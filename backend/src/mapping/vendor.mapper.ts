import { TallyLedger } from '../tally/interfaces/tally.interfaces';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { resolveGstTreatment, resolveOpeningBalanceMagnitude } from './ledger-contact.shared';

/**
 * Zoho Books "Vendor" import columns actually populated by this project —
 * taken from the real template (Master and Invoice or Bill/Vendor.xlsx,
 * sheet "Vendor"). See customer.mapper.ts's doc comment for the same
 * "populate what Tally can genuinely supply, leave the rest blank" rule;
 * Vendor additionally gets Bank Name/Bank Account Number, which Customer.xlsx
 * has no columns for at all.
 */
export interface ZohoVendorRow {
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
  'Bank Name': string;
  'Bank Account Number': string;
}

const DEFAULT_CURRENCY_CODE = 'INR';

export class VendorMapper {
  constructor(private readonly hierarchy: GroupHierarchyResolver) {}

  /** Only ledgers resolving to Sundry Creditors — the exact inverse of
   *  LedgerMapper's EXCLUDED_DIRECT_PARENTS carve-out for this group. */
  toVendorRows(ledgers: TallyLedger[]): ZohoVendorRow[] {
    return ledgers
      .filter((l) => this.hierarchy.resolveToStandardGroup(l.parent) === 'Sundry Creditors')
      .map((l) => this.toVendorRow(l));
  }

  private toVendorRow(ledger: TallyLedger): ZohoVendorRow {
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
      Status: 'Active',
      'Bank Name': ledger.bankName ?? '',
      'Bank Account Number': ledger.bankAccountNumber ?? '',
    };
  }
}
