import { Module } from '@nestjs/common';
import { TallyTunnelGateway } from './tally-tunnel.gateway';

/**
 * The Phase 1-2 proof-of-concept GatewayController (raw "list agents" /
 * "send any tunnel action to any agentId") has been removed: it was
 * superseded by the real, org-scoped job API (ConnectionsModule +
 * ExtractionsModule) and, being unscoped by org, let any authenticated user
 * list or drive *any* org's connected agent — a cross-org security hole.
 * TallyTunnelGateway itself (the actual WS transport) stays; it's only
 * reached now through ConnectionsController/ExtractionsService, both of
 * which check org ownership first.
 */
@Module({
  providers: [TallyTunnelGateway],
  exports: [TallyTunnelGateway],
})
export class GatewayModule {}
