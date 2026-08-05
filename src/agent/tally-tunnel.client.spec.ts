import { AgentTunnelClient } from './tally-tunnel.client';

describe('AgentTunnelClient.computeBackoffMs', () => {
  it('doubles each attempt starting from 1s', () => {
    expect(AgentTunnelClient.computeBackoffMs(0)).toBe(1_000);
    expect(AgentTunnelClient.computeBackoffMs(1)).toBe(2_000);
    expect(AgentTunnelClient.computeBackoffMs(2)).toBe(4_000);
    expect(AgentTunnelClient.computeBackoffMs(3)).toBe(8_000);
  });

  it('caps at 30s so a long-disconnected agent does not back off forever', () => {
    expect(AgentTunnelClient.computeBackoffMs(10)).toBe(30_000);
    expect(AgentTunnelClient.computeBackoffMs(100)).toBe(30_000);
  });
});
