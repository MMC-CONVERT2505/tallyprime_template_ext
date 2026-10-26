import {
  TallyLedger,
  TallyLedgerEntry,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';
import { DepositMapper } from './deposit.mapper';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { buildLedgerIndex, LedgerIndex } from './voucher-line.shared';

describe('DepositMapper', () => {
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
    date: '20260430',
    voucherType: 'Contra',
    voucherNumber: 'CONT-1',
    partyLedgerName: null,
    narration: 'Cash deposited into bank',
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
    name: 'Cash',
    parent: 'Cash-in-Hand',
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

  const HIERARCHY = new GroupHierarchyResolver([]);

  it('keeps a Contra voucher where one side resolves to Cash-in-Hand', () => {
    const ledgerIndex = buildLedgerIndex([
      ledgerRecord({ name: 'Cash', parent: 'Cash-in-Hand' }),
      ledgerRecord({ name: 'ICICI Bank Savings A/c', parent: 'Bank Accounts' }),
    ]);
    const mapper = new DepositMapper(ledgerIndex, HIERARCHY);
    const rows = mapper.toDepositRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: 8000, isDebit: true }),
          ledger({ ledgerName: 'Cash', amount: -8000, isDebit: false }),
        ],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]['To Account']).toBe('ICICI Bank Savings A/c'); // the debited (increasing) side
    expect(rows[0]['From Account']).toBe('Cash'); // the credited (decreasing) side
    expect(rows[0]['Amount (AED)']).toBe(8000);
    expect(rows[0]['Deposit Date']).toEqual(new Date(Date.UTC(2026, 3, 30, 12)));
  });

  it('drops a Contra voucher between two Bank Accounts ledgers (that\'s bank-transfer.mapper.ts\'s row)', () => {
    const ledgerIndex = buildLedgerIndex([
      ledgerRecord({ name: 'ICICI Bank Savings A/c', parent: 'Bank Accounts' }),
      ledgerRecord({ name: 'HDFC Bank Current A/c', parent: 'Bank Accounts' }),
    ]);
    const mapper = new DepositMapper(ledgerIndex, HIERARCHY);
    const rows = mapper.toDepositRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: 50000, isDebit: true }),
          ledger({ ledgerName: 'HDFC Bank Current A/c', amount: -50000, isDebit: false }),
        ],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it('drops a voucher missing a clear Dr/Cr side (malformed data, not guessed)', () => {
    const ledgerIndex = buildLedgerIndex([ledgerRecord({})]);
    const mapper = new DepositMapper(ledgerIndex, HIERARCHY);
    const rows = mapper.toDepositRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'Cash', amount: 8000, isDebit: null }),
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: -8000, isDebit: null }),
        ],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it('carries Reference#/Description/Currency/Exchange Rate', () => {
    const ledgerIndex = buildLedgerIndex([
      ledgerRecord({ name: 'Cash', parent: 'Cash-in-Hand' }),
      ledgerRecord({ name: 'ICICI Bank Savings A/c', parent: 'Bank Accounts' }),
    ]);
    const mapper = new DepositMapper(ledgerIndex, HIERARCHY);
    const [row] = mapper.toDepositRows([
      voucher({
        reference: 'DEP-REF-1',
        narration: 'Weekly cash deposit',
        currencyCode: 'USD',
        exchangeRate: 83.2,
        ledgerEntries: [
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: 8000, isDebit: true }),
          ledger({ ledgerName: 'Cash', amount: -8000, isDebit: false }),
        ],
      }),
    ]);
    expect(row['Reference#']).toBe('DEP-REF-1');
    expect(row.Description).toBe('Weekly cash deposit');
    expect(row.Currency).toBe('USD');
    expect(row['Exchange Rate']).toBe(83.2);
  });
});
