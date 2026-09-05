import { TallyStockItem } from '../tally/interfaces/tally.interfaces';

/**
 * Shared helpers for the 4 VOUCHERS-derived mappers (invoice/bill/credit-note/
 * stock-journal): date conversion and the item lookup they all need to pull
 * HSN/GST rate from the (separately-fetched) STOCK_ITEMS job — see
 * invoice.mapper.ts's doc comment for why tax/HSN come from the item master
 * rather than being re-parsed off each voucher line.
 */

/** Tally's DATE field is YYYYMMDD with no separators. Converts to a real
 *  JS Date so ExcelJS writes a genuine date-typed cell (matching the
 *  template's own date columns) instead of a plain string. UTC noon, same
 *  convention as date-range-chunker.ts, to dodge DST-adjacent date bugs —
 *  irrelevant for a pure calendar date, cheap insurance regardless. */
export function tallyDateToJsDate(date: string | null): Date | null {
  if (!date || !/^\d{8}$/.test(date)) return null;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  return new Date(Date.UTC(year, month - 1, day, 12));
}

/**
 * Voucher date + a bill-wise credit period (days) -> Due Date — added
 * 2026-09-05 for Invoice.xlsx/Bill.xlsx. Returns '' rather than the voucher
 * date itself when no credit period is known, since a Due Date silently
 * equal to the invoice date would misrepresent "payment due immediately" as
 * a real fact rather than "unknown" — see
 * LedgerTaxSummary.partyBillCreditPeriodDays's doc comment for how often
 * that's the actual case with this project's live data today.
 */
export function addDaysToTallyDate(date: string | null, days: number | null): Date | '' {
  const base = tallyDateToJsDate(date);
  if (!base || days === null) return '';
  const due = new Date(base.getTime());
  due.setUTCDate(due.getUTCDate() + days);
  return due;
}

export type StockItemIndex = Map<string, TallyStockItem>;

export function buildStockItemIndex(items: TallyStockItem[]): StockItemIndex {
  return new Map(items.map((item) => [item.name, item]));
}

const DEFAULT_CURRENCY_CODE = 'INR';
/** Zoho's own convention for a base-currency transaction — 1 unit of INR
 *  equals 1 unit of INR, not left blank. */
const DEFAULT_EXCHANGE_RATE = 1;

/**
 * TallyVoucher.currencyCode/.exchangeRate -> Invoice.xlsx/Bill.xlsx/Credit
 * Note.xlsx's "Currency Code"/"Exchange Rate" columns — added 2026-09-05.
 * Previously always hardcoded to 'INR' regardless of the voucher's actual
 * currency; VERIFIED live that ~5% of this project's own test company's real
 * vouchers are genuinely foreign-currency (USD) — see
 * TallyVoucher.currencyCode's doc comment and parseTallyForeignAmount.
 */
export function resolveVoucherCurrency(voucher: {
  currencyCode: string | null;
  exchangeRate: number | null;
}): { currencyCode: string; exchangeRate: number } {
  return voucher.currencyCode
    ? { currencyCode: voucher.currencyCode, exchangeRate: voucher.exchangeRate ?? DEFAULT_EXCHANGE_RATE }
    : { currencyCode: DEFAULT_CURRENCY_CODE, exchangeRate: DEFAULT_EXCHANGE_RATE };
}
