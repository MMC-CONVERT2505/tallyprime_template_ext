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
 * needed on top of this: Tally's Day Book export already accepts
 * `voucherType` as a filter, so "fetch only Sales vouchers" is a parameter,
 * not a different code path.
 */
@Injectable()
export class TransactionExtractionService extends TallyExtractionServiceBase {
  async getVouchers(dto: ExtractVouchersDto, signal?: AbortSignal): Promise<TallyVoucher[]> {
    const resolved = this.resolveCompany(dto.company);
    this.assertDateRange(dto.from, dto.to);

    return this.runExtraction(
      ExtractionType.VOUCHERS,
      resolved,
      { company: resolved, from: dto.from, to: dto.to, voucherType: dto.voucherType ?? null },
      (job) => this.fetchVouchersChunked(resolved, dto, signal, job),
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
      return this.parser.mapVouchers(raw);
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
    return this.dedupeVouchers(results);
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
