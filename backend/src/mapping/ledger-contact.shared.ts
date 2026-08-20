/**
 * Small helpers shared by CustomerMapper and VendorMapper — both derive from
 * the same enriched Ledger fetch and need the same two conversions.
 */

/**
 * Zoho's GST Treatment is a richer enum (business_gst / business_none /
 * business_registered_composition / consumer / overseas / ...) than Tally's
 * ledger master captures directly. A registered GSTIN is a reliable signal
 * of "business_gst"; composition-scheme/overseas/unregistered-business
 * detection would need fields this project doesn't extract — documented
 * simplification, not an oversight.
 */
export function resolveGstTreatment(gstin: string | null): string {
  return gstin ? 'business_gst' : 'consumer';
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
