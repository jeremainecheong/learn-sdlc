import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { DemoClockDto } from './demo.dto';
import { DemoService } from './demo.service';

/**
 * The demo clock, and nothing else. Admin-only, and 404 on any deployment that
 * did not ask for it by name (DemoService.assertAvailable).
 *
 * The role is checked by the service rather than by `@Roles('ADMIN')` here,
 * on purpose: the roles guard answers 403 before the service can answer 404,
 * and "insufficient role" told every signed-in learner on every build that
 * this API has a demo clock. The service answers the same plain 404 to a
 * non-admin as it does to a build without the clock.
 *
 * The limit is sized for the seeder, which moves the clock about twenty times
 * in a run and never twice in the same instant; a person moves it never.
 */
@Controller('demo')
@UseGuards(RateLimitGuard)
@RateLimit(120, 60)
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Get('clock')
  clock(@CurrentUser() user: AuthUser) {
    return this.demo.state(user);
  }

  @HttpCode(200)
  @Post('clock')
  setClock(@CurrentUser() user: AuthUser, @Body() dto: DemoClockDto) {
    return this.demo.set(user, dto);
  }
}
