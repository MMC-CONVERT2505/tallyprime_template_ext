import * as ExcelJS from 'exceljs';
import { BadRequestException } from '@nestjs/common';
import { ExcelGeneratorService } from '../../excel/excel-generator.service';
import {
  SAMPLE_BILL_VOUCHERS,
  SAMPLE_COST_CENTRES,
  SAMPLE_CREDIT_NOTE_VOUCHERS,
  SAMPLE_GROUPS,
  SAMPLE_INVOICE_VOUCHERS,
  SAMPLE_LEDGERS,
  SAMPLE_STOCK_ITEMS,
  SAMPLE_STOCK_JOURNAL_VOUCHERS,
} from '../../mapping/sample-company.fixture';
import { TallyFullSyncExportService } from './full-sync-export.service';
import { TallyFullSyncMappingService } from './full-sync-mapping.service';
import { TallyFullSyncService } from './full-sync.service';
import { MasterExtractionService } from './master-extraction.service';
import { TransactionExtractionService } from './transaction-extraction.service';

const COMPANY = 'ABC Ltd';

function makeFakeRedis() {
  const store = new Map<string, string>();
  const globToRegExp = (pattern: string): RegExp =>
    new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

  return {
    store,
    set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    del: jest.fn(async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) if (store.delete(key)) count++;
      return count;
    }),
    eval: jest.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
    scan: jest.fn(async (_cursor: string, _match: string, pattern: string) => {
      const regex = globToRegExp(pattern);
      return ['0', [...store.keys()].filter((k) => regex.test(k))];
    }),
  } as any;
}

function makeConfig() {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'tally') return { defaultCompany: '', chunkDelayMs: 0 };
      if (key === 'extraction') return { fullSyncTtlSeconds: 604_800 };
      throw new Error(`unexpected config key "${key}"`);
    }),
  } as any;
}

function makeFullSync(redis: any) {
  return new TallyFullSyncService(
    {} as unknown as MasterExtractionService,
    {} as unknown as TransactionExtractionService,
    makeConfig(),
    undefined,
    redis,
  );
}

const MANIFEST = {
  company: COMPANY,
  extractedAt: new Date().toISOString(),
  dateRange: { from: '20200101', to: '20260101' },
  entityCounts: {
    GROUPS: SAMPLE_GROUPS.length,
    LEDGERS: SAMPLE_LEDGERS.length,
    STOCK_ITEMS: SAMPLE_STOCK_ITEMS.length,
    STOCK_GROUPS: 0,
    STOCK_CATEGORIES: 0,
    UNITS: 0,
    CURRENCIES: 0,
    GODOWNS: 0,
    COST_CENTRES: SAMPLE_COST_CENTRES.length,
    COST_CATEGORIES: 0,
    VOUCHER_TYPES: 0,
    VOUCHERS:
      SAMPLE_INVOICE_VOUCHERS.length +
      SAMPLE_BILL_VOUCHERS.length +
      SAMPLE_CREDIT_NOTE_VOUCHERS.length +
      SAMPLE_STOCK_JOURNAL_VOUCHERS.length,
  },
  voucherTypeBreakdown: {
    Sales: SAMPLE_INVOICE_VOUCHERS.length,
    Purchase: SAMPLE_BILL_VOUCHERS.length,
    'Credit Note': SAMPLE_CREDIT_NOTE_VOUCHERS.length,
    'Stock Journal': SAMPLE_STOCK_JOURNAL_VOUCHERS.length,
  },
  ttlSeconds: 604_800,
};

function seed(redis: any, overrides: Record<string, unknown | undefined> = {}) {
  const defaults: Record<string, unknown> = {
    MANIFEST,
    GROUPS: SAMPLE_GROUPS,
    LEDGERS: SAMPLE_LEDGERS,
    STOCK_ITEMS: SAMPLE_STOCK_ITEMS,
    COST_CENTRES: SAMPLE_COST_CENTRES,
    'VOUCHERS:Sales': SAMPLE_INVOICE_VOUCHERS,
    'VOUCHERS:Purchase': SAMPLE_BILL_VOUCHERS,
    'VOUCHERS:Credit Note': SAMPLE_CREDIT_NOTE_VOUCHERS,
    'VOUCHERS:Stock Journal': SAMPLE_STOCK_JOURNAL_VOUCHERS,
    ...overrides,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (value === undefined) continue;
    redis.store.set(`tally:full:${COMPANY}:${key}`, JSON.stringify(value));
  }
}

function makeServices(redis: any) {
  const fullSync = makeFullSync(redis);
  const excel = new ExcelGeneratorService();
  const mapping = new TallyFullSyncMappingService(fullSync, excel, redis);
  const exportService = new TallyFullSyncExportService(fullSync, mapping, excel, redis);
  return { fullSync, mapping, exportService };
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

describe('TallyFullSyncExportService', () => {
  it('builds one RAW sheet per known entity (masters + real voucher types, not VOUCHERS:ALL/COMPANY) plus 9 ZOHO sheets', async () => {
    const redis = makeFakeRedis();
    seed(redis);
    const { exportService } = makeServices(redis);

    const buffer = await exportService.buildWorkbook(COMPANY);
    const workbook = await loadWorkbook(buffer);
    const names = workbook.worksheets.map((s) => s.name);

    // 11 masters + 4 real voucher types = 15 RAW sheets, + 9 ZOHO sheets.
    expect(names.filter((n) => n.startsWith('RAW '))).toHaveLength(15);
    expect(names.filter((n) => n.startsWith('ZOHO '))).toHaveLength(9);
    expect(names).not.toContain('RAW COMPANY');
    expect(names).not.toContain('RAW VOUCHERS ALL');

    // A master with zero cached rows (never populated in this seed) still
    // gets a sheet, with a clear "(no records)" marker instead of a blank
    // header row.
    const stockGroupsSheet = workbook.getWorksheet('RAW STOCK_GROUPS')!;
    expect(stockGroupsSheet.getRow(1).getCell(1).value).toBe('(no records)');
    expect(stockGroupsSheet.rowCount).toBe(1);

    // A populated RAW sheet has real dynamic columns from the cached rows.
    const groupsSheet = workbook.getWorksheet('RAW GROUPS')!;
    expect(groupsSheet.rowCount).toBe(SAMPLE_GROUPS.length + 1);

    // A ZOHO sheet uses the real template's full header set.
    const customerSheet = workbook.getWorksheet('ZOHO CUSTOMER')!;
    const headers: string[] = [];
    customerSheet.getRow(1).eachCell({ includeEmpty: false }, (c) => headers.push(String(c.value)));
    expect(headers).toContain('Website');
    expect(customerSheet.rowCount).toBe(3); // header + 2 customers
  });

  it('reuses an already-cached Zoho mapping instead of recomputing it', async () => {
    const redis = makeFakeRedis();
    seed(redis);
    const { mapping, exportService } = makeServices(redis);
    await mapping.mapAll(COMPANY);

    // Overwrite the cached COA mapping with a distinctive marker row that
    // the real mapper would never produce — proves buildWorkbook read the
    // CACHE rather than recomputing from the raw ledgers.
    const marker = { headers: ['Account Name'], rows: [{ 'Account Name': 'MARKER-FROM-CACHE' }] };
    redis.store.set(`tally:full:${COMPANY}:MAPPED:COA`, JSON.stringify(marker));

    const buffer = await exportService.buildWorkbook(COMPANY);
    const workbook = await loadWorkbook(buffer);
    const coaSheet = workbook.getWorksheet('ZOHO COA')!;
    expect(coaSheet.getRow(2).getCell(1).value).toBe('MARKER-FROM-CACHE');
  });

  it('throws when full sync has never run for this company', async () => {
    const redis = makeFakeRedis();
    const { exportService } = makeServices(redis);
    await expect(exportService.buildWorkbook(COMPANY)).rejects.toThrow(BadRequestException);
  });

  it('rejects while a full sync is currently running for the same company (shared lock)', async () => {
    const redis = makeFakeRedis();
    seed(redis);
    redis.store.set(`tally:full:lock:${COMPANY}`, 'held-by-the-running-sync');
    const { exportService } = makeServices(redis);

    await expect(exportService.buildWorkbook(COMPANY)).rejects.toThrow(/currently running/);
  });

  it('throws when Redis is not configured', async () => {
    const fullSync = makeFullSync(undefined);
    const excel = new ExcelGeneratorService();
    const mapping = new TallyFullSyncMappingService(fullSync, excel, undefined);
    const exportService = new TallyFullSyncExportService(fullSync, mapping, excel, undefined);
    await expect(exportService.buildWorkbook(COMPANY)).rejects.toThrow(BadRequestException);
  });
});
