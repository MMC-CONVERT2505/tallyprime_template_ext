import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { StockItemIndex, tallyDateToJsDate } from './voucher-line.shared';

/**
 * Zoho Books "Inventory Adjustment" import columns actually populated by
 * this project — taken from the real template (Master and Invoice or
 * Bill/Stock Journal.xlsx, sheet "Inventory Adjustment"). Unlike Invoice/
 * Bill/Credit Note, this is a quantity-adjustment shape, not a tax-bearing
 * line-item shape — no GST columns exist on this template at all.
 *
 * "New Quantity on Hand"/"New Value"/"Cost Price" are deliberately left
 * blank: those need a genuine running stock balance at the moment of this
 * specific voucher, which Tally's per-voucher inventory entry doesn't carry
 * (TallyStockItem.closingBalance is the item's company-wide as-of-date
 * balance, not a per-transaction snapshot) — populating them from the wrong
 * source would be actively incorrect, not just incomplete. "Status" is
 * hardcoded to 'adjusted' since every voucher extracted from a completed
 * Tally Day Book is, by definition, already finalized (Zoho's own 'draft'
 * status describes an import-only state Tally has no equivalent for).
 */
export interface ZohoStockJournalRow {
  Date: Date | '';
  Status: string;
  'Reference Number': string;
  Description: string;
  'Quantity Adjusted': number | '';
  'Adjusted Value': number | '';
  'Item Name': string;
  SKU: string;
  'Item Description': string;
  Unit: string;
}

export class StockJournalMapper {
  constructor(private readonly itemIndex: StockItemIndex) {}

  toStockJournalRows(vouchers: TallyVoucher[]): ZohoStockJournalRow[] {
    return vouchers.flatMap((voucher) => this.toStockJournalRowsForVoucher(voucher));
  }

  private toStockJournalRowsForVoucher(voucher: TallyVoucher): ZohoStockJournalRow[] {
    if (voucher.inventoryEntries.length === 0) return [];

    return voucher.inventoryEntries.map((line) => {
      const item = this.itemIndex.get(line.stockItemName);

      return {
        Date: tallyDateToJsDate(voucher.date) ?? '',
        Status: 'adjusted',
        'Reference Number': voucher.reference ?? voucher.voucherNumber ?? '',
        Description: voucher.narration ?? '',
        'Quantity Adjusted': line.quantity ?? '',
        'Adjusted Value': line.amount ?? '',
        'Item Name': line.stockItemName,
        SKU: item?.alias ?? '',
        'Item Description': item?.description ?? '',
        Unit: item?.baseUnit ?? '',
      };
    });
  }
}
