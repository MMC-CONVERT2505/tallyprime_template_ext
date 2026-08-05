import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../database/prisma.service';
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

/**
 * Email/password auth, self-hosted (no external identity provider) — matches
 * this project's pattern of owning its core stack rather than reaching for a
 * third-party SDK/service (see docs memory: tally-connector-build-vs-buy).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
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
