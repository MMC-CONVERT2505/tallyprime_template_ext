import { randomBytes, randomInt, randomUUID } from 'crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DeviceAuthorizationStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../database/prisma.service';
import { ApproveDeviceDto } from './dto/approve-device.dto';
import { formatConnectionToken } from './token.util';

export interface DeviceStartResult {
  deviceCode: string;
  userCode: string;
  /** Seconds until this pairing request expires if never approved. */
  expiresIn: number;
  /** Suggested seconds between polls. */
  interval: number;
}

export type DevicePollResult =
  { status: 'pending' } | { status: 'approved'; id: string; label: string; token: string };

const EXPIRES_IN_SECONDS = 600; // 10 minutes — long enough for a human to switch tabs and paste a code, short enough to bound abuse.
const POLL_INTERVAL_SECONDS = 5;
const DEVICE_CODE_BYTES = 32; // 256 bits — this is the actual bearer secret used to claim the token; must be unguessable.
// Crockford-ish alphabet, no 0/O/1/I/L — short enough to type, hard to misread.
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const USER_CODE_GROUP_LEN = 4;

/**
 * Device Authorization Grant (RFC 8628-style) — see the doc comment on the
 * DeviceAuthorization Prisma model for the full flow. This is what lets a
 * connector bridge pair itself without a human ever copying a raw token: the
 * bridge polls with an opaque `deviceCode` it generated no one else sees; a
 * signed-in human approves the short `userCode` it displays instead.
 */
@Injectable()
export class DeviceAuthService {
  constructor(private readonly prisma: PrismaService) {}

  /** Called by an unauthenticated bridge on first boot — it has no identity yet. */
  async start(): Promise<DeviceStartResult> {
    const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString('hex');
    const userCode = await this.generateUniqueUserCode();
    const expiresAt = new Date(Date.now() + EXPIRES_IN_SECONDS * 1000);

    await this.prisma.deviceAuthorization.create({
      data: { deviceCode, userCode, expiresAt },
    });

    return { deviceCode, userCode, expiresIn: EXPIRES_IN_SECONDS, interval: POLL_INTERVAL_SECONDS };
  }

  /**
   * The one human-mediated step in the whole flow — called by a signed-in
   * user (JWT-authenticated) after reading the userCode off the connector's
   * console/UI. Does not mint the connection itself; that happens on the
   * bridge's next poll, so the bridge (not this request) controls exactly
   * when the credential is generated and handed over.
   */
  async approve(orgId: string, dto: ApproveDeviceDto): Promise<{ approved: true }> {
    const row = await this.prisma.deviceAuthorization.findFirst({
      where: { userCode: dto.userCode, status: DeviceAuthorizationStatus.PENDING },
    });
    if (!row) {
      throw new NotFoundException(
        'No pending pairing request with that code — check it, or it may have expired.',
      );
    }
    if (row.expiresAt < new Date()) {
      await this.markExpired(row.id);
      throw new BadRequestException(
        'This pairing code has expired — restart pairing on the connector.',
      );
    }

    await this.prisma.deviceAuthorization.update({
      where: { id: row.id },
      data: {
        status: DeviceAuthorizationStatus.APPROVED,
        orgId,
        label: dto.label ?? 'Paired via device code',
        defaultCompany: dto.defaultCompany,
      },
    });
    return { approved: true };
  }

  /**
   * Called repeatedly by the bridge until approved. Deliberately returns a
   * normal 200 `{ status: 'pending' }` rather than an error while waiting —
   * "still waiting" is the expected, routine state of a poll loop, not a
   * failure. Only unknown/consumed/expired codes are real errors.
   */
  async poll(deviceCode: string): Promise<DevicePollResult> {
    const row = await this.prisma.deviceAuthorization.findUnique({ where: { deviceCode } });
    if (!row) {
      throw new NotFoundException('Unknown device code — restart pairing on the connector.');
    }
    if (row.status === DeviceAuthorizationStatus.CONSUMED) {
      throw new BadRequestException(
        'This device code has already been used — restart pairing on the connector.',
      );
    }
    if (row.expiresAt < new Date()) {
      if (row.status === DeviceAuthorizationStatus.PENDING) await this.markExpired(row.id);
      throw new BadRequestException(
        'This pairing request expired — restart pairing on the connector.',
      );
    }
    if (row.status === DeviceAuthorizationStatus.PENDING) {
      return { status: 'pending' };
    }

    // APPROVED — mint the real connection now, on this poll, and consume the
    // row atomically so a second poll (or a race) can never mint twice.
    if (!row.orgId) {
      // Not reachable via the API (approve() always sets orgId), but guards
      // against a corrupted row rather than minting an orphaned connection.
      throw new BadRequestException('Approved pairing is missing an organization.');
    }

    const id = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const tokenHash = await argon2.hash(secret);
    const label = row.label ?? 'Paired via device code';

    await this.prisma.$transaction([
      this.prisma.tallyConnection.create({
        data: { id, label, defaultCompany: row.defaultCompany, tokenHash, orgId: row.orgId },
      }),
      this.prisma.deviceAuthorization.update({
        where: { id: row.id },
        data: { status: DeviceAuthorizationStatus.CONSUMED, connectionId: id },
      }),
    ]);

    return { status: 'approved', id, label, token: formatConnectionToken(id, secret) };
  }

  private async markExpired(id: string): Promise<void> {
    await this.prisma.deviceAuthorization.update({
      where: { id },
      data: { status: DeviceAuthorizationStatus.EXPIRED },
    });
  }

  /** Collision odds are astronomically low (32^8 keyspace) — this loop is a cheap belt-and-suspenders, not a load-bearing guarantee. */
  private async generateUniqueUserCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = this.randomUserCode();
      const existing = await this.prisma.deviceAuthorization.findFirst({
        where: { userCode: code, status: DeviceAuthorizationStatus.PENDING },
      });
      if (!existing) return code;
    }
    throw new Error('Could not generate a unique pairing code — please try again.');
  }

  private randomUserCode(): string {
    const group = () =>
      Array.from(
        { length: USER_CODE_GROUP_LEN },
        () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)],
      ).join('');
    return `${group()}-${group()}`;
  }
}
