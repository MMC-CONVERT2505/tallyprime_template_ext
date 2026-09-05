import {
  TallyLedgerEntry,
  TallyStockItem,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';
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
    gstTaxability: null,
    itcIneligible: null,
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
    currencyCode: null, exchangeRate: null, ...overrides,
  });

  it('emits one row per inventory line, repeating the header fields', () => {
    const mapper = new InvoiceMapper(buildStockItemIndex([]));
    const rows = mapper.toInvoiceRows([
      voucher({
        inventoryEntries: [
          { stockItemName: 'Widget A', quantity: 2, rate: 1000, amount: 2000 , discountPercent: null, accountLedgerName: null },
          { stockItemName: 'Widget B', quantity: 1, rate: 500, amount: 500 , discountPercent: null, accountLedgerName: null },
        ],
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]['Invoice Number']).toBe('INV-1042');
    expect(rows[1]['Invoice Number']).toBe('INV-1042');
    expect(rows[0]['Item Name']).toBe('Widget A');
    expect(rows[1]['Item Name']).toBe('Widget B');
  });

  it('returns nothing for a voucher with neither inventory lines nor ledger entries (genuinely empty)', () => {
    const mapper = new InvoiceMapper(buildStockItemIndex([]));
    expect(mapper.toInvoiceRows([voucher({ inventoryEntries: [], ledgerEntries: [] })])).toEqual(
      [],
    );
  });

  it('cross-references HSN/GST rate from the stock item index, not the voucher line', () => {
    const itemIndex = buildStockItemIndex([
      item({ name: 'Widget A', hsnCode: '392321', gstRate: 18 }),
    ]);
    const mapper = new InvoiceMapper(itemIndex);
    const [row] = mapper.toInvoiceRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 , discountPercent: null, accountLedgerName: null }],
      }),
    ]);

    expect(row['HSN/SAC']).toBe('392321');
    expect(row['Item Tax']).toBe('GST18');
    expect(row['Item Tax %']).toBe(18);
    // "ItemAmount", not gst-rate.shared's "Group" — matches Bill.xlsx's
    // confirmed-correct reference value for this Zoho line-item-tax enum.
    expect(row['Item Tax Type']).toBe('ItemAmount');
  });

  it('leaves tax/HSN blank when the item has no match in the stock item index', () => {
    const mapper = new InvoiceMapper(buildStockItemIndex([]));
    const [row] = mapper.toInvoiceRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Unknown Item', quantity: 1, rate: 100, amount: 100 , discountPercent: null, accountLedgerName: null }],
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
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 , discountPercent: null, accountLedgerName: null }],
       currencyCode: null, exchangeRate: null }),
    ]);
    expect(withGstin['GST Treatment']).toBe('business_gst');
    expect(withGstin['GST Identification Number (GSTIN)']).toBe('33AAAAA1111A1Z1');
    expect(withGstin['Place of Supply']).toBe('Tamil Nadu');
    expect(withGstin['Invoice Date']).toEqual(new Date(Date.UTC(2025, 3, 15, 12)));

    const [withoutGstin] = mapper.toInvoiceRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 , discountPercent: null, accountLedgerName: null }],
      }),
    ]);
    expect(withoutGstin['GST Treatment']).toBe('consumer');
  });

  describe('service/ledger-only invoices (no inventory lines) — regression coverage', () => {
    // Mirrors bill.mapper.ts's fix for the identical bug: a Sales voucher
    // recorded in Tally's accounting-only mode (no stock items — e.g. a
    // service fee) has an empty inventoryEntries array and used to be
    // silently dropped entirely.
    const ledger = (overrides: Partial<TallyLedgerEntry>): TallyLedgerEntry => ({
      ledgerName: 'Some Ledger',
      amount: null,
      isDeemedPositive: null,
      isDebit: null,
      billCreditPeriodDays: null, ...overrides,
    });

    it('does NOT drop a real Sales voucher just because it has no stock items', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]));
      const rows = mapper.toInvoiceRows([
        voucher({
          voucherNumber: 'INV-SVC-1',
          partyLedgerName: 'Acme Consulting',
          ledgerEntries: [
            ledger({ ledgerName: 'Consulting Income', amount: 50000, isDebit: false , billCreditPeriodDays: null }),
            ledger({ ledgerName: 'Acme Consulting', amount: -50000, isDebit: true , billCreditPeriodDays: null }),
          ],
        }),
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0]['Invoice Number']).toBe('INV-SVC-1');
      expect(rows[0]['Customer Name']).toBe('Acme Consulting');
      expect(rows[0]['Item Type']).toBe('service');
      expect(rows[0]['Item Name']).toBe('');
    });

    it('derives Item Tax/TCS/TDS from posted ledger entries on a service row', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]));
      const [row] = mapper.toInvoiceRows([
        voucher({
          partyLedgerName: 'Client Co',
          ledgerEntries: [
            ledger({ ledgerName: 'Consulting Income', amount: 100000, isDebit: false , billCreditPeriodDays: null }),
            ledger({ ledgerName: 'Output IGST', amount: 18000, isDebit: false , billCreditPeriodDays: null }),
            ledger({ ledgerName: 'TDS Receivable', amount: -10000, isDebit: true , billCreditPeriodDays: null }),
            ledger({ ledgerName: 'Client Co', amount: -108000, isDebit: true , billCreditPeriodDays: null }),
          ],
        }),
      ]);

      expect(row['Item Tax']).toBe('IGST18');
      expect(row['Item Tax %']).toBe(18);
      expect(row['Item Tax Type']).toBe('ItemAmount');
      expect(row['TDS Name']).toBe('TDS Receivable');
      expect(row['TDS Amount']).toBe(10000);
      expect(row['TDS Percentage']).toBe(10);
    });

    it('captures TCS on a service row', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]));
      const [row] = mapper.toInvoiceRows([
        voucher({
          partyLedgerName: 'Vendor',
          ledgerEntries: [
            ledger({ ledgerName: 'Scrap Sale', amount: 100000, isDebit: false , billCreditPeriodDays: null }),
            ledger({ ledgerName: 'TCS Payable', amount: 5000, isDebit: false , billCreditPeriodDays: null }),
            ledger({ ledgerName: 'Vendor', amount: -105000, isDebit: true , billCreditPeriodDays: null }),
          ],
        }),
      ]);

      expect(row['TCS Tax Name']).toBe('TCS Payable');
      expect(row['TCS Amount']).toBe(5000);
      expect(row['TCS Percentage']).toBe(5);
    });
  });

  describe('TCS/TDS on an item-based invoice', () => {
    const ledger = (overrides: Partial<TallyLedgerEntry>): TallyLedgerEntry => ({
      ledgerName: 'Some Ledger',
      amount: null,
      isDeemedPositive: null,
      isDebit: null,
      billCreditPeriodDays: null, ...overrides,
    });

    it('repeats the same voucher-level TDS/TCS values on every inventory line', () => {
      const itemIndex = buildStockItemIndex([item({ name: 'Widget A', gstRate: 18 })]);
      const mapper = new InvoiceMapper(itemIndex);
      const rows = mapper.toInvoiceRows([
        voucher({
          partyLedgerName: 'Client Co',
          ledgerEntries: [
            ledger({ ledgerName: 'TDS Receivable', amount: -1000, isDebit: true , billCreditPeriodDays: null }),
            ledger({ ledgerName: 'Client Co', amount: -9000, isDebit: true , billCreditPeriodDays: null }),
          ],
          inventoryEntries: [
            { stockItemName: 'Widget A', quantity: 1, rate: 5000, amount: 5000 , discountPercent: null, accountLedgerName: null },
            { stockItemName: 'Widget A', quantity: 1, rate: 5000, amount: 5000 , discountPercent: null, accountLedgerName: null },
          ],
        }),
      ]);

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row['TDS Name']).toBe('TDS Receivable');
        expect(row['TDS Amount']).toBe(1000);
        expect(row['TDS Percentage']).toBe(10); // 1000 / 10000 (2x5000 lines) * 100
      }
    });
  });

  describe('Currency Code/Exchange Rate/Account/Discount/Due Date (2026-09-05 field-mapping pass)', () => {
    const ledger = (overrides: Partial<TallyLedgerEntry>): TallyLedgerEntry => ({
      ledgerName: 'Some Ledger',
      amount: null,
      isDeemedPositive: null,
      isDebit: null,
      billCreditPeriodDays: null,
      ...overrides,
    });

    it('defaults to INR/1 when the voucher carries no foreign-currency data', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]));
      const [row] = mapper.toInvoiceRows([
        voucher({
          inventoryEntries: [
            { stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null },
          ],
        }),
      ]);
      expect(row['Currency Code']).toBe('INR');
      expect(row['Exchange Rate']).toBe(1);
    });

    it('carries the voucher\'s real foreign currency code and exchange rate onto every line', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]));
      const [row] = mapper.toInvoiceRows([
        voucher({
          currencyCode: 'USD',
          exchangeRate: 95.021,
          inventoryEntries: [
            { stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 7242975.73, discountPercent: null, accountLedgerName: null },
          ],
        }),
      ]);
      expect(row['Currency Code']).toBe('USD');
      expect(row['Exchange Rate']).toBe(95.021);
    });

    it('maps an inventory line\'s own posted account and flat discount, distinct from the item master', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]));
      const [row] = mapper.toInvoiceRows([
        voucher({
          inventoryEntries: [
            {
              stockItemName: 'Widget A',
              quantity: 1,
              rate: 100,
              amount: 90,
              discountPercent: 10,
              accountLedgerName: 'Sales - Domestic',
            },
          ],
        }),
      ]);
      expect(row.Account).toBe('Sales - Domestic');
      expect(row.Discount).toBe(10);
    });

    it('leaves Account/Discount blank when the line carries none, rather than guessing', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]));
      const [row] = mapper.toInvoiceRows([
        voucher({
          inventoryEntries: [
            { stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null },
          ],
        }),
      ]);
      expect(row.Account).toBe('');
      expect(row.Discount).toBe('');
    });

    it('uses the single non-tax ledger name as Account on a service-only row', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]));
      const [row] = mapper.toInvoiceRows([
        voucher({
          partyLedgerName: 'Acme Consulting',
          ledgerEntries: [
            ledger({ ledgerName: 'Consulting Income', amount: 50000, isDebit: false }),
            ledger({ ledgerName: 'Acme Consulting', amount: -50000, isDebit: true }),
          ],
        }),
      ]);
      expect(row.Account).toBe('Consulting Income');
      expect(row.Discount).toBe('');
    });

    it('computes Due Date from the voucher date plus the party\'s bill-wise credit period', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]));
      const [row] = mapper.toInvoiceRows([
        voucher({
          date: '20250415',
          partyLedgerName: 'Client Co',
          ledgerEntries: [
            ledger({ ledgerName: 'Sales', amount: 10000, isDebit: false }),
            ledger({
              ledgerName: 'Client Co',
              amount: -10000,
              isDebit: true,
              billCreditPeriodDays: 30,
            }),
          ],
        }),
      ]);
      expect(row['Due Date']).toEqual(new Date(Date.UTC(2025, 4, 15, 12)));
    });

    it('leaves Due Date blank when no bill-wise credit period is set, rather than defaulting to the invoice date', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]));
      const [row] = mapper.toInvoiceRows([
        voucher({
          inventoryEntries: [
            { stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null },
          ],
        }),
      ]);
      expect(row['Due Date']).toBe('');
    });
  });
});
