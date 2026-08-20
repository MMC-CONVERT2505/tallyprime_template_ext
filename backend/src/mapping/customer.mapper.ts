import { TallyLedger } from '../tally/interfaces/tally.interfaces';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { resolveGstTreatment, resolveOpeningBalanceMagnitude } from './ledger-contact.shared';

/**
 * Zoho Books "Customer" import columns actually populated by this project —
 * taken from the real template (Master and Invoice or Bill/Customer.xlsx,
 * sheet "Customer"), which has 65 columns total; only the subset a Tally
 * Sundry Debtors ledger can genuinely supply is listed here. Everything else
 * (Salutation/First/Last Name split, Website, Credit Limit, Payment Terms,
 * portal fields, secondary contact block — Tally's ledger master has no
 * equivalent) is left blank at write time, not guessed.
 */
export interface ZohoCustomerRow {
  'Display Name': string;
  'Currency Code': string;
  EmailID: string;
  Phone: string;
  MobilePhone: string;
  'GST Treatment': string;
  'GST Identification Number (GSTIN)': string;
  'PAN Number': string;
  'Billing Address': string;
  'Billing State': string;
  'Billing Country': string;
  'Billing Code': string;
  'Opening Balance': number | '';
  Status: string;
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
    return {
      'Display Name': ledger.name,
      'Currency Code': DEFAULT_CURRENCY_CODE,
      EmailID: ledger.email ?? '',
      Phone: ledger.phone ?? '',
      MobilePhone: ledger.mobile ?? '',
      'GST Treatment': resolveGstTreatment(ledger.gstin),
      'GST Identification Number (GSTIN)': ledger.gstin ?? '',
      'PAN Number': ledger.panNumber ?? '',
      'Billing Address': ledger.billingAddress ?? '',
      'Billing State': ledger.billingState ?? '',
      'Billing Country': ledger.billingCountry ?? '',
      'Billing Code': ledger.billingPincode ?? '',
      'Opening Balance': resolveOpeningBalanceMagnitude(ledger.openingBalance),
      // No per-ledger active/inactive flag exists in TallyLedger yet — see
      // stock-item.mapper.ts's identical reasoning for defaulting to Active.
      Status: 'Active',
    };
  }
}
