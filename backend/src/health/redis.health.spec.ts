import { HealthIndicatorService } from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health';

describe('RedisHealthIndicator', () => {
  function makeIndicator(ping: jest.Mock) {
    const redis = { ping };
    return new RedisHealthIndicator(redis as any, new HealthIndicatorService());
  }

  it('reports up when ping resolves PONG', async () => {
    const indicator = makeIndicator(jest.fn().mockResolvedValue('PONG'));

    const result = await indicator.isHealthy('redis');

    expect(result.redis.status).toBe('up');
  });

  it('reports down with the raw response when ping resolves anything other than PONG', async () => {
    const indicator = makeIndicator(jest.fn().mockResolvedValue('WEIRD'));

    const result = await indicator.isHealthy('redis');

    expect(result.redis).toMatchObject({ status: 'down', response: 'WEIRD' });
  });

  it('reports down with the error message when ping rejects', async () => {
    const indicator = makeIndicator(jest.fn().mockRejectedValue(new Error('connection refused')));

    const result = await indicator.isHealthy('redis');

    expect(result.redis).toMatchObject({ status: 'down', message: 'connection refused' });
  });
});
