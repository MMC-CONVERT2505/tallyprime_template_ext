import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisConfig } from '../config/configuration';
import { ExcelModule } from '../excel/excel.module';
import { GatewayModule } from '../gateway/gateway.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EXTRACTION_QUEUE } from './extractions.constants';
import { ExtractionsController } from './extractions.controller';
import { ExtractionsProcessor } from './extractions.processor';
import { ExtractionsService } from './extractions.service';

@Module({
  imports: [
    // A dedicated BullMQ Redis connection, not the shared REDIS_CLIENT — BullMQ
    // manages blocking commands internally and shouldn't share a connection
    // with general-purpose cache/result-storage usage.
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = config.getOrThrow<RedisConfig>('redis');
        return {
          connection: { host: redis.host, port: redis.port, password: redis.password, db: redis.db },
        };
      },
    }),
    // Retries are safe here because every extraction job is a Tally read
    // (see docs/architecture.md — this service extracts, it never writes) —
    // a retried job re-runs the same read and overwrites the same Redis/
    // Postgres rows, it can never double-apply anything. ExtractionsProcessor
    // only marks a job FAILED/notifies once these attempts are exhausted.
    BullModule.registerQueue({
      name: EXTRACTION_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    }),
    GatewayModule,
    NotificationsModule,
    ExcelModule,
  ],
  controllers: [ExtractionsController],
  providers: [ExtractionsService, ExtractionsProcessor],
})
export class ExtractionsModule {}
