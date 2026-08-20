import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { deriveIntraStateTax } from './gst-rate.shared';
import { resolveGstTreatment } from './ledger-contact.shared';
import { StockItemIndex, tallyDateToJsDate } from './voucher-line.shared';

/**
 * Zoho Books "Bill" import columns actually populated by this project —
 * taken from the real template (Master and Invoice or Bill/Bill.xlsx, sheet
 * "Bill"). Same shape/simplification rules as invoice.mapper.ts (one row per
 * inventory line, tax/HSN from the STOCK_ITEMS job's item master, single
 * "Tax" column since seller-state isn't known). Unlike Invoice.xlsx, this
 * template has a real Tax Amount column — computed from the line's base
 * amount x the item's GST rate, not left blank, since both inputs are
 * genuinely known once the item's gstRate exists.
 */
export interface ZohoBillRow {
  'Bill Date': Date | '';
  'Bill Number': string;
  'GST Treatment': string;
  'GST Identification Number (GSTIN)': string;
  'Vendor Name': string;
  'Currency Code': string;
  'Item Name': string;
  SKU: string;
  'Item Description': string;
  'Usage unit': string;
  Quantity: number | '';
  Rate: number | '';
  'Item Type': string;
  'Tax Name': string;
  'Tax Percentage': number | '';
  'Tax Amount': number | '';
  'Tax Type': string;
  'Item Total': number | '';
  'Vendor Notes': string;
  'HSN/SAC': string;
}

const DEFAULT_CURRENCY_CODE = 'INR';

export class BillMapper {
  constructor(private readonly itemIndex: StockItemIndex) {}

  toBillRows(vouchers: TallyVoucher[]): ZohoBillRow[] {
    return vouchers.flatMap((voucher) => this.toBillRowsForVoucher(voucher));
  }

  private toBillRowsForVoucher(voucher: TallyVoucher): ZohoBillRow[] {
    if (voucher.inventoryEntries.length === 0) return [];

    return voucher.inventoryEntries.map((line) => {
      const item = this.itemIndex.get(line.stockItemName);
      const tax = deriveIntraStateTax(item?.gstRate ?? null);
      const taxAmount =
        item?.gstRate !== null && item?.gstRate !== undefined && line.amount !== null
          ? Math.round(line.amount * (item.gstRate / 100) * 100) / 100
          : '';

      return {
        'Bill Date': tallyDateToJsDate(voucher.date) ?? '',
        'Bill Number': voucher.voucherNumber ?? '',
        'GST Treatment': resolveGstTreatment(voucher.partyGstin),
        'GST Identification Number (GSTIN)': voucher.partyGstin ?? '',
        'Vendor Name': voucher.partyLedgerName ?? '',
        'Currency Code': DEFAULT_CURRENCY_CODE,
        'Item Name': line.stockItemName,
        SKU: item?.alias ?? '',
        'Item Description': item?.description ?? '',
        'Usage unit': item?.baseUnit ?? '',
        Quantity: line.quantity ?? '',
        Rate: line.rate ?? '',
        'Item Type': 'goods',
        'Tax Name': tax.name,
        'Tax Percentage': tax.rate,
        'Tax Amount': taxAmount,
        'Tax Type': tax.type,
        'Item Total': line.amount ?? '',
        'Vendor Notes': voucher.narration ?? '',
        'HSN/SAC': item?.hsnCode ?? '',
      };
    });
  }
}
