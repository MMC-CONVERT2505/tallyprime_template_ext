# Zoho import template fields with no Tally source

Companion to [`tally-zoho-function-mapping.md`](./tally-zoho-function-mapping.md), one level more
granular: that doc tracks which of the 33 Tally→Zoho *rows* have a template and a mapper built;
this one tracks, **within** each of those 9 built templates, exactly which *columns* still come
back blank on a real export, and why.

**174 of 413 columns across the 9 templates are mapped from a genuine Tally field (verified live
against COREDGE.IO INDIA PRIVATE LIMITED — see `backend/src/mapping/*.mapper.ts` doc comments for
the exact TDL field names and verification dates). The 239 below are not.** Every one was checked
against live Tally data before being left blank — none are unexamined gaps, and none are guessed
or fabricated to fill the template.

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

## Customer.xlsx — 20 / 65 mapped

**No Tally concept** — Customer Number, Customer Sub Type, Place Of Contact, Facebook, Twitter,
Department, Designation, Exemption Reason, Portal Status, Skype Identity, Owner Name, Bank Account
Payment, e-Invoice Registered Vendor, e-Invoice Registration Date *(Bank Account Payment is a Zoho
payment-preference default, distinct from the vendor-side Bank Name/Account Number this project
does map on Vendor.xlsx)*

**Not structured this way in Tally** — Salutation, First Name, Last Name *(one ledger Name field,
no person-name breakdown)*; Billing Attention, Billing City, Billing Fax, Billing Phone *(Tally's
mailing address is free-text lines + State/Country/Pincode — no Attention/City/Fax/Phone
sub-fields)*; Shipping Attention, Shipping Address, Shipping Street2, Shipping City, Shipping
State, Shipping Country, Shipping Code, Shipping Fax, Shipping Phone *(Tally ledgers have one
mailing address; no separate ship-to)*; Conact Salutation, Contact First Name, Conact Last Name,
Conact EmailID, Conact Phone, Conact MobilePhone, Conact Skype, Conact Department, Conact
Designation *(Tally's LEDGERCONTACT is one flat name string — already mapped to "Conact Display
Name" — not a structured contact-person record)*

**Unused by this company** — Payment Terms, Payment Terms Label *(no ledger-master credit-period
field found under any tried name — `CREDITPERIOD` does not exist on the Ledger object on this
Tally build)*; Opening Balance Exchange Rate *(no per-ledger opening-balance currency field
found)*; TDS Name, TDS Section Code, TDS Percentage *(`ISTDSAPPLICABLE` is real and confirmed
live, but reads "No" on all 1,409 real ledgers — no company ledger has TDS configured)*

---

## Vendor.xlsx — 21 / 61 mapped

Same shape as Customer.xlsx (see above for the reasoning behind each repeated field).

**No Tally concept** — Vendor Number, Facebook, Twitter, Department, Designation, Exemption
Reason, Skype Identity, Owner Name

**Not structured this way in Tally** — Salutation, First Name, Last Name; Billing Attention,
Billing City, Billing Fax, Billing Phone; Shipping Attention, Shipping Address, Shipping Street2,
Shipping City, Shipping State, Shipping Country, Shipping Code, Shipping Fax, Shipping Phone;
Conact Salutation, Contact First Name, Conact Last Name, Conact EmailID, Conact Phone, Conact
MobilePhone, Conact Skype, Conact Department, Conact Designation

**Unused by this company** — Source Of Supply *(no distinct source-state field beyond the ledger's
own Billing State, already mapped)*; Payment Terms, Payment Terms Label; Opening Balance Exchange
Rate; TDS Name, TDS Section Code, TDS Percentage

*(Vendor.xlsx has no "Credit Limit" column — that's an AR-side concept Customer.xlsx alone has.)*

---

## Item.xlsx — 22 / 67 mapped

**No Tally concept** — Item ID, UPC, MPN, EAN, ISBN, Is Returnable Item, Is Tax Calculated on
Label Price, Is Receivable Service, Product Type, AttributeName1, AttributeName2, AttributeName3,
AttributeOption1, AttributeOption2, AttributeOption3 *(Zoho's product-variant system — Tally Stock
Items have no variant/attribute structure)*, Source, Reference ID, Last Sync Time, Enable Bin
Tracking, Is Combo Product

**Not structured this way in Tally** — Product Name, Item Description, Unit Name *(duplicate slots
for the same Item Name/Description/Usage unit this template already carries in its primary
columns)*; Package Weight, Package Length, Package Width, Package Height, Dimension Unit, Weight
Unit *(Tally Stock Items carry no shipping-dimension data — this company's items are software/
subscriptions, not physical goods with package dimensions anyway)*

**Unused by this company** — Brand, Manufacturer *(fields checked live — 0 of 35 real items have
either set)*; Rate, Purchase Rate, Account, Purchase Account *(Tally's Price List feature —
`STANDARDPRICELIST.LIST`/`STANDARDCOSTLIST.LIST` — confirmed live to be genuinely unconfigured for
every item)*; Account Code, Purchase Account Code, Purchase Description, Inventory Account,
Inventory Account Code, Inventory Valuation Method, Reorder Point *(`REORDERLEVEL` real field, 0 of
35 items populated)*, Vendor *(no default-supplier field found on the Stock Item master)*, Cost
Centre *(no per-item default Cost Centre found)*

---

## Invoice.xlsx — 29 / 72 mapped

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
already used for Notes; no second free-text field exists)*; Branch Name, Warehouse Name
*(`DispatchFromName` exists live but only ever returns the company's own legal name, not a real
branch — mapping it here would misleadingly imply a multi-branch structure this company doesn't
have)*

---

## Bill.xlsx — 34 / 60 mapped

*(This template's real-world coverage is moot for this company: confirmed live across 8+ sampled
months and the full Voucher Type master list that "Purchase" is a real, standard, unmodified Tally
voucher type this company simply never uses — everything expense-side is recorded as a Journal
instead. The mapper is correct and tested against realistic fixtures; it just has no real rows to
produce from this company's actual books.)*

**No Tally concept** — Is Billable, CF.Transporte_Name *(a custom field, template-specific)*

**Not structured this way in Tally** — Item Exemption Code, Customer Name *(Bill.xlsx carries a
stray "Customer Name" column alongside "Vendor Name" — no second-party concept exists on a
Purchase voucher)*

**Unused by this company** *(same reasoning as the identically-named Invoice.xlsx fields above,
where applicable)* — PurchaseOrder, Bill Status, Source of Supply, Destination of Supply, Is
Inclusive Tax, TDS Section Code, Adjustment, Reverse Charge Tax Name, Reverse Charge Tax Rate,
Reverse Charge Tax Type, Terms & Conditions, Payment Terms, Payment Terms Label, Project Name, Is
Discount Before Tax, Entity Discount Amount, Discount Account, Is Landed Cost, Warehouse Name,
Branch Name, Nature Of Collection, Supply Type

---

## Credit Note.xlsx — 27 / 60 mapped

**No Tally concept** — Template Name, Subject

**Not structured this way in Tally** — Reference Invoice Type *(no registered/unregistered
classification tracked separately from GSTIN presence)*; Item Tax Exemption Reason, Adjustment
Description; Associated Invoice Date *(the linked invoice's own *number* is confirmed real — see
`Associated Invoice Number`, added this session via the voucher's REFERENCE field — but its *date*
would need a second lookup by number into a separate invoice extraction this mapper doesn't have
access to, so it's left blank rather than guessed)*

**Unused by this company** — Credit Note Status; Reason *(narration already carries the real
free-text explanation via Notes; no separate structured reason-code field exists)*; Sales person;
Is Inclusive Tax; Project Name; Discount Type, Is Discount Before Tax, Entity Discount Percent,
Entity Discount Amount, Discount Amount; Shipping Charge, Shipping Charge Tax Name, Shipping
Charge Tax Type, Shipping Charge Tax %, Shipping Charge SAC Code, Shipping Charge Tax Exemption
Code; Adjustment; Terms & Conditions; Branch, Warehouse Name; Reverse Charge Tax Name, Reverse
Charge Tax Rate, Reverse Charge Tax Type; Is Export Without LUT/Bond, Tax Collected From Customer,
Supply Type; Nature Of Collection

---

## Stock Journal.xlsx (Inventory Adjustment) — 10 / 17 mapped

**Not structured this way in Tally** — New Quantity on Hand, New Value *(these need a genuine
running stock balance at the moment of this specific voucher; `TallyStockItem.closingBalance` is
the item's company-wide as-of-date balance, not a per-transaction snapshot — populating these from
the wrong source would be actively incorrect, not just incomplete)*; Cost Price *(same issue —
would need the item's cost basis at that exact point in time, not its current one)*

**Unused by this company** — Reason *(narration already carries the free-text explanation via
Description; no separate reason-code field found)*; Account *(no `ACCOUNTINGALLOCATIONS.LIST`-
equivalent posted-ledger field found on a Stock Journal's inventory entries — unlike Invoice/Bill/
Credit Note lines)*; Branch Name, Warehouse Name *(Godown — checked live against the richer
Jan–Mar 2026 data, still 0 usage across every sampled inventory entry)*

---

## Where to look if you want to close one of these

- **"Unused by this company"** fields are the ones most likely to have real data for a *different*
  Tally company that actually uses the feature (Price Lists, Cost Centres, TDS-on-ledger, Godowns,
  Reverse Charge, Purchase vouchers). The TDL field names above are already correct and
  live-verified where noted — wiring one in for a company that populates it is a mapper change,
  not a new investigation.
- **"Not structured this way"** fields would need either a second cross-referencing extraction
  (e.g. looking up an invoice by number to get its date) or accepting a heuristic guess (e.g.
  splitting a ledger Name into First/Last) — the latter is a deliberate policy decision this
  project has not made; see `backend/src/mapping/*.mapper.ts` doc comments for the "never guess"
  standard this whole mapping layer follows.
- **"No Tally concept"** fields are permanently out of reach short of the user manually filling
  them in Zoho after import — Tally has nothing resembling Facebook handles, product variants, or
  e-commerce operator metadata.
