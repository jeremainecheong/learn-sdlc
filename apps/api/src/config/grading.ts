import { positiveInt } from './parse';
import { resolveRunnerSlots } from './runner';

/**
 * Queued-or-running submissions one learner may hold **across every phase and
 * every task**.
 *
 * `UQ_submissions_in_flight` is the *exactness* guarantee (it stops one set
 * of bytes being graded twice), and narrowing it to `(phaseStateId, taskKey)`
 * is precisely what lets a learner hold one submission per task of every open
 * phase. This number is the separate *fairness* bound, and it is a different
 * requirement with a different mechanism: it is a bare count taken in
 * `FeedbackService.submit` with no lock and no constraint behind it, so it is
 * **advisory** and two submits that arrive together may both read the same
 * count and both insert. An approximate answer is the right kind of answer
 * here: a race that briefly admits a third costs the class one queue slot for
 * one job, and `RunGate(runnerSlots)` bounds real concurrency whatever
 * arrives.
 *
 * Two is a learner working two pieces of work while the class waits on
 * neither; within the cap `BullQueue` is FIFO with no per-owner rotation, so
 * the residual is a queue two jobs deep.
 */
export function resolveSubmitInFlightPerLearner(env = process.env): number {
  return positiveInt(env.SUBMIT_IN_FLIGHT_PER_LEARNER) ?? 2;
}

/* ------------------------------ the grading fan-out ------------------------------ */

/**
 * `GRADING_RUN_FANOUT`: the most sandbox runs one submission's review may
 * hold at once.
 *
 * Unset, which is the default, a review runs its jobs one at a time: the
 * Implementation and Maintenance suite runs one after another (every visible
 * run, then every hidden one), the Testing reference runs one after another,
 * and then all the mutant runs together. Set to F, those same jobs start in
 * that same order with up to F in flight, so the wait shrinks and the jobs,
 * the report and any failure stay what they were (`feedback/run-fanout.ts`).
 *
 * F is a positive whole number no larger than `RUNNER_SLOTS`: a submission
 * holding more runs than the API's gate has slots would only queue behind
 * itself. The other half of the invariant, `RUNNER_SLOTS` no larger than the
 * runner host's own job limit, is the deployment's to keep. Grading is
 * still one job per submission and `JOB_CONCURRENCY` still bounds the jobs;
 * this changes the run shape inside one submission only.
 */
export function resolveGradingRunFanout(env = process.env): number | null {
  const raw = env.GRADING_RUN_FANOUT;
  if (raw === undefined) return null;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('GRADING_RUN_FANOUT must be a positive whole number no larger than RUNNER_SLOTS');
  const fanout = Number(raw);
  const slots = resolveRunnerSlots(env);
  if (fanout > slots) throw new Error(`GRADING_RUN_FANOUT (${fanout}) must not exceed RUNNER_SLOTS (${slots})`);
  return fanout;
}

/**
 * `GRADING_SPECULATIVE_MUTANTS`: `on` starts a Testing review's mutant runs
 * beside its reference runs, in one fan-out, instead of after them.
 *
 * The verdict cannot tell: the mutant results are read only when every
 * reference run passed and the learner wrote at least one test, which is when
 * the serial grader runs them at all. Otherwise they are discarded unread and
 * the report is the same "Not evaluated" one, with no mutant timing rows. The
 * cost is the discarded runs' machines. It needs `GRADING_RUN_FANOUT`, because
 * without one the reference runs are serial and starting the mutants among
 * them would be slower, not faster. `off` and unset are the default.
 */
export function resolveGradingSpeculativeMutants(env = process.env): boolean {
  const raw = env.GRADING_SPECULATIVE_MUTANTS;
  if (raw === undefined || raw === 'off') return false;
  if (raw !== 'on') throw new Error('GRADING_SPECULATIVE_MUTANTS must be on or off');
  if (env.GRADING_RUN_FANOUT === undefined) throw new Error('GRADING_SPECULATIVE_MUTANTS=on needs GRADING_RUN_FANOUT');
  return true;
}

/** Refuses the API's boot on a bad grading fan-out setting. Called by `main.ts` before anything binds. */
export function assertGradingFanout(env = process.env): void {
  resolveGradingRunFanout(env);
  resolveGradingSpeculativeMutants(env);
}

/**
 * The values `config` loads with, which never throw: an acceptance script or
 * a digest check may `require` this module, so a bad value must refuse the
 * API's boot, not the module's load. Any bad value loads both settings as
 * if unset, and `assertGradingFanout` refuses it at boot.
 */
export function gradingFanoutAtLoad(env = process.env): { runFanout: number | null; speculativeMutants: boolean } {
  try {
    return { runFanout: resolveGradingRunFanout(env), speculativeMutants: resolveGradingSpeculativeMutants(env) };
  } catch {
    return { runFanout: null, speculativeMutants: false };
  }
}
