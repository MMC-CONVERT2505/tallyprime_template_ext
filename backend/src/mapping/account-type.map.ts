/**
 * Best-effort Tally standard group -> Zoho Books "Account Type" value.
 *
 * IMPORTANT: this is NOT extracted from the reference migration tool's real
 * logic — that lives in a compiled Java handler
 * (AccountTypeValueHandler.class) that isn't inspectable from its shipped
 * YAML config. This table is built from Tally's own documented standard
 * chart-of-accounts groups and Zoho Books' known Account Type values.
 * Verify against a real Zoho Books org before trusting this for a real
 * migration — see docs/tally-zoho-function-mapping.md.
 */
export const ACCOUNT_TYPE_BY_STANDARD_GROUP: Record<string, string> = {
  'Capital Account': 'Equity',
  'Reserves & Surplus': 'Equity',
  'Current Liabilities': 'Other Current Liability',
  'Duties & Taxes': 'Other Current Liability',
  Provisions: 'Other Current Liability',
  'Loans (Liability)': 'Long Term Liability',
  'Bank OD A/c': 'Bank',
  'Secured Loans': 'Long Term Liability',
  'Unsecured Loans': 'Long Term Liability',
  'Current Assets': 'Other Current Asset',
  'Bank Accounts': 'Bank',
  'Cash-in-Hand': 'Cash',
  'Deposits (Asset)': 'Other Current Asset',
  'Loans & Advances (Asset)': 'Other Current Asset',
  'Stock-in-Hand': 'Stock',
  'Fixed Assets': 'Fixed Asset',
  Investments: 'Other Asset',
  'Branch / Divisions': 'Other Asset',
  'Misc. Expenses (ASSET)': 'Other Asset',
  'Suspense A/c': 'Other Current Asset',
  'Sales Accounts': 'Income',
  'Purchase Accounts': 'Cost of Goods Sold',
  'Direct Incomes': 'Income',
  'Indirect Incomes': 'Other Income',
  'Direct Expenses': 'Cost of Goods Sold',
  'Indirect Expenses': 'Other Expense',
};

/** Matches the real Account Type value seen in the reference tool's own
 *  sample output (Accounts.csv) for an unclassified row — a reasonable,
 *  precedented fallback rather than an invented one. */
export const DEFAULT_ACCOUNT_TYPE = 'Other Current Liability';
