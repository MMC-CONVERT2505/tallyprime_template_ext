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
  synchronize: boolean;
  logging: boolean;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
}

export interface AppConfig {
  env: string;
  port: number;
  globalPrefix: string;
  tally: TallyConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
}

const toBool = (v: string | undefined, fallback: boolean): boolean => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const toInt = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export default (): AppConfig => {
  const tallyHost = process.env.TALLY_HOST ?? '127.0.0.1';
  const tallyPort = toInt(process.env.TALLY_PORT, 9000);

  return {
    env: process.env.NODE_ENV ?? 'development',
    port: toInt(process.env.PORT, 3000),
    globalPrefix: process.env.APP_GLOBAL_PREFIX ?? 'api',
    tally: {
      host: tallyHost,
      port: tallyPort,
      baseUrl: `http://${tallyHost}:${tallyPort}`,
      timeoutMs: toInt(process.env.TALLY_TIMEOUT_MS, 60000),
      responseEncoding: (process.env.TALLY_RESPONSE_ENCODING ?? 'auto').toLowerCase(),
      defaultCompany: process.env.TALLY_DEFAULT_COMPANY ?? '',
    },
    database: {
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: toInt(process.env.DB_PORT, 5432),
      username: process.env.DB_USER ?? 'tally',
      password: process.env.DB_PASSWORD ?? 'tally',
      database: process.env.DB_NAME ?? 'tally_migration',
      synchronize: toBool(process.env.DB_SYNCHRONIZE, true),
      logging: toBool(process.env.DB_LOGGING, false),
    },
    redis: {
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: toInt(process.env.REDIS_PORT, 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: toInt(process.env.REDIS_DB, 0),
    },
  };
};
