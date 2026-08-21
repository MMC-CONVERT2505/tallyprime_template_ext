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
  /**
   * Batch size for LEDGERS/STOCK_ITEMS requests that ALSO carry a
   * fromDate/toDate (SVFROMDATE/SVTODATE) period scope. Defaults to 4,
   * bisected live against a real Tally instance (not a guess) — but the
   * batch-size ceiling is only HALF the story:
   *
   *  1. Tally's own system-computed ledgers (RESERVEDNAME set — e.g.
   *     "Profit & Loss A/c") wedge Tally on a period-scoped balance request
   *     even completely ALONE (confirmed: a single-ledger request for it
   *     never returned, one CPU core pegged flat for 5+ minutes, forcibly
   *     killed; the identical request for an ordinary ledger returns in
   *     under 100ms). This has nothing to do with batch size — it's a
   *     rollup over the company's entire income/expense history, not a
   *     transactional account — so MasterExtractionService.
   *     fetchLedgersBatched excludes these from period-scoped batches
   *     entirely (still returned in the result, with a null balance and a
   *     logged reason) rather than trying to size a batch around them.
   *
   *  2. SEPARATELY, ordinary (non-reserved) ledgers batched together also
   *     have a real ceiling: bisected at 4 (consistently fine, ~40-100ms)
   *     vs 10 (consistently wedged — this time manifesting as a stuck,
   *     near-zero-CPU non-response rather than a CPU spin, a different
   *     symptom from case 1 but equally unrecoverable without a kill).
   *     The true boundary is somewhere in [5, 9]; 4 is what was actually
   *     proven, not a round-number guess — narrowing further costs a full
   *     Tally-hang-and-relaunch cycle per data point, so this stopped at a
   *     safe, evidenced value rather than chasing precision.
   *
   * An earlier version of this fix defaulted to 25, then 1, on the
   * assumption that ALL period-scoped multi-ledger batching was uniformly
   * broken — wrong: once the one reserved ledger is excluded, ordinary
   * ledgers batch together fine up to the real (higher) ceiling above. Only
   * raise this after re-bisecting (reserved ledgers excluded first) against
   * the specific Tally instance in question.
   */
  periodBatchSize: number;
  /**
   * Circuit breaker for a genuinely wedged Tally (not just one flaky call) —
   * see TallyHttpClient. After this many CONSECUTIVE logical requests (each
   * already past its own retries) come back as a transient failure (timeout/
   * unreachable), every further request fails immediately with a clear,
   * actionable message instead of independently waiting out a full
   * TALLY_TIMEOUT_MS to rediscover the same hang. Caught live 2026-08-21: a
   * STOCK_ITEMS batch timeout was followed by 3+ more independent ~60s/8s
   * timeouts before the job finally gave up, while a raw HTTP probe straight
   * to Tally's port (bypassing this app entirely) confirmed it was accepting
   * the TCP connection instantly but never answering ANY request — Tally's
   * own engine was wedged (most likely a blocking dialog: a security/
   * password prompt, license reminder, or unsaved report on screen), which
   * no amount of client-side retrying can fix. 2 is deliberately not 1: the
   * existing "one bad request does not jam the queue" guarantee (see
   * tally-http.client.spec.ts) must still hold for a single flaky call.
   */
  circuitBreakerThreshold: number;
  /** How long the circuit stays open (failing fast) after tripping, before
   *  the next request is allowed through normally to test recovery. */
  circuitOpenMs: number;
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

/**
 * BulkExportService's "every Zoho-mapped entity for one company, zipped"
 * orchestration — see that service's doc comment for the step sequence.
 */
export interface BulkExportConfig {
  /**
   * Where generated .zip files are written, relative to process.cwd() when
   * not absolute (same convention as bridge-state.util.ts's
   * DEFAULT_BRIDGE_STATE_PATH). NOT under `dist/` or `src/` — this holds
   * runtime-generated output containing real customer financial data
   * (GSTIN/PAN/bank details), never something to ship inside a build.
   */
  exportsDir: string;
  /** How long a single step (one master/voucher extraction job) is polled
   *  before the whole bulk export is given up on as stuck. */
  stepTimeoutMs: number;
  /** How often a still-PENDING step's job status is re-checked. */
  pollIntervalMs: number;
  /** How long a completed export's status/step record stays readable from
   *  Redis — kept roughly as long as the zip itself stays on disk (see
   *  retentionHours), so "can I still download this" tracks one lifetime,
   *  not two independently-expiring ones. */
  recordTtlSeconds: number;
  /** Zips older than this are opportunistically deleted from exportsDir the
   *  next time a bulk export starts — see BulkExportService.pruneOldExports. */
  retentionHours: number;
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
  bulkExport: BulkExportConfig;
}

export const toBool = (v: string | undefined, fallback: boolean): boolean => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

export const toInt = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Bracket a raw IPv6 literal for use in a URL (`::1` -> `[::1]`), a no-op for
 * hostnames/IPv4. Without this, `http://${host}:${port}` builds an invalid
 * URL for any IPv6 TALLY_HOST — the colons in the address collide with the
 * URL's own `:port` separator. Encountered live: on some Windows machines
 * TallyPrime's "Act as Server" binds the IPv6 loopback (`::1`) only, so a
 * `127.0.0.1`-only assumption here silently means Tally is *never* reachable
 * on that machine no matter how correctly "Act as Server" is configured —
 * every request fails ECONNREFUSED, indistinguishable from Tally actually
 * being closed.
 */
const formatHostForUrl = (host: string): string =>
  host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

/** Shared by both the server config (below) and agent-configuration.ts. */
export const buildTallyConfig = (): TallyConfig => {
  const tallyHost = process.env.TALLY_HOST ?? '127.0.0.1';
  const tallyPort = toInt(process.env.TALLY_PORT, 9001);
  return {
    host: tallyHost,
    port: tallyPort,
    baseUrl: `http://${formatHostForUrl(tallyHost)}:${tallyPort}`,
    timeoutMs: toInt(process.env.TALLY_TIMEOUT_MS, 60000),
    probeTimeoutMs: toInt(process.env.TALLY_PROBE_TIMEOUT_MS, 8000),
    responseEncoding: (process.env.TALLY_RESPONSE_ENCODING ?? 'auto').toLowerCase(),
    defaultCompany: process.env.TALLY_DEFAULT_COMPANY ?? '',
    maxRetries: toInt(process.env.TALLY_MAX_RETRIES, 2),
    retryBaseMs: toInt(process.env.TALLY_RETRY_BASE_MS, 500),
    voucherChunkDays: toInt(process.env.TALLY_VOUCHER_CHUNK_DAYS, 7),
    chunkDelayMs: toInt(process.env.TALLY_CHUNK_DELAY_MS, 2000),
    masterBatchSize: toInt(process.env.TALLY_MASTER_BATCH_SIZE, 300),
    periodBatchSize: toInt(process.env.TALLY_PERIOD_BATCH_SIZE, 4),
    circuitBreakerThreshold: toInt(process.env.TALLY_CIRCUIT_BREAKER_THRESHOLD, 2),
    circuitOpenMs: toInt(process.env.TALLY_CIRCUIT_OPEN_MS, 15000),
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
    bulkExport: {
      exportsDir: process.env.EXPORTS_DIR || 'public/exports',
      stepTimeoutMs: toInt(process.env.BULK_EXPORT_STEP_TIMEOUT_MS, 1_200_000),
      pollIntervalMs: toInt(process.env.BULK_EXPORT_POLL_INTERVAL_MS, 2000),
      recordTtlSeconds: toInt(process.env.BULK_EXPORT_RECORD_TTL_SECONDS, 604_800),
      retentionHours: toInt(process.env.BULK_EXPORT_RETENTION_HOURS, 168),
    },
  };
};
