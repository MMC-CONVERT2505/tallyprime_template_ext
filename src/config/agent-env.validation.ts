import * as Joi from 'joi';

/** Env schema for the agent/connector process — see agent-configuration.ts for why
 *  this is separate from (and much smaller than) the server's envValidationSchema. */
export const agentEnvValidationSchema = Joi.object({
  TALLY_HOST: Joi.string().hostname().default('127.0.0.1'),
  TALLY_PORT: Joi.number().port().default(9000),
  TALLY_TIMEOUT_MS: Joi.number().integer().min(1000).max(600000).default(60000),
  TALLY_RESPONSE_ENCODING: Joi.string()
    .valid('auto', 'utf-8', 'utf8', 'latin1', 'win1252', 'windows-1252', 'ascii')
    .default('auto'),
  TALLY_DEFAULT_COMPANY: Joi.string().allow('').default(''),

  GATEWAY_URL: Joi.string().uri({ scheme: ['ws', 'wss'] }).default('ws://127.0.0.1:3000/agent-tunnel'),
  AGENT_TOKEN: Joi.string().min(32).required(),
});
