import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AssistantService } from '../assistant/assistant.service';
import { Public } from '../auth/auth.decorators';
import { HealthService } from './health.service';

@Controller()
export class HealthController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly health: HealthService,
  ) {}

  /** A summary probe: up, the AI provider in use, and the server's time. */
  @Public()
  @Get('health')
  healthSummary() {
    return {
      status: 'ok',
      aiProvider: this.assistant.activeProviderName(),
      time: new Date().toISOString(),
    };
  }

  /** Liveness: is the process wedged? Never touches dependencies. */
  @Public()
  @Get('health/live')
  live() {
    return this.health.liveness();
  }

  /**
   * Readiness: can this instance serve traffic? Probes the database and queue,
   * and answers 503 when degraded so a load balancer stops routing to it.
   */
  @Public()
  @Get('health/ready')
  async ready(
    @Res({ passthrough: true }) res: Response,
    // Who is asking, for the runner and content probes: the counts and the
    // transport are public, and the names, paths and the Lambda function are
    // an operator's. See `HealthService.contentProbes`.
    @Headers('authorization') authorization?: string,
  ) {
    const report = await this.health.readiness(authorization);
    if (report.status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
