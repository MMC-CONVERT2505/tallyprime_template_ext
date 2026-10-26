import { TallyLedger } from '../tally/interfaces/tally.interfaces';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import {
  resolveGstTreatment,
  resolveOpeningBalanceMagnitude,
  resolvePaymentTerms,
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
 *
 * Place Of Contact/Billing Attention/Payment Terms/Payment Terms Label/
 * Contact First Name (added 2026-09-10) — cross-referenced against Zoho's
 * own official Tally migration tool, then VERIFIED live against real
 * ledger data; see TallyLedger.gstPlaceOfSupply/mailingName/creditPeriod's
 * doc comments for the exact field names/population counts. Contact First
 * Name reuses the same LEDGERCONTACT value already written to "Conact
 * Display Name" — matching Zoho's own official tool's convention of
 * putting the whole flat name there rather than splitting it; Last Name
 * stays blank (no split is performed).
 *
 * Customer Number (added 2026-10-20) — Tally has no stable external
 * customer-id field on a ledger master; AlterID (Tally's own per-record
 * edit-revision counter, already fetched/parsed for every ledger — see
 * TallyLedger.alterId's doc comment) is the closest real identifier
 * available and is what's used here. Worth knowing: unlike a true master
 * id, AlterID changes every time the ledger is edited in Tally, so a
 * re-export after an edit will carry a different number for the same
 * customer — fine for a one-time migration import, less so if this column
 * were ever used to match/dedupe against a previous import.
 */
export interface ZohoCustomerRow {
  'Display Name': string;
  'Customer Number': number | '';
  /** Added 2026-09-05 — same value as Display Name. Every ledger this
   *  project extracts as a Customer is a Sundry Debtor, which in real Tally
   *  data is overwhelmingly a registered business name (confirmed against
   *  this project's own live company data — "Rakuten Mobile Inc", "Apeiro
   *  Limited", ...), not an individual; Tally's ledger master has no
   *  separate legal-entity-name field to distinguish the two. */
  'Company Name': string;
  'Place Of Contact': string;
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

/**
 * Every Customer/Vendor row is hardcoded to INR — Zoho's own official Tally
 * migration tool reads a ledger's real currency from a flat CURRENCYNAME
 * field, but that field name was tried live 2026-09-12 (COREDGE.IO INDIA
 * PRIVATE LIMITED) and does NOT resolve at the Ledger level: it came back as
 * the literal string "?" (Tally's own sentinel for an unresolvable
 * expression) for all 1,409 real ledgers, not blank/omitted the way a
 * genuinely nonexistent NATIVEMETHOD does elsewhere in this project. A few
 * plausible alternate names (LEDGERCURRENCYNAME, FORINGCURRNAME,
 * USEFORFOREX) were also tried and silently ignored by Tally (not
 * recognized at all). Left hardcoded rather than guessing a fourth name —
 * this company's real ledgers are believed to be INR-denominated by
 * default anyway (only specific vouchers, not ledgers, carry a foreign
 * currency here — see TallyVoucher.currencyCode).
 */
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
    const paymentTerms = resolvePaymentTerms(ledger.creditPeriod);
    return {
      'Display Name': ledger.name,
      'Customer Number': ledger.alterId ?? '',
      'Company Name': ledger.name,
      'Place Of Contact': ledger.gstPlaceOfSupply ?? '',
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
