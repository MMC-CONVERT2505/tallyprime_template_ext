import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TallyJobsService } from './tally-jobs.service';

describe('TallyJobsService', () => {
  function makeService(overrides: { findUnique?: jest.Mock; redisGet?: jest.Mock } = {}) {
    const prisma = {
      extractionJob: {
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'job-1', status: 'PENDING', ...data })),
        findUnique: overrides.findUnique ?? jest.fn(),
      },
    };
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const redis = { get: overrides.redisGet ?? jest.fn() };

    const service = new TallyJobsService(prisma as any, queue as any, redis as any);
    return { service, prisma, queue, redis };
  }

  describe('create', () => {
    it('creates a PENDING job with no orgId/connectionId and enqueues it in local mode', async () => {
      const { service, prisma, queue } = makeService();

      const result = await service.create({ type: 'LEDGERS' as any, payload: { company: 'ABC Ltd' } });

      expect(result).toEqual({ id: 'job-1', status: 'PENDING' });
      const created = prisma.extractionJob.create.mock.calls[0][0].data;
      expect(created).toMatchObject({ type: 'LEDGERS', status: 'PENDING', company: 'ABC Ltd' });
      expect(created).not.toHaveProperty('orgId');
      expect(created).not.toHaveProperty('connectionId');

      expect(queue.add).toHaveBeenCalledWith('extract', {
        mode: 'local',
        extractionJobId: 'job-1',
        type: 'LEDGERS',
        payload: { company: 'ABC Ltd' },
      });
    });

    it('defaults to an empty payload and null company when none is given', async () => {
      const { service, prisma, queue } = makeService();

      await service.create({ type: 'COMPANIES' as any });

      expect(prisma.extractionJob.create.mock.calls[0][0].data.company).toBeNull();
      expect(queue.add).toHaveBeenCalledWith('extract', {
        mode: 'local',
        extractionJobId: 'job-1',
        type: 'COMPANIES',
        payload: {},
      });
    });
  });

  describe('getStatus', () => {
    it('looks up by id alone (no org scoping) and 404s when missing', async () => {
      const findUnique = jest.fn().mockResolvedValue(null);
      const { service } = makeService({ findUnique });

      await expect(service.getStatus('job-1')).rejects.toThrow(NotFoundException);
      expect(findUnique).toHaveBeenCalledWith({ where: { id: 'job-1' } });
    });

    it('returns the job row when found', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'job-1', status: 'SUCCESS' });
      const { service } = makeService({ findUnique });

      await expect(service.getStatus('job-1')).resolves.toEqual({ id: 'job-1', status: 'SUCCESS' });
    });
  });

  describe('getResult', () => {
    it('rejects while the job is still PENDING', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'job-1', status: 'PENDING' });
      const { service } = makeService({ findUnique });

      await expect(service.getResult('job-1')).rejects.toThrow('has not finished');
    });

    it('surfaces the stored error message for a FAILED job', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'job-1', status: 'FAILED', error: 'Tally unreachable' });
      const { service } = makeService({ findUnique });

      await expect(service.getResult('job-1')).rejects.toThrow('Tally unreachable');
    });

    it('returns the parsed result for a SUCCESS job still within TTL', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'job-1', status: 'SUCCESS' });
      const redisGet = jest.fn().mockResolvedValue(JSON.stringify([{ name: 'Cash' }]));
      const { service } = makeService({ findUnique, redisGet });

      await expect(service.getResult('job-1')).resolves.toEqual([{ name: 'Cash' }]);
    });

    it('404s when the result has expired out of Redis', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'job-1', status: 'SUCCESS' });
      const redisGet = jest.fn().mockResolvedValue(null);
      const { service } = makeService({ findUnique, redisGet });

      await expect(service.getResult('job-1')).rejects.toThrow(NotFoundException);
    });

    it('rejects a FAILED job with a fallback message when none was stored', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'job-1', status: 'FAILED', error: null });
      const { service } = makeService({ findUnique });

      await expect(service.getResult('job-1')).rejects.toThrow(BadRequestException);
    });
  });
});
