import { TallyGroup } from '../tally/interfaces/tally.interfaces';

/**
 * Tally's built-in, non-deletable groups. Every custom group a user creates
 * (e.g. "Employee", "Reimbursement Payable") has a Parent chain that
 * eventually terminates at one of these — confirmed against real data: a live
 * extraction against a real company showed the large majority of ledgers
 * sitting under custom sub-groups, not these directly, which is exactly why
 * this resolver exists instead of a flat parent-name lookup (see
 * docs/tally-zoho-function-mapping.md row #4).
 */
export const STANDARD_TALLY_GROUPS = new Set<string>([
  'Capital Account',
  'Reserves & Surplus',
  'Current Liabilities',
  'Duties & Taxes',
  'Provisions',
  'Sundry Creditors',
  'Loans (Liability)',
  'Bank OD A/c',
  'Secured Loans',
  'Unsecured Loans',
  'Current Assets',
  'Bank Accounts',
  'Cash-in-Hand',
  'Deposits (Asset)',
  'Loans & Advances (Asset)',
  'Stock-in-Hand',
  'Sundry Debtors',
  'Fixed Assets',
  'Investments',
  'Branch / Divisions',
  'Misc. Expenses (ASSET)',
  'Suspense A/c',
  'Sales Accounts',
  'Purchase Accounts',
  'Direct Incomes',
  'Indirect Incomes',
  'Direct Expenses',
  'Indirect Expenses',
]);

/**
 * Resolves any group name (standard or a user's custom sub-group) to the
 * nearest standard Tally group by walking up the Parent chain. Built from a
 * full Group extraction for one company — construct fresh per company, never
 * shared/cached across companies.
 */
export class GroupHierarchyResolver {
  private readonly parentByName = new Map<string, string | null>();

  constructor(groups: Pick<TallyGroup, 'name' | 'parent'>[]) {
    for (const g of groups) {
      this.parentByName.set(g.name, g.parent);
    }
  }

  /**
   * Returns the nearest standard ancestor group name, or the input itself if
   * it's already standard, or null if the chain runs out without hitting one
   * (a custom root group, "Primary", or a name absent from the Group extract).
   */
  resolveToStandardGroup(groupName: string | null): string | null {
    if (!groupName) return null;
    if (STANDARD_TALLY_GROUPS.has(groupName)) return groupName;

    const visited = new Set<string>();
    let current: string | null = groupName;
    while (current && !visited.has(current)) {
      if (STANDARD_TALLY_GROUPS.has(current)) return current;
      visited.add(current);
      current = this.parentByName.get(current) ?? null;
    }
    return null;
  }
}
