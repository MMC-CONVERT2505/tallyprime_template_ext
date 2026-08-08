import { ExcelColumn } from '../excel/excel-generator.service';
import { TallyStockItem } from '../tally/interfaces/tally.interfaces';

/** Zoho Books "Item" import columns actually populated by this project today
 *  — column names taken from the reference tool's real field-mapping config
 *  (xml_to_csv_config.yml, the `Item:` section). Rate/Purchase Rate/Account/
 *  Purchase Account are deliberately omitted: those come from nested,
 *  date-wise Tally lists (STANDARDPRICELIST.LIST/STANDARDCOSTLIST.LIST/
 *  SALESLIST.LIST/PURCHASELIST.LIST) this project doesn't extract yet — see
 *  docs/architecture.md's Phase 5 notes. Leaving them out of the type (rather
 *  than emitting blank columns) keeps that gap visible instead of silently
 *  papered over. */
export interface ZohoItemRow {
  'Item Name': string;
  Description: string;
  'Usage unit': string;
  'Stock Group': string;
  'Initial Stock': number | '';
  'Initial Stock Rate': number | '';
}

export const ITEM_COLUMNS: ExcelColumn[] = [
  { header: 'Item Name', key: 'Item Name', width: 30 },
  { header: 'Description', key: 'Description', width: 30 },
  { header: 'Usage unit', key: 'Usage unit', width: 14 },
  { header: 'Stock Group', key: 'Stock Group', width: 22 },
  { header: 'Initial Stock', key: 'Initial Stock', width: 16 },
  { header: 'Initial Stock Rate', key: 'Initial Stock Rate', width: 18 },
];

export class StockItemMapper {
  toItemRows(items: TallyStockItem[]): ZohoItemRow[] {
    return items.map((item) => this.toItemRow(item));
  }

  private toItemRow(item: TallyStockItem): ZohoItemRow {
    const qty = item.openingBalance;
    const value = item.openingValue;
    const rate = qty !== null && qty !== 0 && value !== null ? value / qty : '';

    return {
      'Item Name': item.name,
      Description: item.description ?? '',
      'Usage unit': item.baseUnit ?? '',
      'Stock Group': item.parent ?? '',
      'Initial Stock': qty ?? '',
      'Initial Stock Rate': rate,
    };
  }
}
