import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { normalizeUserCode, USER_CODE_PATTERN } from './user-code.util';

export class DeviceStatusQueryDto {
  /** The short code the human approved — used to look up its current pairing state. */
  @IsString()
  @Transform(normalizeUserCode)
  @Matches(USER_CODE_PATTERN, { message: 'userCode must look like XXXX-XXXX' })
  userCode!: string;
}
