import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
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
import { AgentProgressRelay } from './agent-progress-relay.service';
import { AgentTunnelClient } from './tally-tunnel.client';

/**
 * Relays TallyExtractionServiceBase.reportProgress calls over the WebSocket
 * tunnel (as a 'progress' message — see tunnel-protocol.ts) instead of a
 * Postgres write, since this process has none. `create`/`save` are
 * effectively dead code in practice — AgentTunnelClient always threads its
 * requestId through as `externalJobId`, which skips createJob entirely (see
 * TallyExtractionServiceBase.runExtraction) — but are implemented anyway so
 * the one-shot, non-batching actions that don't accept externalJobId
 * (groups/costCentres/companies/raw/probe) still get a well-shaped stand-in
 * rather than an @Optional() undefined making every reportProgress call a
 * silent no-op again.
 */
const agentProgressJobRepositoryProvider = {
  provide: 'EXTRACTION_JOB_REPOSITORY',
  inject: [AgentProgressRelay],
  useFactory: (relay: AgentProgressRelay) => ({
    create: (data: Record<string, unknown>) => ({ id: randomUUID(), ...data }),
    save: (data: Record<string, unknown>) => Promise.resolve(data),
    update: (id: string, data: { progress?: string | null; recordsSoFar?: number }) => {
      if (typeof data.progress === 'string') {
        relay.report(id, data.progress, data.recordsSoFar);
      }
      return Promise.resolve({ id, ...data });
    },
  }),
};

/**
 * The connector/agent's own module graph — deliberately does NOT import
 * TallyModule, DatabaseModule, or RedisModule. It re-declares the same
 * Tally-facing providers TallyModule uses (same classes, same logic) but
 * leaves the Redis client token unprovided, which TallyExtractionServiceBase
 * tolerates via @Optional() — see its doc comment. 'EXTRACTION_JOB_REPOSITORY'
 * IS provided (see agentProgressJobRepositoryProvider above) — WebSocket-relay
 * backed, not Postgres-backed, since no Postgres exists on the client
 * machine by design.
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
    AgentProgressRelay,
    agentProgressJobRepositoryProvider,
    AgentTunnelClient,
  ],
})
export class AgentModule {}
