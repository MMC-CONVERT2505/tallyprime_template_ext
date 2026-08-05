import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthConfig } from '../../config/configuration';
import { JwtPayload } from '../auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const auth = config.getOrThrow<AuthConfig>('auth');
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: auth.jwtSecret,
    });
  }

  // Whatever this returns becomes `req.user`. No DB lookup here by design —
  // the token payload is trusted for the token's lifetime (short-lived,
  // JWT_EXPIRES_IN). Revocation-on-demand would need a DB check per request;
  // not needed yet (see docs/architecture.md Phase 3 for where that becomes real).
  validate(payload: JwtPayload): JwtPayload {
    return payload;
  }
}
