import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TallyConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { TallyController } from './tally.controller';
import { TallyHttpClient } from './tally-http.client';
import { TallyService } from './tally.service';
import { EnvelopeBuilder } from './xml/envelope.builder';
import { TallyResponseParser } from './xml/response.parser';

/**
 * Real Prisma-backed audit trail (previously a no-op stub that persisted
 * nothing). `create` stays synchronous/non-persisting — it just builds the
 * row shape; `save` is the actual DB write — so callers in TallyService don't
 * change (see TallyService.createJob).
 */
const extractionJobRepositoryProvider = {
  provide: 'EXTRACTION_JOB_REPOSITORY',
  inject: [PrismaService],
  useFactory: (prisma: PrismaService) => ({
    create: (data: Record<string, unknown>) => ({ ...data }),
    save: (data: Record<string, unknown>) =>
      prisma.extractionJob.create({ data: data as Parameters<typeof prisma.extractionJob.create>[0]['data'] }),
    update: (id: string, data: Record<string, unknown>) =>
      prisma.extractionJob.update({ where: { id }, data }),
  }),
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
  ],
  controllers: [TallyController],
  providers: [
    TallyService,
    TallyHttpClient,
    EnvelopeBuilder,
    TallyResponseParser,
    extractionJobRepositoryProvider,
  ],
  exports: [TallyService, TallyHttpClient, EnvelopeBuilder, TallyResponseParser],
})
export class TallyModule {}
