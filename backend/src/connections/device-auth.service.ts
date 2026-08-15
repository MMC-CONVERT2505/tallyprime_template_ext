import { randomBytes, randomInt } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DeviceAuthorization, DeviceAuthorizationStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ConnectionsService } from './connections.service';
import { ApproveDeviceDto } from './dto/approve-device.dto';

export interface DeviceStartResult {
  deviceCode: string;
  userCode: string;
  /** Seconds until this pairing request expires if never approved. */
  expiresIn: number;
  /** Suggested seconds between polls. */
  interval: number;
}

export interface DeviceApproveResult {
  approved: true;
  /** True when this call found the code already approved by this same org — a retried request that already succeeded, not a fresh approval. */
  alreadyApproved: boolean;
}

export type DevicePollResult =
  | { status: 'pending' }
  | {
      status: 'approved';
      id: string;
      label: string;
      token: string;
      reused: boolean;
      defaultCompany?: string | null;
    };

/**
 * Read-only pairing state for the web UI to poll after approving — deliberately
 * separate from `poll()` (which mints/consumes the bridge's real bearer token
 * and must stay bridge-only). Detail fields are only populated when the
 * requesting org matches the row's org, so one org can never learn another
 * org's connector label/company by guessing a userCode.
 */
export type DeviceStatusResult =
  | { status: 'pending'; userCode: string; expiresInSeconds: number }
  | { status: 'expired'; userCode: string }
  | { status: 'approved'; userCode: string; label?: string | null; defaultCompany?: string | null }
  | {
      status: 'consumed';
      userCode: string;
      connectionId?: string;
      label?: string | null;
      defaultCompany?: string | null;
    };

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
  private readonly logger = new Logger(DeviceAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: ConnectionsService,
  ) {}

  /** Called by an unauthenticated bridge on first boot — it has no identity yet. */
  async start(): Promise<DeviceStartResult> {
    const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString('hex');
    const userCode = await this.generateUniqueUserCode();
    const expiresAt = new Date(Date.now() + EXPIRES_IN_SECONDS * 1000);

    await this.prisma.deviceAuthorization.create({
      data: { deviceCode, userCode, expiresAt },
    });

    this.logger.log(`Device pairing started — userCode ${userCode}.`);
    return { deviceCode, userCode, expiresIn: EXPIRES_IN_SECONDS, interval: POLL_INTERVAL_SECONDS };
  }

  /**
   * The one human-mediated step in the whole flow — called by a signed-in
   * user (JWT-authenticated) after reading the userCode off the connector's
   * console/UI. Does not mint the connection itself; that happens on the
   * bridge's next poll, so the bridge (not this request) controls exactly
   * when the credential is generated and handed over.
   *
   * The PENDING -> APPROVED transition is a single atomic `updateMany`
   * (compare-and-swap on `status: PENDING`) rather than a separate
   * find-then-update — two approvals of the same code racing (a retried
   * request after a dropped response, or two different orgs) can no longer
   * both pass a "still pending" check before either write lands. A retried
   * request that actually already succeeded is detected below and returned
   * as an idempotent success instead of a confusing 404.
   */
  async approve(orgId: string, dto: ApproveDeviceDto): Promise<DeviceApproveResult> {
    const claim = await this.prisma.deviceAuthorization.updateMany({
      where: { userCode: dto.userCode, status: DeviceAuthorizationStatus.PENDING, expiresAt: { gt: new Date() } },
      data: {
        status: DeviceAuthorizationStatus.APPROVED,
        orgId,
        label: dto.label ?? 'Paired via device code',
        defaultCompany: dto.defaultCompany,
      },
    });

    if (claim.count === 1) {
      this.logger.log(`Pairing code ${dto.userCode} approved by org ${orgId}.`);
      return { approved: true, alreadyApproved: false };
    }

    // Nothing matched the atomic claim above — figure out precisely why, so
    // the caller (and the human behind it) gets an actionable answer instead
    // of one generic failure for every possible cause.
    const row = await this.prisma.deviceAuthorization.findFirst({
      where: { userCode: dto.userCode },
      orderBy: { createdAt: 'desc' },
    });

    if (!row) {
      this.logger.warn(`Approve attempt for unknown userCode ${dto.userCode} (org ${orgId}).`);
      throw new NotFoundException(
        'No pending pairing request with that code — check it, or it may have expired.',
      );
    }

    if (
      row.status === DeviceAuthorizationStatus.EXPIRED ||
      (row.status === DeviceAuthorizationStatus.PENDING && row.expiresAt < new Date())
    ) {
      if (row.status === DeviceAuthorizationStatus.PENDING) await this.markExpired(row.id);
      this.logger.warn(`Approve attempt for expired userCode ${dto.userCode} (org ${orgId}).`);
      throw new BadRequestException(
        'This pairing code has expired — restart pairing on the connector.',
      );
    }

    if (row.status === DeviceAuthorizationStatus.APPROVED) {
      if (row.orgId === orgId) {
        // Same org re-approving the same code — most likely a retried
        // request after a dropped/timed-out response to the first, actually
        // successful, call. Treat as success, not an error.
        this.logger.log(`Pairing code ${dto.userCode} was already approved by org ${orgId} — idempotent no-op.`);
        return { approved: true, alreadyApproved: true };
      }
      this.logger.warn(
        `Approve attempt for userCode ${dto.userCode} by org ${orgId} — already claimed by org ${row.orgId}.`,
      );
      throw new ConflictException('This code was already approved by a different organization.');
    }

    if (row.status === DeviceAuthorizationStatus.CONSUMED) {
      this.logger.warn(
        `Approve attempt for userCode ${dto.userCode} by org ${orgId} — pairing already completed (org ${row.orgId}).`,
      );
      throw new ConflictException(
        'This pairing has already been completed — the connector should already be online.',
      );
    }

    // Unreachable in practice (every DeviceAuthorizationStatus is handled
    // above), but fail loudly rather than silently if the enum ever grows.
    throw new BadRequestException('Could not approve this pairing code.');
  }

  /**
   * Read-only status lookup for the web UI to poll after approving, so it
   * can detect "the bridge came online" without ever touching `poll()` (that
   * endpoint mints/consumes the bridge's own bearer token — the frontend
   * polling it would race the bridge for its one-time secret). Never
   * transitions CONSUMED; only ever lazily marks EXPIRED, same as
   * `poll()`/`approve()`.
   */
  async status(orgId: string, userCode: string): Promise<DeviceStatusResult> {
    const row = await this.prisma.deviceAuthorization.findFirst({
      where: { userCode },
      orderBy: { createdAt: 'desc' },
    });

    if (!row) {
      throw new NotFoundException('No pairing request with that code.');
    }

    if (row.status === DeviceAuthorizationStatus.PENDING && row.expiresAt < new Date()) {
      await this.markExpired(row.id);
      return { status: 'expired', userCode: row.userCode };
    }

    const sameOrg = (r: DeviceAuthorization) => r.orgId !== null && r.orgId === orgId;

    switch (row.status) {
      case DeviceAuthorizationStatus.PENDING:
        return {
          status: 'pending',
          userCode: row.userCode,
          expiresInSeconds: Math.max(0, Math.round((row.expiresAt.getTime() - Date.now()) / 1000)),
        };
      case DeviceAuthorizationStatus.EXPIRED:
        return { status: 'expired', userCode: row.userCode };
      case DeviceAuthorizationStatus.APPROVED:
        return sameOrg(row)
          ? { status: 'approved', userCode: row.userCode, label: row.label, defaultCompany: row.defaultCompany }
          : { status: 'approved', userCode: row.userCode };
      case DeviceAuthorizationStatus.CONSUMED:
        return sameOrg(row)
          ? {
              status: 'consumed',
              userCode: row.userCode,
              connectionId: row.connectionId ?? undefined,
              label: row.label,
              defaultCompany: row.defaultCompany,
            }
          : { status: 'consumed', userCode: row.userCode };
      default:
        throw new BadRequestException('Unknown pairing status.');
    }
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

    // APPROVED — mint (or reuse) the real connection now, on this poll.
    if (!row.orgId) {
      // Not reachable via the API (approve() always sets orgId), but guards
      // against a corrupted row rather than minting an orphaned connection.
      throw new BadRequestException('Approved pairing is missing an organization.');
    }

    const label = row.label ?? 'Paired via device code';
    // Goes through the same upsert as manual create — a company already
    // paired gets its token rotated on the existing row rather than a new
    // one, so two overlapping polls (or a retried poll) can't produce a
    // duplicate connection. That idempotency is what let this drop the
    // single-transaction guarantee the old create+consume pair relied on: a
    // crash between this mint and the CONSUMED write below just means the
    // next poll upserts the same row again instead of creating a second one.
    const result = await this.connections.upsertForCompany(
      row.orgId,
      label,
      row.defaultCompany ?? undefined,
    );

    await this.prisma.deviceAuthorization.update({
      where: { id: row.id },
      data: { status: DeviceAuthorizationStatus.CONSUMED, connectionId: result.id },
    });

    this.logger.log(
      `Pairing consumed — connection ${result.id} (${label})${result.reused ? ' [reused existing]' : ''}.`,
    );
    return {
      status: 'approved',
      id: result.id,
      label,
      token: result.token,
      reused: result.reused,
      defaultCompany: row.defaultCompany,
    };
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
