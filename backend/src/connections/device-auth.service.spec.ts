import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DeviceAuthService } from './device-auth.service';
import { parseConnectionToken } from './token.util';

describe('DeviceAuthService', () => {
  function makePrisma(
    overrides: Partial<
      Record<'create' | 'findFirst' | 'findUnique' | 'update' | '$transaction', jest.Mock>
    > = {},
  ) {
    return {
      deviceAuthorization: {
        create: overrides.create ?? jest.fn().mockResolvedValue({}),
        findFirst: overrides.findFirst ?? jest.fn().mockResolvedValue(null),
        findUnique: overrides.findUnique ?? jest.fn().mockResolvedValue(null),
        update: overrides.update ?? jest.fn().mockResolvedValue({}),
      },
      tallyConnection: {
        create: jest.fn(),
      },
      $transaction: overrides.$transaction ?? jest.fn().mockResolvedValue([]),
    };
  }

  describe('start', () => {
    it('creates a PENDING row with a device code, a human-typeable user code, and a poll interval', async () => {
      const create = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ create });
      const service = new DeviceAuthService(prisma as any);

      const result = await service.start();

      expect(result.deviceCode).toHaveLength(64); // 32 bytes hex-encoded
      expect(result.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(result.expiresIn).toBeGreaterThan(0);
      expect(result.interval).toBeGreaterThan(0);

      const created = create.mock.calls[0][0].data;
      expect(created.deviceCode).toBe(result.deviceCode);
      expect(created.userCode).toBe(result.userCode);
    });

    it('retries user-code generation on a rare collision with another still-pending code', async () => {
      const findFirst = jest
        .fn()
        .mockResolvedValueOnce({ id: 'taken' })
        .mockResolvedValueOnce(null);
      const prisma = makePrisma({ findFirst });
      const service = new DeviceAuthService(prisma as any);

      const result = await service.start();

      expect(findFirst).toHaveBeenCalledTimes(2);
      expect(result.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    });
  });

  describe('approve', () => {
    const PENDING_ROW = {
      id: 'da-1',
      userCode: 'ABCD-1234',
      expiresAt: new Date(Date.now() + 60_000),
    };

    it('marks a pending, unexpired row APPROVED, scoped to the approving org', async () => {
      const findFirst = jest.fn().mockResolvedValue(PENDING_ROW);
      const update = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ findFirst, update });
      const service = new DeviceAuthService(prisma as any);

      await service.approve('org-1', {
        userCode: 'ABCD-1234',
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
      });

      expect(update).toHaveBeenCalledWith({
        where: { id: 'da-1' },
        data: {
          status: 'APPROVED',
          orgId: 'org-1',
          label: 'Accounts PC',
          defaultCompany: 'ABC Ltd',
        },
      });
    });

    it('404s when no pending request has that user code', async () => {
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(null) });
      const service = new DeviceAuthService(prisma as any);

      await expect(service.approve('org-1', { userCode: 'NOPE-0000' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects and marks EXPIRED an approval attempt past expiresAt', async () => {
      const expired = { ...PENDING_ROW, expiresAt: new Date(Date.now() - 1000) };
      const update = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(expired), update });
      const service = new DeviceAuthService(prisma as any);

      await expect(service.approve('org-1', { userCode: 'ABCD-1234' })).rejects.toThrow(
        BadRequestException,
      );
      expect(update).toHaveBeenCalledWith({ where: { id: 'da-1' }, data: { status: 'EXPIRED' } });
    });
  });

  describe('poll', () => {
    it('returns { status: "pending" } while awaiting approval, without minting anything', async () => {
      const row = {
        id: 'da-1',
        deviceCode: 'x'.repeat(64),
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 60_000),
      };
      const prisma = makePrisma({ findUnique: jest.fn().mockResolvedValue(row) });
      const service = new DeviceAuthService(prisma as any);

      const result = await service.poll(row.deviceCode);

      expect(result).toEqual({ status: 'pending' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('mints a real connection and consumes the row exactly once when APPROVED', async () => {
      const row = {
        id: 'da-1',
        deviceCode: 'x'.repeat(64),
        status: 'APPROVED',
        expiresAt: new Date(Date.now() + 60_000),
        orgId: 'org-1',
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
      };
      const transaction = jest.fn().mockResolvedValue([{}, {}]);
      const prisma = makePrisma({
        findUnique: jest.fn().mockResolvedValue(row),
        $transaction: transaction,
      });
      const service = new DeviceAuthService(prisma as any);

      const result = await service.poll(row.deviceCode);

      expect(result.status).toBe('approved');
      if (result.status !== 'approved') throw new Error('unreachable');
      expect(result.label).toBe('Accounts PC');
      const parsed = parseConnectionToken(result.token);
      expect(parsed!.id).toBe(result.id);
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('404s on an unknown device code', async () => {
      const prisma = makePrisma({ findUnique: jest.fn().mockResolvedValue(null) });
      const service = new DeviceAuthService(prisma as any);

      await expect(service.poll('unknown')).rejects.toThrow(NotFoundException);
    });

    it('rejects polling an already-consumed code (cannot mint twice)', async () => {
      const row = {
        id: 'da-1',
        deviceCode: 'x'.repeat(64),
        status: 'CONSUMED',
        expiresAt: new Date(Date.now() + 60_000),
      };
      const prisma = makePrisma({ findUnique: jest.fn().mockResolvedValue(row) });
      const service = new DeviceAuthService(prisma as any);

      await expect(service.poll(row.deviceCode)).rejects.toThrow(BadRequestException);
    });

    it('rejects and marks EXPIRED a poll past expiresAt', async () => {
      const row = {
        id: 'da-1',
        deviceCode: 'x'.repeat(64),
        status: 'PENDING',
        expiresAt: new Date(Date.now() - 1000),
      };
      const update = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ findUnique: jest.fn().mockResolvedValue(row), update });
      const service = new DeviceAuthService(prisma as any);

      await expect(service.poll(row.deviceCode)).rejects.toThrow(BadRequestException);
      expect(update).toHaveBeenCalledWith({ where: { id: 'da-1' }, data: { status: 'EXPIRED' } });
    });
  });
});
