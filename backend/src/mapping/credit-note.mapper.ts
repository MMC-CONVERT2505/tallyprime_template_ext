import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { deriveGstSplit, deriveInterStateTax, deriveIntraStateTax, gstSplitFromPostedKind, resolveHomeState } from './gst-rate.shared';
import { resolveGstTreatment, splitBillingAddress } from './ledger-contact.shared';
import { LedgerIndex, resolveVoucherCurrency, StockItemIndex, tallyDateToJsDate } from './voucher-line.shared';
import {
  percentageOf,
  round2,
  summarizeLedgerEntries,
  TAX_TYPE_ITEM_AMOUNT,
} from './voucher-tax.shared';

/**
 * Mirrors Zoho's own official Tally migration tool's ReferenceTypeValueHandler
 * — see this function's call sites for the full reasoning (unchanged since
 * this was first written; promoted to an exported function 2026-10-21 so
 * vendor-credit.mapper.ts, the purchase-side mirror of this same concept,
 * can reuse the identical GST-treatment-based classification).
 */
export function resolveReferenceInvoiceType(gstTreatment: string, hasGst: boolean): string {
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
 * Zoho Books "Credit Note" import columns — taken from the real template
 * (backend/src/mapping/templates/Credit Note.xlsx, sheet "Credit Note"),
 * replaced 2026-10-21 with a much larger 143-column version (the previous
 * template had 60). Same row shape as before: one row per Tally inventory
 * line, PLUS a Credit Note with no inventory lines at all still gets
 * exactly one row (see this file's pre-2026-10-21 history).
 *
 * Customer Number/Billing/Shipping/Primary-Contact-equivalent block are new,
 * joined via a new `ledgerIndex` constructor dependency by
 * voucher.partyLedgerName — exactly the same join invoice.mapper.ts's
 * 2026-10-20 pass added, reused here since this template gained the
 * identical column set (column names differ slightly — "Billing Street 2"
 * with a space, no "Primary Contact" columns at all, so this template has
 * no EmailID/Mobile/Phone contact fields to populate). Shipping mirrors
 * Billing, same reasoning as invoice.mapper.ts. Billing City/Shipping City
 * stay blank — TallyLedger has no separate city field, same existing gap.
 *
 * CGST Rate %/SGST Rate %/IGST Rate % (+ amount columns) replace the old
 * single "Item Tax"/"Item Tax %" pair's always-intra-state simplification —
 * this template is on the SALES-return direction (a credit note against a
 * Sales invoice), the same direction invoice.mapper.ts's heuristic was
 * reasoned about and verified for, so the full `deriveGstSplit`/
 * `resolveHomeState` heuristic is reused here (NOT bill.mapper.ts's more
 * conservative intra-only approach — see its doc comment for why the
 * purchase direction is treated differently). The ledger-only branch uses
 * `gstSplitFromPostedKind` (ground truth from the posted entry's own kind),
 * same two-branch shape as invoice.mapper.ts.
 *
 * Round Off (new) — summary.roundOffAmount, same source as invoice.mapper.ts.
 * Account (new) — line.accountLedgerName / the ledger-only row's single
 * non-tax ledger name, same pattern as every other voucher mapper.
 *
 * Applied Invoice Number (new) carries the SAME voucher.reference value as
 * "Associated Invoice Number"/"Reference#" — this template, like
 * Invoice.xlsx's PurchaseOrder/Buyer's Order No., names the same real fact
 * under a third column. "Branch"/"Branch Name" (voucher.gstRegistration)
 * has NO destination in this new template at all — it dropped the old
 * "Branch" column entirely and only kept "Branch ID" (a Zoho-internal id,
 * not a GST registration label) — so that data point is simply not carried
 * forward here; forcing it into "Branch ID" would be a fabrication, not a
 * mapping.
 *
 * The template genuinely has a DUPLICATE "Issued Date" header (columns 2 and
 * 4, confirmed by reading the real file) — a quirk of Zoho's own raw export,
 * not a parsing issue here. ExcelGeneratorService.writeIntoTemplate matches
 * by header text into a Map, so only the LAST "Issued Date" column (4)
 * actually receives this mapper's one "Issued Date" value; column 2 stays
 * blank. Not worth special-casing — it doesn't lose data, it just leaves a
 * duplicate column visually empty.
 *
 * Reason/Discount Type/Sales person/Template Name/Supplier Org
 * block/E-WayBill block/Transporter/Shipping Party/Reverse Charge/Item
 * TDS/Shipping Charge block/Dispatch Doc No./Dispatched through/Destination
 * all have no Tally source and stay blank, same "don't fabricate" rule as
 * every other mapper — see invoice.mapper.ts's class doc comment for the
 * Supplier Org/payment-gateway-equivalent reasoning. "Reason" specifically:
 * Tally has no separate reason-code field for a Credit Note (Notes already
 * carries narration) — unchanged decision from this file's pre-2026-10-21
 * history.
 */
export interface ZohoCreditNoteRow {
  'Credit Note Date': Date | '';
  'Issued Date': Date | '';
  'Product ID': '';
  'CreditNotes ID': '';
  'Credit Note Number': string;
  'Credit Note Status': '';
  'Customer Name': string;
  'Customer Number': number | '';
  'Billing Attention': string;
  'Billing Address': string;
  'Billing Street 2': string;
  'Billing City': '';
  'Billing State': string;
  'Billing Country': string;
  'Billing Code': string;
  'Billing Phone': string;
  'Billing Fax': '';
  'Shipping Attention': string;
  'Shipping Address': string;
  'Shipping Street 2': string;
  'Shipping City': '';
  'Shipping State': string;
  'Shipping Country': string;
  'Shipping Phone': string;
  'Shipping Code': string;
  'Shipping Fax': '';
  'Is Export Without LUT/Bond': '';
  'Tax Collected From Customer': '';
  'Customer ID': '';
  'Currency Code': string;
  'Exchange Rate': number;
  'Is Inclusive Tax': '';
  Total: number | '';
  Balance: number | '';
  'Entity Discount Percent': '';
  Notes: string;
  'Terms & Conditions': '';
  'Reference#': string;
  'Shipping Charge': '';
  'Shipping Charge Tax ID': '';
  'Shipping Charge Tax Amount': '';
  'Shipping Charge SAC Code': '';
  'Shipping Charge Tax Name': '';
  'Shipping Charge Tax %': '';
  'Shipping Charge Tax Type': '';
  'Shipping Charge Tax Exemption Code': '';
  Adjustment: '';
  'Branch ID': '';
  'TCS Amount': number | '';
  'Associated Invoice Number': string;
  'Associated Invoice Date': Date | '';
  'TDS Amount': number | '';
  'TDS Name': string;
  'TDS Section Code': '';
  'TDS Section': '';
  'TDS Percentage': number | '';
  'E-WayBill Number': '';
  'E-WayBill Generated Time': '';
  'E-WayBill Status': '';
  'E-WayBill Cancelled Time': '';
  'E-WayBill Expired Time': '';
  'Transporter Name': '';
  'Transporter ID': '';
  'Shipping Party GSTIN': '';
  'Shipping Party Trader Name': '';
  'Shipping Party Legal Name': '';
  'Is Discount Before Tax': '';
  'Item Name': string;
  Discount: number | '';
  'Discount Amount': '';
  Quantity: number | '';
  'Item Desc': string;
  'Item Tax Amount': number | '';
  'Item Total': number | '';
  'Applied Invoice Number': string;
  'Location Name': '';
  'CGST Rate %': number | '';
  'SGST Rate %': number | '';
  'IGST Rate %': number | '';
  'CESS Rate %': '';
  'CGST(FCY)': '';
  'SGST(FCY)': '';
  'IGST(FCY)': '';
  'CESS(FCY)': '';
  CGST: number | '';
  SGST: number | '';
  IGST: number | '';
  CESS: '';
  Reason: '';
  'Project ID': '';
  'Project Name': '';
  'Supplier Org Name': '';
  'Supplier GST Registration Number': '';
  'Supplier Street Address': '';
  'Supplier City': '';
  'Supplier State': '';
  'Supplier Country': '';
  'Supplier ZipCode': '';
  'Supplier Phone': '';
  'Supplier E-Mail': '';
  'Supply Type': '';
  'Tax1 ID': '';
  'Item Tax': string;
  'Item Tax %': number | '';
  'Item Tax Type': string;
  'Reverse Charge Tax Name': '';
  'Reverse Charge Tax Rate': '';
  'Reverse Charge Tax Type': '';
  'Item TDS Name': '';
  'Item TDS Percentage': '';
  'Item TDS Amount': '';
  'Item TDS Section Code': '';
  'Item TDS Section': '';
  'Place of Supply(With State Code)': '';
  'GST Treatment': string;
  'GST Identification Number (GSTIN)': string;
  'TCS Tax Name': string;
  'TCS Percentage': number | '';
  'Nature Of Collection': '';
  'Sales person': '';
  'Discount Type': '';
  'Place of Supply': string;
  SubTotal: number | '';
  'Round Off': number;
  'Adjustment Description': '';
  Subject: '';
  'Reference Invoice Type': string;
  'Item Type': string;
  'Template Name': '';
  'Usage unit': string;
  'Item Price': number | '';
  'HSN/SAC': string;
  Account: string;
  'Account Code': '';
  'Item Tax Exemption Reason': '';
  'Entity Discount Amount': '';
  'Line Item Location Name': '';
  'Kit Combo Item Name': '';
  'Cost Centre': '';
  'Dispatch Doc No.': '';
  'Dispatched through': '';
  Destination: '';
}

const BLANK_FIELDS: Omit<
  ZohoCreditNoteRow,
  | 'Credit Note Date'
  | 'Issued Date'
  | 'Credit Note Number'
  | 'Customer Name'
  | 'Customer Number'
  | 'Billing Attention'
  | 'Billing Address'
  | 'Billing Street 2'
  | 'Billing State'
  | 'Billing Country'
  | 'Billing Code'
  | 'Billing Phone'
  | 'Shipping Attention'
  | 'Shipping Address'
  | 'Shipping Street 2'
  | 'Shipping State'
  | 'Shipping Country'
  | 'Shipping Phone'
  | 'Shipping Code'
  | 'Currency Code'
  | 'Exchange Rate'
  | 'Total'
  | 'Balance'
  | 'Notes'
  | 'Reference#'
  | 'TCS Amount'
  | 'Associated Invoice Number'
  | 'Associated Invoice Date'
  | 'TDS Amount'
  | 'TDS Name'
  | 'TDS Percentage'
  | 'Item Name'
  | 'Discount'
  | 'Quantity'
  | 'Item Desc'
  | 'Item Tax Amount'
  | 'Item Total'
  | 'Applied Invoice Number'
  | 'CGST Rate %'
  | 'SGST Rate %'
  | 'IGST Rate %'
  | 'CGST'
  | 'SGST'
  | 'IGST'
  | 'Item Tax'
  | 'Item Tax %'
  | 'Item Tax Type'
  | 'GST Treatment'
  | 'GST Identification Number (GSTIN)'
  | 'TCS Tax Name'
  | 'TCS Percentage'
  | 'Place of Supply'
  | 'SubTotal'
  | 'Round Off'
  | 'Reference Invoice Type'
  | 'Item Type'
  | 'Usage unit'
  | 'Item Price'
  | 'HSN/SAC'
  | 'Account'
> = {
  'Product ID': '',
  'CreditNotes ID': '',
  'Credit Note Status': '',
  'Billing City': '',
  'Billing Fax': '',
  'Shipping City': '',
  'Shipping Fax': '',
  'Is Export Without LUT/Bond': '',
  'Tax Collected From Customer': '',
  'Customer ID': '',
  'Is Inclusive Tax': '',
  'Entity Discount Percent': '',
  'Terms & Conditions': '',
  'Shipping Charge': '',
  'Shipping Charge Tax ID': '',
  'Shipping Charge Tax Amount': '',
  'Shipping Charge SAC Code': '',
  'Shipping Charge Tax Name': '',
  'Shipping Charge Tax %': '',
  'Shipping Charge Tax Type': '',
  'Shipping Charge Tax Exemption Code': '',
  Adjustment: '',
  'Branch ID': '',
  'TDS Section Code': '',
  'TDS Section': '',
  'E-WayBill Number': '',
  'E-WayBill Generated Time': '',
  'E-WayBill Status': '',
  'E-WayBill Cancelled Time': '',
  'E-WayBill Expired Time': '',
  'Transporter Name': '',
  'Transporter ID': '',
  'Shipping Party GSTIN': '',
  'Shipping Party Trader Name': '',
  'Shipping Party Legal Name': '',
  'Is Discount Before Tax': '',
  'Discount Amount': '',
  'Location Name': '',
  'CESS Rate %': '',
  'CGST(FCY)': '',
  'SGST(FCY)': '',
  'IGST(FCY)': '',
  'CESS(FCY)': '',
  CESS: '',
  Reason: '',
  'Project ID': '',
  'Project Name': '',
  'Supplier Org Name': '',
  'Supplier GST Registration Number': '',
  'Supplier Street Address': '',
  'Supplier City': '',
  'Supplier State': '',
  'Supplier Country': '',
  'Supplier ZipCode': '',
  'Supplier Phone': '',
  'Supplier E-Mail': '',
  'Supply Type': '',
  'Tax1 ID': '',
  'Reverse Charge Tax Name': '',
  'Reverse Charge Tax Rate': '',
  'Reverse Charge Tax Type': '',
  'Item TDS Name': '',
  'Item TDS Percentage': '',
  'Item TDS Amount': '',
  'Item TDS Section Code': '',
  'Item TDS Section': '',
  'Place of Supply(With State Code)': '',
  'Nature Of Collection': '',
  'Sales person': '',
  'Discount Type': '',
  'Adjustment Description': '',
  Subject: '',
  'Template Name': '',
  'Account Code': '',
  'Item Tax Exemption Reason': '',
  'Entity Discount Amount': '',
  'Line Item Location Name': '',
  'Kit Combo Item Name': '',
  'Cost Centre': '',
  'Dispatch Doc No.': '',
  'Dispatched through': '',
  Destination: '',
};

export class CreditNoteMapper {
  /**
   * `invoiceDatesByNumber` — optional Invoice-Number -> Invoice-Date lookup
   * built from a companion Invoice extraction (see extractions.service.ts).
   * `ledgerIndex` — see this file's class doc comment.
   */
  constructor(
    private readonly itemIndex: StockItemIndex,
    private readonly ledgerIndex: LedgerIndex,
    private readonly invoiceDatesByNumber?: ReadonlyMap<string, Date>,
  ) {}

  toCreditNoteRows(vouchers: TallyVoucher[]): ZohoCreditNoteRow[] {
    const homeState = resolveHomeState(vouchers);
    return vouchers.flatMap((voucher) => this.toCreditNoteRowsForVoucher(voucher, homeState));
  }

  private toCreditNoteRowsForVoucher(
    voucher: TallyVoucher,
    homeState: string | null,
  ): ZohoCreditNoteRow[] {
    const summary = summarizeLedgerEntries(voucher.ledgerEntries, voucher.partyLedgerName);
    const currency = resolveVoucherCurrency(voucher);
    const gstTreatment = resolveGstTreatment(voucher.partyGstin, voucher.partyGstRegistrationType);
    const associatedInvoiceNumber = voucher.reference ?? '';
    const associatedInvoiceDate: Date | '' =
      (associatedInvoiceNumber ? this.invoiceDatesByNumber?.get(associatedInvoiceNumber) : undefined) ??
      '';
    const ledger = voucher.partyLedgerName ? this.ledgerIndex.get(voucher.partyLedgerName) : undefined;
    const billingAddress = splitBillingAddress(ledger?.billingAddress ?? null);

    const contact = {
      'Billing Attention': ledger?.mailingName ?? '',
      'Billing Address': billingAddress.line1,
      'Billing Street 2': billingAddress.line2,
      'Billing City': '' as const,
      'Billing State': ledger?.billingState ?? '',
      'Billing Country': ledger?.billingCountry ?? '',
      'Billing Code': ledger?.billingPincode ?? '',
      'Billing Phone': ledger?.phone ?? '',
      'Billing Fax': '' as const,
    };
    // Shipping mirrors Billing — see class doc comment.
    const shipping = {
      'Shipping Attention': contact['Billing Attention'],
      'Shipping Address': contact['Billing Address'],
      'Shipping Street 2': contact['Billing Street 2'],
      'Shipping City': '' as const,
      'Shipping State': contact['Billing State'],
      'Shipping Country': contact['Billing Country'],
      'Shipping Phone': contact['Billing Phone'],
      'Shipping Code': contact['Billing Code'],
      'Shipping Fax': '' as const,
    };

    const common: Omit<
      ZohoCreditNoteRow,
      | 'Item Name'
      | 'Discount'
      | 'Quantity'
      | 'Item Desc'
      | 'Item Tax Amount'
      | 'Item Total'
      | 'CGST Rate %'
      | 'SGST Rate %'
      | 'IGST Rate %'
      | 'CGST'
      | 'SGST'
      | 'IGST'
      | 'Item Tax'
      | 'Item Tax %'
      | 'Item Tax Type'
      | 'Item Type'
      | 'Usage unit'
      | 'Item Price'
      | 'HSN/SAC'
      | 'Account'
      | 'TCS Percentage'
      | 'TDS Percentage'
      | 'SubTotal'
      | 'Total'
      | 'Balance'
    > = {
      ...BLANK_FIELDS,
      'Credit Note Date': tallyDateToJsDate(voucher.date) ?? '',
      'Issued Date': tallyDateToJsDate(voucher.date) ?? '',
      'Credit Note Number': voucher.voucherNumber ?? '',
      'Customer Name': voucher.partyLedgerName ?? '',
      'Customer Number': ledger?.alterId ?? '',
      ...contact,
      ...shipping,
      'Currency Code': currency.currencyCode,
      'Exchange Rate': currency.exchangeRate,
      Notes: voucher.narration ?? '',
      'Reference#': voucher.reference ?? '',
      'TCS Amount': summary.tcsAmount,
      'Associated Invoice Number': associatedInvoiceNumber,
      'Associated Invoice Date': associatedInvoiceDate,
      'TDS Amount': summary.tdsAmount,
      'TDS Name': summary.tdsName,
      'Applied Invoice Number': associatedInvoiceNumber,
      'GST Treatment': gstTreatment,
      'GST Identification Number (GSTIN)': voucher.partyGstin ?? '',
      'TCS Tax Name': summary.tcsName,
      'Place of Supply': voucher.placeOfSupply ?? '',
      'Round Off': summary.roundOffAmount,
      'Reference Invoice Type': resolveReferenceInvoiceType(gstTreatment, summary.gstAmount !== null),
    };

    if (voucher.inventoryEntries.length > 0) {
      const lines = voucher.inventoryEntries.map((line) => {
        const item = this.itemIndex.get(line.stockItemName);
        const gstRate = item?.gstRate ?? null;
        const lineAmount = line.amount ?? 0;
        const split = deriveGstSplit(gstRate, voucher.placeOfSupply, homeState, lineAmount);
        const combinedTax = split.isInterState
          ? deriveInterStateTax(gstRate)
          : deriveIntraStateTax(gstRate);
        const taxAmount: number | '' =
          combinedTax.rate !== '' ? round2((lineAmount * combinedTax.rate) / 100) : '';
        return { line, item, split, combinedTax, taxAmount };
      });

      const base = round2(lines.reduce((sum, { line }) => sum + (line.amount ?? 0), 0));
      const taxTotal = round2(
        lines.reduce((sum, { taxAmount }) => sum + (taxAmount === '' ? 0 : taxAmount), 0),
      );
      const total = round2(base + taxTotal);

      return lines.map(({ line, item, split, combinedTax, taxAmount }) => ({
        ...common,
        SubTotal: base,
        Total: total,
        Balance: total,
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
        Discount: line.discountPercent ?? '',
        'Item Total': line.amount ?? '',
        'Item Tax': combinedTax.name,
        'Item Tax %': combinedTax.rate,
        'Item Tax Amount': taxAmount,
        'Item Tax Type': combinedTax.name ? TAX_TYPE_ITEM_AMOUNT : '',
        'CGST Rate %': split.cgstRate,
        'SGST Rate %': split.sgstRate,
        'IGST Rate %': split.igstRate,
        CGST: split.cgstAmount,
        SGST: split.sgstAmount,
        IGST: split.igstAmount,
      }));
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
    const split = gstSplitFromPostedKind(summary.gstKind, summary.gstAmount, taxPercentage);
    const total = round2(base + (summary.gstAmount ?? 0));

    return [
      {
        ...common,
        SubTotal: base || '',
        Total: total,
        Balance: total,
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
        Discount: '',
        'Item Total': base || '',
        'Item Tax': taxName,
        'Item Tax %': taxPercentage,
        'Item Tax Amount': taxAmount,
        'Item Tax Type': taxName ? TAX_TYPE_ITEM_AMOUNT : '',
        'CGST Rate %': split.cgstRate,
        'SGST Rate %': split.sgstRate,
        'IGST Rate %': split.igstRate,
        CGST: split.cgstAmount,
        SGST: split.sgstAmount,
        IGST: split.igstAmount,
      },
    ];
  }

  /** Tally's own sentinel for a stock item with no real unit of measure —
   *  see stock-item.mapper.ts's identical UNIT_NOT_APPLICABLE handling. */
  private usageUnit(baseUnit: string | null): string {
    return baseUnit && baseUnit.trim().toLowerCase() !== 'not applicable' ? baseUnit : '';
  }
}
