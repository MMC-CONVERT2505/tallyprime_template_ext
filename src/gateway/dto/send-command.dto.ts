import { IsIn, IsObject, IsOptional } from 'class-validator';
import { TUNNEL_ACTIONS, TunnelAction } from '../../tunnel/tunnel-protocol';

export class SendCommandDto {
  @IsIn(TUNNEL_ACTIONS)
  action!: TunnelAction;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
