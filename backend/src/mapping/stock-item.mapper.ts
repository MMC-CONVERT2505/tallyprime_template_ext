import { TallyStockItem } from '../tally/interfaces/tally.interfaces';
import { deriveInterStateTax, deriveIntraStateTax } from './gst-rate.shared';

/**
 * Zoho Books "Item" import columns actually populated by this project today
 * — taken from the real template (Master and Invoice or Bill/Item.xlsx,
 * sheet "Item"), which has 67 columns total; only the subset Tally's
 * currently-extracted StockItem fields can genuinely supply is listed here.
 * Everything else (SKU, Rate, Account, Purchase Rate/Account — Tally doesn't
 * expose a selling-rate or sales-ledger per stock item, see the price-list
 * gap this project has always deferred) is left blank at write time rather
 * than guessed.
 */
export interface ZohoItemRow {
  'Item Name': string;
  'Alias Name': string;
  Description: string;
  'HSN/SAC': string;
  'Usage unit': string;
  'Opening Stock': number | '';
  'Opening Stock Value': number | '';
  /** Every Tally Stock Item represents physical inventory by construction
   *  (services live on ledgers, not stock items) — 'goods' is a correct
   *  inference here, not a guess. */
  'Item Type': string;
  /** No per-item active/inactive flag exists in TallyStockItem yet; a stock
   *  item just extracted from a live company is overwhelmingly likely to be
   *  in current use, so 'Active' is a reasonable default rather than an
   *  invented fact — same reasoning as ledger.mapper.ts's Currency default. */
  Status: string;
  'Intra State Tax Name': string;
  'Intra State Tax Rate': number | '';
  'Intra State Tax Type': string;
  'Inter State Tax Name': string;
  'Inter State Tax Rate': number | '';
  'Inter State Tax Type': string;
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
      'Alias Name': item.alias ?? '',
      Description: item.description ?? '',
      'HSN/SAC': item.hsnCode ?? '',
      'Usage unit': item.baseUnit ?? '',
      'Opening Stock': item.openingBalance ?? '',
      'Opening Stock Value': item.openingValue ?? '',
      'Item Type': 'goods',
      Status: 'Active',
      'Intra State Tax Name': intra.name,
      'Intra State Tax Rate': intra.rate,
      'Intra State Tax Type': intra.type,
      'Inter State Tax Name': inter.name,
      'Inter State Tax Rate': inter.rate,
      'Inter State Tax Type': inter.type,
    };
  }
}
