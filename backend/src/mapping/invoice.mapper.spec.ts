import { TallyStockItem, TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { InvoiceMapper } from './invoice.mapper';
import { buildStockItemIndex } from './voucher-line.shared';

describe('InvoiceMapper', () => {
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
    voucherType: 'Sales',
    voucherNumber: 'INV-1042',
    partyLedgerName: 'ABC Traders',
    narration: null,
    reference: null,
    alterId: 1,
    ledgerEntries: [],
    inventoryEntries: [],
    partyGstin: null,
    placeOfSupply: null,
    ...overrides,
  });

  it('emits one row per inventory line, repeating the header fields', () => {
    const mapper = new InvoiceMapper(buildStockItemIndex([]));
    const rows = mapper.toInvoiceRows([
      voucher({
        inventoryEntries: [
          { stockItemName: 'Widget A', quantity: 2, rate: 1000, amount: 2000 },
          { stockItemName: 'Widget B', quantity: 1, rate: 500, amount: 500 },
        ],
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]['Invoice Number']).toBe('INV-1042');
    expect(rows[1]['Invoice Number']).toBe('INV-1042');
    expect(rows[0]['Item Name']).toBe('Widget A');
    expect(rows[1]['Item Name']).toBe('Widget B');
  });

  it('skips a voucher with no inventory entries, rather than emitting a header-only row', () => {
    const mapper = new InvoiceMapper(buildStockItemIndex([]));
    expect(mapper.toInvoiceRows([voucher({ inventoryEntries: [] })])).toEqual([]);
  });

  it('cross-references HSN/GST rate from the stock item index, not the voucher line', () => {
    const itemIndex = buildStockItemIndex([
      item({ name: 'Widget A', hsnCode: '392321', gstRate: 18 }),
    ]);
    const mapper = new InvoiceMapper(itemIndex);
    const [row] = mapper.toInvoiceRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 }],
      }),
    ]);

    expect(row['HSN/SAC']).toBe('392321');
    expect(row['Item Tax']).toBe('GST18');
    expect(row['Item Tax %']).toBe(18);
    expect(row['Item Tax Type']).toBe('Group');
  });

  it('leaves tax/HSN blank when the item has no match in the stock item index', () => {
    const mapper = new InvoiceMapper(buildStockItemIndex([]));
    const [row] = mapper.toInvoiceRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Unknown Item', quantity: 1, rate: 100, amount: 100 }],
      }),
    ]);
    expect(row['HSN/SAC']).toBe('');
    expect(row['Item Tax']).toBe('');
    expect(row['Item Tax %']).toBe('');
  });

  it('derives GST Treatment from partyGstin and converts the Tally date to a real Date', () => {
    const mapper = new InvoiceMapper(buildStockItemIndex([]));
    const [withGstin] = mapper.toInvoiceRows([
      voucher({
        partyGstin: '33AAAAA1111A1Z1',
        placeOfSupply: 'Tamil Nadu',
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 }],
      }),
    ]);
    expect(withGstin['GST Treatment']).toBe('business_gst');
    expect(withGstin['GST Identification Number (GSTIN)']).toBe('33AAAAA1111A1Z1');
    expect(withGstin['Place of Supply']).toBe('Tamil Nadu');
    expect(withGstin['Invoice Date']).toEqual(new Date(Date.UTC(2025, 3, 15, 12)));

    const [withoutGstin] = mapper.toInvoiceRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 }],
      }),
    ]);
    expect(withoutGstin['GST Treatment']).toBe('consumer');
  });
});
