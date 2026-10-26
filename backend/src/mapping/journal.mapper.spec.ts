import { TallyLedgerEntry, TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { JournalMapper } from './journal.mapper';

describe('JournalMapper', () => {
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
    date: '20260429',
    voucherType: 'Journal',
    voucherNumber: 'JRNL-1',
    partyLedgerName: null,
    narration: 'Depreciation adjustment',
    reference: 'DEP-01',
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

  it('emits one row per ledger entry, splitting Debit/Credit by isDebit', () => {
    const mapper = new JournalMapper();
    const rows = mapper.toJournalRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'Depreciation Expense', amount: -5000, isDebit: true }),
          ledger({ ledgerName: 'Accumulated Depreciation', amount: 5000, isDebit: false }),
        ],
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]['Journal Number']).toBe('JRNL-1');
    expect(rows[0]['Journal Date']).toEqual(new Date(Date.UTC(2026, 3, 29, 12)));
    expect(rows[0]['Reference Number']).toBe('DEP-01');
    expect(rows[0].Notes).toBe('Depreciation adjustment');
    expect(rows[0].Account).toBe('Depreciation Expense');
    expect(rows[0].Debit).toBe(5000);
    expect(rows[0].Credit).toBe('');
    expect(rows[0]['Item Order']).toBe(1);

    expect(rows[1].Account).toBe('Accumulated Depreciation');
    expect(rows[1].Debit).toBe('');
    expect(rows[1].Credit).toBe(5000);
    expect(rows[1]['Item Order']).toBe(2);
  });

  it('computes Total as the sum of every Debit-side entry (a balanced voucher)', () => {
    const mapper = new JournalMapper();
    const rows = mapper.toJournalRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'Rent Expense', amount: -8000, isDebit: true }),
          ledger({ ledgerName: 'GST Input', amount: -1440, isDebit: true }),
          ledger({ ledgerName: 'Rent Payable', amount: 9440, isDebit: false }),
        ],
      }),
    ]);
    for (const row of rows) {
      expect(row.Total).toBe(9440);
    }
  });

  it('leaves Debit and Credit both blank when isDebit could not be determined, rather than guessing', () => {
    const mapper = new JournalMapper();
    const [row] = mapper.toJournalRows([
      voucher({
        ledgerEntries: [ledger({ ledgerName: 'Unknown Side', amount: 100, isDebit: null })],
      }),
    ]);
    expect(row.Debit).toBe('');
    expect(row.Credit).toBe('');
  });

  it('defaults Currency/Exchange Rate to INR/1 when the voucher carries no foreign-currency data', () => {
    const mapper = new JournalMapper();
    const [row] = mapper.toJournalRows([
      voucher({ ledgerEntries: [ledger({ ledgerName: 'A', amount: 100, isDebit: true })] }),
    ]);
    expect(row.Currency).toBe('INR');
    expect(row['Exchange Rate']).toBe(1);
  });

  it('carries the voucher\'s real foreign currency code and exchange rate', () => {
    const mapper = new JournalMapper();
    const [row] = mapper.toJournalRows([
      voucher({
        currencyCode: 'USD',
        exchangeRate: 83.1,
        ledgerEntries: [ledger({ ledgerName: 'A', amount: 100, isDebit: true })],
      }),
    ]);
    expect(row.Currency).toBe('USD');
    expect(row['Exchange Rate']).toBe(83.1);
  });

  it('returns nothing for a voucher with no ledger entries at all', () => {
    const mapper = new JournalMapper();
    expect(mapper.toJournalRows([voucher({ ledgerEntries: [] })])).toEqual([]);
  });

  it('leaves Tax Name/Percentage/Amount/Type, Contact Name/Type, and Cost Centre blank — no reliable per-line source on a multi-line Journal voucher', () => {
    const mapper = new JournalMapper();
    const [row] = mapper.toJournalRows([
      voucher({
        ledgerEntries: [
          ledger({ ledgerName: 'Output IGST', amount: -1000, isDebit: true }),
          ledger({ ledgerName: 'Some Other Ledger', amount: 1000, isDebit: false }),
        ],
      }),
    ]);
    expect(row['Tax Name']).toBe('');
    expect(row['Tax Percentage']).toBe('');
    expect(row['Tax Amount']).toBe('');
    expect(row['Tax Type']).toBe('');
    expect(row['Contact Name']).toBe('');
    expect(row['Contact Type']).toBe('');
    expect(row['Cost Centre']).toBe('');
  });
});
