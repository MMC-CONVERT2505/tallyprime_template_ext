/**
 * Typed configuration factory. Everything downstream reads config through
 * `ConfigService.get<AppConfig[...]>()` rather than touching process.env directly,
 * so there is a single, typed source of truth.
 */
export interface TallyConfig {
  host: string;
  port: number;
  /** Full base URL Tally listens on, e.g. http://127.0.0.1:9000 */
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
   * answer one extraction command. Must comfortably exceed the agent's own
   * worst-case Tally round trip (its TALLY_TIMEOUT_MS × (maxRetries + 1) +
   * backoff — with that config's own 60s/2-retry defaults, up to ~180s), or
   * a slow-but-working Tally call gets misreported as "agent did not
   * respond" and the result silently dropped when it arrives late. This is
   * a *ceiling* for one already-dispatched command, not added latency on the
   * common path — a fast Tally still answers fast.
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
  const tallyPort = toInt(process.env.TALLY_PORT, 9000);
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
      commandTimeoutMs: toInt(process.env.EXTRACTION_COMMAND_TIMEOUT_MS, 180000),
    },
  };
};
