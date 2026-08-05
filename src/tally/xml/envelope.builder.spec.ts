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

  describe('buildCreateLedgerRequest', () => {
    it('builds an Import Data request for a new ledger', () => {
      const xml = builder.buildCreateLedgerRequest('Test Ledger', 'Sundry Debtors', 'ABC Ltd', 0);
      expect(xml).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
      expect(xml).toContain('<SVCURRENTCOMPANY>ABC Ltd</SVCURRENTCOMPANY>');
      expect(xml).toContain('<LEDGER NAME="Test Ledger" ACTION="Create">');
      expect(xml).toContain('<NAME>Test Ledger</NAME>');
      expect(xml).toContain('<PARENT>Sundry Debtors</PARENT>');
      expect(xml).toContain('<OPENINGBALANCE>0</OPENINGBALANCE>');
    });

    it('escapes ampersands in the ledger name and parent', () => {
      const xml = builder.buildCreateLedgerRequest('Smith & Co', 'Sundry Debtors');
      expect(xml).toContain('<NAME>Smith &amp; Co</NAME>');
      expect(xml).toContain('LEDGER NAME="Smith &amp; Co"');
    });

    it('omits OPENINGBALANCE and SVCURRENTCOMPANY when not supplied', () => {
      const xml = builder.buildCreateLedgerRequest('Test Ledger', 'Sundry Debtors');
      expect(xml).not.toContain('<OPENINGBALANCE>');
      expect(xml).not.toContain('<SVCURRENTCOMPANY>');
    });
  });
});
