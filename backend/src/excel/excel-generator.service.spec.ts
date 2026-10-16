import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { ExcelGeneratorService } from './excel-generator.service';

// Real bundled template — proves this against an actual Zoho file, not a
// hand-rolled fixture, so a change to the template itself is caught here too.
const COA_TEMPLATE = path.join(__dirname, '..', 'mapping', 'templates', 'COA.xlsx');
const COA_SHEET = 'sample_accounts';

describe('ExcelGeneratorService', () => {
  const service = new ExcelGeneratorService();

  it('replaces the template demo rows with real data, keyed by real header text', async () => {
    const buffer = await service.writeIntoTemplate(COA_TEMPLATE, COA_SHEET, [
      {
        'Account Name': 'Cash',
        'Account Type': 'Cash',
        'Opening Balance': 1000,
        'Debit or Credit': 'Debit',
      },
      {
        'Account Name': 'Sales',
        'Account Type': 'Income',
        'Opening Balance': 500,
        'Debit or Credit': 'Credit',
      },
    ]);

    const workbook = new ExcelJS.Workbook();
    // exceljs's Buffer typing predates Node 22's generic Buffer<ArrayBufferLike> —
    // the value itself is a genuine Buffer at runtime, only the type is stale.
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet(COA_SHEET)!;

    // Header row untouched — same real Zoho text, still row 1.
    expect(sheet.getRow(1).getCell(1).value).toBe('Account Name');
    expect(sheet.getRow(1).getCell(4).value).toBe('Account Type');

    // Zoho's own demo rows ("Wages Payable", "Prepaid Insurance", "Citi
    // Bank" in the real template) are gone — exactly the 2 rows we wrote,
    // nothing left over from the template.
    expect(sheet.rowCount).toBe(3); // header + 2 data rows
    expect(sheet.getRow(2).getCell(1).value).toBe('Cash');
    expect(sheet.getRow(3).getCell(1).value).toBe('Sales');

    // A header this row didn't populate (e.g. "Description") stays blank
    // rather than carrying over stale demo content.
    expect(sheet.getRow(2).getCell(3).value).toBeFalsy();
  });

  it('clears every demo row even when writing fewer rows than the template originally had', async () => {
    const buffer = await service.writeIntoTemplate(COA_TEMPLATE, COA_SHEET, [
      { 'Account Name': 'Only Account' },
    ]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet(COA_SHEET)!;
    expect(sheet.rowCount).toBe(2); // header + 1 data row, none of the original 3 demo rows remain
  });

  it('produces a valid workbook with just the header when there are no rows', async () => {
    const buffer = await service.writeIntoTemplate(COA_TEMPLATE, COA_SHEET, []);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(workbook.getWorksheet(COA_SHEET)!.rowCount).toBe(1);
  });

  it('throws a clear error for a sheet name that does not exist in the template', async () => {
    await expect(service.writeIntoTemplate(COA_TEMPLATE, 'Not A Real Sheet', [])).rejects.toThrow(
      /no sheet named "Not A Real Sheet"/,
    );
  });

  it('throws a clear error for a template file that does not exist', async () => {
    await expect(
      service.writeIntoTemplate(path.join(__dirname, 'nope.xlsx'), COA_SHEET, []),
    ).rejects.toThrow(/Could not read Zoho template/);
  });

  it('assertTemplateReadable succeeds for a real template/sheet pair and rejects a bad one', async () => {
    await expect(service.assertTemplateReadable(COA_TEMPLATE, COA_SHEET)).resolves.toBeUndefined();
    await expect(service.assertTemplateReadable(COA_TEMPLATE, 'Nope')).rejects.toThrow();
  });

  describe('getTemplateHeaders (2026-09-19 Full Sync debug feature)', () => {
    it('returns the real, ordered header row', async () => {
      const headers = await service.getTemplateHeaders(COA_TEMPLATE, COA_SHEET);
      expect(headers[0]).toBe('Account Name');
      expect(headers).toContain('Account Type');
    });

    it('caches the result — a second call for the same template/sheet does not re-read the file', async () => {
      const fresh = new ExcelGeneratorService();
      const spy = jest.spyOn(fresh as unknown as { loadSheet: unknown }, 'loadSheet' as never);
      await fresh.getTemplateHeaders(COA_TEMPLATE, COA_SHEET);
      expect(spy).toHaveBeenCalledTimes(1);
      await fresh.getTemplateHeaders(COA_TEMPLATE, COA_SHEET);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('throws the same clear error as writeIntoTemplate for an unknown sheet', async () => {
      await expect(service.getTemplateHeaders(COA_TEMPLATE, 'Not A Real Sheet')).rejects.toThrow(
        /no sheet named "Not A Real Sheet"/,
      );
    });
  });

  describe('buildDebugWorkbook (2026-09-19 Full Sync debug feature)', () => {
    it('writes one worksheet per entry, header row plus data rows in header order', async () => {
      const buffer = await service.buildDebugWorkbook([
        {
          name: 'RAW GROUPS',
          headers: ['name', 'parent'],
          rows: [{ name: 'Sundry Debtors', parent: 'Current Assets' }],
        },
        {
          name: 'ZOHO CUSTOMER',
          headers: ['Contact Name', 'GST Treatment'],
          rows: [{ 'Contact Name': 'ABC Traders' }], // GST Treatment intentionally absent
        },
      ]);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      expect(workbook.worksheets.map((s) => s.name)).toEqual(['RAW GROUPS', 'ZOHO CUSTOMER']);

      const groups = workbook.getWorksheet('RAW GROUPS')!;
      expect(groups.getRow(1).values).toEqual([undefined, 'name', 'parent']);
      expect(groups.getRow(2).values).toEqual([undefined, 'Sundry Debtors', 'Current Assets']);

      // A header with no matching key on this row is left genuinely blank —
      // exactly the "what columns are we missing" signal this feature exists
      // to surface, not silently dropped from the sheet.
      const customer = workbook.getWorksheet('ZOHO CUSTOMER')!;
      expect(customer.getRow(1).values).toEqual([undefined, 'Contact Name', 'GST Treatment']);
      expect(customer.getRow(2).getCell(1).value).toBe('ABC Traders');
      expect(customer.getRow(2).getCell(2).value).toBeNull();
    });

    it('produces a valid (loadable) workbook with zero data rows for an empty sheet entry', async () => {
      const buffer = await service.buildDebugWorkbook([
        { name: 'Empty', headers: ['(no records)'], rows: [] },
      ]);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheet = workbook.getWorksheet('Empty')!;
      expect(sheet.rowCount).toBe(1);
    });
  });
});
