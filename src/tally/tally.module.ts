import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TallyConfig } from '../config/configuration';
import { ExtractionJob } from '../database/entities/extraction-job.entity';
import { TallyController } from './tally.controller';
import { TallyHttpClient } from './tally-http.client';
import { TallyService } from './tally.service';
import { EnvelopeBuilder } from './xml/envelope.builder';
import { TallyResponseParser } from './xml/response.parser';

@Module({
  imports: [
    TypeOrmModule.forFeature([ExtractionJob]),
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
  providers: [TallyService, TallyHttpClient, EnvelopeBuilder, TallyResponseParser],
  exports: [TallyService, TallyHttpClient, EnvelopeBuilder, TallyResponseParser],
})
export class TallyModule {}
