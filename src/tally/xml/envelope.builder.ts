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
    const staticVars: string[] = [
      `<SVEXPORTFORMAT>${SV_EXPORT_FORMAT_XML}</SVEXPORTFORMAT>`,
    ];

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
  buildCollectionRequest(id: string, collectionXml: string, company?: string): string {
    const staticVars: string[] = [
      `<SVEXPORTFORMAT>${SV_EXPORT_FORMAT_XML}</SVEXPORTFORMAT>`,
    ];
    if (company) {
      staticVars.push(`<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>`);
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
   * Lean ledger master export: only Name, Parent, Opening/Closing balance and
   * AlterID — instead of Tally's bloated default Ledger report. Fetching balances
   * requires the company scope so Tally can compute them.
   */
  buildLedgersRequest(company: string): string {
    const collection = `
      <COLLECTION NAME="Lean Ledgers" ISINITIALIZE="Yes">
        <TYPE>Ledger</TYPE>
        <NATIVEMETHOD>Name</NATIVEMETHOD>
        <NATIVEMETHOD>Parent</NATIVEMETHOD>
        <NATIVEMETHOD>OpeningBalance</NATIVEMETHOD>
        <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
        <NATIVEMETHOD>AlterID</NATIVEMETHOD>
      </COLLECTION>`;
    return this.buildCollectionRequest('Lean Ledgers', collection, company);
  }

  /**
   * Lean stock item master export: Name, Parent (Stock Group), BaseUnits,
   * Opening/Closing balance (quantity) and value, and AlterID. Same "lean, not
   * Tally's bloated default report" pattern as buildLedgersRequest.
   */
  buildStockItemsRequest(company: string): string {
    const collection = `
      <COLLECTION NAME="Lean Stock Items" ISINITIALIZE="Yes">
        <TYPE>StockItem</TYPE>
        <NATIVEMETHOD>Name</NATIVEMETHOD>
        <NATIVEMETHOD>Parent</NATIVEMETHOD>
        <NATIVEMETHOD>BaseUnits</NATIVEMETHOD>
        <NATIVEMETHOD>OpeningBalance</NATIVEMETHOD>
        <NATIVEMETHOD>OpeningValue</NATIVEMETHOD>
        <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
        <NATIVEMETHOD>ClosingValue</NATIVEMETHOD>
        <NATIVEMETHOD>AlterID</NATIVEMETHOD>
      </COLLECTION>`;
    return this.buildCollectionRequest('Lean Stock Items', collection, company);
  }

  /** Day Book vouchers for a date range, optionally filtered by voucher type. */
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

  /**
   * Import Data request that creates (or, on a name match, alters) a single
   * Ledger master. This is a WRITE against the live Tally company — unlike
   * every other builder method here, which only ever exports/reads data.
   */
  buildCreateLedgerRequest(
    name: string,
    parent: string,
    company?: string,
    openingBalance?: number,
  ): string {
    const staticVars: string[] = [];
    if (company) {
      staticVars.push(`<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>`);
    }

    const openingBalanceTag =
      openingBalance !== undefined
        ? `<OPENINGBALANCE>${escapeXml(String(openingBalance))}</OPENINGBALANCE>`
        : '';

    const message = `
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <LEDGER NAME="${escapeXml(name)}" ACTION="Create">
          <NAME>${escapeXml(name)}</NAME>
          <PARENT>${escapeXml(parent)}</PARENT>
          ${openingBalanceTag}
        </LEDGER>
      </TALLYMESSAGE>`;

    return this.wrap(`
      <HEADER>
        <TALLYREQUEST>Import Data</TALLYREQUEST>
      </HEADER>
      <BODY>
        <IMPORTDATA>
          <REQUESTDESC>
            <REPORTNAME>All Masters</REPORTNAME>
            <STATICVARIABLES>
              ${staticVars.join('\n              ')}
            </STATICVARIABLES>
          </REQUESTDESC>
          <REQUESTDATA>
            ${message}
          </REQUESTDATA>
        </IMPORTDATA>
      </BODY>`);
  }

  private wrap(inner: string): string {
    // Single leading declaration; trimmed so the body starts clean.
    return `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE>${inner}\n</ENVELOPE>`;
  }
}
