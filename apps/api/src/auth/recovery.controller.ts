import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser, Public } from './auth.decorators';
import { RateLimit, RateLimitGuard } from './rate-limit.guard';
import { ForgotDto, ResetDto, VerifyDto } from './recovery.dto';
import { RecoveryService } from './recovery.service';

/**
 * Password recovery and address verification by emailed link.
 *
 * Every route answers 200 rather than 201: nothing here creates a resource,
 * and the forgot route in particular must look identical for every address.
 * The per-IP limits are generous enough for a classroom behind one NAT and
 * tight enough that a script cannot use forgot as a mail cannon.
 */
@Controller('auth')
@UseGuards(RateLimitGuard)
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @Public()
  @RateLimit(10, 900)
  @HttpCode(200)
  @Post('forgot')
  forgot(@Body() dto: ForgotDto) {
    return this.recovery.forgot(dto.email);
  }

  @Public()
  @RateLimit(10, 900)
  @HttpCode(200)
  @Post('reset')
  reset(@Body() dto: ResetDto) {
    return this.recovery.reset(dto.token || '', dto.password, dto.email, dto.code);
  }

  /** Per account, since the caller is signed in: five mails an hour is plenty. */
  @RateLimit(5, 3600)
  @HttpCode(200)
  @Post('verify/request')
  requestVerification(@CurrentUser() user: AuthUser) {
    return this.recovery.requestVerification(user.id);
  }

  @Public()
  @RateLimit(20, 900)
  @HttpCode(200)
  @Post('verify')
  verify(@Body() dto: VerifyDto) {
    return this.recovery.verify(dto.token);
  }

  @Get('verify/status')
  status(@CurrentUser() user: AuthUser) {
    return this.recovery.status(user.id);
  }
}
