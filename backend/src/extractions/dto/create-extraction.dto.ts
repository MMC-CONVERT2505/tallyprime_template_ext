import { IsBoolean, IsIn, IsObject, IsOptional, IsUUID } from 'class-validator';
import { EXTRACTABLE_TYPES, ExtractableType } from '../extraction-action.map';

export class CreateExtractionDto {
  @IsUUID()
  connectionId!: string;

  @IsIn(EXTRACTABLE_TYPES)
  type!: ExtractableType;

  /**
   * Passed through to the corresponding extraction service method on the agent
   * (e.g. { company, from, to, voucherType } for VOUCHERS). Not validated
   * per-type here — a missing required field surfaces as a FAILED job with a
   * clear error message from the agent's own DTO validation, same as it
   * would through the direct /tally/* endpoints.
   */
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  /**
   * Bypasses ExtractionReuseService — dispatches a fresh Tally fetch even if
   * an identical request's result is still cached. Escape hatch for a caller
   * that specifically needs current data (e.g. right after a known change in
   * Tally), not a general "always refetch" toggle.
   */
  @IsOptional()
  @IsBoolean()
  forceRefresh?: boolean;
}
