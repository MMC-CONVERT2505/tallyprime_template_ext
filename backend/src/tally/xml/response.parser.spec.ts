import { TallyResponseException } from '../exceptions/tally.exceptions';
import { TallyResponseParser } from './response.parser';

describe('TallyResponseParser', () => {
  let parser: TallyResponseParser;

  beforeEach(() => {
    parser = new TallyResponseParser();
  });

  describe('empty responses', () => {
    it('treats <ENVELOPE></ENVELOPE> as zero records, not an error', () => {
      expect(parser.parse('<ENVELOPE></ENVELOPE>').meta.isEmpty).toBe(true);
      expect(parser.mapVouchers('<ENVELOPE></ENVELOPE>')).toEqual([]);
      expect(parser.mapCompanies('<ENVELOPE></ENVELOPE>')).toEqual([]);
      expect(parser.mapLedgers('<ENVELOPE></ENVELOPE>')).toEqual([]);
    });

    it('treats a self-closed <ENVELOPE/> (with declaration) as empty', () => {
      const xml = '<?xml version="1.0" encoding="UTF-8"?><ENVELOPE/>';
      expect(parser.parse(xml).meta.isEmpty).toBe(true);
    });
  });

  describe('error responses', () => {
    it('throws on a <LINEERROR> payload returned with HTTP 200', () => {
      const xml =
        '<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER>' +
        "<BODY><DESC><LINEERROR>Could not find Report 'XYZ'!</LINEERROR></DESC></BODY></ENVELOPE>";
      expect(() => parser.parse(xml)).toThrow(TallyResponseException);
      expect(() => parser.parse(xml)).toThrow(/Could not find Report/);
    });

    it('throws when the response is not a Tally envelope (wrong server on the port)', () => {
      expect(() => parser.parse('<html><body>502 Bad Gateway</body></html>')).toThrow(
        TallyResponseException,
      );
      expect(() => parser.parse('Connection refused')).toThrow(TallyResponseException);
    });
  });

  describe('mapCompanies', () => {
    it('handles a single company (object, not array)', () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION>' +
        '<COMPANY><NAME>ABC Ltd</NAME><STARTINGFROM>20240401</STARTINGFROM></COMPANY>' +
        '</COLLECTION></DATA></BODY></ENVELOPE>';
      const companies = parser.mapCompanies(xml);
      expect(companies).toHaveLength(1);
      expect(companies[0]).toMatchObject({ name: 'ABC Ltd', startingFrom: '20240401' });
    });

    it('handles multiple companies (array)', () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION>' +
        '<COMPANY><NAME>ABC Ltd</NAME></COMPANY>' +
        '<COMPANY><NAME>XYZ &amp; Sons</NAME></COMPANY>' +
        '</COLLECTION></DATA></BODY></ENVELOPE>';
      const companies = parser.mapCompanies(xml);
      expect(companies.map((c) => c.name)).toEqual(['ABC Ltd', 'XYZ & Sons']);
    });
  });

  describe('mapLedgers', () => {
    it('parses description, balances and AlterID, tolerating omitted tags', () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION>' +
        '<LEDGER><NAME>Cash</NAME><PARENT>Cash-in-Hand</PARENT><DESCRIPTION>Petty cash</DESCRIPTION>' +
        '<OPENINGBALANCE>1000.00</OPENINGBALANCE><CLOSINGBALANCE>-2500.50</CLOSINGBALANCE><ALTERID>42</ALTERID></LEDGER>' +
        '<LEDGER><NAME>Sales</NAME></LEDGER>' + // no parent/description/balances/alterid
        '</COLLECTION></DATA></BODY></ENVELOPE>';
      const ledgers = parser.mapLedgers(xml);
      expect(ledgers).toHaveLength(2);
      const enrichmentFieldsBlank = {
        gstin: null,
        panNumber: null,
        email: null,
        phone: null,
        mobile: null,
        billingAddress: null,
        billingState: null,
        billingCountry: null,
        billingPincode: null,
        bankName: null,
        bankAccountNumber: null,
      };
      expect(ledgers[0]).toEqual({
        name: 'Cash',
        parent: 'Cash-in-Hand',
        description: 'Petty cash',
        openingBalance: 1000,
        closingBalance: -2500.5,
        alterId: 42,
        reservedName: null,
        ...enrichmentFieldsBlank,
      });
      expect(ledgers[1]).toEqual({
        name: 'Sales',
        parent: null,
        description: null,
        openingBalance: null,
        closingBalance: null,
        alterId: null,
        reservedName: null,
        ...enrichmentFieldsBlank,
      });
    });

    it('parses PAN/contact/address/bank fields, joining multi-line address into one string', () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION>' +
        '<LEDGER><NAME>ABC Traders</NAME>' +
        '<INCOMETAXNUMBER>AAAAA1111A</INCOMETAXNUMBER>' +
        '<EMAIL>ap@abctraders.com</EMAIL>' +
        '<LEDGERPHONE>044-12345678</LEDGERPHONE>' +
        '<LEDGERMOBILE>9876543210</LEDGERMOBILE>' +
        '<ADDRESS.LIST><ADDRESS>50 Kovil Street</ADDRESS><ADDRESS>Anna Nagar</ADDRESS></ADDRESS.LIST>' +
        '<LEDSTATENAME>Tamil Nadu</LEDSTATENAME>' +
        '<COUNTRYNAME>India</COUNTRYNAME>' +
        '<PINCODE>600040</PINCODE>' +
        // A flat scalar, verified live — NOT a `.LIST`, and no separate
        // "bank name" field exists at all (bankName always stays null).
        '<BANKDETAILS>000123456789</BANKDETAILS>' +
        '</LEDGER>' +
        '</COLLECTION></DATA></BODY></ENVELOPE>';

      const [ledger] = parser.mapLedgers(xml);
      expect(ledger.panNumber).toBe('AAAAA1111A');
      expect(ledger.email).toBe('ap@abctraders.com');
      expect(ledger.phone).toBe('044-12345678');
      expect(ledger.mobile).toBe('9876543210');
      expect(ledger.billingAddress).toBe('50 Kovil Street\nAnna Nagar');
      expect(ledger.billingState).toBe('Tamil Nadu');
      expect(ledger.billingCountry).toBe('India');
      expect(ledger.billingPincode).toBe('600040');
      expect(ledger.bankName).toBeNull();
      expect(ledger.bankAccountNumber).toBe('000123456789');
    });

    it('picks the GSTIN off the last LEDGSTREGDETAILS.LIST entry that actually has one, not just the last entry outright', () => {
      // Real shape observed live: a ledger can carry multiple registration
      // history entries (state changes, re-registrations) — some with no
      // GSTIN at all (pre-GST-registration history), listed chronologically.
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION>' +
        '<LEDGER><NAME>NMDC Data Centre</NAME>' +
        '<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20200401</APPLICABLEFROM>' +
        '<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE></LEDGSTREGDETAILS.LIST>' +
        '<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20240331</APPLICABLEFROM>' +
        '<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>' +
        '<PLACEOFSUPPLY>Maharashtra</PLACEOFSUPPLY>' +
        '<GSTIN>27AAGCN6348H1Z6</GSTIN></LEDGSTREGDETAILS.LIST>' +
        '</LEDGER>' +
        '</COLLECTION></DATA></BODY></ENVELOPE>';

      const [ledger] = parser.mapLedgers(xml);
      expect(ledger.gstin).toBe('27AAGCN6348H1Z6');
    });

    it('leaves gstin null when a ledger has LEDGSTREGDETAILS.LIST entries but none carry a GSTIN', () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION>' +
        '<LEDGER><NAME>No GST Yet</NAME>' +
        '<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20200401</APPLICABLEFROM></LEDGSTREGDETAILS.LIST>' +
        '</LEDGER>' +
        '</COLLECTION></DATA></BODY></ENVELOPE>';

      const [ledger] = parser.mapLedgers(xml);
      expect(ledger.gstin).toBeNull();
    });

    it('leaves gstin null (not throwing) when a ledger has no LEDGSTREGDETAILS.LIST at all', () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION><LEDGER><NAME>Plain</NAME></LEDGER></COLLECTION></DATA></BODY></ENVELOPE>';
      const [ledger] = parser.mapLedgers(xml);
      expect(ledger.gstin).toBeNull();
    });

    it('leaves the enrichment fields null when a ledger has no bank/address details on file, rather than throwing', () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION><LEDGER><NAME>Plain Ledger</NAME></LEDGER></COLLECTION></DATA></BODY></ENVELOPE>';
      const [ledger] = parser.mapLedgers(xml);
      expect(ledger.billingAddress).toBeNull();
      expect(ledger.bankName).toBeNull();
      expect(ledger.bankAccountNumber).toBeNull();
    });

    it('captures RESERVEDNAME for Tally system-computed ledgers (e.g. Profit & Loss A/c), null for ordinary ones', () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION>' +
        '<LEDGER NAME="Profit &amp; Loss A/c" RESERVEDNAME="Profit &amp; Loss A/c"><ALTERID>7</ALTERID></LEDGER>' +
        '<LEDGER NAME="Cash" RESERVEDNAME=""><ALTERID>8</ALTERID></LEDGER>' +
        '</COLLECTION></DATA></BODY></ENVELOPE>';
      const ledgers = parser.mapLedgers(xml);
      expect(ledgers.map((l) => ({ name: l.name, reservedName: l.reservedName }))).toEqual([
        { name: 'Profit & Loss A/c', reservedName: 'Profit & Loss A/c' },
        { name: 'Cash', reservedName: null },
      ]);
    });
  });

  describe('mapGroups', () => {
    it('parses name/parent/alterId, tolerating an omitted parent (top-level group)', () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION>' +
        '<GROUP><NAME>Employee</NAME><PARENT>Current Liabilities</PARENT><ALTERID>12</ALTERID></GROUP>' +
        '<GROUP><NAME>Current Liabilities</NAME></GROUP>' + // top-level: no parent
        '</COLLECTION></DATA></BODY></ENVELOPE>';
      const groups = parser.mapGroups(xml);
      expect(groups).toEqual([
        { name: 'Employee', parent: 'Current Liabilities', alterId: 12 },
        { name: 'Current Liabilities', parent: null, alterId: null },
      ]);
    });
  });

  describe('mapStockItems', () => {
    it('parses quantity/value fields (stripping the unit suffix) and AlterID, tolerating omitted tags', () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION>' +
        '<STOCKITEM><NAME>Widget A</NAME><PARENT>Finished Goods</PARENT><DESCRIPTION>A widget</DESCRIPTION><BASEUNITS>Nos</BASEUNITS>' +
        '<OPENINGBALANCE>100 Nos</OPENINGBALANCE><OPENINGVALUE>5000.00</OPENINGVALUE>' +
        '<CLOSINGBALANCE>-20 Nos</CLOSINGBALANCE><CLOSINGVALUE>-1000.00</CLOSINGVALUE><ALTERID>7</ALTERID></STOCKITEM>' +
        '<STOCKITEM><NAME>Widget B</NAME></STOCKITEM>' + // no parent/description/balances/alterid
        '</COLLECTION></DATA></BODY></ENVELOPE>';
      const items = parser.mapStockItems(xml);
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        name: 'Widget A',
        parent: 'Finished Goods',
        description: 'A widget',
        baseUnit: 'Nos',
        openingBalance: 100,
        openingValue: 5000,
        closingBalance: -20,
        closingValue: -1000,
        alterId: 7,
        alias: null,
        hsnCode: null,
        gstRate: null,
      });
      expect(items[1]).toEqual({
        name: 'Widget B',
        parent: null,
        description: null,
        baseUnit: null,
        openingBalance: null,
        openingValue: null,
        closingBalance: null,
        closingValue: null,
        alterId: null,
        alias: null,
        hsnCode: null,
        gstRate: null,
      });
    });

    it('parses Alias/HSN/GSTRate', () => {
      const xml =
        '<ENVELOPE><BODY><DATA><COLLECTION>' +
        '<STOCKITEM><NAME>Widget A</NAME><ALIAS>WGT-A</ALIAS><HSNCODE>392321</HSNCODE><GSTRATE>18</GSTRATE></STOCKITEM>' +
        '</COLLECTION></DATA></BODY></ENVELOPE>';
      const [item] = parser.mapStockItems(xml);
      expect(item.alias).toBe('WGT-A');
      expect(item.hsnCode).toBe('392321');
      expect(item.gstRate).toBe(18);
    });
  });

  describe('mapVouchers', () => {
    // Real TallyPrime shape for a REQUESTDESC-style report export (Day Book):
    // it reuses its "Import Data" schema, so records land under
    // BODY.IMPORTDATA.REQUESTDATA, not BODY.DATA — captured from a live
    // TallyPrime response, not hand-guessed.
    const salesVoucher =
      '<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>' +
      '<TALLYMESSAGE><VOUCHER VCHTYPE="Sales">' +
      '<DATE>20250415</DATE><VOUCHERNUMBER>INV-1042</VOUCHERNUMBER>' +
      '<PARTYLEDGERNAME>ABC Traders</PARTYLEDGERNAME><NARRATION>Sold R&D kit</NARRATION>' +
      '<ALLLEDGERENTRIES.LIST><LEDGERNAME>ABC Traders</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-11800.00</AMOUNT></ALLLEDGERENTRIES.LIST>' +
      '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales Account</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>10000.00</AMOUNT></ALLLEDGERENTRIES.LIST>' +
      '<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Widget A</STOCKITEMNAME><AMOUNT>10000.00</AMOUNT></ALLINVENTORYENTRIES.LIST>' +
      '</VOUCHER></TALLYMESSAGE>' +
      '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';

    it('extracts header, ledger entries, and inventory entries', () => {
      const [voucher] = parser.mapVouchers(salesVoucher);
      expect(voucher).toMatchObject({
        date: '20250415',
        voucherType: 'Sales', // read from the VCHTYPE attribute
        voucherNumber: 'INV-1042',
        partyLedgerName: 'ABC Traders',
        narration: 'Sold R&D kit', // bare "&" was sanitized then decoded back
      });
      expect(voucher.ledgerEntries).toHaveLength(2);
      expect(voucher.inventoryEntries).toEqual([
        { stockItemName: 'Widget A', quantity: null, rate: null, amount: 10000 },
      ]);
    });

    it('parses PARTYGSTIN/PLACEOFSUPPLY, null when absent', () => {
      const xmlWithGst =
        '<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>' +
        '<TALLYMESSAGE><VOUCHER VCHTYPE="Sales">' +
        '<PARTYGSTIN>33AAAAA1111A1Z1</PARTYGSTIN><PLACEOFSUPPLY>Tamil Nadu</PLACEOFSUPPLY>' +
        '</VOUCHER></TALLYMESSAGE>' +
        '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
      const [withGst] = parser.mapVouchers(xmlWithGst);
      expect(withGst.partyGstin).toBe('33AAAAA1111A1Z1');
      expect(withGst.placeOfSupply).toBe('Tamil Nadu');

      const [withoutGst] = parser.mapVouchers(salesVoucher);
      expect(withoutGst.partyGstin).toBeNull();
      expect(withoutGst.placeOfSupply).toBeNull();
    });

    it('resolves Dr/Cr from ISDEEMEDPOSITIVE + amount sign', () => {
      const [voucher] = parser.mapVouchers(salesVoucher);
      const party = voucher.ledgerEntries[0];
      const sales = voucher.ledgerEntries[1];

      // Party (deemed-positive) with a negative amount => Debit.
      expect(party).toMatchObject({ ledgerName: 'ABC Traders', amount: -11800, isDebit: true });
      // Sales (not deemed-positive) with a positive amount => Credit.
      expect(sales).toMatchObject({ ledgerName: 'Sales Account', amount: 10000, isDebit: false });
    });

    it('returns every voucher and skips non-voucher messages', () => {
      const xml =
        '<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>' +
        '<TALLYMESSAGE><LEDGER><NAME>Some Master</NAME></LEDGER></TALLYMESSAGE>' + // not a voucher
        '<TALLYMESSAGE><VOUCHER VCHTYPE="Receipt"><VOUCHERNUMBER>R-1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE>' +
        '<TALLYMESSAGE><VOUCHER VCHTYPE="Payment"><VOUCHERNUMBER>P-1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE>' +
        '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
      const vouchers = parser.mapVouchers(xml);
      expect(vouchers.map((v) => v.voucherNumber)).toEqual(['R-1', 'P-1']);
      expect(vouchers.map((v) => v.voucherType)).toEqual(['Receipt', 'Payment']);
    });

    it('handles a single ledger entry (object, not array)', () => {
      const xml =
        '<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE><VOUCHER VCHTYPE="Journal">' +
        '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Only One</LEDGERNAME><AMOUNT>50.00</AMOUNT></ALLLEDGERENTRIES.LIST>' +
        '</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
      const [voucher] = parser.mapVouchers(xml);
      expect(voucher.ledgerEntries).toHaveLength(1);
      expect(voucher.ledgerEntries[0]).toMatchObject({ ledgerName: 'Only One', amount: 50 });
    });

    it('falls back to BODY.DATA.TALLYMESSAGE for Tally builds that answer that way', () => {
      const xml =
        '<ENVELOPE><BODY><DATA>' +
        '<TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><VOUCHERNUMBER>J-1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE>' +
        '</DATA></BODY></ENVELOPE>';
      const [voucher] = parser.mapVouchers(xml);
      expect(voucher).toMatchObject({ voucherNumber: 'J-1', voucherType: 'Journal' });
    });
  });
});
