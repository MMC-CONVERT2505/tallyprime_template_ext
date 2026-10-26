import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { findPartyEntries } from './bill-allocation.shared';
import { gstSplitFromPostedKind } from './gst-rate.shared';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { resolveGstTreatment } from './ledger-contact.shared';
import { LedgerIndex, resolveVoucherCurrency, tallyDateToJsDate } from './voucher-line.shared';
import { percentageOf, round2, summarizeLedgerEntries } from './voucher-tax.shared';

/**
 * Zoho Books "Expense" import columns — taken from the real template
 * (backend/src/mapping/templates/Expense.xlsx, sheet "Expense"). Added
 * 2026-10-21 — the exact complementary set to vendor-payment.mapper.ts: both
 * come from Tally's `Payment` voucher type, split by whether the party
 * ledger resolves to `Sundry Creditors` (VendorPaymentMapper) or not
 * (here) — see vendor-payment.mapper.ts's class doc comment for the full
 * reasoning and the user-confirmed classification rule.
 *
 * One row per voucher — a direct/ad-hoc expense payment has no inventory
 * lines and no formal bill to allocate against, so there's no per-line or
 * per-allocation branching the other voucher mappers need. Expense Account
 * AND Vendor both carry the SAME voucher.partyLedgerName value — Zoho
 * models these as two different concepts (the GL account the expense posts
 * to vs. an optional payee for tracking), but Tally's simpler model only
 * has the one ledger, and it genuinely IS both of those things here, so
 * both columns get it rather than arbitrarily picking one. Vendor Number
 * joins the same ledger via `ledgerIndex` (alterId, same caveat as every
 * other mapper). Paid Through is the bank/cash side
 * (LedgerTaxSummary.nonTaxLedgerName — the entry that isn't the party, same
 * reuse as customer-payment.mapper.ts's "Deposit To").
 *
 * Tax Name/Percentage/Type/CGST-SGST-IGST Rate %+amounts/Tax Amount — a
 * direct expense payment has no item line to look up a combined GST rate
 * from, so unlike invoice.mapper.ts/bill.mapper.ts's two-branch shape, this
 * ALWAYS uses the real posted ledger entry's own kind
 * (`gstSplitFromPostedKind` — ground truth, ignoring the placeOfSupply-vs-
 * home-state heuristic entirely, since there's no item-line branch here
 * that would need it). Expense Amount is the PARTY entry's own posted
 * amount (`findPartyEntries`, same pattern vendor-payment.mapper.ts's
 * "Amount" uses) — deliberately NOT
 * LedgerTaxSummary.nonTaxLedgerTotal/nonTaxLedgerName, which on this
 * voucher shape resolve to the bank/cash side instead (used below as Paid
 * Through): `voucher.partyLedgerName` here IS the expense ledger itself
 * (there's no separate customer/vendor control account the way Sales/
 * Purchase/Receipt/Payment-to-a-vendor vouchers have one), so
 * summarizeLedgerEntries' own "non-tax, non-party" bucket excludes exactly
 * the line this mapper actually wants as its base. Total adds the posted
 * GST back in (and should equal the bank/cash side's own amount — a
 * useful sanity check, not separately enforced here).
 *
 * Every mileage-related column/Vehicle Name/Claimant Email (Zoho's mileage-expense feature),
 * Customer Name/Number (Zoho's "bill this expense to a customer" feature),
 * HSN/SAC, Is Billable/Is Reimbursable, Entry Number, Location/Project
 * Name, Expense Reference ID/Recurrence Name/ExpenseReport Name, Reverse
 * Charge*, ITC Eligibility (no item master to check against), Cost Centre
 * all have no reliable Tally source on a bare Payment voucher and stay
 * blank — same "don't fabricate" standard as every other mapper here.
 */
export interface ZohoExpenseRow {
  'Expense Date': Date | '';
  'Expense Description': string;
  'Expense Account': string;
  'Expense Account Code': '';
  'Paid Through': string;
  'Paid Through Account Code': '';
  Vendor: string;
  'Vendor Number': number | '';
  'Location Name': '';
  'Project Name': '';
  'HSN/SAC': '';
  'GST Treatment': string;
  'Destination of Supply': '';
  'Source of Supply': '';
  'GST Identification Number (GSTIN)': string;
  'Entry Number': '';
  'Currency Code': string;
  'Exchange Rate': number;
  'Is Inclusive Tax': '';
  'Mileage Rate': '';
  'Mileage Unit': '';
  Distance: '';
  'Start Odometer Reading': '';
  'End Odometer Reading': '';
  'Mileage Type': '';
  'Vehicle Name': '';
  'Claimant Email': '';
  'Tax Name': string;
  'Tax Percentage': number | '';
  'Tax Type': string;
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
  'Item Exemption Code': '';
  'Tax Amount': number | '';
  'ITC Eligibility': '';
  'Expense Type': '';
  'Reverse Charge Tax Name': '';
  'Reverse Charge Tax Rate': '';
  'Reverse Charge Tax Type': '';
  'Expense Amount': number | '';
  Total: number | '';
  'Supply Type': '';
  'Reference#': string;
  'Is Billable': '';
  'Customer Name': '';
  'Customer Number': '';
  'Expense Reference ID': '';
  'Recurrence Name': '';
  'ExpenseReport Name': '';
  'Is Reimbursable': '';
  'Cost Centre': '';
}

const BLANK_FIELDS: Omit<
  ZohoExpenseRow,
  | 'Expense Date'
  | 'Expense Description'
  | 'Expense Account'
  | 'Paid Through'
  | 'Vendor'
  | 'Vendor Number'
  | 'GST Treatment'
  | 'GST Identification Number (GSTIN)'
  | 'Currency Code'
  | 'Exchange Rate'
  | 'Tax Name'
  | 'Tax Percentage'
  | 'Tax Type'
  | 'CGST Rate %'
  | 'SGST Rate %'
  | 'IGST Rate %'
  | 'CGST'
  | 'SGST'
  | 'IGST'
  | 'Tax Amount'
  | 'Expense Amount'
  | 'Total'
  | 'Reference#'
> = {
  'Expense Account Code': '',
  'Paid Through Account Code': '',
  'Location Name': '',
  'Project Name': '',
  'HSN/SAC': '',
  'Destination of Supply': '',
  'Source of Supply': '',
  'Entry Number': '',
  'Is Inclusive Tax': '',
  'Mileage Rate': '',
  'Mileage Unit': '',
  Distance: '',
  'Start Odometer Reading': '',
  'End Odometer Reading': '',
  'Mileage Type': '',
  'Vehicle Name': '',
  'Claimant Email': '',
  'CESS Rate %': '',
  'CGST(FCY)': '',
  'SGST(FCY)': '',
  'IGST(FCY)': '',
  'CESS(FCY)': '',
  CESS: '',
  'Item Exemption Code': '',
  'ITC Eligibility': '',
  'Expense Type': '',
  'Reverse Charge Tax Name': '',
  'Reverse Charge Tax Rate': '',
  'Reverse Charge Tax Type': '',
  'Supply Type': '',
  'Is Billable': '',
  'Customer Name': '',
  'Customer Number': '',
  'Expense Reference ID': '',
  'Recurrence Name': '',
  'ExpenseReport Name': '',
  'Is Reimbursable': '',
  'Cost Centre': '',
};

export class ExpenseMapper {
  constructor(
    private readonly ledgerIndex: LedgerIndex,
    private readonly hierarchy: GroupHierarchyResolver,
  ) {}

  /** The exact complementary set to VendorPaymentMapper.toVendorPaymentRows
   *  — see class doc comment. */
  toExpenseRows(vouchers: TallyVoucher[]): ZohoExpenseRow[] {
    return vouchers.filter((v) => !this.isVendorPayment(v)).map((v) => this.toExpenseRow(v));
  }

  private isVendorPayment(voucher: TallyVoucher): boolean {
    const ledger = voucher.partyLedgerName ? this.ledgerIndex.get(voucher.partyLedgerName) : undefined;
    return this.hierarchy.resolveToStandardGroup(ledger?.parent ?? null) === 'Sundry Creditors';
  }

  private toExpenseRow(voucher: TallyVoucher): ZohoExpenseRow {
    const summary = summarizeLedgerEntries(voucher.ledgerEntries, voucher.partyLedgerName);
    const currency = resolveVoucherCurrency(voucher);
    const ledger = voucher.partyLedgerName ? this.ledgerIndex.get(voucher.partyLedgerName) : undefined;

    // Unlike every other voucher mapper here, `voucher.partyLedgerName` on
    // an ad-hoc expense Payment IS the expense ledger itself (there's no
    // separate customer/vendor control account) — summarizeLedgerEntries'
    // own "non-tax, non-party" bucket therefore resolves to the bank/cash
    // side instead (used below as Paid Through), not the expense amount.
    // The real expense value is the party entry's own posted amount —
    // same findPartyEntries pattern vendor-payment.mapper.ts uses for its
    // "Amount".
    const partyEntries = findPartyEntries(voucher.ledgerEntries, voucher.partyLedgerName);
    const base = round2(
      partyEntries.reduce((sum, e) => sum + (e.amount !== null ? Math.abs(e.amount) : 0), 0),
    );
    const taxPercentage = percentageOf(summary.gstAmount ?? '', base);
    const taxName =
      summary.gstKind && taxPercentage !== '' ? `${summary.gstKind}${taxPercentage}` : '';
    const split = gstSplitFromPostedKind(summary.gstKind, summary.gstAmount, taxPercentage);
    const total = round2(base + (summary.gstAmount ?? 0));

    return {
      ...BLANK_FIELDS,
      'Expense Date': tallyDateToJsDate(voucher.date) ?? '',
      'Expense Description': voucher.narration ?? '',
      'Expense Account': voucher.partyLedgerName ?? '',
      'Paid Through': summary.nonTaxLedgerName,
      Vendor: voucher.partyLedgerName ?? '',
      'Vendor Number': ledger?.alterId ?? '',
      'GST Treatment': resolveGstTreatment(voucher.partyGstin, voucher.partyGstRegistrationType),
      'GST Identification Number (GSTIN)': voucher.partyGstin ?? '',
      'Currency Code': currency.currencyCode,
      'Exchange Rate': currency.exchangeRate,
      'Tax Name': taxName,
      'Tax Percentage': taxPercentage,
      'Tax Type': taxName ? 'ItemAmount' : '',
      'CGST Rate %': split.cgstRate,
      'SGST Rate %': split.sgstRate,
      'IGST Rate %': split.igstRate,
      CGST: split.cgstAmount,
      SGST: split.sgstAmount,
      IGST: split.igstAmount,
      'Tax Amount': summary.gstAmount ?? '',
      'Expense Amount': base || '',
      Total: total || '',
      'Reference#': voucher.reference ?? '',
    };
  }
}
