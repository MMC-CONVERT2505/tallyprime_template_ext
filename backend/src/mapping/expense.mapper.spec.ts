import {
  TallyLedger,
  TallyLedgerEntry,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';
import { ExpenseMapper } from './expense.mapper';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { buildLedgerIndex, LedgerIndex } from './voucher-line.shared';

describe('ExpenseMapper', () => {
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
    date: '20260427',
    voucherType: 'Payment',
    voucherNumber: 'PAY-1',
    partyLedgerName: 'Office Rent',
    narration: 'Monthly office rent payment',
    reference: null,
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
    name: 'Office Rent',
    parent: 'Indirect Expenses',
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

  it('keeps a Payment voucher whose party does NOT resolve to Sundry Creditors', () => {
    const ledgerIndex = buildLedgerIndex([ledgerRecord({})]);
    const mapper = new ExpenseMapper(ledgerIndex, HIERARCHY);
    const rows = mapper.toExpenseRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'Office Rent', amount: -10000, isDebit: true }),
          ledger({ ledgerName: 'Cash', amount: 10000, isDebit: false }),
        ],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Expense Account']).toBe('Office Rent');
    expect(rows[0].Vendor).toBe('Office Rent'); // same real ledger, two column names
    expect(rows[0]['Paid Through']).toBe('Cash');
    expect(rows[0]['Expense Amount']).toBe(10000);
    expect(rows[0].Total).toBe(10000);
  });

  it('drops a Payment voucher whose party DOES resolve to Sundry Creditors (that\'s vendor-payment.mapper.ts\'s row)', () => {
    const ledgerIndex = buildLedgerIndex([
      ledgerRecord({ name: 'Global Supplies Pvt Ltd', parent: 'Sundry Creditors' }),
    ]);
    const mapper = new ExpenseMapper(ledgerIndex, HIERARCHY);
    const rows = mapper.toExpenseRows([
      voucher({
        partyLedgerName: 'Global Supplies Pvt Ltd',
        ledgerEntries: [
          ledger({ ledgerName: 'Global Supplies Pvt Ltd', amount: -20600, isDebit: true }),
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: 20600, isDebit: false }),
        ],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it('joins Vendor Number via the ledger join', () => {
    const ledgerIndex = buildLedgerIndex([ledgerRecord({ alterId: 201 })]);
    const mapper = new ExpenseMapper(ledgerIndex, HIERARCHY);
    const [row] = mapper.toExpenseRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'Office Rent', amount: -10000, isDebit: true }),
          ledger({ ledgerName: 'Cash', amount: 10000, isDebit: false }),
        ],
      }),
    ]);
    expect(row['Vendor Number']).toBe(201);
  });

  it('derives the CGST/SGST/IGST split and Tax Name from a real posted GST entry — ground truth, no item line exists to guess from', () => {
    const ledgerIndex = buildLedgerIndex([ledgerRecord({})]);
    const mapper = new ExpenseMapper(ledgerIndex, HIERARCHY);
    const [row] = mapper.toExpenseRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'Office Rent', amount: -10000, isDebit: true }),
          ledger({ ledgerName: 'Input CGST', amount: -1800, isDebit: true }),
          ledger({ ledgerName: 'Cash', amount: 11800, isDebit: false }),
        ],
      }),
    ]);
    expect(row['Tax Name']).toBe('GST18');
    expect(row['Tax Percentage']).toBe(18);
    expect(row['Tax Amount']).toBe(1800);
    expect(row['CGST Rate %']).toBe(9);
    expect(row['SGST Rate %']).toBe(9);
    expect(row['IGST Rate %']).toBe('');
    expect(row.CGST).toBe(900);
    expect(row.SGST).toBe(900);
    expect(row.Total).toBe(11800);
  });

  it('leaves Tax Name/Percentage/Amount blank when no GST ledger entry is posted, rather than guessing', () => {
    const ledgerIndex = buildLedgerIndex([ledgerRecord({})]);
    const mapper = new ExpenseMapper(ledgerIndex, HIERARCHY);
    const [row] = mapper.toExpenseRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'Office Rent', amount: -10000, isDebit: true }),
          ledger({ ledgerName: 'Cash', amount: 10000, isDebit: false }),
        ],
      }),
    ]);
    expect(row['Tax Name']).toBe('');
    expect(row['Tax Amount']).toBe('');
    expect(row['CGST Rate %']).toBe('');
  });

  it('defaults Currency/Exchange Rate to INR/1', () => {
    const ledgerIndex = buildLedgerIndex([ledgerRecord({})]);
    const mapper = new ExpenseMapper(ledgerIndex, HIERARCHY);
    const [row] = mapper.toExpenseRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'Office Rent', amount: -10000, isDebit: true }),
          ledger({ ledgerName: 'Cash', amount: 10000, isDebit: false }),
        ],
      }),
    ]);
    expect(row['Currency Code']).toBe('INR');
    expect(row['Exchange Rate']).toBe(1);
  });
});
