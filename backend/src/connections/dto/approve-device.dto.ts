import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Normalizes the human-typed code: trim, uppercase, tolerate a missing/extra dash. */
const normalizeUserCode = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class ApproveDeviceDto {
  /** The short code displayed by the connector, e.g. "WXYZ-2H4K". */
  @IsString()
  @Transform(normalizeUserCode)
  @Matches(/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/, { message: 'userCode must look like XXXX-XXXX' })
  userCode!: string;

  /** Human-readable label for this connector install, e.g. "Accounts PC". Optional — a default is used if omitted. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  label?: string;

  /** Exact Tally company name to pin this connector to. Optional — leave unset for a connector serving multiple companies. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  defaultCompany?: string;
}
