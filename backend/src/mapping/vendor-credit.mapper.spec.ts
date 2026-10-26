import {
  TallyLedger,
  TallyLedgerEntry,
  TallyStockItem,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';
import { VendorCreditMapper } from './vendor-credit.mapper';
import { buildLedgerIndex, buildStockItemIndex, LedgerIndex } from './voucher-line.shared';

describe('VendorCreditMapper', () => {
  const item = (overrides: Partial<TallyStockItem>): TallyStockItem => ({
    name: 'Raw Material X',
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
    date: '20260428',
    voucherType: 'Debit Note',
    voucherNumber: 'DN-1',
    partyLedgerName: 'Global Supplies Pvt Ltd',
    narration: 'Purchase return',
    reference: 'PUR-2001',
    alterId: 1,
    ledgerEntries: [],
    inventoryEntries: [],
    partyGstin: null,
    placeOfSupply: null,
    partyGstRegistrationType: null,
    gstRegistration: null,
    currencyCode: null,
    exchangeRate: null,
    ...overrides,
  });

  const ledgerRecord = (overrides: Partial<TallyLedger>): TallyLedger => ({
    name: 'Global Supplies Pvt Ltd',
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

  it('emits one row per inventory line, always intra-state (CGST+SGST, never IGST) — no home-state heuristic on the purchase side', () => {
    const itemIndex = buildStockItemIndex([item({ gstRate: 18 })]);
    const mapper = new VendorCreditMapper(itemIndex, EMPTY_LEDGERS);
    const [row] = mapper.toVendorCreditRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Raw Material X', quantity: 5, rate: 100, amount: 500, discountPercent: null, accountLedgerName: null }],
      }),
    ]);

    expect(row['Vendor Credit Number']).toBe('DN-1');
    expect(row['Vendor Name']).toBe('Global Supplies Pvt Ltd');
    expect(row['Associated Bill Number']).toBe('PUR-2001');
    expect(row['Item Tax']).toBe('GST18');
    expect(row['Item Tax %']).toBe(18);
    expect(row['Item Tax Type']).toBe('ItemAmount');
    expect(row['CGST Amount']).toBe(45); // 9% of 500
    expect(row['SGST Amount']).toBe(45);
    expect(row['IGST Amount']).toBe('');
  });

  it('joins Vendor Number via the ledger join', () => {
    const ledgerIndex = buildLedgerIndex([ledgerRecord({ alterId: 102 })]);
    const mapper = new VendorCreditMapper(buildStockItemIndex([]), ledgerIndex);
    const [row] = mapper.toVendorCreditRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Raw Material X', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
      }),
    ]);
    expect(row['Vendor Number']).toBe(102);
  });

  it('leaves Vendor Number blank when no matching ledger record exists', () => {
    const mapper = new VendorCreditMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
    const [row] = mapper.toVendorCreditRows([
      voucher({
        inventoryEntries: [{ stockItemName: 'Raw Material X', quantity: 1, rate: 100, amount: 100, discountPercent: null, accountLedgerName: null }],
      }),
    ]);
    expect(row['Vendor Number']).toBe('');
  });

  it('returns nothing for a voucher with neither inventory lines nor ledger entries (genuinely empty)', () => {
    const mapper = new VendorCreditMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
    expect(mapper.toVendorCreditRows([voucher({ inventoryEntries: [], ledgerEntries: [] })])).toEqual(
      [],
    );
  });

  describe('ledger-only Debit Notes (no inventory lines) — regression coverage', () => {
    const ledger = (overrides: Partial<TallyLedgerEntry>): TallyLedgerEntry => ({
      ledgerName: 'Some Ledger',
      amount: null,
      isDeemedPositive: null,
      isDebit: null,
      billCreditPeriodDays: null,
      billAllocations: [],
      ...overrides,
    });

    it('does NOT drop a real Debit Note just because it has no stock items', () => {
      const mapper = new VendorCreditMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const rows = mapper.toVendorCreditRows([
        voucher({
          voucherNumber: 'DN-SVC-1',
          ledgerEntries: [
            ledger({ ledgerName: 'Purchase Returns', amount: 5000, isDebit: true }),
            ledger({ ledgerName: 'Global Supplies Pvt Ltd', amount: -5000, isDebit: false }),
          ],
        }),
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]['Item Type']).toBe('service');
      expect(rows[0]['Item Name']).toBe('');
    });

    it('derives Item Tax AND the CGST/SGST/IGST split from the REAL posted ledger entry\'s own kind (ground truth, not the heuristic)', () => {
      const mapper = new VendorCreditMapper(buildStockItemIndex([]), EMPTY_LEDGERS);
      const [row] = mapper.toVendorCreditRows([
        voucher({
          ledgerEntries: [
            ledger({ ledgerName: 'Purchase Returns', amount: 100000, isDebit: true }),
            ledger({ ledgerName: 'Input IGST', amount: 18000, isDebit: true }),
            ledger({ ledgerName: 'Global Supplies Pvt Ltd', amount: -118000, isDebit: false }),
          ],
        }),
      ]);
      expect(row['Item Tax']).toBe('IGST18');
      expect(row['IGST Amount']).toBe(18000);
      expect(row['CGST Amount']).toBe('');
      expect(row['SGST Amount']).toBe('');
    });
  });
});
