import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { deriveGstSplit, deriveIntraStateTax, gstSplitFromPostedKind } from './gst-rate.shared';
import { resolveGstTreatment } from './ledger-contact.shared';
import { resolveReferenceInvoiceType } from './credit-note.mapper';
import { LedgerIndex, resolveVoucherCurrency, StockItemIndex, tallyDateToJsDate } from './voucher-line.shared';
import {
  percentageOf,
  round2,
  summarizeLedgerEntries,
  TAX_TYPE_ITEM_AMOUNT,
} from './voucher-tax.shared';

/**
 * Zoho Books "Vendor Credit" import columns — taken from the real template
 * (backend/src/mapping/templates/Vendor_Credits.xlsx, sheet
 * "Vendor_Credits"). Added 2026-10-21, the first mapper for Tally's `Debit
 * Note` voucher type (already fetched/cached under VOUCHERS:Debit Note by
 * every full sync, never mapped until now) — the purchase-side mirror of
 * credit-note.mapper.ts (a Credit Note is a sales return; a Debit Note is a
 * purchase return/vendor credit), same row shape: one row per inventory
 * line, PLUS a ledger-only Debit Note still gets exactly one row instead of
 * being dropped (same fix as every other voucher mapper in this project).
 *
 * Unlike credit-note.mapper.ts, the item-line branch's GST split does NOT
 * use the placeOfSupply-vs-home-state heuristic — this is the PURCHASE
 * direction, and bill.mapper.ts's class doc comment explains why that
 * heuristic stays SALES-only (never reasoned about or verified for
 * purchases). `deriveGstSplit(gstRate, null, null, amount)` forces the
 * intra-state (CGST/SGST) split unconditionally, same conservative choice
 * bill.mapper.ts makes. The ledger-only branch uses the real posted ledger
 * entry's own kind (`gstSplitFromPostedKind`) — ground truth regardless of
 * direction — same two-branch shape as every other voucher mapper. Note
 * this template's tax columns are "CGST Amount"/"SGST Amount"/"IGST
 * Amount"/"CESS Amount" only — no separate Rate % columns exist here, unlike
 * Invoice.xlsx/Bill.xlsx/Credit Note.xlsx.
 *
 * Vendor Number (ledger.alterId) joined via `ledgerIndex`, same pattern/
 * caveat as every other mapper's identical field. "Associated Bill Number"
 * uses the SAME voucher.reference value as bill.mapper.ts's "Supplier
 * Invoice No" — deliberately NOT the new best-effort `billAllocations` field
 * (see bill-allocation.shared.ts's doc comment): this template has a single
 * column, not the repeating per-allocation group
 * customer-payment.mapper.ts/vendor-payment.mapper.ts's templates have, so
 * reusing the simpler, already-proven reference-string approach
 * credit-note.mapper.ts already uses is the lower-risk, more consistent
 * choice — not a guess, the same real field this project already trusts
 * elsewhere.
 *
 * TCS/TDS Name/Percentage/Amount — same summarizeLedgerEntries-derived
 * pattern as every other voucher mapper. Everything else (Entity
 * Type/Location ID/Vendor Credit Status/Vendor ID/Nature Of
 * Collection/Source-Destination of Supply/Is Inclusive
 * Tax/Account Code/Product ID/Line Item Location ID-Name/Is Tax Calculated
 * on Label Price/Tax1 ID/Item Non Advol Cess Amount/Item Exemption
 * Code/every Reverse Charge Tax column/Supply Type/Discount Type/Is
 * Discount Before Tax/Entity Discount Percent-Amount/Discount
 * Account(s)/Adjustment(s)/Project ID-Name/TDS Section Code-Section/TDS
 * Calculation Type/every Item TDS column/Cost Centre) has no Tally source
 * and stays blank, same standard as every other mapper in this project.
 */
export interface ZohoVendorCreditRow {
  'Vendor Credit Date': Date | '';
  'Vendor Credit ID': '';
  'Vendor Credit Number': string;
  'Entity Type': '';
  'Location ID': '';
  'Location Name': '';
  'Vendor Credit Status': '';
  'Vendor Name': string;
  'Vendor ID': '';
  'Vendor Number': number | '';
  'Associated Bill Number': string;
  'Reference Invoice Type': string;
  'Currency Code': string;
  'Exchange Rate': number;
  'TCS Amount': number | '';
  'TCS Tax Name': string;
  'TCS Percentage': number | '';
  'Nature Of Collection': '';
  'Source of Supply': '';
  'Destination of Supply': '';
  'GST Treatment': string;
  'GST Identification Number (GSTIN)': string;
  'Is Inclusive Tax': '';
  Account: string;
  'Account Code': '';
  'Item Name': string;
  'Product ID': '';
  'Item Desc': string;
  Quantity: number | '';
  'Usage unit': string;
  'Line Item Location ID': '';
  'Line Item Location Name': '';
  'Item Price': number | '';
  'HSN/SAC': string;
  'Is Tax Calculated on Label Price': '';
  'Tax1 ID': '';
  'Item Tax': string;
  'Item Tax %': number | '';
  'Item Tax Amount': number | '';
  'Item Tax Type': string;
  'Item Non Advol Cess Amount': '';
  'Item Exemption Code': '';
  'Item Type': string;
  'ITC Eligibility': string;
  'Reverse Charge Tax Name': '';
  'Reverse Charge Tax Rate': '';
  'Reverse Charge Tax Type': '';
  'Item Total': number | '';
  'Supply Type': '';
  SubTotal: number | '';
  'Discount Type': '';
  'Is Discount Before Tax': '';
  'Entity Discount Percent': '';
  'Entity Discount Amount': '';
  'Discount Account': '';
  'Discount Account Code': '';
  Total: number | '';
  Balance: number | '';
  Adjustment: '';
  'Adjustment Description': '';
  Notes: string;
  'Reference#': string;
  'Project ID': '';
  'Project Name': '';
  'TDS Name': string;
  'TDS Percentage': number | '';
  'TDS Section Code': '';
  'TDS Section': '';
  'TDS Amount': number | '';
  'TDS Calculation Type': '';
  'Item TDS Name': '';
  'Item TDS Percentage': '';
  'Item TDS Amount': '';
  'Item TDS Section Code': '';
  'Item TDS Section': '';
  'CGST Amount': number | '';
  'SGST Amount': number | '';
  'IGST Amount': number | '';
  'CESS Amount': '';
  'Cost Centre': '';
}

/** See bill.mapper.ts's identical helper's doc comment. */
function itcEligibilityLabel(itcIneligible: boolean | null | undefined): string {
  if (itcIneligible === null || itcIneligible === undefined) return '';
  return itcIneligible ? 'Ineligible' : 'Eligible';
}

const BLANK_FIELDS: Omit<
  ZohoVendorCreditRow,
  | 'Vendor Credit Date'
  | 'Vendor Credit Number'
  | 'Vendor Name'
  | 'Vendor Number'
  | 'Associated Bill Number'
  | 'Reference Invoice Type'
  | 'Currency Code'
  | 'Exchange Rate'
  | 'TCS Amount'
  | 'TCS Tax Name'
  | 'TCS Percentage'
  | 'GST Treatment'
  | 'GST Identification Number (GSTIN)'
  | 'Account'
  | 'Item Name'
  | 'Item Desc'
  | 'Quantity'
  | 'Usage unit'
  | 'Item Price'
  | 'HSN/SAC'
  | 'Item Tax'
  | 'Item Tax %'
  | 'Item Tax Amount'
  | 'Item Tax Type'
  | 'Item Type'
  | 'ITC Eligibility'
  | 'Item Total'
  | 'SubTotal'
  | 'Total'
  | 'Balance'
  | 'Notes'
  | 'Reference#'
  | 'TDS Name'
  | 'TDS Percentage'
  | 'TDS Amount'
  | 'CGST Amount'
  | 'SGST Amount'
  | 'IGST Amount'
> = {
  'Vendor Credit ID': '',
  'Entity Type': '',
  'Location ID': '',
  'Location Name': '',
  'Vendor Credit Status': '',
  'Vendor ID': '',
  'Nature Of Collection': '',
  'Source of Supply': '',
  'Destination of Supply': '',
  'Is Inclusive Tax': '',
  'Account Code': '',
  'Product ID': '',
  'Line Item Location ID': '',
  'Line Item Location Name': '',
  'Is Tax Calculated on Label Price': '',
  'Tax1 ID': '',
  'Item Non Advol Cess Amount': '',
  'Item Exemption Code': '',
  'Reverse Charge Tax Name': '',
  'Reverse Charge Tax Rate': '',
  'Reverse Charge Tax Type': '',
  'Supply Type': '',
  'Discount Type': '',
  'Is Discount Before Tax': '',
  'Entity Discount Percent': '',
  'Entity Discount Amount': '',
  'Discount Account': '',
  'Discount Account Code': '',
  Adjustment: '',
  'Adjustment Description': '',
  'Project ID': '',
  'Project Name': '',
  'TDS Section Code': '',
  'TDS Section': '',
  'TDS Calculation Type': '',
  'Item TDS Name': '',
  'Item TDS Percentage': '',
  'Item TDS Amount': '',
  'Item TDS Section Code': '',
  'Item TDS Section': '',
  'CESS Amount': '',
  'Cost Centre': '',
};

export class VendorCreditMapper {
  constructor(
    private readonly itemIndex: StockItemIndex,
    private readonly ledgerIndex: LedgerIndex,
  ) {}

  toVendorCreditRows(vouchers: TallyVoucher[]): ZohoVendorCreditRow[] {
    return vouchers.flatMap((voucher) => this.toVendorCreditRowsForVoucher(voucher));
  }

  private toVendorCreditRowsForVoucher(voucher: TallyVoucher): ZohoVendorCreditRow[] {
    const summary = summarizeLedgerEntries(voucher.ledgerEntries, voucher.partyLedgerName);
    const currency = resolveVoucherCurrency(voucher);
    const gstTreatment = resolveGstTreatment(voucher.partyGstin, voucher.partyGstRegistrationType);
    const ledger = voucher.partyLedgerName ? this.ledgerIndex.get(voucher.partyLedgerName) : undefined;

    const common: Omit<
      ZohoVendorCreditRow,
      | 'Account'
      | 'Item Name'
      | 'Item Desc'
      | 'Quantity'
      | 'Usage unit'
      | 'Item Price'
      | 'HSN/SAC'
      | 'Item Tax'
      | 'Item Tax %'
      | 'Item Tax Amount'
      | 'Item Tax Type'
      | 'Item Type'
      | 'ITC Eligibility'
      | 'Item Total'
      | 'SubTotal'
      | 'Total'
      | 'Balance'
      | 'TCS Percentage'
      | 'TDS Percentage'
      | 'CGST Amount'
      | 'SGST Amount'
      | 'IGST Amount'
    > = {
      ...BLANK_FIELDS,
      'Vendor Credit Date': tallyDateToJsDate(voucher.date) ?? '',
      'Vendor Credit Number': voucher.voucherNumber ?? '',
      'Vendor Name': voucher.partyLedgerName ?? '',
      'Vendor Number': ledger?.alterId ?? '',
      'Associated Bill Number': voucher.reference ?? '',
      'Reference Invoice Type': resolveReferenceInvoiceType(gstTreatment, summary.gstAmount !== null),
      'Currency Code': currency.currencyCode,
      'Exchange Rate': currency.exchangeRate,
      'TCS Amount': summary.tcsAmount,
      'TCS Tax Name': summary.tcsName,
      'GST Treatment': gstTreatment,
      'GST Identification Number (GSTIN)': voucher.partyGstin ?? '',
      Notes: voucher.narration ?? '',
      'Reference#': voucher.reference ?? '',
      'TDS Name': summary.tdsName,
      'TDS Amount': summary.tdsAmount,
    };

    if (voucher.inventoryEntries.length > 0) {
      const lines = voucher.inventoryEntries.map((line) => {
        const item = this.itemIndex.get(line.stockItemName);
        const gstRate = item?.gstRate ?? null;
        const lineAmount = line.amount ?? 0;
        const tax = deriveIntraStateTax(gstRate);
        // Conservative, intra-only — see class doc comment.
        const split = deriveGstSplit(gstRate, null, null, lineAmount);
        const taxAmount: number | '' = gstRate !== null ? round2((lineAmount * gstRate) / 100) : '';
        return { line, item, tax, split, taxAmount };
      });

      const base = round2(lines.reduce((sum, { line }) => sum + (line.amount ?? 0), 0));
      const taxTotal = round2(
        lines.reduce((sum, { taxAmount }) => sum + (taxAmount === '' ? 0 : taxAmount), 0),
      );
      const total = round2(base + taxTotal);

      return lines.map(({ line, item, tax, split, taxAmount }) => ({
        ...common,
        'TCS Percentage': percentageOf(summary.tcsAmount, base),
        'TDS Percentage': percentageOf(summary.tdsAmount, base),
        Account: line.accountLedgerName ?? '',
        'Item Name': line.stockItemName,
        'Item Desc': item?.description ?? '',
        'Item Type': item?.itemType ?? 'goods',
        'HSN/SAC': item?.hsnCode ?? '',
        Quantity: line.quantity ?? '',
        'Usage unit': this.usageUnit(item?.baseUnit ?? null),
        'Item Price': line.rate ?? '',
        'Item Total': line.amount ?? '',
        'Item Tax': tax.name,
        'Item Tax %': tax.rate,
        'Item Tax Amount': taxAmount,
        'Item Tax Type': tax.name ? TAX_TYPE_ITEM_AMOUNT : '',
        'ITC Eligibility': itcEligibilityLabel(item?.itcIneligible),
        SubTotal: base,
        Total: total,
        Balance: total,
        'CGST Amount': split.cgstAmount,
        'SGST Amount': split.sgstAmount,
        'IGST Amount': split.igstAmount,
      }));
    }

    // No inventory lines — a genuine, ledger-only Debit Note. Emit exactly
    // one row instead of silently dropping it — see bill.mapper.ts's doc
    // comment for the live incident this mirrors.
    if (voucher.ledgerEntries.length === 0) return [];

    const base = summary.nonTaxLedgerTotal;
    const taxAmount = summary.gstAmount ?? '';
    const taxPercentage = percentageOf(taxAmount, base);
    const taxName =
      summary.gstKind && taxPercentage !== '' ? `${summary.gstKind}${taxPercentage}` : '';
    const total = round2(base + (summary.gstAmount ?? 0));
    const split = gstSplitFromPostedKind(summary.gstKind, summary.gstAmount, taxPercentage);

    return [
      {
        ...common,
        'TCS Percentage': percentageOf(summary.tcsAmount, base),
        'TDS Percentage': percentageOf(summary.tdsAmount, base),
        Account: summary.nonTaxLedgerName,
        'Item Name': '',
        'Item Desc': '',
        'Item Type': 'service',
        'HSN/SAC': '',
        Quantity: '',
        'Usage unit': '',
        'Item Price': base || '',
        'Item Total': base || '',
        'Item Tax': taxName,
        'Item Tax %': taxPercentage,
        'Item Tax Amount': taxAmount,
        'Item Tax Type': taxName ? TAX_TYPE_ITEM_AMOUNT : '',
        'ITC Eligibility': '',
        SubTotal: base || '',
        Total: total,
        Balance: total,
        'CGST Amount': split.cgstAmount,
        'SGST Amount': split.sgstAmount,
        'IGST Amount': split.igstAmount,
      },
    ];
  }

  /** Tally's own sentinel for a stock item with no real unit of measure —
   *  see stock-item.mapper.ts's identical UNIT_NOT_APPLICABLE handling. */
  private usageUnit(baseUnit: string | null): string {
    return baseUnit && baseUnit.trim().toLowerCase() !== 'not applicable' ? baseUnit : '';
  }
}
