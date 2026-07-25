import {
  escapeXml,
  parseTallyAmount,
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
