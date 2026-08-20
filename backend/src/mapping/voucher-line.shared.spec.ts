import { buildStockItemIndex, tallyDateToJsDate } from './voucher-line.shared';

describe('tallyDateToJsDate', () => {
  it('converts a YYYYMMDD string to a UTC-noon Date', () => {
    const date = tallyDateToJsDate('20250415');
    expect(date).toEqual(new Date(Date.UTC(2025, 3, 15, 12)));
  });

  it('returns null for null, empty, or malformed input rather than throwing', () => {
    expect(tallyDateToJsDate(null)).toBeNull();
    expect(tallyDateToJsDate('')).toBeNull();
    expect(tallyDateToJsDate('2025-04-15')).toBeNull();
    expect(tallyDateToJsDate('not-a-date')).toBeNull();
  });
});

describe('buildStockItemIndex', () => {
  it('indexes stock items by name for O(1) lookup', () => {
    const index = buildStockItemIndex([
      {
        name: 'Widget A',
        parent: null,
        description: null,
        baseUnit: null,
        openingBalance: null,
        openingValue: null,
        closingBalance: null,
        closingValue: null,
        alterId: 1,
        alias: 'WGT-A',
        hsnCode: '392321',
        gstRate: 18,
      },
    ]);
    expect(index.get('Widget A')?.alias).toBe('WGT-A');
    expect(index.get('Nonexistent')).toBeUndefined();
  });
});
