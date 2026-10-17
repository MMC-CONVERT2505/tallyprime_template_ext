import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TallyTunnelGateway } from '../gateway/tally-tunnel.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { ConnectionsService, NewConnectionResult } from './connections.service';
import { CreateConnectionDto } from './dto/create-connection.dto';

@Controller('connections')
@UseGuards(JwtAuthGuard)
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly tunnel: TallyTunnelGateway,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The returned `token` is shown exactly once — it's what goes in the connector's own .env as AGENT_TOKEN.
   * Safe to re-run for a company you've already paired: if an active connection already exists for
   * `defaultCompany` within this org, its token is rotated and `reused: true` is returned instead of
   * inserting a duplicate row — see ConnectionsService.upsertForCompany.
   *
   * Also emails the token to the acting admin (best-effort, never blocks this
   * response) — see NotificationsService.sendConnectorToken's doc comment for
   * why: "shown exactly once in the browser" is exactly how a token gets lost.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() user: JwtPayload, @Body() dto: CreateConnectionDto) {
    const result = await this.connections.create(user.orgId, dto);
    this.emailToken(user.email, result);
    return result;
  }

  /**
   * Includes live `connected` status by cross-referencing the gateway's
   * in-memory registry. `?search=` filters by company name or label
   * (case-insensitive substring) — the admin company search.
   */
  @Get()
  async list(@CurrentUser() user: JwtPayload, @Query('search') search?: string) {
    const connections = await this.connections.list(user.orgId, search);
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
    this.emailToken(user.email, result);
    return result;
  }

  /**
   * Permanently removes the connection (unlike revoke, not reversible — see
   * ConnectionsService.delete for why this is safe regardless of the
   * connection's current state or live tunnel). Works on an active or
   * already-revoked row.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.connections.delete(user.orgId, id);
    this.tunnel.disconnectAgent(id, 'connection deleted');
    return { deleted: true };
  }

  /**
   * Fire-and-forget — see NotificationsService.sendConnectorToken's doc
   * comment. Never awaited: a slow/failed send must never delay or break the
   * response carrying the token through its normal channel. The trailing
   * .catch is deliberate even though sendConnectorToken already swallows its
   * own errors internally — this call site shouldn't have to trust that;
   * an unhandled rejection here would crash the process, not just this request.
   */
  private emailToken(to: string, result: NewConnectionResult): void {
    this.notifications
      .sendConnectorToken(to, {
        label: result.label,
        defaultCompany: result.defaultCompany,
        token: result.token,
        connectionId: result.id,
      })
      .catch(() => undefined);
  }
}
