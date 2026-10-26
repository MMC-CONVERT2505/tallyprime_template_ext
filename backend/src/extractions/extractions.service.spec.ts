import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ExtractionsService } from './extractions.service';

describe('ExtractionsService', () => {
  const CONNECTION = { id: 'conn-1', orgId: 'org-1', isActive: true, defaultCompany: 'ABC Ltd' };

  function makeDeps(
    overrides: {
      connection?: any;
      tunnel?: Partial<Record<'listConnectedAgents', jest.Mock>>;
      redisGet?: jest.Mock;
      findReusable?: jest.Mock;
    } = {},
  ) {
    const prisma = {
      tallyConnection: {
        findFirst: jest
          .fn()
          .mockResolvedValue('connection' in overrides ? overrides.connection : CONNECTION),
      },
      extractionJob: {
        create: jest
          .fn()
          .mockImplementation(({ data }) => ({ id: 'job-1', status: 'PENDING', ...data })),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const tunnel = {
      listConnectedAgents:
        overrides.tunnel?.listConnectedAgents ?? jest.fn().mockReturnValue(['conn-1']),
    };
    // set/eval back the dispatch-race lock (lock.util's SET NX / compare-and-
    // delete) — always "acquired, then released cleanly" by default so
    // enqueue's lock-then-reuse-check path runs fn() rather than short-
    // circuiting on contention, matching every existing test's expectations.
    const redis = {
      get: overrides.redisGet ?? jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    };
    const excel = { writeIntoTemplate: jest.fn().mockResolvedValue(Buffer.from('fake-xlsx')) };
    // No reuse hit by default — every pre-existing test exercises the
    // "nothing cached yet" fresh-dispatch path unchanged.
    const reuse = { findReusable: overrides.findReusable ?? jest.fn().mockResolvedValue(null) };

    const service = new ExtractionsService(
      prisma as any,
      queue as any,
      tunnel as any,
      redis as any,
      excel as any,
      reuse as any,
    );
    return { service, prisma, queue, tunnel, redis, excel, reuse };
  }

  describe('create', () => {
    it('creates a PENDING job scoped to the org and enqueues it', async () => {
      const { service, prisma, queue } = makeDeps();

      const result = await service.create('org-1', 'user@example.com', {
        connectionId: 'conn-1',
        type: 'LEDGERS' as any,
      });

      expect(result).toEqual({ id: 'job-1', status: 'PENDING' });
      const created = prisma.extractionJob.create.mock.calls[0][0].data;
      expect(created).toMatchObject({ orgId: 'org-1', connectionId: 'conn-1', type: 'LEDGERS' });

      expect(queue.add).toHaveBeenCalledWith('extract', {
        mode: 'agent',
        extractionJobId: 'job-1',
        connectionId: 'conn-1',
        type: 'LEDGERS',
        payload: { company: 'ABC Ltd' }, // connection's defaultCompany, merged in
        notifyEmail: 'user@example.com',
      });
    });

    it("falls back to the connection's defaultCompany when payload.company is omitted, AND actually threads it through to the dispatched job (not just the DB record)", async () => {
      const { service, prisma, queue } = makeDeps();

      await service.create('org-1', 'user@example.com', {
        connectionId: 'conn-1',
        type: 'LEDGERS' as any,
      });

      expect(prisma.extractionJob.create.mock.calls[0][0].data.company).toBe('ABC Ltd');
      // Regression: this used to be recorded on the DB row but silently
      // dropped from the payload actually sent to the agent, so the fallback
      // never worked at runtime — caught live against a real Tally instance.
      expect(queue.add.mock.calls[0][1].payload).toEqual({ company: 'ABC Ltd' });
    });

    it("an explicit payload.company matching the connection's paired company is accepted", async () => {
      const { service, queue } = makeDeps();

      await service.create('org-1', 'user@example.com', {
        connectionId: 'conn-1',
        type: 'LEDGERS' as any,
        payload: { company: 'ABC Ltd' },
      });

      expect(queue.add.mock.calls[0][1].payload).toEqual({ company: 'ABC Ltd' });
    });

    it(
      "rejects an explicit payload.company that does not match the connection's paired company " +
        '(architecture.md non-negotiable: an agent can only act on the company it is paired to)',
      async () => {
        const { service, queue } = makeDeps();

        await expect(
          service.create('org-1', 'user@example.com', {
            connectionId: 'conn-1',
            type: 'LEDGERS' as any,
            payload: { company: 'Some Other Company' },
          }),
        ).rejects.toThrow('does not match');
        expect(queue.add).not.toHaveBeenCalled();
      },
    );

    it('allows an explicit payload.company through unchanged when the connection has no fixed defaultCompany', async () => {
      const { service, queue } = makeDeps({ connection: { ...CONNECTION, defaultCompany: null } });

      await service.create('org-1', 'user@example.com', {
        connectionId: 'conn-1',
        type: 'LEDGERS' as any,
        payload: { company: 'Any Company' },
      });

      expect(queue.add.mock.calls[0][1].payload).toEqual({ company: 'Any Company' });
    });

    it("rejects a connection that does not belong to the caller's org (or does not exist)", async () => {
      const { service, prisma } = makeDeps({ connection: null });

      await expect(
        service.create('org-1', 'user@example.com', {
          connectionId: 'conn-1',
          type: 'LEDGERS' as any,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.extractionJob.create).not.toHaveBeenCalled();
    });

    it('rejects a revoked connection', async () => {
      const { service } = makeDeps({ connection: { ...CONNECTION, isActive: false } });

      await expect(
        service.create('org-1', 'user@example.com', {
          connectionId: 'conn-1',
          type: 'LEDGERS' as any,
        }),
      ).rejects.toThrow('revoked');
    });

    it('rejects immediately when the connector is not currently online, rather than queueing a doomed job', async () => {
      const { service, queue } = makeDeps({
        tunnel: { listConnectedAgents: jest.fn().mockReturnValue([]) },
      });

      await expect(
        service.create('org-1', 'user@example.com', {
          connectionId: 'conn-1',
          type: 'LEDGERS' as any,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('fetchMaster', () => {
    function makeFetchMasterDeps(
      overrides: { findMany?: jest.Mock; tunnel?: jest.Mock; findReusable?: jest.Mock } = {},
    ) {
      const prisma = {
        tallyConnection: {
          findMany: overrides.findMany ?? jest.fn().mockResolvedValue([CONNECTION]),
        },
        extractionJob: {
          create: jest
            .fn()
            .mockImplementation(({ data }) => ({ id: 'job-1', status: 'PENDING', ...data })),
        },
      };
      const queue = { add: jest.fn().mockResolvedValue({}) };
      const tunnel = {
        listConnectedAgents: overrides.tunnel ?? jest.fn().mockReturnValue(['conn-1']),
      };
      const redis = {
        get: jest.fn(),
        set: jest.fn().mockResolvedValue('OK'),
        eval: jest.fn().mockResolvedValue(1),
      };
      const excel = { writeIntoTemplate: jest.fn() };
      const reuse = { findReusable: overrides.findReusable ?? jest.fn().mockResolvedValue(null) };
      const service = new ExtractionsService(
        prisma as any,
        queue as any,
        tunnel as any,
        redis as any,
        excel as any,
        reuse as any,
      );
      return { service, prisma, queue, tunnel, reuse };
    }

    it('resolves the connector by companyName and enqueues a job, converting ISO dates to YYYYMMDD', async () => {
      const { service, prisma, queue } = makeFetchMasterDeps();

      const result = await service.fetchMaster('org-1', 'user@example.com', {
        companyName: 'ABC Ltd',
        masterType: 'LEDGERS' as any,
        fromDate: '2026-04-01' as any,
        toDate: '2026-04-30' as any,
      });

      expect(result).toEqual({ id: 'job-1', status: 'PENDING' });
      expect(prisma.tallyConnection.findMany).toHaveBeenCalledWith({
        where: { orgId: 'org-1', defaultCompany: 'ABC Ltd', isActive: true },
      });
      expect(queue.add).toHaveBeenCalledWith('extract', {
        mode: 'agent',
        extractionJobId: 'job-1',
        connectionId: 'conn-1',
        type: 'LEDGERS',
        payload: { company: 'ABC Ltd', fromDate: '2026-04-01', toDate: '2026-04-30' },
        notifyEmail: 'user@example.com',
      });
    });

    it('404s when no connector is paired with the requested company', async () => {
      const { service, queue } = makeFetchMasterDeps({ findMany: jest.fn().mockResolvedValue([]) });

      await expect(
        service.fetchMaster('org-1', 'user@example.com', {
          companyName: 'Nope Ltd',
          masterType: 'LEDGERS' as any,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('auto-resolves multiple matches (legacy duplicate data) by preferring whichever is currently online', async () => {
      const { service, queue } = makeFetchMasterDeps({
        findMany: jest.fn().mockResolvedValue([CONNECTION, { ...CONNECTION, id: 'conn-2' }]),
        tunnel: jest.fn().mockReturnValue(['conn-2']),
      });

      await service.fetchMaster('org-1', 'user@example.com', {
        companyName: 'ABC Ltd',
        masterType: 'LEDGERS' as any,
      });

      expect(queue.add.mock.calls[0][1].connectionId).toBe('conn-2');
    });

    it('auto-resolves multiple matches with none online (tie-break by lastSeenAt) without throwing the old ambiguity error', async () => {
      const older = { ...CONNECTION, id: 'conn-old', lastSeenAt: new Date('2026-01-01') };
      const newer = { ...CONNECTION, id: 'conn-new', lastSeenAt: new Date('2026-02-01') };
      const { service, queue } = makeFetchMasterDeps({
        findMany: jest.fn().mockResolvedValue([older, newer]),
        tunnel: jest.fn().mockReturnValue([]),
      });

      // Resolution itself succeeds silently (no "ambiguous, pick one" error) —
      // it's the separate, unrelated "is it online" check further down that
      // (correctly) still rejects, since neither candidate is connected here.
      await expect(
        service.fetchMaster('org-1', 'user@example.com', {
          companyName: 'ABC Ltd',
          masterType: 'LEDGERS' as any,
        }),
      ).rejects.toThrow('not currently online');
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('rejects when the resolved connector is not currently online', async () => {
      const { service, queue } = makeFetchMasterDeps({ tunnel: jest.fn().mockReturnValue([]) });

      await expect(
        service.fetchMaster('org-1', 'user@example.com', {
          companyName: 'ABC Ltd',
          masterType: 'LEDGERS' as any,
        }),
      ).rejects.toThrow('not currently online');
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('rejects a fromDate after toDate before ever touching the database', async () => {
      const { service, prisma } = makeFetchMasterDeps();

      await expect(
        service.fetchMaster('org-1', 'user@example.com', {
          companyName: 'ABC Ltd',
          masterType: 'LEDGERS' as any,
          fromDate: '2026-04-30' as any,
          toDate: '2026-04-01' as any,
        }),
      ).rejects.toThrow('must not be after');
      expect(prisma.tallyConnection.findMany).not.toHaveBeenCalled();
    });
  });

  describe('enqueue reuse (ExtractionReuseService integration)', () => {
    it('returns an existing reusable job unchanged, WITHOUT creating a new ExtractionJob row or enqueueing anything', async () => {
      const findReusable = jest.fn().mockResolvedValue({ id: 'reused-job', status: 'SUCCESS' });
      const { service, prisma, queue, reuse } = makeDeps({ findReusable });

      const result = await service.create('org-1', 'user@example.com', {
        connectionId: 'conn-1',
        type: 'GROUPS' as any,
      });

      expect(result).toEqual({ id: 'reused-job', status: 'SUCCESS' });
      expect(prisma.extractionJob.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(reuse.findReusable).toHaveBeenCalledWith('org-1', 'conn-1', 'GROUPS', {
        company: 'ABC Ltd',
      });
    });

    it('forceRefresh bypasses the reuse check entirely, even when a reusable job exists', async () => {
      const findReusable = jest.fn().mockResolvedValue({ id: 'reused-job', status: 'SUCCESS' });
      const { service, prisma, queue, reuse } = makeDeps({ findReusable });

      const result = await service.create('org-1', 'user@example.com', {
        connectionId: 'conn-1',
        type: 'GROUPS' as any,
        forceRefresh: true,
      });

      expect(result).toEqual({ id: 'job-1', status: 'PENDING' });
      expect(reuse.findReusable).not.toHaveBeenCalled();
      expect(prisma.extractionJob.create).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();
    });

    it('falls through to a fresh dispatch when the dispatch-race lock is already held (contended, not a failure)', async () => {
      const findReusable = jest.fn().mockResolvedValue({ id: 'reused-job', status: 'SUCCESS' });
      const { service, prisma, queue, redis, reuse } = makeDeps({ findReusable });
      // Simulate someone else already holding this exact dispatch lock.
      (redis.set as jest.Mock).mockResolvedValueOnce(null);

      const result = await service.create('org-1', 'user@example.com', {
        connectionId: 'conn-1',
        type: 'GROUPS' as any,
      });

      // The reuse lookup never even ran (lock not acquired) — dispatch
      // proceeds fresh rather than blocking or erroring, since losing this
      // race is always safe (every extraction is a Tally read).
      expect(reuse.findReusable).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'job-1', status: 'PENDING' });
      expect(prisma.extractionJob.create).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();
    });

    it('fetchMaster also goes through the same reuse check', async () => {
      const findReusable = jest.fn().mockResolvedValue({ id: 'reused-job', status: 'SUCCESS' });
      const prisma = {
        tallyConnection: { findMany: jest.fn().mockResolvedValue([CONNECTION]) },
        extractionJob: { create: jest.fn() },
      };
      const queue = { add: jest.fn().mockResolvedValue({}) };
      const tunnel = { listConnectedAgents: jest.fn().mockReturnValue(['conn-1']) };
      const redis = {
        get: jest.fn(),
        set: jest.fn().mockResolvedValue('OK'),
        eval: jest.fn().mockResolvedValue(1),
      };
      const excel = { writeIntoTemplate: jest.fn() };
      const reuse = { findReusable };
      const service = new ExtractionsService(
        prisma as any,
        queue as any,
        tunnel as any,
        redis as any,
        excel as any,
        reuse as any,
      );

      const result = await service.fetchMaster('org-1', 'user@example.com', {
        companyName: 'ABC Ltd',
        masterType: 'LEDGERS' as any,
      });

      expect(result).toEqual({ id: 'reused-job', status: 'SUCCESS' });
      expect(prisma.extractionJob.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('scopes the lookup to the org and 404s otherwise', async () => {
      const { service, prisma } = makeDeps();
      prisma.extractionJob.findFirst.mockResolvedValue(null);

      await expect(service.getStatus('org-1', 'job-1')).rejects.toThrow(NotFoundException);
      expect(prisma.extractionJob.findFirst).toHaveBeenCalledWith({
        where: { id: 'job-1', orgId: 'org-1' },
      });
    });
  });

  describe('remove', () => {
    it('deletes a SUCCESS job and its cached Redis result', async () => {
      const { service, prisma, redis } = makeDeps();
      prisma.extractionJob.findFirst.mockResolvedValue({ id: 'job-1', status: 'SUCCESS' });

      await service.remove('org-1', 'job-1');

      expect(redis.del).toHaveBeenCalledWith('extraction-result:job-1');
      expect(prisma.extractionJob.deleteMany).toHaveBeenCalledWith({
        where: { id: 'job-1', orgId: 'org-1' },
      });
    });

    it('deletes a FAILED job too', async () => {
      const { service, prisma } = makeDeps();
      prisma.extractionJob.findFirst.mockResolvedValue({ id: 'job-1', status: 'FAILED' });

      await service.remove('org-1', 'job-1');

      expect(prisma.extractionJob.deleteMany).toHaveBeenCalled();
    });

    it('refuses to delete a still-PENDING job', async () => {
      const { service, prisma } = makeDeps();
      prisma.extractionJob.findFirst.mockResolvedValue({ id: 'job-1', status: 'PENDING' });

      await expect(service.remove('org-1', 'job-1')).rejects.toThrow('still pending');
      expect(prisma.extractionJob.deleteMany).not.toHaveBeenCalled();
    });

    it("404s when a different org tries to delete another org's job", async () => {
      const { service, prisma } = makeDeps();
      prisma.extractionJob.findFirst.mockResolvedValue(null);

      await expect(service.remove('org-2', 'job-1')).rejects.toThrow(NotFoundException);
      expect(prisma.extractionJob.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('listJobs', () => {
    it('scopes to the org, orders newest first, and defaults the limit to 50', async () => {
      const { service, prisma } = makeDeps();
      prisma.extractionJob.findMany.mockResolvedValue([{ id: 'job-2' }, { id: 'job-1' }]);

      const result = await service.listJobs('org-1');

      expect(result).toEqual([{ id: 'job-2' }, { id: 'job-1' }]);
      expect(prisma.extractionJob.findMany).toHaveBeenCalledWith({
        where: { orgId: 'org-1' },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    });

    it('clamps an explicit limit to the [1, 200] range', async () => {
      const { service, prisma } = makeDeps();

      await service.listJobs('org-1', 500);
      expect(prisma.extractionJob.findMany.mock.calls[0][0]).toMatchObject({ take: 200 });

      await service.listJobs('org-1', 0);
      expect(prisma.extractionJob.findMany.mock.calls[1][0]).toMatchObject({ take: 1 });
    });
  });

  describe('getResult', () => {
    it('rejects while the job is still PENDING', async () => {
      const { service, prisma } = makeDeps();
      prisma.extractionJob.findFirst.mockResolvedValue({ id: 'job-1', status: 'PENDING' });

      await expect(service.getResult('org-1', 'job-1')).rejects.toThrow('has not finished');
    });

    it('surfaces the stored error message for a FAILED job', async () => {
      const { service, prisma } = makeDeps();
      prisma.extractionJob.findFirst.mockResolvedValue({
        id: 'job-1',
        status: 'FAILED',
        error: 'Tally unreachable',
      });

      await expect(service.getResult('org-1', 'job-1')).rejects.toThrow('Tally unreachable');
    });

    it('returns the parsed result for a SUCCESS job still within TTL', async () => {
      const redisGet = jest.fn().mockResolvedValue(JSON.stringify([{ name: 'Cash' }]));
      const { service, prisma } = makeDeps({ redisGet });
      prisma.extractionJob.findFirst.mockResolvedValue({ id: 'job-1', status: 'SUCCESS' });

      await expect(service.getResult('org-1', 'job-1')).resolves.toEqual([{ name: 'Cash' }]);
    });

    it('404s when the result has expired out of Redis', async () => {
      const { service, prisma } = makeDeps({ redisGet: jest.fn().mockResolvedValue(null) });
      prisma.extractionJob.findFirst.mockResolvedValue({ id: 'job-1', status: 'SUCCESS' });

      await expect(service.getResult('org-1', 'job-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getExcelResult', () => {
    it('generates an Items workbook for a STOCK_ITEMS job with no extra params needed', async () => {
      const redisGet = jest.fn().mockResolvedValue(
        JSON.stringify([
          {
            name: 'Widget',
            parent: null,
            description: null,
            baseUnit: 'Nos',
            openingBalance: 5,
            openingValue: 50,
            closingBalance: 5,
            closingValue: 50,
            alterId: 1,
          },
        ]),
      );
      const { service, prisma, excel } = makeDeps({ redisGet });
      prisma.extractionJob.findFirst.mockResolvedValue({
        id: 'job-1',
        status: 'SUCCESS',
        type: 'STOCK_ITEMS',
      });

      const result = await service.getExcelResult('org-1', 'job-1');

      expect(result.filename).toBe('items-job-1.xlsx');
      expect(excel.writeIntoTemplate).toHaveBeenCalledTimes(1);
      expect(excel.writeIntoTemplate.mock.calls[0][0]).toMatch(/Item\.xlsx$/);
      expect(excel.writeIntoTemplate.mock.calls[0][1]).toBe('Item');
      expect(excel.writeIntoTemplate.mock.calls[0][2]).toEqual([
        expect.objectContaining({ 'Item Name': 'Widget', 'Opening Stock': 5 }),
      ]);
    });

    it('rejects a LEDGERS export with no groupsJobId when no successful GROUPS job exists to auto-resolve, without touching the excel generator', async () => {
      const { service, prisma, excel } = makeDeps();
      prisma.extractionJob.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.id === 'job-1'
            ? { id: 'job-1', status: 'SUCCESS', type: 'LEDGERS', company: 'ABC Ltd' }
            : null, // the auto-resolve lookup (by company+type+status) finds nothing
        ),
      );

      await expect(service.getExcelResult('org-1', 'job-1')).rejects.toThrow(
        'needs a completed GROUPS extraction',
      );
      expect(excel.writeIntoTemplate).not.toHaveBeenCalled();
    });

    it('auto-resolves groupsJobId to the most recent successful GROUPS job for the same company when not passed explicitly', async () => {
      const jobsById: Record<string, any> = {
        'ledgers-job': {
          id: 'ledgers-job',
          status: 'SUCCESS',
          type: 'LEDGERS',
          company: 'ABC Ltd',
        },
        'auto-groups-job': {
          id: 'auto-groups-job',
          status: 'SUCCESS',
          type: 'GROUPS',
          company: 'ABC Ltd',
        },
      };
      const resultsById: Record<string, unknown> = {
        'ledgers-job': [
          {
            name: 'Cash',
            parent: 'Cash-in-Hand',
            description: null,
            openingBalance: 0,
            closingBalance: 0,
            alterId: 1,
          },
        ],
        'auto-groups-job': [],
      };
      const { service, prisma, excel } = makeDeps({
        redisGet: jest.fn().mockImplementation((key: string) => {
          const id = key.replace('extraction-result:', '');
          return Promise.resolve(JSON.stringify(resultsById[id]));
        }),
      });
      prisma.extractionJob.findFirst.mockImplementation(({ where }: any) => {
        if (where.id) return Promise.resolve(jobsById[where.id] ?? null);
        // The auto-resolve lookup: no `id` in `where`, just company/type/status.
        expect(where).toMatchObject({
          orgId: 'org-1',
          company: 'ABC Ltd',
          type: 'GROUPS',
          status: 'SUCCESS',
        });
        return Promise.resolve({ id: 'auto-groups-job' });
      });

      const result = await service.getExcelResult('org-1', 'ledgers-job');

      expect(result.filename).toBe('accounts-ledgers-job.xlsx');
      expect(excel.writeIntoTemplate).toHaveBeenCalledTimes(1);
    });

    it('combines a LEDGERS job with a separately-completed GROUPS job to generate the Accounts workbook', async () => {
      const jobsById: Record<string, any> = {
        'ledgers-job': { id: 'ledgers-job', status: 'SUCCESS', type: 'LEDGERS' },
        'groups-job': { id: 'groups-job', status: 'SUCCESS', type: 'GROUPS' },
      };
      const resultsById: Record<string, unknown> = {
        'ledgers-job': [
          {
            name: 'Aaina Sinha',
            parent: 'Employee',
            description: null,
            openingBalance: 0,
            closingBalance: 0,
            alterId: 1,
          },
        ],
        'groups-job': [{ name: 'Employee', parent: 'Current Liabilities', alterId: 1 }],
      };
      const { service, prisma, excel } = makeDeps({
        redisGet: jest.fn().mockImplementation((key: string) => {
          const id = key.replace('extraction-result:', '');
          return Promise.resolve(JSON.stringify(resultsById[id]));
        }),
      });
      prisma.extractionJob.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(jobsById[where.id] ?? null),
      );

      const result = await service.getExcelResult('org-1', 'ledgers-job', 'groups-job');

      expect(result.filename).toBe('accounts-ledgers-job.xlsx');
      expect(excel.writeIntoTemplate.mock.calls[0][0]).toMatch(/COA\.xlsx$/);
      expect(excel.writeIntoTemplate.mock.calls[0][1]).toBe('sample_accounts');
      expect(excel.writeIntoTemplate.mock.calls[0][2]).toEqual([
        expect.objectContaining({
          'Account Name': 'Aaina Sinha',
          'Account Type': 'Other Current Liability',
        }),
      ]);
    });

    it('rejects when groupsJobId points at a job that is not actually a GROUPS job', async () => {
      const jobsById: Record<string, any> = {
        'ledgers-job': { id: 'ledgers-job', status: 'SUCCESS', type: 'LEDGERS' },
        'other-job': { id: 'other-job', status: 'SUCCESS', type: 'STOCK_ITEMS' },
      };
      const { service, prisma } = makeDeps({
        redisGet: jest.fn().mockResolvedValue(JSON.stringify([])),
      });
      prisma.extractionJob.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(jobsById[where.id] ?? null),
      );

      await expect(service.getExcelResult('org-1', 'ledgers-job', 'other-job')).rejects.toThrow(
        'must reference a completed GROUPS job',
      );
    });

    it('rejects a type with no mapper yet (e.g. COMPANIES)', async () => {
      const { service, prisma } = makeDeps({
        redisGet: jest.fn().mockResolvedValue(JSON.stringify([])),
      });
      prisma.extractionJob.findFirst.mockResolvedValue({
        id: 'job-1',
        status: 'SUCCESS',
        type: 'COMPANIES',
      });

      await expect(service.getExcelResult('org-1', 'job-1')).rejects.toThrow('not yet supported');
    });

    describe('VOUCHERS (Invoice/Bill/Credit Note/Stock Journal)', () => {
      const voucherRow = {
        date: '20250415',
        voucherType: 'Sales',
        voucherNumber: 'INV-1',
        partyLedgerName: 'ABC Traders',
        narration: null,
        reference: null,
        alterId: 1,
        ledgerEntries: [],
        inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 }],
        partyGstin: null,
        placeOfSupply: null,
      };
      const itemRow = {
        name: 'Widget A',
        parent: null,
        description: null,
        baseUnit: 'Nos',
        openingBalance: null,
        openingValue: null,
        closingBalance: null,
        closingValue: null,
        alterId: 1,
        alias: null,
        hsnCode: '392321',
        gstRate: 18,
      };

      it('rejects a VOUCHERS export with no itemsJobId when no successful STOCK_ITEMS job exists to auto-resolve, without touching the excel generator', async () => {
        const { service, prisma, excel } = makeDeps();
        prisma.extractionJob.findFirst.mockImplementation(({ where }: any) =>
          Promise.resolve(
            where.id === 'voucher-job'
              ? {
                  id: 'voucher-job',
                  status: 'SUCCESS',
                  type: 'VOUCHERS',
                  company: 'ABC Ltd',
                  params: { voucherType: 'Sales' },
                }
              : null, // the auto-resolve lookup finds nothing
          ),
        );

        await expect(service.getExcelResult('org-1', 'voucher-job')).rejects.toThrow(
          'needs a completed STOCK_ITEMS extraction',
        );
        expect(excel.writeIntoTemplate).not.toHaveBeenCalled();
      });

      it('auto-resolves itemsJobId to the most recent successful STOCK_ITEMS job for the same company when not passed explicitly', async () => {
        const jobsById: Record<string, any> = {
          'voucher-job': {
            id: 'voucher-job',
            status: 'SUCCESS',
            type: 'VOUCHERS',
            company: 'ABC Ltd',
            params: { voucherType: 'Sales' },
          },
          'auto-items-job': { id: 'auto-items-job', status: 'SUCCESS', type: 'STOCK_ITEMS' },
        };
        const resultsById: Record<string, unknown> = {
          'voucher-job': [voucherRow],
          'auto-items-job': [itemRow],
        };
        const { service, prisma, excel } = makeDeps({
          redisGet: jest.fn().mockImplementation((key: string) => {
            const id = key.replace('extraction-result:', '');
            return Promise.resolve(JSON.stringify(resultsById[id]));
          }),
        });
        prisma.extractionJob.findFirst.mockImplementation(({ where }: any) => {
          if (where.id) return Promise.resolve(jobsById[where.id] ?? null);
          // An INVOICE export also best-effort auto-resolves a LEDGERS job
          // for the Billing/Shipping/Contact block — irrelevant to this
          // test's own STOCK_ITEMS assertion, so just report none found.
          if (where.type === 'LEDGERS') return Promise.resolve(null);
          expect(where).toMatchObject({
            orgId: 'org-1',
            company: 'ABC Ltd',
            type: 'STOCK_ITEMS',
            status: 'SUCCESS',
          });
          return Promise.resolve({ id: 'auto-items-job' });
        });

        const result = await service.getExcelResult('org-1', 'voucher-job');

        expect(result.filename).toBe('invoices-voucher-job.xlsx');
        expect(excel.writeIntoTemplate.mock.calls[0][2]).toEqual([
          expect.objectContaining({ 'HSN/SAC': '392321' }),
        ]);
      });

      it('dispatches a Sales-voucherType job to the Invoice template, using the completed STOCK_ITEMS job for HSN/GST', async () => {
        const jobsById: Record<string, any> = {
          'voucher-job': {
            id: 'voucher-job',
            status: 'SUCCESS',
            type: 'VOUCHERS',
            params: { voucherType: 'Sales' },
          },
          'items-job': { id: 'items-job', status: 'SUCCESS', type: 'STOCK_ITEMS' },
        };
        const resultsById: Record<string, unknown> = {
          'voucher-job': [voucherRow],
          'items-job': [itemRow],
        };
        const { service, prisma, excel } = makeDeps({
          redisGet: jest.fn().mockImplementation((key: string) => {
            const id = key.replace('extraction-result:', '');
            return Promise.resolve(JSON.stringify(resultsById[id]));
          }),
        });
        prisma.extractionJob.findFirst.mockImplementation(({ where }: any) =>
          Promise.resolve(jobsById[where.id] ?? null),
        );

        const result = await service.getExcelResult(
          'org-1',
          'voucher-job',
          undefined,
          undefined,
          'items-job',
        );

        expect(result.filename).toBe('invoices-voucher-job.xlsx');
        expect(excel.writeIntoTemplate.mock.calls[0][0]).toMatch(/Invoice\.xlsx$/);
        expect(excel.writeIntoTemplate.mock.calls[0][1]).toBe('Invoice');
        expect(excel.writeIntoTemplate.mock.calls[0][2]).toEqual([
          expect.objectContaining({
            'Item Name': 'Widget A',
            'HSN/SAC': '392321',
            'Item Tax %': 18,
          }),
        ]);
      });

      it('rejects a voucherType with no matching Zoho template at all (e.g. a free-text Tally voucher type nothing maps to)', async () => {
        const jobsById: Record<string, any> = {
          'voucher-job': {
            id: 'voucher-job',
            status: 'SUCCESS',
            type: 'VOUCHERS',
            params: { voucherType: 'Memo' },
          },
          'items-job': { id: 'items-job', status: 'SUCCESS', type: 'STOCK_ITEMS' },
        };
        const { service, prisma } = makeDeps({
          redisGet: jest.fn().mockResolvedValue(JSON.stringify([])),
        });
        prisma.extractionJob.findFirst.mockImplementation(({ where }: any) =>
          Promise.resolve(jobsById[where.id] ?? null),
        );

        await expect(
          service.getExcelResult('org-1', 'voucher-job', undefined, undefined, 'items-job'),
        ).rejects.toThrow('not supported for voucher type "Memo"');
      });

      describe('Payment/Contra — ambiguous voucherType, needs voucherEntity to disambiguate (2026-10-21)', () => {
        const jobsById: Record<string, any> = {
          'voucher-job': {
            id: 'voucher-job',
            status: 'SUCCESS',
            type: 'VOUCHERS',
            company: 'ABC Ltd',
            params: { voucherType: 'Payment' },
          },
          'items-job': { id: 'items-job', status: 'SUCCESS', type: 'STOCK_ITEMS' },
        };

        it('rejects a Payment export with no voucherEntity at all', async () => {
          const { service, prisma } = makeDeps({
            redisGet: jest.fn().mockResolvedValue(JSON.stringify([])),
          });
          prisma.extractionJob.findFirst.mockImplementation(({ where }: any) =>
            Promise.resolve(jobsById[where.id] ?? null),
          );

          await expect(
            service.getExcelResult('org-1', 'voucher-job', undefined, undefined, 'items-job'),
          ).rejects.toThrow('pass ?voucherEntity= as one of: VENDOR_PAYMENT, EXPENSE');
        });

        it('rejects a Payment export whose voucherEntity is valid for a DIFFERENT voucherType (e.g. DEPOSIT)', async () => {
          const { service, prisma } = makeDeps({
            redisGet: jest.fn().mockResolvedValue(JSON.stringify([])),
          });
          prisma.extractionJob.findFirst.mockImplementation(({ where }: any) =>
            Promise.resolve(jobsById[where.id] ?? null),
          );

          await expect(
            service.getExcelResult(
              'org-1',
              'voucher-job',
              undefined,
              undefined,
              'items-job',
              undefined,
              undefined,
              'DEPOSIT' as any,
            ),
          ).rejects.toThrow('pass ?voucherEntity= as one of: VENDOR_PAYMENT, EXPENSE');
        });

        it('accepts a Payment export with a valid voucherEntity', async () => {
          const { service, prisma } = makeDeps({
            redisGet: jest.fn().mockResolvedValue(JSON.stringify([])),
          });
          prisma.extractionJob.findFirst.mockImplementation(({ where }: any) =>
            Promise.resolve(jobsById[where.id] ?? null),
          );

          const result = await service.getExcelResult(
            'org-1',
            'voucher-job',
            undefined,
            undefined,
            'items-job',
            undefined,
            undefined,
            'EXPENSE' as any,
          );
          expect(result.filename).toBe('expenses-voucher-job.xlsx');
        });
      });

      it('rejects when itemsJobId points at a job that is not actually a STOCK_ITEMS job', async () => {
        const jobsById: Record<string, any> = {
          'voucher-job': {
            id: 'voucher-job',
            status: 'SUCCESS',
            type: 'VOUCHERS',
            params: { voucherType: 'Sales' },
          },
          'other-job': { id: 'other-job', status: 'SUCCESS', type: 'GROUPS' },
        };
        const { service, prisma } = makeDeps({
          redisGet: jest.fn().mockResolvedValue(JSON.stringify([])),
        });
        prisma.extractionJob.findFirst.mockImplementation(({ where }: any) =>
          Promise.resolve(jobsById[where.id] ?? null),
        );

        await expect(
          service.getExcelResult('org-1', 'voucher-job', undefined, undefined, 'other-job'),
        ).rejects.toThrow('must reference a completed STOCK_ITEMS job');
      });

      describe('CREDIT_NOTE — Associated Invoice Date cross-reference', () => {
        const creditNoteRow = {
          date: '20260415',
          voucherType: 'Credit Note',
          voucherNumber: 'CN-1',
          partyLedgerName: 'ABC Traders',
          narration: null,
          reference: 'INV-1',
          alterId: 2,
          ledgerEntries: [],
          inventoryEntries: [{ stockItemName: 'Widget A', quantity: 1, rate: 100, amount: 100 }],
          partyGstin: null,
          placeOfSupply: null,
        };

        it('auto-resolves invoicesJobId to the most recent successful Sales-voucherType job for the same company, and uses it to populate Associated Invoice Date', async () => {
          const jobsById: Record<string, any> = {
            'cn-job': {
              id: 'cn-job',
              status: 'SUCCESS',
              type: 'VOUCHERS',
              company: 'ABC Ltd',
              params: { voucherType: 'Credit Note' },
            },
            'items-job': { id: 'items-job', status: 'SUCCESS', type: 'STOCK_ITEMS' },
            'auto-invoices-job': {
              id: 'auto-invoices-job',
              status: 'SUCCESS',
              type: 'VOUCHERS',
              company: 'ABC Ltd',
              params: { voucherType: 'Sales' },
            },
          };
          const resultsById: Record<string, unknown> = {
            'cn-job': [creditNoteRow],
            'items-job': [itemRow],
            'auto-invoices-job': [voucherRow], // voucherRow.voucherNumber === 'INV-1'
          };
          const { service, prisma, excel } = makeDeps({
            redisGet: jest.fn().mockImplementation((key: string) => {
              const id = key.replace('extraction-result:', '');
              return Promise.resolve(JSON.stringify(resultsById[id]));
            }),
          });
          prisma.extractionJob.findFirst.mockImplementation(({ where }: any) => {
            if (where.id) return Promise.resolve(jobsById[where.id] ?? null);
            // The itemsJobId auto-resolve lookup (type: STOCK_ITEMS) has no
            // params filter; the invoicesJobId one (type: VOUCHERS) does.
            if (where.type === 'STOCK_ITEMS') return Promise.resolve({ id: 'items-job' });
            // A CREDIT_NOTE export also best-effort auto-resolves a LEDGERS
            // job for the Billing/Shipping/Contact block (2026-10-21) —
            // irrelevant to this test's own invoicesJobId assertion, so just
            // report none found.
            if (where.type === 'LEDGERS') return Promise.resolve(null);
            expect(where).toMatchObject({
              orgId: 'org-1',
              company: 'ABC Ltd',
              type: 'VOUCHERS',
              status: 'SUCCESS',
              params: { path: ['voucherType'], equals: 'Sales' },
            });
            return Promise.resolve({ id: 'auto-invoices-job' });
          });

          const result = await service.getExcelResult('org-1', 'cn-job');

          expect(result.filename).toBe('credit-notes-cn-job.xlsx');
          expect(excel.writeIntoTemplate.mock.calls[0][2]).toEqual([
            expect.objectContaining({
              'Associated Invoice Number': 'INV-1',
              'Associated Invoice Date': new Date(Date.UTC(2025, 3, 15, 12)),
            }),
          ]);
        });

        it('still succeeds with Associated Invoice Date left blank when no Invoice job exists — optional, not required like itemsJobId/groupsJobId', async () => {
          const jobsById: Record<string, any> = {
            'cn-job': {
              id: 'cn-job',
              status: 'SUCCESS',
              type: 'VOUCHERS',
              company: 'ABC Ltd',
              params: { voucherType: 'Credit Note' },
            },
            'items-job': { id: 'items-job', status: 'SUCCESS', type: 'STOCK_ITEMS' },
          };
          const resultsById: Record<string, unknown> = {
            'cn-job': [creditNoteRow],
            'items-job': [itemRow],
          };
          const { service, prisma, excel } = makeDeps({
            redisGet: jest.fn().mockImplementation((key: string) => {
              const id = key.replace('extraction-result:', '');
              return Promise.resolve(JSON.stringify(resultsById[id]));
            }),
          });
          prisma.extractionJob.findFirst.mockImplementation(({ where }: any) => {
            if (where.id) return Promise.resolve(jobsById[where.id] ?? null);
            if (where.type === 'STOCK_ITEMS') return Promise.resolve({ id: 'items-job' });
            return Promise.resolve(null); // no Sales-voucherType job to auto-resolve
          });

          const result = await service.getExcelResult('org-1', 'cn-job');

          expect(result.filename).toBe('credit-notes-cn-job.xlsx');
          expect(excel.writeIntoTemplate.mock.calls[0][2]).toEqual([
            expect.objectContaining({
              'Associated Invoice Number': 'INV-1',
              'Associated Invoice Date': '',
            }),
          ]);
        });
      });
    });
  });
});
