/**
 * Resolves TallyLedgerEntry.billAllocations (see its doc comment — best-effort,
 * added 2026-10-21, not yet live-verified) into one row per bill the payment/
 * credit actually applied against, for Customer_Payment.xlsx/Vendor_Payment.xlsx
 * (whose templates both have a repeating per-bill column group — InvoicePayment
 * ID/Amount Applied to Invoice/Invoice Payment Applied Date/Invoice Number or
 * PIPayment ID/Bill ID/Bill Amount/Bill Payment Applied Date/Bill Number —
 * clearly meant to repeat one application per row, the same "Zoho repeats the
 * header per line" convention Invoice.xlsx/Bill.xlsx already use for inventory
 * lines). An allocation with no `name` (Tally reports a bill-less/On-Account
 * allocation) is skipped — it settles nothing a Zoho row could name. Returns an
 * empty array when there are no usable allocations at all; callers emit exactly
 * one row with every resolved-allocation field blank in that case, matching
 * every other "no data, don't fabricate a row" convention in this project.
 */
export interface ResolvedBillAllocation {
  billNumber: string;
  appliedAmount: number | '';
  billDate: Date | '';
}

import { TallyLedgerEntry } from '../tally/interfaces/tally.interfaces';

/**
 * The party ledger's own entry on a Receipt/Payment voucher — the one entry
 * whose billAllocations actually describe which invoices/bills this payment
 * settles (every other entry on the voucher is the bank/cash/charges side,
 * which never carries bill allocations). Sums amounts across more than one
 * matching entry on the rare voucher that splits the party across several
 * lines, rather than assuming exactly one.
 */
export function findPartyEntries(
  entries: TallyLedgerEntry[],
  partyLedgerName: string | null,
): TallyLedgerEntry[] {
  if (!partyLedgerName) return [];
  return entries.filter((e) => e.ledgerName === partyLedgerName);
}

export function resolveBillAllocations(
  allocations: { name: string | null; amount: number | null }[],
  datesByNumber?: ReadonlyMap<string, Date>,
): ResolvedBillAllocation[] {
  return allocations
    .filter((a) => !!a.name)
    .map((a) => ({
      billNumber: a.name as string,
      appliedAmount: a.amount ?? '',
      billDate: datesByNumber?.get(a.name as string) ?? '',
    }));
}
