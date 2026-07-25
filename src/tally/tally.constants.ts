/** Tally XML export format token — forces structured XML rather than the UI's ASCII. */
export const SV_EXPORT_FORMAT_XML = '$$SysName:XML';

/** Report/collection identifiers used by the preset requests. */
export const TALLY_REPORTS = {
  DAY_BOOK: 'Day Book',
  VOUCHER_REGISTER: 'Voucher Register',
  LIST_OF_COMPANIES: 'List of Companies',
} as const;

/**
 * Date format Tally expects/emits in STATICVARIABLES: YYYYMMDD, no separators.
 * e.g. 1 April 2025 -> "20250401".
 */
export const TALLY_DATE_REGEX = /^\d{8}$/;
