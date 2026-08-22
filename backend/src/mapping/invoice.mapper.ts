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
 * Zoho Books "Invoice" import columns actually populated by this project —
 * taken from the real template (Master and Invoice or Bill/Invoice.xlsx,
 * sheet "Invoice"), which has 72 columns total. One output row per Tally
 * inventory line (Zoho's own flat-per-line convention, confirmed against the
 * template's real sample rows — a multi-item invoice repeats the header
 * fields on every line), PLUS — see bill.mapper.ts's doc comment for the
 * live incident this mirrors — a Sales voucher recorded with NO inventory
 * lines at all (a pure ledger/service invoice) still gets exactly one row
 * instead of being silently dropped. Payment Terms, Sales person, Shipping
 * Charge, discount fields, e-commerce/payment-gateway flags, Branch/
 * Warehouse (no Godown extraction yet) are left blank, not guessed.
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
 * in this project extracts today. A service-only row has no item to look
 * up, so it uses the voucher's own posted ledger entries instead (same
 * IGST/CGST/SGST pattern-matching as bill.mapper.ts) — genuinely more
 * accurate where available, but kept as a fallback only, to avoid changing
 * the already-tested item-line behavior above.
 *
 * TCS/TDS were added by porting bill.mapper.ts's ledger-entry
 * classification (`voucher-tax.shared.ts`) — this template has the
 * identical columns reading off the identical ALLLEDGERENTRIES.LIST data
 * Bill.xlsx already used; "TDS Section Code" has no Tally source in either
 * template and stays blank.
 */
export interface ZohoInvoiceRow {
  'Invoice Number': string;
  'Invoice Date': Date | '';
  'Customer Name': string;
  'GST Treatment': string;
  'TCS Tax Name': string;
  'TCS Percentage': number | '';
  'TCS Amount': number | '';
  'GST Identification Number (GSTIN)': string;
  'TDS Name': string;
  'TDS Percentage': number | '';
  'TDS Amount': number | '';
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
    const summary = summarizeLedgerEntries(voucher.ledgerEntries, voucher.partyLedgerName);

    const common: Pick<
      ZohoInvoiceRow,
      | 'Invoice Number'
      | 'Invoice Date'
      | 'Customer Name'
      | 'GST Treatment'
      | 'GST Identification Number (GSTIN)'
      | 'Place of Supply'
      | 'Currency Code'
      | 'Notes'
      | 'TCS Tax Name'
      | 'TCS Amount'
      | 'TDS Name'
      | 'TDS Amount'
    > = {
      'Invoice Number': voucher.voucherNumber ?? '',
      'Invoice Date': tallyDateToJsDate(voucher.date) ?? '',
      'Customer Name': voucher.partyLedgerName ?? '',
      'GST Treatment': resolveGstTreatment(voucher.partyGstin),
      'GST Identification Number (GSTIN)': voucher.partyGstin ?? '',
      'Place of Supply': voucher.placeOfSupply ?? '',
      'Currency Code': DEFAULT_CURRENCY_CODE,
      Notes: voucher.narration ?? '',
      'TCS Tax Name': summary.tcsName,
      'TCS Amount': summary.tcsAmount,
      'TDS Name': summary.tdsName,
      'TDS Amount': summary.tdsAmount,
    };

    if (voucher.inventoryEntries.length > 0) {
      // TCS/TDS percentages are computed against the invoice's total goods
      // value — the sum of its own inventory lines, same base used for the
      // service-row fallback below.
      const base = round2(voucher.inventoryEntries.reduce((sum, l) => sum + (l.amount ?? 0), 0));

      return voucher.inventoryEntries.map((line) => {
        const item = this.itemIndex.get(line.stockItemName);
        const tax = deriveIntraStateTax(item?.gstRate ?? null);

        return {
          ...common,
          'TCS Percentage': percentageOf(summary.tcsAmount, base),
          'TDS Percentage': percentageOf(summary.tdsAmount, base),
          'Item Name': line.stockItemName,
          SKU: item?.alias ?? '',
          'Item Desc': item?.description ?? '',
          'Item Type': 'goods',
          'HSN/SAC': item?.hsnCode ?? '',
          Quantity: line.quantity ?? '',
          'Usage unit': item?.baseUnit ?? '',
          'Item Price': line.rate ?? '',
          'Item Tax': tax.name,
          'Item Tax Type': tax.name ? TAX_TYPE_ITEM_AMOUNT : '',
          'Item Tax %': tax.rate,
        };
      });
    }

    // No inventory lines — a genuine, ledger-only Sales voucher (service
    // invoice). Emit exactly one row instead of silently dropping the whole
    // invoice — see bill.mapper.ts's doc comment for the live incident this
    // mirrors.
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
        'TDS Percentage': percentageOf(summary.tdsAmount, base),
        'Item Name': '',
        SKU: '',
        'Item Desc': '',
        'Item Type': 'service',
        'HSN/SAC': '',
        Quantity: '',
        'Usage unit': '',
        'Item Price': base || '',
        'Item Tax': taxName,
        'Item Tax Type': taxName ? TAX_TYPE_ITEM_AMOUNT : '',
        'Item Tax %': taxPercentage,
      },
    ];
  }
}
