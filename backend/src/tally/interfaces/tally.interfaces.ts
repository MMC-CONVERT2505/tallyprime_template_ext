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
  /**
   * LEDGSTREGDETAILS.LIST -> GSTREGISTRATIONTYPE, read from the same entry
   * `gstin` resolves to (or, when no entry has a GSTIN at all, the last
   * entry that at least has a registration type) — added 2026-09-10, cross-
   * referenced against Zoho's own official Tally migration tool, then
   * VERIFIED live: real values "Regular" (616 ledgers)/"Unregistered/
   * Consumer" (470)/"Unknown" (32) across 1,409 real ledgers. Powers the
   * corrected resolveGstTreatment (see ledger-contact.shared.ts) — this
   * project previously inferred GST Treatment from GSTIN presence alone,
   * which silently mapped every "Unregistered/Consumer" ledger to Zoho's
   * "consumer" instead of the correct "business_none".
   */
  gstRegistrationType: string | null;
  /**
   * LEDGSTREGDETAILS.LIST -> PLACEOFSUPPLY, same source entry as gstin/
   * gstRegistrationType — added 2026-09-10, VERIFIED live: populated for
   * 1,048 of 1,409 real ledgers. Powers Customer.xlsx's "Place Of Contact"
   * and Vendor.xlsx's "Source Of Supply", both previously blank.
   */
  gstPlaceOfSupply: string | null;
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
  /**
   * Flat MAILINGNAME field — added 2026-09-10, cross-referenced against
   * Zoho's own official Tally migration tool (maps to Customer/Vendor
   * "Billing Attention"), then VERIFIED live: populated for 1,269 of 1,409
   * real ledgers, and genuinely differs from the ledger's own `name` in 4
   * real cases (not just a duplicate — real, independently-settable data).
   */
  mailingName: string | null;
  /**
   * Flat BILLCREDITPERIOD field on the LEDGER master itself — the party's
   * own *default* credit period, distinct from TallyLedgerEntry.
   * billCreditPeriodDays (a per-voucher override read from
   * BILLALLOCATIONS.LIST). Added 2026-09-10, cross-referenced against
   * Zoho's own official Tally migration tool (maps to Customer/Vendor
   * "Payment Terms"/"Payment Terms Label"), then VERIFIED live: a real,
   * correctly-named field (an earlier pass tried "CREDITPERIOD", which
   * truly doesn't exist) but sparse — only 1 of 1,409 real ledgers
   * ("Sachin") has it set, to "20". Kept as raw text rather than parsed to
   * a number here — see resolvePaymentTerms in ledger-contact.shared.ts,
   * which mirrors Zoho's own tool's "only process a ' Days' suffix, leave
   * anything else blank" handling.
   */
  creditPeriod: string | null;
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

/**
 * The remaining standard Tally master types beyond Ledger/Group/StockItem/
 * CostCentre — added 2026-09-19 for comprehensive extraction (every master
 * this project's TDL Collection mechanism can reach, not just the ones the
 * current 9 Zoho templates need). Field names for all of these were VERIFIED
 * live against COREDGE.IO INDIA PRIVATE LIMITED before being added — see
 * EnvelopeBuilder's corresponding build*Request doc comments.
 */
export interface TallyStockGroup {
  name: string;
  parent: string | null;
  alterId: number | null;
}

export interface TallyStockCategory {
  name: string;
  parent: string | null;
  alterId: number | null;
}

/** VERIFIED live: 7 real units on this company (Nos, Kg, Years, TB, ...). */
export interface TallyUnit {
  name: string;
  /** Tally's own display/report name — can differ from `name` (its internal
   *  symbol), e.g. NAME "TB" / ORIGINALNAME "TBRaw" confirmed live. */
  originalName: string | null;
  isSimpleUnit: boolean | null;
  decimalPlaces: number | null;
  alterId: number | null;
}

/** VERIFIED live: 3 real currencies configured on this company (INR, USD,
 *  UAE Dirham) — this company genuinely transacts in more than one currency,
 *  confirmed independently by TallyVoucher.currencyCode's own USD findings. */
export interface TallyCurrency {
  name: string;
  originalName: string | null;
  /** The real currency code/name Zoho's own tool reads this from — e.g. "USD",
   *  "INR" — despite the field name, this is NOT a stock-item-style symbol. */
  expandedSymbol: string | null;
  decimalPlaces: number | null;
  alterId: number | null;
}

/** VERIFIED live: 1 real Godown ("Main Location", the Tally-created default) —
 *  matches this project's existing finding that Godowns are unused by this
 *  company beyond the single default location. */
export interface TallyGodown {
  name: string;
  parent: string | null;
  alterId: number | null;
}

/** VERIFIED live: 1 real Cost Category ("Primary Cost Category", the
 *  Tally-created default) — this company's Cost Centres (already extracted
 *  via TallyCostCentre) all roll up to this one category. */
export interface TallyCostCategory {
  name: string;
  alterId: number | null;
}

/** VERIFIED live: 24 real Voucher Types configured on this company — every
 *  standard Tally type (Sales/Purchase/Payment/Receipt/Journal/Contra/Credit
 *  Note/Debit Note/Sales Order/Purchase Order/Stock Journal/Physical Stock/
 *  Delivery Note/Receipt Note/Rejections In-Out/Job Work In-Out Order/
 *  Material In-Out/Memorandum/Reversing Journal/Attendance/Payroll), no
 *  custom ones. This is the MASTER list (what's configured) — distinct from
 *  what actually appears in TallyVoucher.voucherType across real vouchers
 *  (what's actually used). */
export interface TallyVoucherType {
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
  /**
   * Flat GSTTYPEOFSUPPLY field — added 2026-09-10, cross-referenced against
   * Zoho's own official Tally migration tool (maps to Item.xlsx's "Product
   * Type"), then VERIFIED live: of 35 real stock items, 28 are "Services"
   * and only 6 are "Goods" (1 blank). This project previously hardcoded
   * every item's Item Type to 'goods' everywhere it's written (Item.xlsx
   * and every Invoice/Bill/Credit Note line item), which was wrong for the
   * majority of this company's real items.
   */
  itemType: 'goods' | 'service' | null;
  /**
   * Flat COSTINGMETHOD field — added 2026-09-12, cross-referenced against
   * Zoho's own official Tally migration tool (maps to Item.xlsx's
   * "Inventory Valuation Method"), then VERIFIED live: populated for all 35
   * real items ("Avg. Cost"). Passed through as Tally's own text, not
   * mapped to a guessed Zoho enum.
   */
  inventoryValuationMethod: string | null;
  /**
   * SALESLIST.LIST/PURCHASELIST.LIST -> first entry's LEDGERNAME — the
   * item's own default Sales/Purchase account allocation. Added 2026-09-12,
   * cross-referenced against Zoho's own official Tally migration tool (maps
   * to Item.xlsx's "Account"/"Purchase Account" — corrects an earlier mix-up
   * that attributed those blank columns to the unconfigured Price List
   * fields, STANDARDPRICELIST.LIST/STANDARDCOSTLIST.LIST, a different Tally
   * concept). VERIFIED live that these lists are real and correctly fetched
   * (no error) but empty for all 35 real items — this company has no
   * default Sales/Purchase ledger configured on any Stock Item. The
   * LEDGERNAME child-field read here follows the same convention already
   * independently verified for ACCOUNTINGALLOCATIONS.LIST elsewhere in this
   * project, not a confirmed example of this specific list populated.
   */
  salesAccount: string | null;
  purchaseAccount: string | null;
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
   * Flat GSTREGISTRATIONTYPE field — added 2026-09-10, cross-referenced
   * against Zoho's own official Tally migration tool (maps to Invoice/
   * Bill/Credit Note's "GST Treatment"), then VERIFIED live against 602
   * real sampled vouchers: "Regular" (334)/"Unregistered/Consumer" (113)/
   * blank (123)/"Unknown" (31). This project previously inferred GST
   * Treatment from partyGstin presence alone (see resolveGstTreatment in
   * ledger-contact.shared.ts), which silently mapped every "Unregistered/
   * Consumer" voucher to Zoho's "consumer" instead of "business_none".
   */
  partyGstRegistrationType: string | null;
  /**
   * Flat GSTREGISTRATION field (the GST registration/branch a voucher was
   * recorded against) — added 2026-09-10, cross-referenced against Zoho's
   * own official Tally migration tool (maps to "Branch"/"Branch Name"),
   * then VERIFIED live: populated on 601 of 602 sampled vouchers, always
   * "Uttar Pradesh Registration" for this company (its one GST
   * registration). Replaces the previously-tried DispatchFromName, which
   * this project's own docs already flag as always returning just the
   * company's legal name rather than a real branch.
   */
  gstRegistration: string | null;
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
