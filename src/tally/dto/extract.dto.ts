import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Tally dates are YYYYMMDD with no separators. */
const TALLY_DATE = /^\d{8}$/;

export class ExtractLedgersDto {
  /**
   * Exact company name as shown in Tally. Optional — falls back to
   * TALLY_DEFAULT_COMPANY when omitted.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  company?: string;
}

export class ExtractVouchersDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  company?: string;

  @IsString()
  @Matches(TALLY_DATE, { message: 'from must be in YYYYMMDD format, e.g. 20250401' })
  from!: string;

  @IsString()
  @Matches(TALLY_DATE, { message: 'to must be in YYYYMMDD format, e.g. 20250430' })
  to!: string;

  /** e.g. Sales, Purchase, Payment, Receipt, Journal. Omit for all types. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  voucherType?: string;
}

export class RawReportDto {
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  reportName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  company?: string;

  @IsOptional()
  @IsString()
  @Matches(TALLY_DATE, { message: 'fromDate must be YYYYMMDD' })
  fromDate?: string;

  @IsOptional()
  @IsString()
  @Matches(TALLY_DATE, { message: 'toDate must be YYYYMMDD' })
  toDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  voucherType?: string;
}
