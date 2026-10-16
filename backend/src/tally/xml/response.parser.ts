import { Injectable, Logger } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import { TallyResponseException } from '../exceptions/tally.exceptions';
import {
  TallyCompany,
  TallyCostCategory,
  TallyCostCentre,
  TallyCurrency,
  TallyGodown,
  TallyGroup,
  TallyInventoryEntry,
  TallyLedger,
  TallyLedgerEntry,
  TallyResponseMeta,
  TallyStockCategory,
  TallyStockGroup,
  TallyStockItem,
  TallyUnit,
  TallyVoucher,
  TallyVoucherType,
} from '../interfaces/tally.interfaces';
import {
  parseTallyAmount,
  parseTallyForeignAmount,
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
    return items.map((l) => {
      const payment = this.readPaymentDetails(l?.['PAYMENTDETAILS.LIST']);
      const gstReg = this.readLatestGstRegDetails(l?.['LEDGSTREGDETAILS.LIST']);
      return {
        name: readText(l?.NAME) ?? readText(l?.['@_NAME']) ?? '',
        parent: readText(l?.PARENT),
        description: readText(l?.DESCRIPTION),
        openingBalance: parseTallyAmount(readText(l?.OPENINGBALANCE)),
        closingBalance: parseTallyAmount(readText(l?.CLOSINGBALANCE)),
        alterId: readInt(l?.ALTERID),
        // Tally always emits this as an XML attribute on <LEDGER>, empty for
        // ordinary ledgers — see TallyLedger.reservedName's doc comment.
        reservedName: readText(l?.['@_RESERVEDNAME']) || null,
        // Field names verified live 2026-08-22 against a real Tally instance
        // — see EnvelopeBuilder.buildLedgersRequest's doc comment for exactly
        // what was wrong (GSTIN, BankDetails) vs. confirmed correct.
        gstin: gstReg.gstin,
        // See TallyLedger.gstRegistrationType/gstPlaceOfSupply's doc comments.
        gstRegistrationType: gstReg.registrationType,
        gstPlaceOfSupply: gstReg.placeOfSupply,
        panNumber: readText(l?.INCOMETAXNUMBER),
        email: readText(l?.EMAIL),
        phone: readText(l?.LEDGERPHONE),
        mobile: readText(l?.LEDGERMOBILE),
        billingAddress: this.readAddressList(l?.['ADDRESS.LIST']),
        billingState: readText(l?.LEDSTATENAME),
        billingCountry: readText(l?.COUNTRYNAME),
        billingPincode: readText(l?.PINCODE),
        // VERIFIED live 2026-09-05 (452 real Sundry Creditor ledgers) — see
        // EnvelopeBuilder.buildLedgersRequest's doc comment: a vendor's real
        // payment bank details live in PAYMENTDETAILS.LIST, not the legacy
        // flat BANKDETAILS field (dead on this Tally version). Falls back to
        // BANKDETAILS for the account number when the list is empty, in case
        // an older Tally build or a company that never adopted e-payment
        // setup still only has the legacy field.
        bankName: payment.bankName,
        bankAccountNumber: payment.accountNumber ?? readText(l?.BANKDETAILS),
        website: readText(l?.WEBSITE),
        creditLimit: parseTallyAmount(readText(l?.CREDITLIMIT)),
        contactPersonName: readText(l?.LEDGERCONTACT),
        // See TallyLedger.mailingName/creditPeriod's doc comments.
        mailingName: readText(l?.MAILINGNAME),
        creditPeriod: readText(l?.BILLCREDITPERIOD),
      };
    });
  }

  /**
   * PAYMENTDETAILS.LIST is a REPEATING list — a vendor can have more than
   * one bank account on file. Each entry carries BANKNAME/ACCOUNTNUMBER/
   * IFSCODE/PAYMENTFAVOURING/TRANSACTIONNAME; TRANSACTIONNAME "Primary"
   * marks the one Tally itself treats as the default for that ledger
   * (confirmed against real data), so that entry wins when present —
   * falling back to the first entry otherwise, never fabricating a
   * preference among equals.
   *
   */
  private readPaymentDetails(paymentDetailsList: unknown): {
    bankName: string | null;
    accountNumber: string | null;
  } {
    const entries = toArray<any>(paymentDetailsList);
    if (entries.length === 0) return { bankName: null, accountNumber: null };
    const primary =
      entries.find((e) => (readText(e?.TRANSACTIONNAME) ?? '').toLowerCase() === 'primary') ??
      entries[0];
    return {
      bankName: readText(primary?.BANKNAME),
      accountNumber: readText(primary?.ACCOUNTNUMBER),
    };
  }

  /** ADDRESS.LIST is a single wrapper tag whose ADDRESS child repeats one
   *  entry per line — confirmed against fast-xml-parser's actual output
   *  (`{ "ADDRESS.LIST": { "ADDRESS": ["line1", "line2"] } }`). Joined with
   *  a newline into the single billingAddress field callers actually want. */
  private readAddressList(addressList: unknown): string | null {
    const container = addressList as { ADDRESS?: unknown } | null | undefined;
    const lines = toArray<unknown>(container?.ADDRESS)
      .map((line) => readText(line))
      .filter((line): line is string => line !== null);
    return lines.length > 0 ? lines.join('\n') : null;
  }

  /**
   * LEDGSTREGDETAILS.LIST is a REPEATING list of a party's GST
   * registrations over time (state changes, re-registrations) — confirmed
   * live against a real ledger carrying two entries, one from before its
   * GST registration (no GSTIN) and one after (with it). Not every entry
   * has a GSTIN, and Tally lists them chronologically, so the correct
   * current value is the GSTIN on the LAST entry that actually has one, not
   * just the last entry outright. Each entry also carries
   * GSTREGISTRATIONTYPE/PLACEOFSUPPLY alongside GSTIN — added 2026-09-10,
   * VERIFIED live (see TallyLedger.gstRegistrationType/gstPlaceOfSupply's
   * doc comments) — read from that same GSTIN-bearing entry so all three
   * values describe the same registration, not three different ones. When
   * no entry has a GSTIN at all (e.g. an unregistered party), falls back to
   * the last entry that at least has a registration type, so
   * "Unregistered/Consumer" ledgers (which by definition never have a
   * GSTIN) still get a real registrationType instead of null.
   */
  private readLatestGstRegDetails(gstRegDetails: unknown): {
    gstin: string | null;
    registrationType: string | null;
    placeOfSupply: string | null;
  } {
    const entries = toArray<any>(gstRegDetails);
    for (let i = entries.length - 1; i >= 0; i--) {
      const gstin = readText(entries[i]?.GSTIN);
      if (gstin) {
        return {
          gstin,
          registrationType: readText(entries[i]?.GSTREGISTRATIONTYPE),
          placeOfSupply: readText(entries[i]?.PLACEOFSUPPLY),
        };
      }
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const registrationType = readText(entries[i]?.GSTREGISTRATIONTYPE);
      if (registrationType) {
        return { gstin: null, registrationType, placeOfSupply: readText(entries[i]?.PLACEOFSUPPLY) };
      }
    }
    return { gstin: null, registrationType: null, placeOfSupply: null };
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

  /** See TallyStockGroup's doc comment — VERIFIED live (0 real records on
   *  this company, a valid empty Collection, not an error). */
  mapStockGroups(rawXml: string): TallyStockGroup[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    const items = this.collectionItems(envelope, 'STOCKGROUP');
    return items.map((g) => ({
      name: readText(g?.NAME) ?? readText(g?.['@_NAME']) ?? '',
      parent: readText(g?.PARENT),
      alterId: readInt(g?.ALTERID),
    }));
  }

  /** See TallyStockCategory's doc comment — VERIFIED live (0 real records on
   *  this company, a valid empty Collection, not an error). */
  mapStockCategories(rawXml: string): TallyStockCategory[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    const items = this.collectionItems(envelope, 'STOCKCATEGORY');
    return items.map((c) => ({
      name: readText(c?.NAME) ?? readText(c?.['@_NAME']) ?? '',
      parent: readText(c?.PARENT),
      alterId: readInt(c?.ALTERID),
    }));
  }

  /** See TallyUnit's doc comment — VERIFIED live (7 real units). */
  mapUnits(rawXml: string): TallyUnit[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    const items = this.collectionItems(envelope, 'UNIT');
    return items.map((u) => ({
      name: readText(u?.NAME) ?? readText(u?.['@_NAME']) ?? '',
      originalName: readText(u?.ORIGINALNAME),
      isSimpleUnit: readYesNo(u?.ISSIMPLEUNIT),
      decimalPlaces: readInt(u?.DECIMALPLACES),
      alterId: readInt(u?.ALTERID),
    }));
  }

  /** See TallyCurrency's doc comment — VERIFIED live (3 real currencies:
   *  INR/USD/UAE Dirham). */
  mapCurrencies(rawXml: string): TallyCurrency[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    const items = this.collectionItems(envelope, 'CURRENCY');
    return items.map((c) => ({
      name: readText(c?.NAME) ?? readText(c?.['@_NAME']) ?? '',
      originalName: readText(c?.ORIGINALNAME),
      expandedSymbol: readText(c?.EXPANDEDSYMBOL),
      decimalPlaces: readInt(c?.DECIMALPLACES),
      alterId: readInt(c?.ALTERID),
    }));
  }

  /** See TallyGodown's doc comment — VERIFIED live (1 real Godown, the
   *  Tally-created default "Main Location"). */
  mapGodowns(rawXml: string): TallyGodown[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    const items = this.collectionItems(envelope, 'GODOWN');
    return items.map((g) => ({
      name: readText(g?.NAME) ?? readText(g?.['@_NAME']) ?? '',
      parent: readText(g?.PARENT),
      alterId: readInt(g?.ALTERID),
    }));
  }

  /** See TallyCostCategory's doc comment — VERIFIED live (1 real Cost
   *  Category, the Tally-created default "Primary Cost Category"). */
  mapCostCategories(rawXml: string): TallyCostCategory[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    const items = this.collectionItems(envelope, 'COSTCATEGORY');
    return items.map((c) => ({
      name: readText(c?.NAME) ?? readText(c?.['@_NAME']) ?? '',
      alterId: readInt(c?.ALTERID),
    }));
  }

  /** See TallyVoucherType's doc comment — VERIFIED live (24 real Voucher
   *  Types, every standard Tally type, no custom ones). */
  mapVoucherTypes(rawXml: string): TallyVoucherType[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    const items = this.collectionItems(envelope, 'VOUCHERTYPE');
    return items.map((v) => ({
      name: readText(v?.NAME) ?? readText(v?.['@_NAME']) ?? '',
      parent: readText(v?.PARENT),
      alterId: readInt(v?.ALTERID),
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
      // ALIAS is still a best-effort flat field name — see TallyStockItem's
      // doc comment; HSN/GST fields below are VERIFIED (see
      // EnvelopeBuilder.buildStockItemsRequest's doc comment for the full
      // live-verification evidence).
      alias: readText(s?.ALIAS),
      hsnCode: this.readLatestHsn(s?.['HSNDETAILS.LIST']),
      ...this.readLatestGstDetails(s?.['GSTDETAILS.LIST']),
      // See TallyStockItem.itemType's doc comment.
      itemType: this.readItemType(s?.GSTTYPEOFSUPPLY),
      // See TallyStockItem.inventoryValuationMethod/salesAccount/
      // purchaseAccount's doc comments.
      inventoryValuationMethod: readText(s?.COSTINGMETHOD),
      // Reuses readPrimaryAccountLedger's "first entry's LEDGERNAME"
      // convention — already independently verified live for
      // ACCOUNTINGALLOCATIONS.LIST elsewhere in this file.
      salesAccount: this.readPrimaryAccountLedger(s?.['SALESLIST.LIST']),
      purchaseAccount: this.readPrimaryAccountLedger(s?.['PURCHASELIST.LIST']),
    }));
  }

  /** GSTTYPEOFSUPPLY — a flat scalar, "Goods"/"Services"/blank. See
   *  TallyStockItem.itemType's doc comment for the live evidence. */
  private readItemType(value: unknown): 'goods' | 'service' | null {
    const text = readText(value);
    if (!text) return null;
    if (text.toLowerCase() === 'services') return 'service';
    if (text.toLowerCase() === 'goods') return 'goods';
    return null;
  }

  /**
   * HSNDETAILS.LIST is a REPEATING, date-effective list — same shape/
   * reasoning as LEDGSTREGDETAILS.LIST (readLatestGstin below): an item's
   * HSN classification can change over time (APPLICABLEFROM), so the
   * correct current value is the HSNCODE on the LAST entry that actually
   * has one, not just whichever entry happens to be last in the list.
   */
  private readLatestHsn(hsnDetailsList: unknown): string | null {
    const entries = toArray<any>(hsnDetailsList);
    for (let i = entries.length - 1; i >= 0; i--) {
      const code = readText(entries[i]?.HSNCODE);
      if (code) return code;
    }
    return null;
  }

  /**
   * GSTDETAILS.LIST mirrors HSNDETAILS.LIST's date-effective-list shape one
   * level deeper: each entry holds a STATEWISEDETAILS.LIST (a generic "Any"
   * entry plus optional per-state rate overrides), each of THOSE holding a
   * RATEDETAILS.LIST (one row per duty head — CGST/SGST-UTGST/IGST/Cess/
   * State Cess). This project only needs a single combined percentage (see
   * TallyStockItem.gstRate's doc comment: GST law keeps IGST equal to
   * CGST+SGST for the same HSN, confirmed against real data — a live item
   * carried CGST 9 + SGST/UTGST 9 alongside IGST 18), so IGST is read
   * directly rather than summing the other two. The generic "Any" state
   * entry is preferred over a state-specific override — this project has
   * no single "seller's home state" concept to pick the right override with
   * (same documented limitation as bill.mapper.ts/invoice.mapper.ts's
   * Intra/Inter State simplification) — falling back to whichever state
   * entry IS present for the rare item configured with only a
   * state-specific rate and no generic default.
   */
  private readLatestGstDetails(gstDetailsList: unknown): {
    gstRate: number | null;
    gstTaxability: string | null;
    itcIneligible: boolean | null;
  } {
    const entries = toArray<any>(gstDetailsList);
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      // TAXABILITY is present on every real GSTDETAILS.LIST entry (Taxable
      // or Exempt, confirmed live 2026-09-05 across 35 real items) — used as
      // this entry's "is this the real, current one" signal, since an
      // Exempt item correctly has no rate at all (a rate-only check would
      // wrongly skip past it looking for a nonzero value elsewhere).
      const taxability = readText(entry?.TAXABILITY);
      if (!taxability) continue;
      const stateWiseEntries = toArray<any>(entry?.['STATEWISEDETAILS.LIST']);
      const stateWise =
        stateWiseEntries.find((sw) => readText(sw?.STATENAME) === 'Any') ?? stateWiseEntries[0];
      const rateDetails = toArray<any>(stateWise?.['RATEDETAILS.LIST']);
      const igst = rateDetails.find((r) => readText(r?.GSTRATEDUTYHEAD) === 'IGST');
      return {
        gstRate: parseTallyAmount(readText(igst?.GSTRATE)),
        gstTaxability: taxability,
        // GSTINELIGIBLEITC — Tally flags ITC-INeligible; confirmed live on a
        // real Exempt item (Yes). Powers Bill.xlsx's "ITC Eligibility"
        // column, inverted by the mapper (see bill.mapper.ts).
        itcIneligible: readYesNo(entry?.GSTINELIGIBLEITC),
      };
    }
    return { gstRate: null, gstTaxability: null, itcIneligible: null };
  }

  mapVouchers(rawXml: string): TallyVoucher[] {
    const { envelope, meta } = this.parse(rawXml);
    if (meta.isEmpty) return [];

    // Two possible response shapes, mutually exclusive in practice (each
    // branch finds nothing under the other's path, so running both never
    // double-counts):
    //
    // 1. Report-export shape (a REQUESTDESC-style request, e.g. the old Day
    //    Book export, or the /tally/raw escape hatch aimed at a report) comes
    //    back wrapped as if it were an importable payload — Tally reuses its
    //    "Import Data" XML schema, so records land under
    //    BODY.IMPORTDATA.REQUESTDATA.TALLYMESSAGE.VOUCHER (BODY.DATA.
    //    TALLYMESSAGE kept as a fallback for an older Tally.ERP9 build/
    //    differently-configured report that answers the other way — see this
    //    method's tests). A message may also carry a master (not a voucher),
    //    so only ones that actually contain a <VOUCHER> are kept.
    // 2. Collection-export shape — what EnvelopeBuilder.buildVouchersRequest
    //    actually sends today (a TYPE=Voucher Collection, not a report — see
    //    its doc comment for why). <VOUCHER> sits directly under
    //    BODY.DATA.COLLECTION, no TALLYMESSAGE wrapper at all — the same
    //    shape every other Collection-based master fetch (mapLedgers/
    //    mapGroups/...) already reads via collectionItems.
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
    for (const v of this.collectionItems(envelope, 'VOUCHER')) {
      vouchers.push(this.mapVoucher(v));
    }
    return vouchers;
  }

  private mapVoucher(v: any): TallyVoucher {
    const foreignByEntry = new Map<object, ReturnType<typeof parseTallyForeignAmount>>();

    const ledgerEntries: TallyLedgerEntry[] = toArray<any>(v?.['ALLLEDGERENTRIES.LIST'])
      // Some exports use LEDGERENTRIES.LIST instead — fall back to it.
      .concat(v?.['ALLLEDGERENTRIES.LIST'] ? [] : toArray<any>(v?.['LEDGERENTRIES.LIST']))
      // A genuinely empty <…LIST></…LIST> tag (a real voucher with zero
      // entries of this kind) parses to '' via fast-xml-parser, not
      // undefined — toArray('') then wrongly produces a phantom one-element
      // array holding a bare string. VERIFIED live 2026-09-05: every one of
      // this project's real ledger-only Sales vouchers (no stock items) came
      // back with exactly this shape for ALLINVENTORYENTRIES.LIST, silently
      // misclassifying a service invoice as item-based (blank Item
      // Name/Account instead of the correct ledger-derived fallback — see
      // invoice.mapper.ts/bill.mapper.ts's service-row branch). Filtering to
      // real objects here fixes both lists at the source instead of pushing
      // an empty-string check into every mapper.
      .filter((e) => e !== null && typeof e === 'object')
      .map((e) => {
        const foreign = parseTallyForeignAmount(readText(e?.AMOUNT));
        foreignByEntry.set(e, foreign);
        const amount = foreign.amount;
        const isDeemedPositive = readYesNo(e?.ISDEEMEDPOSITIVE);
        return {
          ledgerName: readText(e?.LEDGERNAME) ?? '',
          amount,
          isDeemedPositive,
          isDebit: this.resolveIsDebit(amount, isDeemedPositive),
          billCreditPeriodDays: this.readBillCreditPeriod(e?.['BILLALLOCATIONS.LIST']),
        };
      });

    const inventoryEntries: TallyInventoryEntry[] = toArray<any>(v?.['ALLINVENTORYENTRIES.LIST'])
      .concat(v?.['ALLINVENTORYENTRIES.LIST'] ? [] : toArray<any>(v?.['INVENTORYENTRIES.LIST']))
      // See ledgerEntries' identical filter above — the same empty-tag-to-
      // phantom-entry bug, confirmed live on this same field.
      .filter((e) => e !== null && typeof e === 'object')
      .map((e) => ({
        stockItemName: readText(e?.STOCKITEMNAME) ?? '',
        quantity: parseTallyAmount(readText(e?.ACTUALQTY) ?? readText(e?.BILLEDQTY)),
        rate: parseTallyForeignAmount(readText(e?.RATE)).amount,
        amount: parseTallyForeignAmount(readText(e?.AMOUNT)).amount,
        discountPercent: parseTallyAmount(readText(e?.DISCOUNT)),
        accountLedgerName: this.readPrimaryAccountLedger(e?.['ACCOUNTINGALLOCATIONS.LIST']),
      }));

    const partyLedgerName = readText(v?.PARTYLEDGERNAME);
    const currency = this.detectVoucherCurrency(foreignByEntry, partyLedgerName);

    return {
      date: readText(v?.DATE),
      voucherType: readText(v?.VOUCHERTYPENAME) ?? readText(v?.['@_VCHTYPE']),
      voucherNumber: readText(v?.VOUCHERNUMBER),
      partyLedgerName,
      narration: readText(v?.NARRATION),
      reference: readText(v?.REFERENCE),
      alterId: readInt(v?.ALTERID),
      ledgerEntries,
      inventoryEntries,
      partyGstin: readText(v?.PARTYGSTIN),
      // ConsigneeStateName fallback added 2026-09-05, VERIFIED live — see
      // EnvelopeBuilder.buildVouchersRequest's doc comment: several real
      // export vouchers have a blank PlaceOfSupply but a populated
      // ConsigneeStateName (the GST e-invoice ship-to state).
      placeOfSupply: readText(v?.PLACEOFSUPPLY) ?? readText(v?.CONSIGNEESTATENAME),
      // See TallyVoucher.partyGstRegistrationType/gstRegistration's doc comments.
      partyGstRegistrationType: readText(v?.GSTREGISTRATIONTYPE),
      gstRegistration: readText(v?.GSTREGISTRATION),
      currencyCode: currency.currencyCode,
      exchangeRate: currency.exchangeRate,
    };
  }

  /**
   * BILLALLOCATIONS.LIST is a REPEATING list (a ledger entry can span
   * multiple bills — part-payments, adjustments) — added 2026-09-05. Takes
   * the first entry that actually carries a credit period rather than
   * summing/averaging across bills, since Zoho's Due Date is a single
   * voucher-level value; real data for this project's test company never
   * populates this field at all (see TallyLedgerEntry.billCreditPeriodDays's
   * doc comment), so this is unverified against a genuinely non-empty case.
   */
  private readBillCreditPeriod(billAllocations: unknown): number | null {
    const entries = toArray<any>(billAllocations);
    for (const entry of entries) {
      const days = readInt(entry?.BILLCREDITPERIOD);
      if (days !== null) return days;
    }
    return null;
  }

  /**
   * ACCOUNTINGALLOCATIONS.LIST is a REPEATING list (an inventory line can
   * split its value across more than one ledger, e.g. a partial discount
   * ledger) — added 2026-09-05, VERIFIED live. The first entry is this
   * line's primary posted account; a full multi-ledger breakdown has no
   * single Zoho "Account" column to hold it anyway.
   */
  private readPrimaryAccountLedger(accountingAllocations: unknown): string | null {
    const entries = toArray<any>(accountingAllocations);
    return readText(entries[0]?.LEDGERNAME);
  }

  /**
   * Added 2026-09-05 alongside parseTallyForeignAmount. Prefers the party
   * ledger entry (the one line every voucher has, representing the total)
   * when it resolved a foreign currency; falls back to the first OTHER
   * entry that did, since a voucher's party line can itself be domestic
   * while a specific expense/income line is genuinely foreign (e.g. a
   * dollar-denominated subscription booked against an INR party ledger).
   * Returns {null, null} — "assume INR" — when nothing in the voucher
   * carried a recognized foreign symbol.
   */
  private detectVoucherCurrency(
    foreignByEntry: Map<object, ReturnType<typeof parseTallyForeignAmount>>,
    partyLedgerName: string | null,
  ): { currencyCode: string | null; exchangeRate: number | null } {
    let partyMatch: ReturnType<typeof parseTallyForeignAmount> | null = null;
    for (const [entry, foreign] of foreignByEntry) {
      if (foreign.currencyCode === null) continue;
      if (partyLedgerName && readText((entry as any)?.LEDGERNAME) === partyLedgerName) {
        partyMatch = foreign;
        break;
      }
      if (!partyMatch) partyMatch = foreign;
    }
    return partyMatch
      ? { currencyCode: partyMatch.currencyCode, exchangeRate: partyMatch.exchangeRate }
      : { currencyCode: null, exchangeRate: null };
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
