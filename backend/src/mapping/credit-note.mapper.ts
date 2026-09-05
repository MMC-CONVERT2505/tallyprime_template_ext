import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { deriveIntraStateTax } from './gst-rate.shared';
import { resolveGstTreatment } from './ledger-contact.shared';
import { resolveVoucherCurrency, StockItemIndex, tallyDateToJsDate } from './voucher-line.shared';
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
 *
 * Currency Code/Exchange Rate/Account/Discount (added 2026-09-05) — see
 * invoice.mapper.ts's doc comment for the same fields; this template has no
 * Due Date column at all (unlike Invoice.xlsx/Bill.xlsx), so
 * LedgerTaxSummary.partyBillCreditPeriodDays has nowhere to go here.
 *
 * Associated Invoice Number (added 2026-09-05) — the SAME voucher.reference
 * value as "Reference#" above, not a second guess: VERIFIED live against
 * this project's own real Credit Notes (COREDGE.IO INDIA PRIVATE LIMITED) —
 * the properly-numbered ones (voucher number series "COREDGE/CN/xx") carry a
 * REFERENCE value that is literally the original Sales invoice's own number
 * (e.g. REFERENCE "Coredge/25-26/27" on a Credit Note against a customer who
 * has a real Sales invoice by that exact number). One real Tally field
 * legitimately answers two different Zoho questions here, the same pattern
 * as Item.xlsx's SKU/Alias Name. "Associated Invoice Date" has no equivalent
 * source — cross-referencing the original invoice's own date would mean
 * looking it up by number in a separate extraction this mapper doesn't have
 * access to, so it stays blank rather than guessed.
 */
export interface ZohoCreditNoteRow {
  'Credit Note Number': string;
  'Credit Note Date': Date | '';
  'Associated Invoice Number': string;
  'Reference#': string;
  'Customer Name': string;
  'GST Treatment': string;
  'GST Identification Number (GSTIN)': string;
  'Place of Supply': string;
  'Currency Code': string;
  'Exchange Rate': number;
  Account: string;
  'Item Name': string;
  SKU: string;
  'Item Desc': string;
  'Item Type': string;
  'HSN/SAC': string;
  Quantity: number | '';
  'Usage unit': string;
  'Item Price': number | '';
  Discount: number | '';
  'Item Tax': string;
  'Item Tax %': number | '';
  'Item Tax Type': string;
  'TCS Tax Name': string;
  'TCS Percentage': number | '';
  'TCS Amount': number | '';
  Notes: string;
}

export class CreditNoteMapper {
  constructor(private readonly itemIndex: StockItemIndex) {}

  toCreditNoteRows(vouchers: TallyVoucher[]): ZohoCreditNoteRow[] {
    return vouchers.flatMap((voucher) => this.toCreditNoteRowsForVoucher(voucher));
  }

  private toCreditNoteRowsForVoucher(voucher: TallyVoucher): ZohoCreditNoteRow[] {
    const summary = summarizeLedgerEntries(voucher.ledgerEntries, voucher.partyLedgerName);
    const currency = resolveVoucherCurrency(voucher);

    const common: Pick<
      ZohoCreditNoteRow,
      | 'Credit Note Number'
      | 'Credit Note Date'
      | 'Associated Invoice Number'
      | 'Reference#'
      | 'Customer Name'
      | 'GST Treatment'
      | 'GST Identification Number (GSTIN)'
      | 'Place of Supply'
      | 'Currency Code'
      | 'Exchange Rate'
      | 'Notes'
      | 'TCS Tax Name'
      | 'TCS Amount'
    > = {
      'Credit Note Number': voucher.voucherNumber ?? '',
      'Credit Note Date': tallyDateToJsDate(voucher.date) ?? '',
      'Associated Invoice Number': voucher.reference ?? '',
      'Reference#': voucher.reference ?? '',
      'Customer Name': voucher.partyLedgerName ?? '',
      'GST Treatment': resolveGstTreatment(voucher.partyGstin),
      'GST Identification Number (GSTIN)': voucher.partyGstin ?? '',
      'Place of Supply': voucher.placeOfSupply ?? '',
      'Currency Code': currency.currencyCode,
      'Exchange Rate': currency.exchangeRate,
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
          Account: line.accountLedgerName ?? '',
          'Item Name': line.stockItemName,
          SKU: item?.alias ?? '',
          'Item Desc': item?.description ?? '',
          'Item Type': 'goods',
          'HSN/SAC': item?.hsnCode ?? '',
          Quantity: line.quantity ?? '',
          'Usage unit': item?.baseUnit ?? '',
          'Item Price': line.rate ?? '',
          Discount: line.discountPercent ?? '',
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
        Account: summary.nonTaxLedgerName,
        'Item Name': '',
        SKU: '',
        'Item Desc': '',
        'Item Type': 'service',
        'HSN/SAC': '',
        Quantity: '',
        'Usage unit': '',
        'Item Price': base || '',
        Discount: '',
        'Item Tax': taxName,
        'Item Tax %': taxPercentage,
        'Item Tax Type': taxName ? TAX_TYPE_ITEM_AMOUNT : '',
      },
    ];
  }
}
