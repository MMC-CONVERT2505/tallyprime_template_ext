import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExtractionType } from '@prisma/client';
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
import { ExtractableType, toTunnelAction } from './extraction-action.map';
import { ExtractionJobData } from './extraction-job-data.interface';
import {
  BATCH_TIMEOUT_FIXED_MARGIN_MS,
  BATCH_TIMEOUT_SAFETY_FACTOR,
  EXTRACTION_QUEUE,
  extractionResultKey,
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
@Processor(EXTRACTION_QUEUE)
export class ExtractionsProcessor extends WorkerHost {
  private readonly logger = new Logger(ExtractionsProcessor.name);

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

      await this.prisma.extractionJob.update({
        where: { id: extractionJobId },
        data: { status: 'SUCCESS', recordCount, durationMs },
      });

      if (job.data.mode === 'agent') {
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
      const durationMs = Date.now() - startedAt;

      // BullMQ retries transient failures (see EXTRACTION_QUEUE's
      // defaultJobOptions in extractions.module.ts) — safe now that every
      // extraction is a read. Only mark the job FAILED and notify once BullMQ
      // has actually given up; otherwise a transient blip would prematurely
      // flip status to FAILED and send a "failed" email moments before the
      // retry quietly succeeds.
      //
      // job.attemptsMade is the count of attempts made BEFORE this one (0 on
      // the very first call — BullMQ only increments it AFTER this handler
      // returns/throws, per Job.moveToFailed in bullmq's own source). BullMQ
      // itself decides whether to retry using `attemptsMade + 1 < attempts`
      // (Job.shouldRetryJob) — mirror that exact formula here, not
      // `attemptsMade < attempts`: that off-by-one meant this branch always
      // believed one more retry was coming, even on the true final attempt,
      // so the FAILED update below never ran and the job stayed PENDING in
      // Postgres forever despite BullMQ having already given up internally.
      // Caught live: three jobs got permanently stuck exactly this way
      // (visible in Redis as `failed` with a real failedReason, but the
      // ExtractionJob Postgres row never left PENDING) the first time
      // anything actually exhausted every retry attempt for real.
      const attemptsMade = job.attemptsMade ?? 0;
      const maxAttempts = job.opts?.attempts ?? 1;
      const isFinalAttempt = attemptsMade + 1 >= maxAttempts;
      if (!isFinalAttempt) {
        this.logger.warn(
          `Extraction job ${extractionJobId} failed on attempt ${attemptsMade + 1}/${maxAttempts} ` +
            `(${message}) — BullMQ will retry.`,
        );
        throw err;
      }

      await this.prisma.extractionJob
        .update({
          where: { id: extractionJobId },
          data: { status: 'FAILED', error: message, durationMs },
        })
        .catch((updateErr) =>
          this.logger.error(
            `Could not record failure for job ${extractionJobId}: ${String(updateErr)}`,
          ),
        );

      if (job.data.mode === 'agent') {
        await this.notifications.sendExtractionComplete(job.data.notifyEmail, {
          jobId: extractionJobId,
          type,
          status: 'FAILED',
          error: message,
        });
      }

      throw err;
    }
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
      const timeoutMs = await this.estimateBatchedTimeoutMs(data.connectionId, data.type);
      return this.tunnel.sendCommand(
        data.connectionId,
        action,
        data.payload,
        timeoutMs,
        data.extractionJobId,
      );
    }
    return dispatchExtraction(action, data.payload, {
      masters: this.masters,
      transactions: this.transactions,
      diagnostics: this.diagnostics,
    });
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
   */
  private async estimateBatchedTimeoutMs(
    connectionId: string,
    type: ExtractableType,
  ): Promise<number | undefined> {
    if (type !== ExtractionType.LEDGERS && type !== ExtractionType.STOCK_ITEMS) return undefined;

    const last = await this.prisma.extractionJob.findFirst({
      where: { connectionId, type, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
      select: { recordCount: true },
    });
    if (!last?.recordCount) return undefined;

    const tally = this.config.getOrThrow<TallyConfig>('tally');
    const estimatedBatches = Math.max(
      1,
      Math.ceil((last.recordCount * BATCH_TIMEOUT_SAFETY_FACTOR) / tally.masterBatchSize),
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
