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
 * Today this covers the Day Book export (all voucher types, or one filtered
 * type via `voucherType`) — the actual requirement per
 * docs/tally-zoho-function-mapping.md's Transactions table (#14-24, #30-33).
 * A dedicated per-voucher-type method (fetchSales/fetchPurchases/...) isn't
 * needed on top of this: "fetch only Sales vouchers" is a parameter, not a
 * different code path.
 *
 * The `VOUCHERTYPENAME` static variable sent with the request (see
 * envelope.builder.ts's buildVouchersRequest) does NOT actually narrow
 * Tally's Day Book export — confirmed live 2026-08-22: four bulk-export
 * requests for four different voucher types each returned the exact same
 * unfiltered result set. filterByVoucherType below is the real filter; the
 * static variable is left in place as a harmless best-effort hint (it costs
 * nothing and may narrow the export on some Tally versions/reports) but is
 * never trusted alone.
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
        `${parsed.length} record(s) in ${Date.now() - startedAt}ms`;
      this.logger.log(`  ${progressMsg}`);
      await this.reportProgress(job ?? null, progressMsg);

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
