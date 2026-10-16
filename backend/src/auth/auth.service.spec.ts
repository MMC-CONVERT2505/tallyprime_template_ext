import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const jwt = { sign: jest.fn().mockReturnValue('signed.jwt.token') };
  const notifications = { sendPasswordResetOtp: jest.fn().mockResolvedValue(undefined) };

  const makeConfig = (env: string = 'development') => ({
    get: jest.fn((key: string) => (key === 'env' ? env : undefined)),
  });

  const makePrisma = (
    overrides: Partial<{
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      otpUpsert: jest.Mock;
      otpFindUnique: jest.Mock;
      otpUpdate: jest.Mock;
      otpDeleteMany: jest.Mock;
      transaction: jest.Mock;
    }> = {},
  ) => ({
    user: {
      findUnique: overrides.findUnique ?? jest.fn().mockResolvedValue(null),
      create: overrides.create ?? jest.fn(),
      update: overrides.update ?? jest.fn(),
    },
    passwordResetOtp: {
      upsert: overrides.otpUpsert ?? jest.fn().mockImplementation(({ create }) => create),
      findUnique: overrides.otpFindUnique ?? jest.fn().mockResolvedValue(null),
      update: overrides.otpUpdate ?? jest.fn(),
      deleteMany: overrides.otpDeleteMany ?? jest.fn(),
    },
    $transaction: overrides.transaction ?? jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  });

  const makeService = (prisma: ReturnType<typeof makePrisma>, config = makeConfig()) =>
    new AuthService(prisma as any, jwt as any, config as any, notifications as any);

  beforeEach(() => {
    jwt.sign.mockClear();
    notifications.sendPasswordResetOtp.mockClear();
  });

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
      const service = makeService(prisma);

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
      const service = makeService(prisma);

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
      const service = makeService(prisma);

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
      const service = makeService(prisma);

      await expect(
        service.login({ email: 'jaz@mmcconvert.com', password: 'wrong-guess' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a nonexistent user with the same error as a wrong password (no account enumeration)', async () => {
      const findUnique = jest.fn().mockResolvedValue(null);
      const prisma = makePrisma({ findUnique });
      const service = makeService(prisma);

      await expect(
        service.login({ email: 'nobody@mmcconvert.com', password: 'whatever12345' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('requestPasswordReset', () => {
    it('outside production, always issues the fixed dev OTP (0000) — the whole point is a locally-testable flow with no SMTP/log-reading needed', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', email: 'jaz@mmcconvert.com' });
      const otpUpsert = jest.fn().mockImplementation(({ create }) => create);
      const prisma = makePrisma({ findUnique, otpUpsert });
      const service = makeService(prisma, makeConfig('development'));

      await service.requestPasswordReset('jaz@mmcconvert.com');

      expect(otpUpsert).toHaveBeenCalledTimes(1);
      const [{ where, create, update }] = otpUpsert.mock.calls[0];
      expect(where).toEqual({ userId: 'user-1' });
      expect(create.userId).toBe('user-1');
      // Stored in plaintext (explicit choice — see PasswordResetOtp's doc
      // comment), not hashed like passwords/connection tokens elsewhere.
      expect(create.otp).toBe('0000');
      expect(create.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(update.attempts).toBe(0);

      expect(notifications.sendPasswordResetOtp).toHaveBeenCalledWith('jaz@mmcconvert.com', '0000');
    });

    it('in production, issues a real random 4-digit OTP, never the fixed dev one', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', email: 'jaz@mmcconvert.com' });
      const otpUpsert = jest.fn().mockImplementation(({ create }) => create);
      const prisma = makePrisma({ findUnique, otpUpsert });
      const service = makeService(prisma, makeConfig('production'));

      await service.requestPasswordReset('jaz@mmcconvert.com');

      const [, otp] = notifications.sendPasswordResetOtp.mock.calls[0];
      expect(otp).toMatch(/^\d{4}$/);
      expect(otp).not.toBe('0000'); // astronomically unlikely to collide; if this ever flakes, generateOtp broke
    });

    it('resolves silently for an unknown email — never reveals whether the account exists', async () => {
      const findUnique = jest.fn().mockResolvedValue(null);
      const prisma = makePrisma({ findUnique });
      const service = makeService(prisma);

      await expect(service.requestPasswordReset('nobody@mmcconvert.com')).resolves.toBeUndefined();
      expect(notifications.sendPasswordResetOtp).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword — in production, the OTP row is verified for real', () => {
    // makeConfig('production') throughout — outside production this whole
    // check is skipped (see the next describe block), so these tests must
    // force the production branch to actually exercise it.

    it('updates the password and clears the OTP row on success', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', email: 'jaz@mmcconvert.com' });
      const otpFindUnique = jest.fn().mockResolvedValue({
        userId: 'user-1',
        otp: '1234',
        attempts: 0,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const update = jest.fn();
      const otpDeleteMany = jest.fn();
      const transaction = jest.fn((ops: Promise<unknown>[]) => Promise.all(ops));
      const prisma = makePrisma({ findUnique, otpFindUnique, update, otpDeleteMany, transaction });
      const service = makeService(prisma, makeConfig('production'));

      await service.resetPassword('jaz@mmcconvert.com', '1234', 'new-strong-password');

      expect(otpFindUnique).toHaveBeenCalled();
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          data: expect.objectContaining({ passwordHash: expect.stringMatching(/^\$argon2/) }),
        }),
      );
      expect(otpDeleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    });

    it('rejects an unknown email with the same generic error, before ever looking up an OTP', async () => {
      const findUnique = jest.fn().mockResolvedValue(null);
      const otpFindUnique = jest.fn();
      const prisma = makePrisma({ findUnique, otpFindUnique });
      const service = makeService(prisma, makeConfig('production'));

      await expect(service.resetPassword('nobody@mmcconvert.com', '1234', 'whatever123')).rejects.toThrow(
        BadRequestException,
      );
      expect(otpFindUnique).not.toHaveBeenCalled();
    });

    it('rejects when no OTP is outstanding for the user', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', email: 'jaz@mmcconvert.com' });
      const otpFindUnique = jest.fn().mockResolvedValue(null);
      const prisma = makePrisma({ findUnique, otpFindUnique });
      const service = makeService(prisma, makeConfig('production'));

      await expect(
        service.resetPassword('jaz@mmcconvert.com', '1234', 'whatever123'),
      ).rejects.toThrow(/invalid or expired/i);
    });

    it('rejects an expired OTP', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', email: 'jaz@mmcconvert.com' });
      const otpFindUnique = jest.fn().mockResolvedValue({
        userId: 'user-1',
        otp: '1234',
        attempts: 0,
        expiresAt: new Date(Date.now() - 1000), // already expired
      });
      const prisma = makePrisma({ findUnique, otpFindUnique });
      const service = makeService(prisma, makeConfig('production'));

      await expect(service.resetPassword('jaz@mmcconvert.com', '1234', 'whatever123')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a wrong code and records the attempt', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', email: 'jaz@mmcconvert.com' });
      const otpFindUnique = jest.fn().mockResolvedValue({
        userId: 'user-1',
        otp: '1234',
        attempts: 0,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const otpUpdate = jest.fn();
      const prisma = makePrisma({ findUnique, otpFindUnique, otpUpdate });
      const service = makeService(prisma, makeConfig('production'));

      await expect(service.resetPassword('jaz@mmcconvert.com', '9999', 'whatever123')).rejects.toThrow(
        BadRequestException,
      );
      expect(otpUpdate).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: { attempts: { increment: 1 } },
      });
    });

    it('rejects once the attempt budget is exhausted, even with the correct code', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', email: 'jaz@mmcconvert.com' });
      const otpFindUnique = jest.fn().mockResolvedValue({
        userId: 'user-1',
        otp: '1234',
        attempts: 5, // == RESET_OTP_MAX_ATTEMPTS
        expiresAt: new Date(Date.now() + 60_000),
      });
      const prisma = makePrisma({ findUnique, otpFindUnique });
      const service = makeService(prisma, makeConfig('production'));

      await expect(service.resetPassword('jaz@mmcconvert.com', '1234', 'whatever123')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('resetPassword — outside production, OTP verification is skipped entirely (2026-09-23)', () => {
    it('resets the password with NO OTP row needed at all — request-password-reset never has to be called first', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', email: 'jaz@mmcconvert.com' });
      const otpFindUnique = jest.fn().mockResolvedValue(null); // no row exists
      const update = jest.fn();
      const otpDeleteMany = jest.fn();
      const transaction = jest.fn((ops: Promise<unknown>[]) => Promise.all(ops));
      const prisma = makePrisma({ findUnique, otpFindUnique, update, otpDeleteMany, transaction });
      const service = makeService(prisma, makeConfig('development'));

      await service.resetPassword('jaz@mmcconvert.com', '0000', 'brand-new-password');

      expect(otpFindUnique).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ passwordHash: expect.any(String) }) }),
      );
      // Best-effort cleanup of any real row that happened to exist too —
      // deleteMany (not delete) specifically so "no row to begin with" here
      // doesn't throw.
      expect(otpDeleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    });

    it('accepts ANY 4-digit code, not just "0000" — outside production the value is never inspected at all', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', email: 'jaz@mmcconvert.com' });
      const otpFindUnique = jest.fn();
      const prisma = makePrisma({ findUnique, otpFindUnique });
      const service = makeService(prisma, makeConfig('development'));

      await expect(
        service.resetPassword('jaz@mmcconvert.com', '7777', 'brand-new-password'),
      ).resolves.toBeUndefined();
      expect(otpFindUnique).not.toHaveBeenCalled();
    });

    it('also bypasses an expired/attempts-exhausted row — the whole row is irrelevant outside production', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', email: 'jaz@mmcconvert.com' });
      const otpFindUnique = jest.fn().mockResolvedValue({
        userId: 'user-1',
        otp: '1234',
        attempts: 5,
        expiresAt: new Date(Date.now() - 1000),
      });
      const prisma = makePrisma({ findUnique, otpFindUnique });
      const service = makeService(prisma, makeConfig('development'));

      await expect(
        service.resetPassword('jaz@mmcconvert.com', '0000', 'brand-new-password'),
      ).resolves.toBeUndefined();
    });

    it('still requires a real, existing email — this skips OTP verification, not authentication of who owns the account', async () => {
      const findUnique = jest.fn().mockResolvedValue(null);
      const prisma = makePrisma({ findUnique });
      const service = makeService(prisma, makeConfig('development'));

      await expect(
        service.resetPassword('nobody@mmcconvert.com', '0000', 'brand-new-password'),
      ).rejects.toThrow(BadRequestException);
    });

    it('in production, the code IS verified for real — "0000" has no special meaning there', async () => {
      const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', email: 'jaz@mmcconvert.com' });
      const otpFindUnique = jest.fn().mockResolvedValue(null); // no row exists
      const prisma = makePrisma({ findUnique, otpFindUnique });
      const service = makeService(prisma, makeConfig('production'));

      await expect(
        service.resetPassword('jaz@mmcconvert.com', '0000', 'brand-new-password'),
      ).rejects.toThrow(BadRequestException);
      expect(otpFindUnique).toHaveBeenCalled();
    });
  });
});
