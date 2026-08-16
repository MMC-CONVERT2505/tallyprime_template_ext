import { HealthController } from './health.controller';

/**
 * The one thing worth locking in here: GET /health and GET /health/tally
 * each wire exactly one indicator, never both. This is a deliberate design
 * decision (see TallyHealthIndicator's doc comment — "a client's Tally
 * being closed is a normal, expected state and must not make the whole
 * service report unhealthy") that a future accidental merge of the two
 * checks would silently break without a test like this catching it.
 */
describe('HealthController', () => {
  function makeController() {
    const health = {
      check: jest.fn(async (indicators: Array<() => Promise<unknown>>) => {
        const results = await Promise.all(indicators.map((fn) => fn()));
        return { status: 'ok', info: results, error: {}, details: results };
      }),
    };
    const redis = { isHealthy: jest.fn().mockResolvedValue({ redis: { status: 'up' } }) };
    const tally = { isHealthy: jest.fn().mockResolvedValue({ tally: { status: 'up' } }) };
    const controller = new HealthController(health as any, redis as any, tally as any);
    return { controller, redis, tally };
  }

  it('GET /health wires only the Redis indicator', async () => {
    const { controller, redis, tally } = makeController();

    await controller.check();

    expect(redis.isHealthy).toHaveBeenCalledWith('redis');
    expect(tally.isHealthy).not.toHaveBeenCalled();
  });

  it('GET /health/tally wires only the Tally indicator', async () => {
    const { controller, redis, tally } = makeController();

    await controller.checkTally();

    expect(tally.isHealthy).toHaveBeenCalledWith('tally');
    expect(redis.isHealthy).not.toHaveBeenCalled();
  });
});
