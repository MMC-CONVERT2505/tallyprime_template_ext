import { TallyVoucher } from '../tally/interfaces/tally.interfaces';
import { findPartyEntries, resolveBillAllocations } from './bill-allocation.shared';
import { resolveGstTreatment } from './ledger-contact.shared';
import { LedgerIndex, resolveVoucherCurrency, tallyDateToJsDate } from './voucher-line.shared';
import { round2, summarizeLedgerEntries } from './voucher-tax.shared';

/** Tally has no dedicated "bank charges" ledger pattern this project has
 *  previously verified — this is a reasonable best-effort name match
 *  (mirroring voucher-tax.shared.ts's ROUND_OFF_LEDGER_PATTERN convention),
 *  not independently confirmed against real data yet. */
const BANK_CHARGES_LEDGER_PATTERN = /bank\s*charges/i;

/**
 * Zoho Books "Customer Payment" import columns — taken from the real
 * template (backend/src/mapping/templates/Customer_Payment.xlsx, sheet
 * "Customer_Payment"). Added 2026-10-21, the first mapper for Tally's
 * `Receipt` voucher type (already fetched/cached under VOUCHERS:Receipt by
 * every full sync, never mapped until now).
 *
 * One row per bill the payment actually applied against (InvoicePayment
 * ID/Amount Applied to Invoice/Invoice Payment Applied Date/Invoice
 * Number/Invoice Date form one contiguous per-allocation group on the real
 * template — the same "Zoho repeats the header per line" convention
 * Invoice.xlsx/Bill.xlsx already use, just keyed on bill allocations instead
 * of inventory lines), sourced from the party ledger entry's own
 * `billAllocations` (see bill-allocation.shared.ts — best-effort, added
 * alongside this mapper, not yet live-verified: Tally's voucher-fetch HTTP
 * endpoint was stuck when this was built). A voucher with no resolvable
 * allocations (a pure "On Account" receipt, or the field simply came back
 * empty) still gets exactly one row, with every allocation column blank —
 * same "never silently drop a real payment" rule every voucher mapper here
 * follows. Invoice Date is the ORIGINAL invoice's own date (looked up by
 * bill number against an optional `invoiceDatesByNumber` map, same
 * mechanism credit-note.mapper.ts already uses for "Associated Invoice
 * Date"); Invoice Payment Applied Date is a different fact — when THIS
 * payment was recorded — and uses the Receipt voucher's own date, since
 * Tally doesn't separately timestamp each bill allocation.
 *
 * Amount is the party ledger entry's own posted amount (summed across any
 * voucher that genuinely splits the party across more than one line) — the
 * real total received, independent of how many bills it was later broken
 * down against. Deposit To is the bank/cash ledger
 * (LedgerTaxSummary.nonTaxLedgerName — reused as-is, since on a Receipt
 * voucher the bank/cash entry is exactly the "non-tax, non-party" entry that
 * helper already isolates). Bank Charges matches a ledger entry whose name
 * contains "bank charges" (best-effort, unverified pattern — see its own doc
 * comment). Withholding Tax Amount is TDS deducted by the customer when
 * paying (LedgerTaxSummary.tdsAmount — the real accounting meaning of
 * "withholding tax" on an Indian receipt).
 *
 * Customer Number joined via `ledgerIndex`, same pattern/caveat as every
 * other mapper's identical field. Mode/Payment Status/Tax Account/Tax
 * Name-Percentage-Type/CustomerID/Branch ID/Location Name/Created
 * Time/Payment Number Prefix-Suffix/Description of Supply/Place of
 * Supply(With State Code)/Deposit To Account Code/Unused Amount have no
 * reliable Tally source and stay blank — a bare Receipt voucher carries no
 * payment-mode/bank-reconciliation-status concept this project extracts.
 * The real template has a genuinely DUPLICATE "Payment Type" header
 * (confirmed by reading the file) — same non-issue as Credit Note.xlsx's
 * duplicate "Issued Date", see that file's doc comment.
 */
export interface ZohoCustomerPaymentRow {
  'Payment Number': string;
  'CustomerPayment ID': '';
  Mode: '';
  CustomerID: '';
  Description: string;
  'Exchange Rate': number;
  Amount: number | '';
  'Unused Amount': '';
  'Bank Charges': number | '';
  'Reference Number': string;
  'Currency Code': string;
  'Branch ID': '';
  'Payment Number Prefix': '';
  'Payment Number Suffix': '';
  'Customer Name': string;
  'Customer Number': number | '';
  'Place of Supply': string;
  'Place of Supply(With State Code)': '';
  'GST Treatment': string;
  'GST Identification Number (GSTIN)': string;
  'Description of Supply': '';
  'Tax Name': '';
  'Tax Percentage': '';
  'Tax Type': '';
  'Payment Type': '';
  'Location Name': '';
  Date: Date | '';
  'Created Time': '';
  'Deposit To': string;
  'Deposit To Account Code': '';
  'Tax Account': '';
  'Payment Status': '';
  'InvoicePayment ID': '';
  'Amount Applied to Invoice': number | '';
  'Invoice Payment Applied Date': Date | '';
  'Withholding Tax Amount': number | '';
  'Invoice Number': string;
  'Invoice Date': Date | '';
}

const BLANK_FIELDS: Omit<
  ZohoCustomerPaymentRow,
  | 'Payment Number'
  | 'Description'
  | 'Exchange Rate'
  | 'Amount'
  | 'Bank Charges'
  | 'Reference Number'
  | 'Currency Code'
  | 'Customer Name'
  | 'Customer Number'
  | 'Place of Supply'
  | 'GST Treatment'
  | 'GST Identification Number (GSTIN)'
  | 'Date'
  | 'Deposit To'
  | 'Withholding Tax Amount'
  | 'Amount Applied to Invoice'
  | 'Invoice Payment Applied Date'
  | 'Invoice Number'
  | 'Invoice Date'
> = {
  'CustomerPayment ID': '',
  Mode: '',
  CustomerID: '',
  'Unused Amount': '',
  'Branch ID': '',
  'Payment Number Prefix': '',
  'Payment Number Suffix': '',
  'Place of Supply(With State Code)': '',
  'Description of Supply': '',
  'Tax Name': '',
  'Tax Percentage': '',
  'Tax Type': '',
  'Payment Type': '',
  'Location Name': '',
  'Created Time': '',
  'Deposit To Account Code': '',
  'Tax Account': '',
  'Payment Status': '',
  'InvoicePayment ID': '',
};

export class CustomerPaymentMapper {
  constructor(
    private readonly ledgerIndex: LedgerIndex,
    private readonly invoiceDatesByNumber?: ReadonlyMap<string, Date>,
  ) {}

  toCustomerPaymentRows(vouchers: TallyVoucher[]): ZohoCustomerPaymentRow[] {
    return vouchers.flatMap((voucher) => this.toCustomerPaymentRowsForVoucher(voucher));
  }

  private toCustomerPaymentRowsForVoucher(voucher: TallyVoucher): ZohoCustomerPaymentRow[] {
    if (voucher.ledgerEntries.length === 0) return [];

    const summary = summarizeLedgerEntries(voucher.ledgerEntries, voucher.partyLedgerName);
    const currency = resolveVoucherCurrency(voucher);
    const ledger = voucher.partyLedgerName ? this.ledgerIndex.get(voucher.partyLedgerName) : undefined;
    const partyEntries = findPartyEntries(voucher.ledgerEntries, voucher.partyLedgerName);
    const amount = round2(
      partyEntries.reduce((sum, e) => sum + (e.amount !== null ? Math.abs(e.amount) : 0), 0),
    );
    const bankCharges = voucher.ledgerEntries.find((e) =>
      BANK_CHARGES_LEDGER_PATTERN.test(e.ledgerName),
    );

    const common: Omit<
      ZohoCustomerPaymentRow,
      'Amount Applied to Invoice' | 'Invoice Payment Applied Date' | 'Invoice Number' | 'Invoice Date'
    > = {
      ...BLANK_FIELDS,
      'Payment Number': voucher.voucherNumber ?? '',
      Description: voucher.narration ?? '',
      'Exchange Rate': currency.exchangeRate,
      Amount: amount || '',
      'Bank Charges': bankCharges?.amount !== undefined && bankCharges?.amount !== null
        ? Math.abs(bankCharges.amount)
        : '',
      'Reference Number': voucher.reference ?? '',
      'Currency Code': currency.currencyCode,
      'Customer Name': voucher.partyLedgerName ?? '',
      'Customer Number': ledger?.alterId ?? '',
      'Place of Supply': voucher.placeOfSupply ?? '',
      'GST Treatment': resolveGstTreatment(voucher.partyGstin, voucher.partyGstRegistrationType),
      'GST Identification Number (GSTIN)': voucher.partyGstin ?? '',
      Date: tallyDateToJsDate(voucher.date) ?? '',
      'Deposit To': summary.nonTaxLedgerName,
      'Withholding Tax Amount': summary.tdsAmount,
    };

    const allocations = resolveBillAllocations(
      partyEntries.flatMap((e) => e.billAllocations),
      this.invoiceDatesByNumber,
    );

    if (allocations.length === 0) {
      return [
        {
          ...common,
          'Amount Applied to Invoice': '',
          'Invoice Payment Applied Date': '',
          'Invoice Number': '',
          'Invoice Date': '',
        },
      ];
    }

    const appliedDate = tallyDateToJsDate(voucher.date) ?? '';
    return allocations.map((allocation) => ({
      ...common,
      'Amount Applied to Invoice': allocation.appliedAmount,
      'Invoice Payment Applied Date': appliedDate,
      'Invoice Number': allocation.billNumber,
      'Invoice Date': allocation.billDate,
    }));
  }
}
