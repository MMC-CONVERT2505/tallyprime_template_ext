import { Injectable, Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { PrismaService } from '../database/prisma.service';
import { parseConnectionToken } from '../connections/token.util';
import {
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

const AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

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

  constructor(private readonly prisma: PrismaService) {}

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
        }
      })();
    });
  }

  handleDisconnect(client: TrackedSocket): void {
    if (client.connectionId && this.agents.get(client.connectionId) === client) {
      this.agents.delete(client.connectionId);
      this.logger.log(`Agent ${client.connectionId} disconnected.`);
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

  /** Sends a command to a specific connected agent and waits for its result. */
  async sendCommand(
    connectionId: string,
    action: TunnelAction,
    payload: Record<string, unknown> = {},
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<unknown> {
    const client = this.agents.get(connectionId);
    if (!client || client.readyState !== WebSocket.OPEN) {
      throw new Error(`Agent ${connectionId} is not connected.`);
    }

    const requestId = randomUUID();
    const command: GatewayToAgentMessage = { type: 'command', requestId, action, payload };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Agent ${connectionId} did not respond within ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      client.send(JSON.stringify(command));
    });
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
    this.logger.log(`Agent ${connection.id} (${connection.label}) connected — build ${message.version}.`);

    await this.prisma.tallyConnection
      .update({ where: { id: connection.id }, data: { lastSeenAt: new Date() } })
      .catch((err) => this.logger.warn(`Could not update lastSeenAt (continuing): ${String(err)}`));

    const ack: GatewayToAgentMessage = { type: 'hello-ack', agentId: connection.id };
    client.send(JSON.stringify(ack));
  }

  private handleResult(message: AgentResultMessage): void {
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
}
