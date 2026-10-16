import { TallyLedger } from '../tally/interfaces/tally.interfaces';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import {
  resolveGstTreatment,
  resolveOpeningBalanceMagnitude,
  resolvePaymentTerms,
  splitBillingAddress,
} from './ledger-contact.shared';

/**
 * Zoho Books "Vendor" import columns actually populated by this project —
 * taken from the real template (Master and Invoice or Bill/Vendor.xlsx,
 * sheet "Vendor"). See customer.mapper.ts's doc comment for the same
 * "populate what Tally can genuinely supply, leave the rest blank" rule;
 * Vendor additionally gets Bank Name/Bank Account Number, which Customer.xlsx
 * has no columns for at all. Vendor.xlsx has no "Credit Limit" column
 * (unlike Customer.xlsx) — that's an AR-side concept.
 *
 * Source Of Supply/Billing Attention/Payment Terms/Payment Terms Label/
 * Contact First Name (added 2026-09-10) — see customer.mapper.ts's
 * identical fields' doc comment.
 */
export interface ZohoVendorRow {
  'Display Name': string;
  /** Added 2026-09-05 — see customer.mapper.ts's identical field. */
  'Company Name': string;
  'Source Of Supply': string;
  'Currency Code': string;
  'Contact First Name': string;
  EmailID: string;
  Phone: string;
  MobilePhone: string;
  'Payment Terms': number | '';
  'Payment Terms Label': string;
  'GST Treatment': string;
  'GST Identification Number (GSTIN)': string;
  'PAN Number': string;
  'Billing Attention': string;
  'Billing Address': string;
  /** Added 2026-09-05 — see customer.mapper.ts's identical field / the
   *  splitBillingAddress doc comment for why this is now its own column
   *  instead of getting silently dropped from the joined address. */
  'Billing Street2': string;
  'Billing State': string;
  'Billing Country': string;
  'Billing Code': string;
  'Opening Balance': number | '';
  Status: string;
  /** Added 2026-09-05 — see customer.mapper.ts's identical field. */
  Notes: string;
  'Bank Name': string;
  'Bank Account Number': string;
  /** Added 2026-09-05 — see customer.mapper.ts's identical fields. */
  Website: string;
  'Conact Display Name': string;
}

/** Hardcoded — see customer.mapper.ts's identical constant doc comment for
 *  why (CURRENCYNAME confirmed live not to resolve at the Ledger level). */
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
    const address = splitBillingAddress(ledger.billingAddress);
    const paymentTerms = resolvePaymentTerms(ledger.creditPeriod);
    return {
      'Display Name': ledger.name,
      'Company Name': ledger.name,
      'Source Of Supply': ledger.gstPlaceOfSupply ?? '',
      'Currency Code': DEFAULT_CURRENCY_CODE,
      'Contact First Name': ledger.contactPersonName ?? '',
      EmailID: ledger.email ?? '',
      Phone: ledger.phone ?? '',
      MobilePhone: ledger.mobile ?? '',
      'Payment Terms': paymentTerms.days,
      'Payment Terms Label': paymentTerms.label,
      'GST Treatment': resolveGstTreatment(ledger.gstin, ledger.gstRegistrationType),
      'GST Identification Number (GSTIN)': ledger.gstin ?? '',
      'PAN Number': ledger.panNumber ?? '',
      'Billing Attention': ledger.mailingName ?? '',
      'Billing Address': address.line1,
      'Billing Street2': address.line2,
      'Billing State': ledger.billingState ?? '',
      'Billing Country': ledger.billingCountry ?? '',
      'Billing Code': ledger.billingPincode ?? '',
      'Opening Balance': resolveOpeningBalanceMagnitude(ledger.openingBalance),
      Status: 'Active',
      Notes: ledger.description ?? '',
      'Bank Name': ledger.bankName ?? '',
      'Bank Account Number': ledger.bankAccountNumber ?? '',
      Website: ledger.website ?? '',
      'Conact Display Name': ledger.contactPersonName ?? '',
    };
  }
}
