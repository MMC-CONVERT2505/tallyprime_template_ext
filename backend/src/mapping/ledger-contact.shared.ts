/**
 * Small helpers shared by CustomerMapper and VendorMapper — both derive from
 * the same enriched Ledger fetch and need the same two conversions.
 */

/**
 * Zoho's GST Treatment enum, keyed by Tally's own GSTREGISTRATIONTYPE value
 * — cross-referenced against Zoho's own official Tally migration tool
 * (ZFMigrationTool-v1.9's col_value_mapping.yml carries this exact table),
 * then VERIFIED live against COREDGE.IO INDIA PRIVATE LIMITED: this
 * company's real ledgers/vouchers actually carry "Regular" (business_gst),
 * "Unregistered/Consumer" (business_none), and "Unknown" (falls to the
 * catch-all below) — Composition/SEZ/Government-TDS/Deemed-Export/Export
 * rows exist in the table for completeness (a real Tally option this
 * company simply doesn't use) but aren't independently confirmed against
 * this company's own data since it has none of those.
 *
 * This replaces an earlier, cruder version of this function that inferred
 * GST Treatment from GSTIN presence alone (`gstin ? 'business_gst' :
 * 'consumer'`) — that silently mapped every real "Unregistered/Consumer"
 * ledger/voucher (470 of 1,409 ledgers; 113 of 602 sampled vouchers) to
 * Zoho's "consumer" (an end retail individual) instead of the correct
 * "business_none" (a registered business that just isn't GST-registered) —
 * two different Zoho GST treatments with different tax/reporting
 * implications.
 */
const GST_TREATMENT_BY_REGISTRATION_TYPE: Record<string, string> = {
  Regular: 'business_gst',
  Composition: 'business_registered_composition',
  'Unregistered/Consumer': 'business_none',
  'Government entity / TDS': 'tax_deductor',
  'Regular - SEZ': 'business_sez',
  'Regular-Deemed Exporter': 'deemed_export',
  'Regular-Exports (EOU)': 'overseas',
};

/**
 * `registrationType` is Tally's own GSTREGISTRATIONTYPE (see TallyLedger.
 * gstRegistrationType/TallyVoucher.partyGstRegistrationType's doc
 * comments) — the real classification, checked first. Falls back to the
 * GSTIN-presence heuristic only when no registration type was found at all
 * (a ledger/voucher with no LEDGSTREGDETAILS.LIST entry whatsoever), and
 * finally to Zoho's own documented default ("consumer") for anything else,
 * including Tally's literal "Unknown" registration type — matching Zoho's
 * own tool's `_else: "consumer"` catch-all.
 */
export function resolveGstTreatment(
  gstin: string | null,
  registrationType: string | null,
): string {
  if (registrationType && GST_TREATMENT_BY_REGISTRATION_TYPE[registrationType]) {
    return GST_TREATMENT_BY_REGISTRATION_TYPE[registrationType];
  }
  if (!registrationType && gstin) return 'business_gst';
  return 'consumer';
}

/**
 * Mirrors Zoho's own official tool's CxPmtTermsValueHandler: only a value
 * in " Days" form is processed (VERIFIED live: TallyLedger.creditPeriod's
 * one real example, "Sachin", came back as a bare "20" via this project's
 * NATIVEMETHOD fetch — handled here as equivalent to "20 Days" — but
 * Zoho's own reference handler explicitly strips a " Days" suffix too, so
 * a differently-configured ledger/Tally build that emits it that way is
 * also handled). Anything else (a specific date, "Advance", blank) is left
 * blank on both columns rather than guessed — matching this project's
 * "Unused by this company" / Zoho's own documented "we will process only
 * Payment Terms with Days format" limitation.
 */
export function resolvePaymentTerms(creditPeriod: string | null): {
  days: number | '';
  label: string;
} {
  if (!creditPeriod) return { days: '', label: '' };
  const match = /^(\d+)(?:\s*Days)?$/i.exec(creditPeriod.trim());
  if (!match) return { days: '', label: '' };
  const days = Number(match[1]);
  return { days, label: `${days} Days` };
}

/**
 * Tally's OPENINGBALANCE sign encodes Dr/Cr (negative = Debit — see
 * ledger.mapper.ts's identical convention). Zoho's Customer/Vendor Opening
 * Balance column is a plain magnitude with no separate Dr/Cr column, unlike
 * the Chart of Accounts import.
 */
export function resolveOpeningBalanceMagnitude(openingBalance: number | null): number | '' {
  return openingBalance !== null ? Math.abs(openingBalance) : '';
}

/**
 * TallyLedger.billingAddress is every ADDRESS.LIST line already joined with
 * '\n' (see response.parser.ts's readAddressList) — a single field, because
 * that's what this project's other consumers (COA has no address column at
 * all; the combined value was previously the only thing written anywhere).
 * Customer.xlsx/Vendor.xlsx actually have TWO address columns (Billing
 * Address, Billing Street2), matching Tally's own multi-line reality more
 * closely than cramming everything into one cell — added 2026-09-05. The
 * first line is the primary line; any further lines join into Street2 with
 * ", " (a single-line field on the Zoho side, unlike Tally's own list).
 */
export function splitBillingAddress(address: string | null): { line1: string; line2: string } {
  if (!address) return { line1: '', line2: '' };
  const [line1, ...rest] = address.split('\n');
  return { line1: line1 ?? '', line2: rest.join(', ') };
}
