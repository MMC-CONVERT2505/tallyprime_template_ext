import { TallyStockItem, TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { StockJournalMapper } from './stock-journal.mapper';
import { buildStockItemIndex } from './voucher-line.shared';

describe('StockJournalMapper', () => {
  const item = (overrides: Partial<TallyStockItem>): TallyStockItem => ({
    name: 'Widget A',
    parent: null,
    description: null,
    baseUnit: 'Nos',
    openingBalance: null,
    openingValue: null,
    closingBalance: null,
    closingValue: null,
    alterId: 1,
    alias: 'WGT-A',
    hsnCode: null,
    gstRate: null,
    ...overrides,
  });

  const voucher = (overrides: Partial<TallyVoucher>): TallyVoucher => ({
    date: '20250415',
    voucherType: 'Stock Journal',
    voucherNumber: 'SJ-1',
    partyLedgerName: null,
    narration: 'Stocktaking adjustment',
    reference: 'REF-001',
    alterId: 1,
    ledgerEntries: [],
    inventoryEntries: [],
    partyGstin: null,
    placeOfSupply: null,
    ...overrides,
  });

  it('maps quantity-adjustment fields, always hardcoding Status to "adjusted"', () => {
    const itemIndex = buildStockItemIndex([item({ name: 'Widget A' })]);
    const mapper = new StockJournalMapper(itemIndex);
    const [row] = mapper.toStockJournalRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: -12, rate: null, amount: -600 }],
      }),
    ]);

    expect(row.Status).toBe('adjusted');
    expect(row['Reference Number']).toBe('REF-001');
    expect(row.Description).toBe('Stocktaking adjustment');
    expect(row['Quantity Adjusted']).toBe(-12);
    expect(row['Adjusted Value']).toBe(-600);
    expect(row.SKU).toBe('WGT-A');
    expect(row.Unit).toBe('Nos');
  });

  it('falls back to voucherNumber when reference is absent', () => {
    const mapper = new StockJournalMapper(buildStockItemIndex([]));
    const [row] = mapper.toStockJournalRows([
      voucher({
        reference: null,
        voucherNumber: 'SJ-2',
        inventoryEntries: [{ stockItemName: 'X', quantity: 1, rate: null, amount: 1 }],
      }),
    ]);
    expect(row['Reference Number']).toBe('SJ-2');
  });

  it('skips a voucher with no inventory entries', () => {
    const mapper = new StockJournalMapper(buildStockItemIndex([]));
    expect(mapper.toStockJournalRows([voucher({ inventoryEntries: [] })])).toEqual([]);
  });

  it('has no GST columns at all, unlike the other 3 voucher mappers', () => {
    const mapper = new StockJournalMapper(buildStockItemIndex([]));
    const [row] = mapper.toStockJournalRows([
      voucher({ inventoryEntries: [{ stockItemName: 'X', quantity: 1, rate: null, amount: 1 }] }),
    ]);
    expect(row).not.toHaveProperty('Item Tax');
    expect(row).not.toHaveProperty('HSN/SAC');
  });
});
