import {
  TallyLedger,
  TallyLedgerEntry,
  TallyVoucher,
} from '../tally/interfaces/tally.interfaces';
import { BankTransferMapper } from './bank-transfer.mapper';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { buildLedgerIndex, LedgerIndex } from './voucher-line.shared';

describe('BankTransferMapper', () => {
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
    date: '20260501',
    voucherType: 'Contra',
    voucherNumber: 'CONT-2',
    partyLedgerName: null,
    narration: 'Transfer between banks',
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
    name: 'ICICI Bank Savings A/c',
    parent: 'Bank Accounts',
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

  it('keeps a Contra voucher where BOTH sides resolve to Bank Accounts', () => {
    const ledgerIndex = buildLedgerIndex([
      ledgerRecord({ name: 'ICICI Bank Savings A/c', parent: 'Bank Accounts' }),
      ledgerRecord({ name: 'HDFC Bank Current A/c', parent: 'Bank Accounts' }),
    ]);
    const mapper = new BankTransferMapper(ledgerIndex, HIERARCHY);
    const rows = mapper.toBankTransferRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: 50000, isDebit: true }),
          ledger({ ledgerName: 'HDFC Bank Current A/c', amount: -50000, isDebit: false }),
        ],
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]['To Account']).toBe('ICICI Bank Savings A/c');
    expect(rows[0]['From Account']).toBe('HDFC Bank Current A/c');
    expect(rows[0].Amount).toBe(50000);
    expect(rows[0].Date).toEqual(new Date(Date.UTC(2026, 4, 1, 12)));
  });

  it('drops a Contra voucher where one side resolves to Cash-in-Hand (that\'s deposit.mapper.ts\'s row)', () => {
    const ledgerIndex = buildLedgerIndex([
      ledgerRecord({ name: 'ICICI Bank Savings A/c', parent: 'Bank Accounts' }),
      ledgerRecord({ name: 'Cash', parent: 'Cash-in-Hand' }),
    ]);
    const mapper = new BankTransferMapper(ledgerIndex, HIERARCHY);
    const rows = mapper.toBankTransferRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: 8000, isDebit: true }),
          ledger({ ledgerName: 'Cash', amount: -8000, isDebit: false }),
        ],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it('drops a voucher missing a clear Dr/Cr side (malformed data, not guessed)', () => {
    const ledgerIndex = buildLedgerIndex([ledgerRecord({})]);
    const mapper = new BankTransferMapper(ledgerIndex, HIERARCHY);
    const rows = mapper.toBankTransferRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: 50000, isDebit: null }),
          ledger({ ledgerName: 'HDFC Bank Current A/c', amount: -50000, isDebit: null }),
        ],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it('carries Reference#/Description/Currency/Exchange Rate', () => {
    const ledgerIndex = buildLedgerIndex([
      ledgerRecord({ name: 'ICICI Bank Savings A/c', parent: 'Bank Accounts' }),
      ledgerRecord({ name: 'HDFC Bank Current A/c', parent: 'Bank Accounts' }),
    ]);
    const mapper = new BankTransferMapper(ledgerIndex, HIERARCHY);
    const [row] = mapper.toBankTransferRows([
      voucher({
        reference: 'XFER-REF-1',
        narration: 'Liquidity rebalancing',
        currencyCode: 'USD',
        exchangeRate: 83.2,
        ledgerEntries: [
          ledger({ ledgerName: 'ICICI Bank Savings A/c', amount: 50000, isDebit: true }),
          ledger({ ledgerName: 'HDFC Bank Current A/c', amount: -50000, isDebit: false }),
        ],
      }),
    ]);
    expect(row['Reference#']).toBe('XFER-REF-1');
    expect(row.Description).toBe('Liquidity rebalancing');
    expect(row.Currency).toBe('USD');
    expect(row['Exchange Rate']).toBe(83.2);
  });
});
