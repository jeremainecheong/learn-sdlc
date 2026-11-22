import {
  Body,
  Controller,
  ParseUUIDPipe,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { ConsoleRateLimit, RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import {
  AuditQuery,
  ClassLearnersQuery,
  ClassMapQuery,
  CohortScheduleDto,
  ExportQuery,
  GradebookQuery,
  PhaseOverrideDto,
  RegradeStartDto,
} from './instructor.dto';
import { InstructorService } from './instructor.service';
// Four instructor levers: regrade, the class dates, view as learner and the
// grade book.
import { RegradeService } from './regrade.service';
import { ScheduleService } from './schedule.service';
import { ViewAsService } from './view-as.service';
// The sign-off queue and the bulk sign-off.
import { BulkSignoffDto, SignoffService } from './signoff';

/**
 * The instructor detail routes live here; the read-only overview is in
 * instructor-overview.controller.ts. Every read of one learner goes through
 * `scopedLearner` (cohort-scope.ts), so a learner outside the caller's classes
 * is a 404; class-wide routes are narrowed by `learnerScope`.
 *
 * Every learner and phase id in a path carries `ParseUUIDPipe`: a word where
 * an id belongs is a malformed request, answered 400 on every route alike,
 * and never reaches a uuid column to come back as a 500. A well-formed id the
 * caller may not see is still the 404 `scopedLearner` gives.
 */
@Controller('instructor')
@Roles('INSTRUCTOR', 'ADMIN')
// Every route here fans out over a whole class, so they are the expensive
// end of the API even when the caller is legitimate.
@UseGuards(RateLimitGuard)
@ConsoleRateLimit()
export class InstructorDetailController {
  constructor(
    private readonly instructor: InstructorService,
    private readonly analytics: AnalyticsService,
    private readonly regrade: RegradeService,
    private readonly schedule: ScheduleService,
    private readonly viewAs: ViewAsService,
    private readonly signoff: SignoffService,
  ) {}

  /**
   * The class as its artefacts rather than its rows. Declared before the
   * `learners/:userId` route only for reading order; the segments differ, so
   * neither can shadow the other.
   */
  @Get('class-map')
  classMap(@CurrentUser() caller: AuthUser, @Query() query: ClassMapQuery) {
    return this.analytics.classMap(caller, query.project || undefined);
  }

  /** Who overrode what, and why, newest first. */
  @Get('audit')
  audit(@CurrentUser() caller: AuthUser, @Query() query: AuditQuery) {
    return this.instructor.auditLog(
      caller,
      query.learnerId || undefined,
      query.limit,
      query.cursor || undefined,
    );
  }

  /**
   * A page of the caller's class, each learner as `learners/:userId` answers
   * them, in one request, so the teacher home does not have to read one of
   * those per learner against this controller's 60-a-minute limit. The
   * same scope decides both, it writes nothing, and a page holds at most 50.
   * `learners` and `learners/:userId` differ by a segment, so neither shadows
   * the other.
   */
  @Get('learners')
  learners(@CurrentUser() caller: AuthUser, @Query() query: ClassLearnersQuery) {
    return this.instructor.classLearnerDetails(caller, {
      cohort: query.cohort || undefined,
      after: query.after || undefined,
      limit: query.limit,
    });
  }

  @Get('learners/:userId')
  learner(@CurrentUser() caller: AuthUser, @Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.instructor.learnerDetail(caller, userId);
  }

  @Post('learners/:userId/phases/:phaseStateId/override')
  @HttpCode(200)
  override(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('phaseStateId', new ParseUUIDPipe()) phaseStateId: string,
    @Body() dto: PhaseOverrideDto,
  ) {
    return this.instructor.overridePhase(
      caller,
      userId,
      phaseStateId,
      dto.action,
      dto.reason,
      // Which task the three per-task
      // levers are about. Without it every one of them reaches the service
      // with no key, resolves the empty one and answers 404; the lever would
      // exist in the DTO, in the service and in the audit register, and work
      // nowhere.
      dto.taskKey,
    );
  }

  /* ------------------------- regrade --------------------------------------- */

  /**
   * What a regrade would do. A dry run writes nothing at all (not even an
   * audit row) so it is cheap to ask twice and cannot be mistaken for the act.
   */
  @RateLimit(10, 60)
  @Post('regrades/preview')
  @HttpCode(200)
  regradePreview(@CurrentUser() caller: AuthUser, @Body() dto: RegradeStartDto) {
    return this.regrade.preview(caller, dto);
  }

  /**
   * Start one. Three in five minutes is generous for a thing an instructor
   * does after a content fix and stingy for anything else: each one is a job
   * per learner through the same runner the class is using.
   */
  @RateLimit(3, 300)
  @Post('regrades')
  regradeStart(@CurrentUser() caller: AuthUser, @Body() dto: RegradeStartDto) {
    return this.regrade.start(caller, dto);
  }

  /**
   * One batch, for the panel's poll. A batch keeps running when the tab is
   * closed (it is queue work, not request work) so this is also how a panel
   * picks up a batch it was not there for the start of.
   */
  @Get('regrades/:id')
  regradeStatus(@CurrentUser() caller: AuthUser, @Param('id') id: string) {
    return this.regrade.status(caller, id);
  }

  /* --------------------- view as learner ----------------------------------- */

  /**
   * Start a view-as session: one audit row, and the learner's name back.
   *
   * There is no token here and nothing to revoke. The view-as reads below are
   * the whole of it, and the instructor's own credential is what makes them.
   */
  @RateLimit(20, 60)
  @Post('learners/:userId/view')
  @HttpCode(200)
  viewAsStart(@CurrentUser() caller: AuthUser, @Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.viewAs.start(caller, userId);
  }

  @Get('learners/:userId/enrollment')
  viewAsEnrollment(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query() query: ExportQuery,
  ) {
    return this.viewAs.enrollment(caller, userId, query.project || undefined);
  }

  @Get('learners/:userId/analytics')
  viewAsAnalytics(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query() query: ExportQuery,
  ) {
    return this.viewAs.learnerAnalytics(caller, userId, query.project || undefined);
  }

  /**
   * The learner's `GET /phases/summaries`: every open phase, in the summary
   * view, from their own board.
   *
   * Declared before `:phaseStateId` because Nest matches in declaration order:
   * without it the phase route below would read "summaries" as a phase id, and
   * the dashboard a teacher lands on while viewing would get a 500 and no tiles.
   */
  @Get('learners/:userId/phases/summaries')
  viewAsSummaries(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query() query: ExportQuery,
  ) {
    return this.viewAs.summaries(caller, userId, query.project || undefined);
  }

  /** The learner's `GET /phases/records`, with the mentor thread left private. Before `:phaseStateId`, as above. */
  @Get('learners/:userId/phases/records')
  viewAsRecords(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query() query: ExportQuery,
  ) {
    return this.viewAs.records(caller, userId, query.project || undefined);
  }

  /** The learner's `GET /projects/:slug/map`, built from the same view-as phases. */
  @RateLimit(30, 60)
  @Get('learners/:userId/projects/:slug/map')
  viewAsMap(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('slug') slug: string,
    @Query('compact') compact?: string,
    @Query('showLocked') showLocked?: string,
  ) {
    return this.viewAs.projectMap(caller, userId, slug, {
      compact: compact === '1' || compact === 'true',
      showLocked: !(showLocked === '0' || showLocked === 'false'),
    });
  }

  // `ParseUUIDPipe` on every id below: a word in the phase slot is
  // a malformed request, answered 400, and never reaches a uuid column to come
  // back as a 500.
  @Get('learners/:userId/phases/:phaseStateId')
  viewAsPhase(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('phaseStateId', new ParseUUIDPipe()) phaseStateId: string,
  ) {
    return this.viewAs.phase(caller, userId, phaseStateId);
  }

  @Get('learners/:userId/phases/:phaseStateId/submissions')
  viewAsSubmissions(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('phaseStateId', new ParseUUIDPipe()) phaseStateId: string,
  ) {
    return this.viewAs.submissions(caller, userId, phaseStateId);
  }

  /**
   * The learner's `GET /phases/:id/tasks/:taskKey/submissions`: one task's
   * revisions of a split phase. Every room of a split phase reads its
   * revision list per task, and without this twin those reads would go to the
   * learner-only route and be refused "not your phase".
   */
  @Get('learners/:userId/phases/:phaseStateId/tasks/:taskKey/submissions')
  viewAsTaskSubmissions(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('phaseStateId', new ParseUUIDPipe()) phaseStateId: string,
    @Param('taskKey') taskKey: string,
  ) {
    return this.viewAs.submissions(caller, userId, phaseStateId, taskKey);
  }

  @Get('learners/:userId/phases/:phaseStateId/runs')
  viewAsRuns(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('phaseStateId', new ParseUUIDPipe()) phaseStateId: string,
  ) {
    return this.viewAs.runs(caller, userId, phaseStateId);
  }

  @Get('learners/:userId/assistant/:phaseStateId')
  viewAsTranscript(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('phaseStateId', new ParseUUIDPipe()) phaseStateId: string,
  ) {
    return this.viewAs.transcript(caller, userId, phaseStateId);
  }

  /* -------------------------- dossier -------------------------------------- */

  /**
   * A learner's whole project as one document, for an instructor to read or
   * print. Heavier than the learner detail because it reads the merged
   * revision's files, lighter than the CSV because it is one learner, so it
   * sits between their two limits.
   *
   * Every read of it leaves a `dossier.read` row in the trail. There is no
   * share link and no token: the only way to this document is a signed-in
   * instructor whose class the learner is in.
   */
  @RateLimit(10, 60)
  @Get('learners/:userId/dossier')
  dossier(
    @CurrentUser() caller: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query() query: ExportQuery,
  ) {
    return this.instructor.learnerDossier(caller, userId, query.project || undefined);
  }

  /* ---------------------- the class dates ---------------------------------- */

  @Get('cohorts/:cohortId/schedule')
  classDates(
    @CurrentUser() caller: AuthUser,
    @Param('cohortId') cohortId: string,
    @Query() query: ExportQuery,
  ) {
    return this.schedule.getSchedule(caller, cohortId, query.project || undefined);
  }

  @RateLimit(20, 60)
  @Put('cohorts/:cohortId/schedule')
  saveSchedule(
    @CurrentUser() caller: AuthUser,
    @Param('cohortId') cohortId: string,
    @Body() dto: CohortScheduleDto,
  ) {
    return this.schedule.saveSchedule(caller, cohortId, dto);
  }

  /** A full-class CSV is the heaviest query the console can ask for. */
  @RateLimit(5, 60)
  @Get('export.csv')
  async export(
    @CurrentUser() caller: AuthUser,
    @Query() query: ExportQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const project = query.project || undefined;
    const cohort = query.cohort || undefined;
    // The service has validated the slug against the catalogue by the time
    // it returns, which is what makes it safe to echo into the filename; the
    // class has been checked against the caller's scope, and its label is
    // reduced to [a-z0-9-].
    const csv = await this.instructor.exportCsv(caller, project, cohort);
    const label = cohort ? `-class-${await this.instructor.classFileLabel(cohort)}` : '';
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="learnsdlc-grades${project ? `-${project}` : ''}${label}.csv"`,
    );
    return csv;
  }

  /**
   * The grade book: one row per learner, one column per phase.
   * The same writer and the same `csvCell` guard as the export above.
   */
  @RateLimit(5, 60)
  @Get('gradebook.csv')
  async gradebook(
    @CurrentUser() caller: AuthUser,
    @Query() query: GradebookQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const project = query.project || undefined;
    const cohort = query.cohort || undefined;
    const csv = await this.instructor.exportGradebook(caller, project, cohort);
    const label = cohort ? `-class-${await this.instructor.classFileLabel(cohort)}` : '';
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="learnsdlc-gradebook${project ? `-${project}` : ''}${label}.csv"`,
    );
    return csv;
  }

  /* ------------- the sign-off routes ------------- */

  /**
   * Exactly the two `SIGNOFF_ROUTES` of the shared contract, and never
   * `AuthoringRouteKey`s: the authoring controller's spec holds it
   * to `AUTHORING_ROUTES` alone. `cohorts/:cohortId/signoff…` shares no
   * segment with `schedule`, `project` or `export.json` beside it.
   */
  @Get('cohorts/:cohortId/signoff-queue')
  signoffQueue(@CurrentUser() caller: AuthUser, @Param('cohortId') cohortId: string) {
    return this.signoff.queue(caller, cohortId);
  }

  /** One task, one reason, many learners: one transaction and one audit row per learner. */
  @RateLimit(10, 60)
  @Post('cohorts/:cohortId/signoff')
  @HttpCode(200)
  bulkSignoff(
    @CurrentUser() caller: AuthUser,
    @Param('cohortId') cohortId: string,
    @Body() dto: BulkSignoffDto,
  ) {
    return this.signoff.bulk(caller, cohortId, dto);
  }
}
