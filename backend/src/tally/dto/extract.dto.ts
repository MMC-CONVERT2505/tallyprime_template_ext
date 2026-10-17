import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ZohoEntityKey } from '../../mapping/zoho-entity.map';

const ZOHO_ENTITY_KEYS: ZohoEntityKey[] = [
  'COA',
  'CUSTOMER',
  'VENDOR',
  'ITEM',
  'COST_CENTRE',
  'INVOICE',
  'BILL',
  'CREDIT_NOTE',
  'STOCK_JOURNAL',
];

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

  /**
   * Optional period (YYYYMMDD) to scope Opening/Closing balance to, via
   * Tally's SVFROMDATE/SVTODATE — same as report exports. Omit both for
   * Tally's current-period balances.
   */
  @IsOptional()
  @IsString()
  @Matches(TALLY_DATE, { message: 'fromDate must be in YYYYMMDD format, e.g. 20260401' })
  fromDate?: string;

  @IsOptional()
  @IsString()
  @Matches(TALLY_DATE, { message: 'toDate must be in YYYYMMDD format, e.g. 20260430' })
  toDate?: string;
}

export class ExtractVouchersDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  company?: string;

  /**
   * Optional — omit to fetch the company's complete real history (its own
   * Tally "StartingFrom" date through today, see
   * MasterExtractionService.resolveDateRange), the same full-history default
   * Full Sync uses. A manually-guessed range that's narrower than the
   * company's real books used to silently return fewer/zero vouchers instead
   * of erroring; omitting both dates avoids that risk entirely.
   */
  @IsOptional()
  @IsString()
  @Matches(TALLY_DATE, { message: 'from must be in YYYYMMDD format, e.g. 20250401' })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(TALLY_DATE, { message: 'to must be in YYYYMMDD format, e.g. 20250430' })
  to?: string;

  /** e.g. Sales, Purchase, Payment, Receipt, Journal. Omit for all types. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  voucherType?: string;
}

export class FullSyncDataQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  company?: string;

  /**
   * One of the strings TallyFullSyncService.listKnownEntityTypes returns for
   * this company right now (e.g. "LEDGERS", "VOUCHERS:Sales") — validated
   * against that live list server-side, not against a fixed enum here, since
   * the voucher-type-derived keys are free-form and company-specific.
   */
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  entityType!: string;
}

export class FullSyncMappedQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  company?: string;

  @IsIn(ZOHO_ENTITY_KEYS)
  entity!: ZohoEntityKey;
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
