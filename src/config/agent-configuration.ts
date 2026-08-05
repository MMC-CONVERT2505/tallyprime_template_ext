import { TallyConfig, buildTallyConfig } from './configuration';

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
  /** Phase 1-2 placeholder auth — proves "a legitimate agent build", not
   *  which org/install. Real per-install credentials are Phase 3. */
  agentToken: string;
}

export default (): AgentConfig => ({
  tally: buildTallyConfig(),
  gatewayUrl: process.env.GATEWAY_URL ?? 'ws://127.0.0.1:3000/agent-tunnel',
  agentToken: process.env.AGENT_TOKEN ?? '',
});
