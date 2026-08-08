import { IsString, MinLength } from 'class-validator';

export class PollDeviceTokenDto {
  @IsString()
  @MinLength(32)
  deviceCode!: string;
}
