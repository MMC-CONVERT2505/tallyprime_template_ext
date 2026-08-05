import { Transform } from 'class-transformer';
import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateLedgerDto {
  /** Ledger name to create, e.g. "Test Ledger". */
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  name!: string;

  /** Exact parent group name as shown in Tally, e.g. "Sundry Debtors". */
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  parent!: string;

  /**
   * Exact company name as shown in Tally. Optional — falls back to
   * TALLY_DEFAULT_COMPANY when omitted.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  company?: string;

  @IsOptional()
  @IsNumber()
  openingBalance?: number;
}
