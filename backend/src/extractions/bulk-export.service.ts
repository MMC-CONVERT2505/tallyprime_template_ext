import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExtractionType } from '@prisma/client';
import Redis from 'ioredis';
import { BulkExportConfig, TallyConfig } from '../config/configuration';
import { REDIS_CLIENT } from '../redis/redis.module';
import { acquireLock, releaseLock } from '../redis/lock.util';
import { ZipEntry, ZipService } from '../excel/zip.service';
import { estimateVouchersTimeoutMs } from '../tally/voucher-timeout-estimate';
import {
  BULK_EXPORT_INDEX_MAX_ENTRIES,
  bulkExportIndexKey,
  bulkExportKey,
  bulkExportLockKey,
} from './bulk-export.constants';
import { ExtractionReuseService } from './extraction-reuse.service';
import { EXTRACTION_QUEUE_DEFAULT_JOB_OPTIONS } from './extractions.constants';
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
  | 'VOUCHERS_JOURNAL'
  | 'VOUCHERS_DEBIT_NOTE'
  | 'VOUCHERS_RECEIPT'
  | 'VOUCHERS_PAYMENT'
  | 'VOUCHERS_CONTRA'
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
  /** Cumulative record count fetched so far, while this step is still
   *  RUNNING — live progress on a batched/chunked fetch (see
   *  TallyExtractionServiceBase.reportProgress), copied in on every poll
   *  tick by awaitJob below. Cleared once the step reaches a terminal
   *  status — `recordCount` is the authoritative final total from then on. */
  recordsSoFar?: number;
  /** Human-readable detail behind `recordsSoFar` (e.g. "batch 3/12 (...): 40
   *  record(s) in 210ms, 120/430 total so far") — same live copy, same
   *  lifetime as recordsSoFar. */
  progress?: string;
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
 *  two of these concurrently. NOTE: this ordering is about avoiding
 *  concurrent load on one Tally connector and about a later
 *  Excel-generation-time companion-job lookup — NOT a fetch-time data
 *  dependency between the steps themselves (dispatchStep below never feeds
 *  one step's jobId into another's request), which is exactly what makes
 *  isolating and independently retrying a failed step safe (see
 *  runFetchPhase). */
const STEP_LABELS: Record<BulkExportStepKey, string> = {
  GROUPS: 'Groups (account hierarchy)',
  LEDGERS: 'Ledgers → Chart of Accounts / Customers / Vendors',
  STOCK_ITEMS: 'Stock Items → Items',
  COST_CENTRES: 'Cost Centres → Reporting Tags',
  VOUCHERS_SALES: 'Sales vouchers → Invoices',
  VOUCHERS_PURCHASE: 'Purchase vouchers → Bills',
  VOUCHERS_CREDIT_NOTE: 'Credit Note vouchers → Credit Notes',
  VOUCHERS_STOCK_JOURNAL: 'Stock Journal vouchers → Inventory Adjustments',
  VOUCHERS_JOURNAL: 'Journal vouchers → Journal',
  VOUCHERS_DEBIT_NOTE: 'Debit Note vouchers → Vendor Credits',
  VOUCHERS_RECEIPT: 'Receipt vouchers → Customer Payments',
  VOUCHERS_PAYMENT: 'Payment vouchers → Vendor Payments / Expenses',
  VOUCHERS_CONTRA: 'Contra vouchers → Deposits / Bank Transfers',
  GENERATE_EXCEL: 'Writing all 16 Zoho templates',
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
  'VOUCHERS_JOURNAL',
  'VOUCHERS_DEBIT_NOTE',
  'VOUCHERS_RECEIPT',
  'VOUCHERS_PAYMENT',
  'VOUCHERS_CONTRA',
];

const ALL_STEP_KEYS: BulkExportStepKey[] = [...FETCH_STEP_KEYS, 'GENERATE_EXCEL', 'ZIP'];

/** Exported for BulkExportRetryDto's validation — every valid value a
 *  caller's `steps` list may contain. */
export const BULK_EXPORT_STEP_KEYS: BulkExportStepKey[] = [...ALL_STEP_KEYS];

/** VOUCHERS_PAYMENT/VOUCHERS_CONTRA each feed 2 Zoho entities at generate
 *  time (VENDOR_PAYMENT/EXPENSE, DEPOSIT/BANK_TRANSFER) — one fetch, two
 *  outputs, see zoho-entity.map.ts's doc comment. */
const VOUCHER_TYPE_BY_STEP: Partial<Record<BulkExportStepKey, string>> = {
  VOUCHERS_SALES: 'Sales',
  VOUCHERS_PURCHASE: 'Purchase',
  VOUCHERS_CREDIT_NOTE: 'Credit Note',
  VOUCHERS_STOCK_JOURNAL: 'Stock Journal',
  VOUCHERS_JOURNAL: 'Journal',
  VOUCHERS_DEBIT_NOTE: 'Debit Note',
  VOUCHERS_RECEIPT: 'Receipt',
  VOUCHERS_PAYMENT: 'Payment',
  VOUCHERS_CONTRA: 'Contra',
};

interface RunContext {
  orgId: string;
  notifyEmail: string;
  company: string;
  connectionId: string;
  fromDate: string;
  toDate: string;
}

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
 * A fetch step's failure is ISOLATED, not fatal to the whole run: every
 * other fetch step is still attempted (they have no fetch-time dependency on
 * each other — see FETCH_STEP_KEYS's doc comment), and `retry` lets a caller
 * re-run just what failed (or what's left over PENDING from an old,
 * pre-this-feature stuck run) without redoing already-successful steps. Only
 * once every fetch step is SUCCESS does the run proceed to generating the 9
 * Excel templates and zipping them.
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
export class BulkExportService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BulkExportService.name);

  constructor(
    private readonly extractions: ExtractionsService,
    private readonly zip: ZipService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly reuse: ExtractionReuseService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcileOrphanedRuns().catch((err) =>
      this.logger.error(`Bulk-export orphan reconciliation failed: ${String(err)}`),
    );
  }

  /**
   * Self-healing sweep run once at boot. `run`/`retry`'s whole orchestration
   * lives as an in-memory, fire-and-forget async function (see `run`'s doc
   * comment) — nothing persists it beyond the process that's actually
   * executing it. So a record still PENDING or RUNNING at the moment THIS
   * process starts up can only mean the process that was supposed to finish
   * it is gone (a crash, a deploy, or — in dev — a hot-reload restart mid-run:
   * confirmed live 2026-08-23, a giant multi-decade VOUCHERS step outlived
   * the backend process that dispatched it, finished on the connector
   * ~8 hours later, and had nowhere to report back to — the record sat
   * "RUNNING" forever and its lock blocked every future start/retry for that
   * company). Nothing else will ever revisit that record on its own: unlike
   * the underlying ExtractionJob rows (which BullMQ's own stalled-job
   * watchdog eventually reconciles automatically — see
   * ExtractionsProcessor.onJobFailed), a Redis JSON blob has no such
   * built-in recovery mechanism.
   *
   * Marks each orphaned record FAILED with a clear, actionable reason and
   * force-clears its run lock (a plain `del`, not the token-safe
   * `releaseLock` — safe ONLY here: this runs during application bootstrap,
   * before this process could possibly have started a new `run`/`retry` of
   * its own, so there is no legitimate concurrent holder this could ever
   * incorrectly steal from).
   *
   * Deliberately does NOT auto-retry — resuming is a separate, explicit user
   * action (the "Retry Failed Functions" button). Auto-resuming every
   * orphaned run on every boot would silently re-launch a possibly
   * hours-long Tally extraction each time the process restarts, which is
   * actively harmful in exactly the dev-hot-reload scenario that surfaces
   * this bug most often.
   */
  private async reconcileOrphanedRuns(): Promise<void> {
    let cursor = '0';
    let recovered = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'bulk-export:*', 'COUNT', 200);
      cursor = next;
      for (const key of keys) {
        // Only plain "bulk-export:<id>" record keys — not the ":index:" or
        // ":lock:" sub-keyspaces, which share this same prefix.
        if (key.split(':').length !== 2) continue;
        const id = key.slice('bulk-export:'.length);
        const record = await this.load(id);
        if (!record || (record.status !== 'PENDING' && record.status !== 'RUNNING')) continue;

        await this.reconcileOrphanedRecord(id, record);
        await this.redis
          .del(bulkExportLockKey(record.orgId, record.company))
          .catch(() => undefined);
        recovered++;
      }
    } while (cursor !== '0');
    if (recovered > 0) {
      this.logger.warn(`Recovered ${recovered} bulk export(s) orphaned by a prior restart.`);
    }
  }

  /**
   * Confirmed live 2026-08-24: a naive "mark every RUNNING/PENDING step
   * FAILED" sweep can be WRONG, not just imprecise — BullMQ's own stalled-
   * job recovery (see ExtractionsProcessor.onJobFailed) resolves the
   * underlying ExtractionJob independently of this sweep, on its own
   * ~30s+ cadence, and can land the job as genuinely SUCCESS (or with a
   * specific, real failure reason) either just before or just after this
   * sweep runs. Blindly failing a step whose data actually finished fetching
   * fine would make a retry needlessly re-pull it (or, worse, made the
   * record's error message read as a generic restart interruption instead
   * of the real cause). So: for every FETCH_STEP_KEYS step that already has
   * a `jobId` (recorded at dispatch time now, not only on success — see
   * `runFetchPhase`), check that job's actual current Postgres status before
   * deciding — only fall back to a generic "interrupted" failure when
   * there's truly no ground truth to check (never dispatched, or the
   * underlying job is itself still genuinely PENDING). GENERATE_EXCEL/ZIP
   * have no such external ground truth (no Postgres job backs them) — they
   * always just get queued for retry, which is cheap since both are fast,
   * local, Tally-independent steps.
   */
  private async reconcileOrphanedRecord(id: string, record: BulkExportRecord): Promise<void> {
    for (const step of record.steps) {
      if (step.status !== 'RUNNING' && step.status !== 'PENDING') continue;

      if (!FETCH_STEP_KEYS.includes(step.key) || !step.jobId) {
        step.status = 'FAILED';
        step.error = step.error ?? 'Interrupted by a server restart.';
        continue;
      }

      const job = await this.extractions.getStatus(record.orgId, step.jobId).catch(() => null);
      if (job?.status === 'SUCCESS' && (await this.reuse.isResultCached(step.jobId))) {
        step.status = 'SUCCESS';
        step.recordCount = job.recordCount ?? undefined;
        step.finishedAt = job.updatedAt.toISOString();
        continue;
      }
      step.status = 'FAILED';
      step.error =
        job?.status === 'FAILED'
          ? (job.error ?? 'Extraction failed.')
          : 'Interrupted by a server restart.';
    }

    const allFetchStepsSucceeded = FETCH_STEP_KEYS.every(
      (key) => record.steps.find((s) => s.key === key)?.status === 'SUCCESS',
    );
    record.status = 'FAILED';
    record.error = allFetchStepsSucceeded
      ? 'Interrupted by a server restart after every fetch had already completed — use "Retry ' +
        'Failed Functions" to finish generating the Excel templates and zip (no re-fetching needed).'
      : 'Interrupted by a server restart while this export was still running — use "Retry Failed ' +
        'Functions" to resume (already-completed steps will not be re-fetched).';
    record.completedAt = new Date().toISOString();
    await this.persist(record);
  }

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

    const lockKey = bulkExportLockKey(orgId, companyName);
    const lockTtlMs = this.computeLockTtlMs(fromDate, toDate);
    const lockToken = await acquireLock(this.redis, lockKey, lockTtlMs);
    if (!lockToken) {
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
    void this.run(
      id,
      { orgId, notifyEmail, company: companyName, connectionId, fromDate, toDate },
      lockKey,
      lockToken,
    ).catch((err) => {
      this.logger.error(`Bulk export ${id} crashed outside its own error handling: ${String(err)}`);
    });

    return { id, status: record.status };
  }

  /**
   * Re-runs only what's actually still broken in a FAILED bulk export:
   *   - any fetch step currently FAILED, or stuck PENDING (a run created
   *     before this feature shipped, which used to abort the whole export
   *     on the first failure — this lets an old stuck record self-heal too),
   *   - PLUS any fetch step that's marked SUCCESS but whose cached result
   *     has since expired out of Redis (its own TTL is much shorter than
   *     this record's — see ExtractionReuseService.isResultCached).
   * If every fetch step is (or turns out to still be) fine, only
   * GENERATE_EXCEL/ZIP are redone — no new Tally dispatch at all.
   *
   * `steps`, if supplied, is intersected with the real retryable set above,
   * never trusted on its own — a stale client list can't force a wasted
   * re-fetch of a step that meanwhile succeeded via another path, and can't
   * skip a step that's genuinely still broken (the run just stays FAILED
   * with that step still flagged, same as it does today).
   */
  async retry(
    orgId: string,
    notifyEmail: string,
    id: string,
    steps?: BulkExportStepKey[],
  ): Promise<{ id: string; status: BulkExportStatus }> {
    const record = await this.loadOwned(orgId, id);
    if (record.status !== 'FAILED') {
      throw new BadRequestException(
        `Bulk export ${id} is ${record.status.toLowerCase()}, not FAILED — nothing to retry.`,
      );
    }

    const lockKey = bulkExportLockKey(orgId, record.company);
    const lockTtlMs = this.computeLockTtlMs(record.fromDate, record.toDate);
    const lockToken = await acquireLock(this.redis, lockKey, lockTtlMs);
    if (!lockToken) {
      throw new BadRequestException(
        `A bulk export for "${record.company}" is already running — wait for it to finish ` +
          'before retrying.',
      );
    }

    try {
      const staleSuccessKeys = await this.findStaleSuccessSteps(record);
      const retryableKeys = new Set<BulkExportStepKey>(staleSuccessKeys);
      for (const step of record.steps) {
        if (
          FETCH_STEP_KEYS.includes(step.key) &&
          (step.status === 'FAILED' || step.status === 'PENDING')
        ) {
          retryableKeys.add(step.key);
        }
      }

      const fetchStepsToRetry = FETCH_STEP_KEYS.filter(
        (key) => retryableKeys.has(key) && (!steps || steps.includes(key)),
      );

      // Every fetch step NOT being retried keeps its existing (still valid)
      // jobId, so generateAllTemplates never has to re-fetch data that's
      // already sitting in Redis.
      const reusableJobIds: Partial<Record<BulkExportStepKey, string>> = {};
      for (const step of record.steps) {
        if (
          FETCH_STEP_KEYS.includes(step.key) &&
          step.status === 'SUCCESS' &&
          step.jobId &&
          !fetchStepsToRetry.includes(step.key)
        ) {
          reusableJobIds[step.key] = step.jobId;
        }
      }

      await this.mutate(id, (r) => {
        r.status = 'PENDING';
        r.error = undefined;
        r.completedAt = undefined;
        for (const key of fetchStepsToRetry) {
          const step = r.steps.find((s) => s.key === key);
          if (!step) continue;
          step.status = 'PENDING';
          step.error = undefined;
          step.jobId = undefined;
          step.recordCount = undefined;
          step.startedAt = undefined;
          step.finishedAt = undefined;
        }
        // GENERATE_EXCEL and ZIP are always retried together, never
        // independently — both are fast, local, Tally-independent steps (no
        // Redis-expiry concern, no reason to cache/skip one), so once every
        // fetch step is (or already was) fine, just redo both rather than
        // adding the complexity of caching intermediate template buffers to
        // support a "only ZIP failed" fast path.
        if (fetchStepsToRetry.length === 0) {
          for (const key of ['GENERATE_EXCEL', 'ZIP'] as const) {
            const step = r.steps.find((s) => s.key === key);
            if (!step) continue;
            step.status = 'PENDING';
            step.error = undefined;
            step.startedAt = undefined;
            step.finishedAt = undefined;
          }
        }
      });

      const connectionId = await this.extractions.resolveConnectionId(orgId, record.company);

      void this.run(
        id,
        {
          orgId,
          notifyEmail,
          company: record.company,
          connectionId,
          fromDate: record.fromDate,
          toDate: record.toDate,
        },
        lockKey,
        lockToken,
        fetchStepsToRetry,
        reusableJobIds,
      ).catch((err) => {
        this.logger.error(
          `Bulk export ${id} retry crashed outside its own error handling: ${String(err)}`,
        );
      });
    } catch (err) {
      await releaseLock(this.redis, lockKey, lockToken).catch(() => undefined);
      throw err;
    }

    return { id, status: 'PENDING' };
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
   * Removes a bulk export from history: its Redis record, its entry in the
   * org's index list, and the generated .zip on disk (best-effort — an
   * already-missing file, e.g. past its own retention window, is not an
   * error). Refuses to delete a still in-flight run (PENDING/RUNNING) rather
   * than yanking the record out from under `run`/`retry` mid-flight — that
   * wouldn't crash anything (`mutate` no-ops once `load` returns null), but
   * would silently orphan a run whose progress the UI can no longer show.
   * Deliberately does NOT delete the underlying per-step ExtractionJob rows
   * (Postgres) or their cached Redis results — those remain valid history/
   * reuse candidates (see ExtractionReuseService) independent of whether this
   * particular bulk-export grouping is still visible.
   */
  async remove(orgId: string, id: string): Promise<void> {
    const record = await this.loadOwned(orgId, id);
    if (record.status === 'PENDING' || record.status === 'RUNNING') {
      throw new BadRequestException(
        `Bulk export ${id} is still ${record.status.toLowerCase()} — wait for it to finish ` +
          'before deleting it.',
      );
    }
    if (record.filePath) {
      await fs
        .unlink(record.filePath)
        .catch((err) => this.logger.debug(`Could not remove ${record.filePath}: ${String(err)}`));
    }
    await this.redis.del(bulkExportKey(id));
    await this.redis.lrem(bulkExportIndexKey(orgId), 0, id);
  }

  /**
   * The actual run, shared by both a fresh `start()` (every fetch step) and
   * a `retry()` (a subset, plus reused jobIds for the rest). Every step's
   * outcome (including the two synthetic GENERATE_EXCEL/ZIP steps) is
   * persisted to Redis as it happens, so a caller polling mid-run sees live
   * progress, not just a final result. Always releases `lockToken` on the
   * way out, success or failure.
   */
  private async run(
    id: string,
    ctx: RunContext,
    lockKey: string,
    lockToken: string,
    fetchStepsToAttempt: BulkExportStepKey[] = FETCH_STEP_KEYS,
    reusableJobIds: Partial<Record<BulkExportStepKey, string>> = {},
  ): Promise<void> {
    try {
      await this.setStatus(id, 'RUNNING');

      let jobIds: Partial<Record<BulkExportStepKey, string>> = { ...reusableJobIds };
      let allSucceeded = true;

      if (fetchStepsToAttempt.length > 0) {
        const result = await this.runFetchPhase(id, ctx, fetchStepsToAttempt);
        jobIds = { ...jobIds, ...result.jobIds };
        allSucceeded = result.allSucceeded;
      }

      const allFetchStepsPresent = FETCH_STEP_KEYS.every((key) => Boolean(jobIds[key]));
      if (!allSucceeded || !allFetchStepsPresent) {
        await this.failRun(id);
        return;
      }

      await this.finishGenerateAndZip(
        id,
        ctx.orgId,
        ctx.company,
        jobIds as Record<BulkExportStepKey, string>,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.mutate(id, (record) => {
        record.status = 'FAILED';
        record.error = message;
        record.completedAt = new Date().toISOString();
      });
      this.logger.warn(`Bulk export ${id} (${ctx.company}) failed: ${message}`);
    } finally {
      await releaseLock(this.redis, lockKey, lockToken).catch(() => undefined);
    }
  }

  /**
   * Dispatches and awaits each of `stepsToAttempt` in sequence. A step's
   * failure is caught and recorded but does NOT abort the loop — every
   * requested step gets a real attempt, since none of them depend on
   * another's fetch-time result (see FETCH_STEP_KEYS's doc comment).
   */
  private async runFetchPhase(
    id: string,
    ctx: RunContext,
    stepsToAttempt: BulkExportStepKey[],
  ): Promise<{ allSucceeded: boolean; jobIds: Partial<Record<BulkExportStepKey, string>> }> {
    const cfg = this.bulkExportConfig();
    const jobIds: Partial<Record<BulkExportStepKey, string>> = {};
    let allSucceeded = true;

    for (const key of stepsToAttempt) {
      await this.updateStep(id, key, {
        status: 'RUNNING',
        startedAt: new Date().toISOString(),
        error: undefined,
      });
      try {
        const { id: jobId } = await this.dispatchStep(key, ctx);
        // Recorded immediately, not only on success — this is what lets a
        // boot-time reconciliation sweep (see reconcileOrphanedRecord) trace
        // an orphaned RUNNING step back to the specific underlying job and
        // check what ACTUALLY happened to it, instead of blindly assuming
        // failure for a step that may have completed successfully via
        // BullMQ's own independent recovery moments after this process died.
        await this.updateStep(id, key, { jobId });
        const stepTimeoutMs = this.pollBudgetFor(key, ctx.fromDate, ctx.toDate, cfg.stepTimeoutMs);
        const finished = await this.awaitJob(
          id,
          key,
          ctx.orgId,
          jobId,
          stepTimeoutMs,
          cfg.pollIntervalMs,
        );
        if (finished.status === 'FAILED') {
          throw new Error(finished.error ?? `${STEP_LABELS[key]} extraction failed.`);
        }
        jobIds[key] = jobId;
        await this.updateStep(id, key, {
          status: 'SUCCESS',
          jobId,
          recordCount: finished.recordCount ?? undefined,
          recordsSoFar: undefined,
          progress: undefined,
          finishedAt: new Date().toISOString(),
        });
      } catch (err) {
        allSucceeded = false;
        const message = err instanceof Error ? err.message : String(err);
        await this.updateStep(id, key, {
          status: 'FAILED',
          error: message,
          recordsSoFar: undefined,
          progress: undefined,
          finishedAt: new Date().toISOString(),
        });
        this.logger.warn(
          `Bulk export ${id}: step "${STEP_LABELS[key]}" failed (${message}) — continuing with ` +
            'the remaining steps.',
        );
      }
    }

    return { allSucceeded, jobIds };
  }

  /** VOUCHERS steps get a deterministic, date-range-based poll budget
   *  (accounting for BullMQ's full retry envelope — a step's Postgres row
   *  only flips to FAILED once every attempt is exhausted, not after the
   *  first) instead of the static default, which was sized for far smaller
   *  ranges — see estimateVouchersTimeoutMs's doc comment for the exact
   *  incident this fixes. Master steps are unaffected. */
  private pollBudgetFor(
    key: BulkExportStepKey,
    fromDate: string,
    toDate: string,
    staticStepTimeoutMs: number,
  ): number {
    if (VOUCHER_TYPE_BY_STEP[key]) {
      return this.vouchersStepPollBudgetMs(fromDate, toDate);
    }
    return staticStepTimeoutMs;
  }

  private vouchersStepPollBudgetMs(fromDate: string, toDate: string): number {
    const tally = this.config.getOrThrow<TallyConfig>('tally');
    const perAttemptMs = estimateVouchersTimeoutMs(fromDate, toDate, tally);
    const { attempts = 1, backoff } = EXTRACTION_QUEUE_DEFAULT_JOB_OPTIONS;
    const baseDelayMs = typeof backoff === 'object' && backoff ? (backoff.delay ?? 0) : 0;
    // Sum of an exponential backoff series (delay, delay*2, delay*4, ...)
    // across (attempts - 1) retries — matches BullMQ's own formula, mirrored
    // here since this needs to reason about the worst case ahead of time,
    // not just apply it retry-by-retry the way BullMQ does internally.
    const totalBackoffMs = attempts > 1 ? baseDelayMs * (2 ** (attempts - 1) - 1) : 0;
    return perAttemptMs * attempts + totalBackoffMs;
  }

  /** Worst-case wall-clock budget for the whole run, used to size the
   *  per-(org,company) lock's TTL generously above it — computed from the
   *  SAME per-step poll budgets `runFetchPhase` actually uses (including the
   *  dynamic VOUCHERS estimate), not a fixed multiple of the static step
   *  timeout, so a legitimately-long-running wide-range run can't outlive
   *  its own lock. */
  private computeLockTtlMs(fromDate: string, toDate: string): number {
    const cfg = this.bulkExportConfig();
    const fetchPhaseTotalMs = FETCH_STEP_KEYS.reduce(
      (sum, key) => sum + this.pollBudgetFor(key, fromDate, toDate, cfg.stepTimeoutMs),
      0,
    );
    // GENERATE_EXCEL/ZIP have no Tally round trip or BullMQ retry envelope —
    // two step-timeouts' worth of margin is generous, not a tight estimate.
    return fetchPhaseTotalMs + cfg.stepTimeoutMs * 2;
  }

  /** Which currently-SUCCESS fetch steps' cached Redis result has expired —
   *  see retry's doc comment for why this matters (a step's result TTL is
   *  much shorter than the bulk-export record's own TTL). */
  private async findStaleSuccessSteps(record: BulkExportRecord): Promise<BulkExportStepKey[]> {
    const successSteps = record.steps.filter(
      (s) => FETCH_STEP_KEYS.includes(s.key) && s.status === 'SUCCESS' && s.jobId,
    );
    const stale: BulkExportStepKey[] = [];
    await Promise.all(
      successSteps.map(async (step) => {
        const cached = await this.reuse.isResultCached(step.jobId!);
        if (!cached) stale.push(step.key);
      }),
    );
    return stale;
  }

  /** Aggregates every currently-FAILED step's error into one overall
   *  message and marks the run FAILED — used both when a fresh fetch phase
   *  doesn't fully succeed and when a retry still leaves something broken. */
  private async failRun(id: string): Promise<void> {
    const record = await this.load(id);
    const failedSteps = record?.steps.filter((s) => s.status === 'FAILED') ?? [];
    const message =
      failedSteps.length > 0
        ? `${failedSteps.length} of ${FETCH_STEP_KEYS.length} fetch step(s) failed: ` +
          failedSteps.map((s) => `${s.label} (${s.error ?? 'unknown error'})`).join('; ')
        : 'One or more fetch steps did not complete.';
    await this.mutate(id, (r) => {
      r.status = 'FAILED';
      r.error = message;
      r.completedAt = new Date().toISOString();
    });
    this.logger.warn(`Bulk export ${id}: ${message}`);
  }

  /** GENERATE_EXCEL then ZIP, each independently marked FAILED (and
   *  re-thrown) if it errors, so a caller always sees exactly which of the
   *  two broke rather than either step staying stuck at RUNNING forever. */
  private async finishGenerateAndZip(
    id: string,
    orgId: string,
    company: string,
    jobIds: Record<BulkExportStepKey, string>,
  ): Promise<void> {
    await this.updateStep(id, 'GENERATE_EXCEL', {
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      error: undefined,
    });
    let entries: ZipEntry[];
    try {
      entries = await this.generateAllTemplates(orgId, jobIds);
    } catch (err) {
      await this.updateStep(id, 'GENERATE_EXCEL', {
        status: 'FAILED',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date().toISOString(),
      });
      throw err;
    }
    await this.updateStep(id, 'GENERATE_EXCEL', {
      status: 'SUCCESS',
      finishedAt: new Date().toISOString(),
    });

    await this.updateStep(id, 'ZIP', {
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      error: undefined,
    });
    let zipBuffer: Buffer;
    let saved: { filename: string; filePath: string };
    try {
      zipBuffer = await this.zip.buildZip(entries);
      saved = await this.saveZip(orgId, company, id, zipBuffer);
    } catch (err) {
      await this.updateStep(id, 'ZIP', {
        status: 'FAILED',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date().toISOString(),
      });
      throw err;
    }
    await this.updateStep(id, 'ZIP', { status: 'SUCCESS', finishedAt: new Date().toISOString() });

    await this.mutate(id, (record) => {
      record.status = 'SUCCESS';
      record.filename = saved.filename;
      record.filePath = saved.filePath;
      record.sizeBytes = zipBuffer.length;
      record.completedAt = new Date().toISOString();
    });
    this.logger.log(
      `Bulk export ${id} (${company}) succeeded: ${saved.filename} (${zipBuffer.length} bytes).`,
    );
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
   *  budget runs out — see BulkExportConfig.stepTimeoutMs's doc comment.
   *  Copies the underlying job's live `recordsSoFar`/`progress` (see
   *  TallyExtractionServiceBase.reportProgress) onto this bulk export's own
   *  step record on every tick, so a caller polling GET
   *  /extractions/bulk-export/:id sees "N records extracted so far" for
   *  whichever function is currently running, not just a bare RUNNING with
   *  no detail — the same underlying data was always being written, this
   *  just surfaces it up one more level to where a caller can actually see it. */
  private async awaitJob(
    bulkExportId: string,
    stepKey: BulkExportStepKey,
    orgId: string,
    jobId: string,
    stepTimeoutMs: number,
    pollIntervalMs: number,
  ) {
    const deadline = Date.now() + stepTimeoutMs;
    for (;;) {
      const job = await this.extractions.getStatus(orgId, jobId);
      if (job.status !== 'PENDING') return job;
      if (job.recordsSoFar !== null || job.progress !== null) {
        await this.updateStep(bulkExportId, stepKey, {
          recordsSoFar: job.recordsSoFar ?? undefined,
          progress: job.progress ?? undefined,
        });
      }
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
    // invoicesJobId passed explicitly (this bulk run's own just-completed
    // Sales job) rather than left to auto-resolve — see credit-note.mapper.ts's
    // "Associated Invoice Date" doc comment for why a Credit Note export
    // wants the Invoice data from the very same run, not just "whatever's
    // latest in the DB".
    const creditNote = await this.extractions.getExcelResult(
      orgId,
      jobIds.VOUCHERS_CREDIT_NOTE,
      undefined,
      undefined,
      itemsJobId,
      jobIds.VOUCHERS_SALES,
    );
    const stockJournal = await this.extractions.getExcelResult(
      orgId,
      jobIds.VOUCHERS_STOCK_JOURNAL,
      undefined,
      undefined,
      itemsJobId,
    );
    const journal = await this.extractions.getExcelResult(
      orgId,
      jobIds.VOUCHERS_JOURNAL,
      undefined,
      undefined,
      itemsJobId,
      undefined,
      ledgersJobId,
    );
    const vendorCredit = await this.extractions.getExcelResult(
      orgId,
      jobIds.VOUCHERS_DEBIT_NOTE,
      undefined,
      undefined,
      itemsJobId,
      undefined,
      ledgersJobId,
    );
    // invoicesJobId reused as "this run's own companion Sales/Purchase job"
    // for the per-allocation Invoice/Bill Date columns — same "own run's
    // data, not just latest in the DB" reasoning as creditNote above.
    const customerPayment = await this.extractions.getExcelResult(
      orgId,
      jobIds.VOUCHERS_RECEIPT,
      undefined,
      undefined,
      itemsJobId,
      jobIds.VOUCHERS_SALES,
      ledgersJobId,
    );
    const vendorPayment = await this.extractions.getExcelResult(
      orgId,
      jobIds.VOUCHERS_PAYMENT,
      groupsJobId,
      undefined,
      itemsJobId,
      jobIds.VOUCHERS_PURCHASE,
      ledgersJobId,
      'VENDOR_PAYMENT',
    );
    const expense = await this.extractions.getExcelResult(
      orgId,
      jobIds.VOUCHERS_PAYMENT,
      groupsJobId,
      undefined,
      itemsJobId,
      undefined,
      ledgersJobId,
      'EXPENSE',
    );
    const deposit = await this.extractions.getExcelResult(
      orgId,
      jobIds.VOUCHERS_CONTRA,
      groupsJobId,
      undefined,
      itemsJobId,
      undefined,
      ledgersJobId,
      'DEPOSIT',
    );
    const bankTransfer = await this.extractions.getExcelResult(
      orgId,
      jobIds.VOUCHERS_CONTRA,
      groupsJobId,
      undefined,
      itemsJobId,
      undefined,
      ledgersJobId,
      'BANK_TRANSFER',
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
      { filename: 'Journal.xlsx', buffer: journal.buffer },
      { filename: 'Vendor_Credits.xlsx', buffer: vendorCredit.buffer },
      { filename: 'Customer_Payment.xlsx', buffer: customerPayment.buffer },
      { filename: 'Vendor_Payment.xlsx', buffer: vendorPayment.buffer },
      { filename: 'Expense.xlsx', buffer: expense.buffer },
      { filename: 'Deposit.xlsx', buffer: deposit.buffer },
      { filename: 'Bank Transfer.xlsx', buffer: bankTransfer.buffer },
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
   *  exactly one `run` ever mutates a given bulk export id at a time (the
   *  per-(org,company) lock in `start`/`retry` prevents two concurrent runs
   *  against the same record, and each run only ever touches its own id). */
  private async mutate(id: string, fn: (record: BulkExportRecord) => void): Promise<void> {
    const record = await this.load(id);
    if (!record) return;
    fn(record);
    await this.persist(record);
  }
}
