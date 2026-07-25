import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';
import { RedisConfig } from '../config/configuration';

export const REDIS_CLIENT = 'REDIS_CLIENT';

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
        const client = new Redis({
          host: redis.host,
          port: redis.port,
          password: redis.password,
          db: redis.db,
          lazyConnect: false,
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
          retryStrategy: (times) => Math.min(times * 200, 5000),
        });

        client.on('error', (err) => {
          // Do not throw here — a background reconnect must not crash the app.
          // eslint-disable-next-line no-console
          console.error(`[redis] connection error: ${err.message}`);
        });

        return client;
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
