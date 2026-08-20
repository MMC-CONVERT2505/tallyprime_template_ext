import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Same YYYY-MM-DD -> YYYYMMDD convention as FetchMasterDto — this is a
 *  public-facing endpoint, everything internal speaks Tally's native format. */
const toTallyDate = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replaceAll('-', '') : value;

/**
 * Kicks off a full "every Zoho-mapped entity for this company" export — see
 * BulkExportService's doc comment for the full step list. Unlike
 * FetchMasterDto, fromDate/toDate are REQUIRED here (not optional): the 4
 * VOUCHERS steps (Sales/Purchase/Credit Note/Stock Journal) have no
 * meaningful "all time" default the way a master's balance-as-of-today does
 * — Tally's Day Book export needs an explicit period regardless.
 */
export class BulkExportDto {
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  companyName!: string;

  @Transform(toTallyDate)
  @Matches(/^\d{8}$/, { message: 'fromDate must be a valid date (YYYY-MM-DD)' })
  fromDate!: string;

  @Transform(toTallyDate)
  @Matches(/^\d{8}$/, { message: 'toDate must be a valid date (YYYY-MM-DD)' })
  toDate!: string;
}
