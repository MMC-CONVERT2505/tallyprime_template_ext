export const EXTRACTION_QUEUE = 'extraction';

/** Redis key holding a completed job's raw result, short-TTL (see
 *  ExtractionConfig.resultTtlSeconds) — never a permanent store, matching
 *  docs/architecture.md's "transient, not persisted" decision. */
export const extractionResultKey = (jobId: string): string => `extraction-result:${jobId}`;
