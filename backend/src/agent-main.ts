import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AgentModule } from './agent/agent.module';

/**
 * Entry point for the connector/agent build (packaged via `npm run package:win`
 * — see package.json's `bin`). No HTTP server, no controllers: just the Tally
 * extraction stack + an outbound WebSocket tunnel client. Compare to main.ts,
 * the cloud App's entry point, which is a full Nest HTTP application.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('AgentBootstrap');
  const app = await NestFactory.createApplicationContext(AgentModule, { bufferLogs: false });
  app.enableShutdownHooks();
  logger.log('Connector agent started.');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal agent bootstrap error:', err);
  process.exit(1);
});
