import { Injectable, Logger } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import { TallyResponseException } from '../exceptions/tally.exceptions';
import {
  TallyCompany,
  TallyCostCentre,
  TallyGroup,
  TallyInventoryEntry,
  TallyLedger,
  TallyLedgerEntry,
  TallyResponseMeta,
  TallyStockItem,
  TallyVoucher,
} from '../interfaces/tally.interfaces';
import {
  parseTallyAmount,
  readInt,
  readText,
  readYesNo,
  sanitizeTallyXml,
  toArray,
} from './xml.utils';

interface ParsedEnvelope {
  envelope: any;
  meta: TallyResponseMeta;
}

/**
 * Turns raw Tally XML into clean, typed domain objects. Every method funnels
 * through {@link parse}, which centralises the three things that bite every
 * Tally integration: non-standard `&` escaping, "empty envelope == zero rows
 * (not an error)", and embedded <LINEERROR> payloads returned with HTTP 200.
 */
@Injectable()
export class TallyResponseParser {
  private readonly logger = new Logger(TallyResponseParser.name);

  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Keep values as strings; we do our own number/sign parsing so we never let
    // the parser silently coerce "-0.00", "007", or a voucher number like
    // "00123" into a lossy JS number.
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    // Tally uses tags like ALLLEDGERENTRIES.LIST — the dot is part of the name,
    // not a path separator. fast-xml-parser treats it literally, which is what
    // we want.
    processEntities: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
  });

  /**
   * Low-level parse: sanitize -> detect empty -> parse -> detect Tally error.
   * Returns the raw object tree plus metadata. Throws only on genuinely
   * unparseable XML or an explicit Tally error — NOT on an empty result.
   */
  parse(rawXml: string): ParsedEnvelope {
    const xml = sanitizeTallyXml(rawXml ?? '');

    // 1. Empty result. An `<ENVELOPE></ENVELOPE>` (or self-closed) reply means
    //    "zero records in range" and is a perfectly valid, successful response.
    if (this.isEmptyEnvelope(xml)) {
      return { envelope: {}, meta: { isEmpty: true } };
    }

    // 2. Sanity guard: it must actually be a Tally ENVELOPE. Anything else on
    //    port 9001 (an HTML error page from a proxy, a plain-text "Connection
    //    refused", another web server) would otherwise be parsed leniently into
    //    junk and silently return zero records — masking a misconfiguration.
    if (!/<ENVELOPE[\s>]/i.test(xml)) {
      throw new TallyResponseException(
        'unexpected response — not a Tally ENVELOPE (is another server listening on this port?)',
      );
    }

    // 3. Fast-path error detection straight off the raw string, so we still
    //    surface a useful message even if the surrounding XML is malformed.
    const rawError = this.extractLineError(xml);
    if (rawError) {
      throw new TallyResponseException(rawError);
    }

    // 3. Structured parse.
    let tree: any;
    try {
      tree = this.parser.parse(xml);
    } catch (err) {
      const snippet = xml.slice(0, 300);
      this.logger.error(`Failed to parse Tally XML. First 300 chars: ${snippet}`);
      throw new TallyResponseException('response was not valid XML', err);
    }

    const envelope = tree?.ENVELOPE ?? tree ?? {};

    // 4. Error that only surfaces after parsing (nested LINEERROR / DESC).
    const parsedError = this.findParsedError(envelope);
    if (parsedError) {
      throw new TallyResponseException(parsedError);
    }

    const isEmpty = envelope == null || (typeof envelope === 'object' && !envelope.BODY);
    return { envelope, meta: { isEmpty } };
  }

  // ── Domain mappers ────────────────────────────────────────────────────────

  mapCompanies(rawXml: string): TallyCompany[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    const items = this.collectionItems(envelope, 'COMPANY');
    return items.map((c) => ({
      name: readText(c?.NAME) ?? readText(c?.['@_NAME']) ?? '',
      startingFrom: readText(c?.STARTINGFROM),
      booksFrom: readText(c?.BOOKSFROM),
      guid: readText(c?.GUID),
    }));
  }

  mapLedgers(rawXml: string): TallyLedger[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    const items = this.collectionItems(envelope, 'LEDGER');
    return items.map((l) => ({
      name: readText(l?.NAME) ?? readText(l?.['@_NAME']) ?? '',
      parent: readText(l?.PARENT),
      description: readText(l?.DESCRIPTION),
      openingBalance: parseTallyAmount(readText(l?.OPENINGBALANCE)),
      closingBalance: parseTallyAmount(readText(l?.CLOSINGBALANCE)),
      alterId: readInt(l?.ALTERID),
      // Tally always emits this as an XML attribute on <LEDGER>, empty for
      // ordinary ledgers — see TallyLedger.reservedName's doc comment.
      reservedName: readText(l?.['@_RESERVEDNAME']) || null,
      // Best-effort field names — see TallyLedger's doc comment and
      // EnvelopeBuilder.buildLedgersRequest's TODO. A tag Tally doesn't
      // recognize simply isn't present in `l`, so readText/toArray already
      // degrade to null/[] here with no extra handling needed.
      gstin: readText(l?.GSTREGISTRATIONNUMBER),
      panNumber: readText(l?.INCOMETAXNUMBER),
      email: readText(l?.EMAIL),
      phone: readText(l?.LEDGERPHONE),
      mobile: readText(l?.LEDGERMOBILE),
      billingAddress: this.readAddressList(l?.['ADDRESS.LIST']),
      billingState: readText(l?.LEDSTATENAME),
      billingCountry: readText(l?.COUNTRYNAME),
      billingPincode: readText(l?.PINCODE),
      bankName: readText(this.firstBankDetail(l)?.BANKNAME),
      bankAccountNumber: readText(this.firstBankDetail(l)?.BANKACCOUNTNUMBER),
    }));
  }

  /** ADDRESS.LIST is a single wrapper tag whose ADDRESS child repeats one
   *  entry per line — confirmed against fast-xml-parser's actual output
   *  (`{ "ADDRESS.LIST": { "ADDRESS": ["line1", "line2"] } }`), unlike
   *  BANKDETAILS.LIST below, which repeats as sibling tags. Joined with a
   *  newline into the single billingAddress field callers actually want. */
  private readAddressList(addressList: unknown): string | null {
    const container = addressList as { ADDRESS?: unknown } | null | undefined;
    const lines = toArray<unknown>(container?.ADDRESS)
      .map((line) => readText(line))
      .filter((line): line is string => line !== null);
    return lines.length > 0 ? lines.join('\n') : null;
  }

  /** A ledger can have multiple bank accounts on file; the first is the best
   *  single value this project's flat Vendor.xlsx row (one bank name/account
   *  number column each) can represent. */
  private firstBankDetail(ledger: any): any {
    return toArray<any>(ledger?.['BANKDETAILS.LIST'])[0];
  }

  mapGroups(rawXml: string): TallyGroup[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    const items = this.collectionItems(envelope, 'GROUP');
    return items.map((g) => ({
      name: readText(g?.NAME) ?? readText(g?.['@_NAME']) ?? '',
      parent: readText(g?.PARENT),
      alterId: readInt(g?.ALTERID),
    }));
  }

  mapCostCentres(rawXml: string): TallyCostCentre[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    const items = this.collectionItems(envelope, 'COSTCENTRE');
    return items.map((c) => ({
      name: readText(c?.NAME) ?? readText(c?.['@_NAME']) ?? '',
      parent: readText(c?.PARENT),
      alterId: readInt(c?.ALTERID),
    }));
  }

  mapStockItems(rawXml: string): TallyStockItem[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    const items = this.collectionItems(envelope, 'STOCKITEM');
    return items.map((s) => ({
      name: readText(s?.NAME) ?? readText(s?.['@_NAME']) ?? '',
      parent: readText(s?.PARENT),
      description: readText(s?.DESCRIPTION),
      baseUnit: readText(s?.BASEUNITS),
      openingBalance: parseTallyAmount(readText(s?.OPENINGBALANCE)),
      openingValue: parseTallyAmount(readText(s?.OPENINGVALUE)),
      closingBalance: parseTallyAmount(readText(s?.CLOSINGBALANCE)),
      closingValue: parseTallyAmount(readText(s?.CLOSINGVALUE)),
      alterId: readInt(s?.ALTERID),
      // Best-effort field names — see TallyStockItem's doc comment.
      alias: readText(s?.ALIAS),
      hsnCode: readText(s?.HSNCODE),
      gstRate: parseTallyAmount(readText(s?.GSTRATE)),
    }));
  }

  mapVouchers(rawXml: string): TallyVoucher[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    // Day Book / Voucher Register exports (REQUESTDESC-style report requests)
    // come back wrapped as if they were an importable payload — Tally reuses
    // its "Import Data" XML schema for this export, so records land under
    // BODY.IMPORTDATA.REQUESTDATA.TALLYMESSAGE, not BODY.DATA.TALLYMESSAGE
    // (that shape is what Collection-style requests return — see
    // collectionItems below). Checked first since it's what a live TallyPrime
    // instance actually sends; BODY.DATA kept as a fallback in case an older
    // Tally.ERP9 build or a differently-configured report answers the other
    // way. A message may also carry a master (not a voucher), so we only keep
    // the ones that actually contain a <VOUCHER>.
    const data =
      this.get(envelope, ['BODY', 'IMPORTDATA', 'REQUESTDATA']) ??
      this.get(envelope, ['BODY', 'DATA']);
    const messages = toArray<any>(data?.TALLYMESSAGE);

    const vouchers: TallyVoucher[] = [];
    for (const msg of messages) {
      for (const v of toArray<any>(msg?.VOUCHER)) {
        vouchers.push(this.mapVoucher(v));
      }
    }
    return vouchers;
  }

  private mapVoucher(v: any): TallyVoucher {
    const ledgerEntries: TallyLedgerEntry[] = toArray<any>(v?.['ALLLEDGERENTRIES.LIST'])
      // Some exports use LEDGERENTRIES.LIST instead — fall back to it.
      .concat(v?.['ALLLEDGERENTRIES.LIST'] ? [] : toArray<any>(v?.['LEDGERENTRIES.LIST']))
      .map((e) => {
        const amount = parseTallyAmount(readText(e?.AMOUNT));
        const isDeemedPositive = readYesNo(e?.ISDEEMEDPOSITIVE);
        return {
          ledgerName: readText(e?.LEDGERNAME) ?? '',
          amount,
          isDeemedPositive,
          isDebit: this.resolveIsDebit(amount, isDeemedPositive),
        };
      });

    const inventoryEntries: TallyInventoryEntry[] = toArray<any>(v?.['ALLINVENTORYENTRIES.LIST'])
      .concat(v?.['ALLINVENTORYENTRIES.LIST'] ? [] : toArray<any>(v?.['INVENTORYENTRIES.LIST']))
      .map((e) => ({
        stockItemName: readText(e?.STOCKITEMNAME) ?? '',
        quantity: parseTallyAmount(readText(e?.ACTUALQTY) ?? readText(e?.BILLEDQTY)),
        rate: parseTallyAmount(readText(e?.RATE)),
        amount: parseTallyAmount(readText(e?.AMOUNT)),
      }));

    return {
      date: readText(v?.DATE),
      voucherType: readText(v?.VOUCHERTYPENAME) ?? readText(v?.['@_VCHTYPE']),
      voucherNumber: readText(v?.VOUCHERNUMBER),
      partyLedgerName: readText(v?.PARTYLEDGERNAME),
      narration: readText(v?.NARRATION),
      reference: readText(v?.REFERENCE),
      alterId: readInt(v?.ALTERID),
      ledgerEntries,
      inventoryEntries,
      partyGstin: readText(v?.PARTYGSTIN),
      placeOfSupply: readText(v?.PLACEOFSUPPLY),
    };
  }

  /**
   * Dr/Cr resolution. Tally's AMOUNT sign is only meaningful alongside
   * ISDEEMEDPOSITIVE, so never assume "negative == credit":
   *   - deemed-positive ledgers (party in a sale): negative amount == debit.
   *   - We therefore key off ISDEEMEDPOSITIVE when present, and fall back to the
   *     raw sign only when the flag is missing.
   */
  private resolveIsDebit(amount: number | null, isDeemedPositive: boolean | null): boolean | null {
    if (isDeemedPositive !== null) {
      // Convention: a deemed-positive line with a negative amount is a debit.
      if (amount === null) return isDeemedPositive ? false : true;
      return amount < 0;
    }
    if (amount === null) return null;
    return amount < 0; // best-effort fallback
  }

  // ── Navigation helpers ────────────────────────────────────────────────────

  /** Safe nested get across an all-uppercase Tally tag path. */
  private get(obj: any, path: string[]): any {
    return path.reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
  }

  /**
   * Pull the array of objects out of a collection response, regardless of
   * whether Tally nested them under BODY.DATA.COLLECTION or returned a single
   * object vs many.
   */
  private collectionItems(envelope: any, objectTag: string): any[] {
    const collection =
      this.get(envelope, ['BODY', 'DATA', 'COLLECTION']) ??
      this.get(envelope, ['BODY', 'DATA']) ??
      {};
    // Collection may itself be an array (rare) — flatten.
    const collections = toArray<any>(collection);
    const items: any[] = [];
    for (const col of collections) {
      items.push(...toArray<any>(col?.[objectTag]));
    }
    return items;
  }

  // ── Empty / error detection ───────────────────────────────────────────────

  private isEmptyEnvelope(xml: string): boolean {
    const stripped = xml.replace(/<\?xml[^>]*\?>/i, '').trim();
    return /^<ENVELOPE\s*\/>$/i.test(stripped) || /^<ENVELOPE\s*>\s*<\/ENVELOPE>$/i.test(stripped);
  }

  /** Regex scan for <LINEERROR> before/independent of a full parse. */
  private extractLineError(xml: string): string | null {
    const m = xml.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i);
    return m ? m[1].trim() : null;
  }

  /** Structured error lookup after parsing. */
  private findParsedError(envelope: any): string | null {
    const desc = this.get(envelope, ['BODY', 'DESC']);
    const lineError = readText(desc?.LINEERROR);
    if (lineError) return lineError;

    // Some builds report failures via HEADER.STATUS=0 with a DESC message.
    const status = readText(this.get(envelope, ['HEADER', 'STATUS']));
    if (status === '0') {
      const respDesc = readText(this.get(envelope, ['BODY', 'DESC', 'CMPINFO'])) ?? null;
      if (respDesc) return `status 0 (${respDesc})`;
    }
    return null;
  }
}
