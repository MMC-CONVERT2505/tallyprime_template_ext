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

export type StockItemIndex = Map<string, TallyStockItem>;

export function buildStockItemIndex(items: TallyStockItem[]): StockItemIndex {
  return new Map(items.map((item) => [item.name, item]));
}
