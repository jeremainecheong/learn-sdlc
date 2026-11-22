import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import {
  SubmissionHistoryQuery,
  SubmissionTeacherFeedbackDto,
} from './submission-feedback.dto';
import { SubmissionTeacherFeedbackService } from './submission-feedback.service';

@Controller('submissions')
@UseGuards(RateLimitGuard)
export class SubmissionTeacherFeedbackController {
  constructor(private readonly feedback: SubmissionTeacherFeedbackService) {}

  @Roles('LEARNER')
  @Get('review-history/pages')
  history(
    @CurrentUser() caller: AuthUser,
    @Query() query: SubmissionHistoryQuery,
  ) {
    return this.feedback.history(caller, query);
  }

  @Roles('INSTRUCTOR', 'ADMIN')
  @Get('learner-history/:userId')
  learnerHistory(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query() query: SubmissionHistoryQuery,
  ) {
    return this.feedback.history(caller, query, userId);
  }

  @Get(':id/teacher-feedback')
  list(
    @CurrentUser() caller: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.feedback.list(caller, id);
  }

  /**
   * The teacher's sign-off of this revision and
   * its reason. `list`'s access rule; writes nothing; no name, email or id.
   */
  @Get(':id/sign-off')
  signOff(
    @CurrentUser() caller: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.feedback.signOff(caller, id);
  }

  @Roles('INSTRUCTOR', 'ADMIN')
  @Get(':id/teacher-evidence')
  evidence(
    @CurrentUser() caller: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.feedback.evidence(caller, id);
  }

  @Roles('INSTRUCTOR', 'ADMIN')
  @Post(':id/teacher-feedback')
  @HttpCode(200)
  @RateLimit(30, 60)
  add(
    @CurrentUser() caller: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SubmissionTeacherFeedbackDto,
  ) {
    return this.feedback.add(caller, id, dto);
  }
}
