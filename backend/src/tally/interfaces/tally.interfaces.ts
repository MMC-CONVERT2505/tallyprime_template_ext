/**
 * Normalized shapes returned by the mapping layer. These are deliberately clean
 * and predictable — the messy, unpredictable Tally XML never escapes the parser.
 */

export interface TallyCompany {
  name: string;
  /** Financial-year start, as reported by Tally (may be absent). */
  startingFrom?: string | null;
  /** Books begin date (may be absent). */
  booksFrom?: string | null;
  guid?: string | null;
}

export interface TallyLedger {
  name: string;
  parent: string | null;
  description: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  /** Incrementing id Tally bumps on every change — the key to incremental sync. */
  alterId: number | null;
  /**
   * Non-null for Tally's own system-computed ledgers (e.g. "Profit & Loss
   * A/c") — Tally's RESERVEDNAME attribute, empty/absent for every ordinary
   * user-created ledger. These aren't real transactional accounts; "Profit &
   * Loss A/c" is a live rollup of every income/expense voucher in the
   * company's history. Asking Tally for its *period-scoped* balance (even
   * alone, batch size 1) reliably wedges Tally's engine — confirmed live: a
   * single-ledger request for it never returned and left Tally spinning one
   * CPU core for 5+ minutes; the identical request for an ordinary ledger
   * returns in under 100ms. See MasterExtractionService.fetchLedgersBatched,
   * which excludes these from period-scoped batches entirely.
   */
  reservedName: string | null;
}

/** A Group is Tally's account-hierarchy node — never a Zoho entity on its own,
 *  but required to resolve which standard chart-of-accounts group a custom
 *  sub-group (e.g. "Employee", "Reimbursement Payable") ultimately rolls up
 *  to. See src/mapping/group-hierarchy.resolver.ts. */
export interface TallyGroup {
  name: string;
  parent: string | null;
  alterId: number | null;
}

export interface TallyLedgerEntry {
  ledgerName: string;
  /**
   * Tally's raw amount. Its sign already encodes Dr/Cr, but the convention is
   * only reliable when read together with `isDeemedPositive`.
   */
  amount: number | null;
  isDeemedPositive: boolean | null;
  /** true = Debit, false = Credit, null = could not determine. */
  isDebit: boolean | null;
}

export interface TallyStockItem {
  name: string;
  parent: string | null;
  description: string | null;
  baseUnit: string | null;
  /** Quantity, not currency — Tally reports this as "<qty> <unit>" (e.g. "100 Nos"). */
  openingBalance: number | null;
  openingValue: number | null;
  /** Quantity, not currency — see openingBalance. */
  closingBalance: number | null;
  closingValue: number | null;
  alterId: number | null;
}

export interface TallyInventoryEntry {
  stockItemName: string;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
}

export interface TallyVoucher {
  date: string | null;
  voucherType: string | null;
  voucherNumber: string | null;
  partyLedgerName: string | null;
  narration: string | null;
  reference: string | null;
  alterId: number | null;
  ledgerEntries: TallyLedgerEntry[];
  inventoryEntries: TallyInventoryEntry[];
}

/** Envelope-level metadata Tally returns alongside data (line/error counts). */
export interface TallyResponseMeta {
  isEmpty: boolean;
  /** Raw <LINEERROR>/description text if Tally flagged an error. */
  error?: string;
}
