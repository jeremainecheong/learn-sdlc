import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { NotificationListView } from '@learnsdlc/shared';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { NotificationListQuery } from './notifications.dto';
import { NotificationsService } from './notifications.service';

/**
 * The learner's and the instructor's own bell.
 *
 * No `@Roles`: both read their own, and every route acts on `@CurrentUser`
 * with no path parameter naming another account: the same shape
 * `AccountController` uses. The allowance is 120 a minute because the panel
 * refetches when the tab regains focus and the store polls at sixty seconds.
 */
@Controller('notifications')
@UseGuards(RateLimitGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** The unread rows, newest first, and the true unread count. */
  @Get()
  @RateLimit(120, 60)
  list(@CurrentUser() user: AuthUser, @Query() query: NotificationListQuery): Promise<NotificationListView> {
    return this.notifications.list(user.id, query.limit);
  }

  @Post(':id/read')
  @HttpCode(200)
  @RateLimit(120, 60)
  read(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<{ unread: number }> {
    return this.notifications.markRead(user.id, id);
  }

  @Post('read-all')
  @HttpCode(200)
  @RateLimit(30, 60)
  readAll(@CurrentUser() user: AuthUser): Promise<{ unread: number }> {
    return this.notifications.markAllRead(user.id);
  }
}
