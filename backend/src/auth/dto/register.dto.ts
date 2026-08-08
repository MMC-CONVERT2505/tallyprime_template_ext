import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class RegisterDto {
  @IsEmail()
  @MaxLength(255)
  @Transform(trim)
  email!: string;

  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  @MaxLength(255)
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  name!: string;

  /** Name of the new org this user becomes the first member of. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Transform(trim)
  orgName!: string;
}
