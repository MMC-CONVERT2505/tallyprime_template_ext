import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { findPartyEntries, resolveBillAllocations } from './bill-allocation.shared';
import { resolveGstTreatment } from './ledger-contact.shared';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { LedgerIndex, resolveVoucherCurrency, tallyDateToJsDate } from './voucher-line.shared';
import { percentageOf, round2, summarizeLedgerEntries } from './voucher-tax.shared';

/**
 * Zoho Books "Vendor Payment" import columns — taken from the real template
 * (backend/src/mapping/templates/Vendor_Payment.xlsx, sheet
 * "Vendor_Payment"). Added 2026-10-21, for Tally's `Payment` voucher type —
 * SPLIT with expense.mapper.ts, since Tally has no separate voucher type
 * for "paying a registered vendor's bill" vs. "a direct/ad-hoc expense
 * payment" (both are just a `Payment` voucher). `toVendorPaymentRows` keeps
 * only the rows whose PARTY ledger (voucher.partyLedgerName — the ledger
 * being debited/reduced, NOT the bank/cash side) resolves, via the existing
 * `GroupHierarchyResolver`, to `Sundry Creditors` — a real registered
 * vendor account. expense.mapper.ts keeps the exact complementary set
 * (everything VendorPaymentMapper drops). User-confirmed classification
 * rule (2026-10-21).
 *
 * Bill ID/Bill Amount/Bill Payment Applied Date/Bill Date/Bill Number form
 * one row-per-bill-application group, same mechanism/caveats as
 * customer-payment.mapper.ts's identical Invoice-side group — see its doc
 * comment for the full reasoning (best-effort `billAllocations`, not yet
 * live-verified; Bill Date is the ORIGINAL bill's own date via
 * `invoiceDatesByNumber`-equivalent lookup, Bill Payment Applied Date is
 * this payment voucher's own date). "Bill ID" itself (a Zoho-internal id)
 * stays blank — only "Bill Number" carries the real value.
 *
 * Vendor Number joined via `ledgerIndex` (ledger.alterId, same caveat as
 * every other mapper). Vendor Bank Account Number/Vendor Bank Name/Vendor
 * Bank Code/EmailID come straight off the vendor's own TallyLedger fields
 * (already extracted — the Vendor.xlsx fix earlier this project). "Debit
 * A/c no" is the PAYING ledger's (the bank/cash side,
 * LedgerTaxSummary.nonTaxLedgerName) own bankAccountNumber, looked up again
 * in `ledgerIndex` — a real, derivable value (bank ledgers carry the same
 * TallyLedger bank fields vendors do), not a guess. TDSAmount/Withholding
 * Tax Amount/Withholding Tax Amount (BCY) all carry the SAME
 * LedgerTaxSummary.tdsAmount value under three column names — this
 * template's own convention, not a guess (this project tracks no separate
 * FCY/BCY distinction, so BCY = the same INR value).
 *
 * Mode/Payment Status/Payment Type/Branch ID/Location Name/Source-
 * Destination of Supply/Description of Supply/Tax Account/every
 * ReverseCharge Tax column/TDS Section Code-Section/TDS Account Name/Bank
 * Reference Number/PIPayment ID/Paid Through Account Code/Unused
 * Amount/Unused TDSAmount/Payment Number Prefix-Suffix have no reliable
 * Tally source and stay blank, same standard as every other mapper here.
 */
export interface ZohoVendorPaymentRow {
  'Payment Number': string;
  'Payment Number Prefix': '';
  'Payment Number Suffix': '';
  'VendorPayment ID': '';
  Mode: '';
  Description: string;
  'Exchange Rate': number;
  Amount: number | '';
  'Unused Amount': '';
  TDSAmount: number | '';
  'Unused TDSAmount': '';
  'Reference Number': string;
  'Currency Code': string;
  'Branch ID': '';
  'Payment Status': '';
  Date: Date | '';
  'Payment Type': '';
  'Location Name': '';
  'Vendor Name': string;
  'Vendor Number': number | '';
  'Debit A/c no': string;
  'Vendor Bank Account Number': string;
  'Vendor Bank Name': string;
  'Vendor Bank Code': string;
  'Source of Supply': '';
  'Destination of Supply': '';
  'GST Treatment': string;
  'GST Identification Number (GSTIN)': string;
  EmailID: string;
  'Description of Supply': '';
  'Paid Through': string;
  'Paid Through Account Code': '';
  'Tax Account': '';
  'ReverseCharge Tax Percentage': '';
  'ReverseCharge Tax Type': '';
  'Reverse Charge Tax Amount': '';
  'ReverseCharge Tax Name': '';
  'TDS Name': string;
  'TDS Percentage': number | '';
  'TDS Section Code': '';
  'TDS Section': '';
  'TDS Account Name': '';
  'Bank Reference Number': '';
  'PIPayment ID': '';
  'Bill ID': '';
  'Bill Amount': number | '';
  'Bill Payment Applied Date': Date | '';
  'Bill Date': Date | '';
  'Bill Number': string;
  'Withholding Tax Amount': number | '';
  'Withholding Tax Amount (BCY)': number | '';
}

const BLANK_FIELDS: Omit<
  ZohoVendorPaymentRow,
  | 'Payment Number'
  | 'Description'
  | 'Exchange Rate'
  | 'Amount'
  | 'TDSAmount'
  | 'Reference Number'
  | 'Currency Code'
  | 'Date'
  | 'Vendor Name'
  | 'Vendor Number'
  | 'Debit A/c no'
  | 'Vendor Bank Account Number'
  | 'Vendor Bank Name'
  | 'Vendor Bank Code'
  | 'GST Treatment'
  | 'GST Identification Number (GSTIN)'
  | 'EmailID'
  | 'Paid Through'
  | 'TDS Name'
  | 'TDS Percentage'
  | 'Bill Amount'
  | 'Bill Payment Applied Date'
  | 'Bill Date'
  | 'Bill Number'
  | 'Withholding Tax Amount'
  | 'Withholding Tax Amount (BCY)'
> = {
  'Payment Number Prefix': '',
  'Payment Number Suffix': '',
  'VendorPayment ID': '',
  Mode: '',
  'Unused Amount': '',
  'Unused TDSAmount': '',
  'Branch ID': '',
  'Payment Status': '',
  'Payment Type': '',
  'Location Name': '',
  'Source of Supply': '',
  'Destination of Supply': '',
  'Description of Supply': '',
  'Paid Through Account Code': '',
  'Tax Account': '',
  'ReverseCharge Tax Percentage': '',
  'ReverseCharge Tax Type': '',
  'Reverse Charge Tax Amount': '',
  'ReverseCharge Tax Name': '',
  'TDS Section Code': '',
  'TDS Section': '',
  'TDS Account Name': '',
  'Bank Reference Number': '',
  'PIPayment ID': '',
  'Bill ID': '',
};

export class VendorPaymentMapper {
  constructor(
    private readonly ledgerIndex: LedgerIndex,
    private readonly hierarchy: GroupHierarchyResolver,
    private readonly billDatesByNumber?: ReadonlyMap<string, Date>,
  ) {}

  /** Only Payment vouchers whose party resolves to Sundry Creditors — see
   *  class doc comment. The exact complementary set to expense.mapper.ts. */
  toVendorPaymentRows(vouchers: TallyVoucher[]): ZohoVendorPaymentRow[] {
    return vouchers
      .filter((v) => this.isVendorPayment(v))
      .flatMap((voucher) => this.toVendorPaymentRowsForVoucher(voucher));
  }

  private isVendorPayment(voucher: TallyVoucher): boolean {
    const ledger = voucher.partyLedgerName ? this.ledgerIndex.get(voucher.partyLedgerName) : undefined;
    return this.hierarchy.resolveToStandardGroup(ledger?.parent ?? null) === 'Sundry Creditors';
  }

  private toVendorPaymentRowsForVoucher(voucher: TallyVoucher): ZohoVendorPaymentRow[] {
    if (voucher.ledgerEntries.length === 0) return [];

    const summary = summarizeLedgerEntries(voucher.ledgerEntries, voucher.partyLedgerName);
    const currency = resolveVoucherCurrency(voucher);
    const ledger = voucher.partyLedgerName ? this.ledgerIndex.get(voucher.partyLedgerName) : undefined;
    const payingLedger = this.ledgerIndex.get(summary.nonTaxLedgerName);
    const partyEntries = findPartyEntries(voucher.ledgerEntries, voucher.partyLedgerName);
    const amount = round2(
      partyEntries.reduce((sum, e) => sum + (e.amount !== null ? Math.abs(e.amount) : 0), 0),
    );

    const common: Omit<
      ZohoVendorPaymentRow,
      'Bill Amount' | 'Bill Payment Applied Date' | 'Bill Date' | 'Bill Number'
    > = {
      ...BLANK_FIELDS,
      'Payment Number': voucher.voucherNumber ?? '',
      Description: voucher.narration ?? '',
      'Exchange Rate': currency.exchangeRate,
      Amount: amount || '',
      TDSAmount: summary.tdsAmount,
      'Reference Number': voucher.reference ?? '',
      'Currency Code': currency.currencyCode,
      Date: tallyDateToJsDate(voucher.date) ?? '',
      'Vendor Name': voucher.partyLedgerName ?? '',
      'Vendor Number': ledger?.alterId ?? '',
      'Debit A/c no': payingLedger?.bankAccountNumber ?? '',
      'Vendor Bank Account Number': ledger?.bankAccountNumber ?? '',
      'Vendor Bank Name': ledger?.bankName ?? '',
      'Vendor Bank Code': ledger?.ifscCode ?? '',
      'GST Treatment': resolveGstTreatment(voucher.partyGstin, voucher.partyGstRegistrationType),
      'GST Identification Number (GSTIN)': voucher.partyGstin ?? '',
      EmailID: ledger?.email ?? '',
      'Paid Through': summary.nonTaxLedgerName,
      'TDS Name': summary.tdsName,
      'TDS Percentage': percentageOf(summary.tdsAmount, amount),
      'Withholding Tax Amount': summary.tdsAmount,
      'Withholding Tax Amount (BCY)': summary.tdsAmount,
    };

    const allocations = resolveBillAllocations(
      partyEntries.flatMap((e) => e.billAllocations),
      this.billDatesByNumber,
    );

    if (allocations.length === 0) {
      return [
        {
          ...common,
          'Bill Amount': '',
          'Bill Payment Applied Date': '',
          'Bill Date': '',
          'Bill Number': '',
        },
      ];
    }

    const appliedDate = tallyDateToJsDate(voucher.date) ?? '';
    return allocations.map((allocation) => ({
      ...common,
      'Bill Amount': allocation.appliedAmount,
      'Bill Payment Applied Date': appliedDate,
      'Bill Date': allocation.billDate,
      'Bill Number': allocation.billNumber,
    }));
  }
}
