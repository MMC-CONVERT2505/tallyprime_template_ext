import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BulkExportService, PublicBulkExportRecord } from './bulk-export.service';
import { ZipService } from '../excel/zip.service';

/** Minimal in-memory stand-in for the ioredis client — only the handful of
 *  commands BulkExportService actually calls (set w/ NX, get, del, list ops). */
class FakeRedis {
  private readonly store = new Map<string, string>();
  private readonly lists = new Map<string, string[]>();

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async lpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list.slice(start, stop + 1));
    return 'OK';
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    return list.slice(start, stop === -1 ? undefined : stop + 1);
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 4000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const ALL_STEP_KEYS = [
  'GROUPS',
  'LEDGERS',
  'STOCK_ITEMS',
  'COST_CENTRES',
  'VOUCHERS_SALES',
  'VOUCHERS_PURCHASE',
  'VOUCHERS_CREDIT_NOTE',
  'VOUCHERS_STOCK_JOURNAL',
  'GENERATE_EXCEL',
  'ZIP',
];

describe('BulkExportService', () => {
  let exportsDir: string;
  let redis: FakeRedis;
  let extractions: {
    resolveConnectionId: jest.Mock;
    fetchMaster: jest.Mock;
    create: jest.Mock;
    getStatus: jest.Mock;
    getExcelResult: jest.Mock;
  };
  let config: { getOrThrow: jest.Mock };
  let service: BulkExportService;
  let jobCounter: number;

  const settle = async (orgId: string, id: string): Promise<PublicBulkExportRecord> => {
    await waitFor(async () => {
      const record = await service.getStatus(orgId, id);
      return record.status === 'SUCCESS' || record.status === 'FAILED';
    });
    return service.getStatus(orgId, id);
  };

  beforeEach(async () => {
    exportsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bulk-export-test-'));
    redis = new FakeRedis();
    jobCounter = 0;

    extractions = {
      resolveConnectionId: jest.fn().mockResolvedValue('conn-1'),
      fetchMaster: jest.fn().mockImplementation(async () => ({
        id: `job-${++jobCounter}`,
        status: 'PENDING',
      })),
      create: jest.fn().mockImplementation(async () => ({
        id: `job-${++jobCounter}`,
        status: 'PENDING',
      })),
      getStatus: jest.fn().mockImplementation(async (_orgId: string, jobId: string) => ({
        id: jobId,
        status: 'SUCCESS',
        recordCount: 3,
        error: null,
      })),
      getExcelResult: jest.fn().mockImplementation(async (_orgId: string, jobId: string) => ({
        buffer: Buffer.from(`fake-${jobId}`),
        filename: `${jobId}.xlsx`,
      })),
    };

    config = {
      getOrThrow: jest.fn().mockReturnValue({
        exportsDir,
        stepTimeoutMs: 2000,
        pollIntervalMs: 5,
        recordTtlSeconds: 3600,
        retentionHours: 168,
      }),
    };

    service = new BulkExportService(
      extractions as any,
      new ZipService(),
      config as any,
      redis as any,
    );
  });

  afterEach(async () => {
    await fs.rm(exportsDir, { recursive: true, force: true });
  });

  it('runs all 8 fetch steps in order, then generates and zips all 9 Zoho templates', async () => {
    const { id, status } = await service.start(
      'org-1',
      'user@example.com',
      'ABC Ltd',
      '20260401',
      '20260430',
    );
    expect(status).toBe('PENDING');

    const record = await settle('org-1', id);

    expect(record.status).toBe('SUCCESS');
    expect(record.steps.map((s) => s.key)).toEqual(ALL_STEP_KEYS);
    expect(record.steps.every((s) => s.status === 'SUCCESS')).toBe(true);
    expect(record.filename).toMatch(/^ABC_Ltd-zoho-export-.*\.zip$/);
    expect(record.sizeBytes).toBeGreaterThan(0);

    // One getExcelResult call per Zoho entity: COA/CUSTOMER/VENDOR (from
    // LEDGERS), ITEM, COST_CENTRE, and the 4 VOUCHERS-derived exports.
    expect(extractions.getExcelResult).toHaveBeenCalledTimes(9);

    // Vouchers were fetched with the correct voucherType, in order.
    const voucherTypes = extractions.create.mock.calls.map((call) => call[2].payload.voucherType);
    expect(voucherTypes).toEqual(['Sales', 'Purchase', 'Credit Note', 'Stock Journal']);

    // The zip genuinely landed on disk with the reported size.
    const { filePath, filename } = await service.getDownload('org-1', id);
    expect(filename).toBe(record.filename);
    const stat = await fs.stat(filePath);
    expect(stat.size).toBe(record.sizeBytes);
  });

  it('stops immediately and marks the whole export FAILED when one fetch step fails', async () => {
    extractions.getStatus.mockImplementation(async (_orgId: string, jobId: string) => {
      // job-2 is the second dispatched job (LEDGERS, per FETCH_STEP_KEYS order).
      if (jobId === 'job-2') return { id: jobId, status: 'FAILED', error: 'Tally unreachable' };
      return { id: jobId, status: 'SUCCESS', recordCount: 1 };
    });

    const { id } = await service.start(
      'org-1',
      'user@example.com',
      'ABC Ltd',
      '20260401',
      '20260430',
    );
    const record = await settle('org-1', id);

    expect(record.status).toBe('FAILED');
    expect(record.error).toContain('Tally unreachable');
    expect(record.steps.find((s) => s.key === 'GROUPS')?.status).toBe('SUCCESS');
    expect(record.steps.find((s) => s.key === 'LEDGERS')?.status).toBe('FAILED');
    // Every step after the failure never ran.
    expect(record.steps.find((s) => s.key === 'STOCK_ITEMS')?.status).toBe('PENDING');
    expect(record.steps.find((s) => s.key === 'GENERATE_EXCEL')?.status).toBe('PENDING');
    expect(extractions.getExcelResult).not.toHaveBeenCalled();
  });

  it('rejects a second concurrent bulk export for the same org+company', async () => {
    const first = await service.start('org-1', 'user@example.com', 'ABC Ltd', '20260401', '20260430');

    await expect(
      service.start('org-1', 'user@example.com', 'ABC Ltd', '20260401', '20260430'),
    ).rejects.toThrow(/already running/);

    // A different company is unaffected by the lock.
    await expect(
      service.start('org-1', 'user@example.com', 'XYZ Pvt Ltd', '20260401', '20260430'),
    ).resolves.toMatchObject({ status: 'PENDING' });

    await settle('org-1', first.id);
  });

  it('rejects fromDate after toDate before touching Tally at all', async () => {
    await expect(
      service.start('org-1', 'user@example.com', 'ABC Ltd', '20260430', '20260401'),
    ).rejects.toThrow(/must not be after/);
    expect(extractions.resolveConnectionId).not.toHaveBeenCalled();
  });

  it('never leaks the internal disk path or orgId through getStatus/list', async () => {
    const { id } = await service.start('org-1', 'user@example.com', 'ABC Ltd', '20260401', '20260430');
    const record = (await settle('org-1', id)) as PublicBulkExportRecord & {
      filePath?: string;
      orgId?: string;
    };

    expect(record.filePath).toBeUndefined();
    expect(record.orgId).toBeUndefined();

    const listed = await service.list('org-1');
    expect(listed[0]).not.toHaveProperty('filePath');
    expect(listed[0]).not.toHaveProperty('orgId');
  });

  it("404s when a different org tries to read another org's bulk export", async () => {
    const { id } = await service.start('org-1', 'user@example.com', 'ABC Ltd', '20260401', '20260430');
    await expect(service.getStatus('org-2', id)).rejects.toThrow('Bulk export not found');
    await settle('org-1', id);
  });
});
