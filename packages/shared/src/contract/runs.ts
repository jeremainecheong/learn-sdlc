/**
 * Runs: a job's status, test results, a run's result and exit kind, the
 * socket events that announce a finished job, the run languages and harnesses,
 * and one run of a merged multi-run result.
 */

/* ---------------------------------- runs --------------------------------- */

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TestCaseResult {
  name: string;
  status: 'passed' | 'failed' | 'errored';
  message?: string;
  hidden?: boolean;
  /**
   * Where the failure happened in the learner's own files, deepest frame
   * first, paths workspace-relative. Absent for passes and for harness errors
   * outside the workspace. At most 5 frames.
   */
  frames?: TestFrame[];
  durationMs?: number;
  // The `runs[].id` this case came from, on a merged multi-run result. Absent
  // on a single-run result, so a consumer that knows nothing of runs reads a
  // single-run result unchanged.
  step?: string;
}

export interface TestFrame {
  path: string;
  line: number;
  /** The source line at that position, trimmed, at most 160 chars. */
  snippet?: string;
}

/**
 * How a sandbox run ended.
 *
 * The first four are verdicts about the learner's code: it ran and the runner
 * observed the outcome. `unavailable` is not a verdict: the code never ran,
 * because the runner could not be reached, answered something that is not a
 * result, or the request died in transport. Nothing may score an
 * `unavailable` run, gate a phase on it, or count an attempt against it. Its
 * `stdout` is always empty. Its `stderr` is empty when the transport failed
 * (the transport's own message names internal paths and hosts and belongs in
 * the server log), and is the runner's own sentence when the runner itself
 * answered that it cannot run this kind of job on this transport: that
 * sentence is shown to the learner verbatim (see `runnerSentence` in
 * apps/api/src/execution/execution.service.ts).
 */
export type RunExitKind = 'ok' | 'timeout' | 'memory' | 'error' | 'unavailable';

export interface RunResult {
  ok: boolean;
  exitKind: RunExitKind;
  stdout: string;
  stderr: string;
  durationMs: number;
  tests?: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
    cases: TestCaseResult[];
  };
  // One row per run when a phase was graded over several runs, in `runs[]`
  // order. Absent on a single-run result, so `RunPanel` draws a single run
  // with no step rows.
  steps?: RunStep[];
}

/** True when the sandbox never ran the code: a transport failure, not a verdict. */
export function isRunnerUnavailable(result: Pick<RunResult, 'exitKind'>): boolean {
  return result.exitKind === 'unavailable';
}

/**
 * What a learner is told when a run or a submission could not reach the code
 * runner. Sentence case, no internal detail, and it says the work is safe,
 * because the one thing a learner fears here is having lost it.
 */
export const RUNNER_UNAVAILABLE_MESSAGE =
  'The code runner could not be reached, so this did not run. Your work is saved. Try again in a moment.';

/**
 * The code on the body of a 503 the AI's queue answered: the class was using
 * every AI slot, so the request did not run. A client reads the code, never
 * the words, to say the mentor is busy rather than that the server failed.
 */
export const AI_BUSY_CODE = 'AI_BUSY';

/**
 * What a learner is told when a review waited for one of the AI's slots and
 * the line was too long to finish: the cause is the rest of the class, not the
 * provider and not their work. The API writes it as the review's
 * `assessmentError`, and the review panel reads that exact sentence to say
 * "busy" instead of "provider unavailable". No Pass is awarded either way.
 */
export const AI_REVIEW_BUSY_MESSAGE =
  'The AI reviewer is busy with the rest of the class, so this review did not run. No Pass was awarded and your work is saved. Resubmit in a minute.';

export interface ExecutionRunView {
  /** Authoritative owning phase for durable history links; a client must render without it. */
  phaseStateId?: string;
  /** Null on legacy records whose exact inputs were not retained. */
  inputHash?: string | null;
  /** The captured run clock; null uses the sandbox clock. */
  runClock?: string | null;
  /** Pre-execution/recovery failure; never fabricated test evidence. */
  error?: string;
  id: string;
  status: JobStatus;
  kind: 'run' | 'submit';
  result: RunResult | null;
  createdAt: string;
}

/* --------------------------------- events -------------------------------- */

export interface JobEvent {
  type: 'run' | 'submission';
  id: string;
  phaseStateId: string;
  status: JobStatus;
}

export const SOCKET_EVENTS = {
  job: 'job.update',
  // One notification, pushed to the account
  // it is for the moment it is written.
  notification: 'notification.new',
} as const;

/* ------------------------- run languages and harnesses -------------------- */

/**
 * A language the runner can execute.
 *
 * `python` and `javascript` are what the runner executes directly; `typescript`
 * is transformed to CommonJS by esbuild in the parent before the child starts,
 * so the child still only ever runs JavaScript.
 */
export type RunLanguage = 'python' | 'javascript' | 'typescript';

/**
 * A harness the runner can drive.
 *
 * `pytest` is what the learner reads and writes on a Python phase; the sealed
 * hidden suites stay on `unittest`, whose import-then-unlink seal is the one
 * that has been proved. `js` is the sandbox's own DOM harness.
 */
export type RunHarness = 'unittest' | 'pytest' | 'js';

/* ------------------------------ multi-run results ------------------------- */

/**
 * One run inside a merged multi-run result.
 *
 * A phase that spans two layers is graded as two runs, the Python API suite
 * and the front end's DOM suite, and the API merges them into one
 * `RunResult`. The pooled totals are what the score is taken from; these rows
 * are what a learner reads to see which half is red, because "9 of 23 passed"
 * across two languages says nothing about which file to open.
 *
 * `id` and `label` are the pack's own (`checks.runs[].id`, `.label`), so the
 * words above a group in the Tests pane are the words the author wrote.
 */
export interface RunStep {
  /** `checks.runs[].id`: 'api' | 'web'. Matches `TestCaseResult.step`. */
  id: string;
  /** `checks.runs[].label`: the words a learner reads above the group. */
  label: string;
  ok: boolean;
  exitKind: RunExitKind;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  errored: number;
}
