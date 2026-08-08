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
    const id = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const tokenHash = await argon2.hash(secret);

    await this.prisma.tallyConnection.create({
      data: { id, label: dto.label, defaultCompany: dto.defaultCompany, tokenHash, orgId },
    });

    return { id, label: dto.label, token: formatConnectionToken(id, secret) };
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
   * Mints a fresh device token for an EXISTING connection — same id, same
   * label/defaultCompany, new secret — instead of `create()`'s "always a new
   * row." This is what a lost/rotated credential for an already-paired
   * physical device should use: re-pairing via `create()` instead leaves the
   * old row behind, and two active rows with the same `defaultCompany`
   * within an org is exactly what makes `POST /extractions/fetch-master`
   * ambiguous (see ExtractionsService.resolveConnectionByCompany).
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
