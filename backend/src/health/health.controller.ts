import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health';
import { TallyHealthIndicator } from './tally.health';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly redis: RedisHealthIndicator,
    private readonly tally: TallyHealthIndicator,
  ) {}

  /**
   * Infrastructure liveness: Postgres + Redis. Tally is deliberately excluded —
   * see /health/tally. Use this for container/orchestrator health probes.
   */
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.redis.isHealthy('redis')]);
  }

  /**
   * Tally connectivity, on its own endpoint. A "down" here means the client's
   * Tally is closed/unreachable — informational, not a service failure.
   */
  @Get('tally')
  @HealthCheck()
  checkTally() {
    return this.health.check([() => this.tally.isHealthy('tally')]);
  }
}
