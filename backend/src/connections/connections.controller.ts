import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TallyTunnelGateway } from '../gateway/tally-tunnel.gateway';
import { ConnectionsService } from './connections.service';
import { CreateConnectionDto } from './dto/create-connection.dto';

@Controller('connections')
@UseGuards(JwtAuthGuard)
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly tunnel: TallyTunnelGateway,
  ) {}

  /**
   * The returned `token` is shown exactly once — it's what goes in the connector's own .env as AGENT_TOKEN.
   * Safe to re-run for a company you've already paired: if an active connection already exists for
   * `defaultCompany` within this org, its token is rotated and `reused: true` is returned instead of
   * inserting a duplicate row — see ConnectionsService.upsertForCompany.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateConnectionDto) {
    return this.connections.create(user.orgId, dto);
  }

  /** Includes live `connected` status by cross-referencing the gateway's in-memory registry. */
  @Get()
  async list(@CurrentUser() user: JwtPayload) {
    const connections = await this.connections.list(user.orgId);
    const online = new Set(this.tunnel.listConnectedAgents());
    return connections.map((c) => ({ ...c, connected: online.has(c.id) }));
  }

  /** Marks the connection inactive AND, if it currently has a live tunnel open, closes that socket. */
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.connections.revoke(user.orgId, id);
    this.tunnel.disconnectAgent(id, 'connection revoked');
    return { revoked: true };
  }

  /**
   * Mints a fresh token for this same connection (e.g. the original was lost,
   * or you want to rotate it) — use this instead of `POST /connections`
   * when re-pairing the same device, so you don't end up with two active
   * connections for the same company (which makes `fetch-master` ambiguous).
   * Disconnects any live session using the old token, same as revoke, so a
   * currently-running agent must be restarted with the new one.
   */
  @Post(':id/rotate-token')
  @HttpCode(HttpStatus.CREATED)
  async rotateToken(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const result = await this.connections.rotateToken(user.orgId, id);
    this.tunnel.disconnectAgent(id, 'token rotated');
    return result;
  }
}
