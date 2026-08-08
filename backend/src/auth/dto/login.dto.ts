import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class LoginDto {
  @IsEmail()
  @MaxLength(255)
  @Transform(trim)
  email!: string;

  @IsString()
  @MaxLength(255)
  password!: string;
}
