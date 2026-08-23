import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExtractionType, Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { ExtractionConfig, TallyConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { TallyTunnelGateway } from '../gateway/tally-tunnel.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { MasterExtractionService } from '../tally/extraction/master-extraction.service';
import { TransactionExtractionService } from '../tally/extraction/transaction-extraction.service';
import { TallyDiagnosticsService } from '../tally/tally-diagnostics.service';
import { dispatchExtraction } from '../tally/extraction-dispatch';
import { estimateVouchersTimeoutMs } from '../tally/voucher-timeout-estimate';
import { ExtractableType, toTunnelAction } from './extraction-action.map';
import { ExtractionJobData } from './extraction-job-data.interface';
import {
  BATCH_TIMEOUT_FIXED_MARGIN_MS,
  BATCH_TIMEOUT_SAFETY_FACTOR,
  EXTRACTION_QUEUE,
  extractionResultKey,
  resolveExtractionWorkerOptions,
} from './extractions.constants';

/**
 * Runs in the same process as the rest of the App for v1 (see
 * docs/deployment-plan.md §2 — same reasoning as the Gateway not being a
 * separate tier yet). The ExtractionJob Postgres row is the durable source of
 * truth the API reads from; re-throwing on failure also marks the underlying
 * BullMQ job failed, for whenever a queue dashboard is worth having.
 *
 * Handles both ExtractionJobData modes (see that interface's doc comment):
 * 'agent' dispatches over the WebSocket tunnel to a paired connector; 'local'
 * dispatches directly against the backend's own configured Tally, no agent
 * involved — the async counterpart of the old synchronous /tally/* routes,
 * sharing this same queue/worker/result-caching machinery rather than a
 * second parallel implementation of it.
 */
@Processor(EXTRACTION_QUEUE, resolveExtractionWorkerOptions())
export class ExtractionsProcessor extends WorkerHost {
  private readonly logger = new Logger(ExtractionsProcessor.name);

  /**
   * Serializes agent-mode dispatch per connectionId — defense-in-depth on
   * top of the worker concurrency raised above. Each agent already
   * serializes its OWN Tally HTTP calls internally (TallyHttpClient's
   * `queue`), so this doesn't protect Tally from a literal double-hit; it
   * keeps this process from piling multiple simultaneous in-flight WS
   * commands (independent timeout clocks, independent cancel-grace windows)
   * onto one connector purely because BullMQ happened to schedule two of
   * its jobs at once. Modeled directly on TallyHttpClient's own `queue`
   * field/pattern: a plain promise chain that just waits its turn, cheaply
   * (in-memory handoff, no network round trip — this app is explicitly
   * single-process for v1, so a Redis-backed lock here would add latency
   * and a new failure mode without protecting anything more). Deliberately
   * NOT a bounded-wait-then-throw lock — that would burn a real BullMQ
   * retry attempt purely because two jobs happened to share a connector,
   * which is not a failure.
   */
  private readonly connectorQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tunnel: TallyTunnelGateway,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    private readonly masters: MasterExtractionService,
    private readonly transactions: TransactionExtractionService,
    private readonly diagnostics: TallyDiagnosticsService,
  ) {
    super();
  }

  async process(job: Job<ExtractionJobData>): Promise<void> {
    const { extractionJobId, type } = job.data;
    const startedAt = Date.now();

    try {
      const data = await this.dispatch(job.data);
      const recordCount = Array.isArray(data) ? data.length : 1;
      const durationMs = Date.now() - startedAt;

      const { resultTtlSeconds } = this.config.getOrThrow<ExtractionConfig>('extraction');
      await this.redis.set(
        extractionResultKey(extractionJobId),
        JSON.stringify(data),
        'EX',
        resultTtlSeconds,
      );

      const updated = await this.markJobDone(extractionJobId, {
        status: 'SUCCESS',
        recordCount,
        durationMs,
      });
      if (updated && job.data.mode === 'agent') {
        await this.notifications.sendExtractionComplete(job.data.notifyEmail, {
          jobId: extractionJobId,
          type,
          status: 'SUCCESS',
          recordCount,
        });
      }

      this.logger.log(
        `Extraction job ${extractionJobId} (${type}, ${this.describeDispatch(job.data)}) succeeded: ` +
          `${recordCount} record(s) in ${durationMs}ms`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attemptsMade = job.attemptsMade ?? 0;
      const maxAttempts = job.opts?.attempts ?? 1;
      if (attemptsMade + 1 < maxAttempts) {
        this.logger.warn(
          `Extraction job ${extractionJobId} failed on attempt ${attemptsMade + 1}/${maxAttempts} ` +
            `(${message}) — BullMQ will retry.`,
        );
      }
      // Deliberately does NOT mark the Postgres row FAILED here, even on what
      // looks like the final configured attempt — see onJobFailed's doc
      // comment for why re-deriving "is this really final" from
      // attemptsMade/attempts disagreed with BullMQ's own ground truth for a
      // stalled job (one whose worker process died mid-attempt) and left
      // rows stuck PENDING forever despite BullMQ having already given up.
      // Just rethrow so BullMQ's own retry/backoff decides what happens next
      // — onJobFailed is the single place that reconciles Postgres once
      // BullMQ actually, verifiably has no more attempts coming.
      throw err;
    }
  }

  /**
   * Fires on EVERY failed attempt (not just the final one — BullMQ emits
   * 'failed' each time `process` throws, whether or not it will retry) AND,
   * critically, on a job BullMQ's own stalled-job watchdog gives up on
   * (worker process died/lost its lock mid-attempt) — a path that never
   * calls `process` again at all, so nothing inside `process`'s own
   * try/catch can ever observe it. `job.isFailed()` queries BullMQ's actual
   * current state directly rather than re-deriving "is this final" from
   * attemptsMade/attempts (which — confirmed live — disagreed with reality
   * for a stalled job: BullMQ had already permanently failed it while the
   * attempts-based check still believed a retry was coming, leaving the
   * Postgres row stuck PENDING forever with no further attempt ever
   * scheduled to reconcile it). This is now the SOLE place Postgres gets
   * marked FAILED, for both causes, uniformly.
   */
  @OnWorkerEvent('failed')
  async onJobFailed(job: Job<ExtractionJobData> | undefined, error: Error): Promise<void> {
    if (!job) return; // job already removed (e.g. removeOnFail) — nothing to reconcile.
    const permanentlyFailed = await job.isFailed().catch(() => false);
    if (!permanentlyFailed) return; // BullMQ has already re-queued it for another attempt.

    const { extractionJobId, type } = job.data;
    const message = error?.message ?? 'Extraction failed.';
    const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;

    const updated = await this.markJobDone(extractionJobId, {
      status: 'FAILED',
      error: message,
      durationMs,
    });
    if (!updated) return; // already reconciled by an earlier event — no duplicate notification.

    this.logger.warn(`Extraction job ${extractionJobId} (${type}) permanently failed: ${message}`);
    if (job.data.mode === 'agent') {
      await this.notifications.sendExtractionComplete(job.data.notifyEmail, {
        jobId: extractionJobId,
        type,
        status: 'FAILED',
        error: message,
      });
    }
  }

  /**
   * Atomic, idempotent terminal-status write: only transitions a job OUT of
   * PENDING, and only once — `updateMany`'s `where` filter (not a plain
   * `update`) makes "already settled by someone else" a normal, silent
   * no-op (`count: 0`) instead of a race or a duplicate notification. The
   * only two writers are this class's own success path and `onJobFailed`,
   * but a late/duplicate BullMQ event or an out-of-order retry could
   * otherwise call this twice for the same job.
   */
  private async markJobDone(
    id: string,
    data: Prisma.ExtractionJobUpdateManyMutationInput,
  ): Promise<boolean> {
    const result = await this.prisma.extractionJob
      .updateMany({ where: { id, status: 'PENDING' }, data })
      .catch((err) => {
        this.logger.error(`Could not record outcome for job ${id}: ${String(err)}`);
        return { count: 0 };
      });
    return result.count > 0;
  }

  private async dispatch(data: ExtractionJobData): Promise<unknown> {
    const action = toTunnelAction(data.type);
    if (data.mode === 'agent') {
      // extractionJobId is the same across every BullMQ retry of this job —
      // used as sendCommand's dedupeKey so a retry can never dispatch a
      // second command while this job's earlier, abandoned attempt is still
      // outstanding on the agent (the fix for the "Tally hangs" bug: without
      // this, a timed-out retry piled duplicate work onto the agent's single
      // Tally-request queue behind an uncancelled first attempt, compounding
      // with every retry).
      const timeoutMs = await this.estimateBatchedTimeoutMs(
        data.connectionId,
        data.type,
        data.payload,
      );
      return this.runSerializedPerConnector(data.connectionId, () =>
        this.tunnel.sendCommand(
          data.connectionId,
          action,
          data.payload,
          timeoutMs,
          data.extractionJobId,
        ),
      );
    }
    // externalJobId: this job's own row (already PENDING, created before
    // dispatch — see TallyJobsService.create) is what GET /tally/jobs/:id
    // polls. Without threading it through, a batched fetch's live progress
    // landed on a second, uncoordinated row only MasterExtractionService
    // ever knew about — the row the caller actually polls stayed
    // PENDING/progress:null for the fetch's entire duration, indistinguishable
    // from a stuck request. See runExtraction's externalJobId doc comment.
    return dispatchExtraction(
      action,
      data.payload,
      { masters: this.masters, transactions: this.transactions, diagnostics: this.diagnostics },
      undefined,
      data.extractionJobId,
    );
  }

  /**
   * A batched LEDGERS/STOCK_ITEMS fetch's real worst-case duration scales
   * with the company's record count, which the cloud doesn't know ahead of
   * dispatch — but this same connector's most recent *successful* fetch of
   * the same type is a reasonable estimate. Returns `undefined` (falling
   * back to sendCommand's static ExtractionConfig.commandTimeoutMs default)
   * when there's no history yet, or for any other extraction type — VOUCHERS
   * chunking's worst case is already what that static default is sized
   * around (see its doc comment).
   *
   * Approximates the agent's own batching config (TALLY_MASTER_BATCH_SIZE
   * etc.) from the cloud's own TallyConfig, since the agent's real,
   * independently-configured values are never reported back — padded by
   * BATCH_TIMEOUT_SAFETY_FACTOR precisely because this is an approximation,
   * not a promise the agent is actually configured identically.
   *
   * `payload`'s fromDate/toDate matter here: a period-scoped batch uses
   * TallyConfig.periodBatchSize, not masterBatchSize (see that field's doc
   * comment — period-scoped balances are batched far smaller because each
   * one is much more expensive for Tally to compute). Estimating this job's
   * batch count with the wrong (larger) divisor would undercount how many
   * batches a period-scoped run actually needs — e.g. 300 vs 25 is a 12x
   * difference in batch count — and hand back a timeout budget too small
   * for a legitimately-in-progress fetch, so the gateway cancels it
   * mid-flight rather than the batch itself ever failing.
   */
  /** Runs `fn` only after every prior call for the same `connectionId` has
   *  settled — see `connectorQueues`'s doc comment. */
  private runSerializedPerConnector<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.connectorQueues.get(connectionId) ?? Promise.resolve();
    const run = prior.then(() => fn());
    this.connectorQueues.set(
      connectionId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async estimateBatchedTimeoutMs(
    connectionId: string,
    type: ExtractableType,
    payload: Record<string, unknown>,
  ): Promise<number | undefined> {
    // VOUCHERS' chunk count is fully determined by the requested date range
    // and TallyConfig.voucherChunkDays alone (see date-range-chunker.ts) —
    // unlike LEDGERS/STOCK_ITEMS, no historical record-count estimate is
    // needed or possible (a Day Book export's size scales with days
    // requested, not a stable record count). See voucher-timeout-estimate.ts
    // — this fixes a real incident where a multi-year VOUCHERS range blew
    // the static commandTimeoutMs floor on its very first dispatch attempt.
    if (type === ExtractionType.VOUCHERS) {
      const from = typeof payload.from === 'string' ? payload.from : undefined;
      const to = typeof payload.to === 'string' ? payload.to : undefined;
      if (!from || !to) return undefined;
      const tally = this.config.getOrThrow<TallyConfig>('tally');
      const staticFloor = this.config.getOrThrow<ExtractionConfig>('extraction').commandTimeoutMs;
      return Math.max(estimateVouchersTimeoutMs(from, to, tally), staticFloor);
    }

    if (type !== ExtractionType.LEDGERS && type !== ExtractionType.STOCK_ITEMS) return undefined;

    const last = await this.prisma.extractionJob.findFirst({
      where: { connectionId, type, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
      select: { recordCount: true },
    });
    if (!last?.recordCount) return undefined;

    const tally = this.config.getOrThrow<TallyConfig>('tally');
    const isPeriodScoped = Boolean(payload.fromDate && payload.toDate);
    const batchSize = isPeriodScoped ? tally.periodBatchSize : tally.masterBatchSize;
    const estimatedBatches = Math.max(
      1,
      Math.ceil((last.recordCount * BATCH_TIMEOUT_SAFETY_FACTOR) / batchSize),
    );
    const dynamicTimeoutMs =
      tally.timeoutMs * (tally.maxRetries + 1) +
      estimatedBatches * (tally.timeoutMs + tally.chunkDelayMs) +
      BATCH_TIMEOUT_FIXED_MARGIN_MS;

    const staticFloor = this.config.getOrThrow<ExtractionConfig>('extraction').commandTimeoutMs;
    return Math.max(dynamicTimeoutMs, staticFloor);
  }

  private describeDispatch(data: ExtractionJobData): string {
    return data.mode === 'agent' ? `connection=${data.connectionId}` : 'local (direct Tally)';
  }
}
