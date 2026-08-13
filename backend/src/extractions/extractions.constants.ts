import { QueueOptions } from 'bullmq';

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
export const EXTRACTION_QUEUE_DEFAULT_JOB_OPTIONS: NonNullable<QueueOptions['defaultJobOptions']> = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
};

/** Redis key holding a completed job's raw result, short-TTL (see
 *  ExtractionConfig.resultTtlSeconds) — never a permanent store, matching
 *  docs/architecture.md's "transient, not persisted" decision. */
export const extractionResultKey = (jobId: string): string => `extraction-result:${jobId}`;
