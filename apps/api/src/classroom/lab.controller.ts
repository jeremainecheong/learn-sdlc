import { Controller, Get, UseGuards } from '@nestjs/common';
import type { LabView } from '@learnsdlc/shared';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { LabService } from './lab.service';

/**
 * The lab block on the console: the join link and a picture of it,
 * per class this instructor owns.
 *
 * A second controller on the `instructor` prefix rather than a method on
 * `InstructorOverviewController`, so the lab block keeps a file of its own. Nest
 * routes by path, not by class, so the two sit side by side.
 */
@Controller('instructor')
@Roles('INSTRUCTOR', 'ADMIN')
@UseGuards(RateLimitGuard)
@RateLimit(30, 60)
export class LabController {
  constructor(private readonly lab: LabService) {}

  @Get('lab')
  read(@CurrentUser() caller: AuthUser): Promise<LabView> {
    return this.lab.lab(caller);
  }
}
