import {
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { EnrollDto } from '../dto';
import { WorkflowService } from './workflow.service';

@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly workflow: WorkflowService) {}

  /**
   * Start the project this learner has been given.
   *
   * The route never writes the slug the request carried: that would make the
   * resolution order a suggestion, letting any signed-in learner name any
   * published project (another teacher's included) and be pinned to it. A
   * shared lab machine would hit it without trying, because the browser's copy
   * of "the project" outlives the account that resolved it.
   *
   * `enrollAsLearner` resolves the answer server-side and treats the slug as a
   * claim to check. Staff naming a slug are the exception: an instructor
   * walking their own project before they assign it, or an admin looking at a
   * pack, is previewing rather than being taught, and an INSTRUCTOR may name
   * only the platform's projects, their own, or one a
   * class of theirs was given; an ADMIN any. `enrollAsStaff` holds the rule,
   * for a request that names nothing as much as for one that names a slug:
   * the dashboard's Start sends `{}`.
   */
  @Post()
  enroll(@CurrentUser() user: AuthUser, @Body() dto: EnrollDto) {
    if (user.role !== 'LEARNER') {
      return this.workflow.enrollAsStaff(user, dto.projectSlug);
    }
    return this.workflow.enrollAsLearner(user, dto.projectSlug);
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthUser, @Query('project') project?: string) {
    // The default is never a literal slug or the content directory, so that
    // renaming the pack cannot leave this route asking for one that is gone.
    // `projectVersionForLearner` resolves the learner's own enrolment, then their class's assignment,
    // then the `DEFAULT_PROJECT` slug, then the project the importer flagged;
    // none of those four is a `readdirSync`, and the first of them is what
    // stops a reassigned class's learner being handed a first-run screen.
    //
    // `project?: string` because the parameter is genuinely absent on the only
    // path the browser takes: `api.myEnrollment()` sends no query string at
    // all. The named path below: a request
    // that names a project is answered about that project, including the
    // empty answer for one the learner is not on.
    if (project) return this.workflow.myEnrollment(user.id, project);
    return this.workflow.myEnrollmentForLearner(user);
  }
}
