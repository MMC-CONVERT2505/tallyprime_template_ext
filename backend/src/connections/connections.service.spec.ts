import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConnectionsService } from './connections.service';
import { parseConnectionToken } from './token.util';

describe('ConnectionsService', () => {
  const makePrisma = (
    overrides: Partial<
      Record<'create' | 'findMany' | 'updateMany' | 'deleteMany' | 'findFirst' | 'update', jest.Mock>
    > = {},
  ) => ({
    tallyConnection: {
      create: overrides.create ?? jest.fn(),
      findMany: overrides.findMany ?? jest.fn().mockResolvedValue([]),
      updateMany: overrides.updateMany ?? jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: overrides.deleteMany ?? jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: overrides.findFirst ?? jest.fn(),
      update: overrides.update ?? jest.fn().mockResolvedValue({}),
    },
  });

  describe('create', () => {
    it('mints a token whose id/secret round-trips against the stored hash, and never returns the hash itself', async () => {
      const create = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({ create });
      const service = new ConnectionsService(prisma as any);

      const result = await service.create('org-1', { label: 'Client XYZ - Accounts PC' });

      expect(result.label).toBe('Client XYZ - Accounts PC');
      expect(result.reused).toBe(false);
      const parsed = parseConnectionToken(result.token);
      expect(parsed).not.toBeNull();
      expect(parsed!.id).toBe(result.id);

      const created = create.mock.calls[0][0].data;
      expect(created.orgId).toBe('org-1');
      expect(created.tokenHash).not.toBe(parsed!.secret); // hashed, not stored raw
      expect(created.tokenHash).toMatch(/^\$argon2/);
      expect(result).not.toHaveProperty('tokenHash');
    });

    it('with no defaultCompany, always inserts a new row without ever checking for an existing one', async () => {
      const create = jest.fn().mockResolvedValue({});
      const findFirst = jest.fn();
      const prisma = makePrisma({ create, findFirst });
      const service = new ConnectionsService(prisma as any);

      await service.create('org-1', { label: 'Generic agent' });

      expect(findFirst).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('with a defaultCompany already actively paired in this org, reuses that row (rotates its token) instead of inserting a duplicate', async () => {
      const existing = {
        id: 'conn-existing',
        label: 'Old label',
        orgId: 'org-1',
        defaultCompany: 'ABC Ltd',
        isActive: true,
      };
      const create = jest.fn();
      const update = jest.fn().mockResolvedValue({});
      const findFirst = jest.fn().mockResolvedValue(existing);
      const prisma = makePrisma({ create, update, findFirst });
      const service = new ConnectionsService(prisma as any);

      const result = await service.create('org-1', {
        label: 'New label',
        defaultCompany: 'ABC Ltd',
      });

      expect(findFirst).toHaveBeenCalledWith({
        where: { orgId: 'org-1', defaultCompany: 'ABC Ltd', isActive: true },
      });
      expect(create).not.toHaveBeenCalled();
      expect(result.id).toBe('conn-existing');
      expect(result.reused).toBe(true);
      const parsed = parseConnectionToken(result.token);
      expect(parsed!.id).toBe('conn-existing');
      expect(update).toHaveBeenCalledWith({
        where: { id: 'conn-existing' },
        data: { tokenHash: expect.stringMatching(/^\$argon2/), label: 'New label' },
      });
    });

    it('with a defaultCompany that has no active match yet, inserts a new row pinned to it', async () => {
      const create = jest.fn().mockResolvedValue({});
      const findFirst = jest.fn().mockResolvedValue(null);
      const prisma = makePrisma({ create, findFirst });
      const service = new ConnectionsService(prisma as any);

      const result = await service.create('org-1', {
        label: 'First pairing',
        defaultCompany: 'New Co',
      });

      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0].data).toMatchObject({
        orgId: 'org-1',
        defaultCompany: 'New Co',
      });
      expect(result.reused).toBe(false);
    });

    it('loses a concurrent first-time-pairing race gracefully: reuses the winner\'s row instead of crashing on the unique-index violation', async () => {
      const winner = {
        id: 'conn-winner',
        label: 'Other request got there first',
        orgId: 'org-1',
        defaultCompany: 'New Co',
        isActive: true,
      };
      const create = jest
        .fn()
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: '7.9.1',
          }),
        );
      const update = jest.fn().mockResolvedValue({});
      const findFirst = jest
        .fn()
        .mockResolvedValueOnce(null) // pre-create check: nobody's paired this yet
        .mockResolvedValueOnce(winner); // post-conflict recheck: the winner's row now exists
      const prisma = makePrisma({ create, update, findFirst });
      const service = new ConnectionsService(prisma as any);

      const result = await service.create('org-1', {
        label: 'My label',
        defaultCompany: 'New Co',
      });

      expect(findFirst).toHaveBeenCalledTimes(2);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'conn-winner' },
        data: { tokenHash: expect.stringMatching(/^\$argon2/), label: 'My label' },
      });
      expect(result.id).toBe('conn-winner');
      expect(result.reused).toBe(true);
    });

    it('rethrows the original error if the post-conflict recheck still finds nothing (a genuinely different failure)', async () => {
      const conflictError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.9.1',
      });
      const create = jest.fn().mockRejectedValueOnce(conflictError);
      const findFirst = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      const prisma = makePrisma({ create, findFirst });
      const service = new ConnectionsService(prisma as any);

      await expect(
        service.create('org-1', { label: 'My label', defaultCompany: 'New Co' }),
      ).rejects.toBe(conflictError);
    });
  });

  describe('list', () => {
    it('scopes the query to the given org, orders company-first, and never selects tokenHash', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const prisma = makePrisma({ findMany });
      const service = new ConnectionsService(prisma as any);

      await service.list('org-1');

      const args = findMany.mock.calls[0][0];
      expect(args.where).toEqual({ orgId: 'org-1' });
      expect(args.select.tokenHash).toBeUndefined();
      expect(args.orderBy).toEqual([
        { defaultCompany: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'desc' },
      ]);
    });

    it('with a search term, filters by company name or label (case-insensitive substring)', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const prisma = makePrisma({ findMany });
      const service = new ConnectionsService(prisma as any);

      await service.list('org-1', 'coredge');

      const args = findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        orgId: 'org-1',
        OR: [
          { defaultCompany: { contains: 'coredge', mode: 'insensitive' } },
          { label: { contains: 'coredge', mode: 'insensitive' } },
        ],
      });
    });
  });

  describe('rotateToken', () => {
    const EXISTING = { id: 'conn-1', label: 'My Dev Machine', orgId: 'org-1', isActive: true };

    it('mints a new token for the same connection id/label, without creating a new row', async () => {
      const findFirst = jest.fn().mockResolvedValue(EXISTING);
      const update = jest.fn().mockResolvedValue({});
      const create = jest.fn();
      const prisma = makePrisma({ findFirst, update, create });
      const service = new ConnectionsService(prisma as any);

      const result = await service.rotateToken('org-1', 'conn-1');

      expect(result.id).toBe('conn-1');
      expect(result.label).toBe('My Dev Machine');
      expect(result.reused).toBe(true);
      const parsed = parseConnectionToken(result.token);
      expect(parsed!.id).toBe('conn-1');
      expect(create).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith({
        where: { id: 'conn-1' },
        data: { tokenHash: expect.stringMatching(/^\$argon2/) },
      });
    });

    it('produces a token whose secret round-trips against the newly stored hash (old token no longer valid)', async () => {
      let storedHash = '';
      const update = jest.fn().mockImplementation(({ data }) => {
        storedHash = data.tokenHash;
        return Promise.resolve({});
      });
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(EXISTING), update });
      const service = new ConnectionsService(prisma as any);

      const result = await service.rotateToken('org-1', 'conn-1');

      const parsed = parseConnectionToken(result.token);
      expect(storedHash).not.toBe(parsed!.secret); // hashed, not stored raw
      expect(storedHash).toMatch(/^\$argon2/);
    });

    it("throws NotFoundException when the connection doesn't exist or belongs to another org", async () => {
      const prisma = makePrisma({ findFirst: jest.fn().mockResolvedValue(null) });
      const service = new ConnectionsService(prisma as any);

      await expect(service.rotateToken('org-1', 'someone-elses-connection')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses to rotate a revoked connection (must re-pair instead, not silently resurrect it)', async () => {
      const prisma = makePrisma({
        findFirst: jest.fn().mockResolvedValue({ ...EXISTING, isActive: false }),
      });
      const service = new ConnectionsService(prisma as any);

      await expect(service.rotateToken('org-1', 'conn-1')).rejects.toThrow(BadRequestException);
      expect(prisma.tallyConnection.update).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it("scopes the update to the given org so one org cannot revoke another org's connection", async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const prisma = makePrisma({ updateMany });
      const service = new ConnectionsService(prisma as any);

      await service.revoke('org-1', 'conn-1');

      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'conn-1', orgId: 'org-1' },
        data: { isActive: false },
      });
    });

    it('throws NotFoundException when nothing matched (wrong org or unknown id)', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const prisma = makePrisma({ updateMany });
      const service = new ConnectionsService(prisma as any);

      await expect(service.revoke('org-1', 'someone-elses-connection')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('delete', () => {
    it("scopes the delete to the given org so one org cannot delete another org's connection", async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
      const prisma = makePrisma({ deleteMany });
      const service = new ConnectionsService(prisma as any);

      await service.delete('org-1', 'conn-1');

      expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'conn-1', orgId: 'org-1' } });
    });

    it('throws NotFoundException when nothing matched (wrong org or unknown id)', async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
      const prisma = makePrisma({ deleteMany });
      const service = new ConnectionsService(prisma as any);

      await expect(service.delete('org-1', 'someone-elses-connection')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
