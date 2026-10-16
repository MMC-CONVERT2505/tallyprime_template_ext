import { randomInt } from 'crypto';
import { BadRequestException, ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

export interface AuthResult {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    orgId: string;
    orgName: string;
  };
}

export interface JwtPayload {
  sub: string;
  email: string;
  orgId: string;
}

/** OTPs are short-lived by nature (10 min, not the hour a link got) — a
 *  4-digit code is meant to be typed in immediately after checking email,
 *  not saved for later. */
const RESET_OTP_TTL_MS = 10 * 60 * 1000;

/** Caps brute-forcing a 4-digit code (10,000 possibilities) — once exhausted
 *  the OTP is dead even if the real code is still technically unexpired;
 *  the user just requests a fresh one. */
const RESET_OTP_MAX_ATTEMPTS = 5;

/** Every environment except production gets this fixed code instead of a
 *  random one — the whole point is to make the reset flow testable without
 *  needing to read the server console or configure real SMTP locally. Gated
 *  on NODE_ENV specifically (not e.g. "is SMTP configured") so a dev/staging
 *  box with real SMTP wired up still gets the fixed code, and there is no
 *  code path in production that could ever produce it. */
const DEV_FIXED_OTP = '0000';

/**
 * Email/password auth, self-hosted (no external identity provider) — matches
 * this project's pattern of owning its core stack rather than reaching for a
 * third-party SDK/service (see docs memory: tally-connector-build-vs-buy).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Creates a new Org and its first User in one step — there is no separate "join an org" flow yet. */
  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists.');
    }

    const passwordHash = await argon2.hash(dto.password);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        name: dto.name,
        org: { create: { name: dto.orgName } },
      },
      include: { org: true },
    });

    return this.buildResult(user.id, user.email, user.name, user.orgId, user.org.name);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { org: true },
    });
    // Same error for "no such user" and "wrong password" — don't leak which
    // one it was, that's an account-enumeration oracle.
    if (!user || !(await argon2.verify(user.passwordHash, dto.password))) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    return this.buildResult(user.id, user.email, user.name, user.orgId, user.org.name);
  }

  /**
   * Always resolves, whether or not `email` matches a real account — the
   * HTTP response is identical either way, same account-enumeration-
   * avoidance standard as login's "same error for no such user vs. wrong
   * password." The no-match case IS logged server-side though (never to the
   * client) — this is a pure debugging aid: "I requested a code and nothing
   * happened" is otherwise indistinguishable from a real bug versus a typo'd
   * email, and the previous silent return made that genuinely undebuggable
   * without a direct DB query every time. Upserts the one-row-per-user OTP
   * (see PasswordResetOtp's doc comment) — requesting a new code always
   * invalidates whatever was issued before it, including its attempt count.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      this.logger.warn(
        `Password reset requested for "${email}" — no account with that email exists, no code sent. ` +
          `(This is by design, not an error — but check for a typo if you expected this to work.)`,
      );
      return;
    }

    const otp = this.generateOtp();
    const expiresAt = new Date(Date.now() + RESET_OTP_TTL_MS);
    await this.prisma.passwordResetOtp.upsert({
      where: { userId: user.id },
      create: { userId: user.id, otp, expiresAt },
      update: { otp, attempts: 0, expiresAt },
    });
    this.logger.log(`Password reset code issued for "${email}" (expires in ${RESET_OTP_TTL_MS / 60_000} min).`);

    await this.notifications.sendPasswordResetOtp(email, otp);
  }

  /**
   * The env check is the top-level branch, deliberately — not a special case
   * bolted onto the real path: outside production, OTP verification is
   * skipped entirely (no row lookup, no expiry/attempts check, `otp` isn't
   * even inspected) and the password is reset directly off a real email
   * alone. In production, the full check runs — one generic error for every
   * failure mode (no outstanding OTP, expired, attempts exhausted, wrong
   * code) so a caller can never tell which part was wrong, same standard as
   * login's "same error for no such user vs. wrong password." A wrong code
   * counts against RESET_OTP_MAX_ATTEMPTS before the OTP is looked up again,
   * so a guessing script can't retry indefinitely against one issued code.
   * On success the OTP row is deleted outright — a replay of the same code
   * afterward finds no row at all.
   */
  async resetPassword(email: string, otp: string, newPassword: string): Promise<void> {
    const invalid = (reason: string) => {
      this.logger.warn(`Password reset for "${email}" rejected: ${reason}`);
      return new BadRequestException('Invalid or expired code — request a new one.');
    };

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw invalid('no account with that email exists');

    const env = this.config.get<string>('env', 'development');

    if (env === 'production') {
      const row = await this.prisma.passwordResetOtp.findUnique({ where: { userId: user.id } });
      if (!row) throw invalid('no code was ever requested for this account (call request-password-reset first)');
      if (row.expiresAt < new Date()) throw invalid('the code expired — request a new one');
      if (row.attempts >= RESET_OTP_MAX_ATTEMPTS) throw invalid('too many wrong attempts on this code');

      if (row.otp !== otp) {
        await this.prisma.passwordResetOtp.update({
          where: { userId: user.id },
          data: { attempts: { increment: 1 } },
        });
        throw invalid(`wrong code (attempt ${row.attempts + 1}/${RESET_OTP_MAX_ATTEMPTS})`);
      }
    } else {
      this.logger.log(`Password reset for "${email}" — OTP verification skipped outside production.`);
    }

    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      // deleteMany, not delete: the non-production path may have no row to
      // begin with (request-password-reset was never called) — a plain
      // `delete` would throw "record not found" in that case.
      this.prisma.passwordResetOtp.deleteMany({ where: { userId: user.id } }),
    ]);
    this.logger.log(`Password reset succeeded for "${email}".`);
  }

  private generateOtp(): string {
    const env = this.config.get<string>('env', 'development');
    if (env !== 'production') return DEV_FIXED_OTP;
    return randomInt(0, 10000).toString().padStart(4, '0');
  }

  private buildResult(
    id: string,
    email: string,
    name: string | null,
    orgId: string,
    orgName: string,
  ): AuthResult {
    const payload: JwtPayload = { sub: id, email, orgId };
    return {
      accessToken: this.jwt.sign(payload),
      user: { id, email, name, orgId, orgName },
    };
  }
}
