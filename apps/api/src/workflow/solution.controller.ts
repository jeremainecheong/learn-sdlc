import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { SolutionService } from './solution.service';

/**
 * The reference solution's two routes.
 *
 * They hang off `/phases/:id` because they are things read inside one
 * phase, and the ownership check lives
 * in the service on `WorkflowService.loadOwnedState`, the product's one
 * ownership check, rather than a second copy of the rule written here.
 *
 * No `@Roles`: these are a learner's own routes, and an instructor reading a
 * learner's work does it through the dossier, which is audited as its own act.
 * Twenty a minute is a learner opening a document and reloading it; a scraper
 * gets the limiter, and the per-task route carries the same allowance,
 * because a split phase is the same reading done twice.
 *
 * The phase-level route is **kept** rather than redirected: it answers the
 * phase's only task, and refuses by naming the tasks when there is more than
 * one. It must not start answering 400 to the solution room the day a split
 * phase exists, and for a teacher-authored project it is the route that
 * carries every reading of every phase.
 */
@Controller()
@UseGuards(RateLimitGuard)
export class SolutionController {
  constructor(private readonly solution: SolutionService) {}

  @RateLimit(20, 60)
  @Get('phases/:id/solution')
  read(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.solution.read(user.id, id);
  }

  @RateLimit(20, 60)
  @Get('phases/:id/tasks/:taskKey/solution')
  readTask(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('taskKey') taskKey: string,
  ) {
    return this.solution.read(user.id, id, taskKey);
  }
}
