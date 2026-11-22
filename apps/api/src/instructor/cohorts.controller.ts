import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { ConsoleRateLimit, RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { CreateCohortDto, JoinCohortDto } from './cohorts.dto';
import { CohortsService } from './cohorts.service';

/**
 * Two prefixes in one controller because the routes are two halves of one
 * feature: the instructor mints a code under /instructor, the learner redeems
 * it under /enrollments.
 */
@Controller()
@UseGuards(RateLimitGuard)
export class CohortsController {
  constructor(private readonly cohorts: CohortsService) {}

  /**
   * Creating a class mints a join code and writes an audit row, so it is
   * counted at the console's rate, per teacher, like every other console
   * route. A teacher makes a handful of classes in a term; a loop does not.
   */
  @Roles('INSTRUCTOR', 'ADMIN')
  @ConsoleRateLimit()
  @Post('instructor/cohorts')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCohortDto) {
    return this.cohorts.create(user.id, dto.name);
  }

  @Roles('INSTRUCTOR', 'ADMIN')
  @Get('instructor/cohorts')
  list(@CurrentUser() user: AuthUser) {
    return this.cohorts.listOwned(user.id);
  }

  @Roles('LEARNER')
  @Get('enrollments/classroom')
  async classroom(@CurrentUser() user: AuthUser) {
    // Nest sends an empty body for a bare null; keep solo membership explicit JSON.
    return { classroom: await this.cohorts.classroom(user.id) };
  }

  @Roles('LEARNER')
  @Post('enrollments/leave')
  @HttpCode(200)
  leave(@CurrentUser() user: AuthUser) {
    return this.cohorts.leave(user.id);
  }

  /**
   * Learners only. An instructor's cohort column is what scopes their
   * overview, so letting staff redeem a code (which learners pass around
   * freely) would let any instructor read another instructor's class.
   *
   * The limit is a brake on guessing: 2^40 codes is out of reach anyway, but
   * a route that answers "no" to wrong guesses should not answer it quickly.
   */
  @Roles('LEARNER')
  @RateLimit(10, 60)
  @Post('enrollments/join')
  @HttpCode(200)
  join(@CurrentUser() user: AuthUser, @Body() dto: JoinCohortDto) {
    return this.cohorts.join(user.id, dto.code);
  }
}
