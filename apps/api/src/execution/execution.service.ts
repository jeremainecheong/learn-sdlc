import { createHash, randomUUID } from 'crypto';
import { atomic } from '../db/atomic';
import { isUniqueViolation } from '../db/unique-violation';
import { SCREEN_COPY_PATH, validScreenCopy, withScreenCopy } from '../content/screen-copy';
import { resolveScreenCopy } from '../workflow/accepted-screen-copy';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import type { ExecutionRunView, RunExitKind, RunResult, RunStep } from '@learnsdlc/shared';
import { isRunnerUnavailable, RUNNER_UNAVAILABLE_MESSAGE } from '@learnsdlc/shared';
import { EnrollmentEntity, ExecutionRunEntity, PhaseStateEntity } from '../db/entities';
import { InjectRepository } from '../db/inject';
import { isoText } from '../db/timestamps';
import { ContentService } from '../content/content.service';
import { EventsGateway } from '../events/events.gateway';
import { dockerEntrypoint, smokeArgvFor } from '../feedback/checkers';
import { JobPayload, JobDeferredUntil } from '../jobs/job-queue';
import { JobsService } from '../jobs/jobs.service';
import { captureException } from '../observability/errors';
import { CodeChecks, PhaseContent, PhaseRun, TestsChecks } from '../content/content.types';
import { SandboxService, SandboxTestJob } from './sandbox.service';

/** A phase's run history stays bounded; the newest runs are the ones a learner reads. */
export const RUN_LIST_CAP = 50;
export const RUN_LEASE_MS = 10 * 60 * 1000;
export const RUN_INPUT_MISSING = 'This older run did not retain its inputs. Your saved work is unchanged. Press Run again to execute the current files.';
const RUN_VIEW_COLUMNS = { id: true, phaseStateId: true, status: true, kind: true, result: true, createdAt: true, error: true, inputHash: true, runClock: true } as const;

export function runInputHash(input: NonNullable<ExecutionRunEntity['inputSnapshot']>): string {
  const copy = input.acceptedScreenCopy;
  return createHash('sha256').update(JSON.stringify({
    version: input.version,
    workspace: Object.fromEntries(Object.entries(input.workspace).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    runClock: input.runClock,
    acceptedScreenCopy: copy ? { version: copy.version, sourceSubmissionId: copy.sourceSubmissionId, sourcePhaseStateId: copy.sourcePhaseStateId, title: copy.title, empty: copy.empty } : null,
  })).digest('hex');
}

function validRunInput(value: ExecutionRunEntity['inputSnapshot']): value is NonNullable<ExecutionRunEntity['inputSnapshot']> {
  return !!value && value.version === 1 && !!value.workspace && typeof value.workspace === 'object'
    && !Array.isArray(value.workspace) && Object.values(value.workspace).every(content => typeof content === 'string')
    && (value.runClock === null || typeof value.runClock === 'string')
    && (value.acceptedScreenCopy === null || validScreenCopy(value.acceptedScreenCopy));
}

/** What `runPhase` says to a phase the pack marks `canRun: false`. */
export const NOTHING_TO_RUN = 'this phase has nothing to run';

/* --------------------------- several runs, one result --------------------- */

/** A merged result carries one row per run; a single-run result carries none. */
export type MergedRunResult = RunResult & { steps: RunStep[] };

/**
 * How several runs of one phase become one result.
 *
 * `mergeRunResults` below is the merge, and `feedback.service.ts` imports it so
 * the grading paths pool the same way. `ExecutionService.mergeRuns` holds it as
 * a property, which lets a spec watch what the merge was given.
 */
export type MergeRuns = (results: RunResult[], runs: PhaseRun[]) => RunResult;

/**
 * The merged output stays one run's worth. The runner clips each run at 20000
 * characters already, and a stored result is a JSON column a panel reads: two
 * runs must not double what one run costs.
 */
export const MERGED_OUTPUT_LIMIT = 20000;

/** The runner's own clip, in the runner's own words, so both look the same. */
function clip(text: string): string {
  return text.length <= MERGED_OUTPUT_LIMIT
    ? text
    : `${text.slice(0, MERGED_OUTPUT_LIMIT)}\n… (truncated)`;
}

/* ------------------- the runner's own refusal sentence ------------------ */

/**
 * The runner's own sentence about why it could not run this job, or null.
 *
 * Two things answer `unavailable`, and a learner needs to tell them apart.
 * The transport failing (a socket that is not there, a Lambda that timed
 * out, a runner with no free slot) leaves `stderr` empty, because the only
 * message there is names a socket path or a function and belongs in the log;
 * "try again in a moment" is the right thing to say, and the queue retries.
 * The runner itself answering that it cannot run this kind of job at all
 * (a TypeScript step on the Lambda transport, where there is no node) writes
 * its sentence into `stderr` (`transport_cannot_run_js_result` in
 * sandbox_runner.py) and is the one writer of that shape. That limit does not
 * go away on the next attempt, so telling a learner to try again for it was a
 * lie, and re-running the Python half three times to ask the same question
 * of the same transport was the cost of the lie.
 */
export function runnerSentence(result: Pick<RunResult, 'exitKind' | 'stderr'>): string | null {
  if (!isRunnerUnavailable(result)) return null;
  const sentence = (result.stderr ?? '').trim();
  return sentence ? sentence : null;
}

/** True when the runner said, in its own words, that it cannot run this job. */
export function isPermanentUnavailable(result: Pick<RunResult, 'exitKind' | 'stderr'>): boolean {
  return runnerSentence(result) !== null;
}

/**
 * What a learner is told about an `unavailable` result: the runner's own
 * sentence, verbatim, when it gave one; the "try again" sentence when the
 * transport is what failed.
 */
export function unavailableSentence(result: Pick<RunResult, 'exitKind' | 'stderr'>): string {
  return runnerSentence(result) ?? RUNNER_UNAVAILABLE_MESSAGE;
}

/**
 * The stderr a merged result carries when one of its runs came back
 * `unavailable`.
 *
 * The runner's sentence, verbatim and unlabelled, then which of the other
 * steps did run: a learner whose API step passed and whose front-end step
 * cannot run here should read exactly that, and that nothing is scored until
 * every step can. A transient outage (no sentence) leaves stderr empty, as a
 * single-run outage does, so the "try again" sentence is the only one drawn.
 */
function unavailableStderr(results: RunResult[], runs: PhaseRun[]): string {
  const sentences = results.map(runnerSentence).filter((s): s is string => s !== null);
  if (sentences.length === 0) return '';
  const checked = results
    .map((result, i) => (isRunnerUnavailable(result) ? null : runs[i]?.label || null))
    .filter((label): label is string => label !== null);
  const rest =
    checked.length === 0
      ? 'Nothing is scored, so the gate stays shut.'
      : `The ${checked.join(' and ')} step${checked.length > 1 ? 's were' : ' was'} checked, but nothing is scored until every step can run, so the gate stays shut.`;
  return clip([...new Set(sentences), rest].join(' '));
}

/**
 * Each run's output under its own label, so a learner reading a wall of output
 * can tell which layer said what. A run that printed nothing contributes
 * nothing: a clean two-run phase has an empty stderr, exactly as a clean
 * one-run phase does, rather than two labels over nothing.
 */
function labelledOutput(runs: PhaseRun[], parts: string[]): string {
  const shown = parts
    .map((text, i) => (text ? `${runs[i].label}\n${text}` : ''))
    .filter((block) => block !== '');
  return clip(shown.join('\n'));
}

/**
 * The merge of a phase's runs into one result.
 *
 * `ok` is every run ok; a single `unavailable` makes the whole result
 * unavailable, because a transport failure is an outage and not a verdict, and
 * then the pooled totals are dropped as well: half a suite counted as a score
 * is the failure `unavailable` exists to prevent. Otherwise the exit kind is
 * the first failing run's, the durations sum (the runs are sequential) and the
 * cases are concatenated in `runs[]` order, each already stamped with its
 * `step` by the runner.
 */
export function mergeRunResults(results: RunResult[], runs: PhaseRun[]): RunResult {
  const steps: RunStep[] = results.map((result, i) => ({
    id: runs[i]?.id ?? '',
    label: runs[i]?.label ?? '',
    ok: result.ok,
    exitKind: result.exitKind,
    durationMs: result.durationMs,
    total: result.tests?.total ?? 0,
    passed: result.tests?.passed ?? 0,
    failed: result.tests?.failed ?? 0,
    errored: result.tests?.errored ?? 0,
  }));
  const unavailable = results.some(isRunnerUnavailable);
  const firstFailure = results.find((result) => !result.ok);
  const merged: MergedRunResult = {
    ok: results.every((result) => result.ok),
    exitKind: unavailable ? 'unavailable' : firstFailure ? firstFailure.exitKind : 'ok',
    stdout: labelledOutput(
      runs,
      results.map((result) => result.stdout),
    ),
    stderr: unavailable
      ? unavailableStderr(results, runs)
      : labelledOutput(
          runs,
          results.map((result) => result.stderr),
        ),
    durationMs: results.reduce((total, result) => total + result.durationMs, 0),
    steps,
  };
  const counted = results.filter((result) => result.tests);
  if (!unavailable && counted.length > 0) {
    merged.tests = {
      total: counted.reduce((n, result) => n + (result.tests?.total ?? 0), 0),
      passed: counted.reduce((n, result) => n + (result.tests?.passed ?? 0), 0),
      failed: counted.reduce((n, result) => n + (result.tests?.failed ?? 0), 0),
      errored: counted.reduce((n, result) => n + (result.tests?.errored ?? 0), 0),
      cases: counted.flatMap((result) => result.tests?.cases ?? []),
    };
  }
  return merged;
}

/* -------------------------------------------------------------------------- */

/**
 * "Run" button executions: fast feedback runs that never gate progression.
 * Submissions go through the FeedbackService instead.
 */
@Injectable()
export class ExecutionService implements OnModuleInit {
  private readonly logger = new Logger(ExecutionService.name);

  /**
   * How a phase's runs become one result: `mergeRunResults`, held as a
   * property so a spec can watch what the merge was given.
   */
  mergeRuns: MergeRuns = mergeRunResults;

  onModuleInit(): void {
    this.jobs.register('run', (payload) => this.processRun(payload));
  }

  constructor(
    @InjectRepository(ExecutionRunEntity) private readonly runs: Repository<ExecutionRunEntity>,
    @InjectRepository(PhaseStateEntity) private readonly phaseStates: Repository<PhaseStateEntity>,
    @InjectRepository(EnrollmentEntity) private readonly enrollments: Repository<EnrollmentEntity>,
    private readonly content: ContentService,
    private readonly sandbox: SandboxService,
    private readonly jobs: JobsService,
    private readonly events: EventsGateway,
  ) {}

  toView(run: ExecutionRunEntity): ExecutionRunView {
    return {
      id: run.id,
      phaseStateId: run.phaseStateId,
      status: run.status,
      kind: run.kind,
      result: run.result,
      inputHash: run.inputHash ?? null,
      runClock: run.runClock ?? null,
      ...(run.error ? { error: run.error } : {}),
      createdAt: isoText(run.createdAt),
    };
  }

  /**
   * Execute the phase's "run" action against the learner's current workspace.
   *
   * A phase the pack marks `canRun: false` (requirements, design) is refused
   * before any row exists: the job would only fail on "no runnable action",
   * and a failed row is a real attempt everywhere the history is read: the
   * records batch, the dossier, the account export. The job path keeps its
   * own check for a pack that says one thing and declares another.
   */
  async runPhase(phase: PhaseContent, state: PhaseStateEntity): Promise<ExecutionRunView> {
    if (!phase.canRun) throw new BadRequestException(NOTHING_TO_RUN);
    const inFlight = () => this.runs.findOne({
      where: { phaseStateId: state.id, userId: state.userId, kind: 'run', status: In(['queued', 'running']) },
      order: { createdAt: 'DESC', id: 'DESC' },
      select: RUN_VIEW_COLUMNS,
    });
    const existing = await inFlight();
    if (existing) return this.toView(existing);
    let acceptedScreenCopy = null;
    if (phase.files.some(file => file.path === SCREEN_COPY_PATH)) {
      const enrollment = await this.enrollments.findOneByOrFail({ id: state.enrollmentId, userId: state.userId });
      acceptedScreenCopy = await resolveScreenCopy(this.phaseStates.manager, this.content, enrollment, state);
    }
    const inputSnapshot = {
      version: 1 as const,
      workspace: Object.fromEntries(phase.files.filter(file => file.editable).map(file => [file.path, state.workspace?.[file.path] ?? file.content])),
      runClock: state.runClock ?? null,
      acceptedScreenCopy: acceptedScreenCopy ? { ...acceptedScreenCopy } : null,
    };
    let run: ExecutionRunEntity;
    try {
      run = await this.runs.save(this.runs.create({ phaseStateId: state.id, userId: state.userId, kind: 'run', status: 'queued', inputSnapshot, inputHash: runInputHash(inputSnapshot), runClock: inputSnapshot.runClock }));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await inFlight();
      if (!winner) throw error;
      return this.toView(winner);
    }

    try {
      // The owner is what makes the scheduler fair: one run from
      // each learner in turn, rather than one learner's ten before anyone else's one.
      await this.jobs.enqueue('run', { id: run.id, ownerId: state.userId });
    } catch (err) {
      // The queue refused the work, so nothing will ever pick this row up.
      // Fail it here and let the 503 reach the learner.
      await this.runs.update({ id: run.id, status: 'queued' }, { status: 'failed', error: 'The run could not be queued. Your work is saved. Press Run again.' });
      throw err;
    }

    return this.toView(run);
  }

  /**
   * Execute one queued run. Registered as the durable 'run' job handler: it
   * takes only an id and reads the immutable input snapshot. A later autosave
   * cannot change its files, clock or accepted Design copy on a retry.
   */
  async processRun({ id }: JobPayload): Promise<void> {
    const run = await this.runs.findOne({ where: { id } });
    if (!run || run.kind !== 'run' || run.status === 'completed' || run.status === 'failed') return;
    const processingToken = randomUUID();
    const now = new Date().toISOString();
    const started = await this.runs.update([
      { id, status: 'queued' },
      { id, status: 'running', processingLeaseUntil: IsNull() },
      { id, status: 'running', processingLeaseUntil: LessThan(now) },
    ], { status: 'running', processingToken, processingLeaseUntil: new Date(Date.now() + RUN_LEASE_MS).toISOString(), error: null });
    if (!started.affected) {
      const held = await this.runs.findOneBy({ id });
      if (this.jobs.durable && held?.status === 'running' && held.processingLeaseUntil) throw new JobDeferredUntil(Date.parse(held.processingLeaseUntil));
      return;
    }
    const owned = { id, processingToken, status: 'running' as const };
    this.events.emitJob(run.userId, { type: 'run', id, phaseStateId: run.phaseStateId, status: 'running' });
    try {
      const input = run.inputSnapshot;
      if (!validRunInput(input) || !run.inputHash || runInputHash(input) !== run.inputHash) {
        await this.runs.update(owned, { status: 'failed', error: !input ? RUN_INPUT_MISSING : 'The retained run inputs could not be verified. Your saved work is unchanged. Press Run again.' });
        return;
      }
      const state = await this.phaseStates.findOneBy({ id: run.phaseStateId, userId: run.userId });
      if (!state) {
        await this.runs.update(owned, { status: 'failed', error: 'The phase for this run no longer exists.' });
        return;
      }
      const enrollment = await this.enrollments.findOneByOrFail({ id: state.enrollmentId, userId: run.userId });
      // A Run executes the version the
      // learner holds, so what they press Run on and what grades them are the
      // same bytes.
      const phase = withScreenCopy(this.content.getPhaseForEnrollment(enrollment, state.phaseKey), input.acceptedScreenCopy);
      const result = await this.executeForPhase(phase, input.workspace, input.runClock, run.id);
      if (isRunnerUnavailable(result)) {
        if (isPermanentUnavailable(result)) {
          await this.runs.update(owned, { status: 'failed', result });
          return;
        }
        await this.runs.update(owned, { result });
        throw new Error('the code runner was unavailable for this run');
      }
      await atomic(this.runs.manager.connection, async manager => {
        const committed = await manager.update(ExecutionRunEntity, owned, { status: 'completed', result, error: null });
        if (committed.affected) await manager.update(PhaseStateEntity, { id: state.id, userId: run.userId }, { ranBeforeSubmit: true });
      });
    } catch (error) {
      captureException(error, { kind: 'run', jobId: id, userId: run.userId });
      if (!this.jobs.durable) await this.runs.update(owned, { status: 'failed', error: 'The run could not finish. Your saved work is unchanged. Press Run again.' });
      throw error;
    } finally {
      // A retry releases only its own lease. A superseded worker cannot clear
      // the next worker's claim or write a result after it has lost ownership.
      await this.runs.update({ id, processingToken }, { processingToken: null, processingLeaseUntil: null });
      const finished = await this.runs.findOne({ where: { id }, select: { status: true } });
      this.events.emitJob(run.userId, { type: 'run', id, phaseStateId: run.phaseStateId, status: finished?.status ?? 'failed' });
    }
  }

  /**
   * The sandbox job for a phase's Run action (also reused by feedback).
   *
   * `clock` is the day the run sees, an ISO date or null for the machine's
   * clock. It is a parameter rather than something read from the
   * phase state here, because the grading path passes the clock stored on the
   * submission rather than the one the learner is looking at now.
   *
   * A phase that spans two layers declares two `checks.runs` and gets two
   * sandbox jobs, one after the other, merged into one result. They are sequential rather than parallel because one
   * learner's Run press then holds one runner slot at a time, which is what
   * keeps a class of thirty fair; the cost is a few seconds. A phase with one
   * run takes a single job and returns the sandbox's own result, unmerged.
   */
  async executeForPhase(
    phase: PhaseContent,
    workspace: Record<string, string> | null,
    clock?: string | null,
    executionRunId?: string,
  ): Promise<RunResult> {
    const checks = phase.checks;
    const language = phase.language;
    const pinned = clock ? { clock } : {};
    if (checks.kind === 'code' || checks.kind === 'tests') {
      const runs = checks.runs || [];
      if (runs.length === 0) {
        // The loader gives every phase at least one run, synthesising it from
        // the flat shape when the pack declares none, so this is a fixture
        // that never went through it rather than anything a pack can do.
        throw new Error(`phase ${phase.key} declares no runs, so there is nothing to execute`);
      }
      const results: RunResult[] = [];
      for (const run of runs) {
        results.push(
          await this.sandbox.execute({
            ...this.jobForRun(phase, workspace, checks, run, runs.length > 1),
            ...pinned,
          }, executionRunId ? { kind: 'run', ownerId: executionRunId, stepId: run.id } : undefined),
        );
      }
      return runs.length === 1 ? results[0] : this.mergeRuns(results, runs);
    }
    if (checks.kind === 'config') {
      const files = {
        ...checks.smokeImplFiles,
        ...this.content.executionFiles(phase, workspace),
      };
      // Run and Submit use the same declared launcher. Missing or invalid
      // Docker instructions must not be replaced with an authored command.
      const entry = dockerEntrypoint(files[checks.smokeDockerfile || 'Dockerfile'] || '', files);
      if (!entry.argv.length) {
        return {
          ok: false,
          exitKind: 'error',
          stdout: '',
          stderr: `Selfcheck did not run: ${entry.problem || 'the Dockerfile does not define a supported launcher'}.`,
          durationMs: 0,
        };
      }
      return this.sandbox.execute({
        files,
        mode: 'smoke',
        smokeCommands: smokeArgvFor(entry.argv, checks.smokeCommands),
        expectInOutput: checks.expectInOutput,
        language,
        ...pinned,
      }, executionRunId ? { kind: 'run', ownerId: executionRunId, stepId: 'smoke' } : undefined);
    }
    throw new Error(`phase ${phase.key} has no runnable action`);
  }

  /**
   * The sandbox job one run of the Run action executes.
   *
   * A `code` phase runs the tests the learner can see over the whole
   * workspace: both layers are mounted, and each run collects only its own
   * `visibleTests`. A `tests` phase runs the learner's own suite against the
   * reference implementation, and carries only what that run needs: its
   * locked helpers, its implementation and its share of the learner's test
   * files, because the grading runs carry nothing else either and Run has to
   * be the same job shape as the one that scores them.
   *
   * `stamp` is true only when the phase has more than one run. `runId` is what
   * the runner writes onto every case as `step`; stamping a single-run phase
   * would put a step on a result that has nothing to group it by.
   */
  private jobForRun(
    phase: PhaseContent,
    workspace: Record<string, string> | null,
    checks: CodeChecks | TestsChecks,
    run: PhaseRun,
    stamp: boolean,
  ): SandboxTestJob {
    const forCode = checks.kind === 'code';
    return {
      files: forCode
        ? this.content.executionFiles(phase, workspace)
        : {
            ...run.supportFiles,
            ...run.implFiles,
            ...this.learnerTestFiles(phase, workspace, run.learnerTestFiles),
          },
      mode: 'tests',
      // What the learner's own Run collects. `run.testPaths` is the graded
      // run's, which is the hidden suite on a code phase and belongs to the
      // grader rather than here.
      testPaths: forCode ? run.visibleTests : run.learnerTestFiles,
      language: run.language,
      // Sent even when it is the language's own default: the pack declared the
      // harness, so the pack decides it, rather than the loader and the runner
      // having to keep two copies of one default in step.
      harness: run.harness,
      ...(run.transform ? { transform: { tool: 'esbuild' as const, jsx: 'automatic' as const } } : {}),
      ...(stamp ? { runId: run.id } : {}),
    };
  }

  learnerTestFiles(
    phase: PhaseContent,
    workspace: Record<string, string> | null,
    paths: string[],
  ): Record<string, string> {
    const all = this.content.executionFiles(phase, workspace);
    const out: Record<string, string> = {};
    for (const p of paths) out[p] = all[p];
    return out;
  }

  /**
   * Every run of one phase, oldest first, so the panel can read the loop the
   * learner worked through. It takes the newest `RUN_LIST_CAP` and reverses
   * them: a learner past the cap sees their recent runs rather than their
   * first ones. Scoped by `userId` as well as phase, so an id guessed from
   * someone else's URL returns an empty list rather than their history.
   */
  async listFor(phaseStateId: string, userId: string): Promise<ExecutionRunView[]> {
    const window = await this.runs.find({
      where: { phaseStateId, userId },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: RUN_LIST_CAP,
      select: RUN_VIEW_COLUMNS,
    });
    return window.reverse().map((run) => this.toView(run));
  }

  async getRun(id: string, userId: string): Promise<ExecutionRunView> {
    const run = await this.runs.findOne({ where: { id, userId }, select: RUN_VIEW_COLUMNS });
    if (!run) throw new NotFoundException('run not found');
    return this.toView(run);
  }
}
