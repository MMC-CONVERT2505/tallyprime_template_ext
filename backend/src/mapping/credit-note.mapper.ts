import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { deriveIntraStateTax } from './gst-rate.shared';
import { resolveGstTreatment } from './ledger-contact.shared';
import { StockItemIndex, tallyDateToJsDate } from './voucher-line.shared';

/**
 * Zoho Books "Credit Note" import columns actually populated by this project
 * — taken from the real template (Master and Invoice or Bill/Credit
 * Note.xlsx, sheet "Credit Note"). Same shape/simplification rules as
 * invoice.mapper.ts. "Reason" is deliberately left blank rather than
 * duplicating narration into it — Notes already carries that, and Tally has
 * no separate reason-code field for a Credit Note voucher.
 */
export interface ZohoCreditNoteRow {
  'Credit Note Number': string;
  'Credit Note Date': Date | '';
  'Customer Name': string;
  'GST Treatment': string;
  'GST Identification Number (GSTIN)': string;
  'Place of Supply': string;
  'Currency Code': string;
  'Item Name': string;
  SKU: string;
  'Item Desc': string;
  'Item Type': string;
  'HSN/SAC': string;
  Quantity: number | '';
  'Usage unit': string;
  'Item Price': number | '';
  'Item Tax': string;
  'Item Tax %': number | '';
  'Item Tax Type': string;
  Notes: string;
}

const DEFAULT_CURRENCY_CODE = 'INR';

export class CreditNoteMapper {
  constructor(private readonly itemIndex: StockItemIndex) {}

  toCreditNoteRows(vouchers: TallyVoucher[]): ZohoCreditNoteRow[] {
    return vouchers.flatMap((voucher) => this.toCreditNoteRowsForVoucher(voucher));
  }

  private toCreditNoteRowsForVoucher(voucher: TallyVoucher): ZohoCreditNoteRow[] {
    if (voucher.inventoryEntries.length === 0) return [];

    return voucher.inventoryEntries.map((line) => {
      const item = this.itemIndex.get(line.stockItemName);
      const tax = deriveIntraStateTax(item?.gstRate ?? null);

      return {
        'Credit Note Number': voucher.voucherNumber ?? '',
        'Credit Note Date': tallyDateToJsDate(voucher.date) ?? '',
        'Customer Name': voucher.partyLedgerName ?? '',
        'GST Treatment': resolveGstTreatment(voucher.partyGstin),
        'GST Identification Number (GSTIN)': voucher.partyGstin ?? '',
        'Place of Supply': voucher.placeOfSupply ?? '',
        'Currency Code': DEFAULT_CURRENCY_CODE,
        'Item Name': line.stockItemName,
        SKU: item?.alias ?? '',
        'Item Desc': item?.description ?? '',
        'Item Type': 'goods',
        'HSN/SAC': item?.hsnCode ?? '',
        Quantity: line.quantity ?? '',
        'Usage unit': item?.baseUnit ?? '',
        'Item Price': line.rate ?? '',
        'Item Tax': tax.name,
        'Item Tax %': tax.rate,
        'Item Tax Type': tax.type,
        Notes: voucher.narration ?? '',
      };
    });
  }
}
