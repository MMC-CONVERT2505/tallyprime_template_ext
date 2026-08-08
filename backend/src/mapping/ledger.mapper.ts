import { ExcelColumn } from '../excel/excel-generator.service';
import { TallyLedger } from '../tally/interfaces/tally.interfaces';
import { ACCOUNT_TYPE_BY_STANDARD_GROUP, DEFAULT_ACCOUNT_TYPE } from './account-type.map';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';

/** Zoho Books "Chart of Accounts" import columns — exact names/order taken
 *  from the reference tool's real field-mapping config (xml_to_csv_config.yml,
 *  the `Account:` section), not guessed. External Reference ID/Type are
 *  omitted: those are the reference tool's own internal cross-file bookkeeping
 *  IDs, not required by Zoho's import format. */
export interface ZohoAccountRow {
  'Account Name': string;
  Description: string;
  'Account Type': string;
  'Parent Account': string;
  'Opening Balance': number | '';
  'Payment Account OB': number | '';
  'Debit or Credit': string;
}

export const ACCOUNT_COLUMNS: ExcelColumn[] = [
  { header: 'Account Name', key: 'Account Name', width: 30 },
  { header: 'Description', key: 'Description', width: 30 },
  { header: 'Account Type', key: 'Account Type', width: 22 },
  { header: 'Parent Account', key: 'Parent Account', width: 25 },
  { header: 'Opening Balance', key: 'Opening Balance', width: 18 },
  { header: 'Payment Account OB', key: 'Payment Account OB', width: 18 },
  { header: 'Debit or Credit', key: 'Debit or Credit', width: 16 },
];

/** Ledgers whose direct parent is one of these become Customer/Vendor/Tax
 *  instead — matches the reference tool's entity_cr filter exactly:
 *  `PARENT not in ('Duties & Taxes', 'Sundry Debtors', 'Sundry Creditors')`.
 *  Those three mappers aren't built yet (need GST/PAN/address fields this
 *  project doesn't extract yet) — see docs/architecture.md Phase 5-7 notes. */
const EXCLUDED_DIRECT_PARENTS = new Set(['Sundry Debtors', 'Sundry Creditors', 'Duties & Taxes']);

const BANK_OR_CASH_TYPES = new Set(['Bank', 'Cash']);

export class LedgerMapper {
  constructor(private readonly hierarchy: GroupHierarchyResolver) {}

  /** Only the ledgers that belong in the Zoho "Account" (Chart of Accounts)
   *  import — Customer/Vendor/Tax-bound ledgers are silently excluded here,
   *  not mis-mapped, since those targets have their own (future) mappers. */
  toAccountRows(ledgers: TallyLedger[]): ZohoAccountRow[] {
    return ledgers
      .filter((l) => !EXCLUDED_DIRECT_PARENTS.has(l.parent ?? ''))
      .map((l) => this.toAccountRow(l));
  }

  private toAccountRow(ledger: TallyLedger): ZohoAccountRow {
    const standardGroup = this.hierarchy.resolveToStandardGroup(ledger.parent);
    const accountType =
      (standardGroup && ACCOUNT_TYPE_BY_STANDARD_GROUP[standardGroup]) ?? DEFAULT_ACCOUNT_TYPE;
    const isBankOrCash = BANK_OR_CASH_TYPES.has(accountType);
    const amount = ledger.openingBalance;

    return {
      'Account Name': ledger.name,
      Description: ledger.description ?? '',
      'Account Type': accountType,
      'Parent Account': ledger.parent ?? '',
      // Tally's OPENINGBALANCE sign already encodes Dr/Cr (negative = Debit,
      // per the reference DSL's own inline comment) — Zoho wants the
      // magnitude and the sign split into separate columns.
      'Opening Balance': amount !== null && !isBankOrCash ? Math.abs(amount) : '',
      'Payment Account OB': amount !== null && isBankOrCash ? Math.abs(amount) : '',
      'Debit or Credit': amount !== null ? (amount < 0 ? 'Debit' : 'Credit') : '',
    };
  }
}
