import { WebSocket } from 'ws';
import { TallyTunnelGateway } from './tally-tunnel.gateway';
import { formatConnectionToken } from '../connections/token.util';

// Real argon2 is genuinely async (native threadpool) — mock it so the
// gateway's auth flow resolves deterministically on the next microtask
// instead of racing a real crypto call. argon2's own correctness is already
// covered by auth.service.spec.ts's real round-trip.
jest.mock('argon2', () => ({
  hash: jest.fn(async (secret: string) => `hashed:${secret}`),
  verify: jest.fn(async (hash: string, secret: string) => hash === `hashed:${secret}`),
}));

/** Minimal fake matching just what TallyTunnelGateway touches on a ws socket. */
function makeFakeSocket() {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    connectionId: undefined as string | undefined,
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

/** Flushes the microtask queue — enough for handleHello's chained awaits
 *  (findUnique -> argon2.verify -> update) to settle before assertions. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const CONNECTION_ID = 'conn-1';
const SECRET = 'the-real-secret';
const VALID_TOKEN = formatConnectionToken(CONNECTION_ID, SECRET);

function makePrisma(overrides: { findUnique?: jest.Mock; update?: jest.Mock } = {}) {
  return {
    tallyConnection: {
      findUnique:
        overrides.findUnique ??
        jest.fn().mockResolvedValue({
          id: CONNECTION_ID,
          label: 'Test Install',
          tokenHash: `hashed:${SECRET}`,
          isActive: true,
          orgId: 'org-1',
        }),
      update: overrides.update ?? jest.fn().mockResolvedValue({}),
    },
  };
}

function makeConfig(commandTimeoutMs = 30_000) {
  return { getOrThrow: jest.fn().mockReturnValue({ commandTimeoutMs }) };
}

describe('TallyTunnelGateway', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let gateway: TallyTunnelGateway;

  beforeEach(() => {
    prisma = makePrisma();
    gateway = new TallyTunnelGateway(prisma as any, makeConfig() as any);
  });

  async function sendHello(socket: ReturnType<typeof makeFakeSocket>, token: string) {
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'hello', token, version: '1.0.0' })));
    await flush();
  }

  it('accepts a valid token, acks with the stable connection id, and tracks it', async () => {
    const socket = makeFakeSocket();
    gateway.handleConnection(socket as any);
    await sendHello(socket, VALID_TOKEN);

    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledTimes(1);
    const ack = JSON.parse(socket.send.mock.calls[0][0]);
    expect(ack).toEqual({ type: 'hello-ack', agentId: CONNECTION_ID });
    expect(gateway.listConnectedAgents()).toEqual([CONNECTION_ID]);
    expect(prisma.tallyConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CONNECTION_ID } }),
    );
  });

  it('rejects a malformed token without touching the database', async () => {
    const socket = makeFakeSocket();
    gateway.handleConnection(socket as any);
    await sendHello(socket, 'not-a-valid-token-format');

    expect(socket.close).toHaveBeenCalledWith(4003, 'invalid token');
    expect(prisma.tallyConnection.findUnique).not.toHaveBeenCalled();
    expect(gateway.listConnectedAgents()).toHaveLength(0);
  });

  it('rejects an unknown connection id', async () => {
    prisma.tallyConnection.findUnique.mockResolvedValue(null);
    const socket = makeFakeSocket();
    gateway.handleConnection(socket as any);
    await sendHello(socket, formatConnectionToken('nonexistent', SECRET));

    expect(socket.close).toHaveBeenCalledWith(4003, 'invalid token');
  });

  it('rejects a revoked (isActive=false) connection even with the right secret', async () => {
    prisma.tallyConnection.findUnique.mockResolvedValue({
      id: CONNECTION_ID,
      label: 'Test Install',
      tokenHash: `hashed:${SECRET}`,
      isActive: false,
      orgId: 'org-1',
    });
    const socket = makeFakeSocket();
    gateway.handleConnection(socket as any);
    await sendHello(socket, VALID_TOKEN);

    expect(socket.close).toHaveBeenCalledWith(4003, 'invalid token');
    expect(gateway.listConnectedAgents()).toHaveLength(0);
  });

  it('rejects the wrong secret for a real connection id', async () => {
    const socket = makeFakeSocket();
    gateway.handleConnection(socket as any);
    await sendHello(socket, formatConnectionToken(CONNECTION_ID, 'wrong-secret'));

    expect(socket.close).toHaveBeenCalledWith(4003, 'invalid token');
    expect(gateway.listConnectedAgents()).toHaveLength(0);
  });

  it('ignores non-hello messages before authentication and closes the socket', () => {
    const socket = makeFakeSocket();
    gateway.handleConnection(socket as any);
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'result', requestId: 'x', ok: true })),
    );
    expect(socket.close).toHaveBeenCalledWith(4001, 'not authenticated');
  });

  it('reconnecting with the same connection id reuses the same identity and supersedes the old socket', async () => {
    const first = makeFakeSocket();
    gateway.handleConnection(first as any);
    await sendHello(first, VALID_TOKEN);
    expect(gateway.listConnectedAgents()).toEqual([CONNECTION_ID]);

    const second = makeFakeSocket();
    gateway.handleConnection(second as any);
    await sendHello(second, VALID_TOKEN);

    expect(first.close).toHaveBeenCalledWith(4004, 'superseded by new connection');
    expect(gateway.listConnectedAgents()).toEqual([CONNECTION_ID]); // still just one entry, not two
  });

  it('removes the connection from the registry on disconnect', async () => {
    const socket = makeFakeSocket();
    gateway.handleConnection(socket as any);
    await sendHello(socket, VALID_TOKEN);
    expect(gateway.listConnectedAgents()).toHaveLength(1);

    socket.connectionId = CONNECTION_ID;
    gateway.handleDisconnect(socket as any);

    expect(gateway.listConnectedAgents()).toHaveLength(0);
  });

  describe('disconnectAgent', () => {
    it('closes the live socket for a connected agent and returns true', async () => {
      const socket = makeFakeSocket();
      gateway.handleConnection(socket as any);
      await sendHello(socket, VALID_TOKEN);

      const result = gateway.disconnectAgent(CONNECTION_ID, 'connection revoked');

      expect(result).toBe(true);
      expect(socket.close).toHaveBeenCalledWith(4003, 'connection revoked');
      expect(gateway.listConnectedAgents()).toHaveLength(0);
    });

    it('returns false for an agent that is not connected', () => {
      expect(gateway.disconnectAgent('nobody-here', 'connection revoked')).toBe(false);
    });
  });

  describe('sendCommand', () => {
    async function connectedAgent() {
      const socket = makeFakeSocket();
      gateway.handleConnection(socket as any);
      await sendHello(socket, VALID_TOKEN);
      return { socket };
    }

    it('sends a command and resolves when the matching result arrives', async () => {
      const { socket } = await connectedAgent();

      const promise = gateway.sendCommand(CONNECTION_ID, 'probe', {});
      const sentCommand = JSON.parse(socket.send.mock.calls[1][0]);
      expect(sentCommand).toMatchObject({ type: 'command', action: 'probe' });

      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'result',
            requestId: sentCommand.requestId,
            ok: true,
            data: { reachable: true },
          }),
        ),
      );

      await expect(promise).resolves.toEqual({ reachable: true });
    });

    it('rejects when the agent reports failure', async () => {
      const { socket } = await connectedAgent();
      const promise = gateway.sendCommand(CONNECTION_ID, 'probe', {});
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
      await connectedAgent();
      await expect(gateway.sendCommand(CONNECTION_ID, 'probe', {}, 20)).rejects.toThrow(
        'did not respond within 20ms',
      );
    });

    it("defaults the timeout to ExtractionConfig.commandTimeoutMs (not a hardcoded constant) when the caller doesn't pass one", async () => {
      const config = makeConfig(25);
      const scopedGateway = new TallyTunnelGateway(prisma as any, config as any);
      const socket = makeFakeSocket();
      scopedGateway.handleConnection(socket as any);
      await sendHello(socket, VALID_TOKEN);

      await expect(scopedGateway.sendCommand(CONNECTION_ID, 'probe', {})).rejects.toThrow(
        'did not respond within 25ms',
      );
      expect(config.getOrThrow).toHaveBeenCalledWith('extraction');
    });

    it('sends a cancel message to the agent when the timeout fires', async () => {
      const { socket } = await connectedAgent();

      const promise = gateway.sendCommand(CONNECTION_ID, 'ledgers', {}, 20, 'job-1');
      const sentCommand = JSON.parse(socket.send.mock.calls[1][0]);
      await expect(promise).rejects.toThrow('did not respond within 20ms');

      const cancelMessage = JSON.parse(socket.send.mock.calls[2][0]);
      expect(cancelMessage).toEqual({ type: 'cancel', requestId: sentCommand.requestId });
    });

    describe('duplicate-dispatch prevention (dedupeKey)', () => {
      it('rejects a retry with the same dedupeKey while the first is still outstanding, without sending a second command', async () => {
        const { socket } = await connectedAgent();

        const first = gateway.sendCommand(CONNECTION_ID, 'ledgers', {}, 30_000, 'job-1');
        expect(socket.send).toHaveBeenCalledTimes(2); // hello-ack + the one command

        await expect(
          gateway.sendCommand(CONNECTION_ID, 'ledgers', {}, 30_000, 'job-1'),
        ).rejects.toThrow(/already has command/);
        expect(socket.send).toHaveBeenCalledTimes(2); // still just the one command — no duplicate sent

        // Resolve the still-pending first command so its timer doesn't leak past this test.
        const sentCommand = JSON.parse(socket.send.mock.calls[1][0]);
        socket.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'result',
              requestId: sentCommand.requestId,
              ok: true,
              data: [],
            }),
          ),
        );
        await expect(first).resolves.toEqual([]);
      });

      it('lets a retry with the same dedupeKey proceed once a late result confirms the abandoned attempt actually finished', async () => {
        const { socket } = await connectedAgent();

        const first = gateway.sendCommand(CONNECTION_ID, 'ledgers', {}, 20, 'job-1');
        const firstCommand = JSON.parse(socket.send.mock.calls[1][0]);
        await expect(first).rejects.toThrow('did not respond within 20ms');

        // The agent's late confirmation, arriving after the timeout already fired.
        socket.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'result',
              requestId: firstCommand.requestId,
              ok: true,
              data: [],
            }),
          ),
        );
        await flush();

        const second = gateway.sendCommand(CONNECTION_ID, 'ledgers', {}, 30_000, 'job-1');
        const secondCommand = JSON.parse(
          socket.send.mock.calls[socket.send.mock.calls.length - 1][0],
        );
        expect(secondCommand).toMatchObject({ type: 'command' });

        socket.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'result',
              requestId: secondCommand.requestId,
              ok: true,
              data: [],
            }),
          ),
        );
        await expect(second).resolves.toEqual([]);
      });

      it('does not block two different dedupeKeys, or no dedupeKey at all, against the same connection', async () => {
        const { socket } = await connectedAgent();

        const a = gateway.sendCommand(CONNECTION_ID, 'ledgers', {}, 30_000, 'job-A');
        const b = gateway.sendCommand(CONNECTION_ID, 'vouchers', {}, 30_000, 'job-B');
        const c = gateway.sendCommand(CONNECTION_ID, 'groups', {}, 30_000); // no dedupeKey

        expect(socket.send).toHaveBeenCalledTimes(4); // hello-ack + 3 commands, none blocked

        const [cmdA, cmdB, cmdC] = socket.send.mock.calls
          .slice(1)
          .map((call) => JSON.parse(call[0]));
        for (const cmd of [cmdA, cmdB, cmdC]) {
          socket.emit(
            'message',
            Buffer.from(
              JSON.stringify({ type: 'result', requestId: cmd.requestId, ok: true, data: [] }),
            ),
          );
        }
        await expect(Promise.all([a, b, c])).resolves.toEqual([[], [], []]);
      });

      it('clears the dedupe guard on disconnect, so a retry against a reconnected agent is not blocked forever', async () => {
        const { socket } = await connectedAgent();

        const first = gateway.sendCommand(CONNECTION_ID, 'ledgers', {}, 30_000, 'job-1');
        socket.connectionId = CONNECTION_ID;
        gateway.handleDisconnect(socket as any);

        const reconnected = makeFakeSocket();
        gateway.handleConnection(reconnected as any);
        await sendHello(reconnected, VALID_TOKEN);

        const second = gateway.sendCommand(CONNECTION_ID, 'ledgers', {}, 30_000, 'job-1');
        const secondCommand = JSON.parse(reconnected.send.mock.calls[1][0]);
        expect(secondCommand).toMatchObject({ type: 'command' });
        reconnected.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'result',
              requestId: secondCommand.requestId,
              ok: true,
              data: [],
            }),
          ),
        );
        await expect(second).resolves.toEqual([]);

        // Clean up `first`'s still-pending promise/timer (handleDisconnect only
        // clears the dedupe guard, not the `pending` entry itself) so it
        // doesn't leak a live timer past this test.
        const firstCommand = JSON.parse(socket.send.mock.calls[1][0]);
        socket.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'result',
              requestId: firstCommand.requestId,
              ok: true,
              data: [],
            }),
          ),
        );
        await expect(first).resolves.toEqual([]);
      });
    });
  });
});
