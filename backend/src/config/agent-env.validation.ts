import * as Joi from 'joi';

/** Env schema for the agent/connector process — see agent-configuration.ts for why
 *  this is separate from (and much smaller than) the server's envValidationSchema. */
export const agentEnvValidationSchema = Joi.object({
  TALLY_HOST: Joi.string().hostname().default('127.0.0.1'),
  TALLY_PORT: Joi.number().port().default(9000),
  TALLY_TIMEOUT_MS: Joi.number().integer().min(1000).max(600000).default(60000),
  TALLY_PROBE_TIMEOUT_MS: Joi.number().integer().min(500).max(60000).default(8000),
  TALLY_RESPONSE_ENCODING: Joi.string()
    .valid('auto', 'utf-8', 'utf8', 'latin1', 'win1252', 'windows-1252', 'ascii')
    .default('auto'),
  TALLY_DEFAULT_COMPANY: Joi.string().allow('').default(''),
  TALLY_MAX_RETRIES: Joi.number().integer().min(0).max(5).default(2),
  TALLY_RETRY_BASE_MS: Joi.number().integer().min(0).max(10000).default(500),

  GATEWAY_URL: Joi.string()
    .uri({ scheme: ['ws', 'wss'] })
    .default('ws://127.0.0.1:3000/agent-tunnel'),
  API_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://127.0.0.1:3000/api'),
  // Optional now: an unset/empty AGENT_TOKEN triggers automatic device-flow
  // pairing on boot (AgentPairingService) instead of failing to start — see
  // docs/connector-bridge-setup-guide.md. Once obtained, it's persisted back
  // into this .env, so this only matters on a machine's very first boot.
  AGENT_TOKEN: Joi.string().min(32).allow('').default(''),
});
