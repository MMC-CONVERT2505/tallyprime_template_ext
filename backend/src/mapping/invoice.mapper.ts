import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import {
  deriveGstSplit,
  deriveIntraStateTax,
  deriveInterStateTax,
  gstSplitFromPostedKind,
  resolveHomeState,
} from './gst-rate.shared';
import { resolveGstTreatment, resolvePaymentTerms, splitBillingAddress } from './ledger-contact.shared';
import {
  addDaysToTallyDate,
  LedgerIndex,
  resolveVoucherCurrency,
  StockItemIndex,
  tallyDateToJsDate,
} from './voucher-line.shared';
import {
  percentageOf,
  round2,
  summarizeLedgerEntries,
  TAX_TYPE_ITEM_AMOUNT,
} from './voucher-tax.shared';

/**
 * Zoho Books "Invoice" import columns — taken from the real template
 * (Master and Invoice or Bill/Invoice.xlsx, sheet "Invoice"), replaced
 * 2026-10-20 with a much larger 185-column version of Zoho's own Invoice
 * bulk-import format (the previous template had 72). One output row per
 * Tally inventory line (Zoho's own flat-per-line convention), PLUS — see
 * bill.mapper.ts's doc comment for the live incident this mirrors — a Sales
 * voucher recorded with NO inventory lines at all (a pure ledger/service
 * invoice) still gets exactly one row instead of being silently dropped.
 * Invoice-level fields (TCS/TDS/Round Off/Billing details/...) repeat on
 * every line, same existing convention as TCS/TDS/Notes before this change.
 *
 * Only the subset of these 185 columns Tally can genuinely supply is
 * populated; everything else stays blank rather than guessed — in
 * particular every payment-gateway column (PayPal..GoCardless), e-way bill,
 * shipping-bill/export-compliance, Supplier Org (the seller's own address/
 * GSTIN — TallyCompany doesn't carry these today), Zoho-internal ids
 * (Invoice ID/Customer ID/Tax ID/...), and every enum-shaped column this
 * project has no independently-verified valid value for (Invoice Status,
 * Discount Type, Invoice Type, TDS Calculation Type, Supply Type, Is
 * Inclusive Tax, ...) — fabricating a plausible-looking enum value is worse
 * than leaving the cell blank, since Zoho may reject or silently
 * misinterpret an invalid one.
 *
 * Customer Number (ledger.alterId, same caveat as Customer.xlsx's identical
 * field — an edit-revision counter, not a stable external id), Payment
 * Terms/Payment Terms Label, and the full Billing/Shipping Attention/
 * Address/Street2/State/Country/Code/Phone + Primary Contact EmailID/
 * Mobile/Phone block are new in this pass: nothing on TallyVoucher itself
 * carries a customer's address/contact (only name/GSTIN/place-of-supply as
 * flat scalars), but the customer's own ledger record — already fetched for
 * Customer.xlsx — has it. `ledgerIndex` (new constructor dependency, built
 * the same way as the existing `itemIndex`) joins it in by
 * voucher.partyLedgerName. Shipping mirrors Billing — Tally doesn't track a
 * separate ship-to address this project extracts. Billing City/Shipping
 * City stay blank: TallyLedger has no separate city field, same existing
 * gap as Customer.xlsx/Vendor.xlsx's own identical columns.
 *
 * CGST Rate %/SGST Rate %/IGST Rate % (+ CGST/SGST/IGST amount columns)
 * replace the old single "Item Tax"/"Item Tax %" pair's always-intra-state
 * simplification — see deriveGstSplit's doc comment for the full reasoning
 * and its "best-effort, not independently verified live" caveat: correctly
 * telling intra- from inter-state needs the seller's own home state, which
 * this project doesn't extract from Tally at all, so `resolveHomeState`
 * below guesses it from the voucher batch itself (most common GST
 * Registration's state name, falling back to most common Place of Supply).
 * "Item Tax"/"Item Tax %"/"Item Tax Type"/"Item Tax Amount" (174-177) are
 * kept too, now driven by the SAME intra/inter determination instead of
 * being unconditionally intra-state — Zoho's generic single-tax-line
 * columns, alongside the detailed CGST/SGST/IGST breakdown rather than
 * contradicting it. CESS has no known Tally source (gstRate is one combined
 * number) and stays blank throughout.
 *
 * The home-state heuristic above only applies to the inventory-line branch,
 * which only ever has a single combined GST rate (the item master's
 * gstRate) to work with. A ledger-only (service) row is different: the
 * voucher's own posted GST ledger entry already says "IGST" or "CGST/SGST"
 * by name (LedgerTaxSummary.gstKind) — real data, not a guess — so that row
 * uses gstKind directly (see gstSplitFromPostedKind) instead of the
 * heuristic, even though both branches ultimately populate the same CGST/
 * SGST/IGST columns.
 *
 * Round Off (149) — a Round Off ledger entry was already pattern-matched
 * and excluded from the invoice's goods/expense base (see
 * voucher-tax.shared.ts), its own amount just discarded; now surfaced via
 * LedgerTaxSummary.roundOffAmount, repeating per line like every other
 * invoice-level field here.
 *
 * PurchaseOrder/Buyer's Order No. (16/184) both carry voucher.reference —
 * the same real fact (the customer's own order reference) under two column
 * names this consolidated template carries for format compatibility, not a
 * guess. Everything else ported from the old 72-column mapper (Invoice
 * Number/Date, Customer Name, GST Treatment, Due Date, Currency Code/
 * Exchange Rate, Account, Item Name/Desc/Type/Qty/Price/Discount, HSN/SAC,
 * Usage unit, TCS/TDS Name/Percentage/Amount, Notes, GSTIN) is unchanged in
 * meaning, just re-pointed at this template's (sometimes renamed) columns.
 * Item Total (72) and Discount Amount (71): Item Total is the line's own
 * already-known amount (line.amount — qty*rate less discount, Tally's own
 * final line value); Discount Amount is left blank rather than
 * back-computed from the Discount % and Item Total, since nothing here
 * independently confirms that arithmetic matches Zoho's own rounding.
 * SubTotal/Total/Balance/TotalRetentionAmount (FCY and BCY)/Adjustment
 * (31-35) are
 * deliberately NOT computed: correctly rolling up a multi-line invoice's
 * totals (handling tax, rounding, partial payments) across repeated rows is
 * a materially different, higher-risk undertaking than any single column
 * here — a wrong total imported into Zoho is worse than a blank one, so
 * this is left for a dedicated future pass rather than guessed now.
 */
export interface ZohoInvoiceRow {
  'Invoice Date': Date | '';
  'Invoice ID': '';
  'Invoice Number': string;
  'Issued Date': Date | '';
  'Invoice Status': '';
  'Customer ID': '';
  'Customer Name': string;
  'Customer Number': number | '';
  'Place of Supply': string;
  'Place of Supply(With State Code)': '';
  'GST Treatment': string;
  'Is Inclusive Tax': '';
  'Is Export Without LUT/Bond': '';
  'Tax Collected From Customer': '';
  'Due Date': Date | '';
  PurchaseOrder: string;
  'Currency Code': string;
  'Exchange Rate': number;
  'Discount Type': '';
  'Is Discount Before Tax': '';
  'Template Name': '';
  'Entity Discount Percent': number | '';
  'TCS Tax Name': string;
  'TCS Percentage': number | '';
  'TDS Calculation Type': '';
  'TDS Name': string;
  'TDS Percentage': number | '';
  'TDS Section Code': '';
  'TDS Section': '';
  'TDS Amount': number | '';
  SubTotal: number | '';
  Total: number | '';
  TotalRetentionAmountFCY: number | '';
  TotalRetentionAmountBCY: number | '';
  Balance: number | '';
  Adjustment: number | '';
  'Adjustment Description': '';
  'Expected Payment Date': Date | '';
  'Last Payment Date': Date | '';
  'Payment Terms': number | '';
  'Payment Terms Label': string;
  Notes: string;
  'Terms & Conditions': '';
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
  'TCS Amount': number | '';
  'Invoice Type': '';
  'Entity Discount Amount': number | '';
  'Location ID': '';
  'Location Name': '';
  'Shipping Charge': number | '';
  'Shipping Charge Tax ID': '';
  'Shipping Charge Tax Amount': number | '';
  'Shipping Charge SAC Code': '';
  'Shipping Charge Tax Name': '';
  'Shipping Charge Tax %': number | '';
  'Shipping Charge Tax Type': '';
  'Shipping Charge Tax Exemption Code': '';
  'Item Name': string;
  'Item Desc': string;
  Quantity: number | '';
  Discount: number | '';
  'Discount Amount': '';
  'Item Total': number | '';
  'Usage unit': string;
  'Item Price': number | '';
  'Product ID': '';
  Brand: '';
  'Sales Order Number': '';
  'Expense Reference ID': '';
  'Recurrence Name': '';
  PayPal: '';
  'Authorize.Net': '';
  'Google Checkout': '';
  'Payflow Pro': '';
  Stripe: '';
  Paytm: '';
  '2Checkout': '';
  Braintree: '';
  Forte: '';
  WorldPay: '';
  'Payments Pro': '';
  Square: '';
  WePay: '';
  Razorpay: '';
  'ICICI EazyPay': '';
  GoCardless: '';
  'Partial Payments': '';
  'Billing Attention': string;
  'Billing Address': string;
  'Billing Street2': string;
  'Billing City': '';
  'Billing State': string;
  'Billing Country': string;
  'Billing Code': string;
  'Billing Phone': string;
  'Billing Fax': '';
  'Shipping Attention': string;
  'Shipping Address': string;
  'Shipping Street2': string;
  'Shipping City': '';
  'Shipping State': string;
  'Shipping Country': string;
  'Shipping Code': string;
  'Shipping Fax': '';
  'Shipping Phone Number': string;
  'Supplier Org Name': '';
  'Supplier GST Registration Number': '';
  'Supplier Street Address': '';
  'Supplier City': '';
  'Supplier State': '';
  'Supplier Country': '';
  'Supplier ZipCode': '';
  'Supplier Phone': '';
  'Supplier E-Mail': '';
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
  'Reverse Charge Tax Name': '';
  'Reverse Charge Tax Rate': '';
  'Reverse Charge Tax Type': '';
  'Item TDS Name': '';
  'Item TDS Percentage': '';
  'Item TDS Amount': '';
  'Item TDS Section Code': '';
  'Item TDS Section': '';
  'GST Identification Number (GSTIN)': string;
  'Nature Of Collection': '';
  'Project ID': '';
  'Project Name': '';
  'HSN/SAC': string;
  'Round Off': number;
  'Sales person': '';
  Subject: '';
  'Primary Contact EmailID': string;
  'Primary Contact Mobile': string;
  'Primary Contact Phone': string;
  'Estimate Number': '';
  'Item Type': string;
  'Custom Charges': '';
  'Shipping Bill#': '';
  'Shipping Bill Date': '';
  'Shipping Bill Total': '';
  PortCode: '';
  'Reference Invoice#': '';
  'Reference Invoice Date': '';
  'Reference Invoice Type': '';
  'GST Registration Number(Reference Invoice)': '';
  'Reason for issuing Debit Note': '';
  'E-Commerce Operator Name': '';
  'E-Commerce Operator GSTIN': '';
  Account: string;
  'Account Code': '';
  'Line Item Location Name': '';
  'Supply Type': '';
  'Tax ID': '';
  'Item Tax': string;
  'Item Tax %': number | '';
  'Item Tax Amount': number | '';
  'Item Tax Type': string;
  'Item Tax Exemption Reason': '';
  'Kit Combo Item Name': '';
  'Cost Centre': '';
  'Delivery Note': '';
  'Delivery Note Date': '';
  'Dispatch Doc No.': '';
  "Buyer's Order No.": string;
  Destination: '';
}

/**
 * Every column this class never sets from real Tally data — see the
 * interface doc comment above for why each group is here. Centralized as
 * one constant (rather than repeated in both the per-line and service-row
 * branches below) so the "don't fabricate" list has exactly one place to
 * audit, and so TypeScript still enforces every one of ZohoInvoiceRow's 185
 * keys is actually written somewhere.
 */
const BLANK_FIELDS: Omit<
  ZohoInvoiceRow,
  | 'Invoice Number'
  | 'Invoice Date'
  | 'Customer Name'
  | 'Customer Number'
  | 'GST Treatment'
  | 'GST Identification Number (GSTIN)'
  | 'Place of Supply'
  | 'Due Date'
  | 'PurchaseOrder'
  | "Buyer's Order No."
  | 'Currency Code'
  | 'Exchange Rate'
  | 'Payment Terms'
  | 'Payment Terms Label'
  | 'Notes'
  | 'TCS Tax Name'
  | 'TCS Amount'
  | 'TDS Name'
  | 'TDS Amount'
  | 'Round Off'
  | 'Billing Attention'
  | 'Billing Address'
  | 'Billing Street2'
  | 'Billing City'
  | 'Billing State'
  | 'Billing Country'
  | 'Billing Code'
  | 'Billing Phone'
  | 'Billing Fax'
  | 'Shipping Attention'
  | 'Shipping Address'
  | 'Shipping Street2'
  | 'Shipping City'
  | 'Shipping State'
  | 'Shipping Country'
  | 'Shipping Code'
  | 'Shipping Fax'
  | 'Shipping Phone Number'
  | 'Primary Contact EmailID'
  | 'Primary Contact Mobile'
  | 'Primary Contact Phone'
  | 'TCS Percentage'
  | 'TDS Percentage'
  | 'Account'
  | 'Item Name'
  | 'Item Desc'
  | 'Item Type'
  | 'HSN/SAC'
  | 'Quantity'
  | 'Usage unit'
  | 'Item Price'
  | 'Discount'
  | 'Discount Amount'
  | 'Item Total'
  | 'CGST Rate %'
  | 'SGST Rate %'
  | 'IGST Rate %'
  | 'CGST'
  | 'SGST'
  | 'IGST'
  | 'Item Tax'
  | 'Item Tax %'
  | 'Item Tax Amount'
  | 'Item Tax Type'
> = {
  'Invoice ID': '',
  'Issued Date': '',
  'Invoice Status': '',
  'Customer ID': '',
  'Place of Supply(With State Code)': '',
  'Is Inclusive Tax': '',
  'Is Export Without LUT/Bond': '',
  'Tax Collected From Customer': '',
  'Discount Type': '',
  'Is Discount Before Tax': '',
  'Template Name': '',
  'Entity Discount Percent': '',
  'TDS Calculation Type': '',
  'TDS Section Code': '',
  'TDS Section': '',
  SubTotal: '',
  Total: '',
  TotalRetentionAmountFCY: '',
  TotalRetentionAmountBCY: '',
  Balance: '',
  Adjustment: '',
  'Adjustment Description': '',
  'Expected Payment Date': '',
  'Last Payment Date': '',
  'Terms & Conditions': '',
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
  'Invoice Type': '',
  'Entity Discount Amount': '',
  'Location ID': '',
  'Location Name': '',
  'Shipping Charge': '',
  'Shipping Charge Tax ID': '',
  'Shipping Charge Tax Amount': '',
  'Shipping Charge SAC Code': '',
  'Shipping Charge Tax Name': '',
  'Shipping Charge Tax %': '',
  'Shipping Charge Tax Type': '',
  'Shipping Charge Tax Exemption Code': '',
  'Product ID': '',
  Brand: '',
  'Sales Order Number': '',
  'Expense Reference ID': '',
  'Recurrence Name': '',
  PayPal: '',
  'Authorize.Net': '',
  'Google Checkout': '',
  'Payflow Pro': '',
  Stripe: '',
  Paytm: '',
  '2Checkout': '',
  Braintree: '',
  Forte: '',
  WorldPay: '',
  'Payments Pro': '',
  Square: '',
  WePay: '',
  Razorpay: '',
  'ICICI EazyPay': '',
  GoCardless: '',
  'Partial Payments': '',
  'Supplier Org Name': '',
  'Supplier GST Registration Number': '',
  'Supplier Street Address': '',
  'Supplier City': '',
  'Supplier State': '',
  'Supplier Country': '',
  'Supplier ZipCode': '',
  'Supplier Phone': '',
  'Supplier E-Mail': '',
  'CESS Rate %': '',
  'CGST(FCY)': '',
  'SGST(FCY)': '',
  'IGST(FCY)': '',
  'CESS(FCY)': '',
  CESS: '',
  'Reverse Charge Tax Name': '',
  'Reverse Charge Tax Rate': '',
  'Reverse Charge Tax Type': '',
  'Item TDS Name': '',
  'Item TDS Percentage': '',
  'Item TDS Amount': '',
  'Item TDS Section Code': '',
  'Item TDS Section': '',
  'Nature Of Collection': '',
  'Project ID': '',
  'Project Name': '',
  'Sales person': '',
  Subject: '',
  'Estimate Number': '',
  'Custom Charges': '',
  'Shipping Bill#': '',
  'Shipping Bill Date': '',
  'Shipping Bill Total': '',
  PortCode: '',
  'Reference Invoice#': '',
  'Reference Invoice Date': '',
  'Reference Invoice Type': '',
  'GST Registration Number(Reference Invoice)': '',
  'Reason for issuing Debit Note': '',
  'E-Commerce Operator Name': '',
  'E-Commerce Operator GSTIN': '',
  'Account Code': '',
  'Line Item Location Name': '',
  'Supply Type': '',
  'Tax ID': '',
  'Item Tax Exemption Reason': '',
  'Kit Combo Item Name': '',
  'Cost Centre': '',
  'Delivery Note': '',
  'Delivery Note Date': '',
  'Dispatch Doc No.': '',
  Destination: '',
};

export class InvoiceMapper {
  constructor(
    private readonly itemIndex: StockItemIndex,
    private readonly ledgerIndex: LedgerIndex,
  ) {}

  toInvoiceRows(vouchers: TallyVoucher[]): ZohoInvoiceRow[] {
    const homeState = resolveHomeState(vouchers);
    return vouchers.flatMap((voucher) => this.toInvoiceRowsForVoucher(voucher, homeState));
  }

  private toInvoiceRowsForVoucher(voucher: TallyVoucher, homeState: string | null): ZohoInvoiceRow[] {
    const summary = summarizeLedgerEntries(voucher.ledgerEntries, voucher.partyLedgerName);
    const currency = resolveVoucherCurrency(voucher);
    const ledger = voucher.partyLedgerName ? this.ledgerIndex.get(voucher.partyLedgerName) : undefined;
    const paymentTerms = resolvePaymentTerms(ledger?.creditPeriod ?? null);
    const billingAddress = splitBillingAddress(ledger?.billingAddress ?? null);

    const contact = {
      'Billing Attention': ledger?.mailingName ?? '',
      'Billing Address': billingAddress.line1,
      'Billing Street2': billingAddress.line2,
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
      'Shipping Street2': contact['Billing Street2'],
      'Shipping City': '' as const,
      'Shipping State': contact['Billing State'],
      'Shipping Country': contact['Billing Country'],
      'Shipping Code': contact['Billing Code'],
      'Shipping Fax': '' as const,
      'Shipping Phone Number': contact['Billing Phone'],
    };

    const common: Omit<
      ZohoInvoiceRow,
      | 'TCS Percentage'
      | 'TDS Percentage'
      | 'Account'
      | 'Item Name'
      | 'Item Desc'
      | 'Item Type'
      | 'HSN/SAC'
      | 'Quantity'
      | 'Usage unit'
      | 'Item Price'
      | 'Discount'
      | 'Discount Amount'
      | 'Item Total'
      | 'CGST Rate %'
      | 'SGST Rate %'
      | 'IGST Rate %'
      | 'CGST'
      | 'SGST'
      | 'IGST'
      | 'Item Tax'
      | 'Item Tax %'
      | 'Item Tax Amount'
      | 'Item Tax Type'
    > = {
      ...BLANK_FIELDS,
      'Invoice Number': voucher.voucherNumber ?? '',
      'Invoice Date': tallyDateToJsDate(voucher.date) ?? '',
      'Customer Name': voucher.partyLedgerName ?? '',
      'Customer Number': ledger?.alterId ?? '',
      'GST Treatment': resolveGstTreatment(voucher.partyGstin, voucher.partyGstRegistrationType),
      'GST Identification Number (GSTIN)': voucher.partyGstin ?? '',
      'Place of Supply': voucher.placeOfSupply ?? '',
      'Due Date': addDaysToTallyDate(voucher.date, summary.partyBillCreditPeriodDays),
      PurchaseOrder: voucher.reference ?? '',
      "Buyer's Order No.": voucher.reference ?? '',
      'Currency Code': currency.currencyCode,
      'Exchange Rate': currency.exchangeRate,
      'Payment Terms': paymentTerms.days,
      'Payment Terms Label': paymentTerms.label,
      Notes: voucher.narration ?? '',
      'TCS Tax Name': summary.tcsName,
      'TCS Amount': summary.tcsAmount,
      'TDS Name': summary.tdsName,
      'TDS Amount': summary.tdsAmount,
      'Round Off': summary.roundOffAmount,
      ...contact,
      ...shipping,
      'Primary Contact EmailID': ledger?.email ?? '',
      'Primary Contact Mobile': ledger?.mobile ?? '',
      'Primary Contact Phone': ledger?.phone ?? '',
    };

    if (voucher.inventoryEntries.length > 0) {
      // TCS/TDS percentages are computed against the invoice's total goods
      // value — the sum of its own inventory lines, same base used for the
      // service-row fallback below.
      const base = round2(voucher.inventoryEntries.reduce((sum, l) => sum + (l.amount ?? 0), 0));

      return voucher.inventoryEntries.map((line) => {
        const item = this.itemIndex.get(line.stockItemName);
        const gstRate = item?.gstRate ?? null;
        const lineAmount = line.amount ?? 0;
        const split = deriveGstSplit(gstRate, voucher.placeOfSupply, homeState, lineAmount);
        const combinedTax = split.isInterState ? deriveInterStateTax(gstRate) : deriveIntraStateTax(gstRate);

        return {
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
          Discount: line.discountPercent ?? '',
          'Discount Amount': '',
          'Item Total': line.amount ?? '',
          'CGST Rate %': split.cgstRate,
          'SGST Rate %': split.sgstRate,
          'IGST Rate %': split.igstRate,
          CGST: split.cgstAmount,
          SGST: split.sgstAmount,
          IGST: split.igstAmount,
          'Item Tax': combinedTax.name,
          'Item Tax %': combinedTax.rate,
          'Item Tax Amount':
            combinedTax.rate !== '' ? round2((lineAmount * combinedTax.rate) / 100) : '',
          'Item Tax Type': combinedTax.name ? TAX_TYPE_ITEM_AMOUNT : '',
        };
      });
    }

    // No inventory lines — a genuine, ledger-only Sales voucher (service
    // invoice). Emit exactly one row instead of silently dropping the whole
    // invoice — see bill.mapper.ts's doc comment for the live incident this
    // mirrors.
    if (voucher.ledgerEntries.length === 0) return [];

    const base = summary.nonTaxLedgerTotal;
    const taxPercentage = percentageOf(summary.gstAmount ?? '', base);
    // Unlike the inventory-line branch below (which only ever knows a single
    // combined GST rate off the item master, so has to guess intra- vs
    // inter-state from the home-state heuristic), a ledger-only row already
    // has the REAL posted ledger entry's own name — summary.gstKind directly
    // says "IGST" (inter-state) or "GST" (intra, CGST+SGST) from Tally's own
    // data, no guessing needed. Using the heuristic here instead would be
    // strictly worse information for the exact rows where the truth is
    // already in hand.
    const split = gstSplitFromPostedKind(summary.gstKind, summary.gstAmount, taxPercentage);
    const taxName =
      summary.gstKind && taxPercentage !== '' ? `${summary.gstKind}${taxPercentage}` : '';

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
        Discount: '',
        'Discount Amount': '',
        'Item Total': base || '',
        'CGST Rate %': split.cgstRate,
        'SGST Rate %': split.sgstRate,
        'IGST Rate %': split.igstRate,
        CGST: split.cgstAmount,
        SGST: split.sgstAmount,
        IGST: split.igstAmount,
        'Item Tax': taxName,
        'Item Tax %': taxPercentage,
        'Item Tax Amount': summary.gstAmount ?? '',
        'Item Tax Type': taxName ? TAX_TYPE_ITEM_AMOUNT : '',
      },
    ];
  }

  /** Tally's own sentinel for a stock item with no real unit of measure
   *  (service/subscription line items) — see stock-item.mapper.ts's
   *  identical UNIT_NOT_APPLICABLE handling. */
  private usageUnit(baseUnit: string | null): string {
    return baseUnit && baseUnit.trim().toLowerCase() !== 'not applicable' ? baseUnit : '';
  }

}
