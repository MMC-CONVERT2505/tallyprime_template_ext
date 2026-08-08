import * as Joi from 'joi';

/**
 * Joi schema for process.env. Fails fast at boot with a readable message if a
 * required variable is missing or malformed — far better than a cryptic runtime
 * crash three layers deep once a request arrives.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  APP_GLOBAL_PREFIX: Joi.string().allow('').default('api'),

  // Tally
  TALLY_HOST: Joi.string().hostname().default('127.0.0.1'),
  TALLY_PORT: Joi.number().port().default(9000),
  TALLY_TIMEOUT_MS: Joi.number().integer().min(1000).max(600000).default(60000),
  TALLY_RESPONSE_ENCODING: Joi.string()
    .valid('auto', 'utf-8', 'utf8', 'latin1', 'win1252', 'windows-1252', 'ascii')
    .default('auto'),
  TALLY_DEFAULT_COMPANY: Joi.string().allow('').default(''),
  // Retry transient failures (timeout/unreachable) with exponential backoff —
  // safe because every Tally request this app sends is a read.
  TALLY_MAX_RETRIES: Joi.number().integer().min(0).max(5).default(2),
  TALLY_RETRY_BASE_MS: Joi.number().integer().min(0).max(10000).default(500),

  // Postgres (Prisma)
  DB_HOST: Joi.string().default('127.0.0.1'),
  DB_PORT: Joi.number().port().default(5432),
  DB_USER: Joi.string().default('tally'),
  DB_PASSWORD: Joi.string().allow('').default('tally'),
  DB_NAME: Joi.string().default('tally_migration'),
  DB_LOGGING: Joi.boolean().default(false),
  // Optional full connection string; overrides the DB_* fields above when set
  // (also what the Prisma CLI itself reads for `migrate`/`generate`).
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .optional(),

  // Redis
  REDIS_HOST: Joi.string().default('127.0.0.1'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().integer().min(0).default(0),

  // Auth — no default on the secret: a fallback here would mean every install
  // that forgets to set it shares the same forgeable signing key.
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('1d'),

  // SMTP (extraction-complete notifications) — all optional. Unset host means
  // NotificationsService no-ops rather than failing a job over a missing mail
  // server; see docs/architecture.md Phase 4.
  SMTP_HOST: Joi.string().allow('').default(''),
  SMTP_PORT: Joi.number().port().default(587),
  SMTP_USER: Joi.string().allow('').default(''),
  SMTP_PASSWORD: Joi.string().allow('').default(''),
  SMTP_FROM: Joi.string().allow('').default(''),
  SMTP_SECURE: Joi.boolean().default(false),

  EXTRACTION_RESULT_TTL_SECONDS: Joi.number().integer().min(60).max(86400).default(3600),
});
