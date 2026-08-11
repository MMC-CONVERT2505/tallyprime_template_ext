import { GroupHierarchyResolver } from './group-hierarchy.resolver';

describe('GroupHierarchyResolver', () => {
  it('returns a standard group unchanged', () => {
    const resolver = new GroupHierarchyResolver([]);
    expect(resolver.resolveToStandardGroup('Bank Accounts')).toBe('Bank Accounts');
  });

  it('walks up a single level of custom sub-group to the standard ancestor', () => {
    // Real shape observed against a live Tally company: "Employee" is a
    // custom sub-group directly under the standard "Current Liabilities".
    const resolver = new GroupHierarchyResolver([
      { name: 'Employee', parent: 'Current Liabilities' },
    ]);
    expect(resolver.resolveToStandardGroup('Employee')).toBe('Current Liabilities');
  });

  it('walks up multiple levels of nested custom sub-groups', () => {
    const resolver = new GroupHierarchyResolver([
      { name: 'Statutory Bonus', parent: 'Payroll Related Expenses' },
      { name: 'Payroll Related Expenses', parent: 'Indirect Expenses' },
    ]);
    expect(resolver.resolveToStandardGroup('Statutory Bonus')).toBe('Indirect Expenses');
  });

  it('returns null for an unknown/custom root group with no resolvable ancestor', () => {
    const resolver = new GroupHierarchyResolver([
      { name: 'Mystery Group', parent: 'Also Unknown' },
    ]);
    expect(resolver.resolveToStandardGroup('Mystery Group')).toBeNull();
  });

  it('returns null for a null input', () => {
    const resolver = new GroupHierarchyResolver([]);
    expect(resolver.resolveToStandardGroup(null)).toBeNull();
  });

  it('does not infinite-loop on a cyclic parent chain (defensive — should never happen in real Tally data)', () => {
    const resolver = new GroupHierarchyResolver([
      { name: 'A', parent: 'B' },
      { name: 'B', parent: 'A' },
    ]);
    expect(resolver.resolveToStandardGroup('A')).toBeNull();
  });
});
