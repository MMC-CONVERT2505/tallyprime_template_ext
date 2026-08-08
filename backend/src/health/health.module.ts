import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { TallyModule } from '../tally/tally.module';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './redis.health';
import { TallyHealthIndicator } from './tally.health';

@Module({
  imports: [TerminusModule, TallyModule],
  controllers: [HealthController],
  providers: [RedisHealthIndicator, TallyHealthIndicator],
})
export class HealthModule {}
