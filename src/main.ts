import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const globalPrefix = config.get<string>('globalPrefix', 'api');
  if (globalPrefix) {
    app.setGlobalPrefix(globalPrefix);
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown properties
      forbidNonWhitelisted: true, // 400 on unexpected properties
      transform: true, // coerce query/body into DTO types
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Enable graceful shutdown so RedisModule.onApplicationShutdown / TypeORM close cleanly.
  app.enableShutdownHooks();
  app.enableCors();

  const port = config.get<number>('port', 3000);
  await app.listen(port);

  const tally = config.get<{ baseUrl: string }>('tally');
  logger.log(`API listening on http://localhost:${port}/${globalPrefix}`);
  logger.log(`Configured Tally endpoint: ${tally?.baseUrl}`);
  logger.log(`Probe connectivity: GET http://localhost:${port}/${globalPrefix}/tally/probe`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
