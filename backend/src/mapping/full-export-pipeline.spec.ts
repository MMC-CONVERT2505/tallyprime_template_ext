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
import { buildLedgerIndex, buildStockItemIndex } from './voucher-line.shared';
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
  const ledgerIndex = buildLedgerIndex(ledgers);

  let buffers: Record<string, Buffer>;

  beforeAll(async () => {
    const coaRows = new LedgerMapper(hierarchy).toAccountRows(ledgers);
    const customerRows = new CustomerMapper(hierarchy).toCustomerRows(ledgers);
    const vendorRows = new VendorMapper(hierarchy).toVendorRows(ledgers);
    const itemRows = new StockItemMapper().toItemRows(stockItems);
    const reportingTagRows = new CostCentreMapper().toReportingTagRows(costCentres);
    const invoiceRows = new InvoiceMapper(itemIndex, ledgerIndex).toInvoiceRows(
      SAMPLE_INVOICE_VOUCHERS,
    );
    const billRows = new BillMapper(itemIndex, ledgerIndex).toBillRows(SAMPLE_BILL_VOUCHERS);
    const creditNoteRows = new CreditNoteMapper(itemIndex, ledgerIndex).toCreditNoteRows(
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
      // header + Office Rent + HDFC Bank Current A/c + Cash + ICICI Bank
      // Savings A/c (the last 2 added 2026-10-21 as Contra-voucher fixture
      // ledgers — see sample-company.fixture.ts).
      expect(sheet.rowCount).toBe(5);

      expect(cell(sheet, 2, 'Account Name')).toBe('Office Rent');
      expect(cell(sheet, 2, 'Description')).toBe('Monthly office rent');
      expect(cell(sheet, 2, 'Account Type')).toBe('Other Expense'); // via custom subgroup -> Indirect Expenses
      expect(cell(sheet, 2, 'Parent Account')).toBe('Office Expenses');
      expect(cell(sheet, 2, 'Currency')).toBe('INR');
      expect(cell(sheet, 2, 'Opening Balance')).toBe(0);
      expect(cell(sheet, 2, 'Debit or Credit')).toBe('Credit');
      expect(cell(sheet, 2, 'Account Code')).toBeFalsy(); // no Tally source — must stay blank
      // Account # / Master Id (2026-10-20) — from ledger.alterId.
      expect(cell(sheet, 2, 'Account #')).toBe(103);

      expect(cell(sheet, 3, 'Account Name')).toBe('HDFC Bank Current A/c');
      expect(cell(sheet, 3, 'Account #')).toBe(104);
      expect(cell(sheet, 3, 'Account Type')).toBe('Bank'); // via custom subgroup -> Bank Accounts
      expect(cell(sheet, 3, 'Opening Balance')).toBe(250000);
      expect(cell(sheet, 3, 'Debit or Credit')).toBe('Debit');

      expect(cell(sheet, 4, 'Account Name')).toBe('Cash');
      expect(cell(sheet, 4, 'Account #')).toBe(105);
      expect(cell(sheet, 4, 'Account Type')).toBe('Cash'); // Cash-in-Hand is itself a standard group
      expect(cell(sheet, 4, 'Opening Balance')).toBe(15000);

      expect(cell(sheet, 5, 'Account Name')).toBe('ICICI Bank Savings A/c');
      expect(cell(sheet, 5, 'Account #')).toBe(106);
      expect(cell(sheet, 5, 'Account Type')).toBe('Bank');
      expect(cell(sheet, 5, 'Opening Balance')).toBe(500000);

      // Rohan Traders / Global Supplies never appear here — they belong to
      // Customer.xlsx / Vendor.xlsx instead.
      const names = [2, 3, 4, 5].map((r) => cell(sheet, r, 'Account Name'));
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
      // Account Holder Name/IFS Code (2026-10-20) — new columns added to the
      // real template, populated from the same PAYMENTDETAILS.LIST entry.
      expect(cell(sheet, 2, 'Account Holder Name')).toBe('Global Supplies Pvt Ltd');
      expect(cell(sheet, 2, 'IFS Code')).toBe('HDFC0000123');
      // SWIFT Code always stays blank — no such field exists in Tally's
      // domestic (IFSC-based) bank details at all.
      expect(cell(sheet, 2, 'SWIFT Code')).toBeFalsy();
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
      // "Item Type" is Zoho's usage-scope column (Sales/Purchases), not
      // goods/service — "Product Type" (added 2026-09-10, from
      // TallyStockItem.itemType/GSTTYPEOFSUPPLY) is the real classification.
      // See stock-item.mapper.ts's doc comment.
      expect(cell(sheet, 2, 'Item Type')).toBe('Sales and Purchases');
      expect(cell(sheet, 2, 'Product Type')).toBe('goods');
      expect(cell(sheet, 2, 'Status')).toBe('Active');
      expect(cell(sheet, 2, 'Intra State Tax Name')).toBe('GST18');
      expect(cell(sheet, 2, 'Intra State Tax Rate')).toBe(18);
      expect(cell(sheet, 2, 'Intra State Tax Type')).toBe('Group');
      expect(cell(sheet, 2, 'Inter State Tax Name')).toBe('IGST18');
      expect(cell(sheet, 2, 'Inter State Tax Rate')).toBe(18);
      // Account/Purchase Account/Inventory Account are always hardcoded
      // (2026-10-20 reviewer feedback), regardless of what Tally has
      // configured for this item's default ledgers.
      expect(cell(sheet, 2, 'Account')).toBe('Sales');
      expect(cell(sheet, 2, 'Purchase Account')).toBe('Cost of Goods Sold');
      expect(cell(sheet, 2, 'Inventory Account')).toBe('Inventory Asset');
      expect(cell(sheet, 2, 'Rate')).toBeFalsy(); // always written as 0
      expect(cell(sheet, 2, 'Purchase Rate')).toBeFalsy(); // always written as 0
      // Stock Group (2026-10-20) — new column, from TallyStockItem.parent.
      expect(cell(sheet, 2, 'Stock Group')).toBe('Finished Goods');

      expect(cell(sheet, 4, 'Item Name')).toBe('Raw Material X');
      expect(cell(sheet, 4, 'Alias Name')).toBeFalsy(); // no alias in Tally for this one
      expect(cell(sheet, 4, 'Stock On Hand')).toBe(300);
      expect(cell(sheet, 4, 'Intra State Tax Name')).toBe('GST5');
      expect(cell(sheet, 4, 'Stock Group')).toBe('Raw Materials');
      // Item.xlsx has both a "SKU" and a separate "Alias Name" column — both
      // get the same TallyStockItem.alias value (see stock-item.mapper.ts's
      // doc comment), so row 2 (which has an alias) carries it on both.
      expect(cell(sheet, 2, 'SKU')).toBe('WID-A');
      // Row 4 has no alias in Tally, so both stay blank.
      expect(cell(sheet, 4, 'SKU')).toBeFalsy();
      // No Tally source for this — always written as 0, not blank (2026-10-20
      // reviewer feedback), which is also falsy.
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

  describe('Invoice.xlsx (185-column template, replaced 2026-10-20)', () => {
    it('emits one row per inventory line, resolving HSN/tax from the item master, plus one row for a ledger-only voucher', async () => {
      const sheet = await loadSheet(buffers['Invoice.xlsx'], 'Invoice');
      // header + 2 lines from INV-1001 + 1 service row from INV-1002 + 1
      // line from INV-1003.
      expect(sheet.rowCount).toBe(5);

      expect(cell(sheet, 2, 'Invoice Number')).toBe('INV-1001');
      expect(cell(sheet, 2, 'Invoice Date')).toEqual(utcNoon(2026, 4, 5));
      expect(cell(sheet, 2, 'Customer Name')).toBe('Rohan Traders');
      // Customer Number (2026-10-20) — ledger.alterId, via the new ledger join.
      expect(cell(sheet, 2, 'Customer Number')).toBe(101);
      expect(cell(sheet, 2, 'GST Treatment')).toBe('business_gst');
      expect(cell(sheet, 2, 'GST Identification Number (GSTIN)')).toBe('27AABCU9603R1ZM');
      expect(cell(sheet, 2, 'Place of Supply')).toBe('Maharashtra');
      expect(cell(sheet, 2, 'Item Name')).toBe('Widget A');
      // SKU no longer exists on this template at all (the old 72-column one had it).
      expect(headerRow(sheet)).not.toContain('SKU');
      expect(cell(sheet, 2, 'Item Desc')).toBe('Standard widget');
      expect(cell(sheet, 2, 'HSN/SAC')).toBe('84819000');
      expect(cell(sheet, 2, 'Quantity')).toBe(10);
      expect(cell(sheet, 2, 'Usage unit')).toBe('Nos');
      expect(cell(sheet, 2, 'Item Price')).toBe(250);
      expect(cell(sheet, 2, 'Item Total')).toBe(2500);
      // Place of Supply (Maharashtra) matches the resolved home state (the
      // most common GST Registration/Place of Supply across this batch —
      // see invoice.mapper.ts's resolveHomeState) -> intra-state.
      expect(cell(sheet, 2, 'Item Tax')).toBe('GST18');
      expect(cell(sheet, 2, 'Item Tax %')).toBe(18);
      expect(cell(sheet, 2, 'Item Tax Type')).toBe('ItemAmount');
      expect(cell(sheet, 2, 'CGST Rate %')).toBe(9);
      expect(cell(sheet, 2, 'SGST Rate %')).toBe(9);
      expect(cell(sheet, 2, 'IGST Rate %')).toBeFalsy();
      expect(cell(sheet, 2, 'CGST')).toBe(225); // 2500 * 9%
      expect(cell(sheet, 2, 'SGST')).toBe(225);
      expect(cell(sheet, 2, 'IGST')).toBeFalsy();
      expect(cell(sheet, 2, 'Notes')).toBe('Sale of widgets');
      // Billing/Primary Contact (2026-10-20) — from the same ledger join.
      expect(cell(sheet, 2, 'Billing Address')).toBe('12 MG Road, Andheri');
      expect(cell(sheet, 2, 'Billing State')).toBe('Maharashtra');
      expect(cell(sheet, 2, 'Billing Country')).toBe('India');
      expect(cell(sheet, 2, 'Billing Code')).toBe('400001');
      expect(cell(sheet, 2, 'Billing Phone')).toBe('02212345678');
      expect(cell(sheet, 2, 'Primary Contact EmailID')).toBe('rohan@traders.in');
      expect(cell(sheet, 2, 'Primary Contact Mobile')).toBe('9876543210');
      // Shipping mirrors Billing — Tally has no separate ship-to address.
      expect(cell(sheet, 2, 'Shipping Address')).toBe('12 MG Road, Andheri');
      expect(cell(sheet, 2, 'Shipping State')).toBe('Maharashtra');

      expect(cell(sheet, 3, 'Item Name')).toBe('Widget B');
      expect(cell(sheet, 3, 'Item Tax')).toBe('GST12');
      expect(cell(sheet, 3, 'Quantity')).toBe(5);
      expect(cell(sheet, 3, 'CGST Rate %')).toBe(6);
      expect(cell(sheet, 3, 'SGST Rate %')).toBe(6);

      // INV-1002 — a ledger-only service invoice, no stock item at all. Used
      // to be silently dropped entirely; derives Item Tax AND the CGST/SGST/
      // IGST split straight off the posted Output IGST ledger entry's own
      // real kind, not the home-state heuristic (which only applies to the
      // inventory-line branch above — see gstSplitFromPostedKind's doc
      // comment for why this one has better information available).
      expect(cell(sheet, 4, 'Invoice Number')).toBe('INV-1002');
      expect(cell(sheet, 4, 'Customer Name')).toBe('Rohan Traders');
      expect(cell(sheet, 4, 'Item Name')).toBeFalsy();
      expect(cell(sheet, 4, 'Item Type')).toBe('service');
      expect(cell(sheet, 4, 'Item Tax')).toBe('IGST18');
      expect(cell(sheet, 4, 'Item Tax %')).toBe(18);
      expect(cell(sheet, 4, 'Item Tax Amount')).toBe(900);
      expect(cell(sheet, 4, 'IGST Rate %')).toBe(18);
      expect(cell(sheet, 4, 'IGST')).toBe(900);
      expect(cell(sheet, 4, 'CGST Rate %')).toBeFalsy();
      expect(cell(sheet, 4, 'SGST Rate %')).toBeFalsy();
      expect(cell(sheet, 4, 'Item Price')).toBe(5000); // the non-tax ledger value (Consulting Income)
      expect(cell(sheet, 4, 'Item Total')).toBe(5000);
      expect(cell(sheet, 4, 'Notes')).toBe('Consulting services rendered');

      // INV-1003 — Place of Supply (West Bengal) differs from the resolved
      // home state (Maharashtra) -> inter-state, demonstrating the
      // heuristic actually switches to IGST for a genuinely different-state
      // sale rather than always defaulting to intra-state.
      expect(cell(sheet, 5, 'Invoice Number')).toBe('INV-1003');
      expect(cell(sheet, 5, 'Customer Name')).toBe('Priya Distributors');
      expect(cell(sheet, 5, 'Customer Number')).toBe(105);
      expect(cell(sheet, 5, 'Place of Supply')).toBe('West Bengal');
      expect(cell(sheet, 5, 'Item Name')).toBe('Widget B');
      expect(cell(sheet, 5, 'Quantity')).toBe(20);
      expect(cell(sheet, 5, 'Item Price')).toBe(380);
      expect(cell(sheet, 5, 'Item Tax')).toBe('IGST12');
      expect(cell(sheet, 5, 'IGST Rate %')).toBe(12);
      expect(cell(sheet, 5, 'CGST Rate %')).toBeFalsy();
      expect(cell(sheet, 5, 'Billing State')).toBe('West Bengal');
      expect(cell(sheet, 5, 'Primary Contact EmailID')).toBe('billing@priyadist.in');

      // Compliance/logistics/payment-gateway columns with no Tally source
      // stay blank — a representative sample, not exhaustive.
      expect(cell(sheet, 2, 'Payment Terms')).toBeFalsy();
      expect(cell(sheet, 2, 'Sales person')).toBeFalsy();
      expect(cell(sheet, 2, 'Invoice ID')).toBeFalsy();
      expect(cell(sheet, 2, 'Supplier Org Name')).toBeFalsy();
      expect(cell(sheet, 2, 'E-WayBill Number')).toBeFalsy();
      expect(cell(sheet, 2, 'PayPal')).toBeFalsy();
      expect(cell(sheet, 2, 'CESS Rate %')).toBeFalsy();
      // No TDS/TCS/Round Off ledger entries on any of these vouchers — must stay blank/0.
      expect(cell(sheet, 2, 'TDS Amount')).toBeFalsy();
      expect(cell(sheet, 2, 'TCS Amount')).toBeFalsy();
      expect(cell(sheet, 2, 'Round Off')).toBeFalsy();
    });
  });

  describe('Bill.xlsx (104-column template, replaced 2026-10-21)', () => {
    it('computes a real Tax Amount from quantity x rate x item GST rate, plus SubTotal/Total/Balance/TDS/PO Number', async () => {
      const sheet = await loadSheet(buffers['Bill.xlsx'], 'Bill');
      expect(sheet.rowCount).toBe(2);
      expect(cell(sheet, 2, 'Bill Number')).toBe('PUR-2001');
      expect(cell(sheet, 2, 'Bill Date')).toEqual(utcNoon(2026, 4, 10));
      expect(cell(sheet, 2, 'Vendor Name')).toBe('Global Supplies Pvt Ltd');
      // Vendor Number (2026-10-21) — ledger.alterId, via the new ledger join.
      expect(cell(sheet, 2, 'Vendor Number')).toBe(102);
      expect(cell(sheet, 2, 'GST Identification Number (GSTIN)')).toBe('29AAACG1234F1Z5');
      // SKU no longer exists on this template at all (the old 60-column one had it).
      expect(headerRow(sheet)).not.toContain('SKU');
      // Same real voucher.reference value under all 3 of these column names.
      expect(cell(sheet, 2, 'Purchase Order Number')).toBe('PO-55');
      expect(cell(sheet, 2, 'PurchaseOrder')).toBe('PO-55');
      expect(cell(sheet, 2, 'Supplier Invoice No')).toBe('PO-55');
      expect(cell(sheet, 2, 'Item Name')).toBe('Raw Material X');
      expect(cell(sheet, 2, 'Description')).toBeFalsy(); // item has no description set
      expect(cell(sheet, 2, 'Usage unit')).toBe('Kg');
      expect(cell(sheet, 2, 'Quantity')).toBe(200);
      expect(cell(sheet, 2, 'Rate')).toBe(100);
      expect(cell(sheet, 2, 'Discount')).toBeFalsy(); // no discountPercent on this line
      expect(cell(sheet, 2, 'Tax Name')).toBe('GST5');
      expect(cell(sheet, 2, 'Tax Percentage')).toBe(5);
      expect(cell(sheet, 2, 'Tax Amount')).toBe(1000); // 20000 * 5%
      expect(cell(sheet, 2, 'Tax Type')).toBe('ItemAmount');
      // CGST/SGST Rate % (2026-10-21) — always intra-state for Bill.xlsx
      // (no home-state heuristic attempted on the purchase side), so a 5%
      // combined rate splits evenly: 2.5% CGST + 2.5% SGST, never IGST.
      expect(cell(sheet, 2, 'CGST Rate %')).toBe(2.5);
      expect(cell(sheet, 2, 'SGST Rate %')).toBe(2.5);
      expect(cell(sheet, 2, 'IGST Rate %')).toBeFalsy();
      expect(cell(sheet, 2, 'CGST')).toBe(500);
      expect(cell(sheet, 2, 'SGST')).toBe(500);
      expect(cell(sheet, 2, 'IGST')).toBeFalsy();
      expect(cell(sheet, 2, 'Item Total')).toBe(20000);
      expect(cell(sheet, 2, 'Amount')).toBe(20000); // same value, second column name
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
      // No Tally source for these at all — a representative sample.
      expect(cell(sheet, 2, 'Customer Name')).toBeFalsy();
      expect(cell(sheet, 2, 'Is Billable')).toBeFalsy();
      expect(cell(sheet, 2, 'Cost Centre')).toBeFalsy();
    });
  });

  describe('Credit Note.xlsx (143-column template, replaced 2026-10-21)', () => {
    it('mirrors the Invoice shape for a sales return, including the new Billing block and CGST/SGST/IGST split', async () => {
      const sheet = await loadSheet(buffers['Credit Note.xlsx'], 'Credit Note');
      expect(sheet.rowCount).toBe(2);
      expect(cell(sheet, 2, 'Credit Note Number')).toBe('CN-3001');
      expect(cell(sheet, 2, 'Credit Note Date')).toEqual(utcNoon(2026, 4, 15));
      expect(cell(sheet, 2, 'Reference#')).toBe('RMA-2026-01'); // voucher.reference
      // Applied Invoice Number (2026-10-21) — the same real reference value
      // under a third column name, same convention as Bill.xlsx's trio.
      expect(cell(sheet, 2, 'Applied Invoice Number')).toBe('RMA-2026-01');
      expect(cell(sheet, 2, 'Customer Name')).toBe('Rohan Traders');
      // Customer Number + Billing block (2026-10-21) — via the new ledger join.
      expect(cell(sheet, 2, 'Customer Number')).toBe(101);
      expect(cell(sheet, 2, 'Billing Address')).toBe('12 MG Road, Andheri');
      expect(cell(sheet, 2, 'Billing State')).toBe('Maharashtra');
      expect(cell(sheet, 2, 'Billing Country')).toBe('India');
      expect(cell(sheet, 2, 'Billing Code')).toBe('400001');
      expect(cell(sheet, 2, 'Shipping Address')).toBe('12 MG Road, Andheri'); // mirrors Billing
      expect(cell(sheet, 2, 'Item Name')).toBe('Widget A');
      expect(cell(sheet, 2, 'Quantity')).toBe(1);
      expect(cell(sheet, 2, 'Item Tax')).toBe('GST18');
      expect(cell(sheet, 2, 'Item Tax Type')).toBe('ItemAmount');
      // Item Tax Amount is the FULL combined-rate tax (CGST+SGST together),
      // same formula as invoice.mapper.ts's identical column — the separate
      // CGST/SGST amount columns below are each half of this.
      expect(cell(sheet, 2, 'Item Tax Amount')).toBe(45); // 250 * 18%
      // CGST/SGST Rate % (2026-10-21) — Place of Supply (Maharashtra)
      // matches the resolved home state for this single-voucher batch -> intra-state.
      expect(cell(sheet, 2, 'CGST Rate %')).toBe(9);
      expect(cell(sheet, 2, 'SGST Rate %')).toBe(9);
      expect(cell(sheet, 2, 'IGST Rate %')).toBeFalsy();
      expect(cell(sheet, 2, 'CGST')).toBe(22.5);
      expect(cell(sheet, 2, 'SGST')).toBe(22.5);
      expect(cell(sheet, 2, 'Round Off')).toBe(0); // no Round Off entry on this voucher
      expect(cell(sheet, 2, 'Notes')).toBe('Sales return - damaged widget');
      // Tally has no reason-code field for a Credit Note — left blank, not
      // duplicated from Notes.
      expect(cell(sheet, 2, 'Reason')).toBeFalsy();
      // No TCS ledger entry on this voucher — must stay blank.
      expect(cell(sheet, 2, 'TCS Amount')).toBeFalsy();
      // "Branch"/"Branch Name" has no destination in this new template at
      // all (only the Zoho-internal "Branch ID" remains) — confirm it's
      // genuinely gone, not silently dropped by this mapper.
      expect(headerRow(sheet)).not.toContain('Branch');
      expect(headerRow(sheet)).not.toContain('Branch Name');
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
