import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

/**
 * Writes rows into a real Zoho Books import template, preserving everything
 * about the template except its data rows — this deliberately knows nothing
 * about Tally or Zoho; which template/sheet to use and how to shape a row
 * lives in src/mapping (see zoho-entity.map.ts and the per-entity mappers).
 */
@Injectable()
export class ExcelGeneratorService {
  /**
   * Loads `templatePath` fresh from disk (never mutates the file itself —
   * every call gets its own in-memory copy), removes every existing row
   * below the header (Zoho ships these templates with 3-13 rows of its own
   * demo data — e.g. customers "Ethan"/"Ganesh", items "Dummy Item" — which
   * must never ship alongside real extracted data), and writes `rows` back
   * starting at row 2, one row per array entry, matched to the template's
   * REAL header text rather than an assumed column order/key.
   *
   * Column order/width/styling are left completely untouched: cells are
   * written by resolved column index, not via ExcelJS's `worksheet.columns =`
   * setter (which rewrites header cells and column definitions from scratch —
   * exactly the template mutation this method exists to avoid).
   *
   * A row object's keys are matched against header text; any header with no
   * matching key is left blank rather than guessed — the same "don't
   * fabricate a value with no real source" standard the mappers themselves
   * follow.
   */
  async writeIntoTemplate<T extends object>(
    templatePath: string,
    sheetName: string,
    rows: T[],
  ): Promise<Buffer> {
    const sheet = await this.loadSheet(templatePath, sheetName);
    const columnByHeader = this.readHeaderRow(sheet);

    // exceljs's spliceRows(start, count) only actually nulls out the row(s)
    // it removes when `start` lands exactly on the sheet's current last row
    // (see its "if (start === nEnd)" special case) — a single call spanning
    // start..sheet.rowCount, which is exactly what "delete every demo row"
    // needs, silently does nothing when there's nothing below it to shift
    // into the gap. Deleting one row at a time, from the last row up to the
    // header, keeps `start === lastRow` true on every call and reliably
    // empties the sheet down to just the header. Confirmed against the real
    // COA.xlsx template — the bulk form leaves every demo row (and its
    // stale cell values) fully intact.
    for (let rowNumber = sheet.rowCount; rowNumber >= 2; rowNumber--) {
      sheet.spliceRows(rowNumber, 1);
    }

    rows.forEach((row, index) => {
      const targetRow = sheet.getRow(index + 2);
      for (const [header, value] of Object.entries(row)) {
        const columnNumber = columnByHeader.get(header);
        if (columnNumber !== undefined) {
          targetRow.getCell(columnNumber).value = value as ExcelJS.CellValue;
        }
      }
      targetRow.commit();
    });

    const buffer = await sheet.workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  /**
   * Boot-time check (see ZohoTemplateValidatorService) that a template file
   * and sheet still exist and are readable — so a moved/renamed template
   * fails loudly at startup, not on the first user export request.
   */
  async assertTemplateReadable(templatePath: string, sheetName: string): Promise<void> {
    await this.loadSheet(templatePath, sheetName);
  }

  private async loadSheet(templatePath: string, sheetName: string): Promise<ExcelJS.Worksheet> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.readFile(templatePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read Zoho template "${templatePath}": ${message}`);
    }
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      const available = workbook.worksheets.map((s) => s.name).join(', ') || '(none)';
      throw new Error(
        `Template "${templatePath}" has no sheet named "${sheetName}" (found: ${available}).`,
      );
    }
    return sheet;
  }

  private readHeaderRow(sheet: ExcelJS.Worksheet): Map<string, number> {
    const columnByHeader = new Map<string, number>();
    sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const header = String(cell.value ?? '').trim();
      if (header) columnByHeader.set(header, columnNumber);
    });
    if (columnByHeader.size === 0) {
      throw new Error(`Sheet "${sheet.name}" has no header row to write against.`);
    }
    return columnByHeader;
  }
}
