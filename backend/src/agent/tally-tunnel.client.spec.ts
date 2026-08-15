import { WebSocket } from 'ws';
import { AgentTunnelClient } from './tally-tunnel.client';

jest.mock('./bridge-state.util', () => ({
  readBridgeState: jest.fn(),
  clearBridgeState: jest.fn(),
  DEFAULT_BRIDGE_STATE_PATH: '/mock/.tally-bridge-state.json',
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readBridgeState, clearBridgeState } = require('./bridge-state.util');

interface MockWebSocketInstance {
  url: string;
  send: jest.Mock;
  close: jest.Mock;
  emit(event: string, ...args: unknown[]): void;
}

jest.mock('ws', () => {
  const instances: MockWebSocketInstance[] = [];
  class MockWebSocket {
    static OPEN = 1;
    static instances = instances;
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    send = jest.fn();
    close = jest.fn();
    readyState = 1;
    constructor(public url: string) {
      instances.push(this as unknown as MockWebSocketInstance);
    }
    on(event: string, cb: (...args: unknown[]) => void) {
      (this.listeners[event] ??= []).push(cb);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of this.listeners[event] ?? []) cb(...args);
    }
  }
  return { WebSocket: MockWebSocket };
});

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

describe('AgentTunnelClient — credential handling', () => {
  const instances = (WebSocket as unknown as { instances: MockWebSocketInstance[] }).instances;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function makeClient(agentToken: string, pairResult: { resolve?: string; reject?: Error } = {}) {
    instances.length = 0;
    const config = {
      get: (key: string) => ({ gatewayUrl: 'ws://127.0.0.1:3000/agent-tunnel', agentToken })[key],
    };
    const pairing = {
      pair: jest.fn(() =>
        pairResult.reject
          ? Promise.reject(pairResult.reject)
          : Promise.resolve(pairResult.resolve ?? 'paired-token'),
      ),
    };
    const client = new AgentTunnelClient(
      config as any,
      pairing as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { client, pairing };
  }

  beforeEach(() => {
    readBridgeState.mockReset().mockReturnValue(null);
    clearBridgeState.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('connects directly, without pairing, when a token is already configured (no state file, env var fallback)', () => {
    const { client, pairing } = makeClient('existing-token');

    client.onModuleInit();

    expect(pairing.pair).not.toHaveBeenCalled();
    expect(instances).toHaveLength(1);
    client.onModuleDestroy();
  });

  it('prefers the local state file token over the AGENT_TOKEN env var when both are present', () => {
    readBridgeState.mockReturnValue({ agentToken: 'state-file-token' });
    const { client, pairing } = makeClient('env-var-token');

    client.onModuleInit();

    expect(pairing.pair).not.toHaveBeenCalled();
    expect(instances).toHaveLength(1);
    instances[0].emit('open');
    const hello = JSON.parse(instances[0].send.mock.calls[0][0]);
    expect(hello).toMatchObject({ token: 'state-file-token' });
    client.onModuleDestroy();
  });

  it('pairs automatically when no token is configured, then connects with the obtained token', async () => {
    const { client, pairing } = makeClient('', { resolve: 'freshly-paired-token' });

    client.onModuleInit();
    await flush();
    await flush();

    expect(pairing.pair).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);

    instances[0].emit('open');
    const hello = JSON.parse(instances[0].send.mock.calls[0][0]);
    expect(hello).toMatchObject({ type: 'hello', token: 'freshly-paired-token' });
    client.onModuleDestroy();
  });

  it('schedules a retry (via the normal backoff) rather than crashing when pairing fails', async () => {
    jest.useFakeTimers();
    const { client, pairing } = makeClient('', { reject: new Error('backend unreachable') });

    client.onModuleInit();
    await Promise.resolve(); // let the rejected pair() promise settle
    await Promise.resolve();

    expect(pairing.pair).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(0); // never got as far as opening a socket

    jest.advanceTimersByTime(1_000); // first backoff step
    await Promise.resolve();
    await Promise.resolve();

    expect(pairing.pair).toHaveBeenCalledTimes(2); // retried pairing, not stuck
    client.onModuleDestroy();
  });

  it('clears a rejected token on auth-error so the next reconnect re-pairs instead of retrying the dead token forever', async () => {
    jest.useFakeTimers();
    const { client, pairing } = makeClient('now-revoked-token', { resolve: 're-paired-token' });

    client.onModuleInit();
    expect(instances).toHaveLength(1);
    const first = instances[0];

    first.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'auth-error', message: 'invalid token' })),
    );
    first.emit('close', 4003, Buffer.from('invalid token')); // gateway closes right after auth-error, same as real behavior

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(pairing.pair).toHaveBeenCalledTimes(1); // did NOT just retry the same dead token
    expect(clearBridgeState).toHaveBeenCalledWith('/mock/.tally-bridge-state.json'); // and not left on disk to be reloaded on restart
    client.onModuleDestroy();
  });
});
