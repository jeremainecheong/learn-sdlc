import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { WorkflowService } from './workflow.service';

@Controller('projects')
@UseGuards(RateLimitGuard)
export class ProjectsController {
  constructor(private readonly workflow: WorkflowService) {}

  /**
   * The projects this caller may be shown.
   *
   * A learner is listed the project the server resolves for them, first, and
   * any other they hold an enrolment in, never another teacher's project,
   * whose title, description and phase titles reach only learners of a class
   * it is assigned to. An ADMIN keeps the whole catalogue. An INSTRUCTOR is
   * listed what they may start: the platform's projects,
   * their own, and any assigned to a class they own, because the list carries
   * the same title, description and phase titles the slug route below refuses
   * them. Assigning reads the authoring library, not this.
   */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    if (user.role === 'LEARNER') return this.workflow.catalogueForLearner(user);
    return this.workflow.catalogueForStaff(user);
  }

  /**
   * One project's meta. For a learner, the same 404 as an unknown slug outside
   * their catalogue; for an instructor, the same 404 outside the projects they
   * may start: another teacher's unassigned project is not theirs to read.
   */
  @Get(':slug')
  get(@CurrentUser() user: AuthUser, @Param('slug') slug: string) {
    if (user.role === 'LEARNER') return this.workflow.projectMetaForLearner(user, slug);
    return this.workflow.projectMetaForStaff(user, slug);
  }

  /**
   * The learner's project map, built by the API.
   *
   * It lives under the project rather than under a phase because it spans every
   * open phase, and it is a GET with two flags because the folded and unfolded
   * shapes have different nodes: Home draws the folded one, ⌘K and the map
   * page the unfolded one. A learner with no enrolment in this project gets an
   * empty graph rather than a 404: an empty map is what the pages already draw
   * before a project is started.
   *
   * Limited because it fans out over every open phase (a detail build each)
   * and Home asks once per load, the map page once per visit.
   */
  @RateLimit(30, 60)
  @Get(':slug/map')
  map(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Query('compact') compact?: string,
    @Query('showLocked') showLocked?: string,
  ) {
    return this.workflow.projectMap(user.id, slug, {
      compact: compact === '1' || compact === 'true',
      showLocked: !(showLocked === '0' || showLocked === 'false'),
    });
  }
}
