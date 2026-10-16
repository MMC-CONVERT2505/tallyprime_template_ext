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
 * Mirrors Zoho's own official Tally migration tool's ReferenceTypeValueHandler:
 * derived from the credit note's OWN GST Treatment (not a re-lookup of the
 * referenced invoice), cross-checked against GST law's return-filing
 * categories.
 *
 * business_gst/business_registered_composition -> "Registered" (a B2B sale
 * to another GST-registered party). business_sez -> SEZ With/Without
 * Payment, overseas -> Export With/Without Payment, deemed_export ->
 * "Deemed Export" — all keyed on whether any GST was actually posted on
 * this voucher (`hasGst`), matching Zoho's own handler exactly.
 *
 * business_none/consumer/tax_deductor (an unregistered or retail buyer) map
 * to "B2C Others" unconditionally here, NOT split against "B2C (Large)".
 * Zoho's own reference distinguishes the two by whether the sale is
 * inter-state AND exceeds a GST-return threshold (₹1,00,000 under current
 * GSTR-1 rules) — but that needs the seller's own home state, which this
 * project doesn't extract (Tally's live instance went unreachable mid-
 * verification before this specific piece could be confirmed against real
 * data, and it has zero real SEZ/overseas/B2C credit notes to check
 * against regardless). "B2C Others" is the correct, common-case bucket and
 * never wrong in a way that fabricates data; add the inter-state/threshold
 * split later if a company's real data ever needs it.
 */
function resolveReferenceInvoiceType(gstTreatment: string, hasGst: boolean): string {
  switch (gstTreatment) {
    case 'business_gst':
    case 'business_registered_composition':
      return 'Registered';
    case 'business_sez':
      return hasGst ? 'SEZ With Payment' : 'SEZ Without Payment';
    case 'overseas':
      return hasGst ? 'Export With Payment' : 'Export Without Payment';
    case 'deemed_export':
      return 'Deemed Export';
    default:
      return 'B2C Others';
  }
}

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
 * as Item.xlsx's SKU/Alias Name.
 *
 * Associated Invoice Date (added 2026-09-10) — a genuine cross-reference,
 * not a Tally field: looked up by "Associated Invoice Number" against a
 * `invoiceDatesByNumber` map built from the SAME company's separately-
 * extracted Invoice vouchers (see extractions.service.ts's `invoicesJobId`
 * plumbing) — real data this project already has elsewhere in the
 * pipeline, not a guess. Left blank when the number doesn't resolve to a
 * real invoice (e.g. the map wasn't supplied, or the reference is
 * freeform text rather than a real invoice number), never fabricated.
 *
 * Branch (added 2026-09-10) — voucher.gstRegistration, cross-referenced
 * against Zoho's own official Tally migration tool, then VERIFIED live
 * (see TallyVoucher.gstRegistration's doc comment).
 *
 * Reference Invoice Type (added 2026-09-10) — see
 * resolveReferenceInvoiceType's doc comment above.
 *
 * Item Type on the item-line branch (corrected 2026-09-10) previously
 * hardcoded 'goods'; now reads TallyStockItem.itemType (GSTTYPEOFSUPPLY) —
 * VERIFIED live that 28 of 35 real items are actually "Services".
 */
export interface ZohoCreditNoteRow {
  'Credit Note Number': string;
  'Credit Note Date': Date | '';
  'Associated Invoice Number': string;
  'Associated Invoice Date': Date | '';
  'Reference Invoice Type': string;
  'Reference#': string;
  'Customer Name': string;
  Branch: string;
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
  /**
   * `invoiceDatesByNumber` — optional Invoice-Number -> Invoice-Date lookup
   * built from a companion Invoice extraction (see extractions.service.ts).
   * Omitted (or a number with no entry) leaves "Associated Invoice Date"
   * blank rather than guessed — see the interface doc comment.
   */
  constructor(
    private readonly itemIndex: StockItemIndex,
    private readonly invoiceDatesByNumber?: ReadonlyMap<string, Date>,
  ) {}

  toCreditNoteRows(vouchers: TallyVoucher[]): ZohoCreditNoteRow[] {
    return vouchers.flatMap((voucher) => this.toCreditNoteRowsForVoucher(voucher));
  }

  private toCreditNoteRowsForVoucher(voucher: TallyVoucher): ZohoCreditNoteRow[] {
    const summary = summarizeLedgerEntries(voucher.ledgerEntries, voucher.partyLedgerName);
    const currency = resolveVoucherCurrency(voucher);
    const gstTreatment = resolveGstTreatment(voucher.partyGstin, voucher.partyGstRegistrationType);
    const associatedInvoiceNumber = voucher.reference ?? '';
    const associatedInvoiceDate: Date | '' =
      (associatedInvoiceNumber ? this.invoiceDatesByNumber?.get(associatedInvoiceNumber) : undefined) ??
      '';

    const common: Pick<
      ZohoCreditNoteRow,
      | 'Credit Note Number'
      | 'Credit Note Date'
      | 'Associated Invoice Number'
      | 'Associated Invoice Date'
      | 'Reference Invoice Type'
      | 'Reference#'
      | 'Customer Name'
      | 'Branch'
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
      'Associated Invoice Number': associatedInvoiceNumber,
      'Associated Invoice Date': associatedInvoiceDate,
      'Reference Invoice Type': resolveReferenceInvoiceType(
        gstTreatment,
        summary.gstAmount !== null,
      ),
      'Reference#': voucher.reference ?? '',
      'Customer Name': voucher.partyLedgerName ?? '',
      Branch: voucher.gstRegistration ?? '',
      'GST Treatment': gstTreatment,
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
          'Item Type': item?.itemType ?? 'goods',
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
