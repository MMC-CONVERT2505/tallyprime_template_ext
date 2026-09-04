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
