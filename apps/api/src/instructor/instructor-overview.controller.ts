import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';
import { AssistantService } from '../assistant/assistant.service';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { ConsoleRateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { ContentService } from '../content/content.service';

@Controller('instructor')
@Roles('INSTRUCTOR', 'ADMIN')
// The overview fans out over a whole class, the same shape as the routes in
// InstructorDetailController, and the same limit, so the two halves of one
// console cannot be throttled differently.
@UseGuards(RateLimitGuard)
@ConsoleRateLimit()
export class InstructorOverviewController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly assistant: AssistantService,
    private readonly content: ContentService,
  ) {}

  /** `?project=` narrows to one enrolment per learner; without it, one row per enrolment. */
  @Get('overview')
  overview(@CurrentUser() user: AuthUser, @Query('project') project?: string) {
    return this.analytics.instructorOverview(user.id, project || undefined);
  }

  @Get('rubrics/:slug')
  rubrics(@Param('slug') slug: string) {
    const project = this.content.getProject(slug);
    return project.phases.map((p) => ({
      key: p.key,
      order: p.order,
      title: p.title,
      rubric: p.rubric,
      objectives: p.objectives,
    }));
  }
}
