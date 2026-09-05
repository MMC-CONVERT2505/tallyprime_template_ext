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
  /**
   * Fields below power Customer.xlsx/Vendor.xlsx export (Sundry Debtors/
   * Creditors ledgers) and a fuller COA export — Tally doesn't expose these
   * on the cheap Name+AlterID pass, only on the full Lean Ledgers collection.
   * TDL field names (see EnvelopeBuilder.buildLedgersRequest) are VERIFIED
   * live (2026-08-22, COREDGE.IO INDIA PRIVATE LIMITED), not guessed — that
   * method's doc comment has the exact corrections made from the original
   * best-effort pass (gstin and bankName/bankAccountNumber both needed
   * fixing; everything else was already right).
   */
  gstin: string | null;
  panNumber: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  /** Mailing address lines, joined with '\n' — Tally reports this as a
   *  multi-line list, not a single field. */
  billingAddress: string | null;
  billingState: string | null;
  billingCountry: string | null;
  billingPincode: string | null;
  /**
   * A vendor's real payment bank details (used for NEFT/RTGS), sourced from
   * PAYMENTDETAILS.LIST — corrected 2026-09-05. An earlier pass claimed no
   * separate bank-name field existed in Tally at all; that was wrong — it
   * was true only of the legacy flat BANKDETAILS field (account number
   * only, no name), which this project also still reads as a fallback. See
   * EnvelopeBuilder.buildLedgersRequest's doc comment for the live evidence.
   */
  bankName: string | null;
  bankAccountNumber: string | null;
  /**
   * Website/CreditLimit/LedgerContact — added 2026-09-05, VERIFIED live
   * (COREDGE.IO INDIA PRIVATE LIMITED): real, flat native Ledger fields, all
   * genuinely populated for only 1 of 1409 real ledgers on this company (a
   * single fully-filled-out test customer) — sparse real data, not a wrong
   * field name (confirmed correct by that one match). Powers Customer.xlsx/
   * Vendor.xlsx's "Website" column (both templates), Customer.xlsx's
   * "Credit Limit" (Vendor.xlsx has no such column), and both templates'
   * "Conact Display Name" (LedgerContact is a single free-text name, not
   * split into First/Last — Tally doesn't structure it that way, so it's
   * written to Display Name only rather than guessing a split).
   */
  website: string | null;
  creditLimit: number | null;
  contactPersonName: string | null;
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

/** A Cost Centre is Tally's project/department/branch-style allocation tag —
 *  maps to Zoho Books' "Reporting Tag" (Master and Invoice or Bill/Class.xlsx). */
export interface TallyCostCentre {
  name: string;
  parent: string | null;
  alterId: number | null;
}

export interface TallyLedgerEntry {
  ledgerName: string;
  /**
   * Tally's raw amount. Its sign already encodes Dr/Cr, but the convention is
   * only reliable when read together with `isDeemedPositive`. Already
   * currency-converted to INR when the underlying entry was foreign — see
   * parseTallyForeignAmount's doc comment.
   */
  amount: number | null;
  isDeemedPositive: boolean | null;
  /** true = Debit, false = Credit, null = could not determine. */
  isDebit: boolean | null;
  /**
   * BILLALLOCATIONS.LIST -> BILLCREDITPERIOD (days), added 2026-09-05 — powers
   * Invoice.xlsx/Bill.xlsx's "Due Date" (voucher date + this many days). Real
   * Tally field, VERIFIED live to exist (82 real bill allocations read
   * against COREDGE.IO INDIA PRIVATE LIMITED), but empty for every one of
   * them — this company's "On Account" billing doesn't set an explicit
   * credit period, so Due Date stays blank for its data even though the
   * field/parsing is correct for a company that does set one.
   */
  billCreditPeriodDays: number | null;
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
  /** Alternate/short name, maps to Zoho Item.xlsx's "Alias Name" column. */
  alias: string | null;
  /**
   * HSN/GST fields powering Item.xlsx's tax columns. TDL field names (see
   * EnvelopeBuilder.buildStockItemsRequest) are VERIFIED live (2026-09-04,
   * COREDGE.IO INDIA PRIVATE LIMITED), not guessed — the original
   * best-effort flat HSNCODE/GSTRATE fields were WRONG (confirmed: they
   * returned nothing for every item in a live company, including items with
   * a real HSN/GST classification visible in Tally's own UI); both actually
   * live in repeating, date-effective lists (HSNDETAILS.LIST/
   * GSTDETAILS.LIST) — see TallyResponseParser.mapStockItems's
   * readLatestHsn/readLatestGstRate. `gstRate` is a single combined
   * percentage (e.g. 18); GST law guarantees the inter-state (IGST) rate
   * equals the intra-state (CGST+SGST) rate for the same HSN, so one field
   * covers both — confirmed both against the real Item.xlsx template's own
   * sample data (which pairs e.g. "GST18"/18/Group with "IGST18"/18/Group
   * for the same row) AND live (a real item carried CGST 9 + SGST/UTGST 9
   * alongside IGST 18).
   */
  hsnCode: string | null;
  gstRate: number | null;
  /**
   * Tally's own GSTDETAILS.LIST → TAXABILITY value ("Taxable"/"Exempt"/"Nil
   * Rated" — read from the same latest entry as gstRate/hsnCode). Added
   * 2026-09-05, VERIFIED live: of 35 real stock items, 8 were "Taxable" (a
   * gstRate too) and 10 were explicitly "Exempt" (correctly no rate) — the
   * remaining 17 have no GSTDETAILS.LIST at all (never GST-classified,
   * consistent with this company using Stock Items for internal cost
   * tracking on subscriptions/licenses, not physical GST-rated goods).
   * Powers Item.xlsx's Taxable/Taxability Type columns.
   */
  gstTaxability: string | null;
  /**
   * GSTDETAILS.LIST → GSTINELIGIBLEITC ("input tax credit ineligible" flag,
   * Yes/No) — added 2026-09-05 alongside gstTaxability, same source entry.
   * Powers Bill.xlsx's "ITC Eligibility" column (inverted: Tally flags
   * ITC-INeligible, Zoho asks for ITC-Eligible).
   */
  itcIneligible: boolean | null;
}

export interface TallyInventoryEntry {
  stockItemName: string;
  quantity: number | null;
  rate: number | null;
  /** Already currency-converted to INR when the underlying line was foreign
   *  — see parseTallyForeignAmount's doc comment. */
  amount: number | null;
  /**
   * Flat DISCOUNT field on ALLINVENTORYENTRIES.LIST — added 2026-09-05,
   * VERIFIED live: already arrives as part of the same list this project has
   * fetched all along (no new FETCH/NATIVEMETHOD needed), just never parsed.
   * Powers Invoice.xlsx/Credit Note.xlsx's "Discount"/"Entity Discount
   * Amount" and Bill.xlsx's discount-adjacent columns. A percentage, per
   * Tally's own convention for this field (0 when no discount applies).
   */
  discountPercent: number | null;
  /**
   * ACCOUNTINGALLOCATIONS.LIST -> LEDGERNAME (first/primary entry) — added
   * 2026-09-05, VERIFIED live: the actual Sales/Purchase/expense ledger this
   * inventory line posted against (e.g. "Subscription Fee of Testing
   * Tools"), nested one level inside the already-fetched inventory entry.
   * Powers Invoice.xlsx/Bill.xlsx/Credit Note.xlsx's "Account" column, which
   * previously had no Tally source at all.
   */
  accountLedgerName: string | null;
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
  /**
   * Power Invoice.xlsx/Bill.xlsx/Credit Note.xlsx's GST columns. Both are
   * flat scalar fields on the voucher (unlike the per-line GST detail this
   * project deliberately avoids parsing — see invoice.mapper.ts's doc
   * comment), so higher confidence than TallyLedger/TallyStockItem's
   * enrichment fields, but still unverified against a live Tally instance —
   * see EnvelopeBuilder.buildVouchersRequest's doc comment.
   */
  partyGstin: string | null;
  placeOfSupply: string | null;
  /**
   * Detected from the party ledger entry's own AMOUNT text — added
   * 2026-09-05 alongside parseTallyForeignAmount. Null (meaning "assume
   * INR") whenever that entry's amount carries no recognized foreign
   * currency symbol; VERIFIED live that ~5% of this company's real vouchers
   * genuinely are foreign-currency (USD). Powers Invoice.xlsx/Bill.xlsx/
   * Credit Note.xlsx's "Currency Code"/"Exchange Rate" columns, which were
   * previously always hardcoded to 'INR'/blank regardless of the voucher's
   * actual currency.
   */
  currencyCode: string | null;
  /** INR per 1 unit of currencyCode — null whenever currencyCode is null. */
  exchangeRate: number | null;
}

/** Envelope-level metadata Tally returns alongside data (line/error counts). */
export interface TallyResponseMeta {
  isEmpty: boolean;
  /** Raw <LINEERROR>/description text if Tally flagged an error. */
  error?: string;
}
