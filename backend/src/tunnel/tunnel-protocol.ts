/**
 * Wire protocol for the agent<->gateway WebSocket tunnel (docs/architecture.md
 * Phase 1-2). Deliberately dependency-free — imported by both src/gateway
 * (cloud) and src/agent (connector), which must never depend on each other.
 *
 * One request/response pair per Tally operation the agent already exposes via
 * its extraction services (src/tally/extraction) — this is a transport swap,
 * not a new API surface. Every action here is a read: this project extracts
 * from Tally, it never writes to it.
 */

export const TUNNEL_ACTIONS = [
  'probe',
  'companies',
  'ledgers',
  'stockItems',
  'groups',
  'costCentres',
  'vouchers',
  'raw',
] as const;

export type TunnelAction = (typeof TUNNEL_ACTIONS)[number];

export interface AgentHelloMessage {
  type: 'hello';
  token: string;
  /** package.json version — lets the gateway flag/reject stale agent builds (Phase 3+). */
  version: string;
}

export interface AgentResultMessage {
  type: 'result';
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: { message: string };
}

/**
 * Sent on its own periodic timer (see AgentTunnelClient), independent of any
 * queued extraction command — a self-check that the agent's own configured
 * Tally is actually reachable right now, not just that the WebSocket tunnel
 * is up. Reuses TallyDiagnosticsService.probe() and deliberately still goes
 * through TallyHttpClient's single serialized queue rather than bypassing
 * it, so a delayed heartbeat during a long batched fetch is itself a
 * meaningful "hasn't updated in a while" signal, not a bug.
 */
export interface AgentHeartbeatMessage {
  type: 'heartbeat';
  tallyReachable: boolean;
  /** Present only when tallyReachable is true. */
  probeDurationMs?: number;
}

export type AgentToGatewayMessage = AgentHelloMessage | AgentResultMessage | AgentHeartbeatMessage;

export interface GatewayHelloAckMessage {
  type: 'hello-ack';
  agentId: string;
}

export interface GatewayAuthErrorMessage {
  type: 'auth-error';
  message: string;
}

export interface GatewayCommandMessage {
  type: 'command';
  requestId: string;
  action: TunnelAction;
  payload: Record<string, unknown>;
}

/**
 * Sent when TallyTunnelGateway.sendCommand gives up waiting on a command
 * (its timeout fired) — tells the agent to actually stop working on it
 * instead of running to completion unobserved. An agent build that doesn't
 * recognize this type simply won't match it in its message switch and
 * ignores it — safe no-op during a rolling upgrade, same fallthrough
 * behavior every other message type here already relies on.
 */
export interface GatewayCancelMessage {
  type: 'cancel';
  requestId: string;
}

export type GatewayToAgentMessage =
  GatewayHelloAckMessage | GatewayAuthErrorMessage | GatewayCommandMessage | GatewayCancelMessage;
