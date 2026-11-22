import {
  Controller,
  Get,
  Query,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser, @Query('project') project?: string) {
    return this.analytics.forLearner(user.id, project);
  }
}
