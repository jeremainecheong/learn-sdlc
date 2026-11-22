import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { COHORT_IMPORT_MAX_BYTES_HEADER } from '@learnsdlc/shared';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { resolveImportMaxBytes } from '../config';
import { CohortExportQuery, CohortImportQuery, parseIncludes } from './portability.dto';
import { PortabilityService } from './portability.service';

/**
 * A file name a person can find again on a desktop: the class's own name, with
 * everything that is awkward in a file name turned into a dash.
 */
export function cohortExportFilename(name: string): string {
  const stem =
    String(name || 'class')
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'class';
  return `${stem}.json`;
}

/**
 * Class portability: a class out as one file, and a class in from one.
 *
 * Its own controller rather than more routes on `instructor.controller.ts`,
 * because the two features share nothing but a URL prefix.
 */
@Controller('instructor')
@Roles('INSTRUCTOR', 'ADMIN')
@UseGuards(RateLimitGuard)
export class PortabilityController {
  constructor(private readonly portability: PortabilityService) {}

  /**
   * A whole class as one document. Three a minute: it is a download an
   * instructor takes once before a machine changes hands, and it reads every
   * row the class owns.
   */
  @RateLimit(3, 60)
  @Get('cohorts/:cohortId/export.json')
  async export(
    @CurrentUser() caller: AuthUser,
    @Param('cohortId') cohortId: string,
    @Query() query: CohortExportQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const document = await this.portability.exportCohort(
      caller,
      cohortId,
      parseIncludes(query.include),
    );
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="${cohortExportFilename(document.cohort.name)}"`,
    );
    // So the panel can say "this file is larger than an import accepts" with
    // this deployment's number rather than the documented default. Read from
    // the same resolver the body parser is built from, so the number the panel
    // is told and the number the route enforces can never drift apart.
    res.setHeader(COHORT_IMPORT_MAX_BYTES_HEADER, String(resolveImportMaxBytes()));
    return document;
  }

  /**
   * Bring a class in, or ask what bringing it in would do (`?dryRun=true`).
   *
   * One limit for both, at the dry run's cadence: the preview is the call an
   * instructor makes repeatedly and it must stay cheap to repeat, and a real
   * import is already bounded by the body ceiling, by being one transaction,
   * and by the audit row every one of them writes.
   *
   * The body is taken as an object rather than a DTO on purpose. The global
   * validation pipe strips undeclared properties, and this body is a nested
   * document whose shape is checked by the service, which is where the
   * refusals have to be sentences an instructor can act on.
   */
  @RateLimit(10, 60)
  @Post('cohorts/import')
  @HttpCode(200)
  import(
    @CurrentUser() caller: AuthUser,
    @Body() body: Record<string, unknown>,
    @Query() query: CohortImportQuery,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    return this.portability.importCohort(caller, body, {
      dryRun: query.dryRun === 'true',
      force: query.force === 'true',
      raw: req.rawBody,
    });
  }
}
