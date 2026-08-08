import * as ExcelJS from 'exceljs';
import { ExcelGeneratorService } from './excel-generator.service';

describe('ExcelGeneratorService', () => {
  const service = new ExcelGeneratorService();

  it('produces a real workbook with a bold header row and the given data', async () => {
    const buffer = await service.generate(
      'Test Sheet',
      [
        { header: 'Name', key: 'name', width: 20 },
        { header: 'Amount', key: 'amount' },
      ],
      [
        { name: 'Cash', amount: 1000 },
        { name: 'Sales', amount: -500 },
      ],
    );

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);

    // Read it back to prove it's a genuinely valid, parseable workbook — not
    // just "some bytes came out".
    const workbook = new ExcelJS.Workbook();
    // exceljs's Buffer typing predates Node 22's generic Buffer<ArrayBufferLike> —
    // the value itself is a genuine Buffer at runtime, only the type is stale.
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Test Sheet');
    expect(sheet).toBeDefined();
    expect(sheet!.getRow(1).getCell(1).value).toBe('Name');
    expect(sheet!.getRow(1).font?.bold).toBe(true);
    expect(sheet!.getRow(2).getCell(1).value).toBe('Cash');
    expect(sheet!.getRow(2).getCell(2).value).toBe(1000);
    expect(sheet!.getRow(3).getCell(1).value).toBe('Sales');
    expect(sheet!.getRow(3).getCell(2).value).toBe(-500);
  });

  it('produces a valid (empty) workbook when there are no rows', async () => {
    const buffer = await service.generate('Empty', [{ header: 'X', key: 'x' }], []);
    const workbook = new ExcelJS.Workbook();
    // exceljs's Buffer typing predates Node 22's generic Buffer<ArrayBufferLike> —
    // the value itself is a genuine Buffer at runtime, only the type is stale.
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(workbook.getWorksheet('Empty')!.rowCount).toBe(1); // just the header
  });
});
