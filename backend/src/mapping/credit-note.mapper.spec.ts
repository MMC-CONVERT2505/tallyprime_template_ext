import {
  TallyLedgerEntry,
  TallyStockItem,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';
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
    // "ItemAmount", not gst-rate.shared's "Group" — same fix as Invoice/Bill.
    expect(row['Item Tax Type']).toBe('ItemAmount');
    expect(row.Notes).toBe('Sales return');
  });

  it('maps Reference# from the voucher reference field', () => {
    const mapper = new CreditNoteMapper(buildStockItemIndex([]));
    const [row] = mapper.toCreditNoteRows([
      voucher({
        reference: 'RET-2026-004',
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 }],
      }),
    ]);
    expect(row['Reference#']).toBe('RET-2026-004');
  });

  it('returns nothing for a voucher with neither inventory lines nor ledger entries (genuinely empty)', () => {
    const mapper = new CreditNoteMapper(buildStockItemIndex([]));
    expect(mapper.toCreditNoteRows([voucher({ inventoryEntries: [], ledgerEntries: [] })])).toEqual(
      [],
    );
  });

  describe('service/ledger-only credit notes (no inventory lines) — regression coverage', () => {
    const ledger = (overrides: Partial<TallyLedgerEntry>): TallyLedgerEntry => ({
      ledgerName: 'Some Ledger',
      amount: null,
      isDeemedPositive: null,
      isDebit: null,
      ...overrides,
    });

    it('does NOT drop a real Credit Note just because it has no stock items', () => {
      const mapper = new CreditNoteMapper(buildStockItemIndex([]));
      const rows = mapper.toCreditNoteRows([
        voucher({
          voucherNumber: 'CN-SVC-1',
          partyLedgerName: 'ABC Traders',
          ledgerEntries: [
            ledger({ ledgerName: 'Sales Returns', amount: -5000, isDebit: true }),
            ledger({ ledgerName: 'ABC Traders', amount: 5000, isDebit: false }),
          ],
        }),
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0]['Credit Note Number']).toBe('CN-SVC-1');
      expect(rows[0]['Item Type']).toBe('service');
      expect(rows[0]['Item Name']).toBe('');
    });

    it('derives Item Tax and TCS from posted ledger entries on a service row', () => {
      const mapper = new CreditNoteMapper(buildStockItemIndex([]));
      const [row] = mapper.toCreditNoteRows([
        voucher({
          partyLedgerName: 'ABC Traders',
          ledgerEntries: [
            ledger({ ledgerName: 'Sales Returns', amount: -100000, isDebit: true }),
            ledger({ ledgerName: 'Output CGST', amount: -9000, isDebit: true }),
            ledger({ ledgerName: 'Output SGST', amount: -9000, isDebit: true }),
            ledger({ ledgerName: 'TCS Payable', amount: -5000, isDebit: true }),
            ledger({ ledgerName: 'ABC Traders', amount: 123000, isDebit: false }),
          ],
        }),
      ]);

      expect(row['Item Tax']).toBe('GST18');
      expect(row['Item Tax %']).toBe(18);
      expect(row['TCS Tax Name']).toBe('TCS Payable');
      expect(row['TCS Amount']).toBe(5000);
      expect(row['TCS Percentage']).toBe(5);
    });
  });
});
