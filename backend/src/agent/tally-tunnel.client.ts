import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import { ExtractVouchersDto, RawReportDto } from '../tally/dto/extract.dto';
import { MasterExtractionService } from '../tally/extraction/master-extraction.service';
import { TransactionExtractionService } from '../tally/extraction/transaction-extraction.service';
import { TallyDiagnosticsService } from '../tally/tally-diagnostics.service';
import {
  AgentResultMessage,
  GatewayToAgentMessage,
  TunnelAction,
} from '../tunnel/tunnel-protocol';
import { AgentPairingService } from './agent-pairing.service';

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Outbound WebSocket client run by the connector/agent process (agent-main.ts).
 * Connects out to the cloud gateway — never accepts inbound connections, since
 * the client machine is behind a NAT/firewall the cloud can't reach (see
 * docs/architecture.md). Reconnects with exponential backoff; "disconnected"
 * is a normal, frequent state (sleep, reboot, WiFi drop), not an error.
 *
 * Dispatch here is a thin transport swap over the exact same extraction
 * services TallyController uses today — see TallyExtractionServiceBase's doc
 * comment on why their Postgres/Redis dependencies are @Optional() (both
 * absent here by design). This is a read-only extraction surface: every
 * action it can dispatch to is a Tally export/report request, never a write.
 *
 * Credential handling: `agentToken` is tracked as instance state, not
 * re-read from ConfigService on every (re)connect — it can change mid-process
 * (see below), and ConfigService's snapshot from boot wouldn't reflect that.
 * If no token is configured at all (fresh install), or the gateway rejects
 * the one we have (revoked), AgentPairingService.pair() is run automatically
 * instead of failing — see docs/connector-bridge-setup-guide.md.
 */
@Injectable()
export class AgentTunnelClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentTunnelClient.name);
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private agentToken = '';

  constructor(
    private readonly config: ConfigService,
    private readonly pairing: AgentPairingService,
    private readonly masters: MasterExtractionService,
    private readonly transactions: TransactionExtractionService,
    private readonly diagnostics: TallyDiagnosticsService,
  ) {}

  onModuleInit(): void {
    this.agentToken = this.config.get<string>('agentToken') ?? '';
    this.connect();
  }

  onModuleDestroy(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  /** Exponential backoff with a ceiling. Pure function, unit-tested directly. */
  static computeBackoffMs(attempt: number): number {
    return Math.min(MIN_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  }

  private connect(): void {
    if (!this.agentToken) {
      void this.pairThenConnect();
      return;
    }
    this.openSocket(this.agentToken);
  }

  /** No token on hand (fresh install, or cleared after an auth-error) — pair first, then connect. */
  private async pairThenConnect(): Promise<void> {
    try {
      this.agentToken = await this.pairing.pair();
      this.openSocket(this.agentToken);
    } catch (err) {
      this.logger.error(
        `Device pairing failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleReconnect();
    }
  }

  private openSocket(agentToken: string): void {
    const gatewayUrl = this.config.get<string>('gatewayUrl')!;

    this.logger.log(`Connecting to gateway at ${gatewayUrl}...`);
    const ws = new WebSocket(gatewayUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      const hello = { type: 'hello' as const, token: agentToken, version: this.getVersion() };
      ws.send(JSON.stringify(hello));
    });

    ws.on('message', (raw: Buffer) => this.handleMessage(raw));

    ws.on('close', (code: number, reason: Buffer) => {
      this.logger.warn(`Gateway connection closed (${code} ${reason.toString()}).`);
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      this.logger.error(`Gateway connection error: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    const delay = AgentTunnelClient.computeBackoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.logger.log(`Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private handleMessage(raw: Buffer): void {
    let message: GatewayToAgentMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === 'hello-ack') {
      this.logger.log(`Authenticated. Agent id: ${message.agentId}`);
      return;
    }
    if (message.type === 'auth-error') {
      this.logger.error(
        `Gateway rejected this agent's token (${message.message}) — it may have been revoked or rotated. ` +
          'Clearing it and re-pairing automatically on the next reconnect.',
      );
      // The token we have is dead — don't keep retrying with it forever.
      // The socket 'close' event fires right after this (the gateway closes
      // the connection on auth-error), which triggers scheduleReconnect();
      // connect() will see no token and run pairing again.
      this.agentToken = '';
      return;
    }
    if (message.type === 'command') {
      void this.handleCommand(message.requestId, message.action, message.payload);
    }
  }

  private async handleCommand(
    requestId: string,
    action: TunnelAction,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const data = await this.dispatch(action, payload);
      this.sendResult({ type: 'result', requestId, ok: true, data });
    } catch (err) {
      this.sendResult({
        type: 'result',
        requestId,
        ok: false,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /**
   * No manual DTO validation here (unlike the HTTP controller, which gets it
   * for free from the global ValidationPipe) — this proof-of-concept dispatch
   * path is superseded by Phase 4's real job API, which is where payload
   * validation belongs long-term.
   */
  private dispatch(action: TunnelAction, payload: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case 'probe':
        return this.diagnostics.probe();
      case 'companies':
        return this.masters.getCompanies(payload.fresh !== true);
      case 'ledgers':
        return this.masters.getLedgers(
          payload.company as string | undefined,
          payload.fromDate as string | undefined,
          payload.toDate as string | undefined,
        );
      case 'stockItems':
        return this.masters.getStockItems(
          payload.company as string | undefined,
          payload.fromDate as string | undefined,
          payload.toDate as string | undefined,
        );
      case 'groups':
        return this.masters.getGroups(payload.company as string | undefined);
      case 'vouchers':
        return this.transactions.getVouchers(payload as unknown as ExtractVouchersDto);
      case 'raw':
        return this.diagnostics.getRaw(payload as unknown as RawReportDto);
    }
  }

  private sendResult(message: AgentResultMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private getVersion(): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('../../package.json').version ?? '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}
