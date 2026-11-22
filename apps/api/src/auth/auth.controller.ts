import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { config } from '../config';
import { RegisterDto, LoginDto } from '../dto';
import { AuthUser, CurrentUser, Public } from './auth.decorators';
import { AuthService } from './auth.service';
import { bearerToken } from './bearer';
import { RateLimit, RateLimitGuard } from './rate-limit.guard';

/**
 * How the two sign-in routes are limited, and why they are limited twice.
 *
 * A cohort arrives through one venue NAT, so a per-address limit is a limit on
 * the room: at 20 and 30 per minute the twenty-first learner to register and
 * the thirty-first to sign in would be turned away by the guard before their
 * password was ever read. Counting the caller's address together
 * with the account they are signing into carries the room, because forty
 * learners are forty buckets, while one account is still held to a per-minute
 * allowance, the number that actually matters against guessing.
 *
 * The address ceiling stays as the coarse brake (bcrypt is not free, and the
 * table has to be bounded), raised to a room-sized number and settable where
 * that room is bigger: `SIGNIN_MAX_PER_ADDRESS`, documented in the runbook
 * beside `TRUSTED_PROXIES`, which is what makes the address the learner's
 * rather than the proxy's in the first place.
 */
const SIGN_IN_PER_ADDRESS = { max: config.signInMaxPerAddress, windowSeconds: 60 };
/** Password attempts on one account, from one address, per minute. */
const LOGIN_PER_ACCOUNT = 30;
/** Registrations for one account from one address per minute: a person retrying, not a script. */
const REGISTER_PER_ACCOUNT = 10;

@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RateLimit(REGISTER_PER_ACCOUNT, 60, {
    identityField: 'email',
    perAddress: SIGN_IN_PER_ADDRESS,
  })
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto.email, dto.password, dto.displayName);
  }

  @Public()
  @RateLimit(LOGIN_PER_ACCOUNT, 60, {
    identityField: 'email',
    perAddress: SIGN_IN_PER_ADDRESS,
  })
  @HttpCode(200)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.profile(user.id);
  }

  /**
   * Sign out everywhere. The token the browser holds is a week-long
   * credential, and clearing it from storage does nothing to a copy that
   * left the machine; this bumps the row's version so every token minted
   * before now is refused on its next request. No body, any role, and fast:
   * the client sends it with `keepalive` on the way out and never waits.
   */
  @RateLimit(30, 60)
  @HttpCode(200)
  @Post('logout')
  logout(@CurrentUser() user: AuthUser) {
    return this.auth.signOut(user.id);
  }

  /**
   * A fresh token for this session, asked for by the web in the background
   * while the person is using the app (lib/api.ts). The guard has already
   * checked the bearer; the service checks it again to read its sign-in time
   * and refuses (401, code `session-cap-reached`) once the managed session's
   * renewal cap has passed. Same answer shape as sign-in.
   */
  @RateLimit(30, 60)
  @HttpCode(200)
  @Post('renew')
  renew(@Headers('authorization') authorization?: string) {
    const token = bearerToken(authorization) ?? '';
    return this.auth.renewSession(token);
  }
}
