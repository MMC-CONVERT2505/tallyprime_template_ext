import { of, throwError } from 'rxjs';
import { AgentPairingService } from './agent-pairing.service';

jest.mock('./bridge-state.util', () => ({
  writeBridgeState: jest.fn(),
  DEFAULT_BRIDGE_STATE_PATH: '/mock/.tally-bridge-state.json',
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { writeBridgeState } = require('./bridge-state.util');

describe('AgentPairingService', () => {
  function makeService(httpPost: jest.Mock) {
    const http = { post: httpPost } as any;
    const config = { get: () => 'http://127.0.0.1:3000/api' } as any;
    return new AgentPairingService(http, config);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('starts pairing, polls through one pending response, then persists the token on approval', async () => {
    const httpPost = jest
      .fn()
      // POST /connections/device/start
      .mockReturnValueOnce(
        of({ data: { deviceCode: 'dc-1', userCode: 'ABCD-1234', expiresIn: 60, interval: 0.01 } }),
      )
      // POST /connections/device/token — first poll: still pending
      .mockReturnValueOnce(of({ status: 200, data: { status: 'pending' } }))
      // second poll: approved
      .mockReturnValueOnce(
        of({
          status: 200,
          data: {
            status: 'approved',
            id: 'conn-1',
            label: 'Accounts PC',
            token: 'conn-1.secret',
            defaultCompany: 'ABC Ltd',
          },
        }),
      );
    const service = makeService(httpPost);

    const token = await service.pair();

    expect(token).toBe('conn-1.secret');
    expect(httpPost).toHaveBeenCalledTimes(3);
    expect(httpPost).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3000/api/connections/device/start',
      {},
    );
    expect(httpPost).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:3000/api/connections/device/token',
      { deviceCode: 'dc-1' },
      expect.anything(),
    );
    expect(writeBridgeState).toHaveBeenCalledWith(
      '/mock/.tally-bridge-state.json',
      expect.objectContaining({
        agentToken: 'conn-1.secret',
        connectionId: 'conn-1',
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
      }),
    );
  });

  it('throws immediately on a terminal error from the poll endpoint (e.g. expired code)', async () => {
    const httpPost = jest
      .fn()
      .mockReturnValueOnce(
        of({ data: { deviceCode: 'dc-1', userCode: 'ABCD-1234', expiresIn: 60, interval: 0.01 } }),
      )
      .mockReturnValueOnce(of({ status: 400, data: { message: 'This pairing request expired' } }));
    const service = makeService(httpPost);

    await expect(service.pair()).rejects.toThrow(/expired/);
    expect(writeBridgeState).not.toHaveBeenCalled();
  });

  it('times out if never approved within expiresIn', async () => {
    const httpPost = jest
      .fn()
      .mockReturnValueOnce(
        of({
          data: { deviceCode: 'dc-1', userCode: 'ABCD-1234', expiresIn: 0.02, interval: 0.01 },
        }),
      )
      .mockReturnValue(of({ status: 200, data: { status: 'pending' } }));
    const service = makeService(httpPost);

    await expect(service.pair()).rejects.toThrow(/timed out/);
  });

  it('propagates a failure to even reach the backend (e.g. connection refused) starting the flow', async () => {
    const httpPost = jest
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('connect ECONNREFUSED')));
    const service = makeService(httpPost);

    await expect(service.pair()).rejects.toThrow('connect ECONNREFUSED');
  });
});
