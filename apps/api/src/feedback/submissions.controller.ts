import {
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { FeedbackService } from './feedback.service';

@Controller('submissions')
export class SubmissionsController {
  constructor(private readonly feedback: FeedbackService) {}

  /**
   * The workspace polls this while a submission grades, so the learner's files
   * are opt-in: `?include=snapshot` is what the revisions panel sends when it
   * opens a revision, and nothing else needs a second copy of the workspace.
   */
  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('include') include?: string,
  ) {
    const wanted = (include ?? '').split(',').map((part) => part.trim());
    return this.feedback.getSubmission(id, user.id, { snapshot: wanted.includes('snapshot') });
  }
}
