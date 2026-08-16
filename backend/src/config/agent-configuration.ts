import { TallyConfig, buildTallyConfig, toInt } from './configuration';

/**
 * Config for the connector/agent process (agent-main.ts) — deliberately
 * separate from configuration.ts's AppConfig. The agent has no Postgres,
 * Redis, or JWT auth of its own (see docs/architecture.md: processing and
 * persistence both live in the cloud, never on the client machine), so it
 * has no business requiring those env vars to be set on a client's PC.
 */
export interface AgentConfig {
  tally: TallyConfig;
  /** wss://.../agent-tunnel on the cloud gateway. */
  gatewayUrl: string;
  /**
   * Base URL of the backend's REST API, e.g. http://127.0.0.1:3000/api —
   * used only for the device-pairing HTTP calls (AgentPairingService), never
   * for the actual tunnel (that's gatewayUrl, a separate ws:// connection).
   */
  apiBaseUrl: string;
  /**
   * Per-install device credential for the gateway tunnel. Optional: if unset,
   * the agent pairs itself automatically on first boot (AgentPairingService)
   * and persists the token it's issued back into this same .env — no human
   * ever needs to copy one in manually. See docs/connector-bridge-setup-guide.md.
   */
  agentToken: string;
  /**
   * How often the agent self-probes its own Tally (independent of any
   * queued extraction command) and reports reachability to the gateway —
   * see AgentTunnelClient's heartbeat timer. This is what lets the cloud
   * distinguish "tunnel connected" from "Tally actually reachable right
   * now," not just how frequently to poll.
   */
  heartbeatIntervalMs: number;
}

export default (): AgentConfig => ({
  tally: buildTallyConfig(),
  gatewayUrl: process.env.GATEWAY_URL ?? 'ws://127.0.0.1:3000/agent-tunnel',
  apiBaseUrl: process.env.API_BASE_URL ?? 'http://127.0.0.1:3000/api',
  agentToken: process.env.AGENT_TOKEN ?? '',
  heartbeatIntervalMs: toInt(process.env.AGENT_HEARTBEAT_INTERVAL_MS, 60000),
});
