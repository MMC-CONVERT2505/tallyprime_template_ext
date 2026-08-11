import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { LedgerMapper } from './ledger.mapper';

describe('LedgerMapper', () => {
  const hierarchy = new GroupHierarchyResolver([
    { name: 'Employee', parent: 'Current Liabilities' },
    { name: 'Local Sales', parent: 'Sales Accounts' },
  ]);
  const mapper = new LedgerMapper(hierarchy);

  it('excludes ledgers whose direct parent is Sundry Debtors/Creditors/Duties & Taxes (Customer/Vendor/Tax territory)', () => {
    const rows = mapper.toAccountRows([
      {
        name: 'ABC Traders',
        parent: 'Sundry Debtors',
        description: null,
        openingBalance: 0,
        closingBalance: 0,
        alterId: 1,
      },
      {
        name: 'XYZ Supplies',
        parent: 'Sundry Creditors',
        description: null,
        openingBalance: 0,
        closingBalance: 0,
        alterId: 2,
      },
      {
        name: 'CGST',
        parent: 'Duties & Taxes',
        description: null,
        openingBalance: 0,
        closingBalance: 0,
        alterId: 3,
      },
      {
        name: 'Cash',
        parent: 'Cash-in-Hand',
        description: null,
        openingBalance: 0,
        closingBalance: 0,
        alterId: 4,
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]['Account Name']).toBe('Cash');
  });

  it('resolves a custom sub-group through the hierarchy to its Account Type', () => {
    const [row] = mapper.toAccountRows([
      {
        name: 'Aaina Sinha',
        parent: 'Employee',
        description: null,
        openingBalance: 0,
        closingBalance: 0,
        alterId: 1,
      },
    ]);
    expect(row['Account Type']).toBe('Other Current Liability'); // Employee -> Current Liabilities
    expect(row['Parent Account']).toBe('Employee'); // raw Tally parent, not the resolved standard group
  });

  it('maps a Bank Accounts ledger to Account Type "Bank" and puts the balance in Payment Account OB, not Opening Balance', () => {
    const [row] = mapper.toAccountRows([
      {
        name: 'HDFC Current A/c',
        parent: 'Bank Accounts',
        description: null,
        openingBalance: -50000,
        closingBalance: -40000,
        alterId: 1,
      },
    ]);
    expect(row['Account Type']).toBe('Bank');
    expect(row['Opening Balance']).toBe('');
    expect(row['Payment Account OB']).toBe(50000);
    expect(row['Debit or Credit']).toBe('Debit'); // negative = Debit, per the reference tool's own convention
  });

  it('maps a non-bank ledger balance to Opening Balance with the correct Debit/Credit split', () => {
    const [row] = mapper.toAccountRows([
      {
        name: 'Local Sales',
        parent: 'Sales Accounts',
        description: null,
        openingBalance: 10000,
        closingBalance: 10000,
        alterId: 1,
      },
    ]);
    expect(row['Account Type']).toBe('Income');
    expect(row['Opening Balance']).toBe(10000);
    expect(row['Payment Account OB']).toBe('');
    expect(row['Debit or Credit']).toBe('Credit');
  });

  it('falls back to the default Account Type for a group with no resolvable standard ancestor', () => {
    const [row] = mapper.toAccountRows([
      {
        name: 'Mystery Ledger',
        parent: 'Totally Unknown Group',
        description: null,
        openingBalance: null,
        closingBalance: null,
        alterId: 1,
      },
    ]);
    expect(row['Account Type']).toBe('Other Current Liability');
    expect(row['Opening Balance']).toBe('');
    expect(row['Debit or Credit']).toBe('');
  });

  it('passes through Description when present', () => {
    const [row] = mapper.toAccountRows([
      {
        name: 'Cash',
        parent: 'Cash-in-Hand',
        description: 'Petty cash float',
        openingBalance: 0,
        closingBalance: 0,
        alterId: 1,
      },
    ]);
    expect(row.Description).toBe('Petty cash float');
  });
});
