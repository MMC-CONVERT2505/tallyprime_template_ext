import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { MASTER_EXTRACTABLE_TYPES, MasterExtractableType } from '../extraction-action.map';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Public-facing convention for this endpoint is ISO 8601 (YYYY-MM-DD), unlike
 * the internal /tally/* and /extractions endpoints which speak Tally's native
 * YYYYMMDD directly. Converted here so everything downstream (EnvelopeBuilder,
 * MasterExtractionService) only ever sees YYYYMMDD.
 */
const toTallyDate = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replaceAll('-', '') : value;

export class FetchMasterDto {
  /** Exact company name as configured on the target connector (TallyConnection.defaultCompany). */
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  companyName!: string;

  /** Which Tally master to extract — see MASTER_EXTRACTABLE_TYPES. */
  @IsIn(MASTER_EXTRACTABLE_TYPES)
  masterType!: MasterExtractableType;

  /** Period start (YYYY-MM-DD). Only meaningful for LEDGERS/STOCK_ITEMS balances; ignored otherwise. */
  @IsOptional()
  @Transform(toTallyDate)
  @Matches(/^\d{8}$/, { message: 'fromDate must be a valid date (YYYY-MM-DD)' })
  fromDate?: string;

  /** Period end (YYYY-MM-DD). See fromDate. */
  @IsOptional()
  @Transform(toTallyDate)
  @Matches(/^\d{8}$/, { message: 'toDate must be a valid date (YYYY-MM-DD)' })
  toDate?: string;
}
