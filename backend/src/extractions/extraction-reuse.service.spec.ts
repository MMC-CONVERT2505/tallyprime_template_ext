import { ExtractionReuseService } from './extraction-reuse.service';

describe('ExtractionReuseService', () => {
  function makeDeps(overrides: { findMany?: jest.Mock; exists?: jest.Mock } = {}) {
    const prisma = {
      extractionJob: {
        findMany: overrides.findMany ?? jest.fn().mockResolvedValue([]),
      },
    };
    const redis = { exists: overrides.exists ?? jest.fn().mockResolvedValue(1) };
    const service = new ExtractionReuseService(prisma as any, redis as any);
    return { service, prisma, redis };
  }

  describe('ineligible types', () => {
    it('never reuses COMPANIES — has its own dedicated short-TTL cache', async () => {
      const { service, prisma } = makeDeps();

      const result = await service.findReusable('org-1', 'conn-1', 'COMPANIES' as any, {});

      expect(result).toBeNull();
      expect(prisma.extractionJob.findMany).not.toHaveBeenCalled();
    });

    it('never reuses RAW — opaque payload, no defined equality', async () => {
      const { service, prisma } = makeDeps();

      const result = await service.findReusable('org-1', 'conn-1', 'RAW' as any, {
        company: 'ABC Ltd',
      });

      expect(result).toBeNull();
      expect(prisma.extractionJob.findMany).not.toHaveBeenCalled();
    });
  });

  it('returns null without querying when payload has no company', async () => {
    const { service, prisma } = makeDeps();

    const result = await service.findReusable('org-1', 'conn-1', 'GROUPS' as any, {});

    expect(result).toBeNull();
    expect(prisma.extractionJob.findMany).not.toHaveBeenCalled();
  });

  describe('GROUPS / COST_CENTRES (no date params — company match is enough)', () => {
    it('reuses the most recent SUCCESS job for the same company when its result is still cached', async () => {
      const findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'job-2', params: { company: 'ABC Ltd' } }]);
      const { service, prisma, redis } = makeDeps({ findMany });

      const result = await service.findReusable('org-1', 'conn-1', 'GROUPS' as any, {
        company: 'ABC Ltd',
      });

      expect(result).toEqual({ id: 'job-2', params: { company: 'ABC Ltd' } });
      expect(prisma.extractionJob.findMany).toHaveBeenCalledWith({
        where: {
          orgId: 'org-1',
          connectionId: 'conn-1',
          type: 'GROUPS',
          company: 'ABC Ltd',
          status: 'SUCCESS',
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      expect(redis.exists).toHaveBeenCalledWith('extraction-result:job-2');
    });

    it('returns null when there is no prior successful job for this company', async () => {
      const { service } = makeDeps({ findMany: jest.fn().mockResolvedValue([]) });

      const result = await service.findReusable('org-1', 'conn-1', 'COST_CENTRES' as any, {
        company: 'ABC Ltd',
      });

      expect(result).toBeNull();
    });

    it("does not fall back to an older candidate once the newest match's cached result has expired", async () => {
      const findMany = jest.fn().mockResolvedValue([
        { id: 'newest', params: { company: 'ABC Ltd' } },
        { id: 'older', params: { company: 'ABC Ltd' } },
      ]);
      const exists = jest.fn().mockResolvedValue(0); // expired
      const { service, redis } = makeDeps({ findMany, exists });

      const result = await service.findReusable('org-1', 'conn-1', 'GROUPS' as any, {
        company: 'ABC Ltd',
      });

      expect(result).toBeNull();
      // Only the newest candidate's cache is even checked — an older match
      // is provably also expired (same fixed TTL, earlier createdAt).
      expect(redis.exists).toHaveBeenCalledTimes(1);
      expect(redis.exists).toHaveBeenCalledWith('extraction-result:newest');
    });
  });

  describe('LEDGERS / STOCK_ITEMS (exact date-scope match required, not containment)', () => {
    it('reuses an unscoped (fromDate/toDate both absent) prior fetch for an unscoped request', async () => {
      const findMany = jest.fn().mockResolvedValue([
        { id: 'job-1', params: { company: 'ABC Ltd', fromDate: null, toDate: null } },
      ]);
      const { service } = makeDeps({ findMany });

      const result = await service.findReusable('org-1', 'conn-1', 'LEDGERS' as any, {
        company: 'ABC Ltd',
      });

      expect(result?.id).toBe('job-1');
    });

    it('does NOT reuse an unscoped prior fetch for a period-scoped request (different data, not a superset)', async () => {
      const findMany = jest.fn().mockResolvedValue([
        { id: 'job-1', params: { company: 'ABC Ltd', fromDate: null, toDate: null } },
      ]);
      const { service } = makeDeps({ findMany });

      const result = await service.findReusable('org-1', 'conn-1', 'LEDGERS' as any, {
        company: 'ABC Ltd',
        fromDate: '20260401',
        toDate: '20260430',
      });

      expect(result).toBeNull();
    });

    it('does NOT reuse a WIDER period-scoped fetch for a narrower request within it (exact match only, containment out of scope)', async () => {
      const findMany = jest.fn().mockResolvedValue([
        {
          id: 'wide-job',
          params: { company: 'ABC Ltd', fromDate: '20260101', toDate: '20261231' },
        },
      ]);
      const { service } = makeDeps({ findMany });

      const result = await service.findReusable('org-1', 'conn-1', 'STOCK_ITEMS' as any, {
        company: 'ABC Ltd',
        fromDate: '20260401',
        toDate: '20260430',
      });

      expect(result).toBeNull();
    });

    it('reuses an exact period-scoped match', async () => {
      const findMany = jest.fn().mockResolvedValue([
        {
          id: 'job-1',
          params: { company: 'ABC Ltd', fromDate: '20260401', toDate: '20260430' },
        },
      ]);
      const { service } = makeDeps({ findMany });

      const result = await service.findReusable('org-1', 'conn-1', 'STOCK_ITEMS' as any, {
        company: 'ABC Ltd',
        fromDate: '20260401',
        toDate: '20260430',
      });

      expect(result?.id).toBe('job-1');
    });

    it('skips a same-range candidate whose result already expired but matches an older exact-range candidate', async () => {
      const findMany = jest.fn().mockResolvedValue([
        { id: 'newest-different-range', params: { company: 'ABC Ltd', fromDate: '20260501', toDate: '20260531' } },
        { id: 'older-matching-range', params: { company: 'ABC Ltd', fromDate: '20260401', toDate: '20260430' } },
      ]);
      const { service } = makeDeps({ findMany });

      const result = await service.findReusable('org-1', 'conn-1', 'LEDGERS' as any, {
        company: 'ABC Ltd',
        fromDate: '20260401',
        toDate: '20260430',
      });

      // The newest candidate has a DIFFERENT range so it's skipped by
      // `matches`, not by the cache-expiry short-circuit — scanning
      // continues to the older, actually-matching candidate.
      expect(result?.id).toBe('older-matching-range');
    });
  });

  describe('VOUCHERS (exact voucherType + from + to match required)', () => {
    it('reuses an identical voucherType/from/to fetch', async () => {
      const findMany = jest.fn().mockResolvedValue([
        {
          id: 'job-1',
          params: { company: 'ABC Ltd', voucherType: 'Sales', from: '20260401', to: '20260430' },
        },
      ]);
      const { service } = makeDeps({ findMany });

      const result = await service.findReusable('org-1', 'conn-1', 'VOUCHERS' as any, {
        company: 'ABC Ltd',
        voucherType: 'Sales',
        from: '20260401',
        to: '20260430',
      });

      expect(result?.id).toBe('job-1');
    });

    it('does NOT reuse across different voucherTypes even with an identical date range', async () => {
      const findMany = jest.fn().mockResolvedValue([
        {
          id: 'job-1',
          params: { company: 'ABC Ltd', voucherType: 'Purchase', from: '20260401', to: '20260430' },
        },
      ]);
      const { service } = makeDeps({ findMany });

      const result = await service.findReusable('org-1', 'conn-1', 'VOUCHERS' as any, {
        company: 'ABC Ltd',
        voucherType: 'Sales',
        from: '20260401',
        to: '20260430',
      });

      expect(result).toBeNull();
    });

    it('does NOT reuse a wider (containing) range for vouchers — exact match only this pass', async () => {
      const findMany = jest.fn().mockResolvedValue([
        {
          id: 'full-year',
          params: { company: 'ABC Ltd', voucherType: 'Sales', from: '20260101', to: '20261231' },
        },
      ]);
      const { service } = makeDeps({ findMany });

      const result = await service.findReusable('org-1', 'conn-1', 'VOUCHERS' as any, {
        company: 'ABC Ltd',
        voucherType: 'Sales',
        from: '20260401',
        to: '20260430',
      });

      expect(result).toBeNull();
    });
  });

  describe('isResultCached', () => {
    it('true when the Redis key exists', async () => {
      const { service, redis } = makeDeps({ exists: jest.fn().mockResolvedValue(1) });
      await expect(service.isResultCached('job-1')).resolves.toBe(true);
      expect(redis.exists).toHaveBeenCalledWith('extraction-result:job-1');
    });

    it('false when it does not', async () => {
      const { service } = makeDeps({ exists: jest.fn().mockResolvedValue(0) });
      await expect(service.isResultCached('job-1')).resolves.toBe(false);
    });
  });
});
