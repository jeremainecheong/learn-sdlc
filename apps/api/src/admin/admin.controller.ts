import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { ConsoleRateLimit, RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import {
  AdminSetPasswordDto,
  LookupUserQuery,
  ReassignCohortOwnerDto,
  UpdateUserDto,
} from './admin.dto';
import { AdminService } from './admin.service';

@Controller('admin')
@Roles('ADMIN')
// A stolen admin session is the worst case these routes have, so they are
// counted like the rest: generous for a person working through the console,
// far below what a script would want.
@UseGuards(RateLimitGuard)
@ConsoleRateLimit()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /** Lookup is by exact address: there is no listing, so no way to page through everyone. */
  @Get('users')
  lookup(@Query() query: LookupUserQuery) {
    return this.admin.lookup(query.email);
  }

  @Get('cohorts')
  cohorts() {
    return this.admin.listCohorts();
  }

  /**
   * Move a class to another instructor. The way out of the refusal an
   * instructor meets when they try to delete an account that still owns a
   * class, and the only repair for a class whose owner has already gone.
   */
  @Patch('cohorts/:id/owner')
  reassignCohortOwner(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReassignCohortOwnerDto,
  ) {
    return this.admin.reassignCohortOwner(actor.id, id, dto.ownerUserId);
  }

  @Patch('users/:id')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.admin.update(actor.id, id, {
      role: dto.role,
      cohort: dto.cohort,
      disabled: dto.disabled,
    });
  }

  /** Tighter: setting someone else's password is the one irreversible route here. */
  @RateLimit(5, 300)
  @Post('users/:id/password')
  @HttpCode(200)
  setPassword(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: AdminSetPasswordDto,
  ) {
    return this.admin.setPassword(actor.id, id, dto.password);
  }
}
