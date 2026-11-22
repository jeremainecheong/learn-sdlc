import { Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { IdentityMigrationService } from './identity-migration.service';

/**
 * The Cognito user-migration trigger's door: the trigger signs each request,
 * and the service checks the signature before it answers with any account.
 */
@Controller('auth/cognito')
@UseGuards(RateLimitGuard)
export class IdentityMigrationController {
  constructor(private readonly migration: IdentityMigrationService) {}

  @Public()
  @Post('migrate')
  @HttpCode(200)
  @RateLimit(10, 60, { identityField: 'email', perAddress: { max: 120, windowSeconds: 60 } })
  migrate(@Req() req: Request & { rawBody?: Buffer }) {
    return this.migration.migrate(req);
  }
}
