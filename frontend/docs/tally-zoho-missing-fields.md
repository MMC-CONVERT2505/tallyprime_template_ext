# Zoho import template fields with no Tally source

Companion to [`tally-zoho-function-mapping.md`](./tally-zoho-function-mapping.md), one level more
granular: that doc tracks which of the 33 Tally→Zoho *rows* have a template and a mapper built;
this one tracks, **within** each of those 9 built templates, exactly which *columns* still come
back blank on a real export, and why.

**193 of 413 columns across the 9 templates are mapped from a genuine Tally field (verified live
against COREDGE.IO INDIA PRIVATE LIMITED — see `backend/src/mapping/*.mapper.ts` doc comments for
the exact TDL field names and verification dates). The 220 below are not.** Every one was checked
against live Tally data before being left blank — none are unexamined gaps, and none are guessed
or fabricated to fill the template.

**2026-09-12 update:** a much wider real dataset became available when Tally's connected session
picked up a broader "Current Period" (see `EnvelopeBuilder.buildVouchersRequest`'s doc comment on
why this project's live results are bounded by that session setting) — for the first time, this
company's real books actually contain Purchase vouchers (9) and Stock Journal vouchers (3, 41
inventory lines), both previously showing zero real rows in every earlier pass. Bill.xlsx's "moot
for this company" framing below is now corrected; Stock Journal.xlsx's already-mapped columns are
now confirmed against real data instead of only realistic fixtures. Three more genuine gaps were
also closed this pass (Item.xlsx's Account/Purchase Account/Inventory Valuation Method — see that
section), and two more candidates were investigated and confirmed to have no real source after
all (Customer/Vendor's Currency Code via `CURRENCYNAME`; Stock Journal's Cost Price via the
per-line RATE Zoho's own tool also relies on) — see each section below.

**2026-09-10 update:** the user supplied Zoho's own official Tally→Zoho Books migration tool
(`ZFMigrationTool-v1.9`, a Java batch tool bundled in `Zoho WorkDrive.zip`), whose config
(`conf/source_conf/tallyprime/xml_to_csv_config.yml`) is a complete field-by-field map of every
Tally XML tag that tool reads for every Zoho column. Cross-referencing that against this
project's own TDL requests — then live-verifying every candidate field against the running Tally
instance — surfaced two kinds of finding, closed in this pass:

- **Two correctness bugs** (a value was already being written, but the wrong one): GST Treatment
  was inferred from GSTIN presence alone, silently mapping every real "Unregistered/Consumer"
  ledger/voucher (470 of 1,409 ledgers; 113 of 602 sampled vouchers) to Zoho's `consumer` instead
  of the correct `business_none` — fixed by reading Tally's own `GSTREGISTRATIONTYPE` field
  (sitting right alongside the GSTIN this project already fetches) and applying Zoho's real
  enum table. Item Type was hardcoded `'goods'` everywhere, but 28 of 35 real stock items are
  actually "Services" (`GSTTYPEOFSUPPLY`) — fixed by reading the item master's real
  classification instead. See `ledger-contact.shared.ts`/`stock-item.mapper.ts` doc comments.
- **Five previously-missing fields, now proven real and wired up**: some earlier investigation
  passes checked the wrong field name (e.g. `CREDITPERIOD`, which really doesn't exist) rather
  than the correct one (`BILLCREDITPERIOD`) that Zoho's own tool uses — this was insufficient
  investigation, not a genuine gap. See each template's section below for the exact field and
  live-population evidence.

Everything else below remains checked-and-genuinely-absent, unaffected by this pass.

Each field is tagged with why it's blank:

- **`[no concept]`** — Tally has nothing resembling this at all (a Zoho SaaS/CRM/e-commerce idea).
- **`[not structured this way]`** — Tally has the underlying information, just not broken into
  this shape (e.g. one Name field instead of Salutation/First/Last).
- **`[unused by this company]`** — a real, correctly-named Tally field, confirmed live, that is
  genuinely empty (or the whole voucher type is unused) in this company's actual data. Populating
  it correctly for a company that *does* use the feature is a one-line change, not a re-investigation.

---

## COA.xlsx — 9 / 9 mapped

Nothing missing.

## Class.xlsx (Reporting Tag) — 2 / 2 mapped

Nothing missing.

---

## Customer.xlsx — 25 / 65 mapped

**No Tally concept** — Customer Number *(Zoho's own official migration tool confirms this too —
its `ContactNumberHandler` auto-generates a sequence number rather than reading anything from
Tally; the "no concept" call was correct)*, Customer Sub Type, Facebook, Twitter, Department,
Designation, Exemption Reason, Portal Status, Skype Identity, Owner Name, Bank Account Payment,
e-Invoice Registered Vendor, e-Invoice Registration Date *(Bank Account Payment is a Zoho
payment-preference default, distinct from the vendor-side Bank Name/Account Number this project
does map on Vendor.xlsx)*

**Not structured this way in Tally** — Salutation, First Name, Last Name *(one ledger Name field,
no person-name breakdown — "Contact First Name" below is a different column, the contact
*person's* name, not the customer's)*; Billing City, Billing Fax, Billing Phone *(Tally's mailing
address is free-text lines + State/Country/Pincode — no City/Fax/Phone sub-fields; confirmed
against Zoho's own migration tool too, which doesn't attempt these either)*; Shipping Attention,
Shipping Address, Shipping Street2, Shipping City, Shipping State, Shipping Country, Shipping
Code, Shipping Fax, Shipping Phone *(Tally ledgers have one mailing address; no separate ship-to)*;
Conact Salutation, Conact Last Name, Conact EmailID, Conact Phone, Conact MobilePhone, Conact
Skype, Conact Department, Conact Designation *(Tally's LEDGERCONTACT is one flat name string —
mapped to "Conact Display Name" and, since 2026-09-10, also "Contact First Name" as the whole
string, matching Zoho's own official migration tool's identical convention — not a structured
contact-person record, so no split into Salutation/Last Name/etc. is attempted)*

**Unused by this company** — Opening Balance Exchange Rate *(no per-ledger opening-balance
currency field found)*; TDS Name, TDS Section Code, TDS Percentage *(`ISTDSAPPLICABLE` is real and
confirmed live, but reads "No" on all 1,409 real ledgers — no company ledger has TDS configured)*

**Mapped 2026-09-10** (cross-referenced against Zoho's own official Tally migration tool, then
live-verified) — Place Of Contact *(`LEDGSTREGDETAILS.LIST` → `PLACEOFSUPPLY`, the same list this
project already fetches for GSTIN — populated for 1,048 of 1,409 real ledgers)*; Billing Attention
*(flat `MAILINGNAME` field, not previously fetched — populated for 1,269 of 1,409 real ledgers)*;
Payment Terms, Payment Terms Label *(flat `BILLCREDITPERIOD` field on the ledger master — a real,
correctly-named field the earlier `CREDITPERIOD` search missed; sparse but genuinely populated,
1 of 1,409 real ledgers)*; Contact First Name *(the same `LEDGERCONTACT` value already used for
"Conact Display Name" — see above)*

**Investigated, not changed** — Currency Code is hardcoded to INR for every row (not blank, so
not in any bucket above, but worth recording): Zoho's own official migration tool reads a ledger's
real currency from a flat `CURRENCYNAME` field, tried live 2026-09-12 and confirmed to NOT resolve
at the Ledger level — it came back as the literal string `"?"` (Tally's own sentinel for an
unresolvable expression) for all 1,409 real ledgers, not blank/omitted the way a genuinely
nonexistent field behaves elsewhere in this project. A few plausible alternate names
(`LEDGERCURRENCYNAME`, `FORINGCURRNAME`, `USEFORFOREX`) were also tried and silently ignored by
Tally. Left hardcoded rather than guessing a fourth name.

---

## Vendor.xlsx — 26 / 61 mapped

Same shape as Customer.xlsx (see above for the reasoning behind each repeated field).

**No Tally concept** — Vendor Number *(auto-generated, same as Customer Number — see above)*,
Facebook, Twitter, Department, Designation, Exemption Reason, Skype Identity, Owner Name

**Not structured this way in Tally** — Salutation, First Name, Last Name; Billing City, Billing
Fax, Billing Phone; Shipping Attention, Shipping Address, Shipping Street2, Shipping City,
Shipping State, Shipping Country, Shipping Code, Shipping Fax, Shipping Phone; Conact Salutation,
Conact Last Name, Conact EmailID, Conact Phone, Conact MobilePhone, Conact Skype, Conact
Department, Conact Designation

**Unused by this company** — Opening Balance Exchange Rate; TDS Name, TDS Section Code, TDS
Percentage

**Mapped 2026-09-10** (see Customer.xlsx's identical fields above for the live-population
evidence) — Source Of Supply *(`LEDGSTREGDETAILS.LIST` → `PLACEOFSUPPLY` — the earlier "no
distinct source-state field" note was wrong: this lives in the GST registration details, not
alongside Billing State)*; Billing Attention; Payment Terms, Payment Terms Label; Contact First
Name

*(Vendor.xlsx has no "Credit Limit" column — that's an AR-side concept Customer.xlsx alone has. It
also has no "Beneficiary"/"Routing Number" columns at all, despite Zoho's own migration tool
carrying those in its own CSV schema — this project's actual Vendor.xlsx template only has "Bank
Name"/"Bank Account Number", both already mapped. Currency Code is hardcoded to INR here too — see
Customer.xlsx's "Investigated, not changed" note above; the `CURRENCYNAME` dead end applies
identically to both templates.)*

---

## Item.xlsx — 26 / 67 mapped

**No Tally concept** — Item ID, UPC, MPN, EAN, ISBN, Is Returnable Item, Is Tax Calculated on
Label Price, Is Receivable Service, AttributeName1, AttributeName2, AttributeName3,
AttributeOption1, AttributeOption2, AttributeOption3 *(Zoho's product-variant system — Tally Stock
Items have no variant/attribute structure)*, Source, Reference ID, Last Sync Time, Enable Bin
Tracking, Is Combo Product, Exemption Reason *(investigated 2026-09-12: fetched GSTDETAILS.LIST's
full structure live for a real Exempt item — TAXABILITY/SRCOFGSTDETAILS/GSTINELIGIBLEITC/
STATEWISEDETAILS.LIST — no free-text or coded reason field exists anywhere in it, unlike the
sibling fields this project already reads from the same list)*

**Corrected 2026-09-10** — "Product Type" was wrongly filed under "No Tally concept" above; it's
real (Tally's flat `GSTTYPEOFSUPPLY` field — "Goods"/"Services") and now mapped, live-verified: 28
of 35 real items are actually "Services", only 6 "Goods". It had been conflated with this
template's *other*, differently-named "Item Type" column (a Zoho usage-scope concept — "Sales and
Purchases"/"Sales"/"Purchases" — with no goods/service meaning at all), which an earlier pass
wrote `'goods'` into by mistake; that column now correctly gets Zoho's own documented default,
`"Sales and Purchases"`, since no per-item Sales-only/Purchases-only signal exists in Tally.

**Mapped 2026-09-12** (cross-referenced against Zoho's own official Tally migration tool, then
live-verified) — Inventory Valuation Method *(flat `COSTINGMETHOD` field, not previously fetched —
populated for all 35 real items, "Avg. Cost")*; Account, Purchase Account *(an earlier pass
conflated these with the unconfigured Price List fields below — they're actually a different
Tally concept, `SALESLIST.LIST`/`PURCHASELIST.LIST`, the item's own default Sales/Purchase ledger
allocation. Confirmed real and correctly fetched — no error — but empty for all 35 real items, so
this company's export won't show a value yet; correct once an item has a default ledger set)*

**Not structured this way in Tally** — Product Name, Item Description, Unit Name *(duplicate slots
for the same Item Name/Description/Usage unit this template already carries in its primary
columns)*; Package Weight, Package Length, Package Width, Package Height, Dimension Unit, Weight
Unit *(Tally Stock Items carry no shipping-dimension data — this company's items are software/
subscriptions, not physical goods with package dimensions anyway)*

**Unused by this company** — Brand, Manufacturer *(fields checked live — 0 of 35 real items have
either set)*; Rate, Purchase Rate *(Tally's Price List feature —
`STANDARDPRICELIST.LIST`/`STANDARDCOSTLIST.LIST` — confirmed live to be genuinely unconfigured for
every item; a different Tally concept from Account/Purchase Account above, despite the similar
name)*; Account Code, Purchase Account Code, Purchase Description, Inventory Account,
Inventory Account Code, Reorder Point *(`REORDERLEVEL` real field, 0 of
35 items populated)*, Vendor *(no default-supplier field found on the Stock Item master)*, Cost
Centre *(no per-item default Cost Centre found)*

---

## Invoice.xlsx — 30 / 72 mapped

**Corrected 2026-09-10** — GST Treatment was inferred from GSTIN presence alone (a documented
simplification), which silently mapped every real "Unregistered/Consumer" voucher to Zoho's
`consumer` instead of the correct `business_none`; now reads Tally's own flat `GSTREGISTRATIONTYPE`
field (populated on 478 of 602 sampled vouchers — 334 Regular, 113 Unregistered/Consumer, 31
"Unknown") and applies Zoho's real enum table. Item Type on
each line was hardcoded `'goods'`; now reads the item master's real `GSTTYPEOFSUPPLY`
classification (see Item.xlsx above) — both columns were already counted as "mapped" before this
fix (a value was written), so neither changes the count here, only the correctness of what's
written.

**Mapped 2026-09-10** — Branch Name *(flat `GSTREGISTRATION` field on the voucher — populated on
601 of 602 sampled vouchers, always "Uttar Pradesh Registration" for this single-GSTIN company;
replaces the earlier `DispatchFromName` attempt below, which only ever returned the company's
legal name)*

**No Tally concept** — Estimate Number, E-Commerce Operator Name, E-Commerce Operator GSTIN,
PayPal, Razorpay, Partial Payments, Template Name

**Not structured this way in Tally** — Item Tax Exemption Reason, Adjustment Description
*(free-text justification fields Tally has no equivalent slot for)*

**Unused by this company** — Invoice Status *(no draft/approved workflow state tracked in Tally —
every extracted voucher is, by definition, already finalized)*; Nature Of Collection, TCS Payable
Account, TCS Receivable Account *(only 1 real TCS ledger entry found across 8+ sampled months, and
it's a receivable, not a collection — not enough real activity for a Nature-of-Collection field)*;
TDS Section Code *(TDS amount/name are mapped from real ledger entries; no separate section-code
field is posted on the voucher itself)*; PurchaseOrder, Expense Reference ID *(voucher.reference is
already used for "Reference#"-equivalent purposes; no distinct second reference field exists)*;
Payment Terms, Payment Terms Label; Expected Payment Date *(distinct from the already-mapped Due
Date — no separate "expected" date tracked)*; Sales person *(no salesperson field or Cost-Centre-
as-salesperson pattern found — Cost Centres on this company are confirmed unused on real
vouchers)*; Shipping Charge Tax Name, Shipping Charge Tax Type, Shipping Charge Tax %, Shipping
Charge, Shipping Charge Tax Exemption Code, Shipping Charge SAC Code *(no shipping-charge line
item pattern found in real invoices — this company doesn't ship physical goods)*; Is Inclusive Tax
*(`ISTAXINCLUSIVE` — checked live, field does not exist under that name on any real voucher)*;
Reverse Charge Tax Name, Reverse Charge Tax Rate, Reverse Charge Tax Type *(`ReverseChargeApplicable`/
`IsReverseCharge` — checked live, 0 occurrences across 480 real vouchers sampled)*; Is Export
Without LUT/Bond, Tax Collected From Customer, Supply Type *(`GSTSupplyType` is a real field,
confirmed live to exist but empty on all 480 sampled vouchers)*; Project Name *(no project-tracking
concept in this company's Tally data)*; Discount Type, Is Discount Before Tax, Entity Discount
Percent, Entity Discount Amount, Discount Amount *(voucher-header-level discount, distinct from
the already-mapped per-line Discount — no real Tally source found)*; Adjustment *(`Discount`/
round-off-style header field — checked live, not present)*; Terms & Conditions *(narration is
already used for Notes; no second free-text field exists)*; Warehouse Name *(Godown — checked live,
0 usage across every sampled inventory entry; see Stock Journal.xlsx below for the same finding)*

---

## Bill.xlsx — 35 / 60 mapped

*(Corrected 2026-09-12 — the earlier "this company simply never uses Purchase vouchers" claim
below was itself an artifact of a narrower Tally "Current Period" scope, not a real fact about
this company's books: once the connected session picked up a wider period, 9 real Purchase
vouchers appeared. All ledger-only/service-row columns (Vendor Name, GST Treatment/GSTIN, Account,
Tax Name/Percentage/Amount/Type, SubTotal/Total/Balance, Vendor Notes, Purchase Order Number,
Branch Name) are now confirmed against these real rows, not just realistic fixtures — every one of
them populated 100% except Purchase Order Number (4/9, expected — a free-text field not every real
bill carries) and Branch Name (6/9). All 9 real bills are ledger-only (no stock items), consistent
with an earlier finding elsewhere in this doc that this company's Stock Items are almost entirely
services.)*

**Corrected 2026-09-10** — GST Treatment/Item Type fixed the same way as Invoice.xlsx above (see
that section) — no count change, both were already mapped, just wrong for a non-Regular-GST
party or a Service-classified item.

**Mapped 2026-09-10** — Branch Name *(same `GSTREGISTRATION` voucher field as Invoice.xlsx above —
now confirmed on real Bill rows too, 6/9)*

**No Tally concept** — Is Billable, CF.Transporte_Name *(a custom field, template-specific)*

**Not structured this way in Tally** — Item Exemption Code, Customer Name *(Bill.xlsx carries a
stray "Customer Name" column alongside "Vendor Name" — no second-party concept exists on a
Purchase voucher)*

**Unused by this company** *(same reasoning as the identically-named Invoice.xlsx fields above,
where applicable)* — PurchaseOrder, Bill Status, Source of Supply, Destination of Supply, Is
Inclusive Tax, TDS Section Code, Adjustment, Reverse Charge Tax Name, Reverse Charge Tax Rate,
Reverse Charge Tax Type, Terms & Conditions, Payment Terms, Payment Terms Label, Project Name, Is
Discount Before Tax, Entity Discount Amount, Discount Account, Is Landed Cost, Warehouse Name,
Nature Of Collection, Supply Type

---

## Credit Note.xlsx — 30 / 60 mapped

**Corrected 2026-09-10** — GST Treatment/Item Type fixed the same way as Invoice.xlsx above.

**Mapped 2026-09-10** — Branch *(same `GSTREGISTRATION` voucher field as Invoice.xlsx above)*;
Reference Invoice Type *(derived from this credit note's own, now-correct GST Treatment, mirroring
Zoho's own official migration tool's `ReferenceTypeValueHandler` — not a re-lookup of the
reference field. `business_gst`/`business_registered_composition` → "Registered", `business_sez` →
SEZ With/Without Payment, `overseas` → Export With/Without Payment, `deemed_export` → "Deemed
Export"; `business_none`/`consumer` → "B2C Others" unconditionally, since correctly splitting that
last case against "B2C (Large)" needs the seller's own home state to check inter-state-ness, which
this project doesn't extract — a documented simplification, not a guess: this company has zero
real SEZ/overseas/B2C credit notes to verify the inter-state split against anyway)*; Associated
Invoice Date *(a genuine cross-reference, not a Tally field: looked up by "Associated Invoice
Number" against a same-run companion Invoice extraction — see `extractions.service.ts`'s
`invoicesJobId` plumbing and `credit-note.mapper.ts`'s `invoiceDatesByNumber` map. Optional: left
blank, not blocked, when no Invoice job is available)*

**No Tally concept** — Template Name, Subject

**Not structured this way in Tally** — Item Tax Exemption Reason, Adjustment Description

**Unused by this company** — Credit Note Status; Reason *(narration already carries the real
free-text explanation via Notes; no separate structured reason-code field exists)*; Sales person;
Is Inclusive Tax; Project Name; Discount Type, Is Discount Before Tax, Entity Discount Percent,
Entity Discount Amount, Discount Amount; Shipping Charge, Shipping Charge Tax Name, Shipping
Charge Tax Type, Shipping Charge Tax %, Shipping Charge SAC Code, Shipping Charge Tax Exemption
Code; Adjustment; Terms & Conditions; Warehouse Name; Reverse Charge Tax Name, Reverse
Charge Tax Rate, Reverse Charge Tax Type; Is Export Without LUT/Bond, Tax Collected From Customer,
Supply Type; Nature Of Collection

---

## Stock Journal.xlsx (Inventory Adjustment) — 10 / 17 mapped

*(Confirmed against real data for the first time 2026-09-12 — every earlier pass had zero real
Stock Journal vouchers to test against. A wider Tally "Current Period" surfaced 3 real vouchers/41
inventory lines: Date/Status/Reference Number/Item Name/Usage unit all 100%, Quantity Adjusted
61%, Adjusted Value 39%, Item Description 24% — all consistent with the mapper's existing logic,
now proven rather than only fixture-tested.)*

**Not structured this way in Tally** — New Quantity on Hand, New Value *(these need a genuine
running stock balance at the moment of this specific voucher; `TallyStockItem.closingBalance` is
the item's company-wide as-of-date balance, not a per-transaction snapshot — populating these from
the wrong source would be actively incorrect, not just incomplete)*; Cost Price *(re-investigated
2026-09-12 against the 3 real vouchers above: hypothesized it could reuse the same per-line RATE
Invoice/Bill/Credit Note already read, cross-referenced against Zoho's own official Tally migration
tool, whose config sources Stock Journal lines from a different list —
INVENTORYENTRIESIN.LIST/INVENTORYENTRIESOUT.LIST, not the ALLINVENTORYENTRIES.LIST every other
voucher type here uses. Checked both live: RATE came back empty in this project's own parsed data
AND in a raw probe of Zoho's own preferred list for the same real voucher — genuinely unset at the
source, not a wrong-list bug; this company records these adjustments by value only, no per-unit
rate entered)*

**Unused by this company** — Reason *(narration already carries the free-text explanation via
Description; no separate reason-code field found)*; Account *(no `ACCOUNTINGALLOCATIONS.LIST`-
equivalent posted-ledger field found on a Stock Journal's inventory entries — unlike Invoice/Bill/
Credit Note lines)*; Branch Name, Warehouse Name *(Godown — checked live against the richer
Jan–Mar 2026 data, still 0 usage across every sampled inventory entry, now including the 41 real
2026-09-12 lines)*

---

## Where to look if you want to close one of these

- **Zoho's own official Tally migration tool** (`ZFMigrationTool-v1.9`, supplied by the user in
  `Zoho WorkDrive.zip`, not checked into this repo) is the single best reference for "does Tally
  actually have this, and under what name" — its `conf/source_conf/tallyprime/xml_to_csv_config.yml`
  is a complete field-by-field map for every Zoho column across every entity, cross-checked
  against this project's real data during the 2026-09-10 pass above. It's a batch tool that reads
  a manually-exported Tally XML file rather than talking to Tally live, so it can't be run
  directly against this project's live HTTP/TDL pipeline — but its config file alone is enough to
  identify a candidate field name to go verify live.
- **"Unused by this company"** fields are the ones most likely to have real data for a *different*
  Tally company that actually uses the feature (Price Lists, Cost Centres, TDS-on-ledger, Godowns,
  Reverse Charge, Purchase vouchers). The TDL field names above are already correct and
  live-verified where noted — wiring one in for a company that populates it is a mapper change,
  not a new investigation.
- **"Not structured this way"** fields would need either a second cross-referencing extraction
  (the pattern Credit Note.xlsx's "Associated Invoice Date" now uses, see above — a same-run
  companion Invoice extraction, not a new Tally field) or accepting a heuristic guess (e.g.
  splitting a ledger Name into First/Last) — the latter is a deliberate policy decision this
  project has not made; see `backend/src/mapping/*.mapper.ts` doc comments for the "never guess"
  standard this whole mapping layer follows.
- **"No Tally concept"** fields are permanently out of reach short of the user manually filling
  them in Zoho after import — Tally has nothing resembling Facebook handles, product variants, or
  e-commerce operator metadata.
- **A field already counted as "mapped" can still be wrong**, not just present-or-absent — GST
  Treatment and Item Type both looked "done" by this audit's own methodology (a real value was
  written) while quietly using the wrong Tally field for a subset of real data. Worth periodically
  re-checking a "mapped" field's *value* against live data, not just its presence, especially one
  derived by pattern-matching or a documented simplification rather than a direct 1:1 field read.
