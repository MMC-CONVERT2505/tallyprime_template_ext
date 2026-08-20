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
          TODO verify against live Tally: field names below power
          Customer.xlsx/Vendor.xlsx (GSTIN/PAN/contact/address/bank) and are
          best-effort per Tally's documented XML schema, not yet confirmed
          against a real Tally instance (none reachable during this
          implementation pass — see TallyLedger's doc comment). A wrong name
          just means Tally silently omits that tag from its response (comes
          back null downstream), not a request failure, so this is safe to
          ship now and correct in place once verified. Address/BankDetails
          are TDL List fields, not simple scalars — requested as their dotted
          list tag (matching this codebase's existing ALLLEDGERENTRIES.LIST-
          style convention for nested lists), least certain of this batch.
        -->
        <NATIVEMETHOD>GSTREGISTRATIONNUMBER</NATIVEMETHOD>
        <NATIVEMETHOD>INCOMETAXNUMBER</NATIVEMETHOD>
        <NATIVEMETHOD>EMAIL</NATIVEMETHOD>
        <NATIVEMETHOD>LEDGERPHONE</NATIVEMETHOD>
        <NATIVEMETHOD>LEDGERMOBILE</NATIVEMETHOD>
        <NATIVEMETHOD>ADDRESS.LIST</NATIVEMETHOD>
        <NATIVEMETHOD>LEDSTATENAME</NATIVEMETHOD>
        <NATIVEMETHOD>COUNTRYNAME</NATIVEMETHOD>
        <NATIVEMETHOD>PINCODE</NATIVEMETHOD>
        <NATIVEMETHOD>BANKDETAILS.LIST</NATIVEMETHOD>
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
        <!-- TODO verify against live Tally — see TallyStockItem's doc comment. -->
        <NATIVEMETHOD>ALIAS</NATIVEMETHOD>
        <NATIVEMETHOD>HSNCODE</NATIVEMETHOD>
        <NATIVEMETHOD>GSTRATE</NATIVEMETHOD>
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
   * Day Book vouchers for a date range, optionally filtered by voucher type.
   * A report-export request (see buildReportRequest) — you don't pick fields
   * here, Tally decides the shape, and a real GST-enabled voucher already
   * includes PARTYGSTIN/PLACEOFSUPPLY (and much more) in its export XML,
   * unrequested. TallyResponseParser.mapVoucher reads them straight off the
   * parsed tree; if a live capture later shows either tag isn't actually
   * present, that's a parser-side name fix, not a change to this method.
   */
  buildVouchersRequest(
    company: string,
    fromDate: string,
    toDate: string,
    voucherType?: string,
  ): string {
    return this.buildReportRequest({
      reportName: TALLY_REPORTS.DAY_BOOK,
      company,
      fromDate,
      toDate,
      voucherType,
    });
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
