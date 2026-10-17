import { ConnectionsController } from './connections.controller';

describe('ConnectionsController', () => {
  const USER = { sub: 'u1', email: 'admin@example.com', orgId: 'org-1' };

  function makeConnections(overrides: Partial<Record<'create' | 'rotateToken', jest.Mock>> = {}) {
    return {
      create: overrides.create ?? jest.fn(),
      rotateToken: overrides.rotateToken ?? jest.fn(),
      list: jest.fn(),
      revoke: jest.fn(),
      delete: jest.fn(),
    };
  }

  function makeTunnel() {
    return { listConnectedAgents: jest.fn().mockReturnValue([]), disconnectAgent: jest.fn() };
  }

  function makeNotifications(sendConnectorToken?: jest.Mock) {
    return { sendConnectorToken: sendConnectorToken ?? jest.fn().mockResolvedValue(undefined) };
  }

  describe('create', () => {
    it('emails the acting user a copy of the newly minted token (fire-and-forget)', async () => {
      const result = {
        id: 'conn-1',
        label: 'Accounts PC',
        token: 'conn-1.secret',
        reused: false,
        defaultCompany: 'ABC Ltd',
      };
      const create = jest.fn().mockResolvedValue(result);
      const sendConnectorToken = jest.fn().mockResolvedValue(undefined);
      const controller = new ConnectionsController(
        makeConnections({ create }) as any,
        makeTunnel() as any,
        makeNotifications(sendConnectorToken) as any,
      );

      const response = await controller.create(USER as any, {
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
      } as any);
      await Promise.resolve();

      expect(response).toBe(result);
      expect(sendConnectorToken).toHaveBeenCalledWith('admin@example.com', {
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
        token: 'conn-1.secret',
        connectionId: 'conn-1',
      });
    });

    it('still returns the token even if the notification email fails', async () => {
      const result = { id: 'conn-1', label: 'Accounts PC', token: 'conn-1.secret', reused: false };
      const create = jest.fn().mockResolvedValue(result);
      const sendConnectorToken = jest.fn().mockRejectedValue(new Error('smtp down'));
      const controller = new ConnectionsController(
        makeConnections({ create }) as any,
        makeTunnel() as any,
        makeNotifications(sendConnectorToken) as any,
      );

      const response = await controller.create(USER as any, { label: 'Accounts PC' } as any);
      await Promise.resolve();

      expect(response).toBe(result);
    });
  });

  describe('rotateToken', () => {
    it('emails the acting user a copy of the freshly rotated token', async () => {
      const result = {
        id: 'conn-1',
        label: 'Accounts PC',
        token: 'conn-1.new-secret',
        reused: true,
        defaultCompany: 'ABC Ltd',
      };
      const rotateToken = jest.fn().mockResolvedValue(result);
      const sendConnectorToken = jest.fn().mockResolvedValue(undefined);
      const controller = new ConnectionsController(
        makeConnections({ rotateToken }) as any,
        makeTunnel() as any,
        makeNotifications(sendConnectorToken) as any,
      );

      const response = await controller.rotateToken(USER as any, 'conn-1');
      await Promise.resolve();

      expect(response).toBe(result);
      expect(sendConnectorToken).toHaveBeenCalledWith('admin@example.com', {
        label: 'Accounts PC',
        defaultCompany: 'ABC Ltd',
        token: 'conn-1.new-secret',
        connectionId: 'conn-1',
      });
    });
  });
});
