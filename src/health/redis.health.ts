import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG' ? indicator.up() : indicator.down({ response: pong });
    } catch (err) {
      return indicator.down({ message: err instanceof Error ? err.message : String(err) });
    }
  }
}
