import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { deriveIntraStateTax } from './gst-rate.shared';
import { resolveGstTreatment } from './ledger-contact.shared';
import { StockItemIndex, tallyDateToJsDate } from './voucher-line.shared';
import {
  percentageOf,
  round2,
  summarizeLedgerEntries,
  TAX_TYPE_ITEM_AMOUNT,
} from './voucher-tax.shared';

/**
 * Zoho Books "Credit Note" import columns actually populated by this project
 * — taken from the real template (Master and Invoice or Bill/Credit
 * Note.xlsx, sheet "Credit Note"). Same shape/simplification rules as
 * invoice.mapper.ts, including the same fixes: a Credit Note voucher with no
 * inventory lines still gets one row instead of being dropped, "Item Tax
 * Type" is "ItemAmount" (not gst-rate.shared's "Group"), and TCS is derived
 * from the voucher's own posted ledger entries (this template has no TDS
 * columns at all, unlike Invoice.xlsx/Bill.xlsx). "Reason" is deliberately
 * left blank rather than duplicating narration into it — Notes already
 * carries that, and Tally has no separate reason-code field for a Credit
 * Note voucher. "Reference#" maps to Tally's own REFERENCE field, the same
 * source Bill.xlsx uses for its Purchase Order Number.
 */
export interface ZohoCreditNoteRow {
  'Credit Note Number': string;
  'Credit Note Date': Date | '';
  'Reference#': string;
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
  'TCS Tax Name': string;
  'TCS Percentage': number | '';
  'TCS Amount': number | '';
  Notes: string;
}

const DEFAULT_CURRENCY_CODE = 'INR';

export class CreditNoteMapper {
  constructor(private readonly itemIndex: StockItemIndex) {}

  toCreditNoteRows(vouchers: TallyVoucher[]): ZohoCreditNoteRow[] {
    return vouchers.flatMap((voucher) => this.toCreditNoteRowsForVoucher(voucher));
  }

  private toCreditNoteRowsForVoucher(voucher: TallyVoucher): ZohoCreditNoteRow[] {
    const summary = summarizeLedgerEntries(voucher.ledgerEntries, voucher.partyLedgerName);

    const common: Pick<
      ZohoCreditNoteRow,
      | 'Credit Note Number'
      | 'Credit Note Date'
      | 'Reference#'
      | 'Customer Name'
      | 'GST Treatment'
      | 'GST Identification Number (GSTIN)'
      | 'Place of Supply'
      | 'Currency Code'
      | 'Notes'
      | 'TCS Tax Name'
      | 'TCS Amount'
    > = {
      'Credit Note Number': voucher.voucherNumber ?? '',
      'Credit Note Date': tallyDateToJsDate(voucher.date) ?? '',
      'Reference#': voucher.reference ?? '',
      'Customer Name': voucher.partyLedgerName ?? '',
      'GST Treatment': resolveGstTreatment(voucher.partyGstin),
      'GST Identification Number (GSTIN)': voucher.partyGstin ?? '',
      'Place of Supply': voucher.placeOfSupply ?? '',
      'Currency Code': DEFAULT_CURRENCY_CODE,
      Notes: voucher.narration ?? '',
      'TCS Tax Name': summary.tcsName,
      'TCS Amount': summary.tcsAmount,
    };

    if (voucher.inventoryEntries.length > 0) {
      const base = round2(voucher.inventoryEntries.reduce((sum, l) => sum + (l.amount ?? 0), 0));

      return voucher.inventoryEntries.map((line) => {
        const item = this.itemIndex.get(line.stockItemName);
        const tax = deriveIntraStateTax(item?.gstRate ?? null);

        return {
          ...common,
          'TCS Percentage': percentageOf(summary.tcsAmount, base),
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
          'Item Tax Type': tax.name ? TAX_TYPE_ITEM_AMOUNT : '',
        };
      });
    }

    // No inventory lines — a genuine, ledger-only Credit Note. Emit exactly
    // one row instead of silently dropping it — see bill.mapper.ts's doc
    // comment for the live incident this mirrors.
    if (voucher.ledgerEntries.length === 0) return [];

    const base = summary.nonTaxLedgerTotal;
    const taxAmount = summary.gstAmount ?? '';
    const taxPercentage = percentageOf(taxAmount, base);
    const taxName =
      summary.gstKind && taxPercentage !== '' ? `${summary.gstKind}${taxPercentage}` : '';

    return [
      {
        ...common,
        'TCS Percentage': percentageOf(summary.tcsAmount, base),
        'Item Name': '',
        SKU: '',
        'Item Desc': '',
        'Item Type': 'service',
        'HSN/SAC': '',
        Quantity: '',
        'Usage unit': '',
        'Item Price': base || '',
        'Item Tax': taxName,
        'Item Tax %': taxPercentage,
        'Item Tax Type': taxName ? TAX_TYPE_ITEM_AMOUNT : '',
      },
    ];
  }
}
