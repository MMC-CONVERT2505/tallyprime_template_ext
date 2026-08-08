import Redis from 'ioredis';
import { createRedisClient } from './redis.module';

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
  }));
});

describe('createRedisClient', () => {
  it('logs Redis connection errors only once while retries continue', () => {
    const listeners: Record<string, Array<(payload?: unknown) => void>> = {};
    const client = {
      on: jest.fn().mockImplementation((event: string, callback: (payload?: unknown) => void) => {
        listeners[event] = [...(listeners[event] ?? []), callback];
      }),
    };

    (Redis as unknown as jest.Mock).mockImplementation(() => client);

    const logger = jest.fn();
    createRedisClient({ host: '127.0.0.1', port: 6379, db: 0 }, logger);

    const firstError = listeners.error?.[0];
    firstError?.(new Error('ECONNREFUSED'));
    firstError?.(new Error('ECONNREFUSED'));

    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('connection error'));
  });
});
