import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { GatewayConfig } from '../config/configuration';
import {
  AgentHelloMessage,
  AgentResultMessage,
  AgentToGatewayMessage,
  GatewayToAgentMessage,
  TunnelAction,
} from '../tunnel/tunnel-protocol';

interface TrackedSocket extends WebSocket {
  agentId?: string;
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
 * Auth here is the Phase 1-2 placeholder (one shared secret, see
 * config/configuration.ts's GatewayConfig doc comment) — proves "a legitimate
 * agent build," not which org/install. Per-org device credentials, pairing,
 * and revocation are Phase 3.
 */
@Injectable()
@WebSocketGateway({ path: '/agent-tunnel' })
export class TallyTunnelGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TallyTunnelGateway.name);
  private readonly agents = new Map<string, TrackedSocket>();
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly config: ConfigService) {}

  handleConnection(client: TrackedSocket): void {
    // .unref() so a pile of never-authenticated sockets can't hold the process
    // open during shutdown — this timer alone shouldn't keep Node alive.
    const authDeadline = setTimeout(() => {
      if (!client.agentId) {
        this.logger.warn('Agent did not authenticate in time; closing connection.');
        client.close(4001, 'auth timeout');
      }
    }, AUTH_TIMEOUT_MS).unref();

    client.on('message', (raw: Buffer) => {
      let message: AgentToGatewayMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        client.close(4002, 'invalid message');
        return;
      }

      if (message.type === 'hello') {
        clearTimeout(authDeadline);
        this.handleHello(client, message);
        return;
      }

      if (!client.agentId) {
        // Anything before a valid hello is not trusted, full stop.
        client.close(4001, 'not authenticated');
        return;
      }

      if (message.type === 'result') {
        this.handleResult(message);
      }
    });
  }

  handleDisconnect(client: TrackedSocket): void {
    if (client.agentId && this.agents.get(client.agentId) === client) {
      this.agents.delete(client.agentId);
      this.logger.log(`Agent ${client.agentId} disconnected.`);
    }
  }

  /** Connected agent IDs. Proof-of-concept accessor — Phase 4's job
   *  orchestration will route through the registry properly instead. */
  listConnectedAgents(): string[] {
    return [...this.agents.keys()];
  }

  /** Sends a command to a specific connected agent and waits for its result. */
  async sendCommand(
    agentId: string,
    action: TunnelAction,
    payload: Record<string, unknown> = {},
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<unknown> {
    const client = this.agents.get(agentId);
    if (!client || client.readyState !== WebSocket.OPEN) {
      throw new Error(`Agent ${agentId} is not connected.`);
    }

    const requestId = randomUUID();
    const command: GatewayToAgentMessage = { type: 'command', requestId, action, payload };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Agent ${agentId} did not respond within ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      client.send(JSON.stringify(command));
    });
  }

  private handleHello(client: TrackedSocket, message: AgentHelloMessage): void {
    const gateway = this.config.getOrThrow<GatewayConfig>('gateway');
    if (message.token !== gateway.agentSharedSecret) {
      this.logger.warn('Agent presented an invalid token; closing connection.');
      const reject: GatewayToAgentMessage = { type: 'auth-error', message: 'invalid token' };
      client.send(JSON.stringify(reject));
      client.close(4003, 'invalid token');
      return;
    }

    const agentId = randomUUID();
    client.agentId = agentId;
    this.agents.set(agentId, client);
    this.logger.log(`Agent ${agentId} connected (build version ${message.version}).`);

    const ack: GatewayToAgentMessage = { type: 'hello-ack', agentId };
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
