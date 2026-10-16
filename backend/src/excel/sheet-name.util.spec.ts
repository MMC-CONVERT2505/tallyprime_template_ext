import { sanitizeSheetName } from './sheet-name.util';

describe('sanitizeSheetName', () => {
  it('passes through an already-safe name unchanged', () => {
    expect(sanitizeSheetName('Customer', new Set())).toBe('Customer');
  });

  it('strips Excel-illegal characters (: \\ / ? * [ ])', () => {
    expect(sanitizeSheetName('VOUCHERS:Sales/Return?', new Set())).toBe('VOUCHERS Sales Return');
  });

  it('trims leading/trailing single quotes', () => {
    expect(sanitizeSheetName("'Quoted'", new Set())).toBe('Quoted');
  });

  it('truncates to Excel\'s 31-character limit', () => {
    const raw = 'A'.repeat(50);
    const result = sanitizeSheetName(raw, new Set());
    expect(result).toHaveLength(31);
  });

  it('falls back to a generic name when sanitization empties the string', () => {
    expect(sanitizeSheetName(':::', new Set())).toBe('Sheet');
  });

  it('avoids Excel\'s reserved "History" sheet name (case-insensitive)', () => {
    expect(sanitizeSheetName('History', new Set()).toLowerCase()).not.toBe('history');
    expect(sanitizeSheetName('HISTORY', new Set()).toLowerCase()).not.toBe('history');
  });

  it('de-duplicates a collision case-insensitively with a numeric suffix', () => {
    const used = new Set(['sales']);
    expect(sanitizeSheetName('Sales', used)).toBe('Sales~2');
  });

  it('de-duplicates against an existing suffix, advancing the counter', () => {
    const used = new Set(['sales', 'sales~2']);
    expect(sanitizeSheetName('Sales', used)).toBe('Sales~3');
  });

  it('keeps a suffixed name within the 31-character limit', () => {
    const longName = 'A'.repeat(31);
    const used = new Set([longName.toLowerCase()]);
    const result = sanitizeSheetName(longName, used);
    expect(result.length).toBeLessThanOrEqual(31);
    expect(result.endsWith('~2')).toBe(true);
  });

  it('is case-insensitive when checking for collisions (Excel treats "Sales" and "SALES" as the same)', () => {
    const used = new Set(['sales']);
    const result = sanitizeSheetName('SALES', used);
    expect(result.toLowerCase()).not.toBe('sales');
  });
});
