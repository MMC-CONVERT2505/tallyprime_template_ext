import { Injectable } from '@nestjs/common';
import { RawReportDto } from './dto/extract.dto';
import { ExtractionType, TallyExtractionServiceBase } from './extraction/tally-extraction.base';

export interface TallyProbeResult {
  reachable: true;
  companies: string[];
  durationMs: number;
}

export interface RawExtractionResult {
  reportName: string;
  company: string | null;
  rawXml: string;
  bytes: number;
}

/**
 * Connectivity probing and the raw-report escape hatch — deliberately not
 * "master" or "transaction" extraction, so it lives outside
 * MasterExtractionService/TransactionExtractionService:
 *   - probe() never persists an audit row (health runs frequently and must
 *     reflect live reality, not a cached/audited view).
 *   - getRaw() is for onboarding/exploring a report this project hasn't
 *     modelled a typed extraction for yet — not a supported extraction type.
 */
@Injectable()
export class TallyDiagnosticsService extends TallyExtractionServiceBase {
  /**
   * Lightweight reachability + discovery probe used by the health check.
   * Deliberately does NOT write a job row (health runs frequently) and does not
   * use the cache (health must reflect live reality).
   */
  async probe(signal?: AbortSignal): Promise<TallyProbeResult> {
    const startedAt = Date.now();
    const xml = this.builder.buildCompaniesRequest();
    // Fast-fail, no retries: this IS the health check — silently retrying
    // internally before answering would make "is Tally up?" take as long as a
    // real extraction call (up to timeoutMs * (maxRetries + 1) + backoff).
    const raw = await this.connector.post(xml, {
      timeoutMs: this.tally.probeTimeoutMs,
      retries: 0,
      signal,
    });
    const companies = this.parser.mapCompanies(raw);
    return {
      reachable: true,
      companies: companies.map((c) => c.name).filter(Boolean),
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Escape hatch for arbitrary report requests — returns the raw XML (and a
   * parse-validated flag) so you can explore reports/collections we have not yet
   * modelled. Useful during onboarding of a new client's Tally.
   */
  async getRaw(dto: RawReportDto, signal?: AbortSignal): Promise<RawExtractionResult> {
    const resolved = dto.company ? dto.company : this.tally.defaultCompany || null;
    const xml = this.builder.buildReportRequest({
      reportName: dto.reportName,
      company: resolved ?? undefined,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      voucherType: dto.voucherType,
    });

    return this.runExtraction(ExtractionType.RAW, resolved, { ...dto }, async () => {
      const raw = await this.connector.post(xml, { signal });
      // Validate it parses (surfaces LINEERROR) but still return the raw body.
      this.parser.parse(raw);
      return { reportName: dto.reportName, company: resolved, rawXml: raw, bytes: raw.length };
    });
  }
}
