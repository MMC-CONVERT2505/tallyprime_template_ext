import {
  TallyLedger,
  TallyLedgerEntry,
  TallyStockItem,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';
import { CreditNoteMapper } from './credit-note.mapper';
import { buildLedgerIndex, buildStockItemIndex, LedgerIndex } from './voucher-line.shared';

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

  it('emits one row per inventory line with the tax derived from the item index', () => {
    const itemIndex = buildStockItemIndex([
      item({ name: 'Widget A', hsnCode: '392321', gstRate: 18 }),
    ]);
    const mapper = new CreditNoteMapper(itemIndex, EMPTY_LEDGERS);
    const [row] = mapper.toCreditNoteRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 , discountPercent: null, accountLedgerName: null }],
      }),
    ]);

    expect(row['Credit Note Number']).toBe('CN-1');
    expect(row['HSN/SAC']).toBe('392321');
    // No homeState signal in this single-voucher batch -> defaults to
    // intra-state (see deriveGstSplit's doc comment).
    expect(row['Item Tax']).toBe('GST18');
    expect(row['Item Tax %']).toBe(18);
    // "ItemAmount", not gst-rate.shared's "Group" — same fix as Invoice/Bill.
    expect(row['Item Tax Type']).toBe('ItemAmount');
    expect(row['CGST Rate %']).toBe(9);
    expect(row['SGST Rate %']).toBe(9);
    expect(row['IGST Rate %']).toBe('');
    expect(row.Notes).toBe('Sales return');
  });

  it('maps Reference# from the voucher reference field', () => {
    const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
    const [row] = mapper.toCreditNoteRows([
      voucher({
        reference: 'RET-2026-004',
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 , discountPercent: null, accountLedgerName: null }],
      }),
    ]);
    expect(row['Reference#']).toBe('RET-2026-004');
  });

  it('also maps the same reference onto Associated Invoice Number and Applied Invoice Number — a real Credit Note against a real original invoice number, not a duplicate guess', () => {
    const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
    const [row] = mapper.toCreditNoteRows([
      voucher({
        reference: 'Coredge/25-26/27',
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 , discountPercent: null, accountLedgerName: null }],
      }),
    ]);
    expect(row['Associated Invoice Number']).toBe('Coredge/25-26/27');
    expect(row['Applied Invoice Number']).toBe('Coredge/25-26/27');
    expect(row['Reference#']).toBe('Coredge/25-26/27');
  });

  it('derives GST Treatment from the real GSTREGISTRATIONTYPE, not GSTIN presence alone', () => {
    const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
    const [row] = mapper.toCreditNoteRows([
      voucher({
        partyGstRegistrationType: 'Unregistered/Consumer',
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
      }),
    ]);
    expect(row['GST Treatment']).toBe('business_none');
  });

  it('reads Item Type from the stock item\'s real Product Type classification, not a hardcoded "goods"', () => {
    const itemIndex = buildStockItemIndex([item({ name: 'Support Plan', itemType: 'service' })]);
    const mapper = new CreditNoteMapper(itemIndex, EMPTY_LEDGERS);
    const [row] = mapper.toCreditNoteRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Support Plan', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
      }),
    ]);
    expect(row['Item Type']).toBe('service');
  });

  describe('Customer Number/Billing/Shipping (2026-10-21, from the ledger join)', () => {
    it('joins Customer Number and the Billing/Shipping block by partyLedgerName', () => {
      const ledgerIndex = buildLedgerIndex([
        ledgerRecord({
          name: 'ABC Traders',
          alterId: 55,
          billingAddress: '9 Lake Road\nSuite 4',
          billingState: 'Tamil Nadu',
          billingCountry: 'India',
          billingPincode: '600001',
        }),
      ]);
      const mapper = new CreditNoteMapper(buildStockItemIndex([]), ledgerIndex);
      const [row] = mapper.toCreditNoteRows([
        voucher({
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      expect(row['Customer Number']).toBe(55);
      expect(row['Billing Address']).toBe('9 Lake Road');
      expect(row['Billing Street 2']).toBe('Suite 4');
      expect(row['Billing State']).toBe('Tamil Nadu');
      expect(row['Shipping Address']).toBe('9 Lake Road'); // mirrors Billing
      expect(row['Shipping State']).toBe('Tamil Nadu');
    });

    it('leaves the block blank when no matching ledger record exists', () => {
      const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toCreditNoteRows([
        voucher({
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      expect(row['Customer Number']).toBe('');
      expect(row['Billing Address']).toBe('');
    });
  });

  describe('resolveHomeState / CGST+SGST vs IGST split (2026-10-21)', () => {
    it('splits as IGST when Place of Supply differs from the batch\'s resolved home state', () => {
      const itemIndex = buildStockItemIndex([item({ name: 'Widget A', gstRate: 18 })]);
      const mapper = new CreditNoteMapper(itemIndex, EMPTY_LEDGERS);
      const [row] = mapper.toCreditNoteRows([
        voucher({
          gstRegistration: 'Uttar Pradesh Registration',
          placeOfSupply: 'Maharashtra',
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 1000, amount: 1000, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      expect(row['IGST Rate %']).toBe(18);
      expect(row['CGST Rate %']).toBe('');
      expect(row['Item Tax']).toBe('IGST18');
    });
  });

  describe('Reference Invoice Type — derived from this voucher\'s own GST Treatment, mirroring Zoho\'s own official migration tool', () => {
    it('maps a registered business GST Treatment to "Registered"', () => {
      const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toCreditNoteRows([
        voucher({
          partyGstin: '33AAAAA1111A1Z1',
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      expect(row['Reference Invoice Type']).toBe('Registered');
    });

    it('falls back to "B2C Others" for an unregistered/consumer party, never guessing "B2C (Large)"', () => {
      const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toCreditNoteRows([
        voucher({
          partyGstRegistrationType: 'Unregistered/Consumer',
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      expect(row['Reference Invoice Type']).toBe('B2C Others');
    });
  });

  describe('Associated Invoice Date — a real cross-reference against a companion Invoice extraction, never guessed', () => {
    it('looks up the date by Associated Invoice Number when a lookup map is supplied', () => {
      const invoiceDatesByNumber = new Map([
        ['Coredge/25-26/27', new Date(Date.UTC(2026, 2, 1, 12))],
      ]);
      const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS, invoiceDatesByNumber);
      const [row] = mapper.toCreditNoteRows([
        voucher({
          reference: 'Coredge/25-26/27',
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      expect(row['Associated Invoice Date']).toEqual(new Date(Date.UTC(2026, 2, 1, 12)));
    });

    it('leaves it blank when no lookup map is supplied, or the number does not resolve, rather than guessing', () => {
      const withoutMap = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [rowWithoutMap] = withoutMap.toCreditNoteRows([
        voucher({
          reference: 'Coredge/25-26/27',
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      expect(rowWithoutMap['Associated Invoice Date']).toBe('');

      const withEmptyMap = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS, new Map());
      const [rowWithEmptyMap] = withEmptyMap.toCreditNoteRows([
        voucher({
          reference: 'Coredge/25-26/27',
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      expect(rowWithEmptyMap['Associated Invoice Date']).toBe('');
    });
  });

  it('returns nothing for a voucher with neither inventory lines nor ledger entries (genuinely empty)', () => {
    const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
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
      billCreditPeriodDays: null,
      billAllocations: [],
      ...overrides,
    });

    it('does NOT drop a real Credit Note just because it has no stock items', () => {
      const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const rows = mapper.toCreditNoteRows([
        voucher({
          voucherNumber: 'CN-SVC-1',
          partyLedgerName: 'ABC Traders',
          ledgerEntries: [
            ledger({ ledgerName: 'Sales Returns', amount: -5000, isDebit: true , billCreditPeriodDays: null }),
            ledger({ ledgerName: 'ABC Traders', amount: 5000, isDebit: false , billCreditPeriodDays: null }),
          ],
        }),
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0]['Credit Note Number']).toBe('CN-SVC-1');
      expect(rows[0]['Item Type']).toBe('service');
      expect(rows[0]['Item Name']).toBe('');
    });

    it('derives Item Tax/TCS AND the CGST/SGST/IGST split from the REAL posted ledger entry\'s own kind', () => {
      const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toCreditNoteRows([
        voucher({
          partyLedgerName: 'ABC Traders',
          ledgerEntries: [
            ledger({ ledgerName: 'Sales Returns', amount: -100000, isDebit: true , billCreditPeriodDays: null }),
            ledger({ ledgerName: 'Output CGST', amount: -9000, isDebit: true , billCreditPeriodDays: null }),
            ledger({ ledgerName: 'Output SGST', amount: -9000, isDebit: true , billCreditPeriodDays: null }),
            ledger({ ledgerName: 'TCS Payable', amount: -5000, isDebit: true , billCreditPeriodDays: null }),
            ledger({ ledgerName: 'ABC Traders', amount: 123000, isDebit: false , billCreditPeriodDays: null }),
          ],
        }),
      ]);

      expect(row['Item Tax']).toBe('GST18');
      expect(row['Item Tax %']).toBe(18);
      expect(row['CGST Rate %']).toBe(9);
      expect(row['SGST Rate %']).toBe(9);
      expect(row['IGST Rate %']).toBe('');
      expect(row.CGST).toBe(9000);
      expect(row.SGST).toBe(9000);
      expect(row['TCS Tax Name']).toBe('TCS Payable');
      expect(row['TCS Amount']).toBe(5000);
      expect(row['TCS Percentage']).toBe(5);
    });
  });

  describe('Round Off (2026-10-21)', () => {
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
      const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toCreditNoteRows([
        voucher({
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
        }),
      ]);
      expect(row['Round Off']).toBe(0);
    });

    it('surfaces a real Round Off ledger entry\'s own signed amount', () => {
      const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toCreditNoteRows([
        voucher({
          partyLedgerName: 'ABC Traders',
          ledgerEntries: [
            ledger({ ledgerName: 'Sales Returns', amount: -5000.4, isDebit: true }),
            ledger({ ledgerName: 'Round Off', amount: 0.4, isDebit: false }),
            ledger({ ledgerName: 'ABC Traders', amount: 5000, isDebit: false }),
          ],
        }),
      ]);
      expect(row['Round Off']).toBe(0.4);
    });
  });

  describe('Currency Code/Exchange Rate/Account/Discount (field-mapping pass)', () => {
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
      const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toCreditNoteRows([
        voucher({
          inventoryEntries: [
            { stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null },
          ],
        }),
      ]);
      expect(row['Currency Code']).toBe('INR');
      expect(row['Exchange Rate']).toBe(1);
    });

    it('carries the voucher\'s real foreign currency code and exchange rate', () => {
      const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toCreditNoteRows([
        voucher({
          currencyCode: 'USD',
          exchangeRate: 95.021,
          inventoryEntries: [
            { stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null },
          ],
        }),
      ]);
      expect(row['Currency Code']).toBe('USD');
      expect(row['Exchange Rate']).toBe(95.021);
    });

    it('maps an inventory line\'s own posted account and flat discount', () => {
      const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toCreditNoteRows([
        voucher({
          inventoryEntries: [
            {
              stockItemName: 'Widget A',
              quantity: 1,
              rate: 100,
              amount: 90,
              discountPercent: 10,
              accountLedgerName: 'Sales Returns',
            },
          ],
        }),
      ]);
      expect(row.Account).toBe('Sales Returns');
      expect(row.Discount).toBe(10);
    });

    it('uses the single non-tax ledger name as Account on a service-only row, leaving Discount blank', () => {
      const mapper = new CreditNoteMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toCreditNoteRows([
        voucher({
          partyLedgerName: 'ABC Traders',
          ledgerEntries: [
            ledger({ ledgerName: 'Sales Returns', amount: -5000, isDebit: true }),
            ledger({ ledgerName: 'ABC Traders', amount: 5000, isDebit: false }),
          ],
        }),
      ]);
      expect(row.Account).toBe('Sales Returns');
      expect(row.Discount).toBe('');
    });
  });
});
