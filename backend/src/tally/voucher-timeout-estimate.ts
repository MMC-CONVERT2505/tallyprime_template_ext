import { TallyConfig } from '../config/configuration';
import { chunkDateRange } from './date-range-chunker';

/**
 * Extra headroom on top of the raw worst-case wall-clock estimate below —
 * shared with (imported from) ExtractionsProcessor's LEDGERS/STOCK_ITEMS
 * batch-timeout estimate, which uses the same constant for the same reason:
 * this is an estimate, not a promise the agent's chunking is configured
 * identically.
 */
export const VOUCHER_TIMEOUT_FIXED_MARGIN_MS = 30_000;

/**
 * Deterministic worst-case wall-clock budget for one VOUCHERS command
 * covering `[from, to]`, mirroring TransactionExtractionService.
 * fetchVouchersChunked's actual chunking exactly — see that method's doc
 * comment. Unlike LEDGERS/STOCK_ITEMS (whose batch count depends on the
 * company's record count, unknowable ahead of dispatch), a Day Book chunk
 * count is fully determined by the date range and `voucherChunkDays`, so no
 * historical-record-count estimate is needed here.
 *
 * Two branches, matching `fetchVouchersChunked`'s own `chunks.length <= 1`
 * check:
 *   - Unchunked (range fits in one request): worst case is one call plus its
 *     own retries, `timeoutMs × (maxRetries + 1)`.
 *   - Chunked: each chunk is sent with `retries: 0` (chunking already trades
 *     "one big risky call" for "several small reliable ones" — see
 *     fetchVouchersChunked's doc comment on why nested per-chunk retries
 *     would just multiply the worst-case wait), so the total is
 *     `chunks × (timeoutMs + chunkDelayMs)`, NOT multiplied by
 *     `(maxRetries + 1)`.
 *
 * This is the single source of truth for "how long can a VOUCHERS command
 * legitimately take" — used both for the per-dispatch agent timeout
 * (ExtractionsProcessor.estimateBatchedTimeoutMs) and the bulk-export
 * orchestrator's poll budget for a VOUCHERS step (BulkExportService), so the
 * two can never drift apart the way they did before (see the incident this
 * function's introduction fixed: a 26-year Sales Vouchers range blew a
 * static 15-minute timeout on attempt 1).
 */
export function estimateVouchersTimeoutMs(from: string, to: string, tally: TallyConfig): number {
  const chunks = chunkDateRange(from, to, tally.voucherChunkDays);
  const raw =
    chunks.length <= 1
      ? tally.timeoutMs * (tally.maxRetries + 1)
      : chunks.length * (tally.timeoutMs + tally.chunkDelayMs);
  return raw + VOUCHER_TIMEOUT_FIXED_MARGIN_MS;
}
