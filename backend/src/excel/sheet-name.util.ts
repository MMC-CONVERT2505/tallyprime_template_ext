const ILLEGAL_CHARS = /[:\\/?*[\]]/g;
const MAX_SHEET_NAME_LENGTH = 31;
/** Excel's own reserved worksheet name — case-insensitive. */
const RESERVED_NAMES = new Set(['history']);

/**
 * Produces a name ExcelJS's `addWorksheet` will accept and that won't
 * collide (case-insensitively — Excel treats sheet names as
 * case-insensitive for uniqueness) with any name already in `usedLowercased`.
 * Needed because the Full Sync debug workbook's RAW sheets are named after
 * free-form Tally voucher type strings (e.g. "Purchase Order", or a name
 * containing "/" or ":") rather than a fixed, pre-vetted set — the 9 Zoho
 * entity sheet names are already short/safe but pass through the same path
 * for one consistent guarantee.
 *
 * Mutates nothing; callers add the returned name (lowercased) to their own
 * `usedLowercased` set before the next call.
 */
export function sanitizeSheetName(raw: string, usedLowercased: ReadonlySet<string>): string {
  let base = raw.replace(ILLEGAL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  base = base.replace(/^'+|'+$/g, '').trim();
  if (!base) base = 'Sheet';
  base = base.slice(0, MAX_SHEET_NAME_LENGTH);
  if (RESERVED_NAMES.has(base.toLowerCase())) {
    base = `${base.slice(0, MAX_SHEET_NAME_LENGTH - 1)}_`;
  }

  if (!usedLowercased.has(base.toLowerCase())) return base;

  for (let suffixNumber = 2; suffixNumber < 1000; suffixNumber++) {
    const suffix = `~${suffixNumber}`;
    const candidate = `${base.slice(0, Math.max(1, MAX_SHEET_NAME_LENGTH - suffix.length))}${suffix}`;
    if (!usedLowercased.has(candidate.toLowerCase())) return candidate;
  }
  // Practically unreachable (would need 1000 colliding names in one
  // workbook) — a last-resort unique fallback rather than an infinite loop.
  return `Sheet${Date.now() % 100000}`;
}
