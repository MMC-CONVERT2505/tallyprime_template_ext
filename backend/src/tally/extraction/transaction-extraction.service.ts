import { Injectable } from '@nestjs/common';
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
      async () => {
        const xml = this.builder.buildVouchersRequest(resolved, dto.from, dto.to, dto.voucherType);
        const raw = await this.connector.post(xml);
        return this.parser.mapVouchers(raw);
      },
    );
  }
}
