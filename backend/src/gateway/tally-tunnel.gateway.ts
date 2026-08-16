import { Injectable, Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { ExtractionConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { parseConnectionToken } from '../connections/token.util';
import {
  AgentHeartbeatMessage,
  AgentHelloMessage,
  AgentResultMessage,
  AgentToGatewayMessage,
  GatewayToAgentMessage,
  TunnelAction,
} from '../tunnel/tunnel-protocol';

interface TrackedSocket extends WebSocket {
  connectionId?: string;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

/** One outstanding command per logical job, tracked by sendCommand's
 *  dedupeKey — see that method's doc comment for why. */
interface InFlightDedupeEntry {
  connectionId: string;
  requestId: string;
  /** Set once a timeout has sent 'cancel' — cleared early if handleResult
   *  confirms the command actually finished before the grace period elapses. */
  graceTimer?: NodeJS.Timeout;
}

const AUTH_TIMEOUT_MS = 10_000;

/**
 * How long sendCommand waits, after sending 'cancel' on a timeout, for the
 * agent to confirm the abandoned command actually stopped (a 'result',
 * ok or not) before force-clearing the dedupe guard anyway. Bounds the
 * worst case to one window instead of an unbounded wait if the agent
 * crashed, lost its connection, or is an older build that ignores 'cancel'.
 */
const CANCEL_GRACE_MS = 30_000;

/**
 * Terminates agent WebSocket connections and routes commands to them. Lives in
 * the same process as the rest of the App for v1 — see docs/deployment-plan.md
 * §2 for why a separate gateway tier + Redis routing isn't built yet (no
 * horizontal scale to route across).
 *
 * Auth (Phase 3): a per-connection device token minted by ConnectionsService,
 * `${TallyConnection.id}.${secret}` — verified directly against Postgres here
 * rather than going through ConnectionsService, specifically to avoid a
 * circular module dependency (ConnectionsModule already needs this gateway,
 * for its revoke-disconnects-live-session behavior). The registry is keyed by
 * the real, stable TallyConnection id — not a fresh random id per reconnect —
 * so "is this specific paired install currently online" is answerable.
 */
@Injectable()
@WebSocketGateway({ path: '/agent-tunnel' })
export class TallyTunnelGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TallyTunnelGateway.name);
  private readonly agents = new Map<string, TrackedSocket>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly inFlightByDedupeKey = new Map<string, InFlightDedupeEntry>();
  private readonly requestOwner = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  handleConnection(client: TrackedSocket): void {
    // .unref() so a pile of never-authenticated sockets can't hold the process
    // open during shutdown — this timer alone shouldn't keep Node alive.
    const authDeadline = setTimeout(() => {
      if (!client.connectionId) {
        this.logger.warn('Agent did not authenticate in time; closing connection.');
        client.close(4001, 'auth timeout');
      }
    }, AUTH_TIMEOUT_MS).unref();

    client.on('message', (raw: Buffer) => {
      void (async () => {
        let message: AgentToGatewayMessage;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          client.close(4002, 'invalid message');
          return;
        }

        if (message.type === 'hello') {
          clearTimeout(authDeadline);
          await this.handleHello(client, message);
          return;
        }

        if (!client.connectionId) {
          // Anything before a valid hello is not trusted, full stop.
          client.close(4001, 'not authenticated');
          return;
        }

        if (message.type === 'result') {
          this.handleResult(message);
          return;
        }

        if (message.type === 'heartbeat') {
          await this.handleHeartbeat(client, message);
        }
      })();
    });
  }

  handleDisconnect(client: TrackedSocket): void {
    if (client.connectionId && this.agents.get(client.connectionId) === client) {
      this.agents.delete(client.connectionId);
      this.logger.log(`Agent ${client.connectionId} disconnected.`);
    }
    // The agent's gone — nothing left to wait on for whatever it was still
    // mid-command on. Clear its dedupe guards so a retry isn't blocked
    // forever behind a connection that no longer exists.
    if (client.connectionId) {
      for (const [dedupeKey, entry] of this.inFlightByDedupeKey) {
        if (entry.connectionId !== client.connectionId) continue;
        if (entry.graceTimer) clearTimeout(entry.graceTimer);
        this.inFlightByDedupeKey.delete(dedupeKey);
        this.requestOwner.delete(entry.requestId);
      }
    }
  }

  /** Connected connection IDs — used by ExtractionsService to reject a job
   *  immediately if its target connector isn't online, and by
   *  ConnectionsController to report live status per connection. Both callers
   *  scope this to the caller's own org before using it; this method itself
   *  returns every org's connected ids and must never be exposed unscoped. */
  listConnectedAgents(): string[] {
    return [...this.agents.keys()];
  }

  /** Closes a specific agent's live socket, if it currently has one open. Used
   *  when a connection is revoked — being marked inactive in Postgres should
   *  not leave an already-authenticated session running until it happens to
   *  disconnect on its own. */
  disconnectAgent(connectionId: string, reason: string): boolean {
    const client = this.agents.get(connectionId);
    if (!client) return false;
    client.close(4003, reason);
    this.agents.delete(connectionId);
    return true;
  }

  /**
   * Sends a command to a specific connected agent and waits for its result.
   * Defaults to ExtractionConfig.commandTimeoutMs — sized to comfortably
   * outlast the agent's own worst-case Tally round trip (its timeout ×
   * retries), not just one Tally request, so a slow-but-working call isn't
   * misreported as "agent did not respond" out from under a result that was
   * actually about to arrive.
   *
   * `dedupeKey`, when supplied, identifies "this logical piece of work" —
   * pass the stable ExtractionJob id, NOT connectionId (two different jobs
   * legitimately run concurrently against one agent; TallyHttpClient's own
   * queue already serializes those safely). If a command with the same
   * dedupeKey is already outstanding, this rejects immediately without
   * sending anything — the fix for a real production bug: a BullMQ retry of
   * a timed-out job used to dispatch a second command while the agent was
   * still working the first, abandoned one, piling duplicate work onto its
   * single Tally-request queue every retry until the connector looked
   * permanently hung. On timeout, a 'cancel' is now also sent so the agent
   * actually stops instead of running to completion unobserved (see
   * AgentTunnelClient's AbortController wiring) — with a bounded grace
   * period (CANCEL_GRACE_MS) before force-clearing the guard regardless, in
   * case the agent never confirms (crashed, or an older build).
   */
  async sendCommand(
    connectionId: string,
    action: TunnelAction,
    payload: Record<string, unknown> = {},
    timeoutMs = this.config.getOrThrow<ExtractionConfig>('extraction').commandTimeoutMs,
    dedupeKey?: string,
  ): Promise<unknown> {
    if (dedupeKey) {
      const busy = this.inFlightByDedupeKey.get(dedupeKey);
      if (busy) {
        throw new Error(
          `Extraction ${dedupeKey} already has command ${busy.requestId} outstanding on agent ` +
            `${busy.connectionId} — refusing to dispatch a duplicate. It will be retried once the ` +
            'prior attempt is confirmed cancelled or finishes.',
        );
      }
    }

    const client = this.agents.get(connectionId);
    if (!client || client.readyState !== WebSocket.OPEN) {
      throw new Error(`Agent ${connectionId} is not connected.`);
    }

    const requestId = randomUUID();
    const command: GatewayToAgentMessage = { type: 'command', requestId, action, payload };

    if (dedupeKey) {
      this.inFlightByDedupeKey.set(dedupeKey, { connectionId, requestId });
      this.requestOwner.set(requestId, dedupeKey);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        this.trySendCancel(client, requestId);
        if (dedupeKey) this.scheduleCancelGraceClear(dedupeKey, requestId);
        reject(new Error(`Agent ${connectionId} did not respond within ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      client.send(JSON.stringify(command));
    });
  }

  private trySendCancel(client: TrackedSocket, requestId: string): void {
    if (client.readyState !== WebSocket.OPEN) return;
    const cancel: GatewayToAgentMessage = { type: 'cancel', requestId };
    try {
      client.send(JSON.stringify(cancel));
    } catch (err) {
      this.logger.warn(
        `Could not send cancel for request ${requestId} (continuing): ${String(err)}`,
      );
    }
  }

  private scheduleCancelGraceClear(dedupeKey: string, requestId: string): void {
    const timer = setTimeout(() => {
      const busy = this.inFlightByDedupeKey.get(dedupeKey);
      if (busy?.requestId !== requestId) return; // already cleared/superseded
      this.inFlightByDedupeKey.delete(dedupeKey);
      this.requestOwner.delete(requestId);
      this.logger.warn(
        `No cancellation confirmation arrived for request ${requestId} (extraction ${dedupeKey}) ` +
          `within ${CANCEL_GRACE_MS}ms — clearing the busy guard so a retry can proceed. The agent ` +
          'may still be finishing the abandoned attempt in the background.',
      );
    }, CANCEL_GRACE_MS).unref();
    const entry = this.inFlightByDedupeKey.get(dedupeKey);
    if (entry) entry.graceTimer = timer;
  }

  private clearDedupeFor(requestId: string): void {
    const dedupeKey = this.requestOwner.get(requestId);
    if (!dedupeKey) return;
    const entry = this.inFlightByDedupeKey.get(dedupeKey);
    if (entry?.requestId === requestId) {
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
      this.inFlightByDedupeKey.delete(dedupeKey);
    }
    this.requestOwner.delete(requestId);
  }

  private async handleHello(client: TrackedSocket, message: AgentHelloMessage): Promise<void> {
    const rejectAuth = (reason: string) => {
      this.logger.warn(`Agent auth rejected: ${reason}`);
      const reject: GatewayToAgentMessage = { type: 'auth-error', message: 'invalid token' };
      client.send(JSON.stringify(reject));
      client.close(4003, 'invalid token');
    };

    const parsed = parseConnectionToken(message.token);
    if (!parsed) return rejectAuth('malformed token');

    let connection;
    try {
      connection = await this.prisma.tallyConnection.findUnique({ where: { id: parsed.id } });
    } catch (err) {
      this.logger.error(`DB error while authenticating agent: ${String(err)}`);
      return rejectAuth('lookup failed');
    }
    if (!connection || !connection.isActive) return rejectAuth('unknown or revoked connection');

    const valid = await argon2.verify(connection.tokenHash, parsed.secret).catch(() => false);
    if (!valid) return rejectAuth('wrong secret');

    // A reconnect (or a stray duplicate) for an id already tracked — replace,
    // don't stack, so a dead socket can never linger as "connected."
    const existing = this.agents.get(connection.id);
    if (existing && existing !== client) {
      existing.close(4004, 'superseded by new connection');
    }

    client.connectionId = connection.id;
    this.agents.set(connection.id, client);
    this.logger.log(
      `Agent ${connection.id} (${connection.label}) connected — build ${message.version}.`,
    );

    await this.prisma.tallyConnection
      .update({ where: { id: connection.id }, data: { lastSeenAt: new Date() } })
      .catch((err) => this.logger.warn(`Could not update lastSeenAt (continuing): ${String(err)}`));

    const ack: GatewayToAgentMessage = { type: 'hello-ack', agentId: connection.id };
    client.send(JSON.stringify(ack));
  }

  private handleResult(message: AgentResultMessage): void {
    // Clear the dedupe guard even for a late reply — pending will already be
    // empty in that case (deleted at timeout), but this is the actual
    // confirmation the abandoned command stopped, which is what a retry via
    // the same dedupeKey is waiting on.
    this.clearDedupeFor(message.requestId);

    const pending = this.pending.get(message.requestId);
    if (!pending) return; // Late or duplicate reply — nothing waiting on it, ignore.
    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.data);
    } else {
      pending.reject(new Error(message.error?.message ?? 'Agent command failed.'));
    }
  }

  /** Updates from the agent's own periodic Tally self-probe (see
   *  AgentTunnelClient's heartbeat timer) — independent of any queued
   *  command. Refreshes lastSeenAt too, since this is otherwise only ever
   *  set once, at hello time, even while a socket stays open for hours. */
  private async handleHeartbeat(
    client: TrackedSocket,
    message: AgentHeartbeatMessage,
  ): Promise<void> {
    if (!client.connectionId) return; // guarded by the caller; defensive only.
    await this.prisma.tallyConnection
      .update({
        where: { id: client.connectionId },
        data: {
          lastSeenAt: new Date(),
          tallyReachable: message.tallyReachable,
          lastProbeAt: new Date(),
        },
      })
      .catch((err) =>
        this.logger.warn(`Could not persist heartbeat for ${client.connectionId}: ${String(err)}`),
      );
  }
}
