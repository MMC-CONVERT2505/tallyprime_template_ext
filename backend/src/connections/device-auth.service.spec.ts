import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DeviceAuthService } from './device-auth.service';

describe('DeviceAuthService', () => {
  function makePrisma(
    overrides: Partial<
      Record<'create' | 'findFirst' | 'findUnique' | 'update' | 'updateMany', jest.Mock>
    > = {},
  ) {
    return {
      deviceAuthorization: {
        create: overrides.create ?? jest.fn().mockResolvedValue({}),
        findFirst: overrides.findFirst ?? jest.fn().mockResolvedValue(null),
        findUnique: overrides.findUnique ?? jest.fn().mockResolvedValue(null),
        update: overrides.update ?? jest.fn().mockResolvedValue({}),
        updateMany: overrides.updateMany ?? jest.fn().mockResolvedValue({ count: 0 }),
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
    it('claims a pending, unexpired row atomically via updateMany, scoped to the approving org', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const prisma = makePrisma({ updateMany });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      const result = await service.approve('org-1', {
        userCode: 'ABCD-1234',
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
      });

      expect(updateMany).toHaveBeenCalledWith({
        where: { userCode: 'ABCD-1234', status: 'PENDING', expiresAt: { gt: expect.any(Date) } },
        data: {
          status: 'APPROVED',
          orgId: 'org-1',
          label: 'Accounts PC',
          defaultCompany: 'ABC Ltd',
        },
      });
      expect(result).toEqual({ approved: true, alreadyApproved: false });
    });

    it('404s when no request at all has that user code', async () => {
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(null) });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      await expect(service.approve('org-1', { userCode: 'NOPE-0000' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects and marks EXPIRED an approval attempt past expiresAt', async () => {
      const expired = {
        id: 'da-1',
        userCode: 'ABCD-1234',
        status: 'PENDING',
        expiresAt: new Date(Date.now() - 1000),
      };
      const update = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(expired), update });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      await expect(service.approve('org-1', { userCode: 'ABCD-1234' })).rejects.toThrow(
        BadRequestException,
      );
      expect(update).toHaveBeenCalledWith({ where: { id: 'da-1' }, data: { status: 'EXPIRED' } });
    });

    it('rejects an approval attempt for a row already marked EXPIRED, without touching it again', async () => {
      const row = { id: 'da-1', userCode: 'ABCD-1234', status: 'EXPIRED', expiresAt: new Date(Date.now() - 1000) };
      const update = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(row), update });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      await expect(service.approve('org-1', { userCode: 'ABCD-1234' })).rejects.toThrow(
        BadRequestException,
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('returns alreadyApproved: true, without throwing, when the same org re-approves an already-approved code', async () => {
      const row = {
        id: 'da-1',
        userCode: 'ABCD-1234',
        status: 'APPROVED',
        orgId: 'org-1',
        expiresAt: new Date(Date.now() + 60_000),
      };
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(row) });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      const result = await service.approve('org-1', { userCode: 'ABCD-1234' });

      expect(result).toEqual({ approved: true, alreadyApproved: true });
    });

    it('409s when a different org tries to approve a code already approved by another org', async () => {
      const row = {
        id: 'da-1',
        userCode: 'ABCD-1234',
        status: 'APPROVED',
        orgId: 'org-OTHER',
        expiresAt: new Date(Date.now() + 60_000),
      };
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(row) });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      await expect(service.approve('org-1', { userCode: 'ABCD-1234' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('409s when the code has already been consumed', async () => {
      const row = {
        id: 'da-1',
        userCode: 'ABCD-1234',
        status: 'CONSUMED',
        orgId: 'org-1',
        expiresAt: new Date(Date.now() + 60_000),
      };
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(row) });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      await expect(service.approve('org-1', { userCode: 'ABCD-1234' })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('status', () => {
    it('404s on an unknown user code', async () => {
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(null) });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      await expect(service.status('org-1', 'NOPE-0000')).rejects.toThrow(NotFoundException);
    });

    it('reports pending with time remaining', async () => {
      const row = {
        id: 'da-1',
        userCode: 'ABCD-1234',
        status: 'PENDING',
        orgId: null,
        expiresAt: new Date(Date.now() + 60_000),
      };
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(row) });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      const result = await service.status('org-1', 'ABCD-1234');

      expect(result.status).toBe('pending');
      if (result.status !== 'pending') throw new Error('unreachable');
      expect(result.expiresInSeconds).toBeGreaterThan(0);
    });

    it('lazily marks a stale PENDING row EXPIRED and reports expired', async () => {
      const row = {
        id: 'da-1',
        userCode: 'ABCD-1234',
        status: 'PENDING',
        orgId: null,
        expiresAt: new Date(Date.now() - 1000),
      };
      const update = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(row), update });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      const result = await service.status('org-1', 'ABCD-1234');

      expect(result).toEqual({ status: 'expired', userCode: 'ABCD-1234' });
      expect(update).toHaveBeenCalledWith({ where: { id: 'da-1' }, data: { status: 'EXPIRED' } });
    });

    it('includes label/company for an APPROVED row when the requester is the owning org', async () => {
      const row = {
        id: 'da-1',
        userCode: 'ABCD-1234',
        status: 'APPROVED',
        orgId: 'org-1',
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
        expiresAt: new Date(Date.now() + 60_000),
      };
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(row) });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      const result = await service.status('org-1', 'ABCD-1234');

      expect(result).toEqual({
        status: 'approved',
        userCode: 'ABCD-1234',
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
      });
    });

    it('omits label/company for an APPROVED row owned by a different org', async () => {
      const row = {
        id: 'da-1',
        userCode: 'ABCD-1234',
        status: 'APPROVED',
        orgId: 'org-OTHER',
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
        expiresAt: new Date(Date.now() + 60_000),
      };
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(row) });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      const result = await service.status('org-1', 'ABCD-1234');

      expect(result).toEqual({ status: 'approved', userCode: 'ABCD-1234' });
    });

    it('includes connectionId for a CONSUMED row when the requester is the owning org', async () => {
      const row = {
        id: 'da-1',
        userCode: 'ABCD-1234',
        status: 'CONSUMED',
        orgId: 'org-1',
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
        connectionId: 'conn-1',
        expiresAt: new Date(Date.now() + 60_000),
      };
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(row) });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      const result = await service.status('org-1', 'ABCD-1234');

      expect(result).toEqual({
        status: 'consumed',
        userCode: 'ABCD-1234',
        connectionId: 'conn-1',
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
      });
    });

    it('omits connection details for a CONSUMED row owned by a different org', async () => {
      const row = {
        id: 'da-1',
        userCode: 'ABCD-1234',
        status: 'CONSUMED',
        orgId: 'org-OTHER',
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
        connectionId: 'conn-1',
        expiresAt: new Date(Date.now() + 60_000),
      };
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(row) });
      const service = new DeviceAuthService(prisma as any, makeConnections() as any);

      const result = await service.status('org-1', 'ABCD-1234');

      expect(result).toEqual({ status: 'consumed', userCode: 'ABCD-1234' });
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
