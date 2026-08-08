import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const jwt = { sign: jest.fn().mockReturnValue('signed.jwt.token') };

  const makePrisma = (overrides: Partial<Record<'findUnique' | 'create', jest.Mock>> = {}) => ({
    user: {
      findUnique: overrides.findUnique ?? jest.fn().mockResolvedValue(null),
      create: overrides.create ?? jest.fn(),
    },
  });

  beforeEach(() => jwt.sign.mockClear());

  describe('register', () => {
    it('creates a User + Org, hashes the password (never stores it in plaintext), and returns a token', async () => {
      const create = jest.fn().mockImplementation(({ data }) => ({
        id: 'user-1',
        email: data.email,
        name: data.name,
        passwordHash: data.passwordHash,
        orgId: 'org-1',
        org: { id: 'org-1', name: data.org.create.name },
      }));
      const prisma = makePrisma({ create });
      const service = new AuthService(prisma as any, jwt as any);

      const result = await service.register({
        email: 'jaz@mmcconvert.com',
        password: 'correct horse battery staple',
        name: 'Jaz',
        orgName: 'MMC Convert',
      });

      expect(create).toHaveBeenCalledTimes(1);
      const created = create.mock.calls[0][0].data;
      expect(created.passwordHash).not.toBe('correct horse battery staple');
      expect(created.passwordHash).toMatch(/^\$argon2/);

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user).toEqual({
        id: 'user-1',
        email: 'jaz@mmcconvert.com',
        name: 'Jaz',
        orgId: 'org-1',
        orgName: 'MMC Convert',
      });
      expect(jwt.sign).toHaveBeenCalledWith({
        sub: 'user-1',
        email: 'jaz@mmcconvert.com',
        orgId: 'org-1',
      });
    });

    it('rejects a duplicate email without hashing a new password or hitting create', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'existing' });
      const create = jest.fn();
      const prisma = makePrisma({ findUnique, create });
      const service = new AuthService(prisma as any, jwt as any);

      await expect(
        service.register({
          email: 'taken@mmcconvert.com',
          password: 'whatever12345',
          name: 'Someone',
          orgName: 'Someone Inc',
        }),
      ).rejects.toThrow(ConflictException);
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('succeeds with the correct password and returns a token', async () => {
      const argon2 = require('argon2');
      const passwordHash = await argon2.hash('correct horse battery staple');
      const findUnique = jest.fn().mockResolvedValue({
        id: 'user-1',
        email: 'jaz@mmcconvert.com',
        name: 'Jaz',
        passwordHash,
        orgId: 'org-1',
        org: { id: 'org-1', name: 'MMC Convert' },
      });
      const prisma = makePrisma({ findUnique });
      const service = new AuthService(prisma as any, jwt as any);

      const result = await service.login({
        email: 'jaz@mmcconvert.com',
        password: 'correct horse battery staple',
      });

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user.email).toBe('jaz@mmcconvert.com');
    });

    it('rejects a wrong password', async () => {
      const argon2 = require('argon2');
      const passwordHash = await argon2.hash('the-real-password');
      const findUnique = jest.fn().mockResolvedValue({
        id: 'user-1',
        email: 'jaz@mmcconvert.com',
        passwordHash,
        orgId: 'org-1',
        org: { id: 'org-1', name: 'MMC Convert' },
      });
      const prisma = makePrisma({ findUnique });
      const service = new AuthService(prisma as any, jwt as any);

      await expect(
        service.login({ email: 'jaz@mmcconvert.com', password: 'wrong-guess' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a nonexistent user with the same error as a wrong password (no account enumeration)', async () => {
      const findUnique = jest.fn().mockResolvedValue(null);
      const prisma = makePrisma({ findUnique });
      const service = new AuthService(prisma as any, jwt as any);

      await expect(
        service.login({ email: 'nobody@mmcconvert.com', password: 'whatever12345' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
