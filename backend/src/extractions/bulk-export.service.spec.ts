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

  async lrem(key: string, _count: number, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    const next = list.filter((v) => v !== value);
    this.lists.set(key, next);
    return list.length - next.length;
  }

  /** Reproduces lock.util.ts's fixed compare-and-delete release script —
   *  no real Lua interpreter needed since the script itself never changes. */
  async eval(_script: string, _numKeys: number, key: string, token: string): Promise<number> {
    if (this.store.get(key) === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
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
  let reuse: { isResultCached: jest.Mock };
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
      // Same flat object regardless of which section is requested — good
      // enough for these tests, and lets a single mock cover both
      // BulkExportConfig (exportsDir/stepTimeoutMs/...) and the TallyConfig
      // fields vouchersStepPollBudgetMs now also reads (timeoutMs/
      // maxRetries/chunkDelayMs/voucherChunkDays). The computed VOUCHERS
      // budget ends up much larger than stepTimeoutMs here, but that's
      // harmless for test speed: awaitJob only ever sleeps pollIntervalMs
      // between polls and returns on the first non-PENDING status, which
      // every test's getStatus mock provides immediately.
      getOrThrow: jest.fn().mockReturnValue({
        exportsDir,
        stepTimeoutMs: 2000,
        pollIntervalMs: 5,
        recordTtlSeconds: 3600,
        retentionHours: 168,
        timeoutMs: 60000,
        maxRetries: 2,
        chunkDelayMs: 2000,
        voucherChunkDays: 7,
      }),
    };

    reuse = { isResultCached: jest.fn().mockResolvedValue(true) };

    service = new BulkExportService(
      extractions as any,
      new ZipService(),
      config as any,
      redis as any,
      reuse as any,
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

  it(
    'fetches every master (GROUPS/LEDGERS/STOCK_ITEMS/COST_CENTRES) UNSCOPED — never forwards the ' +
      "run's fromDate/toDate onto them — while every VOUCHERS step DOES get that date range",
    async () => {
      // Regression test for a live incident (2026-08-22): dispatchStep used
      // to forward fromDate/toDate onto every master fetch unconditionally,
      // which forced STOCK_ITEMS onto Tally's fragile period-scoped batching
      // path (masterBatchSize=300 -> periodBatchSize=4) purely as a side
      // effect of also fetching vouchers for that date range — and wedged a
      // real Tally instance solid. Masters must always take the unscoped,
      // single-request path; only vouchers have a genuine reason to be
      // date-scoped.
      const { id } = await service.start(
        'org-1',
        'user@example.com',
        'ABC Ltd',
        '20260401',
        '20260430',
      );
      await settle('org-1', id);

      for (const call of extractions.fetchMaster.mock.calls) {
        const dto = call[2];
        expect(dto).not.toHaveProperty('fromDate');
        expect(dto).not.toHaveProperty('toDate');
      }
      expect(extractions.fetchMaster).toHaveBeenCalledTimes(4); // GROUPS, LEDGERS, STOCK_ITEMS, COST_CENTRES

      for (const call of extractions.create.mock.calls) {
        expect(call[2].payload).toMatchObject({ from: '20260401', to: '20260430' });
      }
      expect(extractions.create).toHaveBeenCalledTimes(4); // the 4 VOUCHERS steps
    },
  );

  it('continues fetching every OTHER step when one fails — failure isolation, no early abort', async () => {
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
    // Every OTHER step still got a real attempt — the old fail-fast
    // behavior would have left all of these stuck at PENDING.
    expect(record.steps.find((s) => s.key === 'STOCK_ITEMS')?.status).toBe('SUCCESS');
    expect(record.steps.find((s) => s.key === 'COST_CENTRES')?.status).toBe('SUCCESS');
    expect(record.steps.find((s) => s.key === 'VOUCHERS_SALES')?.status).toBe('SUCCESS');
    expect(record.steps.find((s) => s.key === 'VOUCHERS_PURCHASE')?.status).toBe('SUCCESS');
    expect(record.steps.find((s) => s.key === 'VOUCHERS_CREDIT_NOTE')?.status).toBe('SUCCESS');
    expect(record.steps.find((s) => s.key === 'VOUCHERS_STOCK_JOURNAL')?.status).toBe('SUCCESS');
    // GENERATE_EXCEL/ZIP never ran — one fetch step is still broken.
    expect(record.steps.find((s) => s.key === 'GENERATE_EXCEL')?.status).toBe('PENDING');
    expect(record.steps.find((s) => s.key === 'ZIP')?.status).toBe('PENDING');
    expect(extractions.getExcelResult).not.toHaveBeenCalled();
  });

  // Shared by both `retry` and `remove` tests below.
  async function startWithLedgersFailing() {
    extractions.getStatus.mockImplementation(async (_orgId: string, jobId: string) => {
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
    await settle('org-1', id);
    extractions.fetchMaster.mockClear();
    extractions.create.mockClear();
    return id;
  }

  describe('retry', () => {
    it('re-dispatches only the failed step, reuses every already-successful jobId, and completes generate+zip', async () => {
      const id = await startWithLedgersFailing();
      extractions.getStatus.mockImplementation(async (_orgId: string, jobId: string) => ({
        id: jobId,
        status: 'SUCCESS',
        recordCount: 1,
      }));

      const retryResult = await service.retry('org-1', 'user@example.com', id);
      expect(retryResult.status).toBe('PENDING');

      const record = await settle('org-1', id);

      expect(record.status).toBe('SUCCESS');
      expect(record.steps.every((s) => s.status === 'SUCCESS')).toBe(true);
      // Only LEDGERS was re-dispatched — the 3 other masters and 4 vouchers
      // steps that already succeeded were never re-fetched.
      expect(extractions.fetchMaster).toHaveBeenCalledTimes(1);
      expect(extractions.create).not.toHaveBeenCalled();
      expect(extractions.getExcelResult).toHaveBeenCalledTimes(9);
    });

    it('folds a stale (Redis-expired) SUCCESS step back into the retry set even though its own status still says SUCCESS', async () => {
      const id = await startWithLedgersFailing();
      // job-1 (GROUPS) succeeded originally, but its cached result has since
      // expired — result TTL is shorter than the bulk-export record's own.
      reuse.isResultCached.mockImplementation(async (jobId: string) => jobId !== 'job-1');
      extractions.getStatus.mockImplementation(async (_orgId: string, jobId: string) => ({
        id: jobId,
        status: 'SUCCESS',
        recordCount: 1,
      }));

      await service.retry('org-1', 'user@example.com', id);
      const record = await settle('org-1', id);

      expect(record.status).toBe('SUCCESS');
      // Both the originally-FAILED step (LEDGERS) and the stale-cache step
      // (GROUPS) were re-dispatched.
      expect(extractions.fetchMaster).toHaveBeenCalledTimes(2);
    });

    it('retries only GENERATE_EXCEL/ZIP (no new Tally dispatch) when every fetch step already succeeded', async () => {
      const { id } = await service.start(
        'org-1',
        'user@example.com',
        'ABC Ltd',
        '20260401',
        '20260430',
      );
      // Make the Excel-generation phase fail on the very first run.
      extractions.getExcelResult.mockRejectedValueOnce(new Error('template write failed'));
      const failed = await settle('org-1', id);
      expect(failed.status).toBe('FAILED');
      expect(failed.steps.find((s) => s.key === 'GENERATE_EXCEL')?.status).toBe('FAILED');
      extractions.fetchMaster.mockClear();
      extractions.create.mockClear();
      extractions.getExcelResult.mockClear();
      extractions.getExcelResult.mockImplementation(async (_orgId: string, jobId: string) => ({
        buffer: Buffer.from(`fake-${jobId}`),
        filename: `${jobId}.xlsx`,
      }));

      await service.retry('org-1', 'user@example.com', id);
      const record = await settle('org-1', id);

      expect(record.status).toBe('SUCCESS');
      expect(extractions.fetchMaster).not.toHaveBeenCalled();
      expect(extractions.create).not.toHaveBeenCalled();
      expect(extractions.getExcelResult).toHaveBeenCalledTimes(9);
    });

    it('an explicit steps list is intersected with the real retryable set, never trusted blindly', async () => {
      const id = await startWithLedgersFailing();
      extractions.getStatus.mockImplementation(async (_orgId: string, jobId: string) => ({
        id: jobId,
        status: 'SUCCESS',
        recordCount: 1,
      }));

      // Caller asks to retry a step that's actually already fine (GROUPS)
      // AND omits the one that's actually still broken (LEDGERS).
      await service.retry('org-1', 'user@example.com', id, ['GROUPS']);
      const record = await settle('org-1', id);

      // LEDGERS is still broken (never actually retried) — the run stays
      // FAILED rather than silently reporting success.
      expect(record.status).toBe('FAILED');
      expect(record.steps.find((s) => s.key === 'LEDGERS')?.status).toBe('FAILED');
      expect(extractions.fetchMaster).not.toHaveBeenCalled();
    });

    it('rejects retrying a bulk export that is not currently FAILED', async () => {
      const { id } = await service.start(
        'org-1',
        'user@example.com',
        'ABC Ltd',
        '20260401',
        '20260430',
      );
      await settle('org-1', id); // succeeds — nothing to retry

      await expect(service.retry('org-1', 'user@example.com', id)).rejects.toThrow(
        'nothing to retry',
      );
    });

    it("404s when a different org tries to retry another org's bulk export", async () => {
      const id = await startWithLedgersFailing();
      await expect(service.retry('org-2', 'user@example.com', id)).rejects.toThrow(
        'Bulk export not found',
      );
    });
  });

  describe('remove', () => {
    it('deletes the record, its index entry, and the zip file for a SUCCESS export', async () => {
      const { id } = await service.start(
        'org-1',
        'user@example.com',
        'ABC Ltd',
        '20260401',
        '20260430',
      );
      await settle('org-1', id);
      const { filePath } = await service.getDownload('org-1', id);
      await expect(fs.stat(filePath)).resolves.toBeTruthy();

      await service.remove('org-1', id);

      await expect(service.getStatus('org-1', id)).rejects.toThrow('Bulk export not found');
      await expect(service.list('org-1')).resolves.not.toContainEqual(
        expect.objectContaining({ id }),
      );
      await expect(fs.stat(filePath)).rejects.toThrow();
    });

    it('deletes a FAILED export (no zip file to worry about)', async () => {
      const id = await startWithLedgersFailing();

      await expect(service.remove('org-1', id)).resolves.toBeUndefined();
      await expect(service.getStatus('org-1', id)).rejects.toThrow('Bulk export not found');
    });

    it('refuses to delete a still-RUNNING export', async () => {
      // job-1 (GROUPS — first dispatched) stays PENDING; awaitJob polls it
      // for the static master-step budget (fast, self-terminating) before
      // timing out and moving on — plenty of a window to observe the record
      // as RUNNING and attempt the delete. Deliberately NOT stuck on a
      // VOUCHERS step: those get the new dynamic date-range-based budget
      // (see estimateVouchersTimeoutMs), which at this test's TallyConfig
      // values is far larger than this test config's fast stepTimeoutMs and
      // would leave a real multi-minute timer running in the background.
      extractions.getStatus.mockImplementation(async (_orgId: string, jobId: string) => {
        if (jobId === 'job-1') return { id: jobId, status: 'PENDING' };
        return { id: jobId, status: 'SUCCESS', recordCount: 1 };
      });
      const { id } = await service.start(
        'org-1',
        'user@example.com',
        'ABC Ltd',
        '20260401',
        '20260430',
      );
      await waitFor(async () => (await service.getStatus('org-1', id)).status === 'RUNNING');

      await expect(service.remove('org-1', id)).rejects.toThrow('still running');

      // Drain the still-in-flight background run before the test returns —
      // otherwise it keeps polling/settling after this `it()` block exits.
      await settle('org-1', id);
    });

    it("404s when a different org tries to delete another org's bulk export", async () => {
      const { id } = await service.start(
        'org-1',
        'user@example.com',
        'ABC Ltd',
        '20260401',
        '20260430',
      );
      await settle('org-1', id);

      await expect(service.remove('org-2', id)).rejects.toThrow('Bulk export not found');
    });

    it('404s for an id that never existed', async () => {
      await expect(service.remove('org-1', 'no-such-id')).rejects.toThrow('Bulk export not found');
    });
  });

  it('rejects a second concurrent bulk export for the same org+company', async () => {
    const first = await service.start(
      'org-1',
      'user@example.com',
      'ABC Ltd',
      '20260401',
      '20260430',
    );

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
    const { id } = await service.start(
      'org-1',
      'user@example.com',
      'ABC Ltd',
      '20260401',
      '20260430',
    );
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
    const { id } = await service.start(
      'org-1',
      'user@example.com',
      'ABC Ltd',
      '20260401',
      '20260430',
    );
    await expect(service.getStatus('org-2', id)).rejects.toThrow('Bulk export not found');
    await settle('org-1', id);
  });
});
