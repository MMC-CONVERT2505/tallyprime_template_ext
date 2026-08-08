import { ExtractionsProcessor } from './extractions.processor';

describe('ExtractionsProcessor', () => {
  function makeDeps(overrides: { sendCommand?: jest.Mock } = {}) {
    const prisma = { extractionJob: { update: jest.fn().mockResolvedValue({}) } };
    const tunnel = {
      sendCommand:
        overrides.sendCommand ?? jest.fn().mockResolvedValue([{ name: 'Cash' }, { name: 'Sales' }]),
    };
    const redis = { set: jest.fn().mockResolvedValue('OK') };
    const notifications = { sendExtractionComplete: jest.fn().mockResolvedValue(undefined) };
    const config = { getOrThrow: jest.fn().mockReturnValue({ resultTtlSeconds: 3600 }) };

    const processor = new ExtractionsProcessor(
      prisma as any,
      tunnel as any,
      redis as any,
      notifications as any,
      config as any,
    );
    return { processor, prisma, tunnel, redis, notifications };
  }

  const job = {
    data: {
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

  it('on a non-final retry attempt: does not mark FAILED or notify, just rethrows so BullMQ retries', async () => {
    const sendCommand = jest.fn().mockRejectedValue(new Error('Tally timeout'));
    const { processor, prisma, notifications, redis } = makeDeps({ sendCommand });
    const retryingJob = { ...job, attemptsMade: 1, opts: { attempts: 3 } };

    await expect(processor.process(retryingJob)).rejects.toThrow('Tally timeout');

    expect(prisma.extractionJob.update).not.toHaveBeenCalled();
    expect(notifications.sendExtractionComplete).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('on the final configured attempt: marks FAILED and notifies, same as a single-attempt job', async () => {
    const sendCommand = jest.fn().mockRejectedValue(new Error('Tally timeout'));
    const { processor, prisma, notifications } = makeDeps({ sendCommand });
    const finalAttemptJob = { ...job, attemptsMade: 3, opts: { attempts: 3 } };

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
});
