import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import agentConfiguration from '../config/agent-configuration';
import { agentEnvValidationSchema } from '../config/agent-env.validation';
import { TallyConfig } from '../config/configuration';
import { MasterExtractionService } from '../tally/extraction/master-extraction.service';
import { TransactionExtractionService } from '../tally/extraction/transaction-extraction.service';
import { TALLY_CONNECTOR } from '../tally/tally-connector.interface';
import { TallyDiagnosticsService } from '../tally/tally-diagnostics.service';
import { TallyHttpClient } from '../tally/tally-http.client';
import { EnvelopeBuilder } from '../tally/xml/envelope.builder';
import { TallyResponseParser } from '../tally/xml/response.parser';
import { AgentPairingService } from './agent-pairing.service';
import { AgentTunnelClient } from './tally-tunnel.client';

/**
 * The connector/agent's own module graph — deliberately does NOT import
 * TallyModule, DatabaseModule, or RedisModule. It re-declares the same
 * Tally-facing providers TallyModule uses (same classes, same logic) but
 * leaves 'EXTRACTION_JOB_REPOSITORY' and the Redis client token unprovided,
 * which TallyExtractionServiceBase tolerates via @Optional() — see its doc
 * comment. No Postgres, no Redis, nothing persistent on the client machine,
 * by design.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [agentConfiguration],
      validationSchema: agentEnvValidationSchema,
      validationOptions: { abortEarly: false },
    }),
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const tally = config.getOrThrow<TallyConfig>('tally');
        return { timeout: tally.timeoutMs, maxRedirects: 0 };
      },
    }),
  ],
  providers: [
    MasterExtractionService,
    TransactionExtractionService,
    TallyDiagnosticsService,
    TallyHttpClient,
    { provide: TALLY_CONNECTOR, useExisting: TallyHttpClient },
    EnvelopeBuilder,
    TallyResponseParser,
    AgentPairingService,
    AgentTunnelClient,
  ],
})
export class AgentModule {}
