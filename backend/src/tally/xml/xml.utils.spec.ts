import {
  escapeXml,
  parseTallyAmount,
  parseTallyForeignAmount,
  readInt,
  readText,
  readYesNo,
  sanitizeTallyXml,
  toArray,
} from './xml.utils';

describe('xml.utils', () => {
  describe('escapeXml', () => {
    it('escapes XML-significant characters in injected values', () => {
      expect(escapeXml('Smith & Co')).toBe('Smith &amp; Co');
      expect(escapeXml('<x>')).toBe('&lt;x&gt;');
      expect(escapeXml(`a"b'c`)).toBe('a&quot;b&apos;c');
    });
  });

  describe('sanitizeTallyXml', () => {
    it('encodes bare ampersands that are not valid entities', () => {
      expect(sanitizeTallyXml('<N>R&D</N>')).toBe('<N>R&amp;D</N>');
      expect(sanitizeTallyXml('<N>Tom & Jerry</N>')).toBe('<N>Tom &amp; Jerry</N>');
    });

    it('leaves already-valid entities untouched', () => {
      const good = '<N>R&amp;D</N> &lt; &gt; &#39; &#x27;';
      expect(sanitizeTallyXml(good)).toBe(good);
    });

    it('strips a leading BOM', () => {
      expect(sanitizeTallyXml('﻿<ENVELOPE/>')).toBe('<ENVELOPE/>');
    });
  });

  describe('toArray', () => {
    it('normalizes single object, array, and nullish into an array', () => {
      expect(toArray({ a: 1 })).toEqual([{ a: 1 }]);
      expect(toArray([{ a: 1 }, { a: 2 }])).toHaveLength(2);
      expect(toArray(undefined)).toEqual([]);
      expect(toArray(null)).toEqual([]);
    });
  });

  describe('parseTallyAmount', () => {
    it('parses signed decimals', () => {
      expect(parseTallyAmount('-11800.00')).toBe(-11800);
      expect(parseTallyAmount('10000.00')).toBe(10000);
    });

    it('handles Indian-grouped numbers and stray whitespace', () => {
      expect(parseTallyAmount('1,18,000.00')).toBe(118000);
      expect(parseTallyAmount('  500 ')).toBe(500);
    });

    it('returns null for empty / non-numeric / missing values', () => {
      expect(parseTallyAmount('')).toBeNull();
      expect(parseTallyAmount('   ')).toBeNull();
      expect(parseTallyAmount('-')).toBeNull();
      expect(parseTallyAmount(undefined)).toBeNull();
      expect(parseTallyAmount(null)).toBeNull();
    });

    // Confirmed live 2026-08-25: a same-currency (₹-on-both-sides) quantity/
    // rate breakdown must still resolve via the FIRST segment, exactly as
    // before — parseTallyForeignAmount below is what handles a genuine
    // currency change; this function must not regress this live incident.
    it('takes the first segment for a same-currency quantity/rate breakdown, not the total', () => {
      expect(parseTallyAmount('-₹638667.00 @ ₹ 25/? = -₹ 15966675.00')).toBe(-638667);
    });
  });

  describe('parseTallyForeignAmount', () => {
    it('returns the converted (INR) amount for a genuine foreign-currency entry, not the face value', () => {
      // Confirmed live 2026-09-05: 76,225 USD @ 95.021 -> ~72.4 lakh INR;
      // plain parseTallyAmount would silently return 76225 (the dollar face
      // value), understating this line by ~95x.
      const result = parseTallyForeignAmount('76225.00 $ @ ? 95.021/ $ = ? 7242975.73');
      expect(result.amount).toBeCloseTo(7242975.73);
      expect(result.currencyCode).toBe('USD');
      expect(result.foreignAmount).toBe(76225);
      expect(result.exchangeRate).toBeCloseTo(95.021);
    });

    it('preserves a negative sign from the front of the string onto the converted amount', () => {
      const result = parseTallyForeignAmount('-76225.00 $ @ ? 95.021/ $ = ? 7242975.73');
      expect(result.amount).toBeCloseTo(-7242975.73);
    });

    it('falls back to plain parseTallyAmount for a same-currency (₹-only) breakdown', () => {
      const result = parseTallyForeignAmount('-₹638667.00 @ ₹ 25/? = -₹ 15966675.00');
      expect(result.amount).toBe(-638667);
      expect(result.currencyCode).toBeNull();
      expect(result.exchangeRate).toBeNull();
    });

    it('falls back to plain parseTallyAmount for an ordinary domestic amount', () => {
      const result = parseTallyForeignAmount('-11800.00');
      expect(result.amount).toBe(-11800);
      expect(result.currencyCode).toBeNull();
    });

    it('handles a RATE-shaped string with no "@" (per-unit rate, no exchange-rate segment)', () => {
      const result = parseTallyForeignAmount('762.25 $ = ? 72429.76/Nodes');
      expect(result.amount).toBeCloseTo(72429.76);
      expect(result.currencyCode).toBe('USD');
      expect(result.foreignAmount).toBeNull();
      expect(result.exchangeRate).toBeNull();
    });

    it('returns nulls for empty/missing values', () => {
      expect(parseTallyForeignAmount('').amount).toBeNull();
      expect(parseTallyForeignAmount(undefined).amount).toBeNull();
    });
  });

  describe('readText', () => {
    it('reads plain text and #text-wrapped nodes', () => {
      expect(readText('Cash')).toBe('Cash');
      expect(readText({ '#text': 'Cash', '@_ID': '1' })).toBe('Cash');
    });

    it('returns null for empty or absent values (omitted tags)', () => {
      expect(readText('')).toBeNull();
      expect(readText('   ')).toBeNull();
      expect(readText(undefined)).toBeNull();
      expect(readText({})).toBeNull();
    });

    it('strips Tally\'s non-standard "&#N; " level marker on built-in group references', () => {
      // Observed live: Tally sends this as literal text (not a real numeric
      // character reference the XML parser decodes) on PARENT fields that
      // point at a built-in top-level group like "Primary".
      expect(readText('&#4; Primary')).toBe('Primary');
      expect(readText({ '#text': '&#4; Primary' })).toBe('Primary');
      expect(readText('&#1; Primary')).toBe('Primary'); // marker digit may vary
    });
  });

  describe('readInt / readYesNo', () => {
    it('parses ALTERID-style ints', () => {
      expect(readInt('42')).toBe(42);
      expect(readInt('')).toBeNull();
      expect(readInt(undefined)).toBeNull();
    });

    it('parses Yes/No case-insensitively', () => {
      expect(readYesNo('Yes')).toBe(true);
      expect(readYesNo('no')).toBe(false);
      expect(readYesNo(undefined)).toBeNull();
    });
  });
});
