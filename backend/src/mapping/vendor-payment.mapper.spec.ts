import {
  TallyLedger,
  TallyLedgerEntry,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { VendorPaymentMapper } from './vendor-payment.mapper';
import { buildLedgerIndex, LedgerIndex } from './voucher-line.shared';

describe('VendorPaymentMapper', () => {
  const ledger = (overrides: Partial<TallyLedgerEntry>): TallyLedgerEntry => ({
    ledgerName: 'Some Ledger',
    amount: null,
    isDeemedPositive: null,
    isDebit: null,
    billCreditPeriodDays: null,
    billAllocations: [],
    ...overrides,
  });

  const voucher = (overrides: Partial<TallyVoucher>): TallyVoucher => ({
    date: '20260426',
    voucherType: 'Payment',
    voucherNumber: 'PAY-1',
    partyLedgerName: 'Global Supplies Pvt Ltd',
    narration: 'Payment to vendor',
    reference: 'PAY-REF-1',
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
    parent: 'Sundry Creditors',
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
  const HIERARCHY = new GroupHierarchyResolver([]);

  it('keeps a Payment voucher whose party resolves to Sundry Creditors', () => {
    const ledgerIndex = buildLedgerIndex([ledgerRecord({})]);
    const mapper = new VendorPaymentMapper(ledgerIndex, HIERARCHY);
    const rows = mapper.toVendorPaymentRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'Global Supplies Pvt Ltd', amount: -20600, isDebit: true }),
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: 20600, isDebit: false }),
        ],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Payment Number']).toBe('PAY-1');
    expect(rows[0]['Vendor Name']).toBe('Global Supplies Pvt Ltd');
    expect(rows[0].Amount).toBe(20600);
    expect(rows[0]['Paid Through']).toBe('ICICI Bank Savings A/c');
  });

  it('drops a Payment voucher whose party does NOT resolve to Sundry Creditors (that\'s expense.mapper.ts\'s row)', () => {
    const ledgerIndex = buildLedgerIndex([
      ledgerRecord({ name: 'Office Rent', parent: 'Indirect Expenses' }),
    ]);
    const mapper = new VendorPaymentMapper(ledgerIndex, HIERARCHY);
    const rows = mapper.toVendorPaymentRows([
      voucher({
        partyLedgerName: 'Office Rent',
        ledgerEntries: [
          ledger({ ledgerName: 'Office Rent', amount: -10000, isDebit: true }),
          ledger({ ledgerName: 'Cash', amount: 10000, isDebit: false }),
        ],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it('carries the vendor\'s own bank details (Account Number/Name/Code) from the ledger join', () => {
    const ledgerIndex = buildLedgerIndex([
      ledgerRecord({
        bankAccountNumber: '50100123456789',
        bankName: 'HDFC Bank',
        ifscCode: 'HDFC0000123',
        email: 'accounts@globalsupplies.in',
        alterId: 102,
      }),
    ]);
    const mapper = new VendorPaymentMapper(ledgerIndex, HIERARCHY);
    const [row] = mapper.toVendorPaymentRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'Global Supplies Pvt Ltd', amount: -20600, isDebit: true }),
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: 20600, isDebit: false }),
        ],
      }),
    ]);
    expect(row['Vendor Number']).toBe(102);
    expect(row['Vendor Bank Account Number']).toBe('50100123456789');
    expect(row['Vendor Bank Name']).toBe('HDFC Bank');
    expect(row['Vendor Bank Code']).toBe('HDFC0000123');
    expect(row.EmailID).toBe('accounts@globalsupplies.in');
  });

  it('resolves "Debit A/c no" from the PAYING ledger\'s own bank account number, not the vendor\'s', () => {
    const ledgerIndex = buildLedgerIndex([
      ledgerRecord({}),
      ledgerRecord({ name: 'ICICI Bank Savings A/c', parent: 'Bank Accounts', bankAccountNumber: '999888777' }),
    ]);
    const mapper = new VendorPaymentMapper(ledgerIndex, HIERARCHY);
    const [row] = mapper.toVendorPaymentRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'Global Supplies Pvt Ltd', amount: -20600, isDebit: true }),
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: 20600, isDebit: false }),
        ],
      }),
    ]);
    expect(row['Debit A/c no']).toBe('999888777');
  });

  it('emits one row per bill allocation, same mechanism as customer-payment.mapper.ts', () => {
    const ledgerIndex = buildLedgerIndex([ledgerRecord({})]);
    const billDatesByNumber = new Map([['PUR-2001', new Date(Date.UTC(2026, 3, 10, 12))]]);
    const mapper = new VendorPaymentMapper(ledgerIndex, HIERARCHY, billDatesByNumber);
    const rows = mapper.toVendorPaymentRows([
      voucher({
        ledgerEntries: [
          ledger({
            ledgerName: 'Global Supplies Pvt Ltd',
            amount: -20600,
            isDebit: true,
            billAllocations: [{ name: 'PUR-2001', amount: 20600 }],
          }),
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: 20600, isDebit: false }),
        ],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Bill Number']).toBe('PUR-2001');
    expect(rows[0]['Bill Amount']).toBe(20600);
    expect(rows[0]['Bill Date']).toEqual(new Date(Date.UTC(2026, 3, 10, 12)));
    expect(rows[0]['Bill Payment Applied Date']).toEqual(new Date(Date.UTC(2026, 3, 26, 12)));
  });

  it('surfaces TDS deducted from a vendor payment under TDSAmount/Withholding Tax Amount (both names, same value)', () => {
    const ledgerIndex = buildLedgerIndex([ledgerRecord({})]);
    const mapper = new VendorPaymentMapper(ledgerIndex, HIERARCHY);
    const [row] = mapper.toVendorPaymentRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'Global Supplies Pvt Ltd', amount: -18000, isDebit: true }),
          ledger({ ledgerName: 'TDS Payable', amount: 2000, isDebit: false }),
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: 20000, isDebit: false }),
        ],
      }),
    ]);
    expect(row.TDSAmount).toBe(2000);
    expect(row['Withholding Tax Amount']).toBe(2000);
    expect(row['Withholding Tax Amount (BCY)']).toBe(2000);
  });

  it('returns nothing for a voucher with no ledger entries at all', () => {
    const ledgerIndex = buildLedgerIndex([ledgerRecord({})]);
    const mapper = new VendorPaymentMapper(ledgerIndex, HIERARCHY);
    expect(mapper.toVendorPaymentRows([voucher({ ledgerEntries: [] })])).toEqual([]);
  });
});
