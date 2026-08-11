import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ExtractionJob, Prisma, TallyConnection } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../database/prisma.service';
import { ExcelGeneratorService } from '../excel/excel-generator.service';
import { TallyTunnelGateway } from '../gateway/tally-tunnel.gateway';
import { ACCOUNT_COLUMNS, LedgerMapper } from '../mapping/ledger.mapper';
import { GroupHierarchyResolver } from '../mapping/group-hierarchy.resolver';
import { ITEM_COLUMNS, StockItemMapper } from '../mapping/stock-item.mapper';
import { REDIS_CLIENT } from '../redis/redis.module';
import { TallyGroup, TallyLedger, TallyStockItem } from '../tally/interfaces/tally.interfaces';
import { CreateExtractionDto } from './dto/create-extraction.dto';
import { FetchMasterDto } from './dto/fetch-master.dto';
import { ExtractableType } from './extraction-action.map';
import { ExtractionJobData } from './extraction-job-data.interface';
import { EXTRACTION_QUEUE, extractionResultKey } from './extractions.constants';

export interface ExcelExportResult {
  buffer: Buffer;
  filename: string;
}

@Injectable()
export class ExtractionsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EXTRACTION_QUEUE) private readonly queue: Queue<ExtractionJobData>,
    private readonly tunnel: TallyTunnelGateway,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly excel: ExcelGeneratorService,
  ) {}

  /**
   * Validates ownership + live connectivity up front — rejecting immediately
   * with a clear reason beats silently queueing a job that's certain to fail
   * a few seconds later (same "live feedback over a post-hoc failure" idea
   * the rest of this project follows).
   */
  async create(
    orgId: string,
    notifyEmail: string,
    dto: CreateExtractionDto,
  ): Promise<{ id: string; status: string }> {
    const connection = await this.prisma.tallyConnection.findFirst({
      where: { id: dto.connectionId, orgId },
    });
    if (!connection) {
      throw new NotFoundException('Connection not found.');
    }

    const company = this.resolveCompany(connection, dto.payload?.company as string | undefined);
    // Merged back into the payload the agent actually receives — resolving
    // `company` only for the DB record and forgetting to also thread it
    // through to the dispatched job would silently drop the connection's
    // defaultCompany fallback (caught live: see git history for this line).
    const payload = company ? { ...dto.payload, company } : (dto.payload ?? {});

    return this.enqueue(orgId, connection, dto.type, payload, notifyEmail);
  }

  /**
   * Company-name-first entry point: resolves the paired connector by
   * `TallyConnection.defaultCompany` instead of requiring the caller to
   * already know its connectionId, and accepts a friendly ISO date range for
   * masters whose balances are period-scoped (Ledgers/Stock Items). Reuses
   * the exact same job/queue pipeline as `create` — see `enqueue`.
   */
  async fetchMaster(
    orgId: string,
    notifyEmail: string,
    dto: FetchMasterDto,
  ): Promise<{ id: string; status: string }> {
    if (dto.fromDate && dto.toDate && dto.fromDate > dto.toDate) {
      throw new BadRequestException(
        `fromDate (${dto.fromDate}) must not be after toDate (${dto.toDate}).`,
      );
    }

    const connection = await this.resolveConnectionByCompany(orgId, dto.companyName);

    const payload: Record<string, unknown> = { company: dto.companyName };
    if (dto.fromDate) payload.fromDate = dto.fromDate;
    if (dto.toDate) payload.toDate = dto.toDate;

    return this.enqueue(orgId, connection, dto.masterType, payload, notifyEmail);
  }

  /**
   * Shared job-creation tail for `create` and `fetchMaster`: validates the
   * connection is usable right now (rather than queueing a job certain to
   * fail seconds later), persists the audit row, and enqueues the actual work.
   */
  private async enqueue(
    orgId: string,
    connection: TallyConnection,
    type: ExtractableType,
    payload: Record<string, unknown>,
    notifyEmail: string,
  ): Promise<{ id: string; status: string }> {
    if (!connection.isActive) {
      throw new BadRequestException('This connection has been revoked.');
    }
    if (!this.tunnel.listConnectedAgents().includes(connection.id)) {
      throw new BadRequestException('This connector is not currently online.');
    }

    const job = await this.prisma.extractionJob.create({
      data: {
        type,
        status: 'PENDING',
        company: (payload.company as string | undefined) ?? null,
        params: payload as Prisma.InputJsonValue,
        orgId,
        connectionId: connection.id,
      },
    });

    await this.queue.add('extract', {
      extractionJobId: job.id,
      connectionId: connection.id,
      type,
      payload,
      notifyEmail,
    });

    return { id: job.id, status: job.status };
  }

  /**
   * A connector is paired to (at most) one company via `defaultCompany`.
   * Letting a caller freely override that with an arbitrary string would
   * violate docs/architecture.md's non-negotiable — "an agent can only ever
   * act on the org/company it's paired to" — so an explicit company is only
   * accepted when it matches the pairing, or when the connection has no fixed
   * company configured yet (an unpaired/multi-company agent).
   */
  private resolveCompany(connection: TallyConnection, requested?: string): string | undefined {
    if (!requested) return connection.defaultCompany ?? undefined;
    if (connection.defaultCompany && requested !== connection.defaultCompany) {
      throw new BadRequestException(
        `Company "${requested}" does not match this connector's paired company ` +
          `("${connection.defaultCompany}"). An agent can only extract from the company ` +
          'it is paired to — pair a separate connector for a different company.',
      );
    }
    return requested;
  }

  /**
   * Resolves a connector by exact companyName match within the caller's org —
   * the inverse lookup of resolveCompany, used by fetchMaster where
   * companyName (not connectionId) is the primary input. `connectionId` is
   * meant to stay an internal implementation detail on this path (see
   * docs/architecture.md's "no UUIDs in the simplified flow" — the frontend
   * never needs to know or show one), so ambiguity is resolved automatically
   * here rather than surfaced back to the caller as a list of ids to choose
   * from.
   */
  private async resolveConnectionByCompany(
    orgId: string,
    companyName: string,
  ): Promise<TallyConnection> {
    // isActive: true is not optional here — a revoked connection is a dead
    // credential, not a candidate.
    const matches = await this.prisma.tallyConnection.findMany({
      where: { orgId, defaultCompany: companyName, isActive: true },
    });

    if (matches.length === 0) {
      throw new NotFoundException(
        `No active connector is paired with company "${companyName}". Company names must match ` +
          'exactly as configured in Connections (GET /connections); use POST /extractions ' +
          'with an explicit connectionId instead if this connector serves multiple companies.',
      );
    }
    if (matches.length === 1) {
      return matches[0];
    }

    // A DB-level unique index (see schema.prisma's TallyConnection doc
    // comment) now prevents new duplicates, so multiple matches here can only
    // mean pre-existing data. Auto-resolve rather than error: prefer whichever
    // is actually online right now (a dead pairing that never connected loses
    // to a live one every time), then whichever last authenticated.
    const online = new Set(this.tunnel.listConnectedAgents());
    const onlineMatches = matches.filter((m) => online.has(m.id));
    const pool = onlineMatches.length > 0 ? onlineMatches : matches;
    return pool.reduce((best, candidate) =>
      (candidate.lastSeenAt?.getTime() ?? 0) > (best.lastSeenAt?.getTime() ?? 0) ? candidate : best,
    );
  }

  async getStatus(orgId: string, id: string): Promise<ExtractionJob> {
    const job = await this.prisma.extractionJob.findFirst({ where: { id, orgId } });
    if (!job) {
      throw new NotFoundException('Job not found.');
    }
    return job;
  }

  async getResult(orgId: string, id: string): Promise<unknown> {
    const { data } = await this.loadSuccessfulResult(orgId, id);
    return data;
  }

  /**
   * Zoho-import-ready Excel for the entity types that have a mapper today.
   * LEDGERS requires a separately-completed GROUPS job (its id passed via
   * `groupsJobId`) to resolve the Account Type correctly — see
   * src/mapping/group-hierarchy.resolver.ts for why a flat parent-name
   * lookup isn't good enough. Each extraction job stays single-purpose (one
   * job, one Tally call, per docs/architecture.md Phase 4); combining two
   * completed jobs' results happens here, at export time, not by growing the
   * job payload.
   */
  async getExcelResult(
    orgId: string,
    id: string,
    groupsJobId?: string,
  ): Promise<ExcelExportResult> {
    const job = await this.getStatus(orgId, id);
    this.assertSuccessful(job);

    // Checked before touching Redis: a caller who forgot ?groupsJobId= gets a
    // clear, immediate 400 rather than a misleading "result expired" if the
    // job's result also happens to have fallen out of its TTL.
    if (job.type === 'LEDGERS' && !groupsJobId) {
      throw new BadRequestException(
        "LEDGERS Excel export requires a completed GROUPS job id via ?groupsJobId= (needed to classify each ledger's Account Type correctly).",
      );
    }

    const data = await this.loadResultData(id);

    if (job.type === 'STOCK_ITEMS') {
      const rows = new StockItemMapper().toItemRows(data as TallyStockItem[]);
      const buffer = await this.excel.generate('Items', ITEM_COLUMNS, rows);
      return { buffer, filename: `items-${id}.xlsx` };
    }

    if (job.type === 'LEDGERS') {
      const groupsJob = await this.getStatus(orgId, groupsJobId!);
      this.assertSuccessful(groupsJob);
      if (groupsJob.type !== 'GROUPS') {
        throw new BadRequestException('groupsJobId must reference a completed GROUPS job.');
      }
      const groups = await this.loadResultData(groupsJobId!);

      const resolver = new GroupHierarchyResolver(groups as TallyGroup[]);
      const rows = new LedgerMapper(resolver).toAccountRows(data as TallyLedger[]);
      const buffer = await this.excel.generate('Chart of Accounts', ACCOUNT_COLUMNS, rows);
      return { buffer, filename: `accounts-${id}.xlsx` };
    }

    throw new BadRequestException(`Excel export not yet supported for ${job.type}.`);
  }

  private assertSuccessful(job: ExtractionJob): void {
    if (job.status === 'PENDING') {
      throw new BadRequestException('Job has not finished yet.');
    }
    if (job.status === 'FAILED') {
      throw new BadRequestException(job.error ?? 'Extraction failed.');
    }
  }

  private async loadResultData(id: string): Promise<unknown> {
    const raw = await this.redis.get(extractionResultKey(id));
    if (!raw) {
      throw new NotFoundException('Result has expired or is no longer available.');
    }
    return JSON.parse(raw);
  }

  private async loadSuccessfulResult(
    orgId: string,
    id: string,
  ): Promise<{ job: ExtractionJob; data: unknown }> {
    const job = await this.getStatus(orgId, id);
    this.assertSuccessful(job);
    const data = await this.loadResultData(id);
    return { job, data };
  }
}
