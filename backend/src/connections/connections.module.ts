import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { DeviceAuthController } from './device-auth.controller';
import { DeviceAuthService } from './device-auth.service';

@Module({
  imports: [GatewayModule, NotificationsModule],
  controllers: [ConnectionsController, DeviceAuthController],
  providers: [ConnectionsService, DeviceAuthService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
