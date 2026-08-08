import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

export interface ExcelColumn {
  header: string;
  key: string;
  width?: number;
}

/**
 * Generic — takes column definitions + row objects, produces a workbook
 * buffer. Deliberately knows nothing about Tally or Zoho; the entity-specific
 * shape lives in src/mapping (see LedgerMapper, StockItemMapper).
 */
@Injectable()
export class ExcelGeneratorService {
  async generate<T extends object>(sheetName: string, columns: ExcelColumn[], rows: T[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName);
    sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 22 }));
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) {
      sheet.addRow(row);
    }
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
