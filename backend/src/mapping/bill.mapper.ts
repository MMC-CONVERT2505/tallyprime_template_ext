import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { deriveGstSplit, deriveIntraStateTax, gstSplitFromPostedKind } from './gst-rate.shared';
import { resolveGstTreatment, resolvePaymentTerms } from './ledger-contact.shared';
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
 * Zoho Books "Bill" import columns — taken from the real template
 * (backend/src/mapping/templates/Bill.xlsx, sheet "Bill"), replaced
 * 2026-10-21 with a wider 104-column version of Zoho's own Bill bulk-import
 * format (the previous template had 60). Same row shape as before: one row
 * per Tally inventory line for an item-based Purchase voucher, PLUS a
 * Purchase voucher with NO inventory lines at all (a pure ledger/service
 * bill) still gets exactly one row — see this class's pre-2026-10-21 history
 * for the live incident that fix was for ("Bill records missing").
 *
 * Vendor Number (ledger.alterId, same caveat as every other *.mapper.ts's
 * identical field — an edit-revision counter, not a stable external id) and
 * Payment Terms/Payment Terms Label are new, joined via `ledgerIndex` (new
 * constructor dependency, same pattern as invoice.mapper.ts's 2026-10-20
 * pass) by voucher.partyLedgerName. Bill.xlsx's real template, unlike
 * Invoice.xlsx/Credit Note.xlsx, has no Billing/Shipping/Contact-block
 * columns at all — only Vendor Number/Payment Terms are added here.
 *
 * CGST Rate %/SGST Rate %/IGST Rate % (+ CGST/SGST/IGST amount columns) are
 * new. Unlike invoice.mapper.ts's identical-looking columns, the item-line
 * branch here deliberately does NOT attempt the placeOfSupply-vs-home-state
 * inter-state heustic: that heuristic was built and reasoned about for the
 * SALES direction (home state vs. the customer's place of supply); this
 * project has never examined whether the same signals mean the same thing
 * for a PURCHASE voucher (home state vs. the *vendor's* side), so guessing
 * here would be a new, unverified assumption rather than a reuse of a
 * verified one. `deriveGstSplit(gstRate, null, null, amount)` is called with
 * no placeOfSupply/homeState, which deterministically resolves to the
 * intra-state (CGST+SGST) split — the exact same "always intra" assumption
 * the old single "Tax Name" column already made unconditionally, just now
 * visible across 3 columns instead of implied by 1. The ledger-only branch
 * is different: a posted "Input IGST" (etc.) ledger entry is real ground
 * truth regardless of direction, so it uses the shared
 * `gstSplitFromPostedKind` exactly like invoice.mapper.ts's ledger-only
 * branch. CESS has no known Tally source and stays blank throughout.
 *
 * Discount/Discount Amount — Discount (TallyInventoryEntry.discountPercent)
 * is new; this template, unlike the old one, now has a per-line Discount
 * column. Discount Amount is left blank rather than back-computed, same
 * "don't fabricate arithmetic nothing here confirms" rule as
 * invoice.mapper.ts's identical column.
 *
 * PurchaseOrder / Purchase Order Number / Supplier Invoice No — all three
 * carry the SAME voucher.reference value. Tally's own Purchase-voucher UI
 * actually calls this field "Supplier Invoice No." (confirmed by its
 * standard field label), making that column the most accurate of the three;
 * "PurchaseOrder"/"Purchase Order Number" were this project's own earlier
 * best-effort guess (see this file's pre-2026-10-21 history) that the same
 * field doubles as a PO reference. Rather than pick one and silently drop
 * the others, all three are populated with the one real value this project
 * has — consistent with Invoice.xlsx's own PurchaseOrder/Buyer's Order No.
 * precedent (one real fact, multiple plausible Zoho column names).
 *
 * "Amount" (new) carries the same value as "Item Total"/SubTotal on each
 * row respectively — another same-fact-under-two-names column, not a
 * distinct concept this project has evidence for.
 *
 * Everything else new (Entity Discount Percent/Amount, Submitted/Approved
 * By/Date, Bill Status, Is Billable, Reference Invoice Type, Source/
 * Destination of Supply, TDS Calculation Type/TaxID/Section Code/Section,
 * Nature Of Collection, Discount Type, Is Discount Before Tax, Item
 * TDS/Exemption Code, Reverse Charge Tax*, Supply Type, Discount
 * Account(s), Is Landed Cost, Customer Name, Project Name, Cost Centre,
 * Location/Branch ID, Product ID, Account Code) has no Tally source this
 * project extracts and stays blank — in particular "Customer Name"/"Is
 * Billable" (Zoho's "re-bill this expense to a customer" feature, which
 * Tally's own Purchase-voucher data model has no equivalent concept for) and
 * every Zoho-internal workflow/id column, matching every other mapper's
 * "don't guess a value with no real source" standard.
 */
export interface ZohoBillRow {
  'Bill Date': Date | '';
  'Due Date': Date | '';
  'Bill ID': '';
  'Vendor Name': string;
  'Vendor Number': number | '';
  'Entity Discount Percent': '';
  'Payment Terms': number | '';
  'Payment Terms Label': string;
  'Bill Number': string;
  PurchaseOrder: string;
  'Currency Code': string;
  'Exchange Rate': number;
  SubTotal: number | '';
  Total: number | '';
  Balance: number | '';
  TotalRetentionAmountFCY: '';
  TotalRetentionAmountBCY: '';
  'TCS Amount': number | '';
  'Vendor Notes': string;
  'Terms & Conditions': '';
  Adjustment: '';
  'Adjustment Description': '';
  'Branch ID': '';
  'Branch Name': string;
  'Location Name': '';
  'Is Inclusive Tax': '';
  'Submitted By': '';
  'Approved By': '';
  'Submitted Date': '';
  'Approved Date': '';
  'Bill Status': '';
  'Created By': '';
  'Product ID': '';
  'Item Name': string;
  Account: string;
  'Account Code': '';
  Description: string;
  Quantity: number | '';
  'Usage unit': string;
  'Tax Amount': number | '';
  'Item Total': number | '';
  'Is Billable': '';
  'Reference Invoice Type': '';
  'Source of Supply': '';
  'Destination of Supply': '';
  'GST Treatment': string;
  'GST Identification Number (GSTIN)': string;
  'TDS Calculation Type': '';
  'TDS TaxID': '';
  'TDS Name': string;
  'TDS Percentage': number | '';
  'TDS Section Code': '';
  'TDS Section': '';
  'TDS Amount': number | '';
  'TCS Tax Name': string;
  'TCS Percentage': number | '';
  'Nature Of Collection': '';
  'Line Item Location Name': '';
  Rate: number | '';
  'Discount Type': '';
  'Is Discount Before Tax': '';
  Discount: number | '';
  'Discount Amount': '';
  'HSN/SAC': string;
  'Purchase Order Number': string;
  'Tax ID': '';
  'Tax Name': string;
  'Tax Percentage': number | '';
  'Tax Type': string;
  'Item TDS Name': '';
  'Item TDS Percentage': '';
  'Item TDS Amount': '';
  'Item TDS Section Code': '';
  'Item TDS Section': '';
  'Item Exemption Code': '';
  'Item Type': string;
  'Reverse Charge Tax Name': '';
  'Reverse Charge Tax Rate': '';
  'Reverse Charge Tax Type': '';
  'Supply Type': '';
  'ITC Eligibility': string;
  'Entity Discount Amount': '';
  'Discount Account': '';
  'Discount Account Code': '';
  'Item Discount Account': '';
  'Item Discount Account Code': '';
  'Is Landed Cost': '';
  'Customer Name': '';
  'Project Name': '';
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
  'Cost Centre': '';
  Amount: number | '';
  'Supplier Invoice No': string;
}

/** See ZohoBillRow['ITC Eligibility']'s doc comment — plain English, not a
 *  guessed Zoho enum. Blank (not "Eligible") when Tally has no GST
 *  classification for the item at all, since "eligible" would be asserting
 *  a fact this project cannot actually confirm. */
function itcEligibilityLabel(itcIneligible: boolean | null | undefined): string {
  if (itcIneligible === null || itcIneligible === undefined) return '';
  return itcIneligible ? 'Ineligible' : 'Eligible';
}

/** Every column with no Tally source — see the interface doc comment above.
 *  Centralized exactly like invoice.mapper.ts's BLANK_FIELDS. */
const BLANK_FIELDS: Omit<
  ZohoBillRow,
  | 'Bill Date'
  | 'Due Date'
  | 'Vendor Name'
  | 'Vendor Number'
  | 'Payment Terms'
  | 'Payment Terms Label'
  | 'Bill Number'
  | 'PurchaseOrder'
  | 'Currency Code'
  | 'Exchange Rate'
  | 'SubTotal'
  | 'Total'
  | 'Balance'
  | 'TCS Amount'
  | 'Vendor Notes'
  | 'Branch Name'
  | 'Item Name'
  | 'Account'
  | 'Description'
  | 'Quantity'
  | 'Usage unit'
  | 'Tax Amount'
  | 'Item Total'
  | 'GST Treatment'
  | 'GST Identification Number (GSTIN)'
  | 'TDS Name'
  | 'TDS Percentage'
  | 'TDS Amount'
  | 'TCS Tax Name'
  | 'TCS Percentage'
  | 'Rate'
  | 'Discount'
  | 'HSN/SAC'
  | 'Purchase Order Number'
  | 'Tax Name'
  | 'Tax Percentage'
  | 'Tax Type'
  | 'Item Type'
  | 'ITC Eligibility'
  | 'CGST Rate %'
  | 'SGST Rate %'
  | 'IGST Rate %'
  | 'CGST'
  | 'SGST'
  | 'IGST'
  | 'Amount'
  | 'Supplier Invoice No'
> = {
  'Bill ID': '',
  'Entity Discount Percent': '',
  TotalRetentionAmountFCY: '',
  TotalRetentionAmountBCY: '',
  'Terms & Conditions': '',
  Adjustment: '',
  'Adjustment Description': '',
  'Branch ID': '',
  'Location Name': '',
  'Is Inclusive Tax': '',
  'Submitted By': '',
  'Approved By': '',
  'Submitted Date': '',
  'Approved Date': '',
  'Bill Status': '',
  'Created By': '',
  'Product ID': '',
  'Account Code': '',
  'Is Billable': '',
  'Reference Invoice Type': '',
  'Source of Supply': '',
  'Destination of Supply': '',
  'TDS Calculation Type': '',
  'TDS TaxID': '',
  'TDS Section Code': '',
  'TDS Section': '',
  'Nature Of Collection': '',
  'Line Item Location Name': '',
  'Discount Type': '',
  'Is Discount Before Tax': '',
  'Tax ID': '',
  'Item TDS Name': '',
  'Item TDS Percentage': '',
  'Item TDS Amount': '',
  'Item TDS Section Code': '',
  'Item TDS Section': '',
  'Item Exemption Code': '',
  'Reverse Charge Tax Name': '',
  'Reverse Charge Tax Rate': '',
  'Reverse Charge Tax Type': '',
  'Supply Type': '',
  'Discount Amount': '',
  'Entity Discount Amount': '',
  'Discount Account': '',
  'Discount Account Code': '',
  'Item Discount Account': '',
  'Item Discount Account Code': '',
  'Is Landed Cost': '',
  'Customer Name': '',
  'Project Name': '',
  'CESS Rate %': '',
  'CGST(FCY)': '',
  'SGST(FCY)': '',
  'IGST(FCY)': '',
  'CESS(FCY)': '',
  CESS: '',
  'Cost Centre': '',
};

export class BillMapper {
  constructor(
    private readonly itemIndex: StockItemIndex,
    private readonly ledgerIndex: LedgerIndex,
  ) {}

  toBillRows(vouchers: TallyVoucher[]): ZohoBillRow[] {
    return vouchers.flatMap((voucher) => this.toBillRowsForVoucher(voucher));
  }

  private toBillRowsForVoucher(voucher: TallyVoucher): ZohoBillRow[] {
    const summary = summarizeLedgerEntries(voucher.ledgerEntries, voucher.partyLedgerName);
    const currency = resolveVoucherCurrency(voucher);
    const ledger = voucher.partyLedgerName ? this.ledgerIndex.get(voucher.partyLedgerName) : undefined;
    const paymentTerms = resolvePaymentTerms(ledger?.creditPeriod ?? null);

    const common: Omit<
      ZohoBillRow,
      | 'Account'
      | 'Item Name'
      | 'Description'
      | 'Quantity'
      | 'Usage unit'
      | 'Tax Amount'
      | 'Item Total'
      | 'Rate'
      | 'Discount'
      | 'HSN/SAC'
      | 'Tax Name'
      | 'Tax Percentage'
      | 'Tax Type'
      | 'Item Type'
      | 'ITC Eligibility'
      | 'CGST Rate %'
      | 'SGST Rate %'
      | 'IGST Rate %'
      | 'CGST'
      | 'SGST'
      | 'IGST'
      | 'SubTotal'
      | 'Total'
      | 'Balance'
      | 'TDS Percentage'
      | 'TCS Percentage'
      | 'Amount'
    > = {
      ...BLANK_FIELDS,
      'Bill Date': tallyDateToJsDate(voucher.date) ?? '',
      'Due Date': addDaysToTallyDate(voucher.date, summary.partyBillCreditPeriodDays),
      'Vendor Name': voucher.partyLedgerName ?? '',
      'Vendor Number': ledger?.alterId ?? '',
      'Payment Terms': paymentTerms.days,
      'Payment Terms Label': paymentTerms.label,
      'Bill Number': voucher.voucherNumber ?? '',
      // See the class doc comment — the same real voucher.reference value
      // populates all 3 of these differently-named columns.
      PurchaseOrder: voucher.reference ?? '',
      'Purchase Order Number': voucher.reference ?? '',
      'Supplier Invoice No': voucher.reference ?? '',
      'Currency Code': currency.currencyCode,
      'Exchange Rate': currency.exchangeRate,
      'TCS Amount': summary.tcsAmount,
      'Vendor Notes': voucher.narration ?? '',
      'Branch Name': voucher.gstRegistration ?? '',
      'GST Treatment': resolveGstTreatment(voucher.partyGstin, voucher.partyGstRegistrationType),
      'GST Identification Number (GSTIN)': voucher.partyGstin ?? '',
      'TDS Name': summary.tdsName,
      'TDS Amount': summary.tdsAmount,
      'TCS Tax Name': summary.tcsName,
    };

    if (voucher.inventoryEntries.length > 0) {
      const lines = voucher.inventoryEntries.map((line) => {
        const item = this.itemIndex.get(line.stockItemName);
        const gstRate = item?.gstRate ?? null;
        const lineAmount = line.amount ?? 0;
        const tax = deriveIntraStateTax(gstRate);
        const taxAmount: number | '' = gstRate !== null ? round2((lineAmount * gstRate) / 100) : '';
        // No home-state signal attempted for a Purchase voucher — see the
        // class doc comment. This always resolves to the intra-state half
        // split, same assumption `tax`/`taxAmount` above already make.
        const split = deriveGstSplit(gstRate, null, null, lineAmount);
        return { line, item, tax, taxAmount, split };
      });

      const subTotal = round2(lines.reduce((sum, { line }) => sum + (line.amount ?? 0), 0));
      const taxTotal = round2(
        lines.reduce((sum, { taxAmount }) => sum + (taxAmount === '' ? 0 : taxAmount), 0),
      );
      const total = round2(subTotal + taxTotal);

      return lines.map(({ line, item, tax, taxAmount, split }) => ({
        ...common,
        Account: line.accountLedgerName ?? '',
        'Item Name': line.stockItemName,
        Description: item?.description ?? '',
        'Usage unit': this.usageUnit(item?.baseUnit ?? null),
        Quantity: line.quantity ?? '',
        Rate: line.rate ?? '',
        Discount: line.discountPercent ?? '',
        'Item Type': item?.itemType ?? 'goods',
        'Tax Name': tax.name,
        'Tax Percentage': tax.rate,
        'Tax Amount': taxAmount,
        'Tax Type': tax.name ? TAX_TYPE_ITEM_AMOUNT : '',
        'Item Total': line.amount ?? '',
        Amount: line.amount ?? '',
        SubTotal: subTotal,
        Total: total,
        Balance: total,
        'TDS Percentage': percentageOf(summary.tdsAmount, subTotal),
        'TCS Percentage': percentageOf(summary.tcsAmount, subTotal),
        'HSN/SAC': item?.hsnCode ?? '',
        'ITC Eligibility': itcEligibilityLabel(item?.itcIneligible),
        'CGST Rate %': split.cgstRate,
        'SGST Rate %': split.sgstRate,
        'IGST Rate %': split.igstRate,
        CGST: split.cgstAmount,
        SGST: split.sgstAmount,
        IGST: split.igstAmount,
      }));
    }

    // No inventory lines — a genuine, ledger-only Purchase voucher (service/
    // expense bill). Emit exactly one row instead of silently dropping the
    // whole bill: this is the actual fix for "Bill records missing".
    if (voucher.ledgerEntries.length === 0) return [];

    const subTotal = summary.nonTaxLedgerTotal;
    const taxAmount = summary.gstAmount ?? '';
    const taxPercentage = percentageOf(taxAmount, subTotal);
    const taxName =
      summary.gstKind && taxPercentage !== '' ? `${summary.gstKind}${taxPercentage}` : '';
    const total = round2(subTotal + (summary.gstAmount ?? 0));
    // Ground truth — see the class doc comment's reasoning for why this is
    // used here but not on the item-line branch above.
    const split = gstSplitFromPostedKind(summary.gstKind, summary.gstAmount, taxPercentage);

    return [
      {
        ...common,
        Account: summary.nonTaxLedgerName,
        'Item Name': '',
        Description: '',
        'Usage unit': '',
        Quantity: '',
        Rate: '',
        Discount: '',
        'Item Type': 'service',
        'Tax Name': taxName,
        'Tax Percentage': taxPercentage,
        'Tax Amount': taxAmount,
        'Tax Type': taxName ? TAX_TYPE_ITEM_AMOUNT : '',
        'Item Total': subTotal || '',
        Amount: subTotal || '',
        SubTotal: subTotal || '',
        Total: total,
        Balance: total,
        'TDS Percentage': percentageOf(summary.tdsAmount, subTotal),
        'TCS Percentage': percentageOf(summary.tcsAmount, subTotal),
        'HSN/SAC': '',
        // No item to look up for a service-only row — no Tally source.
        'ITC Eligibility': '',
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
