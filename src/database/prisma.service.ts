import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { DatabaseConfig } from '../config/configuration';

/**
 * Thin Prisma wrapper following Nest's recommended lifecycle hook pattern:
 * connect explicitly on module init (rather than lazily on first query) so a
 * misconfigured DB fails fast at boot, and disconnect cleanly on shutdown.
 *
 * Prisma 7 dropped `datasources.db.url` in favor of driver adapters — the
 * connection string is handed to `pg` via `PrismaPg`, not to PrismaClient
 * directly.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const db = config.getOrThrow<DatabaseConfig>('database');
    super({
      adapter: new PrismaPg({ connectionString: db.url }),
      log: db.logging ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
  }

  /**
   * Connect eagerly so a misconfigured DB shows up in logs immediately — but
   * never fail boot over it. The extraction-job audit trail is best-effort by
   * design (see TallyService.createJob); a Postgres outage should degrade
   * that logging, not take down Tally connectivity with it.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Connected to Postgres via Prisma.');
    } catch (err) {
      this.logger.warn(`Could not connect to Postgres at boot (continuing): ${String(err)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
