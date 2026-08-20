import { EnvelopeBuilder } from './envelope.builder';

describe('EnvelopeBuilder', () => {
  const builder = new EnvelopeBuilder();

  it('builds a well-formed report request with static variables', () => {
    const xml = builder.buildReportRequest({
      reportName: 'Day Book',
      company: 'ABC Ltd',
      fromDate: '20250401',
      toDate: '20250430',
      voucherType: 'Sales',
    });
    expect(xml).toContain('<REPORTNAME>Day Book</REPORTNAME>');
    expect(xml).toContain('<SVCURRENTCOMPANY>ABC Ltd</SVCURRENTCOMPANY>');
    expect(xml).toContain('<SVFROMDATE>20250401</SVFROMDATE>');
    expect(xml).toContain('<SVTODATE>20250430</SVTODATE>');
    expect(xml).toContain('<VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>');
    expect(xml).toContain('<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>');
  });

  it('escapes ampersands in company names to keep the envelope well-formed', () => {
    const xml = builder.buildReportRequest({ reportName: 'Day Book', company: 'AT&T Ltd' });
    expect(xml).toContain('<SVCURRENTCOMPANY>AT&amp;T Ltd</SVCURRENTCOMPANY>');
    expect(xml).not.toContain('AT&T Ltd'); // raw ampersand must not survive
  });

  it('omits date/voucher static variables when not supplied', () => {
    const xml = builder.buildReportRequest({ reportName: 'List of Ledgers' });
    expect(xml).not.toContain('<SVFROMDATE>');
    expect(xml).not.toContain('<VOUCHERTYPENAME>');
  });

  it('builds a collection request for companies without a company scope', () => {
    const xml = builder.buildCompaniesRequest();
    expect(xml).toContain('<TYPE>Collection</TYPE>');
    expect(xml).toContain('<TYPE>Company</TYPE>');
    expect(xml).not.toContain('<SVCURRENTCOMPANY>');
  });

  it('builds a lean stock item collection request scoped to a company', () => {
    const xml = builder.buildStockItemsRequest('ABC Ltd');
    expect(xml).toContain('<TYPE>StockItem</TYPE>');
    expect(xml).toContain('<SVCURRENTCOMPANY>ABC Ltd</SVCURRENTCOMPANY>');
    expect(xml).toContain('<NATIVEMETHOD>BaseUnits</NATIVEMETHOD>');
    expect(xml).toContain('<NATIVEMETHOD>OpeningValue</NATIVEMETHOD>');
  });

  it('builds a lean ledger collection request that now includes Description', () => {
    const xml = builder.buildLedgersRequest('ABC Ltd');
    expect(xml).toContain('<TYPE>Ledger</TYPE>');
    expect(xml).toContain('<NATIVEMETHOD>Description</NATIVEMETHOD>');
  });

  it('requests the GSTIN/PAN/contact/address/bank fields Customer.xlsx/Vendor.xlsx need', () => {
    const xml = builder.buildLedgersRequest('ABC Ltd');
    expect(xml).toContain('<NATIVEMETHOD>GSTREGISTRATIONNUMBER</NATIVEMETHOD>');
    expect(xml).toContain('<NATIVEMETHOD>INCOMETAXNUMBER</NATIVEMETHOD>');
    expect(xml).toContain('<NATIVEMETHOD>ADDRESS.LIST</NATIVEMETHOD>');
    expect(xml).toContain('<NATIVEMETHOD>BANKDETAILS.LIST</NATIVEMETHOD>');
  });

  it('scopes ledger balances to a period via SVFROMDATE/SVTODATE when supplied', () => {
    const xml = builder.buildLedgersRequest('ABC Ltd', '20260401', '20260430');
    expect(xml).toContain('<SVFROMDATE>20260401</SVFROMDATE>');
    expect(xml).toContain('<SVTODATE>20260430</SVTODATE>');
  });

  it('omits SVFROMDATE/SVTODATE for ledgers when no period is supplied', () => {
    const xml = builder.buildLedgersRequest('ABC Ltd');
    expect(xml).not.toContain('<SVFROMDATE>');
    expect(xml).not.toContain('<SVTODATE>');
  });

  it('requests the Alias/HSN/GSTRate fields Item.xlsx needs', () => {
    const xml = builder.buildStockItemsRequest('ABC Ltd');
    expect(xml).toContain('<NATIVEMETHOD>ALIAS</NATIVEMETHOD>');
    expect(xml).toContain('<NATIVEMETHOD>HSNCODE</NATIVEMETHOD>');
    expect(xml).toContain('<NATIVEMETHOD>GSTRATE</NATIVEMETHOD>');
  });

  it('scopes stock item balances to a period via SVFROMDATE/SVTODATE when supplied', () => {
    const xml = builder.buildStockItemsRequest('ABC Ltd', '20260401', '20260430');
    expect(xml).toContain('<SVFROMDATE>20260401</SVFROMDATE>');
    expect(xml).toContain('<SVTODATE>20260430</SVTODATE>');
  });

  it('builds a lean cost centre collection request scoped to a company', () => {
    const xml = builder.buildCostCentresRequest('ABC Ltd');
    expect(xml).toContain('<TYPE>CostCentre</TYPE>');
    expect(xml).toContain('<SVCURRENTCOMPANY>ABC Ltd</SVCURRENTCOMPANY>');
    expect(xml).toContain('<NATIVEMETHOD>Name</NATIVEMETHOD>');
    expect(xml).toContain('<NATIVEMETHOD>Parent</NATIVEMETHOD>');
    expect(xml).toContain('<NATIVEMETHOD>AlterID</NATIVEMETHOD>');
  });

  it('builds a lean group collection request scoped to a company', () => {
    const xml = builder.buildGroupsRequest('ABC Ltd');
    expect(xml).toContain('<TYPE>Group</TYPE>');
    expect(xml).toContain('<SVCURRENTCOMPANY>ABC Ltd</SVCURRENTCOMPANY>');
    expect(xml).toContain('<NATIVEMETHOD>Name</NATIVEMETHOD>');
    expect(xml).toContain('<NATIVEMETHOD>Parent</NATIVEMETHOD>');
  });

  it('builds a cheap Name+AlterID ledger request with no balance fields', () => {
    const xml = builder.buildLedgerNamesRequest('ABC Ltd');
    expect(xml).toContain('<TYPE>Ledger</TYPE>');
    expect(xml).toContain('<NATIVEMETHOD>Name</NATIVEMETHOD>');
    expect(xml).toContain('<NATIVEMETHOD>AlterID</NATIVEMETHOD>');
    expect(xml).not.toContain('<NATIVEMETHOD>OpeningBalance</NATIVEMETHOD>');
    expect(xml).not.toContain('<NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>');
  });

  it('builds a cheap Name+AlterID stock item request with no balance/value fields', () => {
    const xml = builder.buildStockItemNamesRequest('ABC Ltd');
    expect(xml).toContain('<TYPE>StockItem</TYPE>');
    expect(xml).toContain('<NATIVEMETHOD>Name</NATIVEMETHOD>');
    expect(xml).toContain('<NATIVEMETHOD>AlterID</NATIVEMETHOD>');
    expect(xml).not.toContain('<NATIVEMETHOD>OpeningBalance</NATIVEMETHOD>');
    expect(xml).not.toContain('<NATIVEMETHOD>OpeningValue</NATIVEMETHOD>');
  });

  it('adds an AlterID-range FILTER and matching formula when batching ledgers, operators XML-escaped', () => {
    const xml = builder.buildLedgersRequest('ABC Ltd', undefined, undefined, {
      from: 100,
      to: 400,
    });
    expect(xml).toContain('<FILTER>AlterIdRangeFilter</FILTER>');
    // `<=`/`>=` contain literal angle brackets — invalid raw inside XML text
    // content, so the whole formula (operators included) must come out
    // entity-escaped, same lesson learned from the name-range approach this replaced.
    expect(xml).toContain(
      '<SYSTEM TYPE="Formulae" NAME="AlterIdRangeFilter">$AlterID &gt;= 100 AND $AlterID &lt;= 400</SYSTEM>',
    );
  });

  it('uses a plain numeric AlterID comparison, not a name — no quoting, no string-collation exposure', () => {
    const xml = builder.buildLedgersRequest('ABC Ltd', undefined, undefined, { from: 1, to: 9999 });
    expect(xml).not.toContain('$Name');
    expect(xml).not.toContain('&quot;'); // no quoted string literal at all — pure integer comparison
  });

  it('omits the FILTER/formula entirely for ledgers when no alterIdRange is given (unbatched, unchanged)', () => {
    const xml = builder.buildLedgersRequest('ABC Ltd');
    expect(xml).not.toContain('<FILTER>');
    expect(xml).not.toContain('SYSTEM TYPE="Formulae"');
  });

  it('adds an AlterID-range FILTER and matching formula when batching stock items', () => {
    const xml = builder.buildStockItemsRequest('ABC Ltd', undefined, undefined, {
      from: 5,
      to: 12,
    });
    expect(xml).toContain('<FILTER>AlterIdRangeFilter</FILTER>');
    expect(xml).toContain(
      '<SYSTEM TYPE="Formulae" NAME="AlterIdRangeFilter">$AlterID &gt;= 5 AND $AlterID &lt;= 12</SYSTEM>',
    );
  });

  it('omits the FILTER/formula entirely for stock items when no alterIdRange is given (unbatched, unchanged)', () => {
    const xml = builder.buildStockItemsRequest('ABC Ltd');
    expect(xml).not.toContain('<FILTER>');
    expect(xml).not.toContain('SYSTEM TYPE="Formulae"');
  });
});
