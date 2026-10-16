import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { AuthService, JwtPayload } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/** Identical response regardless of whether the email matched an account —
 *  see AuthService.requestPasswordReset's doc comment for why. */
const REQUEST_RESET_RESPONSE = {
  message: 'If an account exists for that email, a password reset code has been sent.',
};

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Creates a new Org and its first User. There is no separate invite/join flow yet. */
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  /** Always returns the same generic body — never reveals whether `email`
   *  matched a real account. The actual 4-digit code (if any) goes out by
   *  email, or to the server log outside production — see
   *  NotificationsService.sendPasswordResetOtp / AuthService's
   *  DEV_FIXED_OTP doc comment. */
  @Post('request-password-reset')
  @HttpCode(HttpStatus.OK)
  async requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    await this.auth.requestPasswordReset(dto.email);
    return REQUEST_RESET_RESPONSE;
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.email, dto.otp, dto.newPassword);
    return { message: 'Password reset — you can now log in with your new password.' };
  }

  /** Proves the guard works end-to-end; also what the panel calls on load to check the session. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: JwtPayload) {
    return user;
  }
}
