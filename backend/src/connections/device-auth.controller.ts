import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TallyTunnelGateway } from '../gateway/tally-tunnel.gateway';
import { ApproveDeviceDto } from './dto/approve-device.dto';
import { DeviceStatusQueryDto } from './dto/device-status-query.dto';
import { PollDeviceTokenDto } from './dto/poll-device-token.dto';
import { DeviceAuthService } from './device-auth.service';

/**
 * Device Authorization Grant endpoints for zero-manual-token connector
 * pairing (docs/connector-bridge-setup-guide.md). Deliberately a separate,
 * mostly-unauthenticated controller rather than routes on
 * ConnectionsController: `start`/`token` are called by a bridge that has no
 * identity yet, so they cannot sit behind JwtAuthGuard. Only `approve` and
 * `status` — human-facing steps — require a signed-in user.
 */
@Controller('connections/device')
export class DeviceAuthController {
  constructor(
    private readonly deviceAuth: DeviceAuthService,
    private readonly tunnel: TallyTunnelGateway,
  ) {}

  /** Called by the bridge on first boot. No auth — it doesn't have any yet. */
  @Post('start')
  @HttpCode(HttpStatus.OK)
  start() {
    return this.deviceAuth.start();
  }

  /** Called by a signed-in human after reading the userCode off the bridge's console/UI. */
  @Post('approve')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  approve(@CurrentUser() user: JwtPayload, @Body() dto: ApproveDeviceDto) {
    return this.deviceAuth.approve(user.orgId, dto);
  }

  /** Polled repeatedly by the bridge until approved. No auth — same reason as `start`. */
  @Post('token')
  @HttpCode(HttpStatus.OK)
  poll(@Body() dto: PollDeviceTokenDto) {
    return this.deviceAuth.poll(dto.deviceCode);
  }

  /**
   * Lets the web UI poll for "has the bridge come online yet" after
   * approving, without ever touching `token` (which mints/consumes the
   * bridge's own bearer secret and must stay bridge-only). Read-only, safe
   * to call as often as needed.
   */
  @Get('status')
  @UseGuards(JwtAuthGuard)
  async status(@CurrentUser() user: JwtPayload, @Query() query: DeviceStatusQueryDto) {
    const result = await this.deviceAuth.status(user.orgId, query.userCode);
    if (result.status === 'consumed' && result.connectionId) {
      const online = new Set(this.tunnel.listConnectedAgents());
      return { ...result, connected: online.has(result.connectionId) };
    }
    return result;
  }
}
