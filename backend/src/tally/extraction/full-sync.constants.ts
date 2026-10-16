/** One flag per company — refuses a second concurrent full sync (or a
 *  mapping/Excel build racing an in-progress sync) against the same company.
 *  Tally serves one request at a time (see TallyConfig.chunkDelayMs's doc
 *  comment); overlapping runs would interleave unrelated requests against the
 *  same connector, which is exactly the load pattern that has wedged Tally
 *  before (see full-sync.service.ts's own doc comments). */
export const fullSyncLockKey = (company: string): string => `tally:full:lock:${company}`;

/** Generous margin over the ~8 minute worst-case observed live against a
 *  1,409-ledger/13,312-voucher company — long enough that a legitimately slow
 *  run is never killed by lock expiry (which would let a second run start
 *  concurrently), short enough that a crashed run's lock self-clears well
 *  before anyone would manually intervene (the boot-time orphan sweep clears
 *  it immediately anyway; this TTL is only the fallback if the process never
 *  restarts at all). */
export const FULL_SYNC_RUN_LOCK_TTL_MS = 30 * 60 * 1000;

/** Mapping/Excel generation are pure in-memory transforms over already-cached
 *  data — seconds, not minutes — but still funnel through the same lock so
 *  they can never read a half-written extraction. */
export const FULL_SYNC_QUICK_LOCK_TTL_MS = 3 * 60 * 1000;
