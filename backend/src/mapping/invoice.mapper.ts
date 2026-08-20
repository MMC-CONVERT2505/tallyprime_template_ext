import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { deriveIntraStateTax } from './gst-rate.shared';
import { resolveGstTreatment } from './ledger-contact.shared';
import { StockItemIndex, tallyDateToJsDate } from './voucher-line.shared';

/**
 * Zoho Books "Invoice" import columns actually populated by this project —
 * taken from the real template (Master and Invoice or Bill/Invoice.xlsx,
 * sheet "Invoice"), which has 72 columns total. One output row per Tally
 * inventory line (Zoho's own flat-per-line convention, confirmed against the
 * template's real sample rows — a multi-item invoice repeats the header
 * fields on every line). Everything without a genuine Tally source (TCS/TDS
 * compliance fields, Payment Terms, Sales person, Shipping Charge, discount
 * fields, e-commerce/payment-gateway flags, Branch/Warehouse — no Godown
 * extraction yet) is left blank, not guessed.
 *
 * Item Tax/HSN come from the separately-fetched STOCK_ITEMS job
 * (`itemIndex`, keyed by item name), not parsed off the voucher line itself
 * — Tally's per-line GST detail lives in a deeply nested, highly
 * version-dependent structure (ALLINVENTORYENTRIES.LIST -> GSTDETAILS.LIST)
 * this project deliberately doesn't attempt to parse; the item master's own
 * gstRate (already needed for Item.xlsx) is a more reliable source for the
 * same number. This also means only ONE tax value shows per line (Zoho's
 * template distinguishes Intra/Inter State only on the Item import, not on
 * Invoice/Bill/Credit Note) — deriveIntraStateTax is used as the single
 * "Item Tax" column, a documented simplification: correctly identifying an
 * inter-state (IGST) sale needs the seller's own home state, which nothing
 * in this project extracts today.
 */
export interface ZohoInvoiceRow {
  'Invoice Number': string;
  'Invoice Date': Date | '';
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
  'Item Tax Type': string;
  'Item Tax %': number | '';
  Notes: string;
}

const DEFAULT_CURRENCY_CODE = 'INR';

export class InvoiceMapper {
  constructor(private readonly itemIndex: StockItemIndex) {}

  toInvoiceRows(vouchers: TallyVoucher[]): ZohoInvoiceRow[] {
    return vouchers.flatMap((voucher) => this.toInvoiceRowsForVoucher(voucher));
  }

  private toInvoiceRowsForVoucher(voucher: TallyVoucher): ZohoInvoiceRow[] {
    if (voucher.inventoryEntries.length === 0) return [];

    return voucher.inventoryEntries.map((line) => {
      const item = this.itemIndex.get(line.stockItemName);
      const tax = deriveIntraStateTax(item?.gstRate ?? null);

      return {
        'Invoice Number': voucher.voucherNumber ?? '',
        'Invoice Date': tallyDateToJsDate(voucher.date) ?? '',
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
        'Item Tax Type': tax.type,
        'Item Tax %': tax.rate,
        Notes: voucher.narration ?? '',
      };
    });
  }
}
