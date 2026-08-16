/**
 * Typed configuration factory. Everything downstream reads config through
 * `ConfigService.get<AppConfig[...]>()` rather than touching process.env directly,
 * so there is a single, typed source of truth.
 */
export interface TallyConfig {
  host: string;
  port: number;
  /** Full base URL Tally listens on, e.g. http://127.0.0.1:9001 */
  baseUrl: string;
  timeoutMs: number;
  /**
   * Short, no-retry timeout for connectivity probes/health checks (TallyDiagnosticsService.probe).
   * Deliberately separate from `timeoutMs`: probing is itself a "is it alive"
   * check, so it must fail fast — reusing the full extraction timeout+retry
   * pipeline meant a probe could block for timeoutMs * (maxRetries + 1) plus
   * backoff (with the 60s/2-retry defaults, up to ~3 minutes) before ever
   * telling the caller Tally is unreachable.
   */
  probeTimeoutMs: number;
  /** 'auto' trusts the Content-Type header; otherwise force this decoder. */
  responseEncoding: string;
  defaultCompany: string;
  /** Extra attempts (beyond the first) on transient errors (timeout/unreachable). 0 disables retrying. */
  maxRetries: number;
  /** Exponential backoff base, e.g. 500ms → 500ms, 1000ms, 2000ms, ... */
  retryBaseMs: number;
  /**
   * VOUCHERS (Day Book) requests wider than this many days are automatically
   * split into contiguous sub-requests of at most this size — see
   * date-range-chunker.ts and TransactionExtractionService.getVouchers. Does
   * NOT apply to LEDGERS/STOCK_ITEMS: their balance-as-of-date computation
   * doesn't get cheaper with a narrower window (Tally still walks history
   * from the company's books-from date regardless), so chunking those by
   * date would only multiply work, not reduce it.
   */
  voucherChunkDays: number;
  /**
   * Pause between successive VOUCHERS chunk requests. Tally's HTTP server
   * handles one request at a time on a machine that's often
   * resource-constrained (see the Tally-hang investigation this project has
   * been through) — firing chunk N+1 the instant chunk N's response lands
   * gives Tally, and the OS's memory manager, a moment to breathe instead of
   * hammering it back-to-back. 0 disables the pause entirely.
   */
  chunkDelayMs: number;
  /**
   * LEDGERS/STOCK_ITEMS collections larger than this many records are split
   * into contiguous name-range sub-requests of at most this size instead of
   * one unbounded request — see MasterExtractionService's batched fetch
   * methods. Unlike voucherChunkDays (a date axis that doesn't shrink a
   * balance computation), this genuinely shrinks what Tally has to build and
   * send back per call. A company at or under this size sees zero behavior
   * change (still the original single-shot request).
   */
  masterBatchSize: number;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  /** Full connection string passed to Prisma. Defaults to one built from the
   *  discrete fields above; set DATABASE_URL directly to override (e.g. a
   *  managed Postgres URL with `?sslmode=require` in production). */
  url: string;
  /** Log every Prisma query. Dev-only — noisy and never wanted in production. */
  logging: boolean;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
}

export interface AuthConfig {
  jwtSecret: string;
  /** e.g. '15m', '1d' — anything ms(): https://github.com/vercel/ms accepts. */
  jwtExpiresIn: string;
}

/** All optional — completion emails are a nice-to-have, not a boot requirement.
 *  NotificationsService no-ops (logs at debug, never throws) when host is unset,
 *  same graceful-degrade pattern as Redis/Postgres elsewhere in this app. */
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  secure: boolean;
}

export interface ExtractionConfig {
  /** How long a completed job's result stays fetchable from Redis before
   *  expiring — see docs/architecture.md's "transient, not persisted" decision. */
  resultTtlSeconds: number;
  /**
   * How long TallyTunnelGateway.sendCommand waits for a connected agent to
   * answer one extraction command before giving up, sending 'cancel', and
   * letting BullMQ retry (see ExtractionsProcessor — that retry is now
   * deduped/serialized per job via sendCommand's dedupeKey, so widening this
   * value doesn't paper over a stuck agent, it just changes when a genuinely
   * abandoned command gets cancelled). Must comfortably exceed the agent's
   * own worst-case Tally round trip for a SINGLE call (its TALLY_TIMEOUT_MS ×
   * (maxRetries + 1) + backoff — with that config's own 60s/2-retry
   * defaults, up to ~180s) — or a slow-but-working Tally call gets
   * misreported as "agent did not respond."
   *
   * Two families of multi-call commands can legitimately exceed a single
   * call's budget, not just one:
   *   - A chunked VOUCHERS command (date-range-chunker.ts): worst case (all
   *     chunks time out, 0 retries each) is roughly
   *     chunks × (TALLY_TIMEOUT_MS + TALLY_CHUNK_DELAY_MS). At the
   *     7-day/60s/2s defaults, a full month is 5 chunks ≈ 310s.
   *   - A batched LEDGERS/STOCK_ITEMS command (MasterExtractionService's
   *     AlterID batching): one un-batched names+AlterID pass
   *     (TALLY_TIMEOUT_MS × (maxRetries+1)) plus
   *     batchCount × (TALLY_TIMEOUT_MS + TALLY_CHUNK_DELAY_MS). At the
   *     300/60s/2s defaults, a 6,000-ledger company is 20 batches ≈ 24 min —
   *     this static default is sized to comfortably outlast a "large but not
   *     extreme" company; ExtractionsProcessor.estimateBatchedTimeoutMs
   *     computes a per-job override above this floor once the connector has
   *     at least one successful prior fetch to estimate a batch count from.
   *
   * This is a ceiling for one already-dispatched command, not added latency
   * on the common path — a fast Tally still answers fast.
   */
  commandTimeoutMs: number;
}

export interface AppConfig {
  env: string;
  port: number;
  globalPrefix: string;
  tally: TallyConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  auth: AuthConfig;
  smtp: SmtpConfig;
  extraction: ExtractionConfig;
}

export const toBool = (v: string | undefined, fallback: boolean): boolean => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

export const toInt = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Shared by both the server config (below) and agent-configuration.ts. */
export const buildTallyConfig = (): TallyConfig => {
  const tallyHost = process.env.TALLY_HOST ?? '127.0.0.1';
  const tallyPort = toInt(process.env.TALLY_PORT, 9001);
  return {
    host: tallyHost,
    port: tallyPort,
    baseUrl: `http://${tallyHost}:${tallyPort}`,
    timeoutMs: toInt(process.env.TALLY_TIMEOUT_MS, 60000),
    probeTimeoutMs: toInt(process.env.TALLY_PROBE_TIMEOUT_MS, 8000),
    responseEncoding: (process.env.TALLY_RESPONSE_ENCODING ?? 'auto').toLowerCase(),
    defaultCompany: process.env.TALLY_DEFAULT_COMPANY ?? '',
    maxRetries: toInt(process.env.TALLY_MAX_RETRIES, 2),
    retryBaseMs: toInt(process.env.TALLY_RETRY_BASE_MS, 500),
    voucherChunkDays: toInt(process.env.TALLY_VOUCHER_CHUNK_DAYS, 7),
    chunkDelayMs: toInt(process.env.TALLY_CHUNK_DELAY_MS, 2000),
    masterBatchSize: toInt(process.env.TALLY_MASTER_BATCH_SIZE, 300),
  };
};

export default (): AppConfig => {
  const dbHost = process.env.DB_HOST ?? '127.0.0.1';
  const dbPort = toInt(process.env.DB_PORT, 5432);
  const dbUser = process.env.DB_USER ?? 'tally';
  const dbPassword = process.env.DB_PASSWORD ?? 'tally';
  const dbName = process.env.DB_NAME ?? 'tally_migration';

  return {
    env: process.env.NODE_ENV ?? 'development',
    port: toInt(process.env.PORT, 3000),
    globalPrefix: process.env.APP_GLOBAL_PREFIX ?? 'api',
    tally: buildTallyConfig(),
    database: {
      host: dbHost,
      port: dbPort,
      username: dbUser,
      password: dbPassword,
      database: dbName,
      url:
        process.env.DATABASE_URL ||
        `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${dbHost}:${dbPort}/${dbName}`,
      logging: toBool(process.env.DB_LOGGING, false),
    },
    redis: {
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: toInt(process.env.REDIS_PORT, 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: toInt(process.env.REDIS_DB, 0),
    },
    auth: {
      jwtSecret: process.env.JWT_SECRET ?? '',
      jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
    },
    smtp: {
      host: process.env.SMTP_HOST ?? '',
      port: toInt(process.env.SMTP_PORT, 587),
      user: process.env.SMTP_USER ?? '',
      password: process.env.SMTP_PASSWORD ?? '',
      from: process.env.SMTP_FROM ?? '',
      secure: toBool(process.env.SMTP_SECURE, false),
    },
    extraction: {
      resultTtlSeconds: toInt(process.env.EXTRACTION_RESULT_TTL_SECONDS, 3600),
      commandTimeoutMs: toInt(process.env.EXTRACTION_COMMAND_TIMEOUT_MS, 900000),
    },
  };
};
