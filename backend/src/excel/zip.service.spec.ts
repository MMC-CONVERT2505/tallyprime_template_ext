import * as ExcelJS from 'exceljs';
import { ZipService } from './zip.service';

async function readZipEntryNames(buffer: Buffer): Promise<string[]> {
  // Cheap structural check without a full zip-reading dependency: every
  // local file header in a zip starts with the 4-byte signature PK\x03\x04
  // followed by a 26-byte fixed header, then the filename. Good enough to
  // assert entry names/order without pulling in another package just for a test.
  const names: string[] = [];
  let offset = 0;
  const SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  while (offset < buffer.length) {
    const idx = buffer.indexOf(SIG, offset);
    if (idx === -1) break;
    const nameLen = buffer.readUInt16LE(idx + 26);
    const extraLen = buffer.readUInt16LE(idx + 28);
    const name = buffer.toString('utf-8', idx + 30, idx + 30 + nameLen);
    names.push(name);
    offset = idx + 30 + nameLen + extraLen;
  }
  return names;
}

describe('ZipService', () => {
  let service: ZipService;

  beforeEach(() => {
    service = new ZipService();
  });

  it('rejects an empty entry list rather than producing a useless zip', async () => {
    await expect(service.buildZip([])).rejects.toThrow('zero entries');
  });

  it('bundles every entry into the zip under its given filename', async () => {
    const buffer = await service.buildZip([
      { filename: 'COA.xlsx', buffer: Buffer.from('fake-coa') },
      { filename: 'Customer.xlsx', buffer: Buffer.from('fake-customer') },
      { filename: 'Vendor.xlsx', buffer: Buffer.from('fake-vendor') },
    ]);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    // PK\x03\x04 or PK\x05\x06 (empty archive) signature at the start.
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');

    const names = await readZipEntryNames(buffer);
    expect(names).toEqual(['COA.xlsx', 'Customer.xlsx', 'Vendor.xlsx']);
  });

  it('round-trips a real xlsx buffer through the zip without corruption', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['Name', 'Amount']);
    sheet.addRow(['Acme', 100]);
    const xlsxBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const zipped = await service.buildZip([{ filename: 'Item.xlsx', buffer: xlsxBuffer }]);
    const names = await readZipEntryNames(zipped);
    expect(names).toEqual(['Item.xlsx']);
  });
});
