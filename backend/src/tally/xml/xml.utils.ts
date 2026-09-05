/**
 * XML helpers shared by the request builder and response parser. Kept as pure
 * functions (no Nest DI) so they are trivial to unit-test in isolation.
 */

/**
 * Escape a value before injecting it into a request envelope. Critical for
 * company/ledger names containing `&`, `<`, `>`, quotes — a raw `&` in
 * "Smith & Co" would otherwise produce malformed XML that Tally rejects.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Repair NON-standard escaping in Tally RESPONSES before handing them to a
 * strict XML parser. Older Tally builds emit bare `&` inside narrations/names
 * (e.g. "R&D", "Tom & Jerry") without encoding it, which is not well-formed XML
 * and makes strict parsers throw.
 *
 * We only touch `&` that is NOT already the start of a valid entity
 * (&amp; &lt; &gt; &quot; &apos; &#123; &#x1F;). Everything else is left alone,
 * so a correctly-encoded response passes through untouched.
 */
export function sanitizeTallyXml(xml: string): string {
  if (!xml) return xml;

  let out = xml;

  // Strip a UTF-8 BOM if present — it trips some parsers when it is not the
  // very first byte after decoding.
  if (out.charCodeAt(0) === 0xfeff) {
    out = out.slice(1);
  }

  // Encode stray ampersands that are not part of a recognised entity.
  out = out.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');

  return out;
}

/**
 * Tally returns a single object when a collection has one member and an array
 * when it has many (and `undefined` when zero). Every consumer needs a stable
 * array, so normalize once here. This single quirk is the source of most naive
 * Tally-parser bugs.
 */
export function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Parse a Tally amount string into a number, preserving sign.
 * Handles: "-11800.00", "1,18,000.00" (Indian grouping), " 500 ", "", undefined.
 *
 * Also handles Tally's bill-quantity/rate annotation, e.g.
 * `-₹638667.00 @ ₹ 25/? = -₹ 15966675.00` (confirmed live 2026-08-25 on a
 * real GST-registered ledger entry — the ₹ glyph itself can arrive mangled
 * to "?" depending on TALLY_RESPONSE_ENCODING, unrelated to this format).
 * Only the portion before " @ " is the entry's own amount; what follows is a
 * rate/multiplier breakdown (here, 638667 × 25 = 15966675) that plain
 * balance/quantity fields (ledger OPENINGBALANCE, stock item quantities,
 * ...) never carry — so stripping at " @ " is safe for every caller, not
 * just voucher ledger entries, and previously left the whole string's digits
 * concatenated across both halves, producing an unparseable NaN (silently
 * returned as null, discarding a real amount).
 *
 * Returns null when there is genuinely no parseable number.
 */
export function parseTallyAmount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;

  const beforeRateBreakdown = raw.split(' @ ')[0];

  // Remove thousands separators (commas) and any stray currency symbols/spaces,
  // keep digits, sign and decimal point.
  const cleaned = beforeRateBreakdown.replace(/[,\s]/g, '').replace(/[^0-9.\-+]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '+') return null;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Symbols that unambiguously indicate a genuinely foreign-currency amount —
 *  deliberately excludes '₹' and its mangled '?' rendering (see
 *  parseTallyAmount's doc comment), since those appear on BOTH sides of a
 *  same-currency quantity/rate breakdown too and would misfire here. */
const FOREIGN_CURRENCY_SYMBOLS = ['$', '€', '£', '¥'] as const;

/** Best-effort foreign-symbol -> ISO 4217 code, for the handful of symbols
 *  this project actually watches for. Extend as new symbols are confirmed
 *  live rather than guessing a comprehensive table upfront. */
const CURRENCY_CODE_BY_SYMBOL: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
};

export interface TallyForeignAmount {
  /** Base/reporting-currency (INR) equivalent — what every caller should book. */
  amount: number | null;
  /** ISO 4217 code (e.g. 'USD'), or null for a plain domestic amount. */
  currencyCode: string | null;
  /** Units of foreign currency before conversion — null when not foreign. */
  foreignAmount: number | null;
  /** INR per 1 unit of foreign currency — null when not foreign. */
  exchangeRate: number | null;
}

/**
 * Currency-aware sibling of parseTallyAmount, for the small set of fields
 * where the caller also needs to know the ORIGINAL transaction currency
 * (voucher ledger/inventory entries) rather than just a plain INR number.
 *
 * Confirmed live 2026-09-05, COREDGE.IO INDIA PRIVATE LIMITED: ~5% of this
 * company's real ledger-entry amounts are foreign-currency, e.g.
 * `76225.00 $ @ ? 95.021/ $ = ? 7242975.73` (76,225 USD @ 95.021 -> ~72.4
 * lakh INR; '?' is '₹' mangled by TALLY_RESPONSE_ENCODING, same artifact
 * parseTallyAmount's own doc comment already documents). Calling plain
 * parseTallyAmount on this string silently returns 76225 — the DOLLAR face
 * value — because it only strips the " @ ..." rate-breakdown suffix; that
 * value was then being booked as if it were 76,225 RUPEES, understating this
 * line by roughly 95x. This function instead recognizes the presence of an
 * unambiguous foreign symbol ($/€/£/¥ — never ₹ or its mangled '?', which
 * also legitimately appears in a SAME-currency quantity/rate breakdown, see
 * parseTallyAmount) and returns the converted amount after the final '='
 * instead.
 *
 * Deliberately NOT folded into parseTallyAmount itself: that function is
 * shared by every numeric field this project reads, including ledger/stock
 * item master balances that have never been observed in a foreign-currency
 * shape — changing its core behavior would risk the already-live-verified
 * quantity/rate fix regressing for a case this project hasn't tested. This
 * sibling is opt-in, used only where a foreign-currency voucher amount is
 * actually plausible (TallyResponseParser.mapVoucher's ledger/inventory
 * entries).
 */
export function parseTallyForeignAmount(value: unknown): TallyForeignAmount {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  const symbol = FOREIGN_CURRENCY_SYMBOLS.find((s) => raw.includes(s));

  if (!raw || !symbol || !raw.includes('=')) {
    return { amount: parseTallyAmount(raw), currencyCode: null, foreignAmount: null, exchangeRate: null };
  }

  const segments = raw.split('=');
  const converted = parseTallyAmount(segments[segments.length - 1]);
  // A leading '-' only ever appears once, at the very front of the whole
  // string (confirmed against both this and parseTallyAmount's own live
  // example) — the converted segment after '=' doesn't repeat it unless
  // Tally itself already included one there.
  const isNegative = raw.trimStart().startsWith('-');
  const amount = converted !== null && isNegative && converted > 0 ? -converted : converted;

  const hasRate = raw.includes('@');
  const foreignAmount = hasRate ? parseTallyAmount(raw.split('@')[0]) : null;
  const rateMatch = raw.match(/@\s*[^\d-]*(-?[\d,.]+)/);
  const exchangeRate = rateMatch ? parseTallyAmount(rateMatch[1]) : null;

  return {
    amount,
    currencyCode: CURRENCY_CODE_BY_SYMBOL[symbol] ?? null,
    foreignAmount,
    exchangeRate,
  };
}

/**
 * Tally prefixes references to certain built-in top-level objects (e.g. the
 * "Primary" group) with a literal, non-standard marker that looks like an XML
 * numeric character reference but is actually sent as raw text — Tally itself
 * never encodes it, so it is NOT decoded by the XML parser. Observed as
 * `&#4; Primary` in a stock item / ledger PARENT field; strip it so callers
 * see the clean name Tally's own UI shows, not this internal rendering artifact.
 */
const TALLY_LEVEL_MARKER = /^&#\d+;\s*/;

/**
 * Read a value that Tally may deliver either as text or as `{ '#text': '...' }`
 * (fast-xml-parser wraps a tag that carries both attributes and text). Returns
 * a trimmed string, or null when the tag is absent/empty — never assume a key
 * exists, because Tally frequently OMITS empty fields entirely.
 */
export function readText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    if (text === undefined || text === null) return null;
    const s = String(text).trim().replace(TALLY_LEVEL_MARKER, '');
    return s === '' ? null : s;
  }
  const s = String(value).trim().replace(TALLY_LEVEL_MARKER, '');
  return s === '' ? null : s;
}

/** Parse an integer-ish tag (e.g. ALTERID) to number, or null. */
export function readInt(value: unknown): number | null {
  const s = readText(value);
  if (s === null) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/** Interpret Tally's "Yes"/"No" booleans (case-insensitive). null if absent. */
export function readYesNo(value: unknown): boolean | null {
  const s = readText(value);
  if (s === null) return null;
  return s.toLowerCase() === 'yes';
}
