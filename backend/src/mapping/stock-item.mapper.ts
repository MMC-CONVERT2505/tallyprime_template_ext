import { TallyStockItem } from '../tally/interfaces/tally.interfaces';
import { deriveInterStateTax, deriveIntraStateTax } from './gst-rate.shared';

/**
 * Zoho Books "Item" import columns actually populated by this project today
 * — taken from the real template (Master and Invoice or Bill/Item.xlsx,
 * sheet "Item"), which has 67 columns total; only the subset Tally's
 * currently-extracted StockItem fields can genuinely supply is listed here.
 * Everything else (Rate, Account, Purchase Rate/Account — Tally doesn't
 * expose a selling-rate or sales-ledger per stock item on this project's
 * test company; Tally DOES have a Price List feature that could supply Rate/
 * Purchase Rate, confirmed live 2026-09-05 to genuinely be unconfigured
 * — STANDARDPRICELIST.LIST/STANDARDCOSTLIST.LIST came back empty for every
 * item, a real field with no data rather than a wrong one) is left blank at
 * write time rather than guessed.
 *
 * SKU (added 2026-09-05) — the template has both a "SKU" and a separate
 * "Alias Name" column; both get the same TallyStockItem.alias value. Not a
 * duplication invented here — invoice.mapper.ts/bill.mapper.ts/
 * credit-note.mapper.ts already treat this exact field as each of THEIR
 * templates' own "SKU" column, so leaving Item.xlsx's own "SKU" blank while
 * "Alias Name" carries the same value was the actual inconsistency.
 */
export interface ZohoItemRow {
  'Item Name': string;
  SKU: string;
  'Alias Name': string;
  Description: string;
  'HSN/SAC': string;
  'Usage unit': string;
  'Opening Stock': number | '';
  'Opening Stock Value': number | '';
  'Stock On Hand': number | '';
  /** Every Tally Stock Item represents physical inventory by construction
   *  (services live on ledgers, not stock items) — 'goods' is a correct
   *  inference here, not a guess. */
  'Item Type': string;
  /** No per-item active/inactive flag exists in TallyStockItem yet; a stock
   *  item just extracted from a live company is overwhelmingly likely to be
   *  in current use, so 'Active' is a reasonable default rather than an
   *  invented fact — same reasoning as ledger.mapper.ts's Currency default. */
  Status: string;
  /** Added 2026-09-05 — TallyStockItem.gstTaxability ("Taxable"/"Exempt"),
   *  VERIFIED live: 10 of 35 real items were explicitly Exempt, not merely
   *  unclassified — a plain boolean, distinct from the Intra/Inter State Tax
   *  columns below (which correctly stay blank for an Exempt item; no rate
   *  exists to report). */
  Taxable: boolean | '';
  /** Tally's own taxability value, passed through as-is rather than mapped
   *  to a guessed Zoho enum — see gstTaxability's doc comment. */
  'Taxability Type': string;
  'Intra State Tax Name': string;
  'Intra State Tax Rate': number | '';
  'Intra State Tax Type': string;
  'Inter State Tax Name': string;
  'Inter State Tax Rate': number | '';
  'Inter State Tax Type': string;
  /**
   * Added 2026-09-05 — operational defaults, not fabricated facts: every
   * Tally Stock Item is already asserted 'goods' (see 'Item Type' above),
   * and Zoho's own item-creation UI defaults a new item to sellable,
   * purchasable, and inventory-tracked unless a user explicitly unchecks
   * one — the same "least surprising assumption absent contrary
   * information" reasoning 'Status: Active' already uses. TallyStockItem
   * has no per-item flag to override any of these with real data yet.
   */
  Sellable: boolean;
  Purchasable: boolean;
  'Track Inventory': boolean;
}

export class StockItemMapper {
  toItemRows(items: TallyStockItem[]): ZohoItemRow[] {
    return items.map((item) => this.toItemRow(item));
  }

  private toItemRow(item: TallyStockItem): ZohoItemRow {
    const intra = deriveIntraStateTax(item.gstRate);
    const inter = deriveInterStateTax(item.gstRate);

    return {
      'Item Name': item.name,
      SKU: item.alias ?? '',
      'Alias Name': item.alias ?? '',
      Description: item.description ?? '',
      'HSN/SAC': item.hsnCode ?? '',
      'Usage unit': item.baseUnit ?? '',
      'Opening Stock': item.openingBalance ?? '',
      'Opening Stock Value': item.openingValue ?? '',
      // TallyStockItem.closingBalance was already fetched (CLOSINGBALANCE)
      // but never written to this column — confirmed unused elsewhere in
      // this mapper, so wiring it here is a pure gap-fill, not a behavior
      // change to anything already relying on it.
      'Stock On Hand': item.closingBalance ?? '',
      'Item Type': 'goods',
      Status: 'Active',
      Taxable: item.gstTaxability ? item.gstTaxability.toLowerCase() === 'taxable' : '',
      'Taxability Type': item.gstTaxability ?? '',
      'Intra State Tax Name': intra.name,
      'Intra State Tax Rate': intra.rate,
      'Intra State Tax Type': intra.type,
      'Inter State Tax Name': inter.name,
      'Inter State Tax Rate': inter.rate,
      'Inter State Tax Type': inter.type,
      Sellable: true,
      Purchasable: true,
      'Track Inventory': true,
    };
  }
}
