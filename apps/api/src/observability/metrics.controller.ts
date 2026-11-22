import { Controller, Get, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/auth.decorators';
import { metricsAccess, metricsContentType, renderMetrics } from './metrics';

/**
 * GET /metrics for Prometheus. main.ts keeps it outside the api/v1 prefix so
 * a scraper's default path works. @Public skips the JWT guard; the credential
 * is METRICS_TOKEN instead: see metricsAccess for the open/closed rules.
 */
@Controller()
export class MetricsController {
  @Public()
  @Get('metrics')
  async metrics(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<string> {
    const access = metricsAccess(req.headers.authorization);
    if (access === 'disabled') {
      throw new UnauthorizedException('metrics are disabled: set METRICS_TOKEN to enable the endpoint');
    }
    if (access === 'bad-token') {
      throw new UnauthorizedException('metrics require a valid METRICS_TOKEN bearer');
    }
    res.setHeader('content-type', metricsContentType);
    return renderMetrics();
  }
}
