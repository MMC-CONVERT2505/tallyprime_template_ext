import { TallyStockItem, TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { CreditNoteMapper } from './credit-note.mapper';
import { buildStockItemIndex } from './voucher-line.shared';

describe('CreditNoteMapper', () => {
  const item = (overrides: Partial<TallyStockItem>): TallyStockItem => ({
    name: 'Widget A',
    parent: null,
    description: null,
    baseUnit: null,
    openingBalance: null,
    openingValue: null,
    closingBalance: null,
    closingValue: null,
    alterId: 1,
    alias: null,
    hsnCode: null,
    gstRate: null,
    ...overrides,
  });

  const voucher = (overrides: Partial<TallyVoucher>): TallyVoucher => ({
    date: '20250415',
    voucherType: 'Credit Note',
    voucherNumber: 'CN-1',
    partyLedgerName: 'ABC Traders',
    narration: 'Sales return',
    reference: null,
    alterId: 1,
    ledgerEntries: [],
    inventoryEntries: [],
    partyGstin: null,
    placeOfSupply: null,
    ...overrides,
  });

  it('emits one row per inventory line with the tax derived from the item index', () => {
    const itemIndex = buildStockItemIndex([
      item({ name: 'Widget A', hsnCode: '392321', gstRate: 18 }),
    ]);
    const mapper = new CreditNoteMapper(itemIndex);
    const [row] = mapper.toCreditNoteRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 }],
      }),
    ]);

    expect(row['Credit Note Number']).toBe('CN-1');
    expect(row['HSN/SAC']).toBe('392321');
    expect(row['Item Tax']).toBe('GST18');
    expect(row['Item Tax %']).toBe(18);
    expect(row.Notes).toBe('Sales return');
  });

  it('skips a voucher with no inventory entries', () => {
    const mapper = new CreditNoteMapper(buildStockItemIndex([]));
    expect(mapper.toCreditNoteRows([voucher({ inventoryEntries: [] })])).toEqual([]);
  });
});
