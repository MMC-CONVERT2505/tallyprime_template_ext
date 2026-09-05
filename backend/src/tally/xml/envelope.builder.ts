import { Injectable } from '@nestjs/common';
import { SV_EXPORT_FORMAT_XML, TALLY_REPORTS } from '../tally.constants';
import { escapeXml } from './xml.utils';

export interface ReportRequestOptions {
  reportName: string;
  company?: string;
  fromDate?: string; // YYYYMMDD
  toDate?: string; // YYYYMMDD
  voucherType?: string;
  /** Extra <SVKEY>value</SVKEY> static variables, already-safe scalar values. */
  extraStaticVariables?: Record<string, string>;
}

/**
 * Builds Tally request envelopes. Two families:
 *
 *  1. Report export ("Export Data" / REQUESTDESC) — asks Tally for one of its
 *     named reports (Day Book, Voucher Register…). Simple, but returns Tally's
 *     full report shape.
 *
 *  2. Custom Collection (TALLYREQUEST=Export, TYPE=Collection) — we define a TDL
 *     Collection inline and list EXACTLY the fields we want. This is the pattern
 *     that scales for extraction: no discarding 90% of a bloated default report.
 *
 * All caller-supplied strings are XML-escaped, so a company like "AT&T Ltd" or a
 * voucher type with an "&" cannot break the envelope.
 */
@Injectable()
export class EnvelopeBuilder {
  /** Report-export style request (REQUESTDESC + STATICVARIABLES). */
  buildReportRequest(opts: ReportRequestOptions): string {
    const staticVars: string[] = [`<SVEXPORTFORMAT>${SV_EXPORT_FORMAT_XML}</SVEXPORTFORMAT>`];

    if (opts.company) {
      staticVars.push(`<SVCURRENTCOMPANY>${escapeXml(opts.company)}</SVCURRENTCOMPANY>`);
    }
    if (opts.fromDate) {
      staticVars.push(`<SVFROMDATE>${escapeXml(opts.fromDate)}</SVFROMDATE>`);
    }
    if (opts.toDate) {
      staticVars.push(`<SVTODATE>${escapeXml(opts.toDate)}</SVTODATE>`);
    }
    if (opts.voucherType) {
      staticVars.push(`<VOUCHERTYPENAME>${escapeXml(opts.voucherType)}</VOUCHERTYPENAME>`);
    }
    for (const [key, value] of Object.entries(opts.extraStaticVariables ?? {})) {
      staticVars.push(`<${key}>${escapeXml(value)}</${key}>`);
    }

    return this.wrap(`
      <HEADER>
        <TALLYREQUEST>Export Data</TALLYREQUEST>
      </HEADER>
      <BODY>
        <EXPORTDATA>
          <REQUESTDESC>
            <REPORTNAME>${escapeXml(opts.reportName)}</REPORTNAME>
            <STATICVARIABLES>
              ${staticVars.join('\n              ')}
            </STATICVARIABLES>
          </REQUESTDESC>
        </EXPORTDATA>
      </BODY>`);
  }

  /** Collection-style request: `collectionXml` is a full <COLLECTION>…</COLLECTION>. */
  buildCollectionRequest(
    id: string,
    collectionXml: string,
    company?: string,
    extraStaticVariables?: Record<string, string>,
  ): string {
    const staticVars: string[] = [`<SVEXPORTFORMAT>${SV_EXPORT_FORMAT_XML}</SVEXPORTFORMAT>`];
    if (company) {
      staticVars.push(`<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>`);
    }
    for (const [key, value] of Object.entries(extraStaticVariables ?? {})) {
      staticVars.push(`<${key}>${escapeXml(value)}</${key}>`);
    }

    return this.wrap(`
      <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>${escapeXml(id)}</ID>
      </HEADER>
      <BODY>
        <DESC>
          <STATICVARIABLES>
            ${staticVars.join('\n            ')}
          </STATICVARIABLES>
          <TDL>
            <TDLMESSAGE>
              ${collectionXml}
            </TDLMESSAGE>
          </TDL>
        </DESC>
      </BODY>`);
  }

  /**
   * Lists companies currently loaded in Tally. Needs no company scope, so it is
   * the ideal connectivity probe AND a discovery call (you learn the exact
   * company-name strings you must match elsewhere).
   */
  buildCompaniesRequest(): string {
    const collection = `
      <COLLECTION NAME="List of Companies" ISINITIALIZE="Yes">
        <TYPE>Company</TYPE>
        <NATIVEMETHOD>Name</NATIVEMETHOD>
        <NATIVEMETHOD>StartingFrom</NATIVEMETHOD>
        <NATIVEMETHOD>BooksFrom</NATIVEMETHOD>
        <NATIVEMETHOD>Guid</NATIVEMETHOD>
      </COLLECTION>`;
    return this.buildCollectionRequest(TALLY_REPORTS.LIST_OF_COMPANIES, collection);
  }

  /**
   * Lean ledger master export: Name, Parent, Description, Opening/Closing
   * balance and AlterID — instead of Tally's bloated default Ledger report.
   * Fetching balances requires the company scope so Tally can compute them.
   *
   * fromDate/toDate (YYYYMMDD) set SVFROMDATE/SVTODATE, the same period
   * variables a report export uses — Tally computes OpeningBalance/
   * ClosingBalance relative to that period, not just "whatever's current."
   * Omit both to get Tally's current-period balances (previous behavior).
   *
   * `alterIdRange`, when supplied, scopes the collection to
   * `from <= AlterID <= to` (inclusive both ends) via a named TDL filter
   * formula — see MasterExtractionService's batched fetch, which splits a
   * large company's ledger list into several of these instead of one
   * unbounded request. Batched by AlterID (a plain integer Tally bumps on
   * every change to a record — already one of the fields fetched here), not
   * by name: two name-based approaches were tried and both broke on real
   * data — an alphabetical range mismatched Tally's own string collation
   * against JavaScript's sort order (a batch returned zero records, another
   * more than its slice), and exact-name matching silently missed ~4% of
   * records whose names contained a literal `&#13;&#10;` marker (Tally's
   * own encoding of an embedded CR/LF someone pasted into a name field,
   * which doesn't round-trip through a TDL string literal the same way it's
   * compared internally). A plain numeric ID has none of that ambiguity.
   * Omitted entirely for a small collection: byte-identical to the
   * unfiltered request that ran before batching existed.
   */
  buildLedgersRequest(
    company: string,
    fromDate?: string,
    toDate?: string,
    alterIdRange?: { from: number; to: number },
  ): string {
    const collection = `
      <COLLECTION NAME="Lean Ledgers" ISINITIALIZE="Yes">
        <TYPE>Ledger</TYPE>
        <NATIVEMETHOD>Name</NATIVEMETHOD>
        <NATIVEMETHOD>Parent</NATIVEMETHOD>
        <NATIVEMETHOD>Description</NATIVEMETHOD>
        <NATIVEMETHOD>OpeningBalance</NATIVEMETHOD>
        <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
        <NATIVEMETHOD>AlterID</NATIVEMETHOD>
        <!--
          Fields below power Customer.xlsx/Vendor.xlsx (GSTIN/PAN/contact/
          address/bank) — VERIFIED live 2026-08-22 against a real Tally
          instance (COREDGE.IO INDIA PRIVATE LIMITED), not guessed. Two
          names were wrong in an earlier pass and corrected here:
            - GSTIN is NOT a flat field (GSTREGISTRATIONNUMBER never
              existed) — it lives inside LEDGSTREGDETAILS.LIST, a REPEATING
              list of a party's GST registrations over time (state changes,
              re-registrations), each entry optionally carrying GSTIN/
              PLACEOFSUPPLY/APPLICABLEFROM/GSTREGISTRATIONTYPE. A ledger can
              have entries with no GSTIN at all (pre-GST history) mixed with
              ones that do — response.parser.ts picks the last entry that
              actually has one.
            - BankDetails is a flat scalar (just an account number) — this
              claimed no separate bank-name field existed at all, which was
              WRONG: corrected 2026-09-05, see PAYMENTDETAILS.LIST below.
          EMAIL/LEDGERPHONE/LEDGERMOBILE/ADDRESS.LIST/LEDSTATENAME/
          COUNTRYNAME/PINCODE/INCOMETAXNUMBER were all confirmed correct as
          originally written — real values observed for ledgers that had
          them filled in Tally (most don't; that's sparse real-world data,
          not a wrong field name).

          PAYMENTDETAILS.LIST added 2026-09-05, VERIFIED live against 452
          real Sundry Creditor ledgers: the flat BANKDETAILS field above is
          effectively dead for vendor payment bank details on this Tally
          version (0/452 populated) — a vendors real payment bank info
          (used for NEFT/RTGS, entered via Tally is e-payment setup) lives
          in this separate, REPEATING list instead (entered via Tally e-payment
          setup), each entry carrying BANKNAME/ACCOUNTNUMBER/IFSCODE/
          PAYMENTFAVOURING/TRANSACTIONNAME (dozens of real vendors confirmed
          populated here). Kept alongside
          the legacy BANKDETAILS field as a fallback, not a replacement —
          see response.parser.ts's readPaymentDetails.
        -->
        <NATIVEMETHOD>LEDGSTREGDETAILS.LIST</NATIVEMETHOD>
        <NATIVEMETHOD>INCOMETAXNUMBER</NATIVEMETHOD>
        <NATIVEMETHOD>EMAIL</NATIVEMETHOD>
        <NATIVEMETHOD>LEDGERPHONE</NATIVEMETHOD>
        <NATIVEMETHOD>LEDGERMOBILE</NATIVEMETHOD>
        <NATIVEMETHOD>ADDRESS.LIST</NATIVEMETHOD>
        <NATIVEMETHOD>LEDSTATENAME</NATIVEMETHOD>
        <NATIVEMETHOD>COUNTRYNAME</NATIVEMETHOD>
        <NATIVEMETHOD>PINCODE</NATIVEMETHOD>
        <NATIVEMETHOD>BANKDETAILS</NATIVEMETHOD>
        <NATIVEMETHOD>PAYMENTDETAILS.LIST</NATIVEMETHOD>
        <!--
          Website/CreditLimit/LedgerContact added 2026-09-05, VERIFIED live —
          see TallyLedger.website's doc comment. Genuinely sparse (1/1409
          real ledgers populated) but confirmed correct field names, not a
          guess: that one ledger returned real values for all three.
        -->
        <NATIVEMETHOD>WEBSITE</NATIVEMETHOD>
        <NATIVEMETHOD>CREDITLIMIT</NATIVEMETHOD>
        <NATIVEMETHOD>LEDGERCONTACT</NATIVEMETHOD>
        ${this.alterIdRangeFilterRef(alterIdRange)}
      </COLLECTION>${this.alterIdRangeFormula(alterIdRange)}`;
    return this.buildCollectionRequest(
      'Lean Ledgers',
      collection,
      company,
      this.periodVariables(fromDate, toDate),
    );
  }

  /**
   * Cheap Name+AlterID ledger collection — no balances, no period
   * variables, so Tally doesn't compute anything per row. Used to get a
   * total count and the AlterID list before deciding how (or whether) to
   * batch the full fetch.
   */
  buildLedgerNamesRequest(company: string): string {
    const collection = `
      <COLLECTION NAME="Ledger Names" ISINITIALIZE="Yes">
        <TYPE>Ledger</TYPE>
        <NATIVEMETHOD>Name</NATIVEMETHOD>
        <NATIVEMETHOD>AlterID</NATIVEMETHOD>
      </COLLECTION>`;
    return this.buildCollectionRequest('Ledger Names', collection, company);
  }

  /**
   * Group master export: Name, Parent, AlterID. Groups have no Zoho
   * counterpart of their own — this exists purely to resolve which standard
   * Tally chart-of-accounts group a custom sub-group (created by the user,
   * e.g. "Employee" or "Reimbursement Payable") ultimately rolls up to. See
   * src/mapping/group-hierarchy.resolver.ts.
   */
  buildGroupsRequest(company: string): string {
    const collection = `
      <COLLECTION NAME="Lean Groups" ISINITIALIZE="Yes">
        <TYPE>Group</TYPE>
        <NATIVEMETHOD>Name</NATIVEMETHOD>
        <NATIVEMETHOD>Parent</NATIVEMETHOD>
        <NATIVEMETHOD>AlterID</NATIVEMETHOD>
      </COLLECTION>`;
    return this.buildCollectionRequest('Lean Groups', collection, company);
  }

  /**
   * Lean stock item master export: Name, Parent (Stock Group), BaseUnits,
   * Opening/Closing balance (quantity) and value, and AlterID. Same "lean, not
   * Tally's bloated default report" pattern as buildLedgersRequest.
   *
   * fromDate/toDate: see buildLedgersRequest's doc comment — same
   * SVFROMDATE/SVTODATE period-scoping applies to stock quantities/values.
   * `alterIdRange`: see buildLedgersRequest's doc comment — same numeric batching mechanism.
   *
   * HSNDETAILS.LIST/GSTDETAILS.LIST — VERIFIED live (2026-09-04, COREDGE.IO
   * INDIA PRIVATE LIMITED). The original best-effort flat HSNCODE/GSTRATE
   * fields were WRONG — confirmed via a raw probe against a real
   * HSN-classified, GST-applicable stock item: the flat GSTHSNCODE field
   * itself came back as the literal string "Not Found", and HSNCODE/GSTRATE
   * as requested here returned nothing for every one of a live company's 35
   * stock items. Modern TallyPrime keeps both as REPEATING, date-effective
   * lists instead (an item's HSN/rate can be reclassified over time) — the
   * same shape LEDGSTREGDETAILS.LIST already uses for ledger GSTIN, just one
   * level deeper for GST (STATEWISEDETAILS.LIST -> RATEDETAILS.LIST, one row
   * per duty head: CGST/SGST-UTGST/IGST/Cess/State Cess). See
   * TallyResponseParser.mapStockItems's readLatestHsn/readLatestGstRate for
   * how these are read back down to the single flat hsnCode/gstRate
   * TallyStockItem needs.
   *
   * IMPORTANT: this fields list must NOT carry an inline XML comment inside
   * the <COLLECTION> body — confirmed live: a multi-line `<!-- ... -->`
   * comment placed between two <NATIVEMETHOD> tags here (an earlier version
   * of this exact fix) made Tally reject the ENTIRE request with a bare
   * "Unknown Request, cannot be processed" RESPONSE (not even a proper
   * ENVELOPE) — reproduced and isolated by removing only the comment (same
   * NATIVEMETHOD list otherwise byte-identical), which then succeeded.
   * Tally's TDL parser is not a fully-compliant XML parser (see this file's
   * other doc comments on `$$Date:` literal syntax, unescaped `&`, etc.), so
   * any explanation of a request's fields belongs in a TypeScript comment
   * outside this template literal — like this one — never inside the wire
   * payload itself.
   */
  buildStockItemsRequest(
    company: string,
    fromDate?: string,
    toDate?: string,
    alterIdRange?: { from: number; to: number },
  ): string {
    const collection = `
      <COLLECTION NAME="Lean Stock Items" ISINITIALIZE="Yes">
        <TYPE>StockItem</TYPE>
        <NATIVEMETHOD>Name</NATIVEMETHOD>
        <NATIVEMETHOD>Parent</NATIVEMETHOD>
        <NATIVEMETHOD>Description</NATIVEMETHOD>
        <NATIVEMETHOD>BaseUnits</NATIVEMETHOD>
        <NATIVEMETHOD>OpeningBalance</NATIVEMETHOD>
        <NATIVEMETHOD>OpeningValue</NATIVEMETHOD>
        <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
        <NATIVEMETHOD>ClosingValue</NATIVEMETHOD>
        <NATIVEMETHOD>AlterID</NATIVEMETHOD>
        <NATIVEMETHOD>ALIAS</NATIVEMETHOD>
        <NATIVEMETHOD>HSNDETAILS.LIST</NATIVEMETHOD>
        <NATIVEMETHOD>GSTDETAILS.LIST</NATIVEMETHOD>
        ${this.alterIdRangeFilterRef(alterIdRange)}
      </COLLECTION>${this.alterIdRangeFormula(alterIdRange)}`;
    return this.buildCollectionRequest(
      'Lean Stock Items',
      collection,
      company,
      this.periodVariables(fromDate, toDate),
    );
  }

  /** Cheap Name+AlterID stock item collection — see buildLedgerNamesRequest's doc comment. */
  buildStockItemNamesRequest(company: string): string {
    const collection = `
      <COLLECTION NAME="Stock Item Names" ISINITIALIZE="Yes">
        <TYPE>StockItem</TYPE>
        <NATIVEMETHOD>Name</NATIVEMETHOD>
        <NATIVEMETHOD>AlterID</NATIVEMETHOD>
      </COLLECTION>`;
    return this.buildCollectionRequest('Stock Item Names', collection, company);
  }

  /**
   * Cost Centre master export: Name, Parent, AlterID — same lean shape as
   * buildGroupsRequest. Maps to Zoho Books' "Reporting Tag" import
   * (Master and Invoice or Bill/Class.xlsx).
   */
  buildCostCentresRequest(company: string): string {
    const collection = `
      <COLLECTION NAME="Lean Cost Centres" ISINITIALIZE="Yes">
        <TYPE>CostCentre</TYPE>
        <NATIVEMETHOD>Name</NATIVEMETHOD>
        <NATIVEMETHOD>Parent</NATIVEMETHOD>
        <NATIVEMETHOD>AlterID</NATIVEMETHOD>
      </COLLECTION>`;
    return this.buildCollectionRequest('Lean Cost Centres', collection, company);
  }

  /**
   * Vouchers for a date range. A `TYPE=Voucher` Collection request — NOT the
   * "Day Book" report export this used to be. Confirmed live 2026-08-25
   * against a real TallyPrime instance (COREDGE.IO INDIA PRIVATE LIMITED):
   * the Day Book report export ignores SVFROMDATE/SVTODATE outright on this
   * build — three requests with different, non-overlapping date ranges (one
   * spanning 2000-2026, one narrowed to the exact 2-month window the data
   * actually lived in) all came back with the exact same single stale
   * voucher, byte-for-byte identical response every time. This matches (and
   * explains) the "Tally's report engine doesn't appear to fully reset
   * internal state between back-to-back Export Data requests" behavior
   * TransactionExtractionService.dedupeVouchers already documented for the
   * chunked path — the whole-range/single-request path was hitting the same
   * underlying issue, just badly enough to return ~1 record instead of a few
   * leaked duplicates.
   *
   * A Collection evaluates its own request independently instead of sharing
   * that report-engine session state, and its `$Date` range is enforced via
   * an explicit <FILTER> formula (dateRangeFormula) rather than a static
   * variable — verified live against the same data: an unfiltered Collection
   * correctly returned all 601 real vouchers in range, and the same
   * Collection with this date FILTER correctly narrowed to exactly the
   * subset whose dates fall inside it (confirmed with a 10-day window: only
   * those 10 days' vouchers came back, nothing outside it).
   *
   * `voucherType` is accepted but NOT sent as a request-side filter —
   * VOUCHERTYPENAME never actually narrowed the old Day Book export either
   * (see TransactionExtractionService's class doc comment); the real filter
   * is client-side (TransactionExtractionService.filterByVoucherType),
   * unchanged by this method.
   *
   * Explicit <FETCH> list, NOT omitted — unlike a Report export (Day Book
   * always fully expanded every voucher regardless), a Collection only
   * returns what's asked for, and its *default* field set turned out to
   * depend on the voucher's own view: confirmed live, an "Invoice Voucher
   * View" Sales voucher fetched with no FETCH list at all came back with
   * only ~20 bare scalar fields — no PARTYLEDGERNAME, no ALTERID, no
   * ALLLEDGERENTRIES.LIST/ALLINVENTORYENTRIES.LIST at all — while an
   * "Accounting Voucher View" Journal voucher in the same unfiltered
   * response came back fully expanded. Explicitly fetching each field
   * TallyResponseParser.mapVoucher reads gets the full data back
   * consistently across every voucher type (verified live: the same Sales
   * voucher then included NARRATION/PARTYLEDGERNAME/ALTERID and two
   * populated ALLLEDGERENTRIES.LIST entries).
   *
   * One more constraint, live-verified 2026-08-25/2026-09-03 and independent
   * of everything above: a raw Voucher-type Collection is bounded by
   * whatever "Current Period" the connected Tally session has active
   * (Gateway of Tally, F2/Alt+F2) — NEITHER SVFROMDATE/SVTODATE
   * STATICVARIABLES NOR this method's own $Date FILTER can widen that
   * ceiling from the API side, only narrow further within it. Confirmed by
   * requesting with no filter/type restriction at all: every returned
   * voucher fell inside the connected session's own current period,
   * regardless of the fromDate/toDate this method was called with (a request
   * for e.g. January 2025 legitimately returned zero while the session's
   * Current Period was fixed to an April-2026-onward window). Widening the
   * connected Tally's Current Period to cover the desired range resolves
   * this immediately — confirmed live: the identical request that returned
   * ~601 vouchers before widening returned 13,312 (spanning back to Nov 2020)
   * after — with no code change required. This is an operational/connector-
   * machine setting, not something fixable from this request.
   */
  buildVouchersRequest(
    company: string,
    fromDate: string,
    toDate: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for
    // call-site/signature stability; see doc comment above for why it's not
    // threaded into the request itself.
    voucherType?: string,
  ): string {
    const collection = `
      <COLLECTION NAME="Vouchers In Range" ISINITIALIZE="Yes">
        <TYPE>Voucher</TYPE>
        <FETCH>Date</FETCH>
        <FETCH>VoucherTypeName</FETCH>
        <FETCH>VoucherNumber</FETCH>
        <FETCH>PartyLedgerName</FETCH>
        <FETCH>Narration</FETCH>
        <FETCH>Reference</FETCH>
        <FETCH>AlterID</FETCH>
        <FETCH>PartyGSTIN</FETCH>
        <FETCH>PlaceOfSupply</FETCH>
        <!--
          ConsigneeStateName added 2026-09-05, VERIFIED live: a real GST
          e-invoice field that's populated for several real export
          vouchers (foreign customers) where PlaceOfSupply itself comes
          back blank — e.g. Coredge/25-26/107 to "ADI DLT Foundation"
          (Abu Dhabi) has PlaceOfSupply empty but ConsigneeStateName
          "Abu Dhabi". Used as a fallback in mapVoucher, not a
          replacement — PlaceOfSupply wins when Tally does populate it.
        -->
        <FETCH>ConsigneeStateName</FETCH>
        <FETCH>AllLedgerEntries.List</FETCH>
        <FETCH>AllInventoryEntries.List</FETCH>
        <FILTER>VoucherDateRangeFilter</FILTER>
      </COLLECTION>${this.dateRangeFormula(fromDate, toDate)}`;
    return this.buildCollectionRequest('Vouchers In Range', collection, company);
  }

  /**
   * The named TDL formula buildVouchersRequest's <FILTER> resolves against —
   * inclusive both ends. `$$Date:"D-Mon-YYYY"` is the one literal-construction
   * syntax confirmed live to actually produce a comparable Date value on this
   * TallyPrime build: `$$Date:<yyyymmdd-as-number>` and
   * `$$YYYYMMDD:$Date >= "<yyyymmdd>"` (a plain string compared against a
   * formatter's output) both silently matched zero rows — no LINEERROR, the
   * FILTER just evaluated false for everything. A bare quoted string with no
   * `$$Date:` conversion at all (`$Date >= "1-Apr-2026"`) went the opposite
   * wrong way: a Date-vs-String type mismatch that Tally silently drops
   * instead of erroring on, so the FILTER has no effect and every row comes
   * back — the most dangerous failure mode of the three, since it looks
   * identical to "no filter requested" rather than failing loudly.
   */
  private dateRangeFormula(fromDate: string, toDate: string): string {
    const formula =
      `$Date >= $$Date:"${this.toTallyDateLiteral(fromDate)}" AND ` +
      `$Date <= $$Date:"${this.toTallyDateLiteral(toDate)}"`;
    return `
      <SYSTEM TYPE="Formulae" NAME="VoucherDateRangeFilter">${escapeXml(formula)}</SYSTEM>`;
  }

  /** YYYYMMDD -> Tally's own `$$Date:"D-Mon-YYYY"` literal syntax (English
   *  3-letter month abbreviations — confirmed live independent of Tally's
   *  configured display locale/date format). */
  private toTallyDateLiteral(yyyymmdd: string): string {
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    const year = yyyymmdd.slice(0, 4);
    const month = Number(yyyymmdd.slice(4, 6));
    const day = Number(yyyymmdd.slice(6, 8));
    return `${day}-${months[month - 1]}-${year}`;
  }

  /** SVFROMDATE/SVTODATE as an extraStaticVariables map, omitting whichever side is unset. */
  private periodVariables(fromDate?: string, toDate?: string): Record<string, string> {
    const vars: Record<string, string> = {};
    if (fromDate) vars.SVFROMDATE = fromDate;
    if (toDate) vars.SVTODATE = toDate;
    return vars;
  }

  /** <FILTER> reference for an AlterID-range batch, or empty string when unbatched. */
  private alterIdRangeFilterRef(alterIdRange?: { from: number; to: number }): string {
    return alterIdRange ? '<FILTER>AlterIdRangeFilter</FILTER>' : '';
  }

  /**
   * The named TDL formula an AlterID-range <FILTER> reference resolves
   * against — inclusive both ends ($AlterID >= from AND $AlterID <= to),
   * sibling to (not nested inside) the <COLLECTION> it filters, both
   * wrapped in the same <TDLMESSAGE> by buildCollectionRequest. Empty
   * string when unbatched, so the unfiltered request stays byte-identical
   * to before batching existed.
   *
   * A plain integer comparison — no quoting, no collation, no escaping
   * concerns beyond the operators themselves (`<=` contains a literal `<`,
   * invalid raw inside XML text content, same lesson as the name-based
   * approaches this replaced — escaped as part of the whole formula string).
   */
  private alterIdRangeFormula(alterIdRange?: { from: number; to: number }): string {
    if (!alterIdRange) return '';
    const formula = `$AlterID >= ${alterIdRange.from} AND $AlterID <= ${alterIdRange.to}`;
    return `
      <SYSTEM TYPE="Formulae" NAME="AlterIdRangeFilter">${escapeXml(formula)}</SYSTEM>`;
  }

  private wrap(inner: string): string {
    // Single leading declaration; trimmed so the body starts clean.
    return `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE>${inner}\n</ENVELOPE>`;
  }
}
