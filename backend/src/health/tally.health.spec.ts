import { HealthIndicatorService } from '@nestjs/terminus';
import { TallyHealthIndicator } from './tally.health';

describe('TallyHealthIndicator', () => {
  function makeIndicator(probe: jest.Mock) {
    const diagnostics = { probe };
    return new TallyHealthIndicator(diagnostics as any, new HealthIndicatorService());
  }

  it('reports up with company count and duration when the probe succeeds', async () => {
    const indicator = makeIndicator(
      jest.fn().mockResolvedValue({
        reachable: true,
        companies: ['ABC Ltd', 'XYZ Pvt Ltd'],
        durationMs: 42,
      }),
    );

    const result = await indicator.isHealthy('tally');

    expect(result.tally).toMatchObject({ status: 'up', companies: 2, durationMs: 42 });
  });

  it('reports down with the error message when the probe rejects — a closed Tally is not a service failure', async () => {
    const indicator = makeIndicator(jest.fn().mockRejectedValue(new Error('Tally unreachable')));

    const result = await indicator.isHealthy('tally');

    expect(result.tally).toMatchObject({ status: 'down', message: 'Tally unreachable' });
  });
});
