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
  /** 'auto' trusts the Content-Type header; otherwise force this decoder. */
  responseEncoding: string;
  defaultCompany: string;
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

/** Auth for the agent<->gateway WebSocket tunnel. See docs/architecture.md Phase 1-2 vs 3:
 *  this shared secret only proves "some legitimate agent build," not which org/install —
 *  per-org device credentials + revocation are Phase 3, not built yet. */
export interface GatewayConfig {
  agentSharedSecret: string;
}

export interface AppConfig {
  env: string;
  port: number;
  globalPrefix: string;
  tally: TallyConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  auth: AuthConfig;
  gateway: GatewayConfig;
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
    responseEncoding: (process.env.TALLY_RESPONSE_ENCODING ?? 'auto').toLowerCase(),
    defaultCompany: process.env.TALLY_DEFAULT_COMPANY ?? '',
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
    gateway: {
      agentSharedSecret: process.env.AGENT_SHARED_SECRET ?? '',
    },
  };
};
