import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { PreviewStatusQuery, type PreviewSessionAnswer } from './preview.dto';
import { PreviewService } from './preview.service';

/**
 * The learner's three buttons: start my app, tell me where
 * it is, stop it.
 *
 * A controller of its own rather than three more methods on `PhasesController`:
 * the routes are the same `phases/:id/…` shape and land under the same
 * `api/v1` prefix, but they are the only ones in the product whose whole job
 * is a process that outlives the request, so they live in a controller of
 * their own beside the preview service.
 *
 * Ownership is `WorkflowService.loadOwnedState` inside the service, the same
 * gate every other phase route passes: another learner's phase id is a 403
 * before anything is started, polled or stopped.
 */
@Controller('phases')
@UseGuards(RateLimitGuard)
export class PreviewController {
  constructor(private readonly preview: PreviewService) {}

  /**
   * Six a minute. A start builds a bundle and spawns a process, and a learner
   * pressing Run app more than six times in a minute is not previewing, they
   * are stuck, which the panel says better than a queue would.
   */
  @RateLimit(6, 60)
  @HttpCode(200)
  @Post(':id/preview')
  start(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string): Promise<PreviewSessionAnswer> {
    return this.preview.start(user.id, id, user.sessionVersion);
  }

  /**
   * Sixty a minute: the panel polls every two seconds while an app boots and
   * every fifteen once it is up, and a learner who reloads the workspace
   * starts that over.
   */
  @RateLimit(60, 60)
  @Get(':id/preview')
  status(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: PreviewStatusQuery,
  ): Promise<PreviewSessionAnswer | null> {
    return this.preview.status(user.id, id, query.cursor ?? 0);
  }

  @RateLimit(20, 60)
  @Delete(':id/preview')
  stop(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string): Promise<{ stopped: boolean }> {
    return this.preview.stop(user.id, id);
  }
}
