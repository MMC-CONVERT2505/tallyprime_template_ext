import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { StartupHealthService } from './common/services/startup-health.service';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { ConnectionsModule } from './connections/connections.module';
import { DatabaseModule } from './database/database.module';
import { ExtractionsModule } from './extractions/extractions.module';
import { GatewayModule } from './gateway/gateway.module';
import { HealthModule } from './health/health.module';
import { RedisModule } from './redis/redis.module';
import { TallyModule } from './tally/tally.module';

const envFilePaths = [
  resolve(process.cwd(), '.env'),
  resolve(dirname(process.execPath), '.env'),
  resolve(__dirname, '..', '.env'),
]
  .filter((value, index, values) => values.indexOf(value) === index)
  .filter((value) => existsSync(value));

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      envFilePath: envFilePaths.length > 0 ? envFilePaths : undefined,
      // Report ALL invalid env vars at once, not just the first.
      validationOptions: { abortEarly: false },
    }),
    DatabaseModule,
    RedisModule,
    AuthModule,
    TallyModule,
    GatewayModule,
    ConnectionsModule,
    ExtractionsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    StartupHealthService,
  ],
})
export class AppModule {}
