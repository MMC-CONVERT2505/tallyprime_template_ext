import { randomBytes, randomUUID } from 'crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../database/prisma.service';
import { CreateConnectionDto } from './dto/create-connection.dto';
import { formatConnectionToken } from './token.util';

export interface NewConnectionResult {
  id: string;
  label: string;
  /** Shown exactly once — never retrievable again (same principle as an API key). */
  token: string;
  /** True when this reused an existing row (see upsertForCompany) instead of inserting a new one. */
  reused: boolean;
}

/**
 * CRUD for TallyConnection — the agent registry (docs/architecture.md Phase 3).
 * Deliberately does NOT verify agent tokens itself; that logic lives directly
 * in TallyTunnelGateway (see its doc comment for why: avoiding a circular
 * module dependency between gateway and connections).
 */
@Injectable()
export class ConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(orgId: string, dto: CreateConnectionDto): Promise<NewConnectionResult> {
    return this.upsertForCompany(orgId, dto.label, dto.defaultCompany);
  }

  /**
   * Mints a device token for `defaultCompany`, reusing an existing active
   * connection for that (org, company) pair instead of inserting a new row —
   * this is what actually enforces "one active connection per company," the
   * DB's partial unique index (see schema.prisma) is just the backstop.
   * Every entry point that mints a connection (manual create, device-auth
   * poll) goes through here so neither can create a duplicate the other
   * didn't already dedupe against.
   *
   * `defaultCompany` unset (multi-company/generic agent) always inserts —
   * there's no key to dedupe against, same as before this method existed.
   */
  async upsertForCompany(
    orgId: string,
    label: string,
    defaultCompany?: string,
  ): Promise<NewConnectionResult> {
    const secret = randomBytes(32).toString('hex');
    const tokenHash = await argon2.hash(secret);

    if (defaultCompany) {
      const existing = await this.prisma.tallyConnection.findFirst({
        where: { orgId, defaultCompany, isActive: true },
      });
      if (existing) {
        await this.prisma.tallyConnection.update({
          where: { id: existing.id },
          data: { tokenHash, label },
        });
        return {
          id: existing.id,
          label,
          token: formatConnectionToken(existing.id, secret),
          reused: true,
        };
      }
    }

    const id = randomUUID();
    await this.prisma.tallyConnection.create({
      data: { id, label, defaultCompany, tokenHash, orgId },
    });
    return { id, label, token: formatConnectionToken(id, secret), reused: false };
  }

  list(orgId: string) {
    return this.prisma.tallyConnection.findMany({
      where: { orgId },
      select: {
        id: true,
        label: true,
        defaultCompany: true,
        isActive: true,
        lastSeenAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Mints a fresh device token for an EXISTING connection by id — same row,
   * new secret. `create()`/`upsertForCompany()` now do this automatically
   * when the company already has an active connection, so this is mainly for
   * explicitly rotating a specific row (e.g. a suspected-leaked token) by id
   * rather than by company name.
   */
  async rotateToken(orgId: string, id: string): Promise<NewConnectionResult> {
    const existing = await this.prisma.tallyConnection.findFirst({ where: { id, orgId } });
    if (!existing) {
      throw new NotFoundException('Connection not found.');
    }
    if (!existing.isActive) {
      throw new BadRequestException(
        'This connection has been revoked — pair a new one via POST /connections instead of rotating a revoked one.',
      );
    }

    const secret = randomBytes(32).toString('hex');
    const tokenHash = await argon2.hash(secret);
    await this.prisma.tallyConnection.update({ where: { id }, data: { tokenHash } });

    return {
      id: existing.id,
      label: existing.label,
      token: formatConnectionToken(existing.id, secret),
      reused: true,
    };
  }

  /** Scoped to orgId so one org can never revoke another org's connection by guessing an id. */
  async revoke(orgId: string, id: string): Promise<void> {
    const result = await this.prisma.tallyConnection.updateMany({
      where: { id, orgId },
      data: { isActive: false },
    });
    if (result.count === 0) {
      throw new NotFoundException('Connection not found.');
    }
  }
}
