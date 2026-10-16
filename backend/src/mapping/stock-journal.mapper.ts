import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { StockItemIndex, tallyDateToJsDate } from './voucher-line.shared';

/**
 * Zoho Books "Inventory Adjustment" import columns actually populated by
 * this project — taken from the real template (Master and Invoice or
 * Bill/Stock Journal.xlsx, sheet "Inventory Adjustment"). Unlike Invoice/
 * Bill/Credit Note, this is a quantity-adjustment shape, not a tax-bearing
 * line-item shape — no GST columns exist on this template at all.
 *
 * "New Quantity on Hand"/"New Value" are deliberately left blank: those need
 * a genuine running stock balance at the moment of this specific voucher,
 * which Tally's per-voucher inventory entry doesn't carry
 * (TallyStockItem.closingBalance is the item's company-wide as-of-date
 * balance, not a per-transaction snapshot) — populating them from the wrong
 * source would be actively incorrect, not just incomplete. "Status" is
 * hardcoded to 'adjusted' since every voucher extracted from a completed
 * Tally Day Book is, by definition, already finalized (Zoho's own 'draft'
 * status describes an import-only state Tally has no equivalent for).
 *
 * "Cost Price" investigated 2026-09-12 against 3 real Stock Journal
 * vouchers (41 real line items) — initially hypothesized it could come from
 * the same per-line RATE Invoice/Bill/Credit Note already use (no running
 * balance needed, just this transaction's own rate), cross-referenced
 * against Zoho's own official Tally migration tool (whose config sources
 * Stock Journal lines from a different list, INVENTORYENTRIESIN.LIST/
 * INVENTORYENTRIESOUT.LIST, not the ALLINVENTORYENTRIES.LIST this project
 * uses for every other voucher type). Checked both live: RATE came back
 * empty in this project's own parsed data AND directly in a raw probe of
 * Zoho's own preferred INVENTORYENTRIESOUT.LIST for the same real voucher —
 * not a wrong-list bug, the field is genuinely unset at the source for this
 * company's real stock adjustments (recorded by value only, no per-unit
 * rate entered in Tally). Left blank rather than guessed.
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
