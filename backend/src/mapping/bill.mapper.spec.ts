import { TallyStockItem, TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { BillMapper } from './bill.mapper';
import { buildStockItemIndex } from './voucher-line.shared';

describe('BillMapper', () => {
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
    voucherType: 'Purchase',
    voucherNumber: 'BILL-1',
    partyLedgerName: 'Reliable Supplies Co',
    narration: null,
    reference: null,
    alterId: 1,
    ledgerEntries: [],
    inventoryEntries: [],
    partyGstin: null,
    placeOfSupply: null,
    ...overrides,
  });

  it('computes Tax Amount from the line amount and the item GST rate', () => {
    const itemIndex = buildStockItemIndex([item({ name: 'Widget A', gstRate: 18 })]);
    const mapper = new BillMapper(itemIndex);
    const [row] = mapper.toBillRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 2, rate: 500, amount: 1000 }],
      }),
    ]);

    expect(row['Tax Percentage']).toBe(18);
    expect(row['Tax Amount']).toBe(180); // 1000 * 0.18
    expect(row['Item Total']).toBe(1000);
  });

  it('rounds Tax Amount to 2 decimal places', () => {
    const itemIndex = buildStockItemIndex([item({ name: 'Widget A', gstRate: 12.5 })]);
    const mapper = new BillMapper(itemIndex);
    const [row] = mapper.toBillRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 33.33, amount: 33.33 }],
      }),
    ]);
    expect(row['Tax Amount']).toBe(4.17); // 33.33 * 0.125 = 4.16625 -> 4.17
  });

  it('leaves Tax Amount blank when the item has no known GST rate', () => {
    const mapper = new BillMapper(buildStockItemIndex([]));
    const [row] = mapper.toBillRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Unknown Item', quantity: 1, rate: 100, amount: 100 }],
      }),
    ]);
    expect(row['Tax Amount']).toBe('');
  });

  it('emits one row per inventory line and skips vouchers with none', () => {
    const mapper = new BillMapper(buildStockItemIndex([]));
    expect(
      mapper.toBillRows([
        voucher({
          inventoryEntries: [
            { stockItemName: 'A', quantity: 1, rate: 10, amount: 10 },
            { stockItemName: 'B', quantity: 1, rate: 20, amount: 20 },
          ],
        }),
        voucher({ voucherNumber: 'BILL-2', inventoryEntries: [] }),
      ]),
    ).toHaveLength(2);
  });
});
