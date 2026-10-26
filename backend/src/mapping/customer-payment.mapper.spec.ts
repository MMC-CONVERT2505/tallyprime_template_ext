import {
  TallyLedger,
  TallyLedgerEntry,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';
import { CustomerPaymentMapper } from './customer-payment.mapper';
import { buildLedgerIndex, LedgerIndex } from './voucher-line.shared';

describe('CustomerPaymentMapper', () => {
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
    date: '20260425',
    voucherType: 'Receipt',
    voucherNumber: 'RCPT-1',
    partyLedgerName: 'Rohan Traders',
    narration: 'Payment received',
    reference: 'REF-01',
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
    name: 'Rohan Traders',
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

  it('emits exactly one row, blank per-allocation columns, when the party entry has no bill allocations at all', () => {
    const mapper = new CustomerPaymentMapper(EMPTY_LEDGERS);
    const rows = mapper.toCustomerPaymentRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'HDFC Bank Current A/c', amount: 4500, isDebit: true }),
          ledger({ ledgerName: 'Rohan Traders', amount: -4500, isDebit: false }),
        ],
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]['Payment Number']).toBe('RCPT-1');
    expect(rows[0]['Customer Name']).toBe('Rohan Traders');
    expect(rows[0].Amount).toBe(4500);
    expect(rows[0]['Deposit To']).toBe('HDFC Bank Current A/c');
    expect(rows[0]['Invoice Number']).toBe('');
    expect(rows[0]['Amount Applied to Invoice']).toBe('');
    expect(rows[0]['Invoice Date']).toBe('');
  });

  it('emits one row per bill allocation when the party entry has real billAllocations, repeating the voucher-level fields', () => {
    const invoiceDatesByNumber = new Map([['INV-1001', new Date(Date.UTC(2026, 3, 5, 12))]]);
    const mapper = new CustomerPaymentMapper(EMPTY_LEDGERS, invoiceDatesByNumber);
    const rows = mapper.toCustomerPaymentRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'HDFC Bank Current A/c', amount: 7000, isDebit: true }),
          ledger({
            ledgerName: 'Rohan Traders',
            amount: -7000,
            isDebit: false,
            billAllocations: [
              { name: 'INV-1001', amount: 4500 },
              { name: 'INV-1002', amount: 2500 },
            ],
          }),
        ],
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]['Payment Number']).toBe('RCPT-1'); // repeats on every row
    expect(rows[0]['Invoice Number']).toBe('INV-1001');
    expect(rows[0]['Amount Applied to Invoice']).toBe(4500);
    expect(rows[0]['Invoice Date']).toEqual(new Date(Date.UTC(2026, 3, 5, 12)));
    expect(rows[0]['Invoice Payment Applied Date']).toEqual(new Date(Date.UTC(2026, 3, 25, 12))); // the Receipt's own date

    expect(rows[1]['Invoice Number']).toBe('INV-1002');
    expect(rows[1]['Amount Applied to Invoice']).toBe(2500);
    // No date supplied for INV-1002 in the lookup map — blank, not guessed.
    expect(rows[1]['Invoice Date']).toBe('');
  });

  it('skips a bill-less allocation (Tally reports no `name`) and treats zero usable allocations as "no allocations"', () => {
    const mapper = new CustomerPaymentMapper(EMPTY_LEDGERS);
    const rows = mapper.toCustomerPaymentRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'HDFC Bank Current A/c', amount: 1000, isDebit: true }),
          ledger({
            ledgerName: 'Rohan Traders',
            amount: -1000,
            isDebit: false,
            billAllocations: [{ name: null, amount: 1000 }],
          }),
        ],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Invoice Number']).toBe('');
  });

  it('joins Customer Number via the ledger join', () => {
    const ledgerIndex = buildLedgerIndex([ledgerRecord({ alterId: 101 })]);
    const mapper = new CustomerPaymentMapper(ledgerIndex);
    const [row] = mapper.toCustomerPaymentRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'HDFC Bank Current A/c', amount: 100, isDebit: true }),
          ledger({ ledgerName: 'Rohan Traders', amount: -100, isDebit: false }),
        ],
      }),
    ]);
    expect(row['Customer Number']).toBe(101);
  });

  it('matches a Bank Charges ledger entry by name, capturing its magnitude', () => {
    const mapper = new CustomerPaymentMapper(EMPTY_LEDGERS);
    const [row] = mapper.toCustomerPaymentRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'HDFC Bank Current A/c', amount: 980, isDebit: true }),
          ledger({ ledgerName: 'Bank Charges', amount: 20, isDebit: true }),
          ledger({ ledgerName: 'Rohan Traders', amount: -1000, isDebit: false }),
        ],
      }),
    ]);
    expect(row['Bank Charges']).toBe(20);
  });

  it('surfaces TDS deducted by the customer as Withholding Tax Amount', () => {
    const mapper = new CustomerPaymentMapper(EMPTY_LEDGERS);
    const [row] = mapper.toCustomerPaymentRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'HDFC Bank Current A/c', amount: 900, isDebit: true }),
          ledger({ ledgerName: 'TDS Receivable', amount: 100, isDebit: true }),
          ledger({ ledgerName: 'Rohan Traders', amount: -1000, isDebit: false }),
        ],
      }),
    ]);
    expect(row['Withholding Tax Amount']).toBe(100);
  });

  it('returns nothing for a voucher with no ledger entries at all', () => {
    const mapper = new CustomerPaymentMapper(EMPTY_LEDGERS);
    expect(mapper.toCustomerPaymentRows([voucher({ ledgerEntries: [] })])).toEqual([]);
  });
});
