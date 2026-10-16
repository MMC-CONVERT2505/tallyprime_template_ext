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
import { TallyFullSyncMappingService } from './full-sync-mapping.service';
import { TallyFullSyncService } from './full-sync.service';
import { MasterExtractionService } from './master-extraction.service';
import { TransactionExtractionService } from './transaction-extraction.service';

const COMPANY = 'ABC Ltd';

/** Same in-memory Redis fake as full-sync.service.spec.ts — real SET-NX/EVAL
 *  semantics matter here too (withLock, in mapAll). */
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

/** Seeds the exact raw snapshot keys TallyFullSyncService itself would have
 *  written, reusing the SAME fixtures full-export-pipeline.spec.ts uses
 *  against the real mappers/templates — so row counts here can be
 *  cross-checked against that already-verified suite. */
function seed(redis: any, overrides: Record<string, unknown | undefined> = {}) {
  const defaults: Record<string, unknown> = {
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

describe('TallyFullSyncMappingService', () => {
  it('maps every one of the 9 Zoho entities via the real mappers/templates', async () => {
    const redis = makeFakeRedis();
    seed(redis);
    const mapping = new TallyFullSyncMappingService(
      makeFullSync(redis),
      new ExcelGeneratorService(),
      redis,
    );

    const result = await mapping.mapAll(COMPANY);

    // Row counts match full-export-pipeline.spec.ts's already-verified
    // output for this exact fixture set (sheet.rowCount - 1 for the header).
    expect(result.COA.rows).toHaveLength(2);
    expect(result.CUSTOMER.rows).toHaveLength(2);
    expect(result.VENDOR.rows).toHaveLength(1);
    expect(result.ITEM.rows).toHaveLength(3);
    expect(result.COST_CENTRE.rows).toHaveLength(3);
    expect(result.INVOICE.rows).toHaveLength(4);
    expect(result.BILL.rows).toHaveLength(1);
    expect(result.CREDIT_NOTE.rows).toHaveLength(1);
    expect(result.STOCK_JOURNAL.rows).toHaveLength(2);

    // Every entity is paired with its REAL template's full header list, not
    // just the keys a mapped row happens to set — a column nothing
    // populates (e.g. Customer's "Website") still appears here.
    expect(result.CUSTOMER.headers).toContain('Website');
    expect(result.CUSTOMER.headers).toContain('GST Treatment');

    // Cached under MAPPED:<key> for a later read.
    expect(await mapping.getMapped(COMPANY, 'COA')).toEqual(result.COA);
  });

  it('treats a voucher type with no cached snapshot as zero rows, not an error', async () => {
    const redis = makeFakeRedis();
    seed(redis, { 'VOUCHERS:Purchase': undefined }); // this company had zero Purchase vouchers
    const mapping = new TallyFullSyncMappingService(
      makeFullSync(redis),
      new ExcelGeneratorService(),
      redis,
    );

    const result = await mapping.mapAll(COMPANY);
    expect(result.BILL.rows).toEqual([]);
  });

  it('rejects with a clear "run full sync first" error when a master snapshot is missing entirely', async () => {
    const redis = makeFakeRedis(); // nothing seeded
    const mapping = new TallyFullSyncMappingService(
      makeFullSync(redis),
      new ExcelGeneratorService(),
      redis,
    );

    await expect(mapping.mapAll(COMPANY)).rejects.toThrow(BadRequestException);
    await expect(mapping.mapAll(COMPANY)).rejects.toThrow(/full sync first/);
  });

  it('rejects while a full sync is currently running for the same company (shared lock)', async () => {
    const redis = makeFakeRedis();
    seed(redis);
    redis.store.set(`tally:full:lock:${COMPANY}`, 'held-by-the-running-sync');
    const mapping = new TallyFullSyncMappingService(
      makeFullSync(redis),
      new ExcelGeneratorService(),
      redis,
    );

    await expect(mapping.mapAll(COMPANY)).rejects.toThrow(/currently running/);
  });

  it('throws when Redis is not configured', async () => {
    const mapping = new TallyFullSyncMappingService(
      makeFullSync(undefined),
      new ExcelGeneratorService(),
      undefined,
    );
    await expect(mapping.mapAll(COMPANY)).rejects.toThrow(BadRequestException);
  });

  it('getMapped returns null before mapAll has ever run', async () => {
    const redis = makeFakeRedis();
    const mapping = new TallyFullSyncMappingService(
      makeFullSync(redis),
      new ExcelGeneratorService(),
      redis,
    );
    expect(await mapping.getMapped(COMPANY, 'COA')).toBeNull();
  });
});
