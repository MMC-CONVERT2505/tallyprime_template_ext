import * as Joi from 'joi';

/** Env schema for the agent/connector process — see agent-configuration.ts for why
 *  this is separate from (and much smaller than) the server's envValidationSchema. */
export const agentEnvValidationSchema = Joi.object({
  // See env.validation.ts's TALLY_HOST for why this accepts IP literals
  // (IPv6 in particular), not just hostnames.
  TALLY_HOST: Joi.alternatives()
    .try(Joi.string().hostname(), Joi.string().ip())
    .default('127.0.0.1'),
  TALLY_PORT: Joi.number().port().default(9001),
  TALLY_TIMEOUT_MS: Joi.number().integer().min(1000).max(600000).default(60000),
  TALLY_PROBE_TIMEOUT_MS: Joi.number().integer().min(500).max(60000).default(8000),
  TALLY_RESPONSE_ENCODING: Joi.string()
    .valid('auto', 'utf-8', 'utf8', 'latin1', 'win1252', 'windows-1252', 'ascii')
    .default('auto'),
  TALLY_DEFAULT_COMPANY: Joi.string().allow('').default(''),
  TALLY_MAX_RETRIES: Joi.number().integer().min(0).max(5).default(2),
  TALLY_RETRY_BASE_MS: Joi.number().integer().min(0).max(10000).default(500),
  TALLY_VOUCHER_CHUNK_DAYS: Joi.number().integer().min(1).max(90).default(7),
  TALLY_CHUNK_DELAY_MS: Joi.number().integer().min(0).max(30000).default(2000),
  TALLY_MASTER_BATCH_SIZE: Joi.number().integer().min(10).max(5000).default(300),
  // See env.validation.ts's TALLY_PERIOD_BATCH_SIZE / TallyConfig.periodBatchSize.
  TALLY_PERIOD_BATCH_SIZE: Joi.number().integer().min(1).max(500).default(4),

  GATEWAY_URL: Joi.string()
    .uri({ scheme: ['ws', 'wss'] })
    .default('ws://127.0.0.1:3000/agent-tunnel'),
  API_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://127.0.0.1:3000/api'),
  // Optional now: an unset/empty AGENT_TOKEN triggers automatic device-flow
  // pairing on boot (AgentPairingService) instead of failing to start — see
  // docs/connector-bridge-setup-guide.md. Once obtained, it's persisted to
  // this process's own .tally-bridge-state.json (see bridge-state.util.ts),
  // never back into this .env — so this only matters on a machine's very
  // first boot, or as a scripted-rollout seed value (see the setup guide §2.4).
  AGENT_TOKEN: Joi.string().min(32).allow('').default(''),

  AGENT_HEARTBEAT_INTERVAL_MS: Joi.number().integer().min(5000).max(600000).default(60000),
});
