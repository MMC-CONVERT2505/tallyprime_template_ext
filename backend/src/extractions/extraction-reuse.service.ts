import { Inject, Injectable, Logger } from '@nestjs/common';
import { ExtractionJob, ExtractionType } from '@prisma/client';
import Redis from 'ioredis';
import { PrismaService } from '../database/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ExtractableType } from './extraction-action.map';
import { extractionResultKey, REUSE_CANDIDATE_LOOKBACK } from './extractions.constants';

/**
 * Types with no meaningful reuse equality: COMPANIES already has its own
 * purpose-built 15-second cache (MasterExtractionService.getCompanies,
 * `tally:companies`) that a much-longer-lived reuse window here would
 * silently shadow with stale-for-up-to-an-hour data; RAW's payload is an
 * opaque escape hatch with no defined notion of "the same request."
 */
const REUSE_INELIGIBLE_TYPES: ReadonlySet<ExtractableType> = new Set([
  ExtractionType.COMPANIES,
  ExtractionType.RAW,
]);

/**
 * Master types whose params carry a date scope that must match EXACTLY, not
 * by containment — a period-scoped balance and an unscoped one are
 * different numbers for the same ledger/item, not a range union (see
 * MasterExtractionService.getLedgers/getStockItems and
 * EnvelopeBuilder's SVFROMDATE/SVTODATE handling).
 */
const DATE_SCOPED_MASTER_TYPES: ReadonlySet<ExtractableType> = new Set([
  ExtractionType.LEDGERS,
  ExtractionType.STOCK_ITEMS,
]);

/**
 * Finds a prior SUCCESS ExtractionJob whose request was IDENTICAL to the one
 * about to be dispatched, so ExtractionsService.enqueue can hand back its
 * already-cached result instead of hitting Tally again. Deliberately
 * exact-match only, per type:
 *   - GROUPS / COST_CENTRES: no date params — same {orgId, connectionId,
 *     type, company}, most recent SUCCESS.
 *   - LEDGERS / STOCK_ITEMS: same, PLUS an exact fromDate/toDate match.
 *   - VOUCHERS: same, PLUS an exact {voucherType, from, to} match.
 *   - COMPANIES / RAW: never reused (see REUSE_INELIGIBLE_TYPES).
 *
 * "Overlapping-but-not-identical" ranges (e.g. a cached full year satisfying
 * a one-month request within it) are a deliberately out-of-scope follow-up —
 * see docs/architecture.md or the PR that introduced this service for why:
 * it would require synthesizing a derived job + date-filtering the cached
 * data, materially more surface area than exact-match reuse.
 *
 * A Postgres SUCCESS row never expires on its own, but the job's cached
 * result in Redis does (see extractionResultKey's TTL) — so Redis presence
 * is the freshness bound, not a separately-configured window.
 */
@Injectable()
export class ExtractionReuseService {
  private readonly logger = new Logger(ExtractionReuseService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async findReusable(
    orgId: string,
    connectionId: string,
    type: ExtractableType,
    payload: Record<string, unknown>,
  ): Promise<ExtractionJob | null> {
    if (REUSE_INELIGIBLE_TYPES.has(type)) return null;

    const company = typeof payload.company === 'string' ? payload.company : undefined;
    if (!company) return null;

    const candidates = await this.prisma.extractionJob.findMany({
      where: { orgId, connectionId, type, company, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
      take: REUSE_CANDIDATE_LOOKBACK,
    });

    for (const candidate of candidates) {
      if (!this.matches(type, payload, candidate)) continue;

      if (await this.isResultCached(candidate.id)) {
        this.logger.log(
          `Reusing job ${candidate.id} (${type}, "${company}") for an identical request — ` +
            'no new Tally dispatch.',
        );
        return candidate;
      }
      // This is the MOST RECENT matching job (candidates are newest-first)
      // and its cached result has already expired — every older matching
      // candidate expires strictly earlier (same fixed TTL from an earlier
      // createdAt), so it's provably also expired. No point checking further.
      this.logger.debug(
        `Newest matching job ${candidate.id} (${type}, "${company}") has no cached result left ` +
          '(expired) — not reusable, dispatching fresh.',
      );
      break;
    }
    return null;
  }

  /**
   * Shared with BulkExportService.retry, which must re-validate a
   * previously-SUCCESS step's cached result before trusting it: the result
   * TTL (extractionResultKey, default 1h) is much shorter than a
   * BulkExportRecord's own TTL (default 7 days), so a step marked SUCCESS
   * days ago can have long since lost its underlying Redis data.
   */
  async isResultCached(jobId: string): Promise<boolean> {
    const exists = await this.redis.exists(extractionResultKey(jobId));
    return exists === 1;
  }

  private matches(
    type: ExtractableType,
    payload: Record<string, unknown>,
    candidate: ExtractionJob,
  ): boolean {
    const params = (candidate.params as Record<string, unknown> | null) ?? {};

    if (type === ExtractionType.VOUCHERS) {
      return (
        this.normalize(payload.voucherType) === this.normalize(params.voucherType) &&
        this.normalize(payload.from) === this.normalize(params.from) &&
        this.normalize(payload.to) === this.normalize(params.to)
      );
    }

    if (DATE_SCOPED_MASTER_TYPES.has(type)) {
      return (
        this.normalize(payload.fromDate) === this.normalize(params.fromDate) &&
        this.normalize(payload.toDate) === this.normalize(params.toDate)
      );
    }

    // GROUPS / COST_CENTRES: no date params — the company match already
    // baked into `candidates`'s WHERE clause is the whole story.
    return true;
  }

  /** null/undefined/'' all mean "no date scope" and must compare equal — a
   *  freshly-typed request that simply omits a date field (undefined) must
   *  match a stored job whose params record that same absence as an
   *  explicit `null` (see MasterExtractionService: `fromDate: fromDate ?? null`). */
  private normalize(value: unknown): string {
    return value === undefined || value === null || value === '' ? '' : String(value);
  }
}
