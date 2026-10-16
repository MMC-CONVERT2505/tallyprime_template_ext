import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class RequestPasswordResetDto {
  @IsEmail()
  @MaxLength(255)
  @Transform(trim)
  email!: string;
}
