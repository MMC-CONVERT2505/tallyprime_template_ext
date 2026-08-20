import { TallyLedger } from '../tally/interfaces/tally.interfaces';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { LedgerMapper } from './ledger.mapper';

describe('LedgerMapper', () => {
  const hierarchy = new GroupHierarchyResolver([
    { name: 'Employee', parent: 'Current Liabilities' },
    { name: 'Local Sales', parent: 'Sales Accounts' },
  ]);
  const mapper = new LedgerMapper(hierarchy);

  const enrichmentFieldsBlank = {
    gstin: null,
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
  };

  const ledger = (overrides: Partial<TallyLedger>): TallyLedger => ({
    name: 'Unnamed',
    parent: null,
    description: null,
    openingBalance: null,
    closingBalance: null,
    alterId: 1,
    reservedName: null,
    ...enrichmentFieldsBlank,
    ...overrides,
  });

  it('excludes ledgers whose direct parent is Sundry Debtors/Creditors/Duties & Taxes (Customer/Vendor/Tax territory)', () => {
    const rows = mapper.toAccountRows([
      ledger({
        name: 'ABC Traders',
        parent: 'Sundry Debtors',
        openingBalance: 0,
        closingBalance: 0,
        alterId: 1,
      }),
      ledger({
        name: 'XYZ Supplies',
        parent: 'Sundry Creditors',
        openingBalance: 0,
        closingBalance: 0,
        alterId: 2,
      }),
      ledger({
        name: 'CGST',
        parent: 'Duties & Taxes',
        openingBalance: 0,
        closingBalance: 0,
        alterId: 3,
      }),
      ledger({
        name: 'Cash',
        parent: 'Cash-in-Hand',
        openingBalance: 0,
        closingBalance: 0,
        alterId: 4,
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]['Account Name']).toBe('Cash');
  });

  it('resolves a custom sub-group through the hierarchy to its Account Type', () => {
    const [row] = mapper.toAccountRows([
      ledger({ name: 'Aaina Sinha', parent: 'Employee', openingBalance: 0, closingBalance: 0 }),
    ]);
    expect(row['Account Type']).toBe('Other Current Liability'); // Employee -> Current Liabilities
    expect(row['Parent Account']).toBe('Employee'); // raw Tally parent, not the resolved standard group
  });

  it('maps a Bank Accounts ledger to Account Type "Bank" with the balance in the single Opening Balance column', () => {
    const [row] = mapper.toAccountRows([
      ledger({
        name: 'HDFC Current A/c',
        parent: 'Bank Accounts',
        openingBalance: -50000,
        closingBalance: -40000,
      }),
    ]);
    expect(row['Account Type']).toBe('Bank');
    // The real COA.xlsx template has one Opening Balance column for every
    // account type — no split "Payment Account OB" column exists.
    expect(row['Opening Balance']).toBe(50000);
    expect(row['Debit or Credit']).toBe('Debit'); // negative = Debit, per the reference tool's own convention
  });

  it('maps a non-bank ledger balance to Opening Balance with the correct Debit/Credit split', () => {
    const [row] = mapper.toAccountRows([
      ledger({
        name: 'Local Sales',
        parent: 'Sales Accounts',
        openingBalance: 10000,
        closingBalance: 10000,
      }),
    ]);
    expect(row['Account Type']).toBe('Income');
    expect(row['Opening Balance']).toBe(10000);
    expect(row['Debit or Credit']).toBe('Credit');
  });

  it('falls back to the default Account Type for a group with no resolvable standard ancestor', () => {
    const [row] = mapper.toAccountRows([
      ledger({ name: 'Mystery Ledger', parent: 'Totally Unknown Group' }),
    ]);
    expect(row['Account Type']).toBe('Other Current Liability');
    expect(row['Opening Balance']).toBe('');
    expect(row['Debit or Credit']).toBe('');
  });

  it('passes through Description when present, and leaves the no-Tally-source columns blank', () => {
    const [row] = mapper.toAccountRows([
      ledger({
        name: 'Cash',
        parent: 'Cash-in-Hand',
        description: 'Petty cash float',
        openingBalance: 0,
        closingBalance: 0,
      }),
    ]);
    expect(row.Description).toBe('Petty cash float');
    expect(row['Account Code']).toBe('');
    expect(row['Account #']).toBe('');
    expect(row.Currency).toBe('INR');
  });
});
