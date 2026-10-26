/**
 * Generates a demo "every Zoho template, seeded and zipped" export from a
 * small fixture company (src/mapping/sample-company.fixture.ts) — the exact
 * same mappers + ExcelGeneratorService + real template files, and the exact
 * same fixture, that full-export-pipeline.spec.ts asserts against cell by
 * cell. Run this to get a real .zip to open and eyeball by hand; run the
 * test to get an automated guarantee the same pipeline stays correct.
 *
 * This is NOT a substitute for a real bulk export against a live Tally
 * company (see BulkExportService / POST /extractions/bulk-export) — it
 * proves the templates/mappers/zip plumbing is wired correctly end to end
 * using invented sample data, not that any particular org's real Tally data
 * extracts cleanly.
 *
 * Usage: npm run sample:export
 */
import * as path from 'path';
import { BankTransferMapper } from '../src/mapping/bank-transfer.mapper';
import { ExcelGeneratorService } from '../src/excel/excel-generator.service';
import { ZipService } from '../src/excel/zip.service';
import { BillMapper } from '../src/mapping/bill.mapper';
import { CostCentreMapper } from '../src/mapping/cost-centre.mapper';
import { CreditNoteMapper } from '../src/mapping/credit-note.mapper';
import { CustomerMapper } from '../src/mapping/customer.mapper';
import { CustomerPaymentMapper } from '../src/mapping/customer-payment.mapper';
import { DepositMapper } from '../src/mapping/deposit.mapper';
import { ExpenseMapper } from '../src/mapping/expense.mapper';
import { GroupHierarchyResolver } from '../src/mapping/group-hierarchy.resolver';
import { InvoiceMapper } from '../src/mapping/invoice.mapper';
import { JournalMapper } from '../src/mapping/journal.mapper';
import { LedgerMapper } from '../src/mapping/ledger.mapper';
import {
  SAMPLE_BILL_VOUCHERS,
  SAMPLE_CONTRA_VOUCHERS,
  SAMPLE_COST_CENTRES,
  SAMPLE_CREDIT_NOTE_VOUCHERS,
  SAMPLE_DEBIT_NOTE_VOUCHERS,
  SAMPLE_GROUPS,
  SAMPLE_INVOICE_VOUCHERS,
  SAMPLE_JOURNAL_VOUCHERS,
  SAMPLE_LEDGERS,
  SAMPLE_PAYMENT_VOUCHERS,
  SAMPLE_RECEIPT_VOUCHERS,
  SAMPLE_STOCK_ITEMS,
  SAMPLE_STOCK_JOURNAL_VOUCHERS,
} from '../src/mapping/sample-company.fixture';
import { StockItemMapper } from '../src/mapping/stock-item.mapper';
import { StockJournalMapper } from '../src/mapping/stock-journal.mapper';
import { VendorCreditMapper } from '../src/mapping/vendor-credit.mapper';
import { VendorMapper } from '../src/mapping/vendor.mapper';
import { VendorPaymentMapper } from '../src/mapping/vendor-payment.mapper';
import { buildLedgerIndex, buildStockItemIndex } from '../src/mapping/voucher-line.shared';
import { templatePathFor, ZOHO_ENTITIES, ZohoEntityKey } from '../src/mapping/zoho-entity.map';
import * as fs from 'fs/promises';

async function main(): Promise<void> {
  const excel = new ExcelGeneratorService();
  const zip = new ZipService();
  const hierarchy = new GroupHierarchyResolver(SAMPLE_GROUPS);
  const itemIndex = buildStockItemIndex(SAMPLE_STOCK_ITEMS);
  const ledgerIndex = buildLedgerIndex(SAMPLE_LEDGERS);

  const rowsByEntity: Record<ZohoEntityKey, object[]> = {
    COA: new LedgerMapper(hierarchy).toAccountRows(SAMPLE_LEDGERS),
    CUSTOMER: new CustomerMapper(hierarchy).toCustomerRows(SAMPLE_LEDGERS),
    VENDOR: new VendorMapper(hierarchy).toVendorRows(SAMPLE_LEDGERS),
    ITEM: new StockItemMapper().toItemRows(SAMPLE_STOCK_ITEMS),
    COST_CENTRE: new CostCentreMapper().toReportingTagRows(SAMPLE_COST_CENTRES),
    INVOICE: new InvoiceMapper(itemIndex, ledgerIndex).toInvoiceRows(SAMPLE_INVOICE_VOUCHERS),
    BILL: new BillMapper(itemIndex, ledgerIndex).toBillRows(SAMPLE_BILL_VOUCHERS),
    CREDIT_NOTE: new CreditNoteMapper(itemIndex, ledgerIndex).toCreditNoteRows(
      SAMPLE_CREDIT_NOTE_VOUCHERS,
    ),
    STOCK_JOURNAL: new StockJournalMapper(itemIndex).toStockJournalRows(
      SAMPLE_STOCK_JOURNAL_VOUCHERS,
    ),
    JOURNAL: new JournalMapper().toJournalRows(SAMPLE_JOURNAL_VOUCHERS),
    VENDOR_CREDIT: new VendorCreditMapper(itemIndex, ledgerIndex).toVendorCreditRows(
      SAMPLE_DEBIT_NOTE_VOUCHERS,
    ),
    CUSTOMER_PAYMENT: new CustomerPaymentMapper(ledgerIndex).toCustomerPaymentRows(
      SAMPLE_RECEIPT_VOUCHERS,
    ),
    VENDOR_PAYMENT: new VendorPaymentMapper(ledgerIndex, hierarchy).toVendorPaymentRows(
      SAMPLE_PAYMENT_VOUCHERS,
    ),
    EXPENSE: new ExpenseMapper(ledgerIndex, hierarchy).toExpenseRows(SAMPLE_PAYMENT_VOUCHERS),
    DEPOSIT: new DepositMapper(ledgerIndex, hierarchy).toDepositRows(SAMPLE_CONTRA_VOUCHERS),
    BANK_TRANSFER: new BankTransferMapper(ledgerIndex, hierarchy).toBankTransferRows(
      SAMPLE_CONTRA_VOUCHERS,
    ),
  };

  // Filenames match the project root's "Master and Invoice or Bill/" folder
  // exactly, for immediate recognizability against the originals. DEPOSIT
  // and BANK_TRANSFER share one real template file (2 sheets) but need
  // distinct output names so neither overwrites the other in the zip.
  const filenameByEntity: Record<ZohoEntityKey, string> = {
    COA: 'COA.xlsx',
    CUSTOMER: 'Customer.xlsx',
    VENDOR: 'Vendor.xlsx',
    ITEM: 'Item.xlsx',
    COST_CENTRE: 'Class.xlsx',
    INVOICE: 'Invoice.xlsx',
    BILL: 'Bill.xlsx',
    CREDIT_NOTE: 'Credit Note.xlsx',
    STOCK_JOURNAL: 'Stock Journal.xlsx',
    JOURNAL: 'Journal.xlsx',
    VENDOR_CREDIT: 'Vendor_Credits.xlsx',
    CUSTOMER_PAYMENT: 'Customer_Payment.xlsx',
    VENDOR_PAYMENT: 'Vendor_Payment.xlsx',
    EXPENSE: 'Expense.xlsx',
    DEPOSIT: 'Deposit.xlsx',
    BANK_TRANSFER: 'Bank Transfer.xlsx',
  };

  const entries = [];
  console.log('Writing sample data into each real Zoho template:\n');
  for (const key of Object.keys(ZOHO_ENTITIES) as ZohoEntityKey[]) {
    const { sheetName } = ZOHO_ENTITIES[key];
    const rows = rowsByEntity[key];
    const buffer = await excel.writeIntoTemplate(templatePathFor(key), sheetName, rows);
    const filename = filenameByEntity[key];
    entries.push({ filename, buffer });
    console.log(`  ${filename.padEnd(20)} sheet "${sheetName}"  ${rows.length} row(s)`);
  }

  const zipBuffer = await zip.buildZip(entries);
  const outDir = path.resolve(__dirname, '..', 'public', 'exports');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'sample-full-export.zip');
  await fs.writeFile(outPath, zipBuffer);

  console.log(`\nWrote ${entries.length} templates into ${outPath} (${zipBuffer.length} bytes).`);
  console.log(
    'This is SAMPLE data (see src/mapping/sample-company.fixture.ts), not a real ' +
      'org export — run POST /extractions/bulk-export against a live Tally connector for that.',
  );
}

main().catch((err) => {
  console.error('Sample export generation failed:', err);
  process.exitCode = 1;
});
