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
});
