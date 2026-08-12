import { chunkDateRange } from './date-range-chunker';

describe('chunkDateRange', () => {
  it('returns a single chunk covering the whole range when it fits within chunkDays', () => {
    expect(chunkDateRange('20260401', '20260407', 7)).toEqual([
      { from: '20260401', to: '20260407' },
    ]);
  });

  it('returns a single chunk when fromDate equals toDate', () => {
    expect(chunkDateRange('20260401', '20260401', 7)).toEqual([
      { from: '20260401', to: '20260401' },
    ]);
  });

  it('splits a month into contiguous, non-overlapping 7-day chunks with no gaps', () => {
    const chunks = chunkDateRange('20260401', '20260430', 7);

    expect(chunks).toEqual([
      { from: '20260401', to: '20260407' },
      { from: '20260408', to: '20260414' },
      { from: '20260415', to: '20260421' },
      { from: '20260422', to: '20260428' },
      { from: '20260429', to: '20260430' }, // final chunk is a short remainder, not padded
    ]);
  });

  it('spans a month boundary correctly (chunk crossing Feb->Mar)', () => {
    const chunks = chunkDateRange('20260225', '20260305', 7);

    expect(chunks).toEqual([
      { from: '20260225', to: '20260303' },
      { from: '20260304', to: '20260305' },
    ]);
  });

  it('produces exactly one chunk per day when chunkDays is 1', () => {
    const chunks = chunkDateRange('20260401', '20260403', 1);

    expect(chunks).toEqual([
      { from: '20260401', to: '20260401' },
      { from: '20260402', to: '20260402' },
      { from: '20260403', to: '20260403' },
    ]);
  });

  it('throws when fromDate is after toDate', () => {
    expect(() => chunkDateRange('20260430', '20260401', 7)).toThrow('must not be after');
  });

  it('throws for a non-positive chunkDays', () => {
    expect(() => chunkDateRange('20260401', '20260407', 0)).toThrow('chunkDays must be >= 1');
  });
});
