import { Injectable } from '@nestjs/common';
import { ExtractionJob } from '@prisma/client';
import { chunkDateRange } from '../date-range-chunker';
import { ExtractVouchersDto } from '../dto/extract.dto';
import { TallyVoucher } from '../interfaces/tally.interfaces';
import { ExtractionType, TallyExtractionServiceBase } from './tally-extraction.base';

/**
 * Transactional (voucher) extraction, kept separate from
 * MasterExtractionService per docs/tally-zoho-function-mapping.md's own
 * Masters/Transactions split — masters must be resolved first (a voucher
 * can't be mapped correctly without knowing its ledger's group), so they're a
 * different concern with a different request shape (always date-ranged,
 * never cached, optionally filtered by voucher type).
 *
 * Today this covers all voucher types (or one filtered type via
 * `voucherType`) for a date range — the actual requirement per
 * docs/tally-zoho-function-mapping.md's Transactions table (#14-24, #30-33).
 * A dedicated per-voucher-type method (fetchSales/fetchPurchases/...) isn't
 * needed on top of this: "fetch only Sales vouchers" is a parameter, not a
 * different code path.
 *
 * Fetched via a `TYPE=Voucher` Collection request (EnvelopeBuilder.
 * buildVouchersRequest), NOT the "Day Book" report export this used to be —
 * confirmed live 2026-08-25: the Day Book report ignores its SVFROMDATE/
 * SVTODATE date scoping outright on a real TallyPrime build, returning the
 * same single stale voucher regardless of the requested range or company.
 * See buildVouchersRequest's own doc comment for the full evidence and why a
 * Collection's explicit `$Date` <FILTER> was verified correct instead.
 *
 * Voucher-type filtering happens entirely client-side (filterByVoucherType
 * below) — confirmed live 2026-08-22 that a request-side VOUCHERTYPENAME
 * filter does NOT narrow the result set at all (four requests for four
 * different types each returned the same unfiltered set), so
 * buildVouchersRequest doesn't send one; nothing here relies on Tally doing
 * this filtering for us.
 */
@Injectable()
export class TransactionExtractionService extends TallyExtractionServiceBase {
  async getVouchers(
    dto: ExtractVouchersDto,
    signal?: AbortSignal,
    externalJobId?: string,
  ): Promise<TallyVoucher[]> {
    const resolved = this.resolveCompany(dto.company);
    this.assertDateRange(dto.from, dto.to);

    return this.runExtraction(
      ExtractionType.VOUCHERS,
      resolved,
      { company: resolved, from: dto.from, to: dto.to, voucherType: dto.voucherType ?? null },
      (job) => this.fetchVouchersChunked(resolved, dto, signal, job),
      externalJobId,
    );
  }

  /**
   * A Day Book export's size scales with the number of days requested (unlike
   * a ledger balance-as-of-date — see date-range-chunker.ts), so a wide range
   * is split into several small, reliable requests instead of one large,
   * timeout-prone one. Below the chunk threshold this is exactly the single
   * request it always was — no behavior change for the common case.
   *
   * Above the chunk threshold, one unrestricted whole-range request is tried
   * FIRST — see tryWholeRangeFetch's doc comment for why this is a pure
   * optimization, never a correctness risk. Only on its failure/timeout does
   * this fall through to the proven-safe chunked loop below.
   *
   * Each chunk uses `retries: 0`: chunking already trades "one big risky call"
   * for "several small reliable ones," so a chunk that times out anyway is
   * more likely a genuinely stuck Tally than a transient blip — nested
   * per-chunk retries would just multiply the worst-case wait across every
   * chunk. If a chunk does fail, the whole call throws (no silent partial
   * data); BullMQ's existing job-level retry covers genuine transient issues.
   */
  private async fetchVouchersChunked(
    company: string,
    dto: ExtractVouchersDto,
    signal?: AbortSignal,
    job?: ExtractionJob | null,
  ): Promise<TallyVoucher[]> {
    const chunks = chunkDateRange(dto.from, dto.to, this.tally.voucherChunkDays);
    if (chunks.length <= 1) {
      const xml = this.builder.buildVouchersRequest(company, dto.from, dto.to, dto.voucherType);
      const raw = await this.connector.post(xml, { signal });
      return this.filterByVoucherType(this.parser.mapVouchers(raw), dto.voucherType);
    }

    const wholeRangeResult = await this.tryWholeRangeFetch(company, dto, signal, job);
    if (wholeRangeResult !== null) return wholeRangeResult;

    this.logger.log(
      `VOUCHERS ${dto.from}-${dto.to} spans more than ${this.tally.voucherChunkDays} day(s) — ` +
        `splitting into ${chunks.length} request(s).`,
    );

    const results: TallyVoucher[] = [];
    for (const [index, chunk] of chunks.entries()) {
      if (signal?.aborted) throw new Error('Extraction cancelled.');
      const startedAt = Date.now();
      const xml = this.builder.buildVouchersRequest(company, chunk.from, chunk.to, dto.voucherType);
      const raw = await this.connector.post(xml, { retries: 0, signal });
      const parsed = this.parser.mapVouchers(raw);
      results.push(...parsed);
      const progressMsg =
        `chunk ${index + 1}/${chunks.length} (${chunk.from}-${chunk.to}): ` +
        `${parsed.length} record(s) in ${Date.now() - startedAt}ms, ` +
        `${results.length} total so far`;
      this.logger.log(`  ${progressMsg}`);
      // Cumulative across every chunk fetched so far, not just this one —
      // pre-dedup/pre-filter (those only run once, on the full set, after
      // the loop ends), so it can only ever overstate the final count
      // slightly (a leaked duplicate — see dedupeVouchers — counted more
      // than once mid-flight), never understate it.
      await this.reportProgress(job ?? null, progressMsg, results.length);

      // Pace requests rather than firing the next chunk the instant this one
      // lands — Tally serves one request at a time on hardware that's often
      // resource-constrained; back-to-back chunks just queue up pressure
      // instead of finishing any faster. No pause after the last chunk.
      const isLastChunk = index === chunks.length - 1;
      if (!isLastChunk && this.tally.chunkDelayMs > 0) {
        await this.sleep(this.tally.chunkDelayMs, signal);
      }
    }
    return this.filterByVoucherType(this.dedupeVouchers(results), dto.voucherType);
  }

  /**
   * Confirmed live 2026-08-24: a wide-range company with little or no data
   * for the requested voucher type still paid the FULL chunked cost —
   * hundreds of sequential requests, each paced by TallyConfig.chunkDelayMs,
   * adding up to 45+ minutes across a bulk export's 4 voucher types — purely
   * to discover there was nothing to find. A single unrestricted request
   * across the whole range answers just as correctly, and empirically just
   * as fast, for a sparse company (confirmed: a live probe spanning
   * 2000-01-01..2026-08-22 for this same company answered in 42ms) —
   * chunking exists only to keep a request from timing out when there's
   * genuinely a lot to fetch (see this class's own doc comment), so trying
   * the cheap path first and falling back to the proven-safe chunked path on
   * failure is a pure optimization, never a correctness risk: on failure or
   * timeout, behavior past this point is byte-for-byte identical to before
   * this method existed — no data is ever silently skipped, only the (still
   * fully retried via the chunked loop) discovery of it is reordered.
   *
   * Deliberately reuses the standard TallyConfig.timeoutMs budget (via
   * `retries: 0`, no `timeoutMs` override) rather than a new, shorter
   * tunable — that's exactly the ceiling a single unchunked (in-range)
   * VOUCHERS request already tolerates today, so a moderately-sized company
   * that would genuinely finish in, say, 20s isn't wrongly abandoned early
   * just to save a few seconds on the companies this targets.
   *
   * Returns `null` (never an empty array) to signal "no answer — fall back
   * to chunking," so a genuine zero-record result from a successful
   * whole-range fetch is never confused with a failed one.
   */
  private async tryWholeRangeFetch(
    company: string,
    dto: ExtractVouchersDto,
    signal: AbortSignal | undefined,
    job: ExtractionJob | null | undefined,
  ): Promise<TallyVoucher[] | null> {
    const startedAt = Date.now();
    let raw: string;
    try {
      const xml = this.builder.buildVouchersRequest(company, dto.from, dto.to, dto.voucherType);
      raw = await this.connector.post(xml, { retries: 0, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.log(
        `VOUCHERS ${dto.from}-${dto.to}: whole-range attempt failed after ` +
          `${Date.now() - startedAt}ms (${message}) — falling back to chunked requests.`,
      );
      return null;
    }

    const result = this.filterByVoucherType(
      this.dedupeVouchers(this.parser.mapVouchers(raw)),
      dto.voucherType,
    );
    const progressMsg =
      `VOUCHERS ${dto.from}-${dto.to}: whole-range request answered in ` +
      `${Date.now() - startedAt}ms (${result.length} record(s)) — chunking skipped entirely.`;
    this.logger.log(`  ${progressMsg}`);
    await this.reportProgress(job ?? null, progressMsg, result.length);
    return result;
  }

  /**
   * The real voucher-type filter — see this class's doc comment for why the
   * request-side VOUCHERTYPENAME static variable can't be trusted alone.
   * Case/whitespace-insensitive: Tally's own voucher-type names in the
   * parsed XML have shown no casing variance in practice, but this is a
   * cheap safety margin against a company-customized type name differing
   * only by case. A no-op when no type filter was requested.
   */
  private filterByVoucherType(vouchers: TallyVoucher[], voucherType?: string): TallyVoucher[] {
    if (!voucherType) return vouchers;
    const target = voucherType.trim().toLowerCase();
    return vouchers.filter((v) => v.voucherType?.trim().toLowerCase() === target);
  }

  /**
   * Observed against a live TallyPrime instance: chunked Day Book requests
   * can leak the same voucher into every chunk's response, even chunks whose
   * SVFROMDATE/SVTODATE window doesn't contain that voucher's date — Tally's
   * report engine doesn't appear to fully reset internal state between
   * back-to-back "Export Data" requests for the same report/company a few
   * seconds apart. Deduping by AlterID (Tally's own per-record change
   * counter — unique per record, unlike voucher number which can repeat
   * across voucher types) removes exactly those leaked repeats. Falls back
   * to a composite key only for the rare record with no AlterID at all.
   */
  private dedupeVouchers(vouchers: TallyVoucher[]): TallyVoucher[] {
    const seen = new Set<string>();
    const deduped: TallyVoucher[] = [];
    for (const v of vouchers) {
      const key =
        v.alterId !== null
          ? `id:${v.alterId}`
          : `composite:${v.date}|${v.voucherType}|${v.voucherNumber}|${v.partyLedgerName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(v);
    }
    return deduped;
  }
}
