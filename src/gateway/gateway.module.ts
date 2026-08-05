import { Module } from '@nestjs/common';
import { GatewayController } from './gateway.controller';
import { TallyTunnelGateway } from './tally-tunnel.gateway';

@Module({
  controllers: [GatewayController],
  providers: [TallyTunnelGateway],
  exports: [TallyTunnelGateway],
})
export class GatewayModule {}
