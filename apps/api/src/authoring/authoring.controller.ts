import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Optional,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  ServiceUnavailableException,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { EXPORT_WITHHELD_HEADER, PHASE_ORDER } from '@learnsdlc/shared';
import type { PhaseKey } from '@learnsdlc/shared';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { ConsoleRateLimit, RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { AuthoringService } from './authoring.service';
import { DeepValidationService } from './deep-validation';
import { ExportService } from './export.service';
import { bakedRuntimeProfile } from './runtime-stacks';
import { SealedRoleService, decodeSealedBase64 } from './sealed-roles';
import { UploadService } from './upload.service';
import { errorName } from '../observability/error-name';
import {
  AddTaskDto,
  CreateDraftVersionDto,
  CreateProjectDto,
  DeepValidationStartDto,
  InterviewDto,
  ProjectUploadDto,
  SealedFileReadQueryDto,
  SealedFileWriteDto,
  PublishVersionDto,
  ReorderTasksDto,
  ReplaceFileDto,
  SetTaskRequiredDto,
  UpdatePhaseDto,
  UpdateProjectMetaDto,
  UpdateTaskDto,
} from './authoring.dto';

/** The deep validation this controller needs, by its `DeepValidationService` interface. */
export type DeepValidationPort = Pick<DeepValidationService, 'start' | 'view'>;

/** A write: a task save fires on every edit, so 30 a minute keeps up with typing and not with a loop. */
const WriteRateLimit = () => RateLimit(30, 60);
/** A heavy write or read (archive, draft, publish, deep validation, export): ten a minute. */
const HeavyRateLimit = () => RateLimit(10, 60);
/** A read that leaves an audit row or carries what a learner must not see: twenty a minute. */
const AuditedReadRateLimit = () => RateLimit(20, 60);
/** An upload: each one is an archive read in memory and a whole pack compiled, so five a minute. */
const UploadRateLimit = () => RateLimit(5, 60);

/**
 * The teacher's authoring surface, as routes.
 *
 * **Staff only, at the API.** `@Roles('INSTRUCTOR','ADMIN')` sits on the class,
 * so every handler below inherits it and `RolesGuard` refuses a `LEARNER` with a
 * 403 before a service ever runs. A page that hid the link would be a decoration
 * on top of this, never a substitute for it, and the finer question, which
 * project this particular teacher may write to, is the service's, because it is
 * a question about a row rather than about a role.
 *
 * **The paths are `/instructor`, the pages are `/teacher`.** That is deliberate
 * and not an inconsistency: `/instructor` is where every staff API route already
 * lives and where the console's guards and rate limits are already pointed, and
 * `teacher` is the word the product says out loud.
 *
 * **The write budget is smaller than the read one.** A task save fires on every
 * edit, so the reads keep the console's usual 60 a minute and the writes take
 * 30: enough for a teacher typing, not enough for a loop.
 */
@Controller('instructor')
@Roles('INSTRUCTOR', 'ADMIN')
@UseGuards(RateLimitGuard)
@ConsoleRateLimit()
export class AuthoringController {
  /** A failed follow-up validate after a committed write is logged, never answered as an error. */
  private readonly log = new Logger('AuthoringController');

  constructor(
    private readonly authoring: AuthoringService,
    private readonly upload: UploadService,
    private readonly sealed: SealedRoleService,
    // A version back to the on-disk layout.
    private readonly exporter: ExportService,
    // Optional: without a deep-validation provider the application still
    // boots, and the two deep routes answer 503 with a sentence.
    @Optional() private readonly deep?: DeepValidationService,
  ) {}

  /* ------------------------------ the projects ----------------------------- */

  @Get('projects')
  list(@CurrentUser() caller: AuthUser) {
    return this.authoring.listProjects(caller);
  }

  @WriteRateLimit()
  @Post('projects')
  create(@CurrentUser() caller: AuthUser, @Body() dto: CreateProjectDto) {
    return this.authoring.createProject(caller, dto);
  }

  @Get('projects/:projectId')
  get(@CurrentUser() caller: AuthUser, @Param('projectId') projectId: string) {
    return this.authoring.getProject(caller, projectId);
  }

  @WriteRateLimit()
  @Patch('projects/:projectId')
  updateMeta(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectMetaDto,
  ) {
    return this.authoring.updateMeta(caller, projectId, dto);
  }

  @HeavyRateLimit()
  @Post('projects/:projectId/archive')
  @HttpCode(200)
  archive(@CurrentUser() caller: AuthUser, @Param('projectId') projectId: string) {
    return this.authoring.archiveProject(caller, projectId);
  }

  /* ------------------------------ the version ------------------------------ */

  /**
   * Open the next draft from the published head.
   *
   * A write, and a heavy one (it copies the head's phase rows, task rows and
   * file rows) so it takes the ten-a-minute budget `archive` and `publish` do
   * rather than the thirty a teacher typing needs. It answers a `DraftVersionView`,
   * the same shape the GET below answers, so the editor routes straight into the
   * draft it just opened.
   */
  @HeavyRateLimit()
  @Post('projects/:projectId/versions')
  createDraft(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateDraftVersionDto,
  ) {
    return this.authoring.createDraftVersion(caller, projectId, dto);
  }

  @Get('projects/:projectId/versions/:versionId')
  draft(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.authoring.readDraft(caller, projectId, versionId);
  }

  /**
   * The version as a learner of it would first
   * read it, for its owner alone. A read: no row, no gate, no model, no
   * sandbox. Twenty a minute, counted in memory or Redis like every limit
   * here, never in a row.
   */
  @AuditedReadRateLimit()
  @Get('projects/:projectId/versions/:versionId/learner-preview')
  learnerPreview(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.authoring.learnerPreview(caller, projectId, versionId);
  }

  @WriteRateLimit()
  @Post('projects/:projectId/versions/:versionId/validate')
  @HttpCode(200)
  validate(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.authoring.validate(caller, projectId, versionId);
  }

  @HeavyRateLimit()
  @Post('projects/:projectId/versions/:versionId/publish')
  @HttpCode(200)
  publish(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Body() dto: PublishVersionDto,
  ) {
    return this.authoring.publish(caller, projectId, versionId, dto);
  }

  @Get('projects/:projectId/versions/:versionId/files')
  files(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.authoring.listFiles(caller, projectId, versionId);
  }

  /* ------------------------------- the tasks ------------------------------- */

  @Get('projects/:projectId/versions/:versionId/phases/:phaseKey/tasks')
  tasks(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
  ) {
    return this.authoring.listTasks(caller, projectId, versionId, phaseOf(phaseKey));
  }

  @WriteRateLimit()
  @Post('projects/:projectId/versions/:versionId/phases/:phaseKey/tasks')
  addTask(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
    @Body() dto: AddTaskDto,
  ) {
    return this.authoring.addTask(caller, projectId, versionId, phaseOf(phaseKey), dto);
  }

  @WriteRateLimit()
  @Patch('projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey')
  updateTask(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
    @Param('taskKey') taskKey: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.authoring.updateTask(caller, projectId, versionId, phaseOf(phaseKey), taskKey, dto);
  }

  @WriteRateLimit()
  @Put('projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/required')
  setRequired(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
    @Param('taskKey') taskKey: string,
    @Body() dto: SetTaskRequiredDto,
  ) {
    return this.authoring.setTaskRequired(caller, projectId, versionId, phaseOf(phaseKey), taskKey, dto);
  }

  @WriteRateLimit()
  @Put('projects/:projectId/versions/:versionId/phases/:phaseKey/task-order')
  reorder(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
    @Body() dto: ReorderTasksDto,
  ) {
    return this.authoring.reorderTasks(caller, projectId, versionId, phaseOf(phaseKey), dto);
  }

  /**
   * A quiz's answer key and its explanations: the one door that carries them.
   *
   * It is **not** on the draft payload, and the reason is the
   * guard rather than authorship: `tasks` and `draft` above run behind
   * `requireVisibleProject`, which admits every instructor on the deployment
   * for any platform-owned project and any `ADMIN` for anybody's. They carry
   * `AuthoredQuizView` (stems, options and a count of the keyed options) and
   * this route, behind `requireOwnedProject`, carries `AuthoredQuiz`.
   *
   * A GET that leaves an audit row, which `solution.read` is the precedent for:
   * it changes no score and writes no file, and *who has seen this key* is
   * still a question a class has to be able to answer. So the budget is
   * tighter than the console's usual read: the editor opens the panel on an
   * explicit action, not on every render, and a loop here would be a flood of
   * audit rows rather than of reads.
   */
  @AuditedReadRateLimit()
  @Get('projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/quiz/key')
  quizKey(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
    @Param('taskKey') taskKey: string,
  ) {
    return this.authoring.readQuizKey(caller, projectId, versionId, phaseOf(phaseKey), taskKey);
  }

  @WriteRateLimit()
  @Delete('projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey')
  removeTask(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
    @Param('taskKey') taskKey: string,
  ) {
    return this.authoring.removeTask(caller, projectId, versionId, phaseOf(phaseKey), taskKey);
  }

  /* ---------------- the copy becomes the teacher's own ---------------- */

  /** A phase's intro, on any of the six phases. The title is not a member. */
  @WriteRateLimit()
  @Patch('projects/:projectId/versions/:versionId/phases/:phaseKey')
  updatePhase(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
    @Body() dto: UpdatePhaseDto,
  ) {
    return this.authoring.updatePhase(caller, projectId, versionId, phaseOf(phaseKey), dto);
  }

  /**
   * The Phases card's three doors: remove a phase from a draft, put one back
   * from the version the draft was opened from, or add an empty Requirements
   * or Design. Each answers the draft view. The key is passed as sent, so an
   * unknown one is refused with the card's own sentence rather than `phaseOf`'s.
   */
  @WriteRateLimit()
  @Delete('projects/:projectId/versions/:versionId/phases/:phaseKey')
  removePhase(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
  ) {
    return this.authoring.removePhase(caller, projectId, versionId, phaseKey);
  }

  @WriteRateLimit()
  @Post('projects/:projectId/versions/:versionId/phases/:phaseKey/restore')
  restorePhase(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
  ) {
    return this.authoring.restorePhase(caller, projectId, versionId, phaseKey);
  }

  @WriteRateLimit()
  @Post('projects/:projectId/versions/:versionId/phases/:phaseKey')
  addPhase(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
  ) {
    return this.authoring.addPhase(caller, projectId, versionId, phaseKey);
  }

  /**
   * The stakeholder interview, written whole. The three interview routes name
   * `requirements` in the path (`INTERVIEW_PHASE`): the content loader drops
   * an interview on every other phase, so there is no other value to accept.
   */
  @WriteRateLimit()
  @Put('projects/:projectId/versions/:versionId/phases/requirements/interview')
  putInterview(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Body() dto: InterviewDto,
  ) {
    return this.authoring.putInterview(caller, projectId, versionId, dto);
  }

  @WriteRateLimit()
  @Delete('projects/:projectId/versions/:versionId/phases/requirements/interview')
  removeInterview(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.authoring.removeInterview(caller, projectId, versionId);
  }

  /**
   * The interview with its answers, for the owner alone, audited on every
   * read: `quizKey`'s shape and budget, for `quizKey`'s reason.
   */
  @AuditedReadRateLimit()
  @Get('projects/:projectId/versions/:versionId/phases/requirements/interview')
  readInterview(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.authoring.readInterview(caller, projectId, versionId);
  }

  /** One file's bytes, replaced in a written phase of a draft. Its path and role never change. */
  @WriteRateLimit()
  @Put('projects/:projectId/versions/:versionId/phases/:phaseKey/files')
  replaceFile(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
    @Body() dto: ReplaceFileDto,
  ) {
    return this.authoring.replaceFile(caller, projectId, versionId, phaseOf(phaseKey), dto);
  }

  /* ----------------- upload, profile, sealed, deep ----------------- */

  /**
   * A teacher's own project from an archive (`UploadService`): a draft
   * they own, never published, never the default. Five a minute (each one is
   * an archive read in memory and a whole pack compiled) and the fast tier is
   * run again through this service's own report builder, so the report the
   * upload answers is the one the editor opens on (scenario and screen-contract
   * rows included), word for word.
   */
  @UploadRateLimit()
  @Post('projects/upload')
  @HttpCode(201)
  async uploadProject(@CurrentUser() caller: AuthUser, @Body() dto: ProjectUploadDto) {
    const made = await this.upload.upload(caller, dto);
    // The draft is committed: a failure of the second look must not turn the
    // answer into a 500 about a project the teacher was never told exists.
    const validation = await this.authoring.validate(caller, made.projectId, made.versionId).catch((error: unknown) => {
      this.log.warn(`projects.upload: the second validate failed (${errorName(error)}); answering the upload's own report`);
      return made.validation;
    });
    return { ...made, validation };
  }

  /** The one runtime profile this deployment runs: read off the runner's own manifest. */
  @Get('runtime-profile')
  runtimeProfile() {
    return bakedRuntimeProfile();
  }

  /**
   * One sealed file of an executable task, written whole and answered as a
   * path, a digest and a size (`SealedRoleService`). Never echoes a byte.
   */
  @WriteRateLimit()
  @Put('projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/sealed')
  async writeSealed(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
    @Param('taskKey') taskKey: string,
    @Body() dto: SealedFileWriteDto,
  ) {
    const phase = phaseOf(phaseKey);
    // Who may write answers before what was sent:
    // another teacher's bad base64 is their 404, never a 400 about the bytes.
    await this.authoring.requireOwnedVersion(caller, projectId, versionId);
    const bytes = decodeSealedBase64(dto.contentBase64);
    // The declared run rides to the sealed-role service, which refuses a run that
    // is not the one the overlay grades the file in.
    const view = await this.sealed.write(caller, projectId, versionId, phase, taskKey, dto.role, dto.path, bytes, dto.runId ?? null);
    // The draft's stored compile follows the write (the compile derives the phase from
    // the sealed rows), so deep validation is started against the bytes the
    // teacher just wrote, and the editor's report says what publish will. The
    // write is committed: a failure of that second look is logged and the
    // write is still answered (the next edit or validate recompiles), as
    // `uploadProject` does for its committed draft.
    await this.authoring.validate(caller, projectId, versionId).catch((error: unknown) => {
      this.log.warn(`sealed.write: the follow-up validate failed (${errorName(error)}); the write stands`);
    });
    return view;
  }

  /**
   * A sealed file's bytes, for the project's owner alone (ADMIN 403, another
   * teacher 404) and one audit row on every read: `quizKey`'s budget for
   * `quizKey`'s reason.
   */
  @AuditedReadRateLimit()
  @Get('projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/sealed')
  readSealed(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Param('phaseKey') phaseKey: string,
    @Param('taskKey') taskKey: string,
    @Query() query: SealedFileReadQueryDto,
  ) {
    return this.sealed.readOwnerOnly(
      caller,
      projectId,
      versionId,
      phaseOf(phaseKey),
      taskKey,
      query?.role,
      query?.path,
      // a read under a run that does not grade the file is the sealed-role service's 404
      query?.runId,
    );
  }

  /**
   * Start deep validation: microVMs, so the ten-a-minute write budget,
   * and the version is proved to be the caller's own and of this project
   * before deep validation is asked anything.
   */
  @HeavyRateLimit()
  @Post('projects/:projectId/versions/:versionId/deep-validation')
  @HttpCode(202)
  async startDeepValidation(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Body() dto: DeepValidationStartDto,
  ) {
    const deep = this.requireDeep();
    await this.authoring.requireOwnedVersion(caller, projectId, versionId);
    return deep.start(caller, versionId, { acknowledgedMicroVMs: dto.acknowledgedMicroVMs });
  }

  @Get('projects/:projectId/versions/:versionId/deep-validation')
  async readDeepValidation(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
  ) {
    const deep = this.requireDeep();
    await this.authoring.requireOwnedVersion(caller, projectId, versionId);
    return deep.view(caller, versionId);
  }

  /**
   * One version as an archive in the on-disk
   * layout, for the project's owner alone (ADMIN on another's project 403,
   * another teacher 404, a learner 403 at the class's guard). `ExportService`
   * writes the one `project.exported` row, so the table names no audit here.
   * The bytes are never cached, and the count of sealed files kept out of the
   * archive (inherited from a project the teacher copied) rides in a header
   * the page reads; a refusal (409 `taskEdited` and the rest) is the
   * service's sentence, answered as JSON. Ten a minute: each export builds
   * and re-reads a whole archive in memory.
   */
  @HeavyRateLimit()
  @Get('projects/:projectId/versions/:versionId/export')
  async exportVersion(
    @CurrentUser() caller: AuthUser,
    @Param('projectId') projectId: string,
    @Param('versionId') versionId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const out = await this.exporter.export(caller, projectId, versionId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(EXPORT_WITHHELD_HEADER, String(out.withheld.length));
    return new StreamableFile(out.archive, {
      type: 'application/zip',
      disposition: `attachment; filename="${out.filename}"`,
      length: out.archive.length,
    });
  }

  /**
   * The starter or the shelf example
   * as a zip, for staff only (the class's roles; a learner's 403 comes before
   * the service). Not a table key and not a quiet read: each 200 leaves one
   * `project.sealed-read` audit row, written before the bytes leave; an
   * unknown name is a 404 with no row. `quizKey`'s budget, for its reason.
   */
  @AuditedReadRateLimit()
  @Get('starter/:name')
  async starter(
    @CurrentUser() caller: AuthUser,
    @Param('name') name: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const out = await this.authoring.starterDownload(caller, name);
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(out.bytes, {
      type: 'application/zip',
      disposition: `attachment; filename="${out.filename}"`,
      length: out.bytes.length,
    });
  }

  private requireDeep(): DeepValidationPort {
    if (!this.deep) {
      throw new ServiceUnavailableException('Deep validation is not available on this build yet.');
    }
    return this.deep;
  }
}

/**
 * A phase key out of a path segment.
 *
 * The six are a closed set, so anything else is refused here rather than
 * reaching a query: a segment that is not a phase would otherwise be a lookup
 * that finds nothing and a 404 about a project rather than about the word.
 */
function phaseOf(value: string): PhaseKey {
  if (!(PHASE_ORDER as readonly string[]).includes(value)) {
    throw new BadRequestException(
      `"${value}" is not a phase. The phases are ${PHASE_ORDER.join(', ')}.`,
    );
  }
  return value as PhaseKey;
}
