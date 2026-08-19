import { ExtractionsProcessor } from './extractions.processor';

describe('ExtractionsProcessor', () => {
  function makeDeps(
    overrides: {
      sendCommand?: jest.Mock;
      getLedgers?: jest.Mock;
      findFirst?: jest.Mock;
    } = {},
  ) {
    const prisma = {
      extractionJob: {
        update: jest.fn().mockResolvedValue({}),
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
    expect(prisma.extractionJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({ status: 'SUCCESS', recordCount: 2 }),
    });
    expect(notifications.sendExtractionComplete).toHaveBeenCalledWith(
      'user@example.com',
      expect.objectContaining({ jobId: 'job-1', status: 'SUCCESS', recordCount: 2 }),
    );
  });

  it('on failure with no attempts configured (a single-attempt/final job): marks FAILED, notifies, does not touch Redis, and re-throws', async () => {
    const sendCommand = jest.fn().mockRejectedValue(new Error('Could not reach Tally'));
    const { processor, prisma, redis, notifications } = makeDeps({ sendCommand });

    await expect(processor.process(job)).rejects.toThrow('Could not reach Tally');

    expect(redis.set).not.toHaveBeenCalled();
    expect(prisma.extractionJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({ status: 'FAILED', error: 'Could not reach Tally' }),
    });
    expect(notifications.sendExtractionComplete).toHaveBeenCalledWith(
      'user@example.com',
      expect.objectContaining({ jobId: 'job-1', status: 'FAILED', error: 'Could not reach Tally' }),
    );
  });

  // job.attemptsMade is 0-indexed and reflects attempts made BEFORE the
  // current call (BullMQ increments it only after this handler returns —
  // see Job.moveToFailed in bullmq's own source). So with attempts: 3, the
  // three real calls the processor ever sees are attemptsMade 0, 1, then 2
  // (the final one) — attemptsMade never reaches 3, since BullMQ doesn't
  // invoke the processor a 4th time once it's given up.
  it('on a non-final retry attempt (2nd of 3): does not mark FAILED or notify, just rethrows so BullMQ retries', async () => {
    const sendCommand = jest.fn().mockRejectedValue(new Error('Tally timeout'));
    const { processor, prisma, notifications, redis } = makeDeps({ sendCommand });
    const retryingJob = { ...job, attemptsMade: 1, opts: { attempts: 3 } };

    await expect(processor.process(retryingJob)).rejects.toThrow('Tally timeout');

    expect(prisma.extractionJob.update).not.toHaveBeenCalled();
    expect(notifications.sendExtractionComplete).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('on the true final attempt (3rd of 3, attemptsMade=2): marks FAILED and notifies, same as a single-attempt job', async () => {
    const sendCommand = jest.fn().mockRejectedValue(new Error('Tally timeout'));
    const { processor, prisma, notifications } = makeDeps({ sendCommand });
    const finalAttemptJob = { ...job, attemptsMade: 2, opts: { attempts: 3 } };

    await expect(processor.process(finalAttemptJob)).rejects.toThrow('Tally timeout');

    expect(prisma.extractionJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({ status: 'FAILED', error: 'Tally timeout' }),
    });
    expect(notifications.sendExtractionComplete).toHaveBeenCalledWith(
      'user@example.com',
      expect.objectContaining({ jobId: 'job-1', status: 'FAILED', error: 'Tally timeout' }),
    );
  });

  it('treats a non-array result (e.g. RAW) as a single record', async () => {
    const sendCommand = jest.fn().mockResolvedValue({ rawXml: '<ENVELOPE/>' });
    const { processor, prisma } = makeDeps({ sendCommand });

    await processor.process(job);

    expect(prisma.extractionJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({ recordCount: 1 }),
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

    it('never looks up history for COMPANIES/GROUPS/VOUCHERS — only LEDGERS/STOCK_ITEMS batch', async () => {
      const sendCommand = jest.fn().mockResolvedValue([]);
      const { processor, prisma } = makeDeps({ sendCommand });
      const groupsJob = { data: { ...job.data, type: 'GROUPS' } } as any;

      await processor.process(groupsJob);

      expect(prisma.extractionJob.findFirst).not.toHaveBeenCalled();
      expect(sendCommand.mock.calls[0][3]).toBeUndefined();
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
      expect(prisma.extractionJob.update).toHaveBeenCalledWith({
        where: { id: 'job-2' },
        data: expect.objectContaining({ status: 'SUCCESS', recordCount: 2 }),
      });
    });

    it('never sends an email notification — there is no notifyEmail on a local-mode job', async () => {
      const { processor, notifications } = makeDeps();

      await processor.process(localJob);

      expect(notifications.sendExtractionComplete).not.toHaveBeenCalled();
    });

    it('on final failure: marks FAILED, does not notify, and re-throws', async () => {
      const getLedgers = jest.fn().mockRejectedValue(new Error('Tally unreachable'));
      const { processor, prisma, notifications } = makeDeps({ getLedgers });

      await expect(processor.process(localJob)).rejects.toThrow('Tally unreachable');

      expect(prisma.extractionJob.update).toHaveBeenCalledWith({
        where: { id: 'job-2' },
        data: expect.objectContaining({ status: 'FAILED', error: 'Tally unreachable' }),
      });
      expect(notifications.sendExtractionComplete).not.toHaveBeenCalled();
    });
  });
});
