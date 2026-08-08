import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateConnectionDto {
  /** Human-readable name for this connector install, e.g. "Client XYZ - Accounts PC". */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  defaultCompany?: string;
}
