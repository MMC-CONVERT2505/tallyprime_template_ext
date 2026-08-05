import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';
import { RedisConfig } from '../config/configuration';

export const REDIS_CLIENT = 'REDIS_CLIENT';

export const createRedisClient = (
  redis: RedisConfig,
  logger: (message: string) => void = (message) => console.error(message),
): Redis => {
  const client = new Redis({
    host: redis.host,
    port: redis.port,
    password: redis.password,
    db: redis.db,
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });

  let lastErrorMessage = '';
  client.on('error', (err) => {
    const message = `[redis] connection error: ${err.message}`;
    if (message !== lastErrorMessage) {
      lastErrorMessage = message;
      logger(message);
    }
  });

  client.on('connect', () => {
    lastErrorMessage = '';
  });

  return client;
};

/**
 * Thin, global ioredis provider. Kept deliberately minimal for Phase 1 (cache +
 * health). It is the same client that will later back the Socket.IO adapter and
 * BullMQ queue, so wiring it now avoids a second connection pool later.
 *
 * `lazyConnect` + `maxRetriesPerRequest: null` means the app boots even when
 * Redis is temporarily down; commands reconnect transparently instead of the
 * whole process refusing to start.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        const redis = config.getOrThrow<RedisConfig>('redis');
        return createRedisClient(redis);
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown(): Promise<void> {
    const client = this.moduleRef.get<Redis>(REDIS_CLIENT, { strict: false });
    if (client && client.status !== 'end') {
      await client.quit().catch(() => client.disconnect());
    }
  }
}
