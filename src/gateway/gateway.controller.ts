import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SendCommandDto } from './dto/send-command.dto';
import { TallyTunnelGateway } from './tally-tunnel.gateway';

/**
 * Proof-of-concept surface for Phase 1-2: confirms an agent is connected and
 * lets you drive it manually. Phase 4 (BullMQ job orchestration) replaces this
 * with the real job API — this controller does not survive past that phase.
 */
@Controller('gateway')
@UseGuards(JwtAuthGuard)
export class GatewayController {
  constructor(private readonly tunnel: TallyTunnelGateway) {}

  @Get('agents')
  listAgents() {
    return { agents: this.tunnel.listConnectedAgents() };
  }

  @Post('agents/:agentId/command')
  sendCommand(@Param('agentId') agentId: string, @Body() body: SendCommandDto) {
    return this.tunnel.sendCommand(agentId, body.action, body.payload ?? {});
  }
}
