import { withScreenCopy } from '../content/screen-copy';
import { resolveScreenCopy } from '../workflow/accepted-screen-copy';
import { quizPassed, strictTaskEvidencePassed } from './strict-evidence';
import { errorName } from '../observability/error-name';
import { lockEnrollment } from '../db/enrollment-lock';
import { isUniqueViolation } from '../db/unique-violation';
export { strictEvidencePassed } from './strict-evidence';
import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { EntityManager, In, IsNull, LessThan, MoreThan, Not, Repository } from 'typeorm';
import {
  COMMIT_MESSAGE_MAX,
  isRunnerUnavailable,
  RETIRED_WRITTEN_PHASE_ROOM,
  RUNNER_UNAVAILABLE_MESSAGE,
  holdsPhase,
} from '@learnsdlc/shared';
import type {
  AnalyzerReport,
  DrillReport,
  DrillState,
  FeedbackCheck,
  FeedbackReport,
  IntegritySignals,
  MutantRow,
  MutationReport,
  QuizChecks,
  QuizReport,
  ReportStepTiming,
  RunHarness,
  RunLanguage,
  RunResult,
  SubmissionView,
  TestCaseResult,
} from '@learnsdlc/shared';
import { config } from '../config';
import { firstRejection, OrderedOutcome, runOrdered, settleOrdered } from './run-fanout';
import { ContentService } from '../content/content.service';
import { hasRecord } from '../content/checks-validation';
import { olderFormatRoomSentence } from '../content/phase-grading';
import {
  CodeChecks,
  ConfigChecks,
  MutantSpec,
  PhaseChecks,
  PhaseContent,
  PhaseRun,
  TestsChecks,
} from '../content/content.types';
import {
  checksOf,
  isQuizTask,
  type CompiledTask,
} from '../content/pack-compiler';
import { soleTaskList } from '../content/task-units';
import {
  AgentProposalEntity,
  AssistantMessageEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  QuizAttemptEntity,
  SubmissionEntity,
  TaskStateEntity,
} from '../db/entities';
import { attemptEpochOf, QuizAttemptsService } from '../quiz/quiz-attempts.service';
import { InjectRepository } from '../db/inject';
import { atomic } from '../db/atomic';
import { JobDeferredUntil } from '../jobs/job-queue';
import { EventsGateway } from '../events/events.gateway';
import {
  ExecutionService,
  MergeRuns,
  mergeRunResults,
  runnerSentence,
} from '../execution/execution.service';
import { JobPayload } from '../jobs/job-queue';
import { JobsService } from '../jobs/jobs.service';
import { QUEUE_UNAVAILABLE_MESSAGE } from '../jobs/bull.queue';
import { captureException } from '../observability/errors';
import { boundedExitKind, SandboxJob, SandboxService, SandboxTestJob } from '../execution/sandbox.service';
import { AssistantService, REVIEW_USAGE_PROVIDER } from '../assistant/assistant.service';
import {
  assembleCriteria,
  countTestMethods,
  detectMentorPaste,
  MENTOR_PASTE_WINDOW,
  NO_EFFORT_MIN_HINTS,
  RELIANCE_FLAG_THRESHOLD,
  TOO_FEW_TESTS_CAP,
  dockerEntrypoint,
  evaluateRules,
  overallScore,
  phaseRollup,
  taskRollup,
  type HeldTaskState,
  type PhaseRollup,
  relianceIndex,
  RuleOutcome,
  scoreCodeQuality,
  scoreFromRules,
  scoreMutation,
  scoreProcess,
  scoreTests,
  smokeArgvFor,
  stripCodeComments,
} from './checkers';
import { NotificationsService } from '../notifications/notifications.service';
import { buildCiSteps } from './ci-steps';
import { buildContractLedger } from './conformance';
import { buildDrillReport } from './drill';
import { buildImpactReport } from './impact';
import { buildDesignReport, designWorkspaceForReview } from './design-report';
import { buildStoryPartial, storyWorkspaceForReview } from './story-report';
import { changeFloorOf, recordWorkspaceForReview, runbookFloorOf } from './record-report';
import { drillWithIncident } from '../workflow/drill-incident';
import { learnerReport } from '../workflow/learner-text';
import {
  inPaperTokens,
  notAQuizRefusal,
  paperPercent,
  QUIZ_PAPER_REFUSAL,
  quizNeedsAPaperRefusal,
  quizReview,
  releaseExplanations,
  revealRuleFor,
  scorePaper,
} from './quiz-scoring';
import { taskForRequest, taskForRevision } from './task-resolution';
import { adoptOrphanRevisions, carriedTaskPass } from './legacy-revisions';
import { submissionId } from './submission-id';
import { mentorUseSentences, type AgenticUse } from './mentor-use';

/** The report as a phase builder returns it, before the shared sections are added. */
type PartialReport = Omit<
  FeedbackReport,
  'aiReview' | 'aiReliance' | 'passed' | 'passThreshold' | 'integrity'
>;

/** What one smoke run of the learner's container entrypoint produced. */
export interface SmokeCheckResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** The argv derived from the learner's ENTRYPOINT/CMD; empty when it could not be derived. */
  argv: string[];
  /** Why no run happened, e.g. an unfinished Dockerfile. */
  problem?: string;
}

/** A learner's revision list stays bounded; the newest are the ones they act on. */
const SUBMISSION_LIST_CAP = 50;

/**
 * Everything a SubmissionView is built from, and nothing else. Named so the
 * list and the single-submission read cannot drift apart, and so neither of
 * them pulls `workspaceSnapshot` (a full copy of the learner's files) for a
 * caller that only renders a verdict.
 */
const LIST_COLUMNS = {
  id: true,
  phaseStateId: true,
  // Teacher-authored projects: which task this revision answered.
  // A few bytes on a list that already carries whole reports, and without it
  // every view built from this projection reads the column as undefined,
  // which is indistinguishable from the sole task's own key `''`, so a
  // revision list on a split phase would say every revision was the same
  // piece of work.
  taskKey: true,
  status: true,
  score: true,
  passed: true,
  report: true,
  error: true,
  createdAt: true,
  // 140 bytes on a list that already carries whole reports, and
  // the revision list is where a learner reads their own log, so there is no
  // reason to make either of these opt-in.
  commitMessage: true,
  runClock: true,
} as const;

/** The kill matrix rides inside the report column: six mutants x this many cases. */
const MATRIX_CASE_CAP = 60;

/** Characters of the drill's before and after output a drill report keeps. */
const DRILL_OUTPUT_MAX = 2000;

/** Characters of a runner's error a check line quotes when tests or the selfcheck could not run. */
const RUN_ERROR_EXCERPT_MAX = 300;

/** Characters of a failed smoke run's output the review's evidence line quotes. */
const SMOKE_EVIDENCE_EXCERPT_MAX = 120;

/** Analyzer issues the code-quality evidence lists. */
const CODE_QUALITY_EVIDENCE_ISSUES = 5;

/** Recent completed Implementation revisions searched for a baseline analysis. */
const BASELINE_REPORTS_SCANNED = 5;

/**
 * How long a submission may hold the phase's in-flight slot before a new
 * submit steps over it.
 *
 * The guard against a double-click has to be bounded, because a job can end
 * without its row ever being written: BullMQ fails a job that stalls past
 * `maxStalledCount` without calling the handler at all. An unbounded guard
 * turns that into a phase gate nobody can open again. Ten minutes is far
 * longer than a grading run: the slowest is the testing phase, six mutant
 * runs at the sandbox timeout, and far shorter than a lab.
 */
const IN_FLIGHT_MAX_AGE_MS = 10 * 60 * 1000;

/** What a learner is told about the wedged submission that is being stepped over. */
const STALLED_SUBMISSION_MESSAGE =
  'This submission stopped responding while it was being graded. Nothing was lost — your workspace is saved. Press Submit again to grade it.';

/** What a learner is told when the pipeline itself threw and nothing will retry it. */
const PIPELINE_FAILED_MESSAGE =
  'The feedback engine could not process this submission. Please try again.';

/**
 * The characters kept of the first line of a failure message from a hidden
 * test or a file the learner cannot open. That line keeps the failure
 * actionable; everything a stack dump would carry after it is dropped.
 */
const FOREIGN_MESSAGE_MAX = 160;

/**
 * One commit message, ready for the column.
 *
 * Trimmed, and empty means null: the field left untouched and the field filled
 * with spaces are the same fact to every reader of the revision list, so there
 * is one column and no flag. The length and the single-line rule are the DTO's
 * to enforce; this is the last mile before the row.
 */
function commitMessage(raw: string | undefined): string | null {
  const text = (raw ?? '').trim();
  return text ? text.slice(0, COMMIT_MESSAGE_MAX) : null;
}

/**
 * The sandbox never ran the code (the `unavailable` outcome), so there is
 * no verdict to score. Thrown from `runSandbox` rather than returned, because
 * every scorer downstream (`scoreTests`, the smoke gate, the mutation loop)
 * reads a run with no `tests` as a zero, and a transport failure must never
 * reach any of them.
 */
export class RunnerUnavailableError extends Error {
  /**
   * `sentence` is the runner's own reason when it gave one: a TypeScript step
   * on the Lambda transport comes back with
   * "this transport cannot run JavaScript…" in its stderr, and that limit is
   * permanent, so "try again in a moment" would be the wrong thing to write on
   * the row. The transport failing gives no sentence, and the generic one
   * stands. Either way the attempt goes back: nothing was graded.
   */
  constructor(sentence: string | null = null) {
    super(
      sentence
        ? `${sentence} Nothing was scored and this attempt was not counted.`
        : RUNNER_UNAVAILABLE_MESSAGE,
    );
    this.name = 'RunnerUnavailableError';
  }
}

/**
 * A test case with nothing in it the learner is not meant to read.
 *
 * The runner returns a frame for any file inside the workspace, and the hidden
 * suite is written into that workspace to be run, so a failing hidden case
 * would come back carrying the path, the line and the source of the case that caught
 * the learner out, as the deepest frame when the assertion itself failed, and
 * as the caller frame when their own code raised. So the filter is per frame,
 * and `visiblePaths` is the phase's own file list: exactly what the workspace
 * shows them, hidden tests never among it. A case that lost a frame, and every
 * hidden case, keeps one capped line of its message instead of a traceback.
 */
function redactCase(
  testCase: TestCaseResult,
  visiblePaths: ReadonlySet<string>,
  capMessage: boolean,
): TestCaseResult {
  const { frames, message, ...rest } = testCase;
  const kept = (frames ?? []).filter((frame) => visiblePaths.has(frame.path));
  const capped = capMessage || kept.length !== (frames?.length ?? 0);
  const shown = capped ? message?.split(/\r?\n/, 1)[0]?.trim().slice(0, FOREIGN_MESSAGE_MAX) : message;
  return {
    ...rest,
    ...(shown ? { message: shown } : {}),
    ...(kept.length ? { frames: kept } : {}),
  };
}

/* ------------------------------ multi-run phases -------------------------- */

/**
 * How a phase's runs become one result.
 *
 * There is exactly one implementation of the pooling rule in the process, and
 * it is `mergeRunResults` in `execution.service.ts`: two copies of it is how a
 * Run and a Submit come to disagree about the same workspace. It is
 * re-exported here under the name the graders use, so the grading path reads
 * its own vocabulary rather than the execution service's, and both pool the
 * same object.
 */
export const mergeRuns: MergeRuns = mergeRunResults;

/**
 * The harness a language runs under when nothing declares one.
 *
 * The loader fills `harness` and `hiddenHarness` on every run from the pack,
 * so this is only ever reached through `runsFor`'s synthesised run: a
 * `checks` object assembled by hand. It is the runner's own default, said once
 * here rather than left implicit, so the job a grader sends always names the
 * harness that ran it.
 */
function defaultHarness(language: string): RunHarness {
  return language === 'python' ? 'unittest' : 'js';
}

/**
 * The runs a graded phase executes, in order.
 *
 * The loader gives every phase at least one run, synthesising it from the flat
 * shape when the pack declares none, so in production this is always
 * `checks.runs`. The fallback is for a `checks` object built by hand: several
 * specs here and in `conformance`, `class-map` and the e2e suites do exactly
 * that, and it is deliberately the flat shape those objects already carry, so
 * a phase with no `runs` grades through precisely the single flat job.
 * `executeForPhase` refuses that case instead, because reading `results[0]`
 * of an empty array is the danger there; here the danger is a regression,
 * and reproducing the single-run job is the guard.
 */
function runsFor(phase: PhaseContent, checks: CodeChecks | TestsChecks): PhaseRun[] {
  if (checks.runs?.length) return checks.runs;
  const language = (phase.language || 'python') as RunLanguage;
  const harness = defaultHarness(language);
  const code = checks.kind === 'code';
  const hiddenTestFiles = code ? checks.hiddenTestFiles ?? {} : {};
  const learnerTestFiles = code ? [] : checks.learnerTestFiles ?? [];
  return [
    {
      // No id and no label: a phase with one run has nothing to group by and
      // no group to head, and `stamp` is false everywhere they would be read.
      id: '',
      label: '',
      language,
      harness,
      hiddenHarness: harness,
      transform: false,
      testPaths: code ? Object.keys(hiddenTestFiles) : learnerTestFiles,
      visibleTests: code ? checks.visibleTests ?? [] : [],
      hiddenTestFiles,
      learnerTestFiles,
      referenceTestFiles: code ? {} : checks.referenceTestFiles ?? {},
      implFiles: code ? {} : checks.implFiles ?? {},
      supportFiles: code ? {} : checks.supportFiles ?? {},
    },
  ];
}

/**
 * One result from a phase's runs.
 *
 * A phase with one run returns the sandbox's own object, unmerged: no `steps`,
 * no `step` on a case, the same row a single-run pack has always stored. More
 * than one is pooled, which is what makes `scoreTests` a
 * pass rate over both layers' cases rather than the average of two rates: a
 * learner who finishes the API and skips the front end cannot score 100.
 */
function mergedResult(results: RunResult[], runs: PhaseRun[]): RunResult {
  return results.length === 1 ? results[0] : mergeRuns(results, runs);
}

/**
 * One row of a report's `timings`.
 *
 * The stem is fixed here in the grader and the pack's run id is appended only
 * where a per-run check line would already carry it (`runCheck`), so a row
 * names a step and a layer and nothing else: never a file, never a hidden test,
 * never a word a learner wrote. `durationMs` is the runner's own number, which
 * the caller is holding anyway, and the exit kind goes through
 * `boundedExitKind` because the sandbox only checks that the runner sent a
 * string: this row is stored and read back by the learner, so a runner's
 * sentence must not be able to land in it.
 */
function stepTiming(
  stem: string,
  run: PhaseRun | undefined,
  stamp: boolean,
  result: RunResult,
): ReportStepTiming {
  return {
    step: stamp && run?.id ? `${stem}-${run.id}` : stem,
    durationMs: result.durationMs,
    outcome: boundedExitKind(result.exitKind),
  };
}

/**
 * The learner's test files one run of a `tests` phase carries.
 *
 * A file another run grades is left out: grading it twice would pool it twice,
 * and a file no run claims rides into every run, because that is what a
 * helper the reference directory ships and no learner test path names is. A
 * phase with one run carries the map exactly as it was handed over.
 */
function testFilesForRun(
  all: Record<string, string>,
  run: PhaseRun,
  runs: PhaseRun[],
): Record<string, string> {
  if (runs.length === 1) return all;
  const elsewhere = new Set(runs.filter((other) => other !== run).flatMap((r) => r.learnerTestFiles));
  return Object.fromEntries(Object.entries(all).filter(([path]) => !elsewhere.has(path)));
}

/* -------------------------------------------------------------------------- */

/**
 * The drill the grader hands `drillWithIncident` for a learner who was never
 * paged: no stored incident and no progress, so the incident it answers is
 * the record's alone.
 */
function unpagedDrill(fault: string): DrillState {
  return { fault, pagedAt: '', runbookBefore: null, healthRanAt: null, healthExit: null, fixAppliedAt: null, resolvedAt: null, incident: null };
}

/**
 * Is this verdict about a run of this quiz that has already ended?
 *
 * **One comparison, of two facts that are one fact by construction.**
 * `quiz_attempts.epoch` is stamped at draw from `task_states.resetCount`, and
 * `resetCount` is what `task-reset` increments, so *the paper's run* and
 * *the row's run* are the same integer or the reset happened in between.
 * There is no clock here for the reason there is none in the column itself: a
 * reset and a hand-in inside one millisecond would leave *"papers since the
 * last reset"* undecidable, and this is the comparison that must never be.
 *
 * Both reads are the caller's: under the enrolment lock, inside the
 * transaction, and the paper goes through `QuizAttemptsService` like every
 * other read of that table, built over that transaction's repository the way
 * `task-reset` builds its own (`instructor.service.ts`).
 *
 * **A voided paper is of no run at all.** A reset closes the paper it finds
 * open and marks it void; such a sheet is never scored, never counted and
 * never handed back, so a verdict naming one moves nothing either.
 *
 * **And what it answers for everything else.** A task that is not a quiz has
 * no paper; it answers from the revision's own `resetEpoch` (below). A NULL
 * epoch, a board with no row for the task, and a quiz revision that names no
 * paper are not evidence of anything: the absence of a record is not the
 * absence of a run, which is the rule `markingLost` already keeps. Each reads
 * as *this verdict is of the current run*, because withholding a pass a
 * learner earned is the worse of the two failures: it moves no gate,
 * announces nothing and heals never.
 *
 * **Free of the class, and of the entities, because there are two writers.**
 * `writeVerdict` below asks it of the grading job that was in flight when the
 * reset committed; `RegradeService.processRegrade` asks it of an instructor
 * re-running a pre-reset revision. One predicate or two answers: the row is
 * taken structurally (`attemptEpochOf`'s own parameter, and `undefined` for a
 * board that has no row for this key) so neither caller has to reshape what it
 * already holds to ask.
 */
export async function verdictIsOfAnotherRun(
  manager: EntityManager,
  task: CompiledTask,
  mine: { resetCount: number } | null | undefined,
  submissionId?: string,
): Promise<boolean> {
  if (!submissionId) return false;
  // A task that is not a quiz answers from the revision's own `resetEpoch`,
  // read through the caller's manager: inside its lock and its transaction.
  // NULL (a row written before the column existed, a rollback-window row, a
  // sole-task row) or no row is the current run, for the reason above; every
  // reset stamps a task's NULL rows with the run it ends first, so NULL
  // is exactly the current run.
  if (!isQuizTask(task)) {
    // No row: a sole task (TaskTrackr), whose revisions are NULL by
    // construction, or a board that lost its row, whose verdict is read as the
    // current run for the reason above. No read is issued, so TaskTrackr's
    // verdict path sends no extra statement.
    if (!mine) return false;
    const revision = await manager.findOne(SubmissionEntity, {
      select: ['id', 'resetEpoch'],
      where: { id: submissionId },
    });
    if (revision?.resetEpoch === null || revision?.resetEpoch === undefined) return false;
    return revision.resetEpoch !== attemptEpochOf(mine);
  }
  const paper = await new QuizAttemptsService(
    manager.getRepository(QuizAttemptEntity),
  ).forSubmission(submissionId);
  if (!paper) return false;
  return paper.voidedAt !== null || paper.epoch !== attemptEpochOf(mine);
}

/**
 * The refusal a learner already holding their share of the queue reads.
 *
 * The bound is **advisory**: a bare count with no lock and no constraint
 * behind it, so two submits that arrive together may both read the same number
 * and both insert. That is the right kind of answer here: the database's
 * exactness guarantee is `UQ_submissions_in_flight`, which says nothing about
 * a learner's total, and a race that briefly admits one more costs the class
 * one queue slot for one job.
 */
export function submissionsInFlightMessage(cap: number): string {
  if (cap === 1) {
    return 'One of your submissions is still grading. It will be ready to send again in a moment.';
  }
  const spelled = cap === 2 ? 'Two' : cap === 3 ? 'Three' : String(cap);
  return `${spelled} of your submissions are still grading. They finish in order — this one will be ready to send in a moment.`;
}

/**
 * The automated feedback engine: static analysis, test execution and the
 * rubric review combined into one formative report per submission.
 */
@Injectable()
export class FeedbackService implements OnModuleInit {
  private readonly logger = new Logger(FeedbackService.name);

  onModuleInit(): void {
    this.jobs.register('submission', (payload) => this.processSubmission(payload));
  }

  constructor(
    @InjectRepository(SubmissionEntity) private readonly submissions: Repository<SubmissionEntity>,
    @InjectRepository(PhaseStateEntity) private readonly phaseStates: Repository<PhaseStateEntity>,
    @InjectRepository(EnrollmentEntity) private readonly enrollments: Repository<EnrollmentEntity>,
    @InjectRepository(AssistantMessageEntity)
    private readonly messages: Repository<AssistantMessageEntity>,
    private readonly content: ContentService,
    private readonly sandbox: SandboxService,
    private readonly execution: ExecutionService,
    private readonly assistant: AssistantService,
    private readonly jobs: JobsService,
    private readonly events: EventsGateway,
    private readonly notifications: NotificationsService,
  ) {}

  toView(
    submission: SubmissionEntity,
    extra?: { attempt?: number; workspaceSnapshot?: Record<string, string> | null },
  ): SubmissionView {
    const view: SubmissionView = {
      // Teacher-authored projects: which task this revision is
      // about, as the row itself records it. `''` on a sole-task phase, which
      // is every revision written before the column existed: the value the
      // client reads is the value the gate reads, and a revision list on a
      // split phase is unreadable without it.
      taskKey: submission.taskKey ?? '',
      id: submission.id,
      status: submission.status,
      score: submission.score,
      passed: submission.passed,
      // A quiz result's texts as a learner reads them (plain, HTML comments not shown), converted here, once,
      // whenever it was stored.
      report: learnerReport(submission.report),
      createdAt:
        submission.createdAt instanceof Date
          ? submission.createdAt.toISOString()
          : String(submission.createdAt),
      error: submission.error || undefined,
      // The learner's own words on this revision, and the day it
      // was graded at. Both are null on a revision that predates them, which
      // reads as "no message" and "the machine's clock": what it was.
      commitMessage: submission.commitMessage ?? null,
      runClock: submission.runClock ?? null,
    };
    if (extra?.attempt !== undefined) view.attempt = extra.attempt;
    if (extra && 'workspaceSnapshot' in extra) {
      view.workspaceSnapshot = extra.workspaceSnapshot ?? null;
      view.acceptedScreenCopy = submission.contextSnapshot?.acceptedScreenCopy ?? null;
    }
    return view;
  }

  /**
   * The newest submission for one phase.
   *
   * The tie-break on id is not decoration: sqlite stores `createdAt` to the
   * second, so two submissions inside one second carry the same timestamp and
   * `ORDER BY createdAt DESC` alone returns whichever the scan reaches first,
   * in practice the older of the two. Every other read of this table already
   * orders `createdAt DESC, id DESC`; this one is what the dashboard shows as
   * "your last submission", so it has to agree with the revision list.
   */
  async latestFor(phaseStateId: string, taskKey?: string): Promise<SubmissionView | null> {
    const last = await this.submissions.find({
      // The key narrows where a caller has one and is left off where it does
      // not: "the newest revision on this phase" is still a question with an
      // answer, and it is the one the phase tile asks. Where a key is given
      // the read seeks on `IDX_submissions_task_created`, and on a sole-task
      // phase every revision carries the one key, so the narrowed read returns
      // exactly the rows the wide one does.
      where: taskKey === undefined ? { phaseStateId } : { phaseStateId, taskKey },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: 1,
    });
    return last.length ? this.toView(last[0]) : null;
  }

  /**
   * Every submission for one phase, oldest first, as the revision list. The
   * reports ride along because the panel renders them; the snapshots do not:
   * a workspace file is up to 200 000 chars and only one revision is opened at
   * a time.
   *
   * `taskKey` narrows the list to one piece of the phase's work: the kept and
   * per-task revision routes both name one. A caller that names none gets the
   * whole phase, because `GET /phases/records` draws the workspace, the design
   * room, the journal and the dossier from one batch and a revision missing
   * from it is a revision a learner cannot open.
   *
   * **The number is per task either way.** `attempt` is read as *"my
   * third try at this"*, and `attemptNumber` (the number
   * `GET /submissions/:id` reports, and the one the poller shows while a
   * revision grades) counts tries at the task the row itself names.
   * Numbering the un-narrowed list across the phase would have those two
   * disagree about one revision on one screen, so the ordinal is taken within
   * the row's own key here too. On a phase whose revisions all carry one key:
   * every sole-task phase, and every one-task authored phase:
   * the two arms are the same arithmetic over the same rows.
   */
  async listFor(
    phaseStateId: string,
    userId: string,
    taskKey?: string,
  ): Promise<SubmissionView[]> {
    const where = taskKey === undefined ? { phaseStateId, userId } : { phaseStateId, userId, taskKey };
    const total = await this.submissions.count({ where });
    if (!total) return [];
    // The newest rows are the ones a learner acts on, so the cap keeps those
    // and the attempt number still counts from the first submission ever made.
    const window = await this.submissions.find({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
      take: SUBMISSION_LIST_CAP,
      select: LIST_COLUMNS,
    });
    const totals = await this.attemptTotals(where, window, total, taskKey);
    // Newest first, so a key's first row is its last try and each one below it
    // is one try earlier.
    const taken = new Map<string, number>();
    return window
      .map((row) => {
        const key = row.taskKey ?? '';
        const nth = (taken.get(key) ?? 0) + 1;
        taken.set(key, nth);
        return this.toView(row, { attempt: (totals.get(key) ?? window.length) - nth + 1 });
      })
      .reverse();
  }

  /**
   * How many revisions each key in this window has in total, including the ones
   * the cap left out.
   *
   * Where the window is the whole list: a learner with fewer than
   * `SUBMISSION_LIST_CAP` revisions, which is nearly every learner: the counts
   * are already in hand and this asks the database nothing. A narrowed read has
   * one key and `total` is its count. Only a capped, un-narrowed list pays for a
   * count per key, and it pays it on a phase that really does hold several
   * tasks.
   */
  private async attemptTotals(
    where: { phaseStateId: string; userId: string; taskKey?: string },
    window: readonly SubmissionEntity[],
    total: number,
    taskKey?: string,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (window.length === total) {
      for (const row of window) {
        const key = row.taskKey ?? '';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    }
    if (taskKey !== undefined) return counts.set(taskKey, total);
    for (const key of new Set(window.map((row) => row.taskKey ?? ''))) {
      counts.set(key, await this.submissions.count({ where: { ...where, taskKey: key } }));
    }
    return counts;
  }

  /**
   * One submission. This is also the route the workspace polls while a
   * submission is grading (every 1.2s for up to two minutes) so the files
   * ride along only when a caller asks for them: a snapshot is a full copy of
   * every editable file (200 000 chars each is the cap), and the poller reads
   * nothing but `status`. The revisions panel asks, by opening a revision.
   */
  async getSubmission(
    id: string,
    userId: string,
    opts: { snapshot?: boolean } = {},
  ): Promise<SubmissionView> {
    const submission = await this.submissions.findOne({
      where: { id, userId },
      ...(opts.snapshot ? {} : { select: LIST_COLUMNS }),
    });
    if (!submission) throw new NotFoundException('submission not found');
    return this.toView(submission, {
      attempt: await this.attemptNumber(submission),
      ...(opts.snapshot ? { workspaceSnapshot: submission.workspaceSnapshot } : {}),
    });
  }

  /**
   * Where this submission sits in the phase's revision list, 1-based.
   *
   * One ordered read of the ids, in exactly the order `listFor` presents them,
   * so the number the poll route reports and the number beside the revision
   * are the same by construction. It is not a count of the rows that sort
   * before this one: that comparison would send the hydrated `createdAt` back
   * to the database, and sqlite stores the column to the second while the
   * Date carries milliseconds, so two submissions inside one second would both
   * come back as attempt 2. The read is one index range over a single phase's
   * submissions and returns the id column only.
   */
  private async attemptNumber(submission: SubmissionEntity): Promise<number> {
    const ordered = await this.submissions.find({
      // The row's own key, so "my third try" counts tries at the work that was
      // graded. On a sole-task phase every revision carries the one key and
      // the set is the whole phase's set.
      where: { phaseStateId: submission.phaseStateId, taskKey: submission.taskKey },
      order: { createdAt: 'ASC', id: 'ASC' },
      select: { id: true },
    });
    const place = ordered.findIndex((row) => row.id === submission.id);
    return place >= 0 ? place + 1 : Math.max(1, ordered.length);
  }

  /**
   * `message` is what the learner said this revision changes. It
   * is optional in fact as well as in type: the fast loop must never be gated
   * on prose, so a submission sent with the field empty is recorded as one with
   * no message, and every script and e2e spec that posts no body at all keeps
   * working unchanged.
   *
   * `taskKey` is which piece of the phase's work this revision answers. Left
   * off, it means *the phase's only task*: the phase-level
   * route's question, and a phase with more than one is refused by name
   * rather than assigned one.
   *
   * `quiz` is the paper this revision hands in. **It is
   * not a formality.** A quiz task named without it is refused by name before
   * anything is written, which is what keeps a quiz from being handed in with
   * no sheet to score; a paper named on a task that is not a quiz is refused
   * for the converse reason. Only the quiz hand-in route passes it.
   */
  async submit(
    phase: PhaseContent,
    state: PhaseStateEntity,
    message?: string,
    taskKey?: string,
    quiz?: { attemptId: string },
  ): Promise<SubmissionView> {
    // A phase its pinned version holds in an older form is never graded: the
    // room's own sentence, before anything is read, written or spent.
    const older = olderFormatRoomSentence(phase);
    if (older) throw new ConflictException(older);
    // The list is the **pinned** version's, never the head's, because it is
    // the same list the roll-up's quantifier, the strict gate and the answer
    // door will read, and two keyed structures that can disagree is exactly
    // the defect to avoid.
    const enrollment = await this.enrollments.findOneByOrFail({ id: state.enrollmentId });
    const tasks = this.content.getTasksForEnrollment(enrollment, phase.key);
    const task = taskForRequest(tasks, taskKey);
    // Before the in-flight answer, before the
    // room check, before the task row, before the attempt and before the
    // `submissions` row: a refusal that leaves a counter spent is not a
    // refusal. Nothing below this line runs for a quiz with no paper.
    const paper = await this.paperFor(state, task, quiz);
    // A sole task has no `task_states` row, so nothing below may look for
    // one. Everywhere `rowTask` is null this method executes only the
    // phase-level statements.
    const rowTask = soleTaskList(tasks) ? null : task;

    // A double-click or a retried request must not grade the same workspace
    // twice: an in-flight submission for **this task** is the answer, and the
    // guard is the database's `(phaseStateId, taskKey)`. The winner's
    // message stands: the second press is the same submission, not a revision
    // of its description.
    const inFlight = await this.inFlightFor(state.id, task.taskKey);
    if (inFlight) return this.toView(inFlight);

    // After the idempotent answer and before the attempt is spent, because a
    // double-click must still get the winner's view rather than a refusal.
    await this.assertRoomInFlight(state);

    // The third creator of a task row, on the **authored path only**: a
    // sole-task phase's Submit writes no task row.
    await this.writeTaskState(state, tasks, task);
    const acceptedScreenCopy = await resolveScreenCopy(this.phaseStates.manager, this.content, enrollment, state);
    phase = withScreenCopy(phase, acceptedScreenCopy);
    const packVersion = await this.packVersionFor(state);

    // From the in-flight answer to the insert is
    // ONE transaction under the enrolment lock: the lock every writer of this
    // learner's board takes first (`advance`, `writeVerdict`, the regrade, the
    // teacher's levers and the learner's reset). Inside it, in this order:
    //
    //   1. the lock;
    //   2. the in-flight answer again, through the transaction and without the
    //      age-out (its write would wait on another connection's row lock while
    //      this one holds the enrolment's: a hang PG cannot see); a winner is
    //      returned with nothing spent;
    //   3. the phase row and the task row's `resetCount`, re-read, so the
    //      snapshot and the epoch are of the board as it stands under the lock:
    //      a reset that committed after the outer read is seen, never
    //      graded around;
    //   4. the attempt, spent through the transaction;
    //   5. the insert, stamped with `resetEpoch` (NULL on a sole-task list,
    //      which has no row: NULL is the current run).
    //
    // The age-out form of the in-flight read stays above, before the lock. A
    // unique violation (a double-click that raced past step 2 on sqlite, or a
    // row committed by a submit that held no lock) rolls the whole transaction
    // back, the spend with it, so nothing needs refunding here.
    // TaskTrackr's submit takes the same lock: one more `SELECT … FOR
    // UPDATE` and a re-read, and not one byte graded differently.
    let landed: { winner: SubmissionEntity } | { submission: SubmissionEntity };
    try {
      landed = await atomic(this.submissions.manager.connection, async (manager) => {
        await lockEnrollment(manager, { id: state.enrollmentId, userId: state.userId });
        const winner = await this.inFlightFor(state.id, task.taskKey, { ageOut: false, manager });
        if (winner) return { winner };
        const fresh = await manager.findOneByOrFail(PhaseStateEntity, { id: state.id });
        const epoch = rowTask
          ? ((
              await manager.findOne(TaskStateEntity, {
                where: { phaseStateId: state.id, taskKey: task.taskKey },
              })
            )?.resetCount ?? 0)
          : null;
        await this.spendAttempt(state, rowTask, task, manager);

        const row = manager.create(SubmissionEntity, {
          // Time-ordered, so two submissions inside one sqlite second still have a
          // last one. See submissionId.
          id: submissionId(),
          phaseStateId: state.id,
          userId: state.userId,
          // The work this revision answers. For a compiled sole task this is
          // `SOLE_TASK_KEY`, which is the column's own default, so a sole-task
          // phase's rows read exactly as they read before the column existed.
          taskKey: task.taskKey,
          status: 'queued',
          // The pack that graded this attempt, so a score can be read
          // against the content that produced it.
          packVersion,
          // For the same reason and in the same place: what the learner
          // said about this revision, and the day the sandbox will call today when
          // it grades it. An empty message is null: to a reader "" and "never
          // written" are the same thing, and one column says both.
          commitMessage: commitMessage(message),
          runClock: fresh.runClock ?? null,
          contextSnapshot: {
            links: fresh.links ?? [],
            ranBeforeSubmit: fresh.ranBeforeSubmit,
            drill: drillWithIncident(fresh.drill ?? null, fresh.workspace, phase),
            acceptedScreenCopy,
          },
          // The run this revision belongs to.
          resetEpoch: epoch,
        });
        // saveWorkspace overwrites the workspace in place, so the code that was
        // graded only survives if the submission keeps its own copy. This is the
        // copy at enqueue time, of the row as re-read under the lock;
        // processSubmission replaces it with the copy the report is built from,
        // which is the one a revision must show.
        row.workspaceSnapshot = this.editableSnapshot(phase, fresh);
        return { submission: await manager.save(SubmissionEntity, row) };
      });
    } catch (err) {
      // `UQ_submissions_in_flight` is a partial unique index on the phase
      // state and task, so the database (not a read) is what decides the
      // race between two submits landing together. The loser is not an error
      // for the learner: it is the same double-click the guard exists for, so
      // it answers with the submission that won. The transaction rolled back,
      // and the attempt it spent went with it.
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.inFlightFor(state.id, task.taskKey, { ageOut: false });
      if (!winner) throw err;
      return this.toView(winner);
    }
    if ('winner' in landed) return this.toView(landed.winner);
    const submission = landed.submission;

    // The paper names the revision that carries its
    // verdict, and it does so **before** the job is enqueued, so a grader can
    // never run against a row that does not yet know which submission it is.
    //
    // A paper `paperFor` admitted while it still named a **failed** revision
    // is unlinked from that dead id first, because `link` is scoped to
    // `submissionId IS NULL`: without this the paper would keep naming the
    // revision that never ran, and `record` (which is keyed on the
    // submission) would write this paper's score onto no row at all.
    if (paper) {
      if (paper.submissionId) await this.quizAttempts.unlink(paper.id, paper.submissionId);
      await this.quizAttempts.link(paper.id, submission.id);
    }

    try {
      // The owner is what makes the scheduler fair: one submission
      // from each learner in turn, rather than one learner's ten before
      // anybody else's first.
      await this.jobs.enqueue('submission', { id: submission.id, ownerId: state.userId });
    } catch (err) {
      // The queue answers within a deadline, and a refusal must not
      // leave a queued row holding this phase's in-flight slot for a job that
      // was never accepted. The learner gets the 503 and an unspent attempt.
      await this.submissions.update(
        { id: submission.id, status: In(['queued', 'running']) },
        { status: 'failed', error: QUEUE_UNAVAILABLE_MESSAGE },
      );
      await this.refundAttempt(state, rowTask, task);
      // The paper goes back to naming no revision, for the same reason the
      // attempt goes back: the queue never took the job, so the learner has no
      // verdict, and a paper still linked to a submission that failed is one
      // they can never hand in again.
      if (paper) await this.quizAttempts.unlink(paper.id, submission.id);
      throw err;
    }

    return this.toView(submission);
  }

  /**
   * The one writer of `quiz_attempts`, over the manager this service already
   * holds.
   *
   * A getter rather than a twelfth constructor argument, for the reason
   * `taskStates` below is one: this class is built by hand in a great many
   * specs, and a required parameter would have made this step an edit to every
   * one of them. The quiz routes inject the Nest-provided instance; two instances
   * over one DataSource are two handles on one table, and every write to that
   * table still goes through a method on that class.
   */
  private quizAttemptWriter: QuizAttemptsService | null = null;

  private get quizAttempts(): QuizAttemptsService {
    return (this.quizAttemptWriter ??= new QuizAttemptsService(
      this.submissions.manager.getRepository(QuizAttemptEntity),
    ));
  }

  /**
   * The paper this submit is handing in, or null when the task is not a quiz.
   *
   * Three refusals and no fourth answer:
   *
   * - a **quiz** task with no attempt id is refused by name, the layer the
   *   IDE's ⌘↵ cannot walk around;
   * - a **non-quiz** task carrying an attempt id is refused by name, because a
   *   silently dropped argument is a caller that has misunderstood which route
   *   it is on;
   * - an attempt id that is not this learner's latest handed-in sheet on this
   *   task is refused in **one** sentence, whether it is unknown, somebody
   *   else's, still open or already superseded.
   *
   * The last of the three is also what makes the grader's read exact. It reads
   * *the newest closed paper*, which has no submission id to key on; this
   * refusal is the statement that the paper verified here and the paper scored
   * there are one row.
   *
   * **Newest of the current attempt epoch**, which is what makes a teacher's
   * reset a clean line: a sheet from before the reset is not the newest paper
   * of the run this task is in now, so handing it in afterwards meets the same
   * one sentence every other wrong attempt id meets.
   */
  private async paperFor(
    state: PhaseStateEntity,
    task: CompiledTask,
    quiz: { attemptId: string } | undefined,
  ): Promise<QuizAttemptEntity | null> {
    if (!isQuizTask(task)) {
      if (quiz) throw notAQuizRefusal(task);
      return null;
    }
    if (!quiz?.attemptId) throw quizNeedsAPaperRefusal(task);
    const latest = await this.quizAttempts.latestHandedIn(
      state.id,
      task.taskKey,
      await this.attemptEpoch(state.id, task.taskKey),
    );
    if (!latest || latest.id !== quiz.attemptId || latest.userId !== state.userId) {
      throw new BadRequestException(QUIZ_PAPER_REFUSAL);
    }
    // A paper that names a revision is one this method has already accepted:
    // **unless that revision failed**, in which case its marking was lost and
    // there is no verdict for it anywhere. The 503 path unlinks the paper
    // itself, but the stall age-out and a non-durable pipeline failure both
    // write `failed` and leave the link, and the learner is then holding a
    // spent attempt and a sheet nobody can hand in for a worker death they did
    // not cause. `queued` and `running` are still being marked and `completed`
    // has its verdict, so both still read as the paper that is no longer
    // waiting: this is a lost marking, never a second bite at a scored paper.
    // The same widening, in the same words, as `paperToHandIn` in `quiz.service.ts`.
    if (latest.submissionId && !(await this.markingLost(latest.submissionId))) {
      throw new BadRequestException(QUIZ_PAPER_REFUSAL);
    }
    return latest;
  }

  /** Did this revision fail, so that the paper naming it has no verdict coming? */
  private async markingLost(submissionId: string): Promise<boolean> {
    const named = await this.submissions.findOne({
      where: { id: submissionId },
      select: { id: true, status: true },
    });
    // A submission id that resolves to no row reads as not lost: the absence
    // of a record is not evidence that no verdict exists.
    return named?.status === 'failed';
  }

  /** The task rows, through the manager the injected repositories already share. */
  private get taskStates(): Repository<TaskStateEntity> {
    return this.submissions.manager.getRepository(TaskStateEntity);
  }

  /**
   * Which run of this quiz a request is about.
   *
   * `task_states.resetCount` IS the attempt epoch (`attemptEpochOf`), and a
   * task with no row yet has had no reset. Read here rather than derived from
   * the papers, because right after a reset there is no paper of the new epoch
   * to derive it from, and that is exactly the moment it matters.
   */
  private async attemptEpoch(phaseStateId: string, taskKey: string): Promise<number> {
    return attemptEpochOf(
      await this.taskStates.findOne({
        where: { phaseStateId, taskKey },
        select: { id: true, resetCount: true },
      }),
    );
  }

  /**
   * The task row this submission is about, written the way `advance` writes a
   * release record: an `orIgnore` insert, so a double-click and a retried
   * request settle on `UQ_task_states_key` rather than on a read-then-write.
   *
   * The row is the **submitted task's**, whatever the phase's task count: the
   * attempt below is spent on it, and the roll-up quantifies over the pinned
   * version's required keys, so a row that is not there is a key that has not
   * passed. Nothing is lost by writing one early and the gate is held shut by
   * a creator that does not fire, never opened.
   *
   * **The third of the three creators of a task row, and the first one a
   * learner of a teacher project with a legacy board reaches.** It therefore
   * carries both: `carriedTaskPass` for the row and `adoptOrphanRevisions`
   * for the history:
   * exactly as the two creators in `workflow.service.ts` do.
   *
   * **Which task a phase-level request is about is `tasks.length === 1`, not
   * `SOLE_TASK_KEY`.** `soleTaskList` is **false** for a one-task phase keyed
   * `main`, which is every phase of
   * every teacher-authored project, so a body defaulting the key to
   * `SOLE_TASK_KEY` would match nothing on the mainline. `SOLE_TASK_KEY` is a
   * *compiled* key, not a default a route may assume.
   */
  private async writeTaskState(
    state: PhaseStateEntity,
    tasks: readonly CompiledTask[],
    task: CompiledTask,
  ): Promise<void> {
    if (soleTaskList(tasks)) return;
    await this.submissions.manager
      .createQueryBuilder()
      .insert()
      .into(TaskStateEntity)
      .values({
        phaseStateId: state.id,
        userId: state.userId,
        taskKey: task.taskKey,
        // The carried pass, under the same three conjuncts the other two
        // creators are bounded by: this is the creator a legacy learner of a
        // teacher project reaches first, so a row created here at
        // `in_progress` on a phase they had already passed would refuse them
        // the merge they had earned, for ever.
        ...(carriedTaskPass(state, tasks, task) ?? {}),
      })
      .orIgnore()
      .execute();
    // After the insert and never inside it: the adoption's trigger is the
    // board's state, and this is the creator a legacy learner is most likely
    // to reach first.
    await adoptOrphanRevisions(this.submissions.manager, state.id, tasks);
  }

  /**
   * Refuse a learner who is already holding their share of the queue.
   *
   * Narrowing `UQ_submissions_in_flight` to `(phaseStateId, taskKey)` is
   * exactly what lets one learner hold one submission per task of every open
   * phase, so **exactness** and **fairness** stop being the same guarantee and
   * need separate mechanisms. This is the fairness one, and it is honestly
   * advisory: a bare count with no lock and no constraint behind it, taken
   * after the idempotent in-flight answer and before the attempt is spent.
   *
   * An old row is not in flight for this purpose by the same rule
   * `inFlightFor` uses, or a job that stalled out on one phase would cap a
   * learner out of every other until they happened to submit to that phase
   * again.
   */
  private async assertRoomInFlight(state: PhaseStateEntity): Promise<void> {
    const cap = config.submitInFlightPerLearner;
    const live = await this.submissions.find({
      where: { userId: state.userId, status: In(['queued', 'running']) },
      select: { id: true, createdAt: true },
    });
    const holding = this.jobs.durable
      ? live.length
      : live.filter((row) => this.ageMs(row) <= IN_FLIGHT_MAX_AGE_MS).length;
    if (holding >= cap) throw new BadRequestException(submissionsInFlightMessage(cap));
  }

  /**
   * The submission this phase is genuinely waiting on, or null.
   *
   * A row that is still queued or running past `IN_FLIGHT_MAX_AGE_MS` is not
   * being graded by anyone: its job stalled out, or the queue gave up on it
   * where nothing was listening. Returning it would hold the phase gate shut
   * for ever, and simply ignoring it would not help either: the partial
   * unique index would refuse the next submission while the old row sits in
   * `queued`. So it is written off first, which frees the slot, and the caller
   * inserts a fresh row.
   */
  private async inFlightFor(
    phaseStateId: string,
    taskKey: string,
    /**
     * `manager`: read through the caller's transaction (the locked submit).
     * Only ever with `ageOut: false`, the age-out writes, and a write from
     * inside the lock would wait on another connection's row lock.
     */
    opts: { ageOut?: boolean; manager?: EntityManager } = {},
  ): Promise<SubmissionEntity | null> {
    const manager = opts.manager;
    const find = manager
      ? (options: Parameters<Repository<SubmissionEntity>['findOne']>[0]) =>
          manager.findOne(SubmissionEntity, options)
      : (options: Parameters<Repository<SubmissionEntity>['findOne']>[0]) =>
          this.submissions.findOne(options);
    const row = await find({
      // Per task, exactly as `UQ_submissions_in_flight` is: two tasks of
      // one phase may be graded at once, and the same task twice may not. On a
      // sole-task phase the key is the column's own backfill default, so this
      // read returns the same row a phase-wide read would.
      where: { phaseStateId, taskKey, status: In(['queued', 'running']) },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    if (!row) return null;
    // Redis owns durable retries and terminal failure, including delayed
    // delivery while a crashed worker's lease expires. A learner retry must
    // never cancel that recoverable job merely because its creation is old.
    if (this.jobs.durable || opts.ageOut === false || this.ageMs(row) <= IN_FLIGHT_MAX_AGE_MS) return row;

    // Scoped to the status it was read at, so a verdict that landed in the
    // meantime is never overwritten by this.
    await this.submissions.update(
      { id: row.id, status: In(['queued', 'running']) },
      { status: 'failed', error: STALLED_SUBMISSION_MESSAGE },
    );
    this.logger.warn(
      `submission ${row.id} was still ${row.status} after ${Math.round(this.ageMs(row) / 60000)} minute(s) — ` +
        'marked failed so the phase is not gated on a job nobody is running',
    );
    return null;
  }

  /** How long ago a row was created; 0 for a timestamp that cannot be read. */
  private ageMs(row: SubmissionEntity): number {
    const created =
      row.createdAt instanceof Date ? row.createdAt.getTime() : Date.parse(String(row.createdAt));
    return Number.isNaN(created) ? 0 : Date.now() - created;
  }

  /**
   * Spend the attempt in the database, not in JavaScript.
   *
   * `state.attempts` was read when the request started, so two submits that
   * overlap both write the same number back and one attempt disappears,
   * which matters because attempts are the denominator of the reliance index.
   * The entity's own copy is kept in step for the caller that holds it.
   *
   * **A quiz hand-in does not spend the phase's counter.** One could argue
   * that an attempt is one of the learner's own submit/iterate actions and a
   * quiz hand-in is one of those, but the product rule is that a quiz retake
   * is exempt from the AI-reliance measure, and
   * `phase_states.attempts` **is** that measure's denominator
   * (`relianceIndex(hints, attempts)`), so the exemption lands here rather than
   * in the formula: a learner who has taken hints can now sit a formative quiz
   * five times without their hints-to-attempts ratio being diluted by papers.
   * `checkers.ts`'s formula needs no quiz-specific case.
   *
   * Two consequences are declared rather than discovered, and both fall the
   * right way: a quiz hand-in does not **suppress** `noEffortFlag` (which is
   * `state.attempts <= 1 && !ranBeforeSubmit && hints >= 6`), and the web's
   * phase door does not read `attempts` (every visit opens the room). The
   * phase's counter means *goes this learner has had at this phase's work*.
   *
   * **`task_states.attempts` is not exempt**, and that is the point of having
   * two counters. It is the task's own visible attempt count: what the panel
   * draws, and no reliance reader touches it. The quiz's *limit* is neither of
   * them: it is `COUNT(*)` over closed `quiz_attempts` rows.
   */
  private async spendAttempt(
    state: PhaseStateEntity,
    task: CompiledTask | null,
    /**
     * The task being submitted, which is not always `task`: `task` is null
     * wherever the phase has no `task_states` row, and the exemption is a
     * question about the kind that scores the work, not about whether a row
     * exists. Absent on no caller; typed optional only so an older call reads
     * as *not a quiz*, which is what it was.
     */
    submitted?: CompiledTask,
    /**
     * The locked submit spends through its own transaction,
     * so a rollback (a double-click that lost at the index) undoes the spend
     * and nothing needs refunding. Absent, the repositories' own manager.
     */
    manager?: EntityManager,
  ): Promise<void> {
    // Only the counter: the entity was loaded before this request did any of
    // its work, and save() would write its stale `workspace` back over an
    // autosave that landed in between.
    if (!(submitted && isQuizTask(submitted))) {
      if (manager) await manager.update(PhaseStateEntity, state.id, { attempts: () => 'attempts + 1' });
      else await this.phaseStates.update(state.id, { attempts: () => 'attempts + 1' });
      state.attempts = (state.attempts ?? 0) + 1;
    }
    // The task's own counter, in the same narrow SQL expression and never a
    // recompute: `sum(tasks.attempts)` would be read before it was written and
    // would clobber a sibling's increment, since two tasks of one phase can
    // be graded at once, so the count would go *backwards*. The phase's number
    // stays exactly what it is (the goes this learner has had at this phase)
    // and on a split phase it is a sum over tasks, a declared looseness of
    // split phases. `task` is null where the phase has no row.
    if (!task) return;
    await (manager ? manager.getRepository(TaskStateEntity) : this.taskStates).update(
      { phaseStateId: state.id, taskKey: task.taskKey },
      { attempts: () => 'attempts + 1' },
    );
  }

  /**
   * Hand an attempt back: the submission it was spent on never produced a
   * verdict, so charging the learner for it would push the reliance index up
   * for an outage they did not cause.
   *
   * **Exactly the same exemption, in the same words, or the refund is a bug.**
   * A quiz hand-in spends no phase attempt, so a refund that decremented one
   * would take back a counter it never spent: pushing `attempts` *below* the
   * work the learner actually did and their reliance index *up*, which is the
   * opposite of what the exemption is for. The two methods ask one predicate.
   */
  private async refundAttempt(
    state: PhaseStateEntity,
    task: CompiledTask | null,
    submitted?: CompiledTask,
  ): Promise<void> {
    if (!(submitted && isQuizTask(submitted))) {
      await this.phaseStates.update(
        { id: state.id, attempts: MoreThan(0) },
        { attempts: () => 'attempts - 1' },
      );
      state.attempts = Math.max(0, (state.attempts ?? 1) - 1);
    }
    if (!task) return;
    await this.taskStates.update(
      { phaseStateId: state.id, taskKey: task.taskKey, attempts: MoreThan(0) },
      { attempts: () => 'attempts - 1' },
    );
  }

  /**
   * Where one verdict lands: the task's row, then the phase's roll-up, under
   * the same lock and inside the caller's transaction.
   *
   * **The lock is on the enrolment**, taken by `lockEnrollment` from
   * `db/enrollment-lock`, the same lock `advance` takes through
   * `heldEnrollment`, and on PostgreSQL only, where SQLite serialises writers
   * anyway. That is the right row: it is the one every writer of a phase's
   * status can reach from, it is the row `advance` already holds, and a lock
   * on the phase state would not serialise two writers moving two phases of
   * one enrolment against `advance`'s whole-board read.
   *
   * Without it, two verdicts for the last two required tasks each write their
   * own row and then read the task set without seeing the other's commit: both
   * answer *not every required task has passed*, the phase is left `submitted`
   * with every required task `passed`, and **nothing later corrects it**. The
   * sign-off case is the worst of them, because a countersignature happens
   * once.
   *
   * The phase state keeps its narrow, unlocked `{ id }` read and its narrow
   * `{ id }` write: the three roll-up columns and nothing else on the row.
   *
   * **And the lock is what makes the attempt-epoch comparison answerable.** A
   * grading job enqueued before a teacher's `task-reset` arrives after it, and
   * `verdictIsOfAnotherRun` above asks whether the paper it is carrying still
   * belongs to the run the task row is on. That question is *about* the commit
   * the two are racing, so both of its reads are taken here: after the lock,
   * inside this transaction, and never handed in from outside it. `task-reset`
   * takes the same lock on the same row (`instructor.service.ts`), so the two
   * writers see each other's work whole or not at all. The regrade asks the
   * same predicate under its own copy of this lock (`regrade.service.ts`).
   */
  private async writeVerdict(
    manager: EntityManager,
    state: PhaseStateEntity,
    tasks: readonly CompiledTask[],
    task: CompiledTask,
    verdict: { passed: boolean; overall: number },
    now: string,
    /** The revision this verdict is for, where the caller has one. */
    submissionId?: string,
  ): Promise<{ held: PhaseStateEntity; roll: PhaseRollup; taskAttempts: number | null }> {
    await lockEnrollment(manager, { id: state.enrollmentId, userId: state.userId });
    const held = await manager.findOneByOrFail(PhaseStateEntity, { id: state.id });

    let states: HeldTaskState[] = [];
    let taskAttempts: number | null = null;
    // A sole task again, and it is the proof rather than an optimisation: a
    // sole-task phase reads no task row and writes none, so the three columns
    // below are written by the phase-level expression.
    if (!soleTaskList(tasks)) {
      const mine = await this.heldTaskRow(manager, state, task);
      taskAttempts = mine.attempts ?? null;
      // A verdict for a paper of a run that has ended is
      // history and nothing else. It is already stored on the revision (the
      // `update` that wrote `status`, `score`, `passed` and `report` ran before
      // this method was called, in this transaction) and `record` puts it back
      // on the paper afterwards. What it must not do is move a gate: the row
      // below belongs to the run the reset started, and neither its status nor
      // the `bestScore` the reset nulled is this verdict's to write.
      if (await verdictIsOfAnotherRun(manager, task, mine, submissionId)) {
        this.logger.warn(
          `submission ${submissionId} was marked for an attempt epoch task "${task.taskKey}" has left on phase state ${state.id}; the verdict is kept on the revision and the paper and moves no gate`,
        );
        return {
          held,
          // The roll-up as it stands, so the caller's transition reads
          // `before === after` and the bell announces a gate that did not move.
          roll: { status: held.status, passedAt: held.passedAt, bestScore: held.bestScore },
          taskAttempts,
        };
      }
      await manager.update(
        TaskStateEntity,
        { phaseStateId: state.id, taskKey: task.taskKey },
        taskRollup(mine, task, verdict, now),
      );
      // Read back inside the transaction, so the roll-up quantifies over this
      // verdict's own write and over every sibling's committed one.
      states = await manager.find(TaskStateEntity, { where: { phaseStateId: state.id } });
    }

    const roll = phaseRollup(held, tasks, states, verdict, now);
    await manager.update(PhaseStateEntity, state.id, roll);
    return { held, roll, taskAttempts };
  }

  /**
   * This task's row as the verdict found it, created if the board never got
   * one: an `orIgnore` insert, so a repair landing at the same instant
   * settles on `UQ_task_states_key` rather than on a read-then-write.
   */
  private async heldTaskRow(
    manager: EntityManager,
    state: PhaseStateEntity,
    task: CompiledTask,
  ): Promise<TaskStateEntity> {
    const where = { phaseStateId: state.id, taskKey: task.taskKey };
    const held = await manager.findOne(TaskStateEntity, { where });
    if (held) return held;
    await manager
      .createQueryBuilder()
      .insert()
      .into(TaskStateEntity)
      .values({ ...where, userId: state.userId })
      .orIgnore()
      .execute();
    return manager.findOneOrFail(TaskStateEntity, { where });
  }

  /**
   * Grade one submission. Registered as the durable 'submission' job handler:
   * it takes only an id and reloads everything from the database, so any
   * worker can execute it, including after a restart, when the queue
   * re-delivers a job whose original worker died mid-grading. A renewable job
   * lock and database lease prevent concurrent work; only its holder may commit.
   * Completed verdicts are immutable.
   */
  async processSubmission({ id }: JobPayload): Promise<void> {
    const submission = await this.submissions.findOne({ where: { id } });
    if (submission?.status === 'completed' || submission?.status === 'failed') return;
    if (!submission) {
      this.logger.warn(`submission ${id} vanished before grading; nothing to do`);
      return;
    }
    const state = await this.phaseStates.findOne({ where: { id: submission.phaseStateId } });
    if (!state) {
      await this.submissions.update(id, {
        status: 'failed',
        error: 'The phase this submission belongs to no longer exists.',
      });
      return;
    }
    const enrollment = await this.enrollments.findOneByOrFail({ id: state.enrollmentId });
    // The phase this attempt is graded
    // against. A published version is immutable so that a rubric, a hidden
    // suite or a threshold cannot move under an attempt, and this is the line
    // that promise is kept at.
    const phase = this.content.getPhaseForEnrollment(enrollment, state.phaseKey);
    // A job for a phase the pinned version holds in an older form (one queued
    // while the version was converted, or one whose learner's pin moved after
    // the submit) fails closed as "did not grade", with the room's own sentence.
    const older = olderFormatRoomSentence(phase);
    if (older) {
      await this.submissions.update(id, { status: 'failed', error: older });
      return;
    }
    // The task list this attempt is graded against, from the same
    // pin and the same resolution the phase came from, never the head. It is
    // read here, outside every transaction, because the builders, the rubric
    // they read and the gate they hand their report to all need it and none of
    // them may issue a second, disagreeing read.
    const tasks = this.content.getTasksForEnrollment(enrollment, state.phaseKey);

    // Grade the immutable bytes submitted, even while autosave continues or a worker restarts.
    if (!submission.workspaceSnapshot || !submission.contextSnapshot) {
      await this.submissions.update(id, { status: 'failed', error: 'Submission evidence is missing. Save your work and submit a new revision.' });
      return;
    }
    const graded = { ...state, ...submission.contextSnapshot, acceptedScreenCopy: submission.contextSnapshot.acceptedScreenCopy ?? null, workspace: submission.workspaceSnapshot, runClock: submission.runClock ?? null };
    const processingToken = randomUUID();
    const now = new Date().toISOString();
    const started = await this.submissions.update([
      { id, status: 'queued' },
      { id, status: 'running', processingLeaseUntil: IsNull() },
      { id, status: 'running', processingLeaseUntil: LessThan(now) },
    ], { status: 'running', processingToken, processingLeaseUntil: new Date(Date.now() + IN_FLIGHT_MAX_AGE_MS).toISOString() });
    if (!started.affected) {
      const held = await this.submissions.findOneBy({ id });
      if (this.jobs.durable && held?.status === 'running' && held.processingLeaseUntil) throw new JobDeferredUntil(Date.parse(held.processingLeaseUntil));
      return;
    }
    this.events.emitJob(state.userId, {
      type: 'submission',
      id,
      phaseStateId: state.id,
      status: 'running',
    });

    const task = taskForRevision(tasks, submission.taskKey);
    // Null wherever the phase has no task row, which is every phase of the
    // shipped project.
    const rowTask = task && !soleTaskList(tasks) ? task : null;
    try {
      if (!task) {
        throw new Error(
          `submission ${id} names task "${submission.taskKey}", which ${phase.key} does not declare`,
        );
      }
      // The revision, so a quiz is scored against the sheet that names it
      // rather than against whichever sheet is newest. On this path the two
      // are one row (`paperToHandIn` and `submit` between them see to that) and saying so
      // costs a keyed read and removes the reliance.
      const report = await this.buildReport(phase, graded, tasks, task, id);
      const passed = report.passed;
      const landed = await atomic(this.submissions.manager.connection, async manager => {
        const committed = await manager.getRepository(SubmissionEntity).update({ id, processingToken, status: In(['queued', 'running']) }, {
          status: 'completed', score: report.overall, passed, report,
        });
        if (!committed.affected) return null;
        // The task's row and the phase's roll-up, in this transaction and
        // under the enrolment lock. `passed` is this **task's** answer; what
        // the phase does with it is the roll-up's to say, and the revision's
        // id goes with it, because which run of a quiz this verdict belongs to
        // is a question about the paper that names it.
        return this.writeVerdict(
          manager, state, tasks, task, { passed, overall: report.overall }, new Date().toISOString(), id,
        );
      });
      if (!landed) return;
      // The verdict, back on the paper it was earned
      // on. The submission is the record; this is what makes a learner's
      // export of `quiz_attempts` read as a list of papers *with results*
      // rather than a list of papers. It is after the verdict has landed and
      // never allowed to be the thing that fails one.
      if (isQuizTask(task)) {
        await this.quizAttempts.record(id, report.overall, passed).catch((err) => {
          this.logger.warn(`submission ${id}: the quiz result was not recorded on its paper: ${errorName(err)}`);
        });
      }
      // The bell. Never allowed to fail a verdict: a notification
      // is a pointer, the grade is the record. The held row rather than
      // `state` because it carries this attempt's count and best score, which
      // are what the stuck sentence is about; the transition beside it because
      // on a split phase a task's pass and a phase's opening are two different
      // events and only the roll-up knows which one just happened.
      await this.notifications.onVerdict(landed.held, id, report, passed, {
        before: landed.held.status,
        after: landed.roll.status,
        taskKey: task.taskKey,
        taskAttempts: landed.taskAttempts,
      }).catch((err) => {
        this.logger.warn(`submission ${id}: the verdict notification was not sent: ${errorName(err)}`);
      });
    } catch (err) {
      // The runner was never reached, so this is not a verdict. Nothing
      // about the phase changes (no bestScore, no status, no passedAt) and
      // the attempt goes back, because an outage is not a failed attempt at
      // the rubric. The transport's own message names a socket path or a
      // Lambda function and never reaches the learner.
      if (err instanceof RunnerUnavailableError) {
        this.logger.error(`submission ${id} could not reach the code runner; attempt refunded`);
        // Scoped to a row still in flight, so a redelivery of the same job
        // cannot refund the attempt twice or overwrite a verdict that landed
        // between the two deliveries.
        const written = await this.submissions.update(
          { id, processingToken, status: In(['queued', 'running']) },
          { status: 'failed', error: err.message },
        );
        if (written.affected) await this.refundAttempt(state, rowTask, task);
        return;
      }

      captureException(err, { kind: 'submission', jobId: id, userId: state.userId, phase: phase.key });

      // `failed` is final in the workspace, so it is only written when
      // nothing is going to run this job again. A durable queue retries (and
      // writes the row itself through the terminal-failure sink once it gives
      // up) so the row is left in flight and keeps its slot in the unique
      // index, which is what stops a resubmit from racing the retry. Without
      // a durable queue there is no second attempt, so this exception is the
      // end of the line and the learner has to be told.
      if (!this.jobs.durable) {
        await this.submissions.update(
          { id, processingToken, status: In(['queued', 'running']) },
          { status: 'failed', error: PIPELINE_FAILED_MESSAGE },
        );
      }
      throw err; // let the queue count the attempt and retry
    } finally {
      // A failed durable attempt releases its own lease for the queue's retry.
      // A superseded worker cannot clear the newer worker's lease.
      await this.submissions.update({ id, processingToken }, { processingToken: null, processingLeaseUntil: null });
      const finished = await this.submissions.findOne({ where: { id }, select: { status: true } });
      this.events.emitJob(state.userId, {
        type: 'submission',
        id,
        phaseStateId: state.id,
        status: finished?.status ?? 'failed',
      });
    }
  }

  /**
   * One sandbox run, with the transport failure separated from the verdict.
   *
   * `execute` does not throw: a socket that is not there, a Lambda that cannot
   * be reached and a harness that died all come back as a result object, and
   * every scorer downstream reads a result with no `tests` as a zero. That is
   * how an outage was written into a learner's record as a failed rubric. The
   * `unavailable` outcome is the one case that is not an answer about their
   * code, so it leaves the pipeline here and `processSubmission` decides what
   * to do with it.
   */
  private async runSandbox(job: SandboxJob, clock?: string | null): Promise<RunResult> {
    // The one place this file reaches the sandbox, so the clock is
    // set here rather than at each caller. That is what makes the kill matrix
    // answerable: the reference run and all six mutant runs saw one instant by
    // construction, not because three call sites agreed.
    const run = await this.sandbox.execute(clock ? { ...job, clock } : job);
    if (isRunnerUnavailable(run)) throw new RunnerUnavailableError(runnerSentence(run));
    return run;
  }

  /** What the reviewer is shown: a structured kind's labelled fields, or the learner's editable files (a record's beside them as labelled fields). */
  private reviewWorkspace(phase: PhaseContent, slice: PhaseChecks, fresh: PhaseStateEntity): Record<string, string> {
    const files = this.content.executionFiles(phase, fresh.workspace);
    if (slice.kind === 'story') return storyWorkspaceForReview(files[slice.record]);
    if (slice.kind === 'design') return designWorkspaceForReview(slice, files);
    const snapshot = this.editableSnapshot(phase, fresh, files);
    return recordWorkspaceForReview(slice, snapshot, files) ?? snapshot;
  }

  /** The learner's own files at submission time; scaffold-only files add nothing. `files` when the caller already built them. */
  private editableSnapshot(phase: PhaseContent, state: PhaseStateEntity, files = this.content.executionFiles(phase, state.workspace)): Record<string, string> {
    const snapshot: Record<string, string> = {};
    for (const spec of phase.files) if (spec.editable) snapshot[spec.path] = files[spec.path] ?? '';
    return snapshot;
  }

  private async hintsForPhase(phaseStateId: string): Promise<number> {
    return this.messages.count({ where: { phaseStateId, role: 'user' } });
  }

  /**
   * The phase's Agentic proposals, for the process sentence only: one read on
   * `agent_proposals`' (userId, phaseStateId) index, through the manager the
   * message repository already holds. Null when it cannot be read (a double
   * without a manager, a table not there): the sentence then says nothing
   * about Agentic.
   */
  private async agenticUseFor(state: PhaseStateEntity): Promise<AgenticUse | null> {
    try {
      const rows = await this.messages.manager.getRepository(AgentProposalEntity).find({
        select: { id: true, appliedAt: true },
        where: { userId: state.userId, phaseStateId: state.id },
      });
      return { proposals: rows.length, applied: rows.filter((row) => row.appliedAt).length };
    } catch (err) {
      this.logger.warn(`phase state ${state.id}: the Agentic proposals could not be read: ${errorName(err)}`);
      return null;
    }
  }

  /**
   * Grade files that are already stored, rather than the workspace as it is
   * now.
   *
   * A regrade re-runs an old revision against the pack on disk today, so the
   * files are the snapshot that revision kept and the phase state is a
   * detached copy the caller never saves. Nothing else about the pipeline
   * changes: the same report, the same scorers, the same runner, which is the
   * point, because a regraded verdict has to be comparable with the one it
   * replaces.
   *
   * `submissionId` is **the revision being re-run**, not the regrade's own row:
   * the parent, whose snapshot `state` carries. A quiz is the one kind of
   * work whose evidence is not in that snapshot: the sheet is a row of its
   * own, and the revision is the only thing that names which row. Every other
   * builder ignores it. See `buildQuizReport`.
   */
  async gradeSnapshot(
    phase: PhaseContent,
    state: PhaseStateEntity,
    tasks: readonly CompiledTask[],
    task: CompiledTask,
    submissionId?: string,
  ): Promise<FeedbackReport> {
    return this.buildReport(phase, state, tasks, task, submissionId);
  }

  /**
   * `fresh` is the state as the job read it, not as the request left it: the
   * caller re-reads before grading and stores the same read as the revision's
   * snapshot, so the verdict and the files it is shown against are the same
   * bytes by construction.
   *
   * Public so specs can grade a hand-built state directly; production callers
   * use `gradeSnapshot` (the regrade) or `processSubmission`.
   */
  async buildReport(
    phase: PhaseContent,
    fresh: PhaseStateEntity,
    /**
     * The pinned version's whole task list, and the one task this revision is
     * about. Both are required rather than defaulted: a default
     * would be a second answer to *which task is this*, and on a
     * teacher-authored phase (every one of which is keyed `main`) the obvious
     * default is the wrong one.
     */
    tasks: readonly CompiledTask[],
    task: CompiledTask,
    /**
     * The revision this verdict is for, where the caller has one. Only the
     * quiz builder reads it, and only to resolve the sheet by the column that
     * names it rather than by *which sheet is newest*; omitted, the quiz
     * builder falls back to the newest sheet and every other arm ignores it.
     */
    submissionId?: string,
  ): Promise<FeedbackReport> {
    phase = withScreenCopy(phase, fresh.acceptedScreenCopy);
    const hints = await this.hintsForPhase(fresh.id);

    let partial: PartialReport;
    // The deployment sections re-use the smoke run the gate already paid for.
    let smoke: SmokeCheckResult | undefined;
    /**
     * The quiz fork comes **before** the switch, for a reason that is easy
     * to get wrong.
     *
     * `buildReport`'s switch is on `phase.checks.kind`. A quiz task sits in a
     * phase whose checks are a record, or code, or tests, or config, under
     * the all-six-phases rule, so the switch is exactly the thing that must
     * **not** be what finds it. `checksOf(phase, task)` is the task's own
     * slice, which is where a quiz declares itself, and asking it here leaves
     * the four non-quiz arms unaware of quizzes. That is what the
     * verdict-golden net proves, and it is why the switch has no quiz case.
     */
    const slice = checksOf(phase, task);
    const quiz = slice.kind === 'quiz' ? slice : null;
    // One row per sandbox job this verdict is
    // built from, filled in by whichever builder runs them and kept on the
    // stored report. A phase with no sandbox job leaves it empty and the field
    // stays absent. The drill's run against the pack's faulted copy is not one
    // of them: `reportExtras` runs after this object is assembled, and that
    // machine is counted in `sandbox_execution_duration_seconds` alone.
    const timings: ReportStepTiming[] = [];
    // The switch stays a switch on the **phase's** kind, and the three
    // executable builders keep `phase.checks` and `phase.rubric` verbatim:
    // coding, testing and deployment phases hold one work task each. The
    // written arms take the task's slice where it carries one.
    if (quiz) {
      partial = await this.buildQuizReport(quiz, fresh, task, submissionId);
    } else switch (phase.checks.kind) {
      case 'code':
        partial = await this.buildCodeReport(phase, phase.checks, fresh, hints, timings);
        break;
      case 'tests':
        partial = await this.buildTestsReport(phase, phase.checks, fresh, timings);
        break;
      case 'config': {
        const built = await this.buildConfigReport(phase, phase.checks, fresh, timings);
        partial = built.report;
        smoke = built.smoke;
        break;
      }
      // The fork above took every quiz, so this arm is
      // unreachable for one: `checksOf` answers the phase's checks whenever
      // the task declares no slice of its own, so a phase whose OWN kind is
      // `quiz` has already been scored as a paper by the time this switch
      // runs. What is left is the shape nobody can author and the compiler
      // would refuse: a quiz **phase** whose one task carries a slice of some
      // other kind. The arm stays because `let partial: PartialReport` is
      // used-before-assigned without it, and it refuses loudly rather than
      // inventing a verdict.
      case 'quiz':
        throw new Error(
          `${phase.key}: this phase is scored as a quiz, but ${task.taskKey || 'its sole task'} is not`,
        );
      case 'story': {
        const checks = slice.kind === 'story' ? slice : phase.checks;
        const files = this.content.executionFiles(phase, fresh.workspace);
        partial = buildStoryPartial(task.rubric, checks, files[checks.record]);
        break;
      }
      case 'design': {
        const checks = slice.kind === 'design' ? slice : phase.checks;
        partial = buildDesignReport(task.rubric, checks, this.content.executionFiles(phase, fresh.workspace));
        break;
      }
      default:
        // An older written phase is never graded: the API refuses its submit and
        // its run, and a job already queued for one fails closed with the room's sentence before it gets
        // here; this arm fails closed too. An older Requirements or Design is not retired, only
        // unconverted, so it answers its own older-format room sentence; every other key answers the
        // retired phase's.
        throw new Error(olderFormatRoomSentence(phase) ?? RETIRED_WRITTEN_PHASE_ROOM);
    }

    // **No provider is asked to score set
    // equality.** `aiReview` is not optional on a `FeedbackReport` and
    // `buildReport` is its only producer, so "the model is skipped" has to be
    // written down as a value rather than as an omission, and it must not be
    // the `'unavailable'` stub, which means *a model was asked and did not
    // answer*, draws the degraded-grading banner over a paper that scored 100,
    // and is refused outright by `strictTaskEvidencePassed`'s first clause.
    const aiReview = quiz
      ? quizReview(task, partial.overall, quiz.passMark)
      : await this.assistant.reviewSubmission(phase, fresh, {
          workspace: this.reviewWorkspace(phase, slice, fresh),
          criteria: partial.criteria,
          checks: partial.checks,
          overall: partial.overall,
          hints,
          ranBeforeSubmit: fresh.ranBeforeSubmit,
          // The third input to the verdict, about the same task the gate is
          // about. The snapshot above stays the phase's: the task's paths are
          // evidence, the phase's others are context, and only the first are
          // citable.
          task,
          // The pinned list beside the task, so the
          // reviewer knows which task the web routes to the phase's room.
          phaseTasks: tasks,
        });

    // The same function for a quiz as for everything else, and **not** a
    // hand-written zero. Only the paste half is zero:
    // a quiz owns no file, so `editable` is empty and `mentorPasteFlag` is
    // false, everything else is read off the phase's own counters, so a
    // quiz's report carries the phase's live reliance signals. Assembling it
    // from `integrityFor` rather than from a literal is also what keeps a
    // future signal from being silently missing on quizzes alone.
    const integrity = await this.integrityFor(phase, fresh, hints, task);

    const report: FeedbackReport = {
      ...partial,
      assessmentMode: 'strict_binary',
      // `quizPassed` here, and `strictTaskEvidencePassed` everywhere else,
      // with the quiz's report built so that the second answers the first.
      // That equivalence is the whole design: `advance`, project completion and three instructor
      // readers re-ask `strictTaskEvidencePassed` of the **stored** report
      // long after this function has finished with it, and a fork at five call
      // sites is five places that can disagree about one gate.
      passed: quiz
        ? quizPassed(partial.overall, quiz.passMark)
        : strictTaskEvidencePassed(task, partial, aiReview),
      aiReview,
      aiReliance: { hintsThisPhase: hints, index: relianceIndex(hints, fresh.attempts) },
      integrity,
      ...(timings.length ? { timings } : {}),
    };
    let extras: Partial<FeedbackReport> = {};
    try {
      extras = await this.reportExtras(phase, fresh, report, smoke, task);
    } catch (err) {
      // These sections are additive and change no score, so losing one must
      // not cost the learner a graded submission.
      captureException(err, { kind: 'report-sections', userId: fresh.userId, phase: phase.key });
    }
    return { ...report, ...extras };
  }

  /**
   * The phase-specific sections, each from its own module and each only where
   * the phase has the material for it: the conformance ledger needs a design
   * contract to hold the code against, the pipeline and drill need a
   * Dockerfile and a workflow, the impact report needs an earlier baseline.
   * None of them changes a score.
   *
   * **Quizzes are excluded first.** Every test below is on the **phase's**
   * key and none of them is on the task, so without this guard a quiz handed
   * in on the deployment phase would reach `drillFor`, which runs
   * `runSmokeCheck` against the pack's faulted copy: a real microVM, off the
   * request path, billed to a hand-in that scored an MCQ by set equality. A
   * quiz on implementation or maintenance would likewise attach a conformance
   * ledger and an impact report built out of **another task's** static
   * analysis. The guard is what makes *"a quiz costs zero microVMs"* true here
   * as well as in `sandboxBudgetFor`, which is why it is stated at the top
   * rather than folded into the three conditions: a quiz has no material for
   * any of these sections, whatever phase it sits in.
   *
   * `task` is a parameter because the sections are phase-shaped, and
   * the one fact that separates them is the kind that scores the task the
   * report is about. It is asked through `isQuizTask`, so this site and the
   * compiler's budget cannot answer differently.
   */
  private async reportExtras(
    phase: PhaseContent,
    state: PhaseStateEntity,
    report: FeedbackReport,
    smoke: SmokeCheckResult | undefined,
    task: CompiledTask,
  ): Promise<Partial<FeedbackReport>> {
    const extras: Partial<FeedbackReport> = {};

    if (isQuizTask(task)) return extras;

    if (phase.key === 'implementation' || phase.key === 'maintenance') {
      const contract = buildContractLedger(
        await this.designSources(phase, state),
        report,
        report.staticAnalysis,
      );
      if (contract.length) extras.contract = contract;
    }

    if (phase.key === 'maintenance') {
      const impact = buildImpactReport(
        await this.baselineAnalysis(state),
        report.staticAnalysis,
        report.tests?.cases ?? [],
      );
      if (impact) extras.impact = impact;
    }

    if (phase.key === 'deployment') {
      const files = this.content.executionFiles(phase, state.workspace);
      const ci = buildCiSteps(files['.github/workflows/ci.yml'] ?? '', smoke);
      if (ci.length) extras.ci = ci;
      const drill = await this.drillFor(phase, files, smoke, state);
      if (drill) extras.drill = drill;
    }

    return extras;
  }

  /**
   * INCIDENT-1: the same smoke check against the faulted copy the pack ships
   * and against the learner's current files, so the report can say whether the
   * fault reproduced and whether the fix holds.
   */
  private async drillFor(
    phase: PhaseContent,
    files: Record<string, string>,
    smoke: SmokeCheckResult | undefined,
    state: PhaseStateEntity,
  ): Promise<DrillReport | undefined> {
    // Only a config phase has a smoke check to fail, and only packs that
    // declare a fault have a drill at all.
    const drill = phase.checks.kind === 'config' ? phase.checks.drill : undefined;
    if (!drill) return undefined;
    const before = await this.runSmokeCheck(phase, { ...files, ...drill.faultedFiles });
    return buildDrillReport({
      fault: drill.fault,
      description: drill.description,
      failedBeforeFix: !before.ok,
      passedAfterFix: smoke?.ok ?? false,
      // The diagnosis reads the incident alone, through the drill's one reader,
      // over the learner's own workspace: the saved record's incident, or an
      // older drill's stored one when the workspace holds no record (the
      // loader's seeded record in `files` is not theirs). A phase without a
      // runbook record has no incident to read.
      incident: hasRecord(phase.checks)
        ? drillWithIncident(state.drill ?? unpagedDrill(drill.fault), state.workspace, phase)?.incident ?? null
        : null,
      // ops/selfcheck.py prints its fault to
      // stdout and exits 1, so reading stderr alone leaves the learner's panel empty.
      beforeStderr: (before.stderr || before.stdout || before.problem || '').slice(0, DRILL_OUTPUT_MAX),
      afterStdout: (smoke?.stdout ?? '').slice(0, DRILL_OUTPUT_MAX),
    });
  }

  /**
   * The version of the pack grading this attempt (the `packVersion` column).
   * Null when the enrolment or the pack cannot be read: a version is a note in
   * the margin and must never be the reason a submission is refused.
   *
   * Read from the enrolment's pinned version, never the published *head's*:
   * a learner pinned to 1.0.0 while 2.0.0 is published would otherwise carry
   * `2.0.0` on every submission, so the column the regrade tooling reads (the
   * column that exists so that "a regrade after a rubric fix is not
   * guesswork") would name a version that had graded nothing.
   */
  private async packVersionFor(state: PhaseStateEntity): Promise<string | null> {
    try {
      const enrollment = await this.enrollments.findOne({ where: { id: state.enrollmentId } });
      return enrollment ? this.content.getForEnrollment(enrollment).version : null;
    } catch (err) {
      this.logger.warn(`phase state ${state.id}: the pack version could not be read: ${errorName(err)}`);
      return null;
    }
  }

  /**
   * What the learner promised, for the phase being graded: the design phase's
   * files for the same enrolment, where its version holds Design, plus the
   * contract record this phase carries of its own. The lookup is by enrolment,
   * never by request input, and never writes.
   */
  private async designSources(
    phase: PhaseContent,
    state: PhaseStateEntity,
  ): Promise<Record<string, string>> {
    const enrollment = await this.enrollments.findOneByOrFail({ id: state.enrollmentId });
    const sources: Record<string, string> = {};
    // The pinned version holds Design: read its contract as the learner left it. Without Design, the phase's
    // own carried contract is the ledger's only source; `phaseOf` keeps its 404 for everyone else.
    if (holdsPhase(this.content.getForEnrollment(enrollment), 'design')) {
      const design = await this.phaseStates.findOne({
        where: { enrollmentId: state.enrollmentId, phaseKey: 'design' },
      });
      // The design phase the conformance ledger
      // reads, resolved from the enrolment like the phase being graded.
      const designPhase = this.content.getPhaseForEnrollment(enrollment, 'design');
      Object.assign(sources, this.content.executionFiles(designPhase, design?.workspace ?? null));
    }

    // Maintenance amends the contract rather than restating it: the phase carries
    // its own `design/contracts.json`, seeded at unlock from the design record,
    // and an operation the learner adds there is one the changed code answers to.
    const carried = phase.files.find((f) => f.editable && /(^|\/)contracts\.json$/i.test(f.path));
    if (carried) sources[carried.path] = state.workspace?.[carried.path] ?? carried.content;
    return sources;
  }

  /**
   * The analyzer report for the code as the learner left it at the end of
   * implementation: the baseline a maintenance change is measured against.
   */
  private async baselineAnalysis(state: PhaseStateEntity): Promise<AnalyzerReport | undefined> {
    const implementation = await this.phaseStates.findOne({
      where: { enrollmentId: state.enrollmentId, phaseKey: 'implementation' },
    });
    if (!implementation) return undefined;
    const recent = await this.submissions.find({
      where: { phaseStateId: implementation.id, status: 'completed' },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: BASELINE_REPORTS_SCANNED,
    });
    return recent.find((row) => row.report?.staticAnalysis)?.report?.staticAnalysis;
  }

  /**
   * Academic-integrity & over-reliance signals. Never changes the score:
   * it surfaces process concerns for the learner and the instructor: heavy
   * mentor reliance, a verbatim paste of a mentor reply into the artefact, and
   * a first-attempt pass with no run and many hints.
   */
  private async integrityFor(
    phase: PhaseContent,
    state: PhaseStateEntity,
    hints: number,
    task: CompiledTask,
  ): Promise<IntegritySignals> {
    const index = relianceIndex(hints, state.attempts);
    const relianceFlag = index >= RELIANCE_FLAG_THRESHOLD;

    const files = this.content.executionFiles(phase, state.workspace);
    // The artefact a paste is looked for in is **this task's**: a passage a
    // learner pasted into a sibling's file is not a signal about this task's
    // work, and flagging it would accuse the wrong answer. The phase's own
    // order is kept, and for a sole task `owns` is every editable path, so the
    // list is the list it was.
    const editable = phase.files
      .filter((f) => f.editable && task.owns.includes(f.path))
      .map((f) => f.path);
    const artifact = editable.map((p) => files[p] || '').join('\n');
    const mentorReplies = (
      await this.messages.find({
        // Review-spend rows are metering, not something the learner could paste.
        where: { phaseStateId: state.id, role: 'assistant', provider: Not(REVIEW_USAGE_PROVIDER) },
        select: ['content'],
      })
    ).map((m) => m.content);
    // Everything the pack put in front of this learner: the task panel, the
    // brief, the objectives and every file they were given, including the ones
    // they may since have edited, in the state the pack ships them. A phrase
    // they were handed is not a phrase they took from the mentor.
    const given = [
      phase.taskPanel || '',
      phase.intro || '',
      ...(phase.objectives || []),
      ...Object.values(this.content.executionFiles(phase, null)),
    ];
    const mentorPasteFlag = detectMentorPaste(artifact, mentorReplies, MENTOR_PASTE_WINDOW, given);

    const noEffortFlag = state.attempts <= 1 && !state.ranBeforeSubmit && hints >= NO_EFFORT_MIN_HINTS;

    const notes: string[] = [];
    if (mentorPasteFlag) notes.push('a passage matching a mentor reply appears in your artefact');
    if (relianceFlag) notes.push(`AI-reliance is high (${index}%)`);
    if (noEffortFlag) notes.push('passed first try with no run and heavy hint use');
    return {
      relianceFlag,
      relianceIndex: index,
      mentorPasteFlag,
      noEffortFlag,
      note: notes.length
        ? `Integrity signals: ${notes.join('; ')}. These do not change your score — they are here so you (and your instructor) can reflect on how the work was done.`
        : 'No integrity concerns flagged — healthy, self-directed process.',
    };
  }

  /* --------------------------------- quiz -------------------------------- */

  /**
   * The verdict on one paper.
   *
   * **No provider is called, no token is spent, no guardrail is consulted.**
   * Scoring a multiple-choice answer is exact set equality over option ids,
   * which is a comparison and not a judgement.
   *
   * Three things are load-bearing:
   *
   * 1. **Exactly one `FeedbackCheck`, id `quiz`.** `report.checks` is
   *    quantified over by `strictTaskEvidencePassed`, which `advance`, project
   *    completion and three instructor readers ask of the **stored** report.
   *    One `failed` check per wrong answer would silently replace the
   *    teacher's pass mark with *no wrong answers*: a required quiz passed at
   *    80% would open its phase through the roll-up and then refuse the
   *    advance for ever. The per-question half rides in the optional
   *    `FeedbackReport.quiz` section instead, which nothing quantifies over.
   * 2. **`correct` is in none of it.** The key is read here, off the pinned
   *    version's sealed slice, and nothing derived from it but the word
   *    `right` or `wrong` goes into the report. The explanation is released
   *    only under `releaseExplanations`' rule, computed from the row and the task rather than
   *    sent as a flag a browser could flip.
   * 3. **One pass, no early return.** The verdict is produced by the
   *    submission job rather than by the request, and the sheet is scored
   *    whole, so neither latency nor the shape of the work carries how many
   *    answers were right.
   *
   * **Which paper.** The revision names it: `quiz_attempts.submissionId` is
   * written before the job is enqueued, so `forSubmission` is the question
   * asked directly rather than inferred. *The newest handed-in row* is the
   * answer only where there is no revision to name, and it is then the right
   * answer, because `paperToHandIn` refuses a second paper while the first is still being
   * marked and `submit` refuses a hand-in that does not name the newest closed
   * sheet. Those two refusals stand in front of the live path and in front of
   * nothing else: `gradeSnapshot` is reached by the regrade, months later and
   * against a revision an instructor chose, so a grader that read *newest*
   * there would score whatever the learner has handed in since onto the
   * revision being appealed, and `taskRollup`'s `Math.max` would take it.
   */
  private async buildQuizReport(
    checks: QuizChecks,
    state: PhaseStateEntity,
    task: CompiledTask,
    /** The revision this verdict is for, where the caller has one. */
    submissionId?: string,
  ): Promise<PartialReport> {
    let paper = submissionId ? await this.quizAttempts.forSubmission(submissionId) : null;
    if (!paper) {
      const epoch = await this.attemptEpoch(state.id, task.taskKey);
      const latest = await this.quizAttempts.latestHandedIn(state.id, task.taskKey, epoch);
      // A revision that names no paper of its own is not always a missing
      // record: a queue that answered 503 takes the link back, and what it
      // leaves is one closed sheet naming no revision, which is that
      // revision's sheet, handed in again when the queue is back. A sheet that
      // *another* revision already owns can never be this one's, so it falls
      // to the refusal below rather than being borrowed. With no revision in
      // hand the newest sheet is the answer, unchanged.
      paper = submissionId && latest?.submissionId ? null : latest;
    }
    if (!paper?.answers) {
      // A quiz with no sheet is not a low score, it is a missing record, and
      // the difference matters: `submit` refuses a quiz that names no paper,
      // so reaching this line means the row went away between the hand-in and
      // the grade. Scoring an absent sheet as zero would write that accident
      // onto a learner.
      throw new Error(
        `submission for ${task.taskKey} names a quiz with no handed-in paper on phase state ${state.id}`,
      );
    }

    // **As of the paper, and never as of now.** `attempt` and `attemptsLeft`
    // are facts about the sheet in hand, so they are counted over the papers
    // of that sheet's own attempt epoch handed in no later than it was. On the
    // live path this is the same number a running count would give, because
    // the paper in hand is the newest. On the regrade path it is not: a
    // regrade of revision one, two papers later, would otherwise read "attempt
    // 3", and because `attemptsLeft === 0` is one of the three doors
    // `releaseExplanations` opens on, it would release explanations that
    // revision withheld.
    const attempt = await this.quizAttempts.attemptNumberOf(paper);
    const attemptsLeft =
      checks.attempts.max === null ? null : Math.max(0, checks.attempts.max - attempt);
    const scored = scorePaper(checks, paper.paper, paper.answers);
    const overall = paperPercent(scored);
    const passed = quizPassed(overall, checks.passMark);

    const quiz: QuizReport = {
      correctCount: scored.correctCount,
      drawn: scored.drawn,
      passMark: checks.passMark,
      attempt,
      attemptsLeft,
      questions: inPaperTokens(
        paper.id,
        releaseExplanations(scored.questions, {
          passed,
          attemptsLeft,
          formative: !task.required && checks.attempts.max === null,
          reveal: revealRuleFor(task, checks),
        }),
      ),
    };

    // "right", and not "correct", and the word is chosen rather than found.
    // `QuizQuestion.correct` is the sealed key and `QuizQuestionResult` says
    // `outcome` for the same reason: the seal is asserted by **substring**
    // over a whole serialised payload, and a detail line carrying that word
    // would put it on the wire with the key nowhere near it.
    const detail = `${scored.correctCount} of ${scored.drawn} right — ${overall}%, against a pass mark of ${checks.passMark}%.`;
    const evidence = new Map(task.rubric.criteria.map((criterion) => [criterion.key, [detail]]));
    const scores = new Map(task.rubric.criteria.map((criterion) => [criterion.key, overall]));
    return {
      overall,
      criteria: assembleCriteria(task.rubric, scores, evidence),
      checks: [
        {
          id: 'quiz',
          label: 'Quiz',
          status: passed ? 'passed' : 'failed',
          detail,
        },
      ],
      quiz,
    };
  }

  private evidenceFromOutcomes(outcomes: RuleOutcome[]): Map<string, string[]> {
    const evidence = new Map<string, string[]>();
    for (const o of outcomes) {
      const list = evidence.get(o.criterion) || [];
      list.push(`${o.passed ? '✓' : '✗'} ${o.check.label}`);
      evidence.set(o.criterion, list);
    }
    return evidence;
  }

  /* --------------------------------- code -------------------------------- */

  private async buildCodeReport(
    phase: PhaseContent,
    checks: CodeChecks,
    state: PhaseStateEntity,
    hints: number,
    /**
     * The report's timing rows, appended to rather
     * than returned: what a phase builder returns is the verdict, field for
     * field, and the measurement is the caller's to keep.
     */
    timings?: ReportStepTiming[],
  ) {
    const files = this.content.executionFiles(phase, state.workspace);
    const language = phase.language;
    const runs = runsFor(phase, checks);
    // The runner stamps `step` on every case from `runId`, and a step on a
    // single-run result is a group label for a list with one group.
    const stamp = runs.length > 1;

    // One analyzer call, whatever languages the phase spans: `analyzer.py`
    // dispatches per target by extension, so a `.py` target is read by
    // Python's AST, a `.js` target by the JavaScript reader, and a `.ts`
    // target is skipped and counted as no file. Splitting the call per language would spawn a second
    // interpreter and need `issues`, `metrics`, `functions` and `imports`
    // merged: new arithmetic for the same answer.
    const analysis = await this.sandbox.analyze(files, checks.editableTargets, language);

    // Every visible run before every hidden one, in run order: the order a
    // single-run phase has always run in. Each is its own job, so a hidden
    // suite never shares a run with a visible one. With `GRADING_RUN_FANOUT`
    // unset they run one at a time, which is how one learner's Submit holds
    // one runner slot and a class of thirty stays fair; set to F, the same
    // jobs start in the same order with up to F in flight. Either way the
    // results are read back by position, never by which finished first, and
    // a refused run rethrows the first refusal in this order.
    const codeJobs = [
      ...runs.map((run) => this.codeJob(files, run, false, stamp)),
      ...runs.map((run) => this.codeJob(files, run, true, stamp)),
    ];
    const codeResults = await runOrdered(
      codeJobs.map((job) => () => this.runSandbox(job)),
      config.gradingRunFanout ?? 1,
    );
    const visibleResults: RunResult[] = codeResults.slice(0, runs.length);
    const hiddenResults: RunResult[] = codeResults.slice(runs.length);
    const visibleRun = mergedResult(visibleResults, runs);
    const hiddenRun = mergedResult(hiddenResults, runs);
    // The hidden suite runs from inside the workspace, so the runner returns
    // frames pointing straight at the case that caught the learner out. Both
    // runs are redacted against the same set (the files this phase shows the
    // learner) and the hidden one loses its messages to a single line as well.
    const visiblePaths = new Set(phase.files.map((f) => f.path));
    if (visibleRun.tests) {
      visibleRun.tests.cases = visibleRun.tests.cases.map((c: TestCaseResult) =>
        redactCase(c, visiblePaths, false),
      );
    }
    if (hiddenRun.tests) {
      hiddenRun.tests.cases = hiddenRun.tests.cases.map((c: TestCaseResult) => ({
        ...redactCase(c, visiblePaths, true),
        hidden: true,
      }));
    }

    const scores = new Map<string, number>();
    scores.set('correctness_hidden', scoreTests(hiddenRun));
    scores.set('visible_tests', scoreTests(visibleRun));
    scores.set('code_quality', scoreCodeQuality(analysis));
    scores.set('process', scoreProcess(state.ranBeforeSubmit, hints));

    const allChecks: FeedbackCheck[] = [
      {
        id: 'visible-tests',
        label: 'Visible test suite',
        status: visibleRun.ok ? 'passed' : 'failed',
        detail: this.testSummary(visibleRun),
      },
      {
        id: 'hidden-tests',
        label: 'Hidden test suite (edge cases)',
        status: hiddenRun.ok ? 'passed' : 'failed',
        detail: this.testSummary(hiddenRun),
      },
      // Across two layers "9 of 23 passed" tells a learner
      // nothing about which half to open, so each run's hidden suite gets its
      // own line beside the pooled one. Only when there is more than one run:
      // the pooled line is the whole story for a single-run pack, and
      // `hidden-tests` is the id `analytics/class-map.ts` probes and
      // `components/pr/ChecksCard.tsx` orders by, so it keeps its place.
      ...(stamp ? runs.map((run, at) => this.runCheck('hidden-tests', 'Hidden test suite', run, hiddenResults[at])) : []),
      {
        id: 'static-analysis',
        label: 'Static analysis',
        status: analysis.issues.some((i) => i.severity === 'error')
          ? 'failed'
          : analysis.issues.length
            ? 'warning'
            : 'passed',
        detail: analysis.issues.length
          ? `${analysis.issues.length} finding(s); worst: ${analysis.issues[0].message}`
          : 'No findings.',
      },
      {
        id: 'ran-before-submit',
        label: 'Ran the tests before submitting',
        status: state.ranBeforeSubmit ? 'passed' : 'warning',
        detail: state.ranBeforeSubmit
          ? 'Good practice — you used the fast feedback loop.'
          : 'You submitted without running the visible tests first.',
      },
    ];

    const evidence = new Map<string, string[]>([
      ['correctness_hidden', [this.testSummary(hiddenRun)]],
      ['visible_tests', [this.testSummary(visibleRun)]],
      [
        'code_quality',
        analysis.issues.slice(0, CODE_QUALITY_EVIDENCE_ISSUES).map((i) => `${i.severity}: ${i.message} (${i.path}:${i.line})`),
      ],
      ['process', [state.ranBeforeSubmit ? 'Ran tests before submitting.' : 'No run before submit.', ...mentorUseSentences(hints, await this.agenticUseFor(state))]],
    ]);

    // The change request's floor beside the four fixed keys, which keep their rules; `process` keeps its status.
    const change = changeFloorOf(checks, files, phase.rubric);
    if (change) {
      for (const [key, score] of change.scores) scores.set(key, score);
      for (const [key, lines] of change.evidence) evidence.set(key, lines);
      allChecks.push(...change.checks);
    }

    const criteria = assembleCriteria(phase.rubric, scores, evidence);
    // The durations arrive with each run and the pooled `tests` object below
    // has nowhere to keep them, so they are recorded here; otherwise the
    // sandbox share of a Submit would be an estimate. Recorded in the order the
    // loops above ran them, and read by nothing that scores.
    timings?.push(
      ...visibleResults.map((result, at) => stepTiming('visible', runs[at], stamp, result)),
      ...hiddenResults.map((result, at) => stepTiming('hidden', runs[at], stamp, result)),
    );
    const merged: RunResult['tests'] = {
      total: (visibleRun.tests?.total || 0) + (hiddenRun.tests?.total || 0),
      passed: (visibleRun.tests?.passed || 0) + (hiddenRun.tests?.passed || 0),
      failed: (visibleRun.tests?.failed || 0) + (hiddenRun.tests?.failed || 0),
      errored: (visibleRun.tests?.errored || 0) + (hiddenRun.tests?.errored || 0),
      cases: [...(visibleRun.tests?.cases || []), ...(hiddenRun.tests?.cases || [])],
    };
    return {
      overall: overallScore(criteria),
      criteria,
      checks: allChecks,
      staticAnalysis: analysis,
      tests: merged,
    };
  }

  /**
   * One graded run of a `code` phase.
   *
   * The visible job runs the tests the learner can see over their whole
   * workspace, both layers are mounted, because a front-end suite imports
   * components the API run also ships, and each run collects only its own
   * `visibleTests`. The hidden job adds that run's sealed suite and collects
   * `run.testPaths`, which is what the *graded* run collects.
   *
   * The two harnesses differ on purpose: the learner reads and writes pytest,
   * while the suite that decides the score stays on the harness whose seal has
   * been proved. `harness` is sent even when it is the language's own
   * default, so the pack decides it rather than the loader's default and the
   * runner's having to stay in step for ever, and `runId` only when the phase
   * has more than one run.
   */
  private codeJob(
    files: Record<string, string>,
    run: PhaseRun,
    hidden: boolean,
    stamp: boolean,
  ): SandboxTestJob {
    return {
      files: hidden ? { ...files, ...run.hiddenTestFiles } : files,
      mode: 'tests',
      testPaths: hidden ? run.testPaths : run.visibleTests,
      language: run.language,
      harness: hidden ? run.hiddenHarness : run.harness,
      ...(run.transform ? { transform: { tool: 'esbuild' as const, jsx: 'automatic' as const } } : {}),
      ...(stamp ? { runId: run.id } : {}),
    };
  }

  /**
   * One run's own line beside the pooled one. The id keeps
   * the pooled check's id as its stem so a reader can see they are the same
   * check split by layer, and the label is the pack's own words for the run.
   */
  private runCheck(id: string, label: string, run: PhaseRun, result: RunResult): FeedbackCheck {
    return {
      id: `${id}-${run.id}`,
      label: `${label}, ${run.label}`,
      status: result.ok ? 'passed' : 'failed',
      detail: this.testSummary(result),
    };
  }

  private testSummary(run: RunResult): string {
    if (!run.tests) {
      return run.exitKind === 'timeout'
        ? 'Execution timed out — check for infinite loops.'
        : `Tests could not run: ${(run.stderr || 'unknown error').slice(0, RUN_ERROR_EXCERPT_MAX)}`;
    }
    return `${run.tests.passed}/${run.tests.total} passed${run.tests.errored ? `, ${run.tests.errored} errored` : ''}.`;
  }

  /* -------------------------------- tests -------------------------------- */

  private async buildTestsReport(
    phase: PhaseContent,
    checks: TestsChecks,
    state: PhaseStateEntity,
    /** The report's timing rows, as in `buildCodeReport`. */
    timings?: ReportStepTiming[],
  ) {
    const learnerTests = this.execution.learnerTestFiles(phase, state.workspace, checks.learnerTestFiles);
    const runs = runsFor(phase, checks);
    const stamp = runs.length > 1;
    // Per run, because the two layers are two languages: a `def test_` counter
    // over a `.tsx` suite reads zero, and a `#` comment stripper over one
    // leaves the whole scaffold in. Both are pooled afterwards: `minTests` is
    // the pack's one number over the whole suite.
    const runSources = runs.map((run) =>
      stripCodeComments(
        Object.values(testFilesForRun(learnerTests, run, runs)).join('\n'),
        run.language,
      ),
    );
    const learnerSource = runSources.join('\n');
    const testCount = runs.reduce((n, run, at) => n + countTestMethods(runSources[at], run.language), 0);
    // One clock for the whole report. The reference runs and every
    // mutant run read this same value, so a kill matrix is a statement about
    // one day rather than about whenever each run happened to start.
    const clock = state.runClock ?? null;

    // The reference runs, in run order: one at a time with
    // `GRADING_RUN_FANOUT` unset, up to F at once when it is set. The mutants
    // fan out below, after the references, unless speculative mutants are on:
    // then their jobs join the same fan-out behind the references, and their
    // outcomes are held unread until the check below says the serial grader
    // would have run them at all. A learner with no tests never gets mutant
    // runs, so none are started for them.
    const fanout = config.gradingRunFanout;
    const speculative = fanout !== null && config.gradingSpeculativeMutants && testCount > 0;
    const scheduled = await settleOrdered(
      [
        ...runs.map((run) => () => this.runSandbox(this.mutationJob(run, learnerTests, runs, stamp), clock)),
        ...(speculative ? this.mutantRuns(checks, runs, learnerTests, clock, stamp) : []),
      ],
      fanout ?? 1,
    );
    // References before mutants: a refused reference is rethrown whatever a
    // speculative mutant did, as the serial grader never reached the mutants.
    const references = scheduled.slice(0, runs.length);
    const refusedReference = firstRejection(references);
    if (refusedReference) throw refusedReference.reason;
    const correctResults: RunResult[] = references.map((outcome) => (outcome as PromiseFulfilledResult<RunResult>).value);
    const correctRun = mergedResult(correctResults, runs);

    // As in `buildCodeReport`: the reference runs first, then the mutant
    // wave appends its own rows from inside `runMutants`, which is where those
    // results are settled.
    timings?.push(...correctResults.map((result, at) => stepTiming('reference', runs[at], stamp, result)));

    let mutation: MutationReport | null = null;
    if (correctRun.ok && testCount > 0) {
      mutation = await this.runMutants(
        checks,
        runs,
        learnerTests,
        clock,
        stamp,
        timings,
        speculative ? scheduled.slice(runs.length) : undefined,
      );
    } else {
      // Any speculative mutant outcomes are dropped here unread: the report
      // is the "Not evaluated" one the serial grader writes, with no mutant rows.
      mutation = {
        total: checks.mutants.length,
        killed: 0,
        survivors: checks.mutants.map((m) => ({ name: m.name, description: 'Not evaluated — your tests must first pass on the reference implementation.' })),
        matrix: checks.mutants.map((m) => this.mutantRow(m, false, undefined)),
      };
    }

    const coverageMatches = checks.coverageKeywords.map((group) => ({
      group,
      matched: group.keywords.some((k) => learnerSource.toLowerCase().includes(k.toLowerCase())),
    }));
    const coverageScore = Math.round(
      (coverageMatches.filter((m) => m.matched).length / Math.max(1, coverageMatches.length)) * 100,
    );

    const scores = new Map<string, number>();
    const enoughTests = testCount >= checks.minTests;
    scores.set('tests_pass', enoughTests ? scoreTests(correctRun) : Math.min(TOO_FEW_TESTS_CAP, scoreTests(correctRun)));
    scores.set('mutants_killed', scoreMutation(mutation));
    scores.set('coverage_mapping', enoughTests ? coverageScore : Math.min(TOO_FEW_TESTS_CAP, coverageScore));

    const allChecks: FeedbackCheck[] = [
      {
        id: 'tests-on-correct',
        label: 'Suite passes on the reference implementation',
        status: correctRun.ok ? 'passed' : 'failed',
        detail: this.testSummary(correctRun),
      },
      // One line per layer beside the pooled one, because a pooled count
      // across two languages does not say which half
      // to open. `tests-on-correct` keeps its id (`analytics/class-map.ts`
      // probes it) and these are added only when there is a second layer.
      ...(stamp
        ? runs.map((run, at) =>
            this.runCheck('tests-on-correct', 'Suite passes on the reference implementation', run, correctResults[at]),
          )
        : []),
      {
        id: 'enough-tests',
        label: `At least ${checks.minTests} tests written`,
        status: enoughTests ? 'passed' : 'failed',
        detail: `${testCount} test method(s) found.`,
      },
      {
        id: 'mutation',
        label: 'Seeded bugs caught (mutation testing)',
        status: mutation.killed === mutation.total ? 'passed' : mutation.killed > 0 ? 'warning' : 'failed',
        detail: `${mutation.killed}/${mutation.total} buggy variants caught${
          mutation.survivors.length
            ? `; survived: ${mutation.survivors.map((s) => s.description).join(' · ')}`
            : '.'
        }`,
      },
      ...coverageMatches.map((m) => ({
        id: `coverage-${m.group.criterion.replace(/\s+/g, '-').toLowerCase()}`,
        label: `Covers ${m.group.criterion}`,
        status: (m.matched ? 'passed' : 'failed') as FeedbackCheck['status'],
        detail: m.matched
          ? 'Behaviour referenced in your suite.'
          : `No test appears to exercise ${m.group.criterion}.`,
      })),
    ];

    const evidence = new Map<string, string[]>([
      // The review's line, in words; the enough-tests check's own detail keeps "test method(s)": the reviewer model is sent it.
      ['tests_pass', [this.testSummary(correctRun), `${testCount} ${testCount === 1 ? 'test method' : 'test methods'}.`]],
      ['mutants_killed', [`${mutation.killed}/${mutation.total} mutants killed.`]],
      ['coverage_mapping', coverageMatches.map((m) => `${m.matched ? '✓' : '✗'} ${m.group.criterion}`)],
    ]);

    const criteria = assembleCriteria(phase.rubric, scores, evidence);
    return {
      overall: overallScore(criteria),
      criteria,
      checks: allChecks,
      tests: correctRun.tests,
      mutation,
      // The day this whole report was graded at. Two submissions at
      // different clocks are not comparable, and the kill matrix says so; a
      // report with no clock ran on the machine's date.
      runClock: clock,
    };
  }

  /**
   * One run of the learner's suite against an implementation they must not read.
   *
   * `implFiles` is the reference solution and a mutant's files are the planted
   * bug. Both decide the score, and a suite that can open them knows which bug
   * to look for without writing a test that finds it, so they ride in
   * `gradedFiles`: the runner keeps those outside the workspace, imports them
   * and deletes them before the learner's tests load. Only the learner's own
   * test files are written where their code can reach.
   *
   * The reference run is sealed for the same reason the mutant runs are, not
   * for tidiness: seal only the mutants and a test that reads the file passes
   * on the reference and errors against all six, and an errored suite is a
   * kill, one line of file reading would score full marks for mutation.
   */
  private mutationJob(
    run: PhaseRun,
    learnerTests: Record<string, string>,
    runs: PhaseRun[],
    stamp: boolean,
    mutant: Record<string, string> = {},
  ): SandboxTestJob {
    return {
      // The locked helpers the suite imports go in the workspace, not in
      // `gradedFiles`: the harness deletes the graded files before a line of
      // learner code loads, and a module the suite imports has to still be
      // there when it does.
      files: { ...run.supportFiles, ...testFilesForRun(learnerTests, run, runs) },
      gradedFiles: { ...run.implFiles, ...mutant },
      mode: 'tests',
      testPaths: run.testPaths,
      language: run.language,
      // The learner's own suite runs here, so it is the learner's harness
      // (pytest for the API layer) and never `hiddenHarness`. Nothing sends a
      // test file in `gradedFiles`, which is what the runner refuses under
      // pytest: the implementation is the graded artefact.
      harness: run.harness,
      ...(run.transform ? { transform: { tool: 'esbuild' as const, jsx: 'automatic' as const } } : {}),
      ...(stamp ? { runId: run.id } : {}),
    };
  }

  /**
   * The run a mutant belongs to: its `meta.json.run` decides which
   * implementation it overlays and which of the learner's suites is run
   * against it, so the kill matrix is one grid over both layers. A phase with
   * one run has one answer; a mutant naming a run the phase does not declare
   * cannot be loaded, so the fallback is only ever a hand-built fixture.
   */
  private runForMutant(mutant: MutantSpec, runs: PhaseRun[]): PhaseRun {
    return runs.find((run) => run.id === mutant.run) ?? runs[0];
  }

  /**
   * The planted mutants, run together.
   *
   * They are independent: the same suite against one swapped implementation
   * each time, so waiting for each in turn made one testing submission seven
   * serial sandbox calls. More workers did not help, because those seven sit
   * inside one submission: a class of thirty measured 29.1 s of wall clock at
   * the default and still 20.8 s at eight. The gate inside `SandboxService`
   * bounds how many runs exist at once (`RUNNER_SLOTS`), so this asks the
   * runner for no more capacity than the loop did; it turns the critical path
   * of a single submission from seven runs into two.
   *
   * Settled, not `all`: a rejection from one run must not leave the others
   * unhandled, and rethrowing the first failure in mutant order keeps an
   * unreachable runner reading exactly as it did when the runs were serial.
   * With `GRADING_RUN_FANOUT` unset every mutant run starts at once, as it
   * always has; set to F, at most F are in flight. With speculative mutants
   * the runs were started beside the references, and `presettled` hands their
   * outcomes over, in pack order, to be read here for the first time.
   */
  private async runMutants(
    checks: TestsChecks,
    runs: PhaseRun[],
    learnerTests: Record<string, string>,
    clock: string | null,
    stamp: boolean,
    /**
     * The report's timing rows, appended to in the loop below rather than
     * returned: the caller keeps the order of the whole report, and the
     * mutation report itself stays exactly the object it was.
     */
    timings?: ReportStepTiming[],
    presettled?: OrderedOutcome<RunResult>[],
  ): Promise<MutationReport> {
    const settled =
      presettled ??
      (await settleOrdered(
        this.mutantRuns(checks, runs, learnerTests, clock, stamp),
        config.gradingRunFanout ?? Infinity,
      ));
    const failed = firstRejection(settled);
    if (failed) throw failed.reason;

    const survivors: { name: string; description: string }[] = [];
    const matrix: MutantRow[] = [];
    let killed = 0;
    // By index, so the matrix keeps the pack's order however the runs finished.
    checks.mutants.forEach((mutant, at) => {
      const run = (settled[at] as PromiseFulfilledResult<RunResult>).value;
      // A mutant dies when the suite reports a failure or an error against
      // it. A harness that crashed without a result line is not a kill: it
      // says nothing about the tests. Neither is a run that ended
      // `exitKind: "error"`, that is the harness itself failing, and a
      // TypeScript file that will not compile comes back that way
      // *with* one errored case per esbuild diagnostic, which would otherwise
      // read as a kill nobody's test earned. A mutant the author broke is an
      // author's problem, not a learner's score.
      const died =
        !!run.tests && run.exitKind !== 'error' && (run.tests.failed > 0 || run.tests.errored > 0);
      if (died) killed += 1;
      else survivors.push({ name: mutant.name, description: mutant.description });
      matrix.push(this.mutantRow(mutant, died, run.tests?.cases));
      // One row per planted mutant, in the pack's order (the order the matrix
      // is in) so a reader can line the two up without a name being written
      // down twice. These ran together, not one after the other.
      timings?.push(stepTiming('mutant', this.runForMutant(mutant, runs), stamp, run));
    });
    return { total: checks.mutants.length, killed, survivors, matrix };
  }

  /** One deferred run per planted mutant, in the pack's order. Nothing starts until the fan-out calls it. */
  private mutantRuns(
    checks: TestsChecks,
    runs: PhaseRun[],
    learnerTests: Record<string, string>,
    clock: string | null,
    stamp: boolean,
  ): (() => Promise<RunResult>)[] {
    return checks.mutants.map((mutant) => () =>
      this.runSandbox(
        this.mutationJob(this.runForMutant(mutant, runs), learnerTests, runs, stamp, mutant.files),
        clock,
      ),
    );
  }

  /**
   * One row of the kill matrix: which of the learner's tests failed against
   * this mutant. Messages are dropped: the matrix is a grid, and the report
   * column has to hold six mutants times the whole suite.
   */
  private mutantRow(
    mutant: MutantSpec,
    killed: boolean,
    cases: TestCaseResult[] | undefined,
  ): MutantRow {
    return {
      mutant: mutant.name,
      description: mutant.description,
      killed,
      ...(mutant.covers ? { covers: mutant.covers } : {}),
      cases: (cases ?? [])
        .slice(0, MATRIX_CASE_CAP)
        .map((c) => ({ name: c.name, status: c.status })),
    };
  }

  /* -------------------------------- config -------------------------------- */

  private async buildConfigReport(
    phase: PhaseContent,
    checks: ConfigChecks,
    state: PhaseStateEntity,
    /** The report's timing rows, as in `buildCodeReport`. */
    timings?: ReportStepTiming[],
  ): Promise<{ report: PartialReport; smoke: SmokeCheckResult }> {
    const files = this.content.executionFiles(phase, state.workspace);
    // No file rule targets markdown: the runbook is a record of its own. A
    // rule stored before file rules named their file has no target, and reads nothing.
    const outcomes = evaluateRules(checks.rules, (target) => files[target ?? ''] || '');

    const smokeRun = await this.runSmokeCheck(phase, files);
    // Only when a job really ran: an unfinished Dockerfile is refused before
    // the sandbox is touched, and a row of zero would read as a machine that
    // started instantly. The smoke result keeps its own shape, which carries
    // no exit kind, so this row is the duration alone.
    if (smokeRun.argv.length) timings?.push({ step: 'smoke', durationMs: smokeRun.durationMs });

    const scores = scoreFromRules(phase.rubric, outcomes);
    scores.set('build_smoke', smokeRun.ok ? 100 : 0);

    const started = smokeRun.argv.length ? `Isolated process invoked from Dockerfile command \`${smokeRun.argv.join(' ')}\`` : '';
    const scope = 'This checks source syntax and the isolated selfcheck only; it does not build Docker images, start Compose services, execute CI workflow steps, or prove HTTP network health.';
    const allChecks: FeedbackCheck[] = [
      ...outcomes.map((o) => o.check),
      { id: 'execution-scope', label: 'Execution evidence scope', status: 'info', detail: scope },
      {
        id: 'build-smoke',
        label: 'Isolated syntax and entrypoint selfcheck',
        status: smokeRun.ok ? 'passed' : 'failed',
        detail: smokeRun.ok
          ? `${started}; the selfcheck completed in ${smokeRun.durationMs}ms. ${scope}`
          : `Selfcheck failed${started ? ` (${started.toLowerCase()})` : ''}: ${(smokeRun.stderr || smokeRun.stdout || 'no output').slice(0, RUN_ERROR_EXCERPT_MAX)}. ${scope}`,
      },
    ];

    const evidence = this.evidenceFromOutcomes(outcomes);
    // The review's own line: "Dockerfile" stays a name and the command is quoted, not in Markdown
    // backticks the review shows raw. The check's detail above keeps its bytes: the reviewer model is sent it.
    const ran = smokeRun.argv.length ? `, isolated process invoked from the Dockerfile command "${smokeRun.argv.join(' ')}"` : '';
    evidence.set('build_smoke', [
      smokeRun.ok
        ? `Source syntax and isolated selfcheck passed${ran}. ${scope}`
        : `Smoke run failed: ${(smokeRun.stderr || 'no output').slice(0, SMOKE_EVIDENCE_EXCERPT_MAX)}`,
    ]);

    // The runbook's floor: its criteria scored by the share of floor rules that pass, every rule a required check.
    const runbook = runbookFloorOf(checks, files, phase.rubric);
    if (runbook) {
      for (const [key, score] of runbook.scores) scores.set(key, score);
      for (const [key, lines] of runbook.evidence) evidence.set(key, lines);
      allChecks.splice(outcomes.length, 0, ...runbook.checks);
    }

    const criteria = assembleCriteria(phase.rubric, scores, evidence);
    return {
      report: { overall: overallScore(criteria), criteria, checks: allChecks },
      smoke: smokeRun,
    };
  }

  /**
   * The deployment smoke run: the CLI is started the way the learner's
   * container would start it, so the argv comes from their own ENTRYPOINT/CMD
   * and an unfinished Dockerfile cannot earn the build points on the strength
   * of the authored command. Public because the drill runs the same check
   * against the faulted copy and against the learner's fix.
   */
  async runSmokeCheck(phase: PhaseContent, files: Record<string, string>): Promise<SmokeCheckResult> {
    if (phase.checks.kind !== 'config') {
      return {
        ok: false,
        stdout: '',
        stderr: '',
        durationMs: 0,
        argv: [],
        problem: `The ${phase.key} phase has no smoke check.`,
      };
    }
    const checks = phase.checks;
    // The map that is validated is the map that runs, so a learner who names a
    // script this phase does not ship is told that, rather than being handed a
    // runtime traceback from the sandbox. (Hence `dockerEntrypoint`'s second parameter.)
    const smokeFiles = { ...checks.smokeImplFiles, ...files };
    // Which Dockerfile starts the service, `"Dockerfile"` unless the
    // pack says otherwise. A two-service application has
    // two, and `api/Dockerfile` is the one whose ENTRYPOINT the smoke run
    // starts; the `|| 'Dockerfile'` is for a `checks` object built by hand,
    // since the loader always fills the field.
    const entry = dockerEntrypoint(files[checks.smokeDockerfile || 'Dockerfile'] || '', smokeFiles);
    if (!entry.argv.length) {
      return {
        ok: false,
        stdout: '',
        stderr: entry.problem || '',
        durationMs: 0,
        argv: [],
        problem: entry.problem,
      };
    }
    const run: RunResult = await this.runSandbox({
      files: smokeFiles,
      mode: 'smoke',
      smokeCommands: smokeArgvFor(entry.argv, checks.smokeCommands),
      expectInOutput: checks.expectInOutput,
      language: phase.language,
    });
    return {
      ok: run.ok,
      stdout: run.stdout,
      stderr: run.stderr,
      durationMs: run.durationMs,
      argv: entry.argv,
    };
  }
}
