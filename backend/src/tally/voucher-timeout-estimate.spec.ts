import { TallyConfig } from '../config/configuration';
import { estimateVouchersTimeoutMs, VOUCHER_TIMEOUT_FIXED_MARGIN_MS } from './voucher-timeout-estimate';

describe('estimateVouchersTimeoutMs', () => {
  const tally: Pick<
    TallyConfig,
    'timeoutMs' | 'maxRetries' | 'chunkDelayMs' | 'voucherChunkDays'
  > = {
    timeoutMs: 60000,
    maxRetries: 2,
    chunkDelayMs: 2000,
    voucherChunkDays: 7,
  };

  it('unchunked range (fits in one request): timeoutMs × (maxRetries + 1), plus margin — no chunk-delay term', () => {
    const result = estimateVouchersTimeoutMs('20260401', '20260407', tally as TallyConfig);
    expect(result).toBe(60000 * 3 + VOUCHER_TIMEOUT_FIXED_MARGIN_MS);
  });

  it('chunked range: chunks × (timeoutMs + chunkDelayMs), NOT multiplied by (maxRetries + 1) — chunks use retries:0', () => {
    // A 30-day range at 7-day chunks is 5 chunks.
    const result = estimateVouchersTimeoutMs('20260401', '20260430', tally as TallyConfig);
    expect(result).toBe(5 * (60000 + 2000) + VOUCHER_TIMEOUT_FIXED_MARGIN_MS);
  });

  it('a multi-year range produces a proportionally large budget, not the tiny static default', () => {
    // ~26 years, 7-day chunks — this is the exact shape of range that blew
    // the old static 900_000ms default on its very first attempt.
    const result = estimateVouchersTimeoutMs('20000101', '20260815', tally as TallyConfig);
    expect(result).toBeGreaterThan(900_000 * 10);
  });

  it('a single-day range is unchunked', () => {
    const result = estimateVouchersTimeoutMs('20260401', '20260401', tally as TallyConfig);
    expect(result).toBe(60000 * 3 + VOUCHER_TIMEOUT_FIXED_MARGIN_MS);
  });
});
