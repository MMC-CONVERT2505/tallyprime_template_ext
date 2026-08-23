import { ExtractionsProcessor } from './extractions.processor';

describe('ExtractionsProcessor', () => {
  function makeDeps(
    overrides: {
      sendCommand?: jest.Mock;
      getLedgers?: jest.Mock;
      findFirst?: jest.Mock;
      updateMany?: jest.Mock;
    } = {},
  ) {
    const prisma = {
      extractionJob: {
        updateMany: overrides.updateMany ?? jest.fn().mockResolvedValue({ count: 1 }),
        // No prior successful fetch by default — estimateBatchedTimeoutMs
        // falls back to the static commandTimeoutMs floor, same as before
        // dynamic sizing existed. Dedicated tests below override this.
        findFirst: overrides.findFirst ?? jest.fn().mockResolvedValue(null),
      },
    };
    const tunnel = {
      sendCommand:
        overrides.sendCommand ?? jest.fn().mockResolvedValue([{ name: 'Cash' }, { name: 'Sales' }]),
    };
    const redis = { set: jest.fn().mockResolvedValue('OK') };
    const notifications = { sendExtractionComplete: jest.fn().mockResolvedValue(undefined) };
    const config = {
      getOrThrow: jest.fn().mockReturnValue({
        resultTtlSeconds: 3600,
        commandTimeoutMs: 900000,
        timeoutMs: 60000,
        maxRetries: 2,
        chunkDelayMs: 2000,
        masterBatchSize: 300,
        periodBatchSize: 25,
        voucherChunkDays: 7,
      }),
    };
    const masters = {
      getLedgers:
        overrides.getLedgers ?? jest.fn().mockResolvedValue([{ name: 'Cash' }, { name: 'Sales' }]),
      getCompanies: jest.fn(),
      getStockItems: jest.fn(),
      getGroups: jest.fn(),
    };
    const transactions = { getVouchers: jest.fn() };
    const diagnostics = { probe: jest.fn(), getRaw: jest.fn() };

    const processor = new ExtractionsProcessor(
      prisma as any,
      tunnel as any,
      redis as any,
      notifications as any,
      config as any,
      masters as any,
      transactions as any,
      diagnostics as any,
    );
    return { processor, prisma, tunnel, redis, notifications, masters };
  }

  const job = {
    data: {
      mode: 'agent',
      extractionJobId: 'job-1',
      connectionId: 'conn-1',
      type: 'LEDGERS',
      payload: { company: 'ABC Ltd' },
      notifyEmail: 'user@example.com',
    },
    attemptsMade: 0,
    opts: { attempts: 1 },
    processedOn: Date.now(),
    isFailed: jest.fn().mockResolvedValue(true),
  } as any;

  it('on success: stores the result in Redis with the configured TTL, marks the job SUCCESS with the record count, and notifies', async () => {
    const { processor, prisma, redis, notifications } = makeDeps();

    await processor.process(job);

    expect(redis.set).toHaveBeenCalledWith(
      'extraction-result:job-1',
      JSON.stringify([{ name: 'Cash' }, { name: 'Sales' }]),
      'EX',
      3600,
    );
    expect(prisma.extractionJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'SUCCESS', recordCount: 2 }),
    });
    expect(notifications.sendExtractionComplete).toHaveBeenCalledWith(
      'user@example.com',
      expect.objectContaining({ jobId: 'job-1', status: 'SUCCESS', recordCount: 2 }),
    );
  });

  it('never notifies (or double-writes) a SUCCESS whose Postgres row was already settled by someone else (updateMany matches 0 rows)', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const { processor, notifications } = makeDeps({ updateMany });

    await processor.process(job);

    expect(notifications.sendExtractionComplete).not.toHaveBeenCalled();
  });

  // `process` itself never touches Postgres or sends a notification on
  // failure — regardless of attempt number, it just rethrows so BullMQ's own
  // retry/backoff decides what happens next. Postgres reconciliation and
  // notification are the SOLE responsibility of the `onJobFailed` event
  // handler below (see its doc comment for exactly why this split exists).
  it('on failure: never touches Postgres or notifies from inside `process` itself, regardless of attempt number', async () => {
    const sendCommand = jest.fn().mockRejectedValue(new Error('Could not reach Tally'));
    const { processor, prisma, redis, notifications } = makeDeps({ sendCommand });

    await expect(processor.process(job)).rejects.toThrow('Could not reach Tally');

    expect(redis.set).not.toHaveBeenCalled();
    expect(prisma.extractionJob.updateMany).not.toHaveBeenCalled();
    expect(notifications.sendExtractionComplete).not.toHaveBeenCalled();
  });

  it('treats a non-array result (e.g. RAW) as a single record', async () => {
    const sendCommand = jest.fn().mockResolvedValue({ rawXml: '<ENVELOPE/>' });
    const { processor, prisma } = makeDeps({ sendCommand });

    await processor.process(job);

    expect(prisma.extractionJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'PENDING' },
      data: expect.objectContaining({ recordCount: 1 }),
    });
  });

  describe("onJobFailed (the @OnWorkerEvent('failed') handler)", () => {
    /**
     * The regression test for the live incident this handler exists to fix:
     * a job whose worker process died mid-attempt gets recovered by BullMQ's
     * OWN stalled-job watchdog, which can permanently fail it (job.isFailed()
     * === true) via a path that never calls `process` again at all — so
     * `attemptsMade` can be arbitrarily low (here, still 0/1) even though
     * BullMQ has already, definitively given up. The old attemptsMade-vs-
     * attempts inference would have wrongly concluded "not final yet" and
     * left the Postgres row stuck PENDING forever; job.isFailed() (BullMQ's
     * own ground truth) doesn't make that mistake.
     */
    it('marks the job FAILED even though attemptsMade looks nowhere near the configured attempts — trusts job.isFailed(), not attempt math', async () => {
      const { processor, prisma, notifications } = makeDeps();
      const stalledJob = {
        ...job,
        attemptsMade: 1,
        opts: { attempts: 3 },
        isFailed: jest.fn().mockResolvedValue(true),
      };

      await processor.onJobFailed(stalledJob, new Error('job stalled more than allowable limit'));

      expect(prisma.extractionJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job-1', status: 'PENDING' },
        data: expect.objectContaining({
          status: 'FAILED',
          error: 'job stalled more than allowable limit',
        }),
      });
      expect(notifications.sendExtractionComplete).toHaveBeenCalledWith(
        'user@example.com',
        expect.objectContaining({
          jobId: 'job-1',
          status: 'FAILED',
          error: 'job stalled more than allowable limit',
        }),
      );
    });

    it('does nothing when BullMQ will still retry (job.isFailed() resolves false)', async () => {
      const { processor, prisma, notifications } = makeDeps();
      const retryingJob = { ...job, isFailed: jest.fn().mockResolvedValue(false) };

      await processor.onJobFailed(retryingJob, new Error('Tally timeout'));

      expect(prisma.extractionJob.updateMany).not.toHaveBeenCalled();
      expect(notifications.sendExtractionComplete).not.toHaveBeenCalled();
    });

    it('is idempotent — a second failed event for an already-settled job is a silent no-op (updateMany matches 0 rows)', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const { processor, notifications } = makeDeps({ updateMany });

      await processor.onJobFailed(job, new Error('Tally timeout'));

      expect(notifications.sendExtractionComplete).not.toHaveBeenCalled();
    });

    it('handles job being undefined (already removed, e.g. by removeOnFail) without throwing', async () => {
      const { processor, prisma } = makeDeps();

      await expect(processor.onJobFailed(undefined, new Error('gone'))).resolves.toBeUndefined();
      expect(prisma.extractionJob.updateMany).not.toHaveBeenCalled();
    });

    it('never notifies for a local-mode job — there is no notifyEmail on it', async () => {
      const { processor, prisma, notifications } = makeDeps();
      const localJob = {
        data: { mode: 'local', extractionJobId: 'job-2', type: 'LEDGERS', payload: {} },
        isFailed: jest.fn().mockResolvedValue(true),
        processedOn: Date.now(),
      } as any;

      await processor.onJobFailed(localJob, new Error('Tally unreachable'));

      expect(prisma.extractionJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job-2', status: 'PENDING' },
        data: expect.objectContaining({ status: 'FAILED', error: 'Tally unreachable' }),
      });
      expect(notifications.sendExtractionComplete).not.toHaveBeenCalled();
    });
  });

  describe('agent-mode dispatch: dedupeKey + dynamic timeout', () => {
    it("passes extractionJobId as sendCommand's dedupeKey", async () => {
      const sendCommand = jest.fn().mockResolvedValue([]);
      const { processor } = makeDeps({ sendCommand });

      await processor.process(job);

      expect(sendCommand).toHaveBeenCalledWith(
        'conn-1',
        'ledgers',
        { company: 'ABC Ltd' },
        undefined,
        'job-1',
      );
    });

    it("computes a dynamic timeout from the connector's last successful fetch of the same type", async () => {
      const sendCommand = jest.fn().mockResolvedValue([]);
      const findFirst = jest.fn().mockResolvedValue({ recordCount: 6000 });
      const { processor, prisma } = makeDeps({ sendCommand, findFirst });

      await processor.process(job);

      expect(prisma.extractionJob.findFirst).toHaveBeenCalledWith({
        where: { connectionId: 'conn-1', type: 'LEDGERS', status: 'SUCCESS' },
        orderBy: { createdAt: 'desc' },
        select: { recordCount: true },
      });
      // 6000 records at the default 300 batch size, 1.5x safety factor, is
      // well beyond the static commandTimeoutMs floor (900000ms) — the
      // dynamic estimate must win, not just fall through to the default.
      expect(sendCommand.mock.calls[0][3]).toBeGreaterThan(900000);
    });

    it('estimates using the much smaller periodBatchSize (not masterBatchSize) when the job is period-scoped', async () => {
      const sendCommand = jest.fn().mockResolvedValue([]);
      const findFirst = jest.fn().mockResolvedValue({ recordCount: 6000 });
      const { processor } = makeDeps({ sendCommand, findFirst });
      const periodScopedJob = {
        data: {
          ...job.data,
          payload: { company: 'ABC Ltd', fromDate: '20260401', toDate: '20260430' },
        },
      } as any;

      await processor.process(periodScopedJob);
      const periodScopedTimeout = sendCommand.mock.calls[0][3];

      sendCommand.mockClear();
      await processor.process(job); // same recordCount, no date range -> masterBatchSize
      const allTimeTimeout = sendCommand.mock.calls[0][3];

      // 6000 records at periodBatchSize=25 is 12x the batches of
      // masterBatchSize=300 for the identical record count — the dynamic
      // estimate must reflect that, not silently reuse the all-time figure
      // (which is exactly what would hand back a too-small command timeout
      // for a period-scoped fetch — see estimateBatchedTimeoutMs's doc
      // comment for why that matters: the gateway would cancel a
      // legitimately-in-progress fetch mid-flight).
      expect(periodScopedTimeout).toBeGreaterThan(allTimeTimeout);
    });

    it("falls back to undefined (sendCommand's own static default) when there is no prior successful fetch", async () => {
      const sendCommand = jest.fn().mockResolvedValue([]);
      const { processor } = makeDeps({ sendCommand }); // default findFirst resolves null

      await processor.process(job);

      expect(sendCommand.mock.calls[0][3]).toBeUndefined();
    });

    it('never looks up history for COMPANIES/GROUPS — only LEDGERS/STOCK_ITEMS batch (VOUCHERS computes its own timeout deterministically instead, see below)', async () => {
      const sendCommand = jest.fn().mockResolvedValue([]);
      const { processor, prisma } = makeDeps({ sendCommand });
      const groupsJob = { data: { ...job.data, type: 'GROUPS' } } as any;

      await processor.process(groupsJob);

      expect(prisma.extractionJob.findFirst).not.toHaveBeenCalled();
      expect(sendCommand.mock.calls[0][3]).toBeUndefined();
    });

    describe('VOUCHERS: deterministic date-range-based timeout (no history lookup, unlike LEDGERS/STOCK_ITEMS)', () => {
      const vouchersJob = (payload: Record<string, unknown>) =>
        ({ data: { ...job.data, type: 'VOUCHERS', payload } }) as any;

      it('computes a timeout from the date range without ever consulting job history', async () => {
        const sendCommand = jest.fn().mockResolvedValue([]);
        const { processor, prisma } = makeDeps({ sendCommand });

        // A full year at the default 7-day chunking is ~53 chunks — large
        // enough that the dynamic estimate clearly exceeds the static
        // 900000ms floor (a 30-day range, by contrast, is only ~340s of
        // estimated work and would just clamp to the floor unchanged,
        // which wouldn't actually prove this is computing anything).
        await processor.process(
          vouchersJob({
            company: 'ABC Ltd',
            from: '20260101',
            to: '20261231',
            voucherType: 'Sales',
          }),
        );

        expect(prisma.extractionJob.findFirst).not.toHaveBeenCalled();
        expect(sendCommand.mock.calls[0][3]).toBeGreaterThan(900000);
      });

      it('a multi-year range produces a proportionally large budget instead of the tiny static default — the exact incident this fixes', async () => {
        const sendCommand = jest.fn().mockResolvedValue([]);
        const { processor } = makeDeps({ sendCommand });

        await processor.process(
          vouchersJob({
            company: 'ABC Ltd',
            from: '20000101',
            to: '20260815',
            voucherType: 'Sales',
          }),
        );

        expect(sendCommand.mock.calls[0][3]).toBeGreaterThan(900000 * 10);
      });

      it('a range narrow enough to be unchunked still floors at the static commandTimeoutMs', async () => {
        const sendCommand = jest.fn().mockResolvedValue([]);
        const { processor } = makeDeps({ sendCommand });

        await processor.process(
          vouchersJob({
            company: 'ABC Ltd',
            from: '20260401',
            to: '20260401',
            voucherType: 'Sales',
          }),
        );

        expect(sendCommand.mock.calls[0][3]).toBe(900000);
      });

      it('falls back to undefined when from/to are missing from the payload', async () => {
        const sendCommand = jest.fn().mockResolvedValue([]);
        const { processor } = makeDeps({ sendCommand });

        await processor.process(vouchersJob({ company: 'ABC Ltd' }));

        expect(sendCommand.mock.calls[0][3]).toBeUndefined();
      });
    });
  });

  describe('per-connector dispatch serialization', () => {
    it('serializes two agent-mode dispatches for the SAME connector — the second only starts once the first resolves', async () => {
      const order: string[] = [];
      let resolveFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      const sendCommand = jest.fn().mockImplementation(async () => {
        order.push('start');
        if (order.filter((e) => e === 'start').length === 1) {
          await firstGate; // first call blocks until explicitly released below
        }
        order.push('end');
        return [];
      });
      const { processor } = makeDeps({ sendCommand });
      const jobA = { ...job, data: { ...job.data, extractionJobId: 'job-a' } };
      const jobB = { ...job, data: { ...job.data, extractionJobId: 'job-b' } };

      const first = processor.process(jobA);
      // Give the first call a chance to actually start (and block on the gate).
      await new Promise((resolve) => setImmediate(resolve));
      const second = processor.process(jobB);
      await new Promise((resolve) => setImmediate(resolve));

      // The second dispatch must not have started yet — only one 'start' so far.
      expect(order).toEqual(['start']);

      resolveFirst();
      await Promise.all([first, second]);

      expect(order).toEqual(['start', 'end', 'start', 'end']);
    });

    it('does NOT serialize dispatches for DIFFERENT connectors — both may be in flight at once', async () => {
      const order: string[] = [];
      let releaseA!: () => void;
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const sendCommand = jest.fn().mockImplementation(async (connectionId: string) => {
        order.push(`start:${connectionId}`);
        if (connectionId === 'conn-A') await gateA;
        order.push(`end:${connectionId}`);
        return [];
      });
      const { processor } = makeDeps({ sendCommand });
      const jobA = {
        ...job,
        data: { ...job.data, connectionId: 'conn-A', extractionJobId: 'job-a' },
      };
      const jobB = {
        ...job,
        data: { ...job.data, connectionId: 'conn-B', extractionJobId: 'job-b' },
      };

      const first = processor.process(jobA);
      await new Promise((resolve) => setImmediate(resolve));
      const second = processor.process(jobB);
      await second; // conn-B's dispatch completes without waiting on conn-A's gate

      expect(order).toEqual(['start:conn-A', 'start:conn-B', 'end:conn-B']);

      releaseA();
      await first;
      expect(order).toEqual(['start:conn-A', 'start:conn-B', 'end:conn-B', 'end:conn-A']);
    });
  });

  describe('mode: local (the /tally/jobs dev/testing path — no agent involved)', () => {
    const localJob = {
      data: {
        mode: 'local',
        extractionJobId: 'job-2',
        type: 'LEDGERS',
        payload: { company: 'ABC Ltd' },
      },
      attemptsMade: 0,
      opts: { attempts: 1 },
      processedOn: Date.now(),
      isFailed: jest.fn().mockResolvedValue(true),
    } as any;

    it('dispatches to the local Tally services (not the tunnel), and still stores/marks the result', async () => {
      const { processor, prisma, redis, tunnel, masters } = makeDeps();

      await processor.process(localJob);

      // Last arg is the job's own id — see runExtraction's externalJobId doc
      // comment: without it, a batched fetch's live progress lands on a
      // second, uncoordinated row the caller (GET /tally/jobs/:id) never sees.
      expect(masters.getLedgers).toHaveBeenCalledWith(
        'ABC Ltd',
        undefined,
        undefined,
        undefined,
        'job-2',
      );
      expect(tunnel.sendCommand).not.toHaveBeenCalled();
      expect(redis.set).toHaveBeenCalledWith(
        'extraction-result:job-2',
        JSON.stringify([{ name: 'Cash' }, { name: 'Sales' }]),
        'EX',
        3600,
      );
      expect(prisma.extractionJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job-2', status: 'PENDING' },
        data: expect.objectContaining({ status: 'SUCCESS', recordCount: 2 }),
      });
    });

    it('never sends an email notification — there is no notifyEmail on a local-mode job', async () => {
      const { processor, notifications } = makeDeps();

      await processor.process(localJob);

      expect(notifications.sendExtractionComplete).not.toHaveBeenCalled();
    });

    it('on final failure (via onJobFailed): marks FAILED, does not notify, and process() itself still re-throws', async () => {
      const getLedgers = jest.fn().mockRejectedValue(new Error('Tally unreachable'));
      const { processor, prisma, notifications } = makeDeps({ getLedgers });

      await expect(processor.process(localJob)).rejects.toThrow('Tally unreachable');
      expect(prisma.extractionJob.updateMany).not.toHaveBeenCalled();

      await processor.onJobFailed(localJob, new Error('Tally unreachable'));

      expect(prisma.extractionJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job-2', status: 'PENDING' },
        data: expect.objectContaining({ status: 'FAILED', error: 'Tally unreachable' }),
      });
      expect(notifications.sendExtractionComplete).not.toHaveBeenCalled();
    });
  });
});
