import {
  TallyLedgerEntry,
  TallyStockItem,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';
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

  const ledger = (overrides: Partial<TallyLedgerEntry>): TallyLedgerEntry => ({
    ledgerName: 'Some Ledger',
    amount: null,
    isDeemedPositive: null,
    isDebit: null,
    ...overrides,
  });

  describe('item-based bills (inventory lines present)', () => {
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
          inventoryEntries: [
            { stockItemName: 'Widget A', quantity: 1, rate: 33.33, amount: 33.33 },
          ],
        }),
      ]);
      expect(row['Tax Amount']).toBe(4.17); // 33.33 * 0.125 = 4.16625 -> 4.17
    });

    it('leaves Tax Amount blank when the item has no known GST rate', () => {
      const mapper = new BillMapper(buildStockItemIndex([]));
      const [row] = mapper.toBillRows([
        voucher({
          inventoryEntries: [
            { stockItemName: 'Unknown Item', quantity: 1, rate: 100, amount: 100 },
          ],
        }),
      ]);
      expect(row['Tax Amount']).toBe('');
    });

    it('uses "ItemAmount" as the Tax Type when a tax was computed — matches the real Bill.xlsx reference sample, not gst-rate.shared\'s "Group"', () => {
      const itemIndex = buildStockItemIndex([item({ name: 'Widget A', gstRate: 18 })]);
      const mapper = new BillMapper(itemIndex);
      const [row] = mapper.toBillRows([
        voucher({
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 }],
        }),
      ]);
      expect(row['Tax Type']).toBe('ItemAmount');
    });

    it('leaves Tax Type blank alongside a blank Tax Amount', () => {
      const mapper = new BillMapper(buildStockItemIndex([]));
      const [row] = mapper.toBillRows([
        voucher({
          inventoryEntries: [
            { stockItemName: 'Unknown Item', quantity: 1, rate: 100, amount: 100 },
          ],
        }),
      ]);
      expect(row['Tax Type']).toBe('');
    });

    it('emits one row per inventory line, all sharing the same voucher-level SubTotal/Total/Balance', () => {
      const itemIndex = buildStockItemIndex([
        item({ name: 'A', gstRate: 18 }),
        item({ name: 'B', gstRate: 18 }),
      ]);
      const mapper = new BillMapper(itemIndex);
      const rows = mapper.toBillRows([
        voucher({
          inventoryEntries: [
            { stockItemName: 'A', quantity: 1, rate: 100, amount: 100 },
            { stockItemName: 'B', quantity: 1, rate: 200, amount: 200 },
          ],
        }),
      ]);

      expect(rows).toHaveLength(2);
      // SubTotal = 100 + 200 = 300; tax = 18 + 36 = 54; Total = 354.
      for (const row of rows) {
        expect(row.SubTotal).toBe(300);
        expect(row.Total).toBe(354);
        expect(row.Balance).toBe(354);
      }
    });

    it('maps HSN/SAC from the item master', () => {
      const itemIndex = buildStockItemIndex([item({ name: 'Widget A', hsnCode: '998314' })]);
      const mapper = new BillMapper(itemIndex);
      const [row] = mapper.toBillRows([
        voucher({
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 }],
        }),
      ]);
      expect(row['HSN/SAC']).toBe('998314');
    });
  });

  describe('service/ledger-only bills (no inventory lines) — regression coverage for the missing-records bug', () => {
    // Regression test for the reported production bug: a real Purchase
    // voucher recorded in Tally's accounting-only mode (no stock items —
    // e.g. professional fees, rent) has an empty inventoryEntries array. The
    // previous implementation treated that identically to "nothing to
    // report" and silently dropped the whole bill — vendor, GSTIN, amount,
    // everything. It must now produce exactly one row.
    it('does NOT drop a real Purchase voucher just because it has no stock items', () => {
      const mapper = new BillMapper(buildStockItemIndex([]));
      const rows = mapper.toBillRows([
        voucher({
          voucherNumber: 'BILL-SVC-1',
          partyLedgerName: 'Acme Consulting',
          ledgerEntries: [
            ledger({ ledgerName: 'Professional Fees', amount: -50000, isDebit: true }),
            ledger({ ledgerName: 'Acme Consulting', amount: 50000, isDebit: false }),
          ],
        }),
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0]['Bill Number']).toBe('BILL-SVC-1');
      expect(rows[0]['Vendor Name']).toBe('Acme Consulting');
      expect(rows[0]['Item Type']).toBe('service');
      expect(rows[0]['Item Name']).toBe('');
    });

    it('derives SubTotal/Tax Amount/Total from the posted ledger entries — mirrors a real captured Tally voucher (Marketing Expenses + Input IGST + TDS)', () => {
      const mapper = new BillMapper(buildStockItemIndex([]));
      const [row] = mapper.toBillRows([
        voucher({
          voucherNumber: 'TI2627-158',
          partyLedgerName: 'Celebration',
          partyGstin: '27ATWPK0907H1ZE',
          ledgerEntries: [
            ledger({ ledgerName: 'Marketing Expenses', amount: -92242, isDebit: true }),
            ledger({ ledgerName: 'Input IGST', amount: -16603.56, isDebit: true }),
            ledger({ ledgerName: 'TDS on Contractor', amount: 1845, isDebit: false }),
            ledger({ ledgerName: 'Celebration', amount: 107000, isDebit: false }),
            ledger({ ledgerName: 'Round Off', amount: 0.56, isDebit: false }),
          ],
        }),
      ]);

      expect(row.SubTotal).toBe(92242);
      expect(row['Tax Amount']).toBe(16603.56);
      expect(row['Tax Name']).toBe('IGST18'); // 16603.56 / 92242 * 100 = 18(.00)
      expect(row.Total).toBe(108845.56); // 92242 + 16603.56
      expect(row.Balance).toBe(row.Total);
      expect(row['TDS Name']).toBe('TDS on Contractor');
      expect(row['TDS Amount']).toBe(1845);
      // Round Off and the vendor's own settlement entry must not be counted
      // as part of the goods/services value.
    });

    it('classifies CGST+SGST (intra-state) ledger entries as "GST", not "IGST"', () => {
      const mapper = new BillMapper(buildStockItemIndex([]));
      const [row] = mapper.toBillRows([
        voucher({
          partyLedgerName: 'Landlord',
          ledgerEntries: [
            ledger({ ledgerName: 'Office Rent', amount: -10000, isDebit: true }),
            ledger({ ledgerName: 'Input CGST', amount: -900, isDebit: true }),
            ledger({ ledgerName: 'Input SGST', amount: -900, isDebit: true }),
            ledger({ ledgerName: 'Landlord', amount: 11800, isDebit: false }),
          ],
        }),
      ]);

      expect(row.SubTotal).toBe(10000);
      expect(row['Tax Amount']).toBe(1800); // 900 + 900
      expect(row['Tax Name']).toBe('GST18');
      expect(row.Total).toBe(11800);
    });

    it('captures a TCS-collected bill (Nature of Collection scenarios) via the TCS ledger entry', () => {
      const mapper = new BillMapper(buildStockItemIndex([]));
      const [row] = mapper.toBillRows([
        voucher({
          partyLedgerName: 'Vendor',
          ledgerEntries: [
            ledger({ ledgerName: 'Scrap Purchase', amount: -100000, isDebit: true }),
            ledger({ ledgerName: 'TCS Payable', amount: 5000, isDebit: false }),
            ledger({ ledgerName: 'Vendor', amount: 105000, isDebit: false }),
          ],
        }),
      ]);

      expect(row['TCS Tax Name']).toBe('TCS Payable');
      expect(row['TCS Amount']).toBe(5000);
      expect(row['TCS Percentage']).toBe(5); // 5000 / 100000 * 100
    });

    it('leaves Tax fields entirely blank for a GST-exempt vendor with no tax ledger entries at all', () => {
      const mapper = new BillMapper(buildStockItemIndex([]));
      const [row] = mapper.toBillRows([
        voucher({
          partyGstin: null,
          partyLedgerName: 'Local Vendor',
          ledgerEntries: [
            ledger({ ledgerName: 'Office Supplies', amount: -500, isDebit: true }),
            ledger({ ledgerName: 'Local Vendor', amount: 500, isDebit: false }),
          ],
        }),
      ]);

      expect(row['GST Treatment']).toBe('consumer');
      expect(row['Tax Name']).toBe('');
      expect(row['Tax Amount']).toBe('');
      expect(row['Tax Type']).toBe('');
      expect(row.SubTotal).toBe(500);
      expect(row.Total).toBe(500);
    });

    it('returns nothing for a voucher with neither inventory lines nor ledger entries (genuinely empty)', () => {
      const mapper = new BillMapper(buildStockItemIndex([]));
      const rows = mapper.toBillRows([voucher({ ledgerEntries: [], inventoryEntries: [] })]);
      expect(rows).toHaveLength(0);
    });
  });

  describe('cross-cutting fields', () => {
    it('maps GST Treatment/GSTIN from the voucher party fields', () => {
      const mapper = new BillMapper(buildStockItemIndex([]));
      const [row] = mapper.toBillRows([
        voucher({
          partyGstin: '33AAAAA1111A1Z1',
          inventoryEntries: [{ stockItemName: 'X', quantity: 1, rate: 10, amount: 10 }],
        }),
      ]);
      expect(row['GST Treatment']).toBe('business_gst');
      expect(row['GST Identification Number (GSTIN)']).toBe('33AAAAA1111A1Z1');
    });

    it('maps Purchase Order Number from the voucher reference field', () => {
      const mapper = new BillMapper(buildStockItemIndex([]));
      const [row] = mapper.toBillRows([
        voucher({
          reference: 'PO-00031',
          inventoryEntries: [{ stockItemName: 'X', quantity: 1, rate: 10, amount: 10 }],
        }),
      ]);
      expect(row['Purchase Order Number']).toBe('PO-00031');
    });

    it('maps Bill Number, Bill Date and Vendor Name straight through', () => {
      const mapper = new BillMapper(buildStockItemIndex([]));
      const [row] = mapper.toBillRows([
        voucher({
          voucherNumber: 'BILL-42',
          date: '20260115',
          partyLedgerName: 'David',
          inventoryEntries: [{ stockItemName: 'X', quantity: 1, rate: 10, amount: 10 }],
        }),
      ]);
      expect(row['Bill Number']).toBe('BILL-42');
      expect(row['Bill Date']).toEqual(new Date(Date.UTC(2026, 0, 15, 12)));
      expect(row['Vendor Name']).toBe('David');
    });
  });

  describe('multiple bills — end-to-end record count', () => {
    it('produces one row set per voucher across a mixed batch (item-based, service-only, and multi-line)', () => {
      const itemIndex = buildStockItemIndex([
        item({ name: 'Goods', gstRate: 28, hsnCode: '992515' }),
      ]);
      const mapper = new BillMapper(itemIndex);

      const rows = mapper.toBillRows([
        voucher({
          voucherNumber: 'BILL-1',
          inventoryEntries: [{ stockItemName: 'Goods', quantity: 1, rate: 100, amount: 100 }],
        }),
        voucher({
          voucherNumber: 'BILL-2',
          ledgerEntries: [
            ledger({ ledgerName: 'Consulting Fees', amount: -200, isDebit: true }),
            ledger({ ledgerName: 'Vendor', amount: 200, isDebit: false }),
          ],
        }),
        voucher({
          voucherNumber: 'BILL-3',
          inventoryEntries: [
            { stockItemName: 'Goods', quantity: 1, rate: 100, amount: 100 },
            { stockItemName: 'Goods', quantity: 2, rate: 50, amount: 100 },
          ],
        }),
      ]);

      const billNumbers = rows.map((r) => r['Bill Number']);
      expect(billNumbers).toEqual(['BILL-1', 'BILL-2', 'BILL-3', 'BILL-3']);
      expect(rows).toHaveLength(4); // 1 + 1 + 2 lines
    });
  });
});
