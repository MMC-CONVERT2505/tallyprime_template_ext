import { ExtractionsProcessor } from './extractions.processor';

describe('ExtractionsProcessor', () => {
  function makeDeps(overrides: { sendCommand?: jest.Mock; getLedgers?: jest.Mock } = {}) {
    const prisma = { extractionJob: { update: jest.fn().mockResolvedValue({}) } };
    const tunnel = {
      sendCommand:
        overrides.sendCommand ?? jest.fn().mockResolvedValue([{ name: 'Cash' }, { name: 'Sales' }]),
    };
    const redis = { set: jest.fn().mockResolvedValue('OK') };
    const notifications = { sendExtractionComplete: jest.fn().mockResolvedValue(undefined) };
    const config = { getOrThrow: jest.fn().mockReturnValue({ resultTtlSeconds: 3600 }) };
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

      expect(masters.getLedgers).toHaveBeenCalledWith('ABC Ltd', undefined, undefined);
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
