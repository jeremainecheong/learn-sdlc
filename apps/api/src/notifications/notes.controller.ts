import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { InstructorNoteDto } from './notifications.dto';
import { NotificationsService } from './notifications.service';

/**
 * One instructor writing to one learner.
 *
 * A second controller on the `instructor` prefix, which Nest allows and
 * `CohortsController` already does: keeping the route here rather than on
 * `InstructorDetailController` keeps the notes surface beside the
 * notifications module. The scope, the refusal and the audit row are the console's usual ones:
 * a learner outside the caller's class is a 404, never a 403, and a malformed id is a 400.
 */
@Controller('instructor')
@Roles('INSTRUCTOR', 'ADMIN')
@UseGuards(RateLimitGuard)
export class InstructorNotesController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post('learners/:userId/note')
  @HttpCode(200)
  @RateLimit(30, 60)
  note(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: InstructorNoteDto,
  ): Promise<{ sent: true }> {
    return this.notifications.note(caller, userId, dto.text, dto.phaseStateId);
  }
}
