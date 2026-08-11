import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { ExtractionConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { TallyTunnelGateway } from '../gateway/tally-tunnel.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { toTunnelAction } from './extraction-action.map';
import { ExtractionJobData } from './extraction-job-data.interface';
import { EXTRACTION_QUEUE, extractionResultKey } from './extractions.constants';

/**
 * Runs in the same process as the rest of the App for v1 (see
 * docs/deployment-plan.md §2 — same reasoning as the Gateway not being a
 * separate tier yet). The ExtractionJob Postgres row is the durable source of
 * truth the API reads from; re-throwing on failure also marks the underlying
 * BullMQ job failed, for whenever a queue dashboard is worth having.
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
  ) {
    super();
  }

  async process(job: Job<ExtractionJobData>): Promise<void> {
    const { extractionJobId, connectionId, type, payload, notifyEmail } = job.data;
    const startedAt = Date.now();

    try {
      const action = toTunnelAction(type);
      const data = await this.tunnel.sendCommand(connectionId, action, payload);
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

      await this.notifications.sendExtractionComplete(notifyEmail, {
        jobId: extractionJobId,
        type,
        status: 'SUCCESS',
        recordCount,
      });

      this.logger.log(
        `Extraction job ${extractionJobId} (${type}, connection=${connectionId}) succeeded: ` +
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
      const attemptsMade = job.attemptsMade ?? 1;
      const maxAttempts = job.opts?.attempts ?? 1;
      if (attemptsMade < maxAttempts) {
        this.logger.warn(
          `Extraction job ${extractionJobId} failed on attempt ${attemptsMade}/${maxAttempts} ` +
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

      await this.notifications.sendExtractionComplete(notifyEmail, {
        jobId: extractionJobId,
        type,
        status: 'FAILED',
        error: message,
      });

      throw err;
    }
  }
}
