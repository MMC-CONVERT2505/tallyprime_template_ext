import {
  TallyLedger,
  TallyLedgerEntry,
  TallyStockItem,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';
import { InvoiceMapper } from './invoice.mapper';
import { buildLedgerIndex, buildStockItemIndex, LedgerIndex } from './voucher-line.shared';

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
    itemType: null,
    inventoryValuationMethod: null,
    salesAccount: null,
    purchaseAccount: null,
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
    partyGstRegistrationType: null,
    gstRegistration: null,
    currencyCode: null, exchangeRate: null, ...overrides,
  });

  const ledgerRecord = (overrides: Partial<TallyLedger>): TallyLedger => ({
    name: 'ABC Traders',
    parent: null,
    description: null,
    openingBalance: null,
    closingBalance: null,
    alterId: null,
    reservedName: null,
    gstin: null,
    gstRegistrationType: null,
    gstPlaceOfSupply: null,
    panNumber: null,
    email: null,
    phone: null,
    mobile: null,
    billingAddress: null,
    billingState: null,
    billingCountry: null,
    billingPincode: null,
    bankName: null,
    bankAccountNumber: null,
    ifscCode: null,
    accountHolderName: null,
    website: null,
    creditLimit: null,
    contactPersonName: null,
    mailingName: null,
    creditPeriod: null,
    ...overrides,
  });

  const EMPTY_LEDGERS: LedgerIndex = buildLedgerIndex([]);

  it('emits one row per inventory line, repeating the header fields', () => {
    const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
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
    const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
    expect(mapper.toInvoiceRows([voucher({ inventoryEntries: [], ledgerEntries: [] })])).toEqual(
      [],
    );
  });

  it('cross-references HSN/GST rate from the stock item index, not the voucher line', () => {
    const itemIndex = buildStockItemIndex([
      item({ name: 'Widget A', hsnCode: '392321', gstRate: 18 }),
    ]);
    const mapper = new InvoiceMapper(itemIndex, EMPTY_LEDGERS);
    const [row] = mapper.toInvoiceRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 , discountPercent: null, accountLedgerName: null }],
      }),
    ]);

    expect(row['HSN/SAC']).toBe('392321');
    // No homeState signal anywhere in this single-voucher batch -> defaults
    // to intra-state (see deriveGstSplit's doc comment), so the combined
    // "Item Tax" column still reads "GST18" (the intra-state naming), not
    // "IGST18".
    expect(row['Item Tax']).toBe('GST18');
    expect(row['Item Tax %']).toBe(18);
    // "ItemAmount", not gst-rate.shared's "Group" — matches Bill.xlsx's
    // confirmed-correct reference value for this Zoho line-item-tax enum.
    expect(row['Item Tax Type']).toBe('ItemAmount');
    expect(row['CGST Rate %']).toBe(9);
    expect(row['SGST Rate %']).toBe(9);
    expect(row['IGST Rate %']).toBe('');
    expect(row.CGST).toBe(9);
    expect(row.SGST).toBe(9);
    expect(row.IGST).toBe('');
  });

  it('leaves tax/HSN blank when the item has no match in the stock item index', () => {
    const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
    const [row] = mapper.toInvoiceRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Unknown Item', quantity: 1, rate: 100, amount: 100 , discountPercent: null, accountLedgerName: null }],
      }),
    ]);
    expect(row['HSN/SAC']).toBe('');
    expect(row['Item Tax']).toBe('');
    expect(row['Item Tax %']).toBe('');
    expect(row['CGST Rate %']).toBe('');
    expect(row['IGST Rate %']).toBe('');
  });

  it('derives GST Treatment from partyGstin and converts the Tally date to a real Date', () => {
    const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
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

  it('derives GST Treatment from the real GSTREGISTRATIONTYPE, not GSTIN presence alone — VERIFIED live: 113 of 602 real sampled vouchers are "Unregistered/Consumer" (a registered business, not a retail consumer), which the old GSTIN-only heuristic silently mapped to "consumer"', () => {
    const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
    const [unregisteredBusiness] = mapper.toInvoiceRows([
      voucher({
        partyGstRegistrationType: 'Unregistered/Consumer',
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
      }),
    ]);
    expect(unregisteredBusiness['GST Treatment']).toBe('business_none');

    const [unknownType] = mapper.toInvoiceRows([
      voucher({
        partyGstRegistrationType: 'Unknown',
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
      }),
    ]);
    expect(unknownType['GST Treatment']).toBe('consumer');
  });

  it('reads Item Type from the stock item\'s real Product Type classification, not a hardcoded "goods"', () => {
    const itemIndex = buildStockItemIndex([item({ name: 'Support Plan', itemType: 'service' })]);
    const mapper = new InvoiceMapper(itemIndex, EMPTY_LEDGERS);
    const [row] = mapper.toInvoiceRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Support Plan', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
      }),
    ]);
    expect(row['Item Type']).toBe('service');
  });

  describe('Customer Number/Billing/Shipping/Primary Contact (2026-10-20, from the ledger join)', () => {
    it('leaves the whole contact block blank when the party has no matching ledger record', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toInvoiceRows([
        voucher({
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      expect(row['Customer Number']).toBe('');
      expect(row['Billing Address']).toBe('');
      expect(row['Primary Contact EmailID']).toBe('');
    });

    it('joins Customer Number (alterId) and the full Billing/Shipping/Contact block by partyLedgerName', () => {
      const ledgerIndex = buildLedgerIndex([
        ledgerRecord({
          name: 'Rohan Traders',
          alterId: 101,
          mailingName: 'Rohan Traders Pvt Ltd',
          billingAddress: '12 MG Road, Andheri\nNear Metro Station',
          billingState: 'Maharashtra',
          billingCountry: 'India',
          billingPincode: '400001',
          phone: '02212345678',
          email: 'rohan@traders.in',
          mobile: '9876543210',
          creditPeriod: '30',
        }),
      ]);
      const mapper = new InvoiceMapper(buildStockItemIndex([]), ledgerIndex);
      const [row] = mapper.toInvoiceRows([
        voucher({
          partyLedgerName: 'Rohan Traders',
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
        }),
      ]);

      expect(row['Customer Number']).toBe(101);
      expect(row['Billing Attention']).toBe('Rohan Traders Pvt Ltd');
      expect(row['Billing Address']).toBe('12 MG Road, Andheri');
      expect(row['Billing Street2']).toBe('Near Metro Station');
      expect(row['Billing State']).toBe('Maharashtra');
      expect(row['Billing Country']).toBe('India');
      expect(row['Billing Code']).toBe('400001');
      expect(row['Billing Phone']).toBe('02212345678');
      expect(row['Primary Contact EmailID']).toBe('rohan@traders.in');
      expect(row['Primary Contact Mobile']).toBe('9876543210');
      expect(row['Primary Contact Phone']).toBe('02212345678');
      expect(row['Payment Terms']).toBe(30);
      expect(row['Payment Terms Label']).toBe('30 Days');

      // Shipping mirrors Billing — Tally doesn't track a separate ship-to
      // address this project extracts (see class doc comment).
      expect(row['Shipping Attention']).toBe('Rohan Traders Pvt Ltd');
      expect(row['Shipping Address']).toBe('12 MG Road, Andheri');
      expect(row['Shipping Street2']).toBe('Near Metro Station');
      expect(row['Shipping State']).toBe('Maharashtra');
      expect(row['Shipping Country']).toBe('India');
      expect(row['Shipping Code']).toBe('400001');
      expect(row['Shipping Phone Number']).toBe('02212345678');
    });
  });

  describe('resolveHomeState / CGST+SGST vs IGST split on inventory lines (2026-10-20)', () => {
    it('defaults to intra-state (CGST+SGST) when no GST Registration or Place of Supply exists anywhere in the batch', () => {
      const itemIndex = buildStockItemIndex([item({ name: 'Widget A', gstRate: 18 })]);
      const mapper = new InvoiceMapper(itemIndex, EMPTY_LEDGERS);
      const [row] = mapper.toInvoiceRows([
        voucher({
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 1000, amount: 1000, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      expect(row['CGST Rate %']).toBe(9);
      expect(row['SGST Rate %']).toBe(9);
      expect(row['IGST Rate %']).toBe('');
      expect(row.CGST).toBe(90);
      expect(row.SGST).toBe(90);
      expect(row.IGST).toBe('');
    });

    it('splits as IGST when a voucher\'s Place of Supply differs from the batch\'s resolved home state', () => {
      const itemIndex = buildStockItemIndex([item({ name: 'Widget A', gstRate: 18 })]);
      const mapper = new InvoiceMapper(itemIndex, EMPTY_LEDGERS);
      // Two Maharashtra vouchers + one West Bengal voucher -> home state
      // resolves to Maharashtra (most common Place of Supply, since no
      // voucher carries a GST Registration at all) -> the West Bengal
      // voucher alone is inter-state.
      const rows = mapper.toInvoiceRows([
        voucher({
          voucherNumber: 'INV-1',
          placeOfSupply: 'Maharashtra',
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 1000, amount: 1000, discountPercent: null, accountLedgerName: null }],
        }),
        voucher({
          voucherNumber: 'INV-2',
          placeOfSupply: 'Maharashtra',
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 1000, amount: 1000, discountPercent: null, accountLedgerName: null }],
        }),
        voucher({
          voucherNumber: 'INV-3',
          placeOfSupply: 'West Bengal',
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 1000, amount: 1000, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      const [intra1, intra2, inter] = rows;
      expect(intra1['CGST Rate %']).toBe(9);
      expect(intra1['IGST Rate %']).toBe('');
      expect(intra2['CGST Rate %']).toBe(9);
      expect(inter['IGST Rate %']).toBe(18);
      expect(inter['IGST']).toBe(180);
      expect(inter['CGST Rate %']).toBe('');
      expect(inter['Item Tax']).toBe('IGST18');
    });

    it('prefers GST Registration\'s state name over Place of Supply when resolving the home state', () => {
      const itemIndex = buildStockItemIndex([item({ name: 'Widget A', gstRate: 18 })]);
      const mapper = new InvoiceMapper(itemIndex, EMPTY_LEDGERS);
      // gstRegistration says "Uttar Pradesh Registration" -> home state is
      // Uttar Pradesh, even though every voucher's Place of Supply is
      // Maharashtra (what a naive Place-of-Supply-only heuristic would have
      // picked) -> every one of these is actually inter-state.
      const [row] = mapper.toInvoiceRows([
        voucher({
          gstRegistration: 'Uttar Pradesh Registration',
          placeOfSupply: 'Maharashtra',
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 1000, amount: 1000, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      expect(row['IGST Rate %']).toBe(18);
      expect(row['CGST Rate %']).toBe('');
    });
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
      billCreditPeriodDays: null,
      billAllocations: [],
      ...overrides,
    });

    it('does NOT drop a real Sales voucher just because it has no stock items', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
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

    it('derives Item Tax/TCS/TDS AND the CGST/SGST/IGST split from the REAL posted ledger entry\'s own kind, not the home-state heuristic', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toInvoiceRows([
        voucher({
          partyLedgerName: 'Client Co',
          // No placeOfSupply/gstRegistration at all on this voucher — the
          // home-state heuristic has nothing to go on and would default to
          // intra-state, but the REAL posted entry below says "Output
          // IGST" — ground truth that must win.
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
      expect(row['IGST Rate %']).toBe(18);
      expect(row['IGST']).toBe(18000);
      expect(row['CGST Rate %']).toBe('');
      expect(row['SGST Rate %']).toBe('');
      expect(row['TDS Name']).toBe('TDS Receivable');
      expect(row['TDS Amount']).toBe(10000);
      expect(row['TDS Percentage']).toBe(10);
    });

    it('splits a posted CGST/SGST (non-IGST) ledger entry evenly across both columns, not as a single combined rate', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toInvoiceRows([
        voucher({
          partyLedgerName: 'Client Co',
          ledgerEntries: [
            ledger({ ledgerName: 'Consulting Income', amount: 100000, isDebit: false, billCreditPeriodDays: null }),
            ledger({ ledgerName: 'Output CGST', amount: 9000, isDebit: false, billCreditPeriodDays: null }),
            ledger({ ledgerName: 'Output SGST', amount: 9000, isDebit: false, billCreditPeriodDays: null }),
            ledger({ ledgerName: 'Client Co', amount: -118000, isDebit: true, billCreditPeriodDays: null }),
          ],
        }),
      ]);

      expect(row['Item Tax %']).toBe(18);
      expect(row['IGST Rate %']).toBe('');
      expect(row['CGST Rate %']).toBe(9);
      expect(row['SGST Rate %']).toBe(9);
      expect(row.CGST).toBe(9000);
      expect(row.SGST).toBe(9000);
    });

    it('captures TCS on a service row', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
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
      billCreditPeriodDays: null,
      billAllocations: [],
      ...overrides,
    });

    it('repeats the same voucher-level TDS/TCS values on every inventory line', () => {
      const itemIndex = buildStockItemIndex([item({ name: 'Widget A', gstRate: 18 })]);
      const mapper = new InvoiceMapper(itemIndex, EMPTY_LEDGERS);
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

  describe('Round Off (2026-10-20)', () => {
    const ledger = (overrides: Partial<TallyLedgerEntry>): TallyLedgerEntry => ({
      ledgerName: 'Some Ledger',
      amount: null,
      isDeemedPositive: null,
      isDebit: null,
      billCreditPeriodDays: null,
      billAllocations: [],
      ...overrides,
    });

    it('defaults to 0 when no Round Off ledger entry is posted', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toInvoiceRows([
        voucher({
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      expect(row['Round Off']).toBe(0);
    });

    it('surfaces a real Round Off ledger entry\'s own signed amount', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toInvoiceRows([
        voucher({
          partyLedgerName: 'Client Co',
          ledgerEntries: [
            ledger({ ledgerName: 'Sales', amount: 10000.4, isDebit: false }),
            ledger({ ledgerName: 'Round Off', amount: -0.4, isDebit: true }),
            ledger({ ledgerName: 'Client Co', amount: -10000, isDebit: true }),
          ],
        }),
      ]);
      expect(row['Round Off']).toBe(-0.4);
    });
  });

  describe('Currency Code/Exchange Rate/Account/Discount/Due Date/PurchaseOrder (field-mapping pass)', () => {
    const ledger = (overrides: Partial<TallyLedgerEntry>): TallyLedgerEntry => ({
      ledgerName: 'Some Ledger',
      amount: null,
      isDeemedPositive: null,
      isDebit: null,
      billCreditPeriodDays: null,
      billAllocations: [],
      ...overrides,
    });

    it('defaults to INR/1 when the voucher carries no foreign-currency data', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
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
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
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
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
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
      expect(row['Item Total']).toBe(90);
    });

    it('leaves Account/Discount blank when the line carries none, rather than guessing', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
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
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
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
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
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
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toInvoiceRows([
        voucher({
          inventoryEntries: [
            { stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null },
          ],
        }),
      ]);
      expect(row['Due Date']).toBe('');
    });

    it('carries voucher.reference onto both PurchaseOrder and "Buyer\'s Order No." — the same real fact under two column names', () => {
      const mapper = new InvoiceMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toInvoiceRows([
        voucher({
          reference: 'PO-9981',
          inventoryEntries: [
            { stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null },
          ],
        }),
      ]);
      expect(row.PurchaseOrder).toBe('PO-9981');
      expect(row["Buyer's Order No."]).toBe('PO-9981');
    });
  });
});
