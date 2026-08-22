import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExtractionType } from '@prisma/client';
import Redis from 'ioredis';
import { BulkExportConfig } from '../config/configuration';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ZipEntry, ZipService } from '../excel/zip.service';
import {
  BULK_EXPORT_INDEX_MAX_ENTRIES,
  bulkExportIndexKey,
  bulkExportKey,
  bulkExportLockKey,
} from './bulk-export.constants';
import { ExtractionsService } from './extractions.service';

export type BulkExportStepKey =
  | 'GROUPS'
  | 'LEDGERS'
  | 'STOCK_ITEMS'
  | 'COST_CENTRES'
  | 'VOUCHERS_SALES'
  | 'VOUCHERS_PURCHASE'
  | 'VOUCHERS_CREDIT_NOTE'
  | 'VOUCHERS_STOCK_JOURNAL'
  | 'GENERATE_EXCEL'
  | 'ZIP';

export type BulkExportStepStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
export type BulkExportStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface BulkExportStep {
  key: BulkExportStepKey;
  label: string;
  status: BulkExportStepStatus;
  jobId?: string;
  recordCount?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface BulkExportRecord {
  id: string;
  orgId: string;
  company: string;
  fromDate: string;
  toDate: string;
  status: BulkExportStatus;
  steps: BulkExportStep[];
  error?: string;
  filename?: string;
  /** Absolute path on the server's disk — internal only, never serialized
   *  back to a caller (see toPublic). */
  filePath?: string;
  sizeBytes?: number;
  createdAt: string;
  completedAt?: string;
}

export type PublicBulkExportRecord = Omit<BulkExportRecord, 'filePath' | 'orgId'>;

/** The 8 fetch steps, in dependency order — masters before the vouchers that
 *  need them (STOCK_ITEMS before any VOUCHERS step, since every voucher
 *  export's HSN/GST rate is resolved from the item master, not re-parsed off
 *  the voucher — see invoice.mapper.ts's doc comment). Also the ONLY safe
 *  order given a single Tally connector serves one request at a time (see
 *  TallyConfig.chunkDelayMs's doc comment) — this orchestrator never fires
 *  two of these concurrently. */
const STEP_LABELS: Record<BulkExportStepKey, string> = {
  GROUPS: 'Groups (account hierarchy)',
  LEDGERS: 'Ledgers → Chart of Accounts / Customers / Vendors',
  STOCK_ITEMS: 'Stock Items → Items',
  COST_CENTRES: 'Cost Centres → Reporting Tags',
  VOUCHERS_SALES: 'Sales vouchers → Invoices',
  VOUCHERS_PURCHASE: 'Purchase vouchers → Bills',
  VOUCHERS_CREDIT_NOTE: 'Credit Note vouchers → Credit Notes',
  VOUCHERS_STOCK_JOURNAL: 'Stock Journal vouchers → Inventory Adjustments',
  GENERATE_EXCEL: 'Writing all 9 Zoho templates',
  ZIP: 'Packaging the download (.zip)',
};

const FETCH_STEP_KEYS: BulkExportStepKey[] = [
  'GROUPS',
  'LEDGERS',
  'STOCK_ITEMS',
  'COST_CENTRES',
  'VOUCHERS_SALES',
  'VOUCHERS_PURCHASE',
  'VOUCHERS_CREDIT_NOTE',
  'VOUCHERS_STOCK_JOURNAL',
];

const ALL_STEP_KEYS: BulkExportStepKey[] = [...FETCH_STEP_KEYS, 'GENERATE_EXCEL', 'ZIP'];

const VOUCHER_TYPE_BY_STEP: Partial<Record<BulkExportStepKey, string>> = {
  VOUCHERS_SALES: 'Sales',
  VOUCHERS_PURCHASE: 'Purchase',
  VOUCHERS_CREDIT_NOTE: 'Credit Note',
  VOUCHERS_STOCK_JOURNAL: 'Stock Journal',
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Orchestrates "every Zoho-mapped entity this project can build for one
 * company, in one zip" — the full 9-template set documented in
 * docs/tally-zoho-function-mapping.md's "Export status" table (COA,
 * Customer, Vendor, Item, Reporting Tags, Invoice, Bill, Credit Note,
 * Inventory Adjustment). Exists because every one of those today requires
 * its own extraction job plus, for 6 of the 9, a manually-resolved companion
 * job (LEDGERS needs GROUPS, the 4 VOUCHERS exports need STOCK_ITEMS) — this
 * runs that whole sequence once, unattended, and hands back a single
 * downloadable archive instead of 9 separate manual fetch+download round trips.
 *
 * Deliberately sequential, not parallel, even though nothing here is
 * CPU-bound: a single Tally connector serves one request at a time (see
 * TallyConfig.chunkDelayMs's doc comment on why back-to-back requests have
 * previously wedged Tally), so firing multiple of these steps at once would
 * risk the exact hang this project has already been burned by. Progress is
 * tracked in Redis (short-TTL, like every other job result — see
 * docs/architecture.md's "transient, not persisted" decision) so a caller
 * can poll GET /extractions/bulk-export/:id the same way it already polls a
 * single extraction job.
 *
 * The generated .zip is written to disk (BulkExportConfig.exportsDir, not
 * inside dist/src) rather than held only in Redis/memory — these can run
 * several minutes for a large company and produce a multi-entity archive
 * that's worth keeping around for a while, unlike a single job's raw JSON
 * result. It is NEVER served as static/unauthenticated content: download
 * only ever goes through this service's getDownload, gated by the same
 * JwtAuthGuard + org-ownership check as every other route in this
 * controller — these exports carry real customer GSTIN/PAN/bank-account
 * data, so an open static mount would be a straightforward data leak.
 */
@Injectable()
export class BulkExportService {
  private readonly logger = new Logger(BulkExportService.name);

  constructor(
    private readonly extractions: ExtractionsService,
    private readonly zip: ZipService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async start(
    orgId: string,
    notifyEmail: string,
    companyName: string,
    fromDate: string,
    toDate: string,
  ): Promise<{ id: string; status: BulkExportStatus }> {
    if (fromDate > toDate) {
      throw new BadRequestException(`fromDate (${fromDate}) must not be after toDate (${toDate}).`);
    }

    // Resolved (and validated active) up front, same "fail fast, don't queue
    // work certain to fail" reasoning as ExtractionsService.enqueue — a
    // multi-step run is a much more expensive thing to discover is doomed
    // halfway through.
    const connectionId = await this.extractions.resolveConnectionId(orgId, companyName);

    const cfg = this.bulkExportConfig();
    const lockKey = bulkExportLockKey(orgId, companyName);
    const lockTtlSeconds = Math.ceil((cfg.stepTimeoutMs * (FETCH_STEP_KEYS.length + 2)) / 1000);
    const acquired = await this.redis.set(lockKey, '1', 'EX', lockTtlSeconds, 'NX');
    if (!acquired) {
      throw new BadRequestException(
        `A bulk export for "${companyName}" is already running — wait for it to finish ` +
          '(GET /extractions/bulk-export/:id) before starting another.',
      );
    }

    void this.pruneOldExports();

    const id = randomUUID();
    const record: BulkExportRecord = {
      id,
      orgId,
      company: companyName,
      fromDate,
      toDate,
      status: 'PENDING',
      steps: ALL_STEP_KEYS.map((key) => ({
        key,
        label: STEP_LABELS[key],
        status: 'PENDING' as const,
      })),
      createdAt: new Date().toISOString(),
    };
    await this.persist(record);
    await this.pushIndex(orgId, id);

    // Fire-and-forget: the caller polls status, matching this project's
    // existing single-job async pattern (POST returns 202 + id immediately).
    void this.run(id, orgId, notifyEmail, companyName, connectionId, fromDate, toDate).catch(
      (err) => {
        this.logger.error(
          `Bulk export ${id} crashed outside its own error handling: ${String(err)}`,
        );
      },
    );

    return { id, status: record.status };
  }

  async getStatus(orgId: string, id: string): Promise<PublicBulkExportRecord> {
    const record = await this.loadOwned(orgId, id);
    return this.toPublic(record);
  }

  async list(orgId: string, limit = 10): Promise<PublicBulkExportRecord[]> {
    const ids = await this.redis.lrange(bulkExportIndexKey(orgId), 0, Math.max(1, limit) - 1);
    const records = await Promise.all(ids.map((entryId) => this.load(entryId)));
    return records
      .filter((r): r is BulkExportRecord => r !== null && r.orgId === orgId)
      .map((r) => this.toPublic(r));
  }

  async getDownload(orgId: string, id: string): Promise<{ filePath: string; filename: string }> {
    const record = await this.loadOwned(orgId, id);
    if (record.status !== 'SUCCESS' || !record.filePath || !record.filename) {
      throw new BadRequestException(
        record.status === 'FAILED'
          ? (record.error ?? 'Bulk export failed.')
          : `Bulk export is ${record.status.toLowerCase()}, not ready to download yet.`,
      );
    }
    const exists = await fs.stat(record.filePath).catch(() => null);
    if (!exists) {
      throw new NotFoundException(
        'The export file is no longer on disk (cleaned up after its retention window) — run a new bulk export.',
      );
    }
    return { filePath: record.filePath, filename: record.filename };
  }

  /**
   * The actual sequential run: 8 fetch steps, then write all 9 templates,
   * then zip. Every step's outcome (including the two synthetic
   * GENERATE_EXCEL/ZIP steps) is persisted to Redis as it happens, so a
   * caller polling mid-run sees live progress, not just a final result.
   */
  private async run(
    id: string,
    orgId: string,
    notifyEmail: string,
    company: string,
    connectionId: string,
    fromDate: string,
    toDate: string,
  ): Promise<void> {
    const cfg = this.bulkExportConfig();
    const jobIds: Partial<Record<BulkExportStepKey, string>> = {};

    try {
      await this.setStatus(id, 'RUNNING');

      for (const key of FETCH_STEP_KEYS) {
        await this.updateStep(id, key, { status: 'RUNNING', startedAt: new Date().toISOString() });
        try {
          const { id: jobId } = await this.dispatchStep(key, {
            orgId,
            notifyEmail,
            company,
            connectionId,
            fromDate,
            toDate,
          });
          const finished = await this.awaitJob(orgId, jobId, cfg.stepTimeoutMs, cfg.pollIntervalMs);
          if (finished.status === 'FAILED') {
            throw new Error(finished.error ?? `${STEP_LABELS[key]} extraction failed.`);
          }
          jobIds[key] = jobId;
          await this.updateStep(id, key, {
            status: 'SUCCESS',
            jobId,
            recordCount: finished.recordCount ?? undefined,
            finishedAt: new Date().toISOString(),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await this.updateStep(id, key, {
            status: 'FAILED',
            error: message,
            finishedAt: new Date().toISOString(),
          });
          throw new Error(`Step "${STEP_LABELS[key]}" failed: ${message}`);
        }
      }

      await this.updateStep(id, 'GENERATE_EXCEL', {
        status: 'RUNNING',
        startedAt: new Date().toISOString(),
      });
      const entries = await this.generateAllTemplates(
        orgId,
        jobIds as Record<BulkExportStepKey, string>,
      );
      await this.updateStep(id, 'GENERATE_EXCEL', {
        status: 'SUCCESS',
        finishedAt: new Date().toISOString(),
      });

      await this.updateStep(id, 'ZIP', { status: 'RUNNING', startedAt: new Date().toISOString() });
      const zipBuffer = await this.zip.buildZip(entries);
      const { filename, filePath } = await this.saveZip(orgId, company, id, zipBuffer);
      await this.updateStep(id, 'ZIP', { status: 'SUCCESS', finishedAt: new Date().toISOString() });

      await this.mutate(id, (record) => {
        record.status = 'SUCCESS';
        record.filename = filename;
        record.filePath = filePath;
        record.sizeBytes = zipBuffer.length;
        record.completedAt = new Date().toISOString();
      });
      this.logger.log(
        `Bulk export ${id} (${company}) succeeded: ${filename} (${zipBuffer.length} bytes).`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.mutate(id, (record) => {
        record.status = 'FAILED';
        record.error = message;
        record.completedAt = new Date().toISOString();
      });
      this.logger.warn(`Bulk export ${id} (${company}) failed: ${message}`);
    } finally {
      await this.redis.del(bulkExportLockKey(orgId, company)).catch(() => undefined);
    }
  }

  private dispatchStep(
    key: BulkExportStepKey,
    ctx: {
      orgId: string;
      notifyEmail: string;
      company: string;
      connectionId: string;
      fromDate: string;
      toDate: string;
    },
  ): Promise<{ id: string; status: string }> {
    const voucherType = VOUCHER_TYPE_BY_STEP[key];
    if (voucherType) {
      return this.extractions.create(ctx.orgId, ctx.notifyEmail, {
        connectionId: ctx.connectionId,
        type: ExtractionType.VOUCHERS,
        payload: { company: ctx.company, from: ctx.fromDate, to: ctx.toDate, voucherType },
      });
    }

    const masterType = {
      GROUPS: ExtractionType.GROUPS,
      LEDGERS: ExtractionType.LEDGERS,
      STOCK_ITEMS: ExtractionType.STOCK_ITEMS,
      COST_CENTRES: ExtractionType.COST_CENTRES,
    }[key as 'GROUPS' | 'LEDGERS' | 'STOCK_ITEMS' | 'COST_CENTRES'];

    // Deliberately UNSCOPED (no fromDate/toDate) for every master, including
    // LEDGERS/STOCK_ITEMS which technically accept a period. Two independent
    // reasons, not just one:
    //  1. Correctness: a Zoho Chart-of-Accounts/Item import wants the
    //     company's real opening balance, not a balance scoped to whatever
    //     date range this run happens to be pulling vouchers for — those are
    //     different concepts that happen to share two form fields.
    //  2. Safety: an unscoped master fetch takes the single-request/
    //     masterBatchSize=300 path; a period-scoped one is forced onto the
    //     much smaller, fragile periodBatchSize=4 path (see
    //     TallyConfig.periodBatchSize's doc comment). Caught live 2026-08-22:
    //     this bulk export's own STOCK_ITEMS step — 35 records, well under
    //     masterBatchSize — got needlessly period-scoped by this method
    //     forwarding ctx.fromDate/toDate unconditionally, forced it onto the
    //     4-item-batch path, and wedged Tally's engine solid (confirmed via a
    //     raw HTTP probe bypassing this app entirely, and Windows itself
    //     reporting the tally.exe process as "Not Responding") requiring a
    //     manual restart. The date range only has real meaning for the
    //     VOUCHERS steps below — Tally's Day Book export has no "all time"
    //     default the way a master's current balance does.
    return this.extractions.fetchMaster(ctx.orgId, ctx.notifyEmail, {
      companyName: ctx.company,
      masterType,
    });
  }

  /** Polls GET-status equivalent until the job leaves PENDING or the step
   *  budget runs out — see BulkExportConfig.stepTimeoutMs's doc comment. */
  private async awaitJob(
    orgId: string,
    jobId: string,
    stepTimeoutMs: number,
    pollIntervalMs: number,
  ) {
    const deadline = Date.now() + stepTimeoutMs;
    for (;;) {
      const job = await this.extractions.getStatus(orgId, jobId);
      if (job.status !== 'PENDING') return job;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${stepTimeoutMs}ms waiting on job ${jobId} — the connector may be ` +
            'stuck or offline. Check Connections for its status.',
        );
      }
      await delay(pollIntervalMs);
    }
  }

  /**
   * Reuses ExtractionsService.getExcelResult exactly as the single-job
   * download route does — same mappers, same real templates, same
   * companion-job wiring — just called 9 times back to back instead of once
   * per manual click. Filenames match the project root's
   * "Master and Invoice or Bill/" folder for immediate recognizability.
   */
  private async generateAllTemplates(
    orgId: string,
    jobIds: Record<BulkExportStepKey, string>,
  ): Promise<ZipEntry[]> {
    const { LEDGERS: ledgersJobId, GROUPS: groupsJobId, STOCK_ITEMS: itemsJobId } = jobIds;

    const coa = await this.extractions.getExcelResult(orgId, ledgersJobId, groupsJobId, 'COA');
    const customer = await this.extractions.getExcelResult(
      orgId,
      ledgersJobId,
      groupsJobId,
      'CUSTOMER',
    );
    const vendor = await this.extractions.getExcelResult(
      orgId,
      ledgersJobId,
      groupsJobId,
      'VENDOR',
    );
    const item = await this.extractions.getExcelResult(orgId, itemsJobId);
    const costCentre = await this.extractions.getExcelResult(orgId, jobIds.COST_CENTRES);
    const invoice = await this.extractions.getExcelResult(
      orgId,
      jobIds.VOUCHERS_SALES,
      undefined,
      undefined,
      itemsJobId,
    );
    const bill = await this.extractions.getExcelResult(
      orgId,
      jobIds.VOUCHERS_PURCHASE,
      undefined,
      undefined,
      itemsJobId,
    );
    const creditNote = await this.extractions.getExcelResult(
      orgId,
      jobIds.VOUCHERS_CREDIT_NOTE,
      undefined,
      undefined,
      itemsJobId,
    );
    const stockJournal = await this.extractions.getExcelResult(
      orgId,
      jobIds.VOUCHERS_STOCK_JOURNAL,
      undefined,
      undefined,
      itemsJobId,
    );

    return [
      { filename: 'COA.xlsx', buffer: coa.buffer },
      { filename: 'Customer.xlsx', buffer: customer.buffer },
      { filename: 'Vendor.xlsx', buffer: vendor.buffer },
      { filename: 'Item.xlsx', buffer: item.buffer },
      { filename: 'Class.xlsx', buffer: costCentre.buffer },
      { filename: 'Invoice.xlsx', buffer: invoice.buffer },
      { filename: 'Bill.xlsx', buffer: bill.buffer },
      { filename: 'Credit Note.xlsx', buffer: creditNote.buffer },
      { filename: 'Stock Journal.xlsx', buffer: stockJournal.buffer },
    ];
  }

  /**
   * Written under exportsDir/<orgId>/... — not a flat directory — so a given
   * org's exports are physically grouped and discoverable on disk by the
   * same org id that already gates every read (loadOwned/getDownload above).
   * This is purely a disk-layout convenience: ownership was already correctly
   * enforced via the Redis record's orgId field before this change, and still
   * is (filePath is read back from that record, never reconstructed from
   * orgId+filename by a caller).
   */
  private async saveZip(
    orgId: string,
    company: string,
    id: string,
    buffer: Buffer,
  ): Promise<{ filename: string; filePath: string }> {
    const dir = path.join(this.resolveExportsDir(), this.sanitizeForPath(orgId, 'org'));
    await fs.mkdir(dir, { recursive: true });
    const filename = `${this.sanitizeForPath(company, 'company')}-zoho-export-${id}.zip`;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, buffer);
    return { filename, filePath };
  }

  /** Filesystem-safe path segment — strips everything but alphanumerics/-/_ so
   *  neither an org id nor a company name can escape exportsDir (e.g. via
   *  `..`) or collide with a reserved name. */
  private sanitizeForPath(value: string, fallback: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || fallback;
  }

  /** Best-effort disk cleanup of zips older than BulkExportConfig.retentionHours,
   *  swept opportunistically each time a new export starts rather than on its
   *  own timer — this whole feature has no background scheduler today, and one
   *  isn't worth adding just for housekeeping. Never blocks or fails `start`.
   *  Recurses one level into the per-org subdirectories saveZip writes into,
   *  and also sweeps any stray flat file directly under exportsDir left over
   *  from before that layout existed. */
  private async pruneOldExports(): Promise<void> {
    try {
      const dir = this.resolveExportsDir();
      const { retentionHours } = this.bulkExportConfig();
      const cutoff = Date.now() - retentionHours * 3_600_000;
      const entries = await fs.readdir(dir).catch(() => [] as string[]);
      for (const entry of entries) {
        const entryPath = path.join(dir, entry);
        const stat = await fs.stat(entryPath).catch(() => null);
        if (!stat) continue;
        if (stat.isFile()) {
          if (stat.mtimeMs < cutoff) {
            await fs
              .unlink(entryPath)
              .catch((err) => this.logger.debug(`Could not prune ${entryPath}: ${String(err)}`));
          }
          continue;
        }
        if (stat.isDirectory()) {
          const orgEntries = await fs.readdir(entryPath).catch(() => [] as string[]);
          for (const orgEntry of orgEntries) {
            const orgEntryPath = path.join(entryPath, orgEntry);
            const orgStat = await fs.stat(orgEntryPath).catch(() => null);
            if (orgStat?.isFile() && orgStat.mtimeMs < cutoff) {
              await fs
                .unlink(orgEntryPath)
                .catch((err) =>
                  this.logger.debug(`Could not prune ${orgEntryPath}: ${String(err)}`),
                );
            }
          }
        }
      }
    } catch (err) {
      this.logger.debug(`Export retention sweep skipped: ${String(err)}`);
    }
  }

  private resolveExportsDir(): string {
    const { exportsDir } = this.bulkExportConfig();
    return path.isAbsolute(exportsDir) ? exportsDir : path.resolve(process.cwd(), exportsDir);
  }

  private bulkExportConfig(): BulkExportConfig {
    return this.config.getOrThrow<BulkExportConfig>('bulkExport');
  }

  private toPublic(record: BulkExportRecord): PublicBulkExportRecord {
    // Built explicitly (not via destructuring-and-discarding filePath/orgId)
    // so there's no unused-binding lint noise and no risk of a future field
    // added to BulkExportRecord leaking out here by accident.
    return {
      id: record.id,
      company: record.company,
      fromDate: record.fromDate,
      toDate: record.toDate,
      status: record.status,
      steps: record.steps,
      error: record.error,
      filename: record.filename,
      sizeBytes: record.sizeBytes,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
    };
  }

  private async loadOwned(orgId: string, id: string): Promise<BulkExportRecord> {
    const record = await this.load(id);
    if (!record || record.orgId !== orgId) {
      throw new NotFoundException('Bulk export not found (it may have expired).');
    }
    return record;
  }

  private async load(id: string): Promise<BulkExportRecord | null> {
    const raw = await this.redis.get(bulkExportKey(id));
    return raw ? (JSON.parse(raw) as BulkExportRecord) : null;
  }

  private async persist(record: BulkExportRecord): Promise<void> {
    const { recordTtlSeconds } = this.bulkExportConfig();
    await this.redis.set(bulkExportKey(record.id), JSON.stringify(record), 'EX', recordTtlSeconds);
  }

  private async pushIndex(orgId: string, id: string): Promise<void> {
    const key = bulkExportIndexKey(orgId);
    await this.redis.lpush(key, id);
    await this.redis.ltrim(key, 0, BULK_EXPORT_INDEX_MAX_ENTRIES - 1);
  }

  private async setStatus(id: string, status: BulkExportStatus): Promise<void> {
    await this.mutate(id, (record) => {
      record.status = status;
    });
  }

  private async updateStep(
    id: string,
    key: BulkExportStepKey,
    patch: Partial<BulkExportStep>,
  ): Promise<void> {
    await this.mutate(id, (record) => {
      const step = record.steps.find((s) => s.key === key);
      if (step) Object.assign(step, patch);
    });
  }

  /** Read-modify-write against Redis — fine without optimistic locking since
   *  exactly one `run` ever mutates a given bulk export id (the lock in
   *  `start` prevents two concurrent runs for the same org+company, and each
   *  run only ever touches its own id). */
  private async mutate(id: string, fn: (record: BulkExportRecord) => void): Promise<void> {
    const record = await this.load(id);
    if (!record) return;
    fn(record);
    await this.persist(record);
  }
}
