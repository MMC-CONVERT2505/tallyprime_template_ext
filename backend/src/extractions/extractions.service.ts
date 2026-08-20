import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ExtractionJob, ExtractionType, Prisma, TallyConnection } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../database/prisma.service';
import { ExcelGeneratorService } from '../excel/excel-generator.service';
import { TallyTunnelGateway } from '../gateway/tally-tunnel.gateway';
import { BillMapper } from '../mapping/bill.mapper';
import { CostCentreMapper } from '../mapping/cost-centre.mapper';
import { CreditNoteMapper } from '../mapping/credit-note.mapper';
import { CustomerMapper } from '../mapping/customer.mapper';
import { LedgerMapper } from '../mapping/ledger.mapper';
import { GroupHierarchyResolver } from '../mapping/group-hierarchy.resolver';
import { InvoiceMapper } from '../mapping/invoice.mapper';
import { StockItemMapper } from '../mapping/stock-item.mapper';
import { StockJournalMapper } from '../mapping/stock-journal.mapper';
import { VendorMapper } from '../mapping/vendor.mapper';
import { buildStockItemIndex } from '../mapping/voucher-line.shared';
import {
  ZOHO_ENTITIES,
  ZohoEntityKey,
  templatePathFor,
  zohoEntityForVoucherType,
} from '../mapping/zoho-entity.map';
import { REDIS_CLIENT } from '../redis/redis.module';
import {
  TallyCostCentre,
  TallyGroup,
  TallyLedger,
  TallyStockItem,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';
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
      mode: 'agent',
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

  /** Recent jobs for the org, newest first — what the UI's job list/download
   *  picker is actually backed by (there was no persisted listing before
   *  this; the frontend tracked jobs in session-only React state). */
  async listJobs(orgId: string, limit = 50): Promise<ExtractionJob[]> {
    return this.prisma.extractionJob.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  async getResult(orgId: string, id: string): Promise<unknown> {
    const { data } = await this.loadSuccessfulResult(orgId, id);
    return data;
  }

  /**
   * Zoho-import-ready Excel for the entity types that have a mapper today.
   * LEDGERS requires a separately-completed GROUPS job to resolve the
   * Account Type/Customer-vs-Vendor classification correctly — see
   * src/mapping/group-hierarchy.resolver.ts for why a flat parent-name
   * lookup isn't good enough. VOUCHERS similarly requires a completed
   * STOCK_ITEMS job to resolve each line's HSN/GST rate — see
   * invoice.mapper.ts's doc comment for why that comes from the item master
   * rather than the voucher itself. Each extraction job stays single-purpose
   * (one job, one Tally call, per docs/architecture.md Phase 4); combining
   * two completed jobs' results happens here, at export time, not by
   * growing the job payload.
   *
   * The companion job (`groupsJobId`/`itemsJobId`) is auto-resolved to the
   * most recent successful job of that type for the same org+company when
   * not passed explicitly — a caller (the UI, a script) never needs to know
   * or look up a second job's id to download; a manual override is still
   * accepted for the rare case of wanting a specific older companion run.
   * Caught live: requiring callers to paste a companion job id by hand was
   * exactly the kind of manual-lookup UX this project's whole "extraction
   * job" abstraction was supposed to make unnecessary.
   *
   * A single LEDGERS job can produce 3 different Zoho exports (Chart of
   * Accounts, Customers, Vendors) depending which slice of the same ledger
   * set the caller wants — `ledgerEntity` selects which; defaults to 'COA'
   * for backward compatibility with callers that don't pass it. A VOUCHERS
   * job's target (Invoice/Bill/Credit Note/Stock Journal) isn't a caller
   * choice at all — it's fixed by which `voucherType` the job was fetched
   * with (stored on the job's own `params`), resolved via
   * zohoEntityForVoucherType.
   */
  async getExcelResult(
    orgId: string,
    id: string,
    groupsJobId?: string,
    ledgerEntity: 'COA' | 'CUSTOMER' | 'VENDOR' = 'COA',
    itemsJobId?: string,
  ): Promise<ExcelExportResult> {
    const job = await this.getStatus(orgId, id);
    this.assertSuccessful(job);

    if (job.type === 'LEDGERS' && !groupsJobId) {
      groupsJobId = await this.resolveLatestSuccessfulJobId(orgId, job.company, 'GROUPS');
      if (!groupsJobId) {
        throw new BadRequestException(
          'LEDGERS Excel export needs a completed GROUPS extraction for the same company first ' +
            `(none found for "${job.company ?? 'this company'}") — run one via POST ` +
            '/extractions/fetch-master with masterType: GROUPS, or pass ?groupsJobId= explicitly.',
        );
      }
    }
    if (job.type === 'VOUCHERS' && !itemsJobId) {
      itemsJobId = await this.resolveLatestSuccessfulJobId(orgId, job.company, 'STOCK_ITEMS');
      if (!itemsJobId) {
        throw new BadRequestException(
          'VOUCHERS Excel export needs a completed STOCK_ITEMS extraction for the same company ' +
            `first (none found for "${job.company ?? 'this company'}") — run one via POST ` +
            '/extractions/fetch-master with masterType: STOCK_ITEMS, or pass ?itemsJobId= explicitly.',
        );
      }
    }

    const data = await this.loadResultData(id);

    if (job.type === 'STOCK_ITEMS') {
      const rows = new StockItemMapper().toItemRows(data as TallyStockItem[]);
      return this.writeZohoExport('ITEM', rows, `items-${id}.xlsx`);
    }

    if (job.type === 'COST_CENTRES') {
      const rows = new CostCentreMapper().toReportingTagRows(data as TallyCostCentre[]);
      return this.writeZohoExport('COST_CENTRE', rows, `reporting-tags-${id}.xlsx`);
    }

    if (job.type === 'LEDGERS') {
      const groupsJob = await this.getStatus(orgId, groupsJobId!);
      this.assertSuccessful(groupsJob);
      if (groupsJob.type !== 'GROUPS') {
        throw new BadRequestException('groupsJobId must reference a completed GROUPS job.');
      }
      const groups = await this.loadResultData(groupsJobId!);
      const resolver = new GroupHierarchyResolver(groups as TallyGroup[]);
      const ledgers = data as TallyLedger[];

      if (ledgerEntity === 'CUSTOMER') {
        const rows = new CustomerMapper(resolver).toCustomerRows(ledgers);
        return this.writeZohoExport('CUSTOMER', rows, `customers-${id}.xlsx`);
      }
      if (ledgerEntity === 'VENDOR') {
        const rows = new VendorMapper(resolver).toVendorRows(ledgers);
        return this.writeZohoExport('VENDOR', rows, `vendors-${id}.xlsx`);
      }
      const rows = new LedgerMapper(resolver).toAccountRows(ledgers);
      return this.writeZohoExport('COA', rows, `accounts-${id}.xlsx`);
    }

    if (job.type === 'VOUCHERS') {
      const params = job.params as Record<string, unknown> | null;
      const voucherType = typeof params?.voucherType === 'string' ? params.voucherType : undefined;
      const entityKey = zohoEntityForVoucherType(voucherType);
      if (!entityKey) {
        throw new BadRequestException(
          `Excel export not supported for voucher type "${voucherType ?? 'unknown'}" ` +
            '(no matching Zoho template — see zoho-entity.map.ts).',
        );
      }

      const itemsJob = await this.getStatus(orgId, itemsJobId!);
      this.assertSuccessful(itemsJob);
      if (itemsJob.type !== 'STOCK_ITEMS') {
        throw new BadRequestException('itemsJobId must reference a completed STOCK_ITEMS job.');
      }
      const items = await this.loadResultData(itemsJobId!);
      const itemIndex = buildStockItemIndex(items as TallyStockItem[]);
      const vouchers = data as TallyVoucher[];

      if (entityKey === 'INVOICE') {
        const rows = new InvoiceMapper(itemIndex).toInvoiceRows(vouchers);
        return this.writeZohoExport('INVOICE', rows, `invoices-${id}.xlsx`);
      }
      if (entityKey === 'BILL') {
        const rows = new BillMapper(itemIndex).toBillRows(vouchers);
        return this.writeZohoExport('BILL', rows, `bills-${id}.xlsx`);
      }
      if (entityKey === 'CREDIT_NOTE') {
        const rows = new CreditNoteMapper(itemIndex).toCreditNoteRows(vouchers);
        return this.writeZohoExport('CREDIT_NOTE', rows, `credit-notes-${id}.xlsx`);
      }
      const rows = new StockJournalMapper(itemIndex).toStockJournalRows(vouchers);
      return this.writeZohoExport('STOCK_JOURNAL', rows, `inventory-adjustments-${id}.xlsx`);
    }

    throw new BadRequestException(`Excel export not yet supported for ${job.type}.`);
  }

  /**
   * The auto-resolution behind getExcelResult's companion-job lookup: the
   * most recently *created* successful job of `type` for the same org+
   * company — not the most recent by any other measure, since a caller
   * downloading right after a fresh extraction almost always wants that
   * fresh data, not an older run that happened to finish later (retries can
   * reorder completion times). Returns undefined (not a throw) when there's
   * no candidate — the caller decides how to respond to "not found."
   */
  private async resolveLatestSuccessfulJobId(
    orgId: string,
    company: string | null,
    type: ExtractionType,
  ): Promise<string | undefined> {
    if (!company) return undefined;
    const job = await this.prisma.extractionJob.findFirst({
      where: { orgId, company, type, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return job?.id;
  }

  /** Writes mapped rows into the real Zoho template for `key` (see
   *  zoho-entity.map.ts) and returns a ready-to-download buffer. */
  private async writeZohoExport<T extends object>(
    key: ZohoEntityKey,
    rows: T[],
    filename: string,
  ): Promise<ExcelExportResult> {
    const { sheetName } = ZOHO_ENTITIES[key];
    const buffer = await this.excel.writeIntoTemplate(templatePathFor(key), sheetName, rows);
    return { buffer, filename };
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
