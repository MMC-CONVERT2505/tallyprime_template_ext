import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ExtractionsService } from './extractions.service';

describe('ExtractionsService', () => {
  const CONNECTION = { id: 'conn-1', orgId: 'org-1', isActive: true, defaultCompany: 'ABC Ltd' };

  function makeDeps(
    overrides: {
      connection?: any;
      tunnel?: Partial<Record<'listConnectedAgents', jest.Mock>>;
      redisGet?: jest.Mock;
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
      },
    };
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const tunnel = {
      listConnectedAgents:
        overrides.tunnel?.listConnectedAgents ?? jest.fn().mockReturnValue(['conn-1']),
    };
    const redis = { get: overrides.redisGet ?? jest.fn().mockResolvedValue(null) };
    const excel = { generate: jest.fn().mockResolvedValue(Buffer.from('fake-xlsx')) };

    const service = new ExtractionsService(
      prisma as any,
      queue as any,
      tunnel as any,
      redis as any,
      excel as any,
    );
    return { service, prisma, queue, tunnel, redis, excel };
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
    function makeFetchMasterDeps(overrides: { findMany?: jest.Mock; tunnel?: jest.Mock } = {}) {
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
      const redis = { get: jest.fn() };
      const excel = { generate: jest.fn() };
      const service = new ExtractionsService(
        prisma as any,
        queue as any,
        tunnel as any,
        redis as any,
        excel as any,
      );
      return { service, prisma, queue, tunnel };
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
      expect(excel.generate).toHaveBeenCalledTimes(1);
      expect(excel.generate.mock.calls[0][0]).toBe('Items');
      expect(excel.generate.mock.calls[0][2]).toEqual([
        expect.objectContaining({ 'Item Name': 'Widget', 'Initial Stock': 5 }),
      ]);
    });

    it('rejects a LEDGERS export with no groupsJobId, without touching the excel generator', async () => {
      const { service, prisma, excel } = makeDeps();
      prisma.extractionJob.findFirst.mockResolvedValue({
        id: 'job-1',
        status: 'SUCCESS',
        type: 'LEDGERS',
      });

      await expect(service.getExcelResult('org-1', 'job-1')).rejects.toThrow('groupsJobId');
      expect(excel.generate).not.toHaveBeenCalled();
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
      expect(excel.generate.mock.calls[0][0]).toBe('Chart of Accounts');
      expect(excel.generate.mock.calls[0][2]).toEqual([
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
  });
});
