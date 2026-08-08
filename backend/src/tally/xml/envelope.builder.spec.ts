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

  it('scopes stock item balances to a period via SVFROMDATE/SVTODATE when supplied', () => {
    const xml = builder.buildStockItemsRequest('ABC Ltd', '20260401', '20260430');
    expect(xml).toContain('<SVFROMDATE>20260401</SVFROMDATE>');
    expect(xml).toContain('<SVTODATE>20260430</SVTODATE>');
  });

  it('builds a lean group collection request scoped to a company', () => {
    const xml = builder.buildGroupsRequest('ABC Ltd');
    expect(xml).toContain('<TYPE>Group</TYPE>');
    expect(xml).toContain('<SVCURRENTCOMPANY>ABC Ltd</SVCURRENTCOMPANY>');
    expect(xml).toContain('<NATIVEMETHOD>Name</NATIVEMETHOD>');
    expect(xml).toContain('<NATIVEMETHOD>Parent</NATIVEMETHOD>');
  });

});
