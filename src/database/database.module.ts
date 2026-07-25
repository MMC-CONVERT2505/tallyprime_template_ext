import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseConfig } from '../config/configuration';
import { ExtractionJob } from './entities/extraction-job.entity';
import { TallyConnection } from './entities/tally-connection.entity';

export const ALL_ENTITIES = [TallyConnection, ExtractionJob];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const db = config.getOrThrow<DatabaseConfig>('database');
        return {
          type: 'postgres' as const,
          host: db.host,
          port: db.port,
          username: db.username,
          password: db.password,
          database: db.database,
          entities: ALL_ENTITIES,
          synchronize: db.synchronize,
          logging: db.logging,
          // Keep the app resilient if Postgres is briefly unavailable at boot.
          retryAttempts: 10,
          retryDelay: 3000,
          autoLoadEntities: true,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
