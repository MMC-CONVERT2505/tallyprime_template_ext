import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import { CreateLedgerDto } from '../tally/dto/create-ledger.dto';
import { ExtractVouchersDto, RawReportDto } from '../tally/dto/extract.dto';
import { TallyService } from '../tally/tally.service';
import {
  AgentResultMessage,
  GatewayToAgentMessage,
  TunnelAction,
} from '../tunnel/tunnel-protocol';

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Outbound WebSocket client run by the connector/agent process (agent-main.ts).
 * Connects out to the cloud gateway — never accepts inbound connections, since
 * the client machine is behind a NAT/firewall the cloud can't reach (see
 * docs/architecture.md). Reconnects with exponential backoff; "disconnected"
 * is a normal, frequent state (sleep, reboot, WiFi drop), not an error.
 *
 * Dispatch here is a thin transport swap over the exact same TallyService used
 * by TallyController today — see tally.service.ts's doc comment on why its
 * Postgres/Redis dependencies are @Optional() (both absent here by design).
 */
@Injectable()
export class AgentTunnelClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentTunnelClient.name);
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closing = false;

  constructor(
    private readonly config: ConfigService,
    private readonly tally: TallyService,
  ) {}

  onModuleInit(): void {
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
    const gatewayUrl = this.config.get<string>('gatewayUrl')!;
    const agentToken = this.config.get<string>('agentToken')!;

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
      this.logger.error(`Gateway rejected this agent: ${message.message}`);
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
        return this.tally.probe();
      case 'companies':
        return this.tally.getCompanies(payload.fresh !== true);
      case 'ledgers':
        return this.tally.getLedgers(payload.company as string | undefined);
      case 'stockItems':
        return this.tally.getStockItems(payload.company as string | undefined);
      case 'vouchers':
        return this.tally.getVouchers(payload as unknown as ExtractVouchersDto);
      case 'createLedger':
        return this.tally.createLedger(payload as unknown as CreateLedgerDto);
      case 'raw':
        return this.tally.getRaw(payload as unknown as RawReportDto);
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
