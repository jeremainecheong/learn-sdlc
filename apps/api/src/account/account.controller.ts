import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { ChangePasswordDto, ConfirmDeleteDto, UpdateProfileDto } from '../dto';
import { AccountService } from './account.service';

/**
 * The rights the privacy policy promises. Both routes act only on the caller's
 * own id; there is deliberately no path parameter, so there is no shape of
 * request that can name someone else's account.
 */
@Controller('account')
@UseGuards(RateLimitGuard)
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Patch('profile')
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.account.updateProfile(user.id, dto);
  }

  /** Tight limit: this route is an online password oracle if left open. */
  @RateLimit(5, 300)
  @Post('password')
  @HttpCode(200)
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.account.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }

  @RateLimit(5, 60)
  @Get('export')
  async export(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const data = await this.account.exportData(user.id);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="learnsdlc-export.json"');
    return data;
  }

  /**
   * Deletion requires the account's own email echoed back in the body. A
   * mis-click cannot destroy a term's work, and a CSRF-style forged request
   * cannot either, because the attacker would have to know the address.
   */
  @RateLimit(5, 300)
  @Delete()
  async remove(@CurrentUser() user: AuthUser, @Body() dto: ConfirmDeleteDto) {
    return this.account.deleteAccount(user.id, dto.email);
  }
}
