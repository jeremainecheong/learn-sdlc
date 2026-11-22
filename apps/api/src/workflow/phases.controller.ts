import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AssistantService } from '../assistant/assistant.service';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { BodyKeysGuard } from '../body-keys.guard';
import { ContentService } from '../content/content.service';
import { olderFormatRoomSentence } from '../content/phase-grading';
import { ClockDto, DrillResolveDto, LinksDto, ReflectDto, SubmitDto, WorkspaceDto } from '../dto';
import { ExecutionService } from '../execution/execution.service';
import { FeedbackService } from '../feedback/feedback.service';
// Which task a **phase-level** route is about. Imported rather than
// re-derived, because the answer is "the phase's only task" and never
// `SOLE_TASK_KEY`, and a second copy of that resolution is a second answer.
import { taskForRequest } from '../feedback/task-resolution';
import { ResetTaskDto } from './reset-task.dto';
import { WorkflowService } from './workflow.service';

/**
 * BodyKeysGuard: the workspace save takes `files` as a free-form map of path
 * to text, and a key named `constructor` in that map would turn the request
 * into a 500 inside the validation pipe. Guards run first, so it is refused
 * here with a 400.
 */
@Controller('phases')
@UseGuards(RateLimitGuard, BodyKeysGuard)
export class PhasesController {
  constructor(
    private readonly workflow: WorkflowService,
    private readonly execution: ExecutionService,
    private readonly feedback: FeedbackService,
    // the records batch below answers all three of a
    // phase's record lists at once, and the third of them is the reviewer's
    // thread.
    private readonly assistant: AssistantService,
    // the pinned version's task list, for the two revision routes.
    // `getTasksForEnrollment` is the one accessor every reader of learner state
    // goes through, never the head's task list, which can disagree with the
    // pin in both directions.
    private readonly content: ContentService,
  ) {}

  /**
   * Every open phase of the learner's enrolment, in the summary view, in one
   * request.
   *
   * Declared before `:id` because Nest matches in declaration order and
   * `summaries` would otherwise be read as a phase id.
   *
   * Limited at the instructor console's rate for a whole-class fan-out: this
   * reconciles the enrolment and builds every open phase, and the shell asks
   * once per page load.
   */
  @RateLimit(60, 60)
  @Get('summaries')
  summaries(@CurrentUser() user: AuthUser, @Query('project') project?: string) {
    // The same pair as `EnrollmentsController.mine`: a named project is
    // answered about that project, and a request that names none is resolved
    // for the learner rather than for the content directory.
    if (project) return this.workflow.phaseSummaries(user.id, project);
    return this.workflow.phaseSummariesForLearner(user);
  }

  /**
   * Every open phase's submissions, runs and reviewer thread, in one request.
   *
   * /journal and /dossier walk the whole project, and each phase would cost
   * three requests (31 and 42 in all). The answer is the same; a page which
   * needs all of it asks once. The per-phase routes are still what one room
   * costs.
   *
   * **It stays phase-wide on a split phase, and names no task.**
   * The kept `GET /phases/:id/submissions` below refuses a phase holding more
   * than one task, because a caller naming no key is asking about *the phase's
   * only task* and there isn't one. This route is asking a different question:
   * *everything this learner has on this phase*, for pages that draw the whole
   * board at once, and a batch that refused would blank the revisions panel on
   * a split phase rather than fill it. Narrowing it to the pinned version's
   * tasks would be worse still: a revision keyed by a task an earlier pin
   * declared would vanish from the learner's own log.
   *
   * What that costs is the one thing a union could get wrong, and it does not:
   * `FeedbackService.listFor` numbers each revision within its own task, so the
   * `attempt` this batch reports for a revision is the number
   * `GET /submissions/:id` reports for it, and "Revision 3" in the workspace
   * panel and "#3" in the dossier are the same try at the same work.
   */
  @RateLimit(60, 60)
  @Get('records')
  async records(@CurrentUser() user: AuthUser, @Query('project') project?: string) {
    const summaries = project
      ? await this.workflow.phaseSummaries(user.id, project)
      : await this.workflow.phaseSummariesForLearner(user);
    const rows = await Promise.all(
      summaries.map(async (phase) => {
        const [submissions, runs, chat] = await Promise.all([
          this.feedback.listFor(phase.id, user.id).catch(() => []),
          this.execution.listFor(phase.id, user.id).catch(() => []),
          this.assistant.history(user.id, phase.id).catch(() => []),
        ]);
        return [phase.id, { submissions, runs, chat }] as const;
      }),
    );
    return Object.fromEntries(rows);
  }

  /**
   * `?view=summary` answers with the phase minus its file bodies and its brief:
   * what the shell holds for every open phase. Anything that reads a file
   * reads the default view.
   */
  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('view') view?: string) {
    return this.workflow.phaseDetail(user.id, id, view === 'summary' ? 'summary' : 'full');
  }

  @Put(':id/workspace')
  async save(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: WorkspaceDto,
  ) {
    // `version` is the new `workspaceUpdatedAt`: the tab quotes it back on its
    // next save, which is what lets the API tell a tab it is about to write
    // over somebody else's work.
    const { version } = await this.workflow.saveWorkspace(user.id, id, dto.files, dto.baseVersion);
    return { saved: true, version };
  }

  @RateLimit(30, 60)
  @Post(':id/run')
  async run(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const { state, phase } = await this.workflow.loadOwnedState(user.id, id);
    // A phase its pinned version holds in an older form is not run: 409 with
    // the room's own sentence, as its submit answers.
    const older = olderFormatRoomSentence(phase);
    if (older) throw new ConflictException(older);
    return this.execution.runPhase(phase, state);
  }

  /**
   * The body is optional in fact as well as in type: a submit with
   * no body at all still grades, and records a revision with no message. That
   * is deliberate: every journey script, e2e spec and stress run posts nothing,
   * and a required message would have made writing prose the price of a run.
   *
   * **It answers the phase's only task.** It names no key,
   * and `FeedbackService.submit` reads that as *the phase's only task*: a
   * phase holding more than one is refused by name rather than assigned one,
   * because picking one is how a learner's work goes to the wrong grader. It is
   * what every journey script, e2e spec and stress run posts, and for a
   * teacher-authored project it carries every submission of every phase.
   */
  @RateLimit(20, 60)
  @Post(':id/submit')
  async submit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto?: SubmitDto,
  ) {
    const { state, phase } = await this.workflow.loadOwnedState(user.id, id);
    return this.feedback.submit(phase, state, dto?.message);
  }

  /**
   * One task of a phase, graded against the learner's whole phase workspace
   * with only that task's rules evaluated and scored.
   *
   * The same allowance as the phase-level route above and the same optional
   * body: a split phase is the same work handed in twice, not a second kind of
   * request. The ownership check is `loadOwnedState`, the product's one, and a
   * key the pinned version does not declare is a 404 in `getPhase`'s own
   * register, never a silent fall back to some other task.
   *
   * There is deliberately no `POST /phases/:id/tasks/:taskKey/run` beside it:
   * a written phase cannot Run, and an executable one holds one task.
   */
  @RateLimit(20, 60)
  @Post(':id/tasks/:taskKey/submit')
  async submitTask(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('taskKey') taskKey: string,
    @Body() dto?: SubmitDto,
  ) {
    const { state, phase } = await this.workflow.loadOwnedState(user.id, id);
    return this.feedback.submit(phase, state, dto?.message, taskKey);
  }

  /**
   * What "Start this task over" would do, for the confirm:
   * the paths it restores, the ones it re-seeds, the ones a passed sibling
   * keeps, whether a pending Agentic proposal goes, and the one sentence it
   * would be refused with. Writes nothing.
   */
  @RateLimit(60, 60)
  @Get(':id/tasks/:taskKey/reset')
  taskResetPlan(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('taskKey') taskKey: string,
  ) {
    return this.workflow.planTaskReset(user.id, id, taskKey);
  }

  /**
   * The learner starts one task of an authored list over. The
   * submit's allowance: a deliberate press, never a background job.
   */
  @RateLimit(20, 60)
  @Post(':id/tasks/:taskKey/reset')
  resetTask(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('taskKey') taskKey: string,
    @Body() dto: ResetTaskDto,
  ) {
    return this.workflow.resetTask(user.id, id, taskKey, dto.baseVersion);
  }

  /**
   * What "Retry this phase" would do, for the confirm, on a phase whose work
   * is one task: TaskTrackr's sole task above all, whose key is the empty
   * key a `:taskKey` segment cannot carry. It answers *the phase's only task*
   * as the phase-level submit does (`taskForRequest`, never an assumed
   * `SOLE_TASK_KEY`), and is the task route's plan for that key; a phase of
   * several tasks is refused by name, as the submit refuses it.
   */
  @RateLimit(60, 60)
  @Get(':id/reset')
  async phaseResetPlan(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.workflow.planTaskReset(user.id, id, await this.onlyTaskKey(user.id, id));
  }

  /** The learner retries (or starts over) the phase's only task: the task route's reset for that key, with its allowance and its body. */
  @RateLimit(20, 60)
  @Post(':id/reset')
  async resetPhase(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ResetTaskDto) {
    return this.workflow.resetTask(user.id, id, await this.onlyTaskKey(user.id, id), dto.baseVersion);
  }

  /** The key of the phase's only task, as the phase-level routes resolve it. */
  private async onlyTaskKey(userId: string, id: string): Promise<string> {
    const { state, enrollment } = await this.workflow.loadOwnedState(userId, id);
    return taskForRequest(this.content.getTasksForEnrollment(enrollment, state.phaseKey)).taskKey;
  }

  /**
   * Pin the day this phase's sandbox runs see, or clear it back to the
   * machine's clock. The same limit as Run: a control a learner
   * nudges while they think, not a job.
   */
  @RateLimit(30, 60)
  @Put(':id/clock')
  clock(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ClockDto) {
    return this.workflow.setRunClock(user.id, id, dto?.date ?? null);
  }

  @Post(':id/reflect')
  async reflect(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReflectDto,
  ) {
    await this.workflow.reflect(user.id, id, dto.reflection);
    return { saved: true };
  }

  @Post(':id/advance')
  advance(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.workflow.advance(user.id, id);
  }

  /**
   * Every verdict this phase has had, oldest first, without the snapshots.
   *
   * **It answers the phase's only task.** A revision list
   * is a list of tries at one piece of work: the attempt numbers on it are
   * *"my third try at this"*, so on a phase holding more than one task it
   * refuses by naming them rather than interleaving two histories under one
   * set of numbers. On a sole-task phase every revision carries the one key,
   * so the narrowed read returns exactly the rows the wide one would.
   *
   * **On a teacher-authored phase the narrow is bounded by the board's task-key
   * adoption, and this route does not perform it.** The only task there is
   * keyed `main` while a revision stored before tasks were keyed carries the
   * backfill default `''`, so the narrow sees it only once the adoption has
   * given it the pinned version's key. `loadOwnedState` stamps the pack and leaves the board to
   * the reads that describe it, so the window is closed by the learner's first
   * board read: `GET /phases/:id`, the dashboard's summaries, the enrolment
   * view, or by their first submit, each of which adopts on every pass. It is
   * one response wide and heals itself; no revision is lost and no gate moves,
   * which is why the repair is not lifted into a GET here: that would be a
   * write on a read and a fourth adoption site beside the three row writers.
   * `phase-routes.e2e-spec.ts` states it end to end.
   */
  @Get(':id/submissions')
  async submissions(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const { state, enrollment } = await this.workflow.loadOwnedState(user.id, id);
    const task = taskForRequest(
      this.content.getTasksForEnrollment(enrollment, state.phaseKey),
    );
    return this.feedback.listFor(state.id, user.id, task.taskKey);
  }

  /**
   * Every verdict one task of this phase has had, oldest first.
   *
   * It narrows on the same key and therefore carries the same adoption window as
   * the kept route above, closed by the same first board read.
   */
  @Get(':id/tasks/:taskKey/submissions')
  async taskSubmissions(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('taskKey') taskKey: string,
  ) {
    const { state, enrollment } = await this.workflow.loadOwnedState(user.id, id);
    const task = taskForRequest(
      this.content.getTasksForEnrollment(enrollment, state.phaseKey),
      taskKey,
    );
    return this.feedback.listFor(state.id, user.id, task.taskKey);
  }

  /** Every sandbox run this phase has had, oldest first. */
  @Get(':id/runs')
  async runs(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const { state } = await this.workflow.loadOwnedState(user.id, id);
    return this.execution.listFor(state.id, user.id);
  }

  /** Replaces the phase's link set; the body is the whole set, not a delta. */
  @Put(':id/links')
  async links(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: LinksDto) {
    await this.workflow.saveLinks(user.id, id, dto.links);
    return { saved: true };
  }

  /**
   * INCIDENT-1. Each of the three steps runs the container in the sandbox from
   * the request path, so the three limits below are deliberately far tighter
   * than the Run button's: the runs are serialised behind the API's runner gate
   * (SandboxService), and a limit above what one learner can work through by
   * hand only buys them a queue to sit in.
   */
  @RateLimit(6, 60)
  @HttpCode(200)
  @Post(':id/drill/start')
  drillStart(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.workflow.drillStart(user.id, id);
  }

  @RateLimit(10, 60)
  @HttpCode(200)
  @Post(':id/drill/health')
  drillHealth(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.workflow.drillHealth(user.id, id);
  }

  @RateLimit(6, 60)
  @HttpCode(200)
  @Post(':id/drill/resolve')
  drillResolve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: DrillResolveDto,
  ) {
    return this.workflow.drillResolve(user.id, id, dto.incident);
  }
}
