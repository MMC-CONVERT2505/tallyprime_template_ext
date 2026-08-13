import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TallyConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { EXTRACTION_QUEUE, EXTRACTION_QUEUE_DEFAULT_JOB_OPTIONS } from '../extractions/extractions.constants';
import { MasterExtractionService } from './extraction/master-extraction.service';
import { TransactionExtractionService } from './extraction/transaction-extraction.service';
import { TALLY_CONNECTOR } from './tally-connector.interface';
import { TallyController } from './tally.controller';
import { TallyDiagnosticsService } from './tally-diagnostics.service';
import { TallyHttpClient } from './tally-http.client';
import { TallyJobsService } from './tally-jobs.service';
import { EnvelopeBuilder } from './xml/envelope.builder';
import { TallyResponseParser } from './xml/response.parser';

/**
 * Real Prisma-backed audit trail (previously a no-op stub that persisted
 * nothing). `create` stays synchronous/non-persisting — it just builds the
 * row shape; `save` is the actual DB write — so callers in the extraction
 * services don't change (see TallyExtractionServiceBase.createJob).
 */
const extractionJobRepositoryProvider = {
  provide: 'EXTRACTION_JOB_REPOSITORY',
  inject: [PrismaService],
  useFactory: (prisma: PrismaService) => ({
    create: (data: Record<string, unknown>) => ({ ...data }),
    save: (data: Record<string, unknown>) =>
      prisma.extractionJob.create({
        data: data as Parameters<typeof prisma.extractionJob.create>[0]['data'],
      }),
    update: (id: string, data: Record<string, unknown>) =>
      prisma.extractionJob.update({ where: { id }, data }),
  }),
};

/** Aliases the TallyConnector token to the same TallyHttpClient singleton —
 *  see tally-connector.interface.ts for why extraction services depend on
 *  the interface rather than this concrete class directly. */
const tallyConnectorProvider = {
  provide: TALLY_CONNECTOR,
  useExisting: TallyHttpClient,
};

@Module({
  imports: [
    // Per-request timeout is set explicitly on each call; this is a sane default.
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const tally = config.getOrThrow<TallyConfig>('tally');
        return {
          timeout: tally.timeoutMs,
          // Do not follow redirects — Tally never issues them; a redirect means
          // something else is on that port.
          maxRedirects: 0,
        };
      },
    }),
    // Same named queue ExtractionsModule registers, reusing the SAME
    // defaultJobOptions constant — BullMQ's Nest integration shares the one
    // underlying Redis-backed queue/connection (configured via
    // BullModule.forRootAsync there) across every module that registers it,
    // but each registerQueue call builds its own client-side Queue instance,
    // so defaultJobOptions must be repeated explicitly here or local-mode
    // jobs (POST /tally/jobs, via TallyJobsService) would silently get none
    // of the retry/backoff policy agent-mode jobs get.
    BullModule.registerQueue({ name: EXTRACTION_QUEUE, defaultJobOptions: EXTRACTION_QUEUE_DEFAULT_JOB_OPTIONS }),
  ],
  controllers: [TallyController],
  providers: [
    MasterExtractionService,
    TransactionExtractionService,
    TallyDiagnosticsService,
    TallyHttpClient,
    tallyConnectorProvider,
    EnvelopeBuilder,
    TallyResponseParser,
    extractionJobRepositoryProvider,
    TallyJobsService,
  ],
  exports: [
    MasterExtractionService,
    TransactionExtractionService,
    TallyDiagnosticsService,
    TallyHttpClient,
    EnvelopeBuilder,
    TallyResponseParser,
  ],
})
export class TallyModule {}
