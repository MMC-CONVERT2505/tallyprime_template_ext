import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApproveDeviceDto } from './dto/approve-device.dto';
import { PollDeviceTokenDto } from './dto/poll-device-token.dto';
import { DeviceAuthService } from './device-auth.service';

/**
 * Device Authorization Grant endpoints for zero-manual-token connector
 * pairing (docs/connector-bridge-setup-guide.md). Deliberately a separate,
 * mostly-unauthenticated controller rather than routes on
 * ConnectionsController: `start`/`token` are called by a bridge that has no
 * identity yet, so they cannot sit behind JwtAuthGuard. Only `approve` —
 * the one human-mediated step — requires a signed-in user.
 */
@Controller('connections/device')
export class DeviceAuthController {
  constructor(private readonly deviceAuth: DeviceAuthService) {}

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
}
