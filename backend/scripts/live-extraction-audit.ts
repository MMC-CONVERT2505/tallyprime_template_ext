/**
 * Live end-to-end audit: drives the REAL production pipeline (EnvelopeBuilder
 * -> Tally HTTP -> TallyResponseParser -> per-entity mappers ->
 * ExcelGeneratorService, writing into the REAL Zoho template files) against
 * whatever Tally instance TALLY_HOST/TALLY_PORT (.env) points at — NOT the
 * sample-company.fixture.ts data full-export-pipeline.spec.ts and
 * generate-sample-export.ts use.
 *
 * Bypasses Nest DI (no DB/Redis/queue needed) — this only needs Tally
 * reachable. Talks to Tally directly with the same charset-decode logic
 * tally-http.client.ts uses, single request at a time (no overlapping calls),
 * and deliberately only uses request patterns already proven safe against a
 * live instance in this project's own incident history (see
 * MasterExtractionService/TallyConfig doc comments):
 *   - LEDGERS/STOCK_ITEMS/GROUPS/COST_CENTRES: UNSCOPED (no fromDate/toDate)
 *     — period-scoped requests are the ones documented to have wedged Tally.
 *   - VOUCHERS: ONE bounded-range request (no chunking loop) — chunking only
 *     exists to survive very wide ranges; a single bounded request is exactly
 *     what the real service does below its own chunk threshold anyway.
 *
 * Usage: npx ts-node scripts/live-extraction-audit.ts [fromDate] [toDate]
 *   dates as YYYYMMDD, default: company's FY-to-date (STARTINGFROM..today).
 *
 * Output: audit-output/live-<Company>-<timestamp>/*.xlsx (real templates,
 * real extracted rows) plus a printed coverage report — which template
 * columns got a real value vs. stayed blank, and why (cross-referenced
 * against each mapper's own documented Tally-source-exists rule) — plus
 * dependency sanity checks (group-hierarchy resolution, stock-item index
 * hit rate for voucher lines).
 */
import axios from 'axios';
import * as iconv from 'iconv-lite';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { EnvelopeBuilder } from '../src/tally/xml/envelope.builder';
import { TallyResponseParser } from '../src/tally/xml/response.parser';
import { buildTallyConfig } from '../src/config/configuration';
import { TallyLedger, TallyStockItem, TallyVoucher } from '../src/tally/interfaces/tally.interfaces';

import { GroupHierarchyResolver } from '../src/mapping/group-hierarchy.resolver';
import { LedgerMapper } from '../src/mapping/ledger.mapper';
import { CustomerMapper } from '../src/mapping/customer.mapper';
import { VendorMapper } from '../src/mapping/vendor.mapper';
import { StockItemMapper } from '../src/mapping/stock-item.mapper';
import { CostCentreMapper } from '../src/mapping/cost-centre.mapper';
import { InvoiceMapper } from '../src/mapping/invoice.mapper';
import { BillMapper } from '../src/mapping/bill.mapper';
import { CreditNoteMapper } from '../src/mapping/credit-note.mapper';
import { StockJournalMapper } from '../src/mapping/stock-journal.mapper';
import { buildStockItemIndex, tallyDateToJsDate } from '../src/mapping/voucher-line.shared';
import { ExcelGeneratorService } from '../src/excel/excel-generator.service';
import { templatePathFor, ZOHO_ENTITIES } from '../src/mapping/zoho-entity.map';
import * as ExcelJS from 'exceljs';

const tally = buildTallyConfig();
const builder = new EnvelopeBuilder();
const parser = new TallyResponseParser();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function post(xml: string, label: string): Promise<string> {
  const startedAt = Date.now();
  const response = await axios.post(tally.baseUrl, xml, {
    responseType: 'arraybuffer',
    timeout: tally.timeoutMs,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml, application/xml' },
    validateStatus: () => true,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label}: HTTP ${response.status}`);
  }
  const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
  const contentType = String(response.headers?.['content-type'] ?? '');
  const match = contentType.match(/charset=([^;]+)/i);
  let encoding = match ? match[1].trim().toLowerCase() : 'utf-8';
  if (encoding === 'utf8') encoding = 'utf-8';
  if (!iconv.encodingExists(encoding)) encoding = 'utf-8';
  const body = iconv.decode(buffer, encoding);
  console.log(`  [${label}] ${response.status} in ${Date.now() - startedAt}ms (${body.length} chars)`);
  return body;
}

interface ColumnCoverage {
  header: string;
  populatedRows: number;
  totalRows: number;
}

function coverageReport(headers: string[], rows: Record<string, unknown>[]): ColumnCoverage[] {
  return headers.map((header) => ({
    header,
    populatedRows: rows.filter((r) => {
      const v = r[header];
      return v !== undefined && v !== null && v !== '';
    }).length,
    totalRows: rows.length,
  }));
}

function printCoverage(entity: string, headers: string[], rows: Record<string, unknown>[]) {
  console.log(`\n--- ${entity}: ${rows.length} row(s), ${headers.length} template column(s) ---`);
  const cov = coverageReport(headers, rows);
  const populated = cov.filter((c) => c.populatedRows > 0);
  const blank = cov.filter((c) => c.populatedRows === 0);
  console.log(`  Populated in >=1 row: ${populated.length}/${headers.length}`);
  for (const c of populated) {
    const pct = rows.length ? Math.round((c.populatedRows / rows.length) * 100) : 0;
    console.log(`    [x] ${c.header.padEnd(45)} ${c.populatedRows}/${rows.length} rows (${pct}%)`);
  }
  console.log(`  Blank in ALL rows: ${blank.length}/${headers.length}`);
  for (const c of blank) {
    console.log(`    [ ] ${c.header}`);
  }
}

async function main() {
  console.log(`Tally base URL: ${tally.baseUrl}`);

  console.log('\n[1/7] Probing companies...');
  const companiesXml = await post(builder.buildCompaniesRequest(), 'companies');
  const companies = parser.mapCompanies(companiesXml);
  if (companies.length === 0) {
    throw new Error('No company loaded in Tally — open a company in TallyPrime first.');
  }
  const company = companies[0].name;
  console.log(`  Using company: "${company}" (startingFrom=${companies[0].startingFrom}, booksFrom=${companies[0].booksFrom})`);

  await sleep(300);
  console.log('\n[2/7] Fetching Groups (unscoped)...');
  const groupsXml = await post(builder.buildGroupsRequest(company), 'groups');
  const groups = parser.mapGroups(groupsXml);
  console.log(`  ${groups.length} group(s)`);

  await sleep(300);
  console.log('\n[3/7] Fetching Ledgers (unscoped — current balances)...');
  const ledgersXml = await post(builder.buildLedgersRequest(company), 'ledgers');
  const ledgers: TallyLedger[] = parser.mapLedgers(ledgersXml);
  console.log(`  ${ledgers.length} ledger(s)`);

  await sleep(300);
  console.log('\n[4/7] Fetching Stock Items (unscoped — current balances)...');
  const itemsXml = await post(builder.buildStockItemsRequest(company), 'stock-items');
  const stockItems: TallyStockItem[] = parser.mapStockItems(itemsXml);
  console.log(`  ${stockItems.length} stock item(s)`);

  await sleep(300);
  console.log('\n[5/7] Fetching Cost Centres...');
  const ccXml = await post(builder.buildCostCentresRequest(company), 'cost-centres');
  const costCentres = parser.mapCostCentres(ccXml);
  console.log(`  ${costCentres.length} cost centre(s)`);

  const fromDateArg = process.argv[2];
  const toDateArg = process.argv[3];
  const fromDate = fromDateArg ?? (companies[0].startingFrom ?? '20250401');
  const toDate = toDateArg ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');

  await sleep(300);
  console.log(`\n[6/7] Fetching Vouchers ${fromDate}-${toDate} (single bounded request, all types)...`);
  const vouchersXml = await post(builder.buildVouchersRequest(company, fromDate, toDate), 'vouchers');
  const allVouchers: TallyVoucher[] = parser.mapVouchers(vouchersXml);
  console.log(`  ${allVouchers.length} voucher(s) total`);

  const byType = new Map<string, number>();
  for (const v of allVouchers) {
    const t = v.voucherType ?? '(none)';
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  console.log('  Voucher type breakdown:');
  for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(6)}  ${t}`);
  }

  const norm = (s: string) => s.trim().toLowerCase();
  const salesVouchers = allVouchers.filter((v) => norm(v.voucherType ?? '') === 'sales');
  const purchaseVouchers = allVouchers.filter((v) => norm(v.voucherType ?? '') === 'purchase');
  const creditNoteVouchers = allVouchers.filter((v) => norm(v.voucherType ?? '') === 'credit note');
  const stockJournalVouchers = allVouchers.filter(
    (v) => norm(v.voucherType ?? '') === 'stock journal',
  );

  console.log('\n[7/7] Running real mappers + writing into real Zoho templates...');
  const hierarchy = new GroupHierarchyResolver(groups);
  const itemIndex = buildStockItemIndex(stockItems);

  const coaRows = new LedgerMapper(hierarchy).toAccountRows(ledgers);
  const customerRows = new CustomerMapper(hierarchy).toCustomerRows(ledgers);
  const vendorRows = new VendorMapper(hierarchy).toVendorRows(ledgers);
  const itemRows = new StockItemMapper().toItemRows(stockItems);
  const reportingTagRows = new CostCentreMapper().toReportingTagRows(costCentres);
  const invoiceRows = new InvoiceMapper(itemIndex).toInvoiceRows(salesVouchers);
  const billRows = new BillMapper(itemIndex).toBillRows(purchaseVouchers);
  const invoiceDatesByNumber = new Map<string, Date>();
  for (const v of salesVouchers) {
    const date = tallyDateToJsDate(v.date);
    if (v.voucherNumber && date) invoiceDatesByNumber.set(v.voucherNumber, date);
  }
  const creditNoteRows = new CreditNoteMapper(itemIndex, invoiceDatesByNumber).toCreditNoteRows(
    creditNoteVouchers,
  );
  const stockJournalRows = new StockJournalMapper(itemIndex).toStockJournalRows(
    stockJournalVouchers,
  );

  // ── Dependency sanity checks ──────────────────────────────────────────
  console.log('\n=== Dependency resolution sanity checks ===');
  const ledgerParents = new Set(ledgers.map((l) => l.parent).filter((p): p is string => !!p));
  let unresolvedParents = 0;
  for (const p of ledgerParents) {
    if (!hierarchy.resolveToStandardGroup(p)) unresolvedParents++;
  }
  console.log(
    `Ledger parent groups: ${ledgerParents.size} distinct, ${unresolvedParents} could not resolve to a standard group (Account Type will fall back to "Other Current Asset" default for those).`,
  );
  const coaClassified = new Map<string, number>();
  for (const r of coaRows) {
    coaClassified.set(r['Account Type'], (coaClassified.get(r['Account Type']) ?? 0) + 1);
  }
  console.log('COA Account Type distribution:', Object.fromEntries(coaClassified));

  const gstinCount = ledgers.filter((l) => l.gstin).length;
  const panCount = ledgers.filter((l) => l.panNumber).length;
  const emailCount = ledgers.filter((l) => l.email).length;
  console.log(
    `Ledgers with GSTIN: ${gstinCount}/${ledgers.length}, PAN: ${panCount}/${ledgers.length}, Email: ${emailCount}/${ledgers.length}`,
  );

  const hsnCount = stockItems.filter((s) => s.hsnCode).length;
  const gstRateCount = stockItems.filter((s) => s.gstRate !== null).length;
  const aliasCount = stockItems.filter((s) => s.alias).length;
  console.log(
    `Stock items with HSN: ${hsnCount}/${stockItems.length}, GST rate: ${gstRateCount}/${stockItems.length}, Alias: ${aliasCount}/${stockItems.length}`,
  );

  const invoiceLinesWithItem = invoiceRows.filter((r) => r['Item Name']).length;
  const invoiceItemMisses = invoiceRows.filter(
    (r) => r['Item Name'] && !r['HSN/SAC'],
  ).length;
  console.log(
    `Invoice lines with an item name: ${invoiceLinesWithItem}/${invoiceRows.length}; of those, ${invoiceItemMisses} had NO HSN resolved from the item index (stock-item lookup miss or item has no HSN in Tally).`,
  );
  const billLinesWithItem = billRows.filter((r) => r['Item Name']).length;
  const billItemMisses = billRows.filter((r) => r['Item Name'] && !r['HSN/SAC']).length;
  console.log(
    `Bill lines with an item name: ${billLinesWithItem}/${billRows.length}; of those, ${billItemMisses} had NO HSN resolved from the item index.`,
  );

  const invoiceServiceRows = invoiceRows.filter((r) => r['Item Type'] === 'service').length;
  const billServiceRows = billRows.filter((r) => r['Item Type'] === 'service').length;
  console.log(
    `Invoice rows with no inventory line (ledger-only "service" fallback row): ${invoiceServiceRows}/${invoiceRows.length}`,
  );
  console.log(
    `Bill rows with no inventory line (ledger-only "service" fallback row): ${billServiceRows}/${billRows.length}`,
  );

  // Vouchers dropped entirely (both inventoryEntries AND ledgerEntries empty)
  const salesDropped = salesVouchers.filter(
    (v) => v.inventoryEntries.length === 0 && v.ledgerEntries.length === 0,
  ).length;
  const purchaseDropped = purchaseVouchers.filter(
    (v) => v.inventoryEntries.length === 0 && v.ledgerEntries.length === 0,
  ).length;
  console.log(
    `Sales vouchers dropped (no inventory AND no ledger entries at all): ${salesDropped}/${salesVouchers.length}`,
  );
  console.log(
    `Purchase vouchers dropped (no inventory AND no ledger entries at all): ${purchaseDropped}/${purchaseVouchers.length}`,
  );

  // ── Write real templates ──────────────────────────────────────────────
  const excel = new ExcelGeneratorService();
  const outDir = path.resolve(
    __dirname,
    '..',
    'audit-output',
    `live-${company.replace(/[^a-zA-Z0-9]+/g, '_')}-${Date.now()}`,
  );
  await fs.mkdir(outDir, { recursive: true });

  const rowsByEntity: Record<string, object[]> = {
    COA: coaRows,
    CUSTOMER: customerRows,
    VENDOR: vendorRows,
    ITEM: itemRows,
    COST_CENTRE: reportingTagRows,
    INVOICE: invoiceRows,
    BILL: billRows,
    CREDIT_NOTE: creditNoteRows,
    STOCK_JOURNAL: stockJournalRows,
  };

  console.log(`\n=== Writing real Zoho templates to ${outDir} ===`);
  for (const key of Object.keys(rowsByEntity) as (keyof typeof ZOHO_ENTITIES)[]) {
    const { templateFile, sheetName } = ZOHO_ENTITIES[key];
    const rows = rowsByEntity[key];
    const buffer = await excel.writeIntoTemplate(templatePathFor(key), sheetName, rows as any[]);
    const outPath = path.join(outDir, templateFile);
    await fs.writeFile(outPath, buffer);
    console.log(`  ${templateFile.padEnd(20)} ${rows.length} row(s) -> ${outPath}`);

    // Re-open the written file to report per-column coverage against the
    // REAL header row (not the mapper's own TS interface) — the same
    // headers a Zoho import will actually see.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const sheet = wb.getWorksheet(sheetName)!;
    const headers: string[] = [];
    sheet.getRow(1).eachCell({ includeEmpty: false }, (cell) => headers.push(String(cell.value ?? '').trim()));
    printCoverage(templateFile, headers, rows as Record<string, unknown>[]);
  }

  console.log('\n=== Raw extracted-record dump (for spot-checking) ===');
  await fs.writeFile(
    path.join(outDir, '_raw-groups.json'),
    JSON.stringify(groups, null, 2),
  );
  await fs.writeFile(
    path.join(outDir, '_raw-ledgers-sample.json'),
    JSON.stringify(ledgers.slice(0, 20), null, 2),
  );
  await fs.writeFile(
    path.join(outDir, '_raw-stock-items-sample.json'),
    JSON.stringify(stockItems.slice(0, 20), null, 2),
  );
  await fs.writeFile(
    path.join(outDir, '_raw-vouchers-sample.json'),
    JSON.stringify(allVouchers.slice(0, 10), null, 2),
  );
  console.log(`Raw samples written for manual spot-check in ${outDir}`);

  console.log(`\nDone. Output directory: ${outDir}`);
}

main().catch((err) => {
  console.error('\nLIVE AUDIT FAILED:', err);
  process.exitCode = 1;
});
