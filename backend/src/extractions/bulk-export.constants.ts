/** Redis key holding one BulkExportRecord (see bulk-export.service.ts),
 *  short-TTL like extractionResultKey — same "transient, not a permanent
 *  store" convention the rest of this project's job results follow. */
export const bulkExportKey = (id: string): string => `bulk-export:${id}`;

/** Per-org recent-ids list (Redis LIST, newest first) backing the "list my
 *  bulk exports" UI — the individual bulkExportKey records already expire on
 *  their own TTL, so a stale id in this list just resolves to "not found"
 *  rather than needing its own separate cleanup. */
export const bulkExportIndexKey = (orgId: string): string => `bulk-export:index:${orgId}`;

/** One flag per (org, company) — refuses a second concurrent bulk export
 *  against the same company while one is already running. Tally serves one
 *  request at a time (see TallyConfig.chunkDelayMs's doc comment); two
 *  overlapping bulk exports would interleave unrelated Day Book/master
 *  requests against the same connector, which is exactly the load pattern
 *  that has wedged Tally before. */
export const bulkExportLockKey = (orgId: string, company: string): string =>
  `bulk-export:lock:${orgId}:${company}`;

export const BULK_EXPORT_INDEX_MAX_ENTRIES = 20;
