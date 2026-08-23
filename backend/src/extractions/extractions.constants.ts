import { QueueOptions, WorkerOptions } from 'bullmq';
import { toInt } from '../config/configuration';

export const EXTRACTION_QUEUE = 'extraction';

/**
 * Registered via BullModule.registerQueue in BOTH ExtractionsModule (agent
 * jobs) and TallyModule (local jobs — TallyJobsService). Each registerQueue
 * call constructs its own client-side Queue instance with whatever
 * defaultJobOptions it's given; the underlying Redis-backed queue is shared
 * by name, but defaultJobOptions is NOT — so this is exported and reused in
 * both places rather than duplicated, or a local-mode job silently added
 * with none of the retry/backoff policy that agent-mode jobs get, which is
 * exactly the kind of behavioral drift a shared constant here prevents.
 */
export const EXTRACTION_QUEUE_DEFAULT_JOB_OPTIONS: NonNullable<QueueOptions['defaultJobOptions']> =
  {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  };

/**
 * A plain (non-DI) function, deliberately — `@Processor(EXTRACTION_QUEUE,
 * options)`'s second argument is captured as decorator metadata at
 * class-definition/import time, before Nest's DI container exists, so it
 * cannot be `ConfigService`-resolved (same constraint
 * EXTRACTION_QUEUE_DEFAULT_JOB_OPTIONS above already lives under).
 *
 * Raises BullMQ's worker concurrency from its otherwise-implicit default of
 * 1 (every org/connector in the system sharing one serialized job slot) to
 * something that lets DIFFERENT orgs'/connectors' jobs process in parallel.
 * Safe to raise because Tally itself only ever needs PER-CONNECTOR
 * serialization, and that's enforced independently — each agent already
 * serializes its own Tally HTTP calls internally (TallyHttpClient's `queue`),
 * and ExtractionsProcessor additionally serializes agent-mode dispatch per
 * connectionId in-process (see its `connectorQueues` field) so raising this
 * number can never cause two commands to hit the SAME connector at once.
 * Ships with a conservative default; tune EXTRACTION_WORKER_CONCURRENCY per
 * deployment against real Postgres/Redis connection-pool and Tally-fleet
 * capacity, same "bisect against reality" spirit as TallyConfig's tuning.
 */
export function resolveExtractionWorkerOptions(): Pick<WorkerOptions, 'concurrency'> {
  return { concurrency: toInt(process.env.EXTRACTION_WORKER_CONCURRENCY, 5) };
}

/** How many of a connector's most recent SUCCESS jobs of a given type
 *  ExtractionReuseService scans (newest first) looking for a reusable exact
 *  match — bounded rather than unbounded so a connector with a long history
 *  of one-off VOUCHERS ranges can't turn every dispatch into an expensive
 *  scan. 20 comfortably covers "this bulk export retried a few times" /
 *  "this exact range was fetched earlier today" without being a real cost. */
export const REUSE_CANDIDATE_LOOKBACK = 20;

/** Short-lived guard around the reuse-check-then-create sequence in
 *  ExtractionsService.enqueue — see that method's doc comment. Held only for
 *  the duration of one Postgres read + a Redis EXISTS + (on a miss) one
 *  Postgres insert, so a few seconds is generous, not tight. */
export const DISPATCH_LOCK_TTL_MS = 5_000;

/** Canonical signature for the short dispatch-race lock — one key per
 *  logical "thing being fetched", matching exactly what
 *  ExtractionReuseService treats as equivalent (see its per-type matching
 *  rules) so the lock and the reuse check can never disagree about what
 *  counts as "the same request." */
export const extractionDispatchLockKey = (
  orgId: string,
  connectionId: string,
  type: string,
  company: string,
  variant?: string,
): string =>
  `extraction:dispatch-lock:${orgId}:${connectionId}:${type}:${company}${variant ? `:${variant}` : ''}`;

/**
 * Padding for ExtractionsProcessor.estimateBatchedTimeoutMs's dynamic
 * per-job commandTimeoutMs override (LEDGERS/STOCK_ITEMS only) — the
 * connector's last successful record count is used to estimate this run's
 * batch count, multiplied by this factor to leave headroom for organic
 * growth since that last fetch, plus a small fixed margin on top of the
 * computed worst-case wall-clock budget.
 */
export const BATCH_TIMEOUT_SAFETY_FACTOR = 1.5;
export const BATCH_TIMEOUT_FIXED_MARGIN_MS = 30_000;

/** Redis key holding a completed job's raw result, short-TTL (see
 *  ExtractionConfig.resultTtlSeconds) — never a permanent store, matching
 *  docs/architecture.md's "transient, not persisted" decision. */
export const extractionResultKey = (jobId: string): string => `extraction-result:${jobId}`;
