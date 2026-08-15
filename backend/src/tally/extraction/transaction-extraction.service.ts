import { Injectable } from '@nestjs/common';
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
  async getVouchers(dto: ExtractVouchersDto): Promise<TallyVoucher[]> {
    const resolved = this.resolveCompany(dto.company);
    this.assertDateRange(dto.from, dto.to);

    return this.runExtraction(
      ExtractionType.VOUCHERS,
      resolved,
      { company: resolved, from: dto.from, to: dto.to, voucherType: dto.voucherType ?? null },
      () => this.fetchVouchersChunked(resolved, dto),
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
  ): Promise<TallyVoucher[]> {
    const chunks = chunkDateRange(dto.from, dto.to, this.tally.voucherChunkDays);
    if (chunks.length <= 1) {
      const xml = this.builder.buildVouchersRequest(company, dto.from, dto.to, dto.voucherType);
      const raw = await this.connector.post(xml);
      return this.parser.mapVouchers(raw);
    }

    this.logger.log(
      `VOUCHERS ${dto.from}-${dto.to} spans more than ${this.tally.voucherChunkDays} day(s) — ` +
        `splitting into ${chunks.length} request(s).`,
    );

    const results: TallyVoucher[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const startedAt = Date.now();
      const xml = this.builder.buildVouchersRequest(company, chunk.from, chunk.to, dto.voucherType);
      const raw = await this.connector.post(xml, { retries: 0 });
      const parsed = this.parser.mapVouchers(raw);
      results.push(...parsed);
      this.logger.log(
        `  chunk ${index + 1}/${chunks.length} (${chunk.from}-${chunk.to}): ` +
          `${parsed.length} record(s) in ${Date.now() - startedAt}ms`,
      );

      // Pace requests rather than firing the next chunk the instant this one
      // lands — Tally serves one request at a time on hardware that's often
      // resource-constrained; back-to-back chunks just queue up pressure
      // instead of finishing any faster. No pause after the last chunk.
      const isLastChunk = index === chunks.length - 1;
      if (!isLastChunk && this.tally.chunkDelayMs > 0) {
        await this.sleep(this.tally.chunkDelayMs);
      }
    }
    return results;
  }
}
