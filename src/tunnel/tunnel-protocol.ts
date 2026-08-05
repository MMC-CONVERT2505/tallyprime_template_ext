/**
 * Wire protocol for the agent<->gateway WebSocket tunnel (docs/architecture.md
 * Phase 1-2). Deliberately dependency-free — imported by both src/gateway
 * (cloud) and src/agent (connector), which must never depend on each other.
 *
 * One request/response pair per Tally operation the agent already exposes via
 * TallyService — this is a transport swap, not a new API surface.
 */

export const TUNNEL_ACTIONS = [
  'probe',
  'companies',
  'ledgers',
  'stockItems',
  'vouchers',
  'createLedger',
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

export type AgentToGatewayMessage = AgentHelloMessage | AgentResultMessage;

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

export type GatewayToAgentMessage =
  | GatewayHelloAckMessage
  | GatewayAuthErrorMessage
  | GatewayCommandMessage;
