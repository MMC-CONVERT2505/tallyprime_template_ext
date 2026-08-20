# Tally → Zoho Books function mapping (extraction scope)

Source: `Tally to ZohoBooks Excel Mapping.xlsx` (project root — not yet committed to git). This is the authoritative list of what Phase 5–7 need to cover. Reproduced here in Markdown so it's greppable/diffable without opening Excel, and so it survives if that file moves.

**Scope reminder (decided, unchanged from architecture.md): this project extracts from Tally and produces a Zoho-Books-import-ready Excel file per function — it does not push into Zoho Books via API.** Each row below becomes its own extraction (and eventually its own output Excel/sheet), not one combined dump.

33 rows in the source doc (numbered 1–33; a `-` in either column means no direct counterpart — still needed for extraction context, just not a standalone Zoho import target on its own).

## Masters

| # | Tally | Zoho Books | Notes |
|---|---|---|---|
| 1 | Company setting | Organizations | |
| 2 | Ledgers | Chart of Accounts | |
| 3 | Ledgers | Bank Accounts | Same Tally source (Ledgers) as #2/#7/#8 — the *group* a ledger sits under determines which Zoho bucket it becomes. |
| 4 | Groups | – | No direct Zoho entity; needed to resolve ledger parent hierarchy (which Ledgers become Accounts vs Bank Accounts vs Customers vs Vendors). |
| 5 | Tax | Taxes / Tax Rates | |
| 6 | Currencies | Currencies | |
| 7 | Ledgers | Customers | |
| 8 | Ledgers | Vendors | |
| 9 | Stock Items | Items | Already built ([tally.service.ts](../src/tally/tally.service.ts) `getStockItems`). |
| 10 | Stock Groups | – | Context for Items. |
| 11 | Stock Categories | – | Context for Items. |
| 12 | Godowns | – | Context for Items (warehouse/location). |
| 13 | Cost Centres | Reporting Tag | |

## Transactions

| # | Tally | Zoho Books | Notes |
|---|---|---|---|
| 14 | Sales | Invoices | |
| 15 | Purchase | Bills | |
| 16 | Credit Note | Credit Notes | |
| 17 | Debit Note | Vendor Credits | |
| 18 | Receipt | Customer Payments | Same Tally voucher type (Receipt) as #22 — Zoho target depends on what the receipt is against. |
| 19 | Payment | Vendor Payments | Same Tally voucher type (Payment) as #21 — see above. |
| 20 | Journal | Journals | |
| 21 | Payment | Expenses | |
| 22 | Receipt | Deposit | |
| 23 | Contra | Transfer | |
| 24 | Stock Journal | Inventory Adjustment | |
| 25 | Physical Stock | – | Context/adjustment source, no standalone Zoho import. |
| 26 | Credit Note Allocation | – | Bill/invoice-application detail, not a standalone entity. |
| 27 | Debit Note Allocation | – | Same as above. |
| 28 | Journal Allocation | – | Same as above. |
| 29 | – | Estimates | No direct Tally source identified yet — needs investigation when this row comes up. |
| 30 | Sales Order | Sales Orders | |
| 31 | Purchase Order | Purchase Orders | |
| 32 | Delivery Note | Delivery Note | |
| 33 | Delivery Challan | Delivery Challan | |

## What this changes about Phase 5's plan

`architecture.md`'s Phase 5 previously listed a rough entity set inferred from the reference migration tool's `conf.properties`. This table supersedes that with the actual, authoritative scope. Same priority logic still applies — masters (#1–13) unlock everything downstream (a voucher can't be mapped correctly without knowing its ledger's group, its stock item's group, etc.), so they come first; among transactions, the ones with the most 1:1 mapping clarity (#14–20) are lower-risk than the ones sharing a single Tally voucher type across multiple Zoho targets (#18/#22 both from Receipt, #19/#21 both from Payment — those need the same kind of disambiguation logic the reference tool's Pre-Migration Checklist documents, e.g. "which ledger is this against" rules).

## Export status (which rows actually produce a downloadable file)

A row only gets a downloadable Zoho import file if a real Zoho template exists for it in the project root's `Master and Invoice or Bill/` folder — see `backend/src/mapping/zoho-entity.map.ts`, the single registry of entity → template file → sheet name. Of the 33 rows above, **9 have a template and are built end-to-end** (Tally fetch → mapper → real-template Excel download):

| # | Row | Zoho template | Mapper |
|---|---|---|---|
| 2/3 | Ledgers → Chart of Accounts | `COA.xlsx` | `LedgerMapper` |
| 7 | Ledgers → Customers | `Customer.xlsx` | `CustomerMapper` |
| 8 | Ledgers → Vendors | `Vendor.xlsx` | `VendorMapper` |
| 9 | Stock Items → Items | `Item.xlsx` | `StockItemMapper` |
| 13 | Cost Centres → Reporting Tag | `Class.xlsx` | `CostCentreMapper` |
| 14 | Sales → Invoices | `Invoice.xlsx` | `InvoiceMapper` |
| 15 | Purchase → Bills | `Bill.xlsx` | `BillMapper` |
| 16 | Credit Note → Credit Notes | `Credit Note.xlsx` | `CreditNoteMapper` |
| 24 | Stock Journal → Inventory Adjustment | `Stock Journal.xlsx` | `StockJournalMapper` |

Every other row (Tax, Currencies, Company/Organizations, Debit Note, Receipt, Payment, Journal, Contra, Sales/Purchase Order, Delivery Note/Challan, Estimates, and the context-only rows #4/#10-12/#25-28) has **no template file** — deliberately out of scope rather than guessed. Add one only once a real Zoho template for it exists to read the exact columns/sheet name from.

Within the 9 built entities, several fields are best-effort Tally TDL field names not yet verified against a live Tally instance (GSTIN, PAN, address, bank details, HSN/SAC, GST rate — see the `TODO verify against live Tally` comments in `backend/src/tally/xml/envelope.builder.ts` and the doc comments on `TallyLedger`/`TallyStockItem`/`TallyVoucher` in `backend/src/tally/interfaces/tally.interfaces.ts`). A wrong tag name means that field comes back blank, not a broken export — correcting it once Tally is reachable is a one-line fix per field, not a re-investigation.
