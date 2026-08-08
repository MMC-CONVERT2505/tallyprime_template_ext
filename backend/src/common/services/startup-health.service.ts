import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

@Injectable()
export class StartupHealthService implements OnModuleInit {
  private readonly logger = new Logger(StartupHealthService.name);

  async onModuleInit(): Promise<void> {
    this.logger.log('Application startup completed in degraded mode.');
    this.logger.warn('Database and Redis are optional for boot in this environment.');
  }
}
