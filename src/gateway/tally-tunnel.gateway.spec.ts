import { WebSocket } from 'ws';
import { TallyTunnelGateway } from './tally-tunnel.gateway';

/** Minimal fake matching just what TallyTunnelGateway touches on a ws socket. */
function makeFakeSocket() {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    agentId: undefined as string | undefined,
    readyState: WebSocket.OPEN,
    on: jest.fn((event: string, cb: (...args: any[]) => void) => {
      listeners[event] = [...(listeners[event] ?? []), cb];
    }),
    send: jest.fn(),
    close: jest.fn(),
    emit(event: string, ...args: any[]) {
      for (const cb of listeners[event] ?? []) cb(...args);
    },
  };
}

const config = { getOrThrow: jest.fn().mockReturnValue({ agentSharedSecret: 'correct-secret' }) };

describe('TallyTunnelGateway', () => {
  let gateway: TallyTunnelGateway;

  beforeEach(() => {
    gateway = new TallyTunnelGateway(config as any);
  });

  it('accepts a hello with the correct token, acks it, and tracks the agent', () => {
    const socket = makeFakeSocket();
    gateway.handleConnection(socket as any);

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'hello', token: 'correct-secret', version: '1.0.0' })));

    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledTimes(1);
    const ack = JSON.parse(socket.send.mock.calls[0][0]);
    expect(ack.type).toBe('hello-ack');
    expect(gateway.listConnectedAgents()).toContain(ack.agentId);
  });

  it('rejects a hello with the wrong token and closes the connection', () => {
    const socket = makeFakeSocket();
    gateway.handleConnection(socket as any);

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'hello', token: 'wrong', version: '1.0.0' })));

    expect(socket.close).toHaveBeenCalledWith(4003, 'invalid token');
    expect(gateway.listConnectedAgents()).toHaveLength(0);
  });

  it('ignores non-hello messages before authentication and closes the socket', () => {
    const socket = makeFakeSocket();
    gateway.handleConnection(socket as any);

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'result', requestId: 'x', ok: true })));

    expect(socket.close).toHaveBeenCalledWith(4001, 'not authenticated');
  });

  it('removes the agent from the registry on disconnect', () => {
    const socket = makeFakeSocket();
    gateway.handleConnection(socket as any);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'hello', token: 'correct-secret', version: '1.0.0' })));
    expect(gateway.listConnectedAgents()).toHaveLength(1);

    socket.agentId = JSON.parse(socket.send.mock.calls[0][0]).agentId;
    gateway.handleDisconnect(socket as any);

    expect(gateway.listConnectedAgents()).toHaveLength(0);
  });

  describe('sendCommand', () => {
    async function connectedAgent() {
      const socket = makeFakeSocket();
      gateway.handleConnection(socket as any);
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'hello', token: 'correct-secret', version: '1.0.0' })));
      const agentId = JSON.parse(socket.send.mock.calls[0][0]).agentId;
      socket.agentId = agentId;
      return { socket, agentId };
    }

    it('sends a command and resolves when the matching result arrives', async () => {
      const { socket, agentId } = await connectedAgent();

      const promise = gateway.sendCommand(agentId, 'probe', {});
      const sentCommand = JSON.parse(socket.send.mock.calls[1][0]);
      expect(sentCommand).toMatchObject({ type: 'command', action: 'probe' });

      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({ type: 'result', requestId: sentCommand.requestId, ok: true, data: { reachable: true } }),
        ),
      );

      await expect(promise).resolves.toEqual({ reachable: true });
    });

    it('rejects when the agent reports failure', async () => {
      const { socket, agentId } = await connectedAgent();
      const promise = gateway.sendCommand(agentId, 'probe', {});
      const sentCommand = JSON.parse(socket.send.mock.calls[1][0]);

      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'result',
            requestId: sentCommand.requestId,
            ok: false,
            error: { message: 'Tally unreachable' },
          }),
        ),
      );

      await expect(promise).rejects.toThrow('Tally unreachable');
    });

    it('rejects immediately for an agent that is not connected', async () => {
      await expect(gateway.sendCommand('nonexistent-agent', 'probe', {})).rejects.toThrow(
        'nonexistent-agent is not connected',
      );
    });

    it('rejects after the timeout if no result ever arrives', async () => {
      const { agentId } = await connectedAgent();
      await expect(gateway.sendCommand(agentId, 'probe', {}, 20)).rejects.toThrow('did not respond within 20ms');
    });
  });
});
