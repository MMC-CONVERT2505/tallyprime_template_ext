import { BadRequestException } from '@nestjs/common';
import { ExtractionStatus, ExtractionType } from '@prisma/client';
import { TallyFullSyncService } from './full-sync.service';
import { MasterExtractionService } from './master-extraction.service';
import { TransactionExtractionService } from './transaction-extraction.service';

describe('TallyFullSyncService', () => {
  function makeMasters(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return {
      getCompanies: jest.fn().mockResolvedValue([{ name: 'ABC Ltd', startingFrom: '20240401' }]),
      getGroups: jest.fn().mockResolvedValue([{ name: 'G1' }]),
      getLedgers: jest.fn().mockResolvedValue([{ name: 'L1' }]),
      getStockItems: jest.fn().mockResolvedValue([{ name: 'SI1' }]),
      getStockGroups: jest.fn().mockResolvedValue([{ name: 'SG1' }]),
      getStockCategories: jest.fn().mockResolvedValue([{ name: 'SC1' }]),
      getUnits: jest.fn().mockResolvedValue([{ name: 'U1' }]),
      getCurrencies: jest.fn().mockResolvedValue([{ name: 'C1' }]),
      getGodowns: jest.fn().mockResolvedValue([{ name: 'GD1' }]),
      getCostCentres: jest.fn().mockResolvedValue([{ name: 'CC1' }]),
      getCostCategories: jest.fn().mockResolvedValue([{ name: 'CCat1' }]),
      getVoucherTypes: jest.fn().mockResolvedValue([{ name: 'Sales' }]),
      ...overrides,
    } as unknown as MasterExtractionService;
  }

  function makeTransactions(vouchers: unknown[] = []) {
    return {
      getVouchers: jest.fn().mockResolvedValue(vouchers),
    } as unknown as TransactionExtractionService;
  }

  function makeConfig(
    overrides: { defaultCompany?: string; chunkDelayMs?: number; fullSyncTtlSeconds?: number } = {},
  ) {
    return {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'tally') {
          return {
            defaultCompany: overrides.defaultCompany ?? '',
            chunkDelayMs: overrides.chunkDelayMs ?? 0,
          };
        }
        if (key === 'extraction') {
          return { fullSyncTtlSeconds: overrides.fullSyncTtlSeconds ?? 604_800 };
        }
        throw new Error(`unexpected config key "${key}"`);
      }),
    } as any;
  }

  function makeRedis() {
    return {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      scan: jest.fn().mockResolvedValue(['0', []]),
      del: jest.fn().mockResolvedValue(0),
      eval: jest.fn().mockResolvedValue(1),
    } as any;
  }

  /** A real-enough in-memory Redis fake — needed for the lock/status tests
   *  below, which exercise actual SET-NX/EVAL-compare-delete semantics
   *  (acquireLock/releaseLock in lock.util.ts), not just "was .set called". */
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

  /** Lets a fire-and-forget background chain (start()'s `void this.runTracked(...)`)
   *  actually finish before assertions run — everything in that chain is
   *  mocked to resolve immediately (no real timers, chunkDelayMs=0), so a
   *  couple of macrotask flushes are enough. */
  async function flushAsync(times = 5): Promise<void> {
    for (let i = 0; i < times; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  function makePrisma() {
    return {
      extractionJob: {
        create: jest.fn(async (args: any) => ({ id: 'job-1', ...args.data })),
        update: jest.fn().mockResolvedValue({}),
      },
    } as any;
  }

  it('throws BadRequestException when no company is given and no default is configured', async () => {
    const service = new TallyFullSyncService(makeMasters(), makeTransactions(), makeConfig());

    await expect(service.runFullSync()).rejects.toThrow(BadRequestException);
  });

  it('falls back to the configured default company when none is passed', async () => {
    const masters = makeMasters();
    const service = new TallyFullSyncService(
      masters,
      makeTransactions(),
      makeConfig({ defaultCompany: 'Default Co' }),
    );

    const manifest = await service.runFullSync();

    expect(manifest.company).toBe('Default Co');
    expect(masters.getGroups).toHaveBeenCalledWith('Default Co');
  });

  it('fetches every master type plus every voucher, and caches each raw result in Redis under tally:full:{company}:*', async () => {
    const masters = makeMasters();
    const vouchers = [
      { voucherType: 'Sales', voucherNumber: 'S-1' },
      { voucherType: 'Sales', voucherNumber: 'S-2' },
      { voucherType: 'Purchase', voucherNumber: 'P-1' },
    ];
    const transactions = makeTransactions(vouchers);
    const redis = makeRedis();
    const service = new TallyFullSyncService(
      masters,
      transactions,
      makeConfig({ fullSyncTtlSeconds: 999 }),
      undefined,
      redis,
    );

    const manifest = await service.runFullSync('ABC Ltd');

    expect(manifest.entityCounts).toEqual({
      GROUPS: 1,
      LEDGERS: 1,
      STOCK_ITEMS: 1,
      STOCK_GROUPS: 1,
      STOCK_CATEGORIES: 1,
      UNITS: 1,
      CURRENCIES: 1,
      GODOWNS: 1,
      COST_CENTRES: 1,
      COST_CATEGORIES: 1,
      VOUCHER_TYPES: 1,
      VOUCHERS: 3,
    });
    expect(manifest.voucherTypeBreakdown).toEqual({ Sales: 2, Purchase: 1 });
    expect(manifest.dateRange).toEqual({ from: '20240401', to: expect.any(String) });

    expect(redis.set).toHaveBeenCalledWith(
      'tally:full:ABC Ltd:GROUPS',
      JSON.stringify([{ name: 'G1' }]),
      'EX',
      999,
    );
    expect(redis.set).toHaveBeenCalledWith(
      'tally:full:ABC Ltd:VOUCHERS:ALL',
      JSON.stringify(vouchers),
      'EX',
      999,
    );
    expect(redis.set).toHaveBeenCalledWith(
      'tally:full:ABC Ltd:VOUCHERS:Sales',
      JSON.stringify([vouchers[0], vouchers[1]]),
      'EX',
      999,
    );
    expect(redis.set).toHaveBeenCalledWith(
      'tally:full:ABC Ltd:VOUCHERS:Purchase',
      JSON.stringify([vouchers[2]]),
      'EX',
      999,
    );
    expect(redis.set).toHaveBeenCalledWith(
      'tally:full:ABC Ltd:MANIFEST',
      JSON.stringify(manifest),
      'EX',
      999,
    );
  });

  it('respects an explicit fromDate/toDate over the company record default', async () => {
    const service = new TallyFullSyncService(makeMasters(), makeTransactions(), makeConfig());

    const manifest = await service.runFullSync('ABC Ltd', '20250101', '20250630');

    expect(manifest.dateRange).toEqual({ from: '20250101', to: '20250630' });
  });

  it('does not throw when Redis is unavailable — caching is best-effort', async () => {
    const service = new TallyFullSyncService(makeMasters(), makeTransactions(), makeConfig());

    await expect(service.runFullSync('ABC Ltd')).resolves.toBeDefined();
  });

  it('creates and finalizes an audited FULL_SYNC job as SUCCESS when Prisma is wired up', async () => {
    const prisma = makePrisma();
    const service = new TallyFullSyncService(makeMasters(), makeTransactions(), makeConfig(), prisma);

    await service.runFullSync('ABC Ltd');

    expect(prisma.extractionJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: ExtractionType.FULL_SYNC, company: 'ABC Ltd' }),
      }),
    );
    expect(prisma.extractionJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1' },
        data: expect.objectContaining({ status: ExtractionStatus.SUCCESS }),
      }),
    );
  });

  it('marks the job FAILED and rethrows when a master fetch throws', async () => {
    const prisma = makePrisma();
    const masters = makeMasters({
      getLedgers: jest.fn().mockRejectedValue(new Error('Tally timed out')),
    });
    const service = new TallyFullSyncService(masters, makeTransactions(), makeConfig(), prisma);

    await expect(service.runFullSync('ABC Ltd')).rejects.toThrow('Tally timed out');

    expect(prisma.extractionJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ExtractionStatus.FAILED, error: 'Tally timed out' }),
      }),
    );
  });

  describe('start / status / lock (2026-09-19 Full Sync Explorer)', () => {
    it('throws when Redis is not configured — this feature cannot run without it', async () => {
      const service = new TallyFullSyncService(makeMasters(), makeTransactions(), makeConfig());
      await expect(service.start('ABC Ltd')).rejects.toThrow(BadRequestException);
    });

    it('returns RUNNING immediately, then the background run reaches SUCCESS with a manifest', async () => {
      const redis = makeFakeRedis();
      const service = new TallyFullSyncService(
        makeMasters(),
        makeTransactions([{ voucherType: 'Sales', voucherNumber: 'S-1' }]),
        makeConfig(),
        undefined,
        redis,
      );

      const result = await service.start('ABC Ltd');
      expect(result).toEqual({ status: 'RUNNING' });
      expect((await service.getStatus('ABC Ltd')).status).toBe('RUNNING');

      await flushAsync();

      const status = await service.getStatus('ABC Ltd');
      expect(status.status).toBe('SUCCESS');
      expect(status.manifest?.entityCounts.LEDGERS).toBe(1);
      expect(status.manifest?.voucherTypeBreakdown).toEqual({ Sales: 1 });
    });

    it('rejects a second start() for the same company while one is already RUNNING', async () => {
      const redis = makeFakeRedis();
      // Never resolves — simulates a run still genuinely in progress.
      const masters = makeMasters({ getGroups: jest.fn(() => new Promise(() => {})) });
      const service = new TallyFullSyncService(
        masters,
        makeTransactions(),
        makeConfig(),
        undefined,
        redis,
      );

      await service.start('ABC Ltd');
      await expect(service.start('ABC Ltd')).rejects.toThrow(/already running/);
    });

    it('releases the lock on failure too, so a fresh start() succeeds after a FAILED run', async () => {
      const redis = makeFakeRedis();
      const masters = makeMasters({
        getGroups: jest.fn().mockRejectedValue(new Error('boom')),
      });
      const service = new TallyFullSyncService(
        masters,
        makeTransactions(),
        makeConfig(),
        undefined,
        redis,
      );

      await service.start('ABC Ltd');
      await flushAsync();
      expect((await service.getStatus('ABC Ltd')).status).toBe('FAILED');

      // Lock was released — a second start() is accepted, not rejected.
      await expect(service.start('ABC Ltd')).resolves.toEqual({ status: 'RUNNING' });
    });

    it('getStatus reports NOT_STARTED when nothing has ever run for this company', async () => {
      const service = new TallyFullSyncService(
        makeMasters(),
        makeTransactions(),
        makeConfig(),
        undefined,
        makeFakeRedis(),
      );
      expect(await service.getStatus('Never Ran Ltd')).toEqual({ status: 'NOT_STARTED' });
    });
  });

  describe('listKnownEntityTypes / getEntitySnapshot (2026-09-19 Full Sync Explorer)', () => {
    it('returns null before any full sync has completed', async () => {
      const service = new TallyFullSyncService(
        makeMasters(),
        makeTransactions(),
        makeConfig(),
        undefined,
        makeFakeRedis(),
      );
      expect(await service.listKnownEntityTypes('ABC Ltd')).toBeNull();
    });

    it('lists every master, COMPANY, VOUCHERS:ALL, and each real voucher type after a successful run', async () => {
      const redis = makeFakeRedis();
      const service = new TallyFullSyncService(
        makeMasters(),
        makeTransactions([
          { voucherType: 'Sales', voucherNumber: 'S-1' },
          { voucherType: 'Purchase', voucherNumber: 'P-1' },
        ]),
        makeConfig(),
        undefined,
        redis,
      );
      await service.runFullSync('ABC Ltd');

      const known = await service.listKnownEntityTypes('ABC Ltd');
      expect(known).toEqual(
        expect.arrayContaining([
          'GROUPS',
          'LEDGERS',
          'STOCK_ITEMS',
          'COMPANY',
          'VOUCHERS:ALL',
          'VOUCHERS:Sales',
          'VOUCHERS:Purchase',
        ]),
      );
      expect(known).not.toContain('VOUCHERS');

      expect(await service.getEntitySnapshot('ABC Ltd', 'LEDGERS')).toEqual([{ name: 'L1' }]);
      expect(await service.getEntitySnapshot('ABC Ltd', 'NOPE')).toBeNull();
    });

    it('clears a stale VOUCHERS:<type> key left over from a previous run whose type mix has since changed', async () => {
      const redis = makeFakeRedis();
      const transactions = {
        getVouchers: jest
          .fn()
          .mockResolvedValueOnce([{ voucherType: 'Sales', voucherNumber: 'S-1' }])
          .mockResolvedValueOnce([{ voucherType: 'Purchase', voucherNumber: 'P-1' }]),
      } as unknown as TransactionExtractionService;
      const service = new TallyFullSyncService(
        makeMasters(),
        transactions,
        makeConfig(),
        undefined,
        redis,
      );

      // Run 1: has a "Sales" voucher.
      await service.runFullSync('ABC Ltd');
      expect(await redis.get('tally:full:ABC Ltd:VOUCHERS:Sales')).not.toBeNull();

      // Run 2: only a "Purchase" voucher now — the old Sales key must not survive.
      await service.runFullSync('ABC Ltd');
      expect(await redis.get('tally:full:ABC Ltd:VOUCHERS:Sales')).toBeNull();
      expect(await redis.get('tally:full:ABC Ltd:VOUCHERS:Purchase')).not.toBeNull();
    });
  });

  describe('onApplicationBootstrap orphan sweep (2026-09-19 Full Sync Explorer)', () => {
    it('marks a STATUS stuck RUNNING as FAILED and clears its lock', async () => {
      const redis = makeFakeRedis();
      redis.store.set(
        'tally:full:ABC Ltd:STATUS',
        JSON.stringify({ status: 'RUNNING', startedAt: '2026-01-01T00:00:00.000Z' }),
      );
      redis.store.set('tally:full:lock:ABC Ltd', 'some-token');

      const service = new TallyFullSyncService(
        makeMasters(),
        makeTransactions(),
        makeConfig(),
        undefined,
        redis,
      );
      await service.onApplicationBootstrap();

      const status = await service.getStatus('ABC Ltd');
      expect(status.status).toBe('FAILED');
      expect(status.error).toMatch(/restart/i);
      expect(redis.store.has('tally:full:lock:ABC Ltd')).toBe(false);
    });

    it('leaves a SUCCESS/FAILED status untouched', async () => {
      const redis = makeFakeRedis();
      redis.store.set(
        'tally:full:ABC Ltd:STATUS',
        JSON.stringify({ status: 'SUCCESS', startedAt: 'x', finishedAt: 'y' }),
      );
      const service = new TallyFullSyncService(
        makeMasters(),
        makeTransactions(),
        makeConfig(),
        undefined,
        redis,
      );
      await service.onApplicationBootstrap();
      expect((await service.getStatus('ABC Ltd')).status).toBe('SUCCESS');
    });
  });
});
