import { TallyLedger } from '../tally/interfaces/tally.interfaces';
import { ACCOUNT_TYPE_BY_STANDARD_GROUP, DEFAULT_ACCOUNT_TYPE } from './account-type.map';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';

/**
 * Zoho Books "Chart of Accounts" import columns — taken from the real
 * template (Master and Invoice or Bill/COA.xlsx, sheet "sample_accounts"),
 * not guessed. `Account Code`/`Account #` have no Tally-side source and are
 * always left blank rather than fabricated. `Currency` defaults to 'INR' — a
 * currency code, not a financial value — since every company this project
 * targets is India/GST-context; this project doesn't extract a currency
 * master (no Zoho template exists for one either, see zoho-entity.map.ts).
 */
export interface ZohoAccountRow {
  'Account Name': string;
  'Account Code': string;
  Description: string;
  'Account Type': string;
  'Parent Account': string;
  'Account #': string;
  Currency: string;
  'Opening Balance': number | '';
  'Debit or Credit': string;
}

const DEFAULT_CURRENCY_CODE = 'INR';

/** Ledgers whose direct parent is one of these become Customer/Vendor/Tax
 *  instead — matches the reference tool's entity_cr filter exactly:
 *  `PARENT not in ('Duties & Taxes', 'Sundry Debtors', 'Sundry Creditors')`.
 *  Customer/Vendor mappers (customer.mapper.ts/vendor.mapper.ts) are the
 *  inverse of this same classification — see resolveAccountClassification. */
const EXCLUDED_DIRECT_PARENTS = new Set(['Sundry Debtors', 'Sundry Creditors', 'Duties & Taxes']);

export class LedgerMapper {
  constructor(private readonly hierarchy: GroupHierarchyResolver) {}

  /** Only the ledgers that belong in the Zoho "Account" (Chart of Accounts)
   *  import — Customer/Vendor/Tax-bound ledgers are silently excluded here,
   *  not mis-mapped, since those targets have their own mappers. */
  toAccountRows(ledgers: TallyLedger[]): ZohoAccountRow[] {
    return ledgers
      .filter((l) => !EXCLUDED_DIRECT_PARENTS.has(l.parent ?? ''))
      .map((l) => this.toAccountRow(l));
  }

  private toAccountRow(ledger: TallyLedger): ZohoAccountRow {
    const accountType = this.resolveAccountType(ledger);
    const amount = ledger.openingBalance;

    return {
      'Account Name': ledger.name,
      'Account Code': '',
      Description: ledger.description ?? '',
      'Account Type': accountType,
      'Parent Account': ledger.parent ?? '',
      'Account #': '',
      Currency: DEFAULT_CURRENCY_CODE,
      // Tally's OPENINGBALANCE sign already encodes Dr/Cr (negative = Debit,
      // per the reference DSL's own inline comment) — Zoho wants the
      // magnitude and the sign split into a separate column. The real
      // template has a single Opening Balance column for every account type
      // (bank/cash included) — no split "Payment Account OB" column exists.
      'Opening Balance': amount !== null ? Math.abs(amount) : '',
      'Debit or Credit': amount !== null ? (amount < 0 ? 'Debit' : 'Credit') : '',
    };
  }

  private resolveAccountType(ledger: TallyLedger): string {
    const standardGroup = this.hierarchy.resolveToStandardGroup(ledger.parent);
    return (standardGroup && ACCOUNT_TYPE_BY_STANDARD_GROUP[standardGroup]) ?? DEFAULT_ACCOUNT_TYPE;
  }
}
