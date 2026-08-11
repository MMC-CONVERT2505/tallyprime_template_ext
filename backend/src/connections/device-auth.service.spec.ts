import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DeviceAuthService } from './device-auth.service';

describe('DeviceAuthService', () => {
  function makePrisma(
    overrides: Partial<Record<'create' | 'findFirst' | 'findUnique' | 'update', jest.Mock>> = {},
  ) {
    return {
      deviceAuthorization: {
        create: overrides.create ?? jest.fn().mockResolvedValue({}),
        findFirst: overrides.findFirst ?? jest.fn().mockResolvedValue(null),
        findUnique: overrides.findUnique ?? jest.fn().mockResolvedValue(null),
        update: overrides.update ?? jest.fn().mockResolvedValue({}),
      },
    };
  }

  /** Stands in for ConnectionsService — poll() only ever calls upsertForCompany on it. */
  function makeConnections(upsertForCompany?: jest.Mock) {
    return {
      upsertForCompany:
        upsertForCompany ??
        jest.fn().mockResolvedValue({
          id: 'conn-1',
          label: 'Accounts PC',
          token: 'conn-1.secret',
          reused: false,
        }),
    };
  }

  describe('start', () => {
    it('creates a PENDING row with a device code, a human-typeable user code, and a poll interval', async () => {
      const create = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ create });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

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
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

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
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

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
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      await expect(service.approve('org-1', { userCode: 'NOPE-0000' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects and marks EXPIRED an approval attempt past expiresAt', async () => {
      const expired = { ...PENDING_ROW, expiresAt: new Date(Date.now() - 1000) };
      const update = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(expired), update });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

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
      const upsertForCompany = jest.fn();
      const service = new DeviceAuthService(
        prisma as any,
        makeConnections(upsertForCompany) as any,
      );

      const result = await service.poll(row.deviceCode);

      expect(result).toEqual({ status: 'pending' });
      expect(upsertForCompany).not.toHaveBeenCalled();
    });

    it('mints (or reuses) a connection via ConnectionsService and consumes the row exactly once when APPROVED', async () => {
      const row = {
        id: 'da-1',
        deviceCode: 'x'.repeat(64),
        status: 'APPROVED',
        expiresAt: new Date(Date.now() + 60_000),
        orgId: 'org-1',
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
      };
      const upsertForCompany = jest.fn().mockResolvedValue({
        id: 'conn-1',
        label: 'Accounts PC',
        token: 'conn-1.deadbeef',
        reused: false,
      });
      const update = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ findUnique: jest.fn().mockResolvedValue(row), update });
      const service = new DeviceAuthService(
        prisma as any,
        makeConnections(upsertForCompany) as any,
      );

      const result = await service.poll(row.deviceCode);

      expect(upsertForCompany).toHaveBeenCalledWith('org-1', 'Accounts PC', 'ABC Ltd');
      expect(result.status).toBe('approved');
      if (result.status !== 'approved') throw new Error('unreachable');
      expect(result.id).toBe('conn-1');
      expect(result.label).toBe('Accounts PC');
      expect(result.token).toBe('conn-1.deadbeef');
      expect(result.reused).toBe(false);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'da-1' },
        data: { status: 'CONSUMED', connectionId: 'conn-1' },
      });
    });

    it('surfaces reused: true from ConnectionsService when this poll rotated an existing company pairing instead of creating one', async () => {
      const row = {
        id: 'da-1',
        deviceCode: 'x'.repeat(64),
        status: 'APPROVED',
        expiresAt: new Date(Date.now() + 60_000),
        orgId: 'org-1',
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
      };
      const upsertForCompany = jest.fn().mockResolvedValue({
        id: 'conn-existing',
        label: 'Accounts PC',
        token: 'conn-existing.deadbeef',
        reused: true,
      });
      const prisma = makePrisma({ findUnique: jest.fn().mockResolvedValue(row) });
      const service = new DeviceAuthService(
        prisma as any,
        makeConnections(upsertForCompany) as any,
      );

      const result = await service.poll(row.deviceCode);

      if (result.status !== 'approved') throw new Error('unreachable');
      expect(result.id).toBe('conn-existing');
      expect(result.reused).toBe(true);
    });

    it('404s on an unknown device code', async () => {
      const prisma = makePrisma({ findUnique: jest.fn().mockResolvedValue(null) });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

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
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

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
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      await expect(service.poll(row.deviceCode)).rejects.toThrow(BadRequestException);
      expect(update).toHaveBeenCalledWith({ where: { id: 'da-1' }, data: { status: 'EXPIRED' } });
    });
  });
});
