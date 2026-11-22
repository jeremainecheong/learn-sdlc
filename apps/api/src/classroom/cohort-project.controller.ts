import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import type {
  AssignableVersionView,
  CohortProjectView,
} from '@learnsdlc/shared';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { ConsoleRateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { AssignProjectDto } from './cohort-project.dto';
import { CohortProjectService } from './cohort-project.service';

/**
 * Which project a class works: the three doors of the assignment surface.
 *
 * **`@Roles` at the API, not only in the page.** `RolesGuard` is a global guard
 * and resolves the caller from the users row at request time rather than from
 * whatever the token said when it was signed, so a learner who found the path
 * is refused here and not by a button that was not drawn.
 *
 * A controller of its own on the `instructor` prefix rather than a method on
 * `InstructorDetailController`, for the reason `LabController` gives above it:
 * Nest routes by path and not by class, so the assignment surface keeps a file
 * of its own. These are **API** paths under `/instructor`, where every staff
 * route lives; the pages that call them live under `/teacher`.
 *
 * The rate limit is the console's, not a learner route's: every one of these
 * fans out over a class and its library, and Assign writes a row the whole
 * class reads.
 */
@Controller('instructor')
@Roles('INSTRUCTOR', 'ADMIN')
@UseGuards(RateLimitGuard)
@ConsoleRateLimit()
export class CohortProjectController {
  constructor(private readonly assignment: CohortProjectService) {}

  /**
   * Declared before the bare `cohorts/:cohortId/project` only for reading
   * order; the two differ by a segment, so neither can shadow the other.
   */
  @Get('cohorts/:cohortId/project/assignable')
  assignable(
    @CurrentUser() caller: AuthUser,
    @Param('cohortId') cohortId: string,
  ): Promise<AssignableVersionView[]> {
    return this.assignment.assignable(caller, cohortId);
  }

  @Get('cohorts/:cohortId/project')
  read(
    @CurrentUser() caller: AuthUser,
    @Param('cohortId') cohortId: string,
  ): Promise<CohortProjectView> {
    return this.assignment.read(caller, cohortId);
  }

  /**
   * A `PUT`, because a class has one project: the request names the whole fact
   * rather than patching part of it. Reassigning supersedes the row the class
   * held and keeps it in the history.
   */
  @Put('cohorts/:cohortId/project')
  assign(
    @CurrentUser() caller: AuthUser,
    @Param('cohortId') cohortId: string,
    @Body() dto: AssignProjectDto,
  ): Promise<CohortProjectView> {
    return this.assignment.assign(caller, cohortId, dto);
  }
}
