import { ExtractVouchersDto, RawReportDto } from './dto/extract.dto';
import { MasterExtractionService } from './extraction/master-extraction.service';
import { TransactionExtractionService } from './extraction/transaction-extraction.service';
import { TallyDiagnosticsService } from './tally-diagnostics.service';
import { TunnelAction } from '../tunnel/tunnel-protocol';

export interface ExtractionDispatchServices {
  masters: MasterExtractionService;
  transactions: TransactionExtractionService;
  diagnostics: TallyDiagnosticsService;
}

/**
 * Maps a generic action + payload to the concrete typed extraction call.
 * Shared by two callers that otherwise have nothing to do with each other:
 * AgentTunnelClient (dispatching a command that arrived over the WebSocket
 * tunnel, against the connector machine's own Tally) and the cloud backend's
 * own local-mode job processor (dispatching a queued /tally/jobs request
 * directly, no agent involved). Same action vocabulary, same payload shape —
 * only which service instances (and therefore which Tally the calls actually
 * reach) differ, so this is the one place that logic needs to live.
 *
 * No manual DTO validation here (unlike the HTTP controllers, which get it
 * for free from the global ValidationPipe) — both callers' inputs already
 * passed through their own validation before reaching this point.
 */
export function dispatchExtraction(
  action: TunnelAction,
  payload: Record<string, unknown>,
  services: ExtractionDispatchServices,
  signal?: AbortSignal,
): Promise<unknown> {
  const { masters, transactions, diagnostics } = services;
  switch (action) {
    case 'probe':
      return diagnostics.probe(signal);
    case 'companies':
      return masters.getCompanies(payload.fresh !== true);
    case 'ledgers':
      return masters.getLedgers(
        payload.company as string | undefined,
        payload.fromDate as string | undefined,
        payload.toDate as string | undefined,
        signal,
      );
    case 'stockItems':
      return masters.getStockItems(
        payload.company as string | undefined,
        payload.fromDate as string | undefined,
        payload.toDate as string | undefined,
        signal,
      );
    case 'groups':
      return masters.getGroups(payload.company as string | undefined);
    case 'vouchers':
      return transactions.getVouchers(payload as unknown as ExtractVouchersDto, signal);
    case 'raw':
      return diagnostics.getRaw(payload as unknown as RawReportDto, signal);
  }
}
