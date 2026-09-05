import { TallyLedger } from '../tally/interfaces/tally.interfaces';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import {
  resolveGstTreatment,
  resolveOpeningBalanceMagnitude,
  splitBillingAddress,
} from './ledger-contact.shared';

/**
 * Zoho Books "Customer" import columns actually populated by this project —
 * taken from the real template (Master and Invoice or Bill/Customer.xlsx,
 * sheet "Customer"), which has 65 columns total; only the subset a Tally
 * Sundry Debtors ledger can genuinely supply is listed here. Everything else
 * (Salutation/First/Last Name split, Payment Terms, portal fields — Tally's
 * ledger master has no equivalent) is left blank at write time, not guessed.
 *
 * Website/Credit Limit/Conact Display Name (added 2026-09-05) — see
 * TallyLedger.website's doc comment: real fields, genuinely sparse for this
 * company's data (1/1409 ledgers), correct for any company that fills them
 * in. LedgerContact is a single free-text name — written to Display Name
 * only, not split into First/Last (Tally doesn't structure it that way).
 */
export interface ZohoCustomerRow {
  'Display Name': string;
  /** Added 2026-09-05 — same value as Display Name. Every ledger this
   *  project extracts as a Customer is a Sundry Debtor, which in real Tally
   *  data is overwhelmingly a registered business name (confirmed against
   *  this project's own live company data — "Rakuten Mobile Inc", "Apeiro
   *  Limited", ...), not an individual; Tally's ledger master has no
   *  separate legal-entity-name field to distinguish the two. */
  'Company Name': string;
  'Currency Code': string;
  EmailID: string;
  Phone: string;
  MobilePhone: string;
  'GST Treatment': string;
  'GST Identification Number (GSTIN)': string;
  'PAN Number': string;
  'Billing Address': string;
  /** Added 2026-09-05 — Tally's ADDRESS.LIST is multi-line; the first line
   *  goes to Billing Address, everything after it here instead of being
   *  silently dropped — see splitBillingAddress's doc comment. */
  'Billing Street2': string;
  'Billing State': string;
  'Billing Country': string;
  'Billing Code': string;
  'Opening Balance': number | '';
  Status: string;
  /** Added 2026-09-05 — ledger.description was already fetched (it powers
   *  COA.xlsx) but never written here; Customer.xlsx has no "Description"
   *  column of its own, and Notes is the closest real Zoho equivalent. */
  Notes: string;
  Website: string;
  'Credit Limit': number | '';
  'Conact Display Name': string;
}

const DEFAULT_CURRENCY_CODE = 'INR';

export class CustomerMapper {
  constructor(private readonly hierarchy: GroupHierarchyResolver) {}

  /** Only ledgers resolving to Sundry Debtors — the exact inverse of
   *  LedgerMapper's EXCLUDED_DIRECT_PARENTS carve-out for this group. */
  toCustomerRows(ledgers: TallyLedger[]): ZohoCustomerRow[] {
    return ledgers
      .filter((l) => this.hierarchy.resolveToStandardGroup(l.parent) === 'Sundry Debtors')
      .map((l) => this.toCustomerRow(l));
  }

  private toCustomerRow(ledger: TallyLedger): ZohoCustomerRow {
    const address = splitBillingAddress(ledger.billingAddress);
    return {
      'Display Name': ledger.name,
      'Company Name': ledger.name,
      'Currency Code': DEFAULT_CURRENCY_CODE,
      EmailID: ledger.email ?? '',
      Phone: ledger.phone ?? '',
      MobilePhone: ledger.mobile ?? '',
      'GST Treatment': resolveGstTreatment(ledger.gstin),
      'GST Identification Number (GSTIN)': ledger.gstin ?? '',
      'PAN Number': ledger.panNumber ?? '',
      'Billing Address': address.line1,
      'Billing Street2': address.line2,
      'Billing State': ledger.billingState ?? '',
      'Billing Country': ledger.billingCountry ?? '',
      'Billing Code': ledger.billingPincode ?? '',
      'Opening Balance': resolveOpeningBalanceMagnitude(ledger.openingBalance),
      // No per-ledger active/inactive flag exists in TallyLedger yet — see
      // stock-item.mapper.ts's identical reasoning for defaulting to Active.
      Status: 'Active',
      Notes: ledger.description ?? '',
      Website: ledger.website ?? '',
      'Credit Limit': ledger.creditLimit ?? '',
      'Conact Display Name': ledger.contactPersonName ?? '',
    };
  }
}
