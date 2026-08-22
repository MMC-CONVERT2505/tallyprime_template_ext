import * as ExcelJS from 'exceljs';
import { ExcelGeneratorService } from '../excel/excel-generator.service';
import { ZipService } from '../excel/zip.service';
import { BillMapper } from './bill.mapper';
import { CostCentreMapper } from './cost-centre.mapper';
import { CreditNoteMapper } from './credit-note.mapper';
import { CustomerMapper } from './customer.mapper';
import { GroupHierarchyResolver } from './group-hierarchy.resolver';
import { InvoiceMapper } from './invoice.mapper';
import { LedgerMapper } from './ledger.mapper';
import {
  SAMPLE_BILL_VOUCHERS,
  SAMPLE_COST_CENTRES,
  SAMPLE_CREDIT_NOTE_VOUCHERS,
  SAMPLE_GROUPS,
  SAMPLE_INVOICE_VOUCHERS,
  SAMPLE_LEDGERS,
  SAMPLE_STOCK_ITEMS,
  SAMPLE_STOCK_JOURNAL_VOUCHERS,
} from './sample-company.fixture';
import { StockItemMapper } from './stock-item.mapper';
import { StockJournalMapper } from './stock-journal.mapper';
import { VendorMapper } from './vendor.mapper';
import { buildStockItemIndex } from './voucher-line.shared';
import { templatePathFor, ZOHO_ENTITIES } from './zoho-entity.map';

/**
 * End-to-end proof that "every sheet in Master and Invoice or Bill/ gets
 * fully, correctly seeded" — the exact question this suite exists to answer
 * automatically, on every run, without needing a live Tally instance. Runs
 * realistic fixture data through the REAL production path: every mapper,
 * ExcelGeneratorService, and the REAL bundled Zoho template files (not
 * hand-rolled stand-ins) — then re-parses each generated sheet and the final
 * zip to assert every column a Tally source can supply actually landed in
 * the right cell, and every column with no Tally source stayed genuinely
 * blank rather than silently missing a real value.
 *
 * This is the same code path BulkExportService.generateAllTemplates and the
 * single-job GET /extractions/:id/excel route both call — a regression here
 * means a real user's download is wrong, not just this test.
 */

async function loadSheet(buffer: Buffer, sheetName: string): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found.`);
  return sheet;
}

function headerRow(sheet: ExcelJS.Worksheet): string[] {
  const headers: string[] = [];
  sheet
    .getRow(1)
    .eachCell({ includeEmpty: false }, (cell) => headers.push(String(cell.value ?? '').trim()));
  return headers;
}

function cell(sheet: ExcelJS.Worksheet, rowNumber: number, header: string): ExcelJS.CellValue {
  const columnNumber = headerRow(sheet).indexOf(header) + 1;
  if (columnNumber === 0) throw new Error(`Header "${header}" not found in sheet "${sheet.name}".`);
  return sheet.getRow(rowNumber).getCell(columnNumber).value;
}

/** Cheap zip entry-name reader (local file header signature PK\x03\x04) —
 *  avoids pulling in a zip-reading dependency just for a test assertion. */
function readZipEntryNames(buffer: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  const SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  while (offset < buffer.length) {
    const idx = buffer.indexOf(SIG, offset);
    if (idx === -1) break;
    const nameLen = buffer.readUInt16LE(idx + 26);
    const extraLen = buffer.readUInt16LE(idx + 28);
    names.push(buffer.toString('utf-8', idx + 30, idx + 30 + nameLen));
    offset = idx + 30 + nameLen + extraLen;
  }
  return names;
}

function utcNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12));
}

// Fixtures live in sample-company.fixture.ts, shared with
// scripts/generate-sample-export.ts so the demo .zip a human can open and
// this test's assertions can never silently drift apart from each other.
const groups = SAMPLE_GROUPS;
const ledgers = SAMPLE_LEDGERS;
const stockItems = SAMPLE_STOCK_ITEMS;
const costCentres = SAMPLE_COST_CENTRES;

describe('full Tally -> Zoho export pipeline (all 9 templates)', () => {
  const excel = new ExcelGeneratorService();
  const zip = new ZipService();
  const hierarchy = new GroupHierarchyResolver(groups);
  const itemIndex = buildStockItemIndex(stockItems);

  let buffers: Record<string, Buffer>;

  beforeAll(async () => {
    const coaRows = new LedgerMapper(hierarchy).toAccountRows(ledgers);
    const customerRows = new CustomerMapper(hierarchy).toCustomerRows(ledgers);
    const vendorRows = new VendorMapper(hierarchy).toVendorRows(ledgers);
    const itemRows = new StockItemMapper().toItemRows(stockItems);
    const reportingTagRows = new CostCentreMapper().toReportingTagRows(costCentres);
    const invoiceRows = new InvoiceMapper(itemIndex).toInvoiceRows(SAMPLE_INVOICE_VOUCHERS);
    const billRows = new BillMapper(itemIndex).toBillRows(SAMPLE_BILL_VOUCHERS);
    const creditNoteRows = new CreditNoteMapper(itemIndex).toCreditNoteRows(
      SAMPLE_CREDIT_NOTE_VOUCHERS,
    );
    const stockJournalRows = new StockJournalMapper(itemIndex).toStockJournalRows(
      SAMPLE_STOCK_JOURNAL_VOUCHERS,
    );

    const write = (key: keyof typeof ZOHO_ENTITIES, rows: object[]) =>
      excel.writeIntoTemplate(templatePathFor(key), ZOHO_ENTITIES[key].sheetName, rows);

    buffers = {
      'COA.xlsx': await write('COA', coaRows),
      'Customer.xlsx': await write('CUSTOMER', customerRows),
      'Vendor.xlsx': await write('VENDOR', vendorRows),
      'Item.xlsx': await write('ITEM', itemRows),
      'Class.xlsx': await write('COST_CENTRE', reportingTagRows),
      'Invoice.xlsx': await write('INVOICE', invoiceRows),
      'Bill.xlsx': await write('BILL', billRows),
      'Credit Note.xlsx': await write('CREDIT_NOTE', creditNoteRows),
      'Stock Journal.xlsx': await write('STOCK_JOURNAL', stockJournalRows),
    };
  });

  it('produces exactly the 9 in-scope Zoho templates, matching the real "Master and Invoice or Bill" folder', () => {
    expect(Object.keys(buffers).sort()).toEqual(
      [
        'COA.xlsx',
        'Customer.xlsx',
        'Vendor.xlsx',
        'Item.xlsx',
        'Class.xlsx',
        'Invoice.xlsx',
        'Bill.xlsx',
        'Credit Note.xlsx',
        'Stock Journal.xlsx',
      ].sort(),
    );
  });

  it('zips all 9 files, downloadable as one archive with every filename intact', async () => {
    const entries = Object.entries(buffers).map(([filename, buffer]) => ({ filename, buffer }));
    const zipped = await zip.buildZip(entries);
    const names = readZipEntryNames(zipped);
    expect(names).toEqual(Object.keys(buffers));
  });

  describe('COA.xlsx (Chart of Accounts)', () => {
    it('excludes Customer/Vendor-bound ledgers and correctly classifies the rest', async () => {
      const sheet = await loadSheet(buffers['COA.xlsx'], 'sample_accounts');
      expect(headerRow(sheet)).toEqual([
        'Account Name',
        'Account Code',
        'Description',
        'Account Type',
        'Parent Account',
        'Account #',
        'Currency',
        'Opening Balance',
        'Debit or Credit',
      ]);
      expect(sheet.rowCount).toBe(3); // header + Office Rent + HDFC Bank Current A/c

      expect(cell(sheet, 2, 'Account Name')).toBe('Office Rent');
      expect(cell(sheet, 2, 'Description')).toBe('Monthly office rent');
      expect(cell(sheet, 2, 'Account Type')).toBe('Other Expense'); // via custom subgroup -> Indirect Expenses
      expect(cell(sheet, 2, 'Parent Account')).toBe('Office Expenses');
      expect(cell(sheet, 2, 'Currency')).toBe('INR');
      expect(cell(sheet, 2, 'Opening Balance')).toBe(0);
      expect(cell(sheet, 2, 'Debit or Credit')).toBe('Credit');
      expect(cell(sheet, 2, 'Account Code')).toBeFalsy(); // no Tally source — must stay blank

      expect(cell(sheet, 3, 'Account Name')).toBe('HDFC Bank Current A/c');
      expect(cell(sheet, 3, 'Account Type')).toBe('Bank'); // via custom subgroup -> Bank Accounts
      expect(cell(sheet, 3, 'Opening Balance')).toBe(250000);
      expect(cell(sheet, 3, 'Debit or Credit')).toBe('Debit');

      // Rohan Traders / Global Supplies never appear here — they belong to
      // Customer.xlsx / Vendor.xlsx instead.
      const names = [2, 3].map((r) => cell(sheet, r, 'Account Name'));
      expect(names).not.toContain('Rohan Traders');
      expect(names).not.toContain('Global Supplies Pvt Ltd');
    });
  });

  describe('Customer.xlsx', () => {
    it('carries every GSTIN/PAN/contact/address field Tally can supply, and nothing it cannot', async () => {
      const sheet = await loadSheet(buffers['Customer.xlsx'], 'Customer');
      expect(sheet.rowCount).toBe(3); // header + Rohan Traders + Priya Distributors
      expect(cell(sheet, 2, 'Display Name')).toBe('Rohan Traders');
      expect(cell(sheet, 2, 'EmailID')).toBe('rohan@traders.in');
      expect(cell(sheet, 2, 'Phone')).toBe('02212345678');
      expect(cell(sheet, 2, 'MobilePhone')).toBe('9876543210');
      expect(cell(sheet, 2, 'GST Treatment')).toBe('business_gst');
      expect(cell(sheet, 2, 'GST Identification Number (GSTIN)')).toBe('27AABCU9603R1ZM');
      expect(cell(sheet, 2, 'PAN Number')).toBe('AABCU9603R');
      expect(cell(sheet, 2, 'Billing Address')).toBe('12 MG Road, Andheri');
      expect(cell(sheet, 2, 'Billing State')).toBe('Maharashtra');
      expect(cell(sheet, 2, 'Billing Country')).toBe('India');
      expect(cell(sheet, 2, 'Billing Code')).toBe('400001');
      expect(cell(sheet, 2, 'Opening Balance')).toBe(15000); // magnitude, sign dropped (no Dr/Cr column here)
      expect(cell(sheet, 2, 'Status')).toBe('Active');
      expect(cell(sheet, 2, 'Currency Code')).toBe('INR');
      // No Tally source for these — must stay genuinely blank, not guessed.
      expect(cell(sheet, 2, 'Website')).toBeFalsy();
      expect(cell(sheet, 2, 'Credit Limit')).toBeFalsy();

      expect(cell(sheet, 3, 'Display Name')).toBe('Priya Distributors');
      expect(cell(sheet, 3, 'GST Identification Number (GSTIN)')).toBe('19AACPD1122K1ZQ');
      expect(cell(sheet, 3, 'Billing State')).toBe('West Bengal');
      expect(cell(sheet, 3, 'Opening Balance')).toBe(42000);
    });
  });

  describe('Vendor.xlsx', () => {
    it('carries bank details, which Customer.xlsx has no columns for at all', async () => {
      const sheet = await loadSheet(buffers['Vendor.xlsx'], 'Vendor');
      expect(sheet.rowCount).toBe(2);
      expect(cell(sheet, 2, 'Display Name')).toBe('Global Supplies Pvt Ltd');
      expect(cell(sheet, 2, 'GST Identification Number (GSTIN)')).toBe('29AAACG1234F1Z5');
      expect(cell(sheet, 2, 'PAN Number')).toBe('AAACG1234F');
      expect(cell(sheet, 2, 'Bank Name')).toBe('HDFC Bank');
      expect(cell(sheet, 2, 'Bank Account Number')).toBe('50100123456789');
      expect(cell(sheet, 2, 'Opening Balance')).toBe(8000);
      expect(cell(sheet, 2, 'Status')).toBe('Active');
    });
  });

  describe('Item.xlsx', () => {
    it('derives Intra/Inter State tax columns from the item GST rate for every item', async () => {
      const sheet = await loadSheet(buffers['Item.xlsx'], 'Item');
      expect(sheet.rowCount).toBe(4); // header + 3 items

      expect(cell(sheet, 2, 'Item Name')).toBe('Widget A');
      expect(cell(sheet, 2, 'Alias Name')).toBe('WID-A');
      expect(cell(sheet, 2, 'HSN/SAC')).toBe('84819000');
      expect(cell(sheet, 2, 'Usage unit')).toBe('Nos');
      expect(cell(sheet, 2, 'Opening Stock')).toBe(100);
      expect(cell(sheet, 2, 'Opening Stock Value')).toBe(25000);
      expect(cell(sheet, 2, 'Stock On Hand')).toBe(80);
      expect(cell(sheet, 2, 'Item Type')).toBe('goods');
      expect(cell(sheet, 2, 'Status')).toBe('Active');
      expect(cell(sheet, 2, 'Intra State Tax Name')).toBe('GST18');
      expect(cell(sheet, 2, 'Intra State Tax Rate')).toBe(18);
      expect(cell(sheet, 2, 'Intra State Tax Type')).toBe('Group');
      expect(cell(sheet, 2, 'Inter State Tax Name')).toBe('IGST18');
      expect(cell(sheet, 2, 'Inter State Tax Rate')).toBe(18);

      expect(cell(sheet, 4, 'Item Name')).toBe('Raw Material X');
      expect(cell(sheet, 4, 'Alias Name')).toBeFalsy(); // no alias in Tally for this one
      expect(cell(sheet, 4, 'Stock On Hand')).toBe(300);
      expect(cell(sheet, 4, 'Intra State Tax Name')).toBe('GST5');
      // No Tally source for these — must stay blank.
      expect(cell(sheet, 2, 'SKU')).toBeFalsy();
      expect(cell(sheet, 2, 'Rate')).toBeFalsy();
    });
  });

  describe('Class.xlsx (Reporting Tags)', () => {
    it('lists every Cost Centre under the fixed "Cost Centre" tag name', async () => {
      const sheet = await loadSheet(buffers['Class.xlsx'], 'Sheet1');
      expect(headerRow(sheet)).toEqual(['Tag Name', 'Options']);
      expect(sheet.rowCount).toBe(4); // header + 3 cost centres
      expect(cell(sheet, 2, 'Tag Name')).toBe('Cost Centre');
      expect(cell(sheet, 2, 'Options')).toBe('Mumbai Branch');
      expect(cell(sheet, 3, 'Options')).toBe('Bangalore Branch');
      expect(cell(sheet, 4, 'Options')).toBe('Admin');
    });
  });

  describe('Invoice.xlsx', () => {
    it('emits one row per inventory line, resolving HSN/tax from the item master, plus one row for a ledger-only voucher', async () => {
      const sheet = await loadSheet(buffers['Invoice.xlsx'], 'Invoice');
      // header + 2 lines from INV-1001 + 1 service row from INV-1002 + 1
      // line from INV-1003.
      expect(sheet.rowCount).toBe(5);

      expect(cell(sheet, 2, 'Invoice Number')).toBe('INV-1001');
      expect(cell(sheet, 2, 'Invoice Date')).toEqual(utcNoon(2026, 4, 5));
      expect(cell(sheet, 2, 'Customer Name')).toBe('Rohan Traders');
      expect(cell(sheet, 2, 'GST Treatment')).toBe('business_gst');
      expect(cell(sheet, 2, 'GST Identification Number (GSTIN)')).toBe('27AABCU9603R1ZM');
      expect(cell(sheet, 2, 'Place of Supply')).toBe('Maharashtra');
      expect(cell(sheet, 2, 'Item Name')).toBe('Widget A');
      expect(cell(sheet, 2, 'SKU')).toBe('WID-A');
      expect(cell(sheet, 2, 'Item Desc')).toBe('Standard widget');
      expect(cell(sheet, 2, 'HSN/SAC')).toBe('84819000');
      expect(cell(sheet, 2, 'Quantity')).toBe(10);
      expect(cell(sheet, 2, 'Usage unit')).toBe('Nos');
      expect(cell(sheet, 2, 'Item Price')).toBe(250);
      expect(cell(sheet, 2, 'Item Tax')).toBe('GST18');
      expect(cell(sheet, 2, 'Item Tax %')).toBe(18);
      expect(cell(sheet, 2, 'Item Tax Type')).toBe('ItemAmount');
      expect(cell(sheet, 2, 'Notes')).toBe('Sale of widgets');

      expect(cell(sheet, 3, 'Item Name')).toBe('Widget B');
      expect(cell(sheet, 3, 'Item Tax')).toBe('GST12');
      expect(cell(sheet, 3, 'Quantity')).toBe(5);

      // INV-1002 — a ledger-only service invoice, no stock item at all. Used
      // to be silently dropped entirely; now derives Item Tax straight off
      // the posted Output IGST ledger entry instead of an item lookup.
      expect(cell(sheet, 4, 'Invoice Number')).toBe('INV-1002');
      expect(cell(sheet, 4, 'Customer Name')).toBe('Rohan Traders');
      expect(cell(sheet, 4, 'Item Name')).toBeFalsy();
      expect(cell(sheet, 4, 'Item Type')).toBe('service');
      expect(cell(sheet, 4, 'Item Tax')).toBe('IGST18');
      expect(cell(sheet, 4, 'Item Tax %')).toBe(18);
      expect(cell(sheet, 4, 'Item Price')).toBe(5000); // the non-tax ledger value (Consulting Income)
      expect(cell(sheet, 4, 'Notes')).toBe('Consulting services rendered');

      expect(cell(sheet, 5, 'Invoice Number')).toBe('INV-1003');
      expect(cell(sheet, 5, 'Customer Name')).toBe('Priya Distributors');
      expect(cell(sheet, 5, 'Place of Supply')).toBe('West Bengal');
      expect(cell(sheet, 5, 'Item Name')).toBe('Widget B');
      expect(cell(sheet, 5, 'Quantity')).toBe(20);
      expect(cell(sheet, 5, 'Item Price')).toBe(380);

      // Compliance/logistics columns with no Tally source stay blank.
      expect(cell(sheet, 2, 'Payment Terms')).toBeFalsy();
      expect(cell(sheet, 2, 'Sales person')).toBeFalsy();
      // No TDS/TCS ledger entries on any of these vouchers — must stay blank.
      expect(cell(sheet, 2, 'TDS Amount')).toBeFalsy();
      expect(cell(sheet, 2, 'TCS Amount')).toBeFalsy();
    });
  });

  describe('Bill.xlsx', () => {
    it('computes a real Tax Amount from quantity x rate x item GST rate, plus SubTotal/Total/Balance/TDS/PO Number', async () => {
      const sheet = await loadSheet(buffers['Bill.xlsx'], 'Bill');
      expect(sheet.rowCount).toBe(2);
      expect(cell(sheet, 2, 'Bill Number')).toBe('PUR-2001');
      expect(cell(sheet, 2, 'Bill Date')).toEqual(utcNoon(2026, 4, 10));
      expect(cell(sheet, 2, 'Vendor Name')).toBe('Global Supplies Pvt Ltd');
      expect(cell(sheet, 2, 'GST Identification Number (GSTIN)')).toBe('29AAACG1234F1Z5');
      expect(cell(sheet, 2, 'Purchase Order Number')).toBe('PO-55'); // voucher.reference
      expect(cell(sheet, 2, 'Item Name')).toBe('Raw Material X');
      expect(cell(sheet, 2, 'SKU')).toBeFalsy();
      expect(cell(sheet, 2, 'Usage unit')).toBe('Kg');
      expect(cell(sheet, 2, 'Quantity')).toBe(200);
      expect(cell(sheet, 2, 'Rate')).toBe(100);
      expect(cell(sheet, 2, 'Tax Name')).toBe('GST5');
      expect(cell(sheet, 2, 'Tax Percentage')).toBe(5);
      expect(cell(sheet, 2, 'Tax Amount')).toBe(1000); // 20000 * 5%
      expect(cell(sheet, 2, 'Tax Type')).toBe('ItemAmount');
      expect(cell(sheet, 2, 'Item Total')).toBe(20000);
      expect(cell(sheet, 2, 'SubTotal')).toBe(20000);
      expect(cell(sheet, 2, 'Total')).toBe(21000); // 20000 + 1000 tax
      expect(cell(sheet, 2, 'Balance')).toBe(21000);
      expect(cell(sheet, 2, 'TDS Name')).toBe('TDS on Contractor');
      expect(cell(sheet, 2, 'TDS Amount')).toBe(400);
      expect(cell(sheet, 2, 'TDS Percentage')).toBe(2); // 400 / 20000 * 100
      expect(cell(sheet, 2, 'HSN/SAC')).toBe('39269099');
      expect(cell(sheet, 2, 'Vendor Notes')).toBe('Purchase of raw material');
      // No TCS ledger entry on this voucher — must stay blank.
      expect(cell(sheet, 2, 'TCS Amount')).toBeFalsy();
    });
  });

  describe('Credit Note.xlsx', () => {
    it('mirrors the Invoice shape for a sales return', async () => {
      const sheet = await loadSheet(buffers['Credit Note.xlsx'], 'Credit Note');
      expect(sheet.rowCount).toBe(2);
      expect(cell(sheet, 2, 'Credit Note Number')).toBe('CN-3001');
      expect(cell(sheet, 2, 'Credit Note Date')).toEqual(utcNoon(2026, 4, 15));
      expect(cell(sheet, 2, 'Reference#')).toBe('RMA-2026-01'); // voucher.reference
      expect(cell(sheet, 2, 'Customer Name')).toBe('Rohan Traders');
      expect(cell(sheet, 2, 'Item Name')).toBe('Widget A');
      expect(cell(sheet, 2, 'Quantity')).toBe(1);
      expect(cell(sheet, 2, 'Item Tax')).toBe('GST18');
      expect(cell(sheet, 2, 'Item Tax Type')).toBe('ItemAmount');
      expect(cell(sheet, 2, 'Notes')).toBe('Sales return - damaged widget');
      // Tally has no reason-code field for a Credit Note — left blank, not
      // duplicated from Notes.
      expect(cell(sheet, 2, 'Reason')).toBeFalsy();
      // No TCS ledger entry on this voucher — must stay blank.
      expect(cell(sheet, 2, 'TCS Amount')).toBeFalsy();
    });
  });

  describe('Stock Journal.xlsx (Inventory Adjustment)', () => {
    it('carries quantity/value deltas per item line, with no fabricated running-balance columns', async () => {
      const sheet = await loadSheet(buffers['Stock Journal.xlsx'], 'Inventory Adjustment');
      expect(sheet.rowCount).toBe(3); // header + 2 lines from the one voucher
      expect(cell(sheet, 2, 'Date')).toEqual(utcNoon(2026, 4, 20));
      expect(cell(sheet, 2, 'Status')).toBe('adjusted');
      expect(cell(sheet, 2, 'Reference Number')).toBe('ADJ-01'); // voucher.reference, not voucherNumber
      expect(cell(sheet, 2, 'Description')).toBe('Stock adjustment - physical count variance');
      expect(cell(sheet, 2, 'Item Name')).toBe('Widget A');
      expect(cell(sheet, 2, 'Quantity Adjusted')).toBe(-2);
      expect(cell(sheet, 2, 'Adjusted Value')).toBe(-500);
      expect(cell(sheet, 2, 'Unit')).toBe('Nos');

      expect(cell(sheet, 3, 'Item Name')).toBe('Raw Material X');
      expect(cell(sheet, 3, 'SKU')).toBeFalsy();
      expect(cell(sheet, 3, 'Quantity Adjusted')).toBe(10);
      expect(cell(sheet, 3, 'Unit')).toBe('Kg');

      // These need a genuine running stock balance this project doesn't
      // have — must stay blank rather than wrong (see stock-journal.mapper.ts).
      expect(cell(sheet, 2, 'New Quantity on Hand')).toBeFalsy();
      expect(cell(sheet, 2, 'New Value')).toBeFalsy();
      expect(cell(sheet, 2, 'Cost Price')).toBeFalsy();
      expect(cell(sheet, 2, 'Reason')).toBeFalsy();
    });
  });
});
