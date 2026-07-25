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
 * Returns null when there is genuinely no parseable number.
 */
export function parseTallyAmount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;

  // Remove thousands separators (commas) and any stray currency symbols/spaces,
  // keep digits, sign and decimal point.
  const cleaned = raw.replace(/[,\s]/g, '').replace(/[^0-9.\-+]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '+') return null;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

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
    const s = String(text).trim();
    return s === '' ? null : s;
  }
  const s = String(value).trim();
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
