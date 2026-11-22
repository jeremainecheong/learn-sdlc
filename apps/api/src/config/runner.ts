import * as os from 'os';
import { positiveInt } from './parse';

/**
 * Transport for learner-code execution. There is no implicit local: 'local'
 * runs the learner's code as a child of this process, with this uid, this
 * network and /proc access to this environment, so it has to be asked for by
 * name. Everything else (an unset variable, a typo, a value from a shell
 * that meant something else) resolves to the socket runner, which fails
 * closed (every run errors) rather than opening a shell on the host.
 */
export function resolveRunnerMode(env = process.env): 'local' | 'socket' | 'lambda' {
  const mode = (env.RUNNER_MODE || '').trim();
  if (mode === 'local' || mode === 'socket' || mode === 'lambda') return mode;
  return 'socket';
}

/** Invalid remote transport settings fail at boot rather than causing hanging jobs. */
export function resolveRunnerTransportAllowance(env = process.env): number {
  const raw = env.RUNNER_TRANSPORT_ALLOWANCE_SECONDS ?? '0';
  if (!/^(0|[1-9]\d*)$/.test(raw) || Number(raw) > 120) {
    throw new Error('RUNNER_TRANSPORT_ALLOWANCE_SECONDS must be an integer from 0 to 120');
  }
  return Number(raw);
}

/**
 * How many things this host can genuinely do at once. `availableParallelism`
 * respects a cgroup CPU quota where `cpus().length` reports the whole machine,
 * which matters when the API runs in a container; it is guarded because the
 * runbook still supports a Node that predates it.
 */
export function hostParallelism(): number {
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 0;
  return Math.max(1, available || os.cpus().length || 1);
}

/**
 * Grading and run jobs one API process works on at once.
 *
 * A fixed number would be a machine-independent answer to a machine-dependent
 * question: thirty submissions arriving together on an eight-core laptop queue
 * behind two workers while six cores sit idle (p50 8.6 s at two workers
 * against 5.0 s at eight). Leaving one core for the API
 * itself, the database and the browser is what keeps the console responsive
 * while the class is being graded, so the default is one below the host's
 * parallelism, with a floor of two so a single-core CI box still overlaps two
 * jobs. JOB_CONCURRENCY still overrides.
 */
export function resolveJobConcurrency(env = process.env): number {
  return positiveInt(env.JOB_CONCURRENCY) ?? Math.max(2, hostParallelism() - 1);
}

/**
 * Sandbox children that may exist at once: the cap the runner container is
 * actually provisioned for (`mem_limit` = this × RUN_MEMORY_MB).
 *
 * This is a separate setting from JOB_CONCURRENCY because the two answer
 * different questions. One grading job makes several sandbox runs, one after another, and the
 * deployment phase's incident drill runs the sandbox straight off the request
 * path without a job at all. Sizing the runner to the worker count therefore
 * left a learner pressing "Run health check" waiting behind the whole class's
 * grading. The headroom is small and deliberate: two slots above the worker
 * count, so a couple of request-path runs get through a busy queue without
 * multiplying the runner container's memory.
 */
export function resolveRunnerSlots(env = process.env): number {
  return positiveInt(env.RUNNER_SLOTS) ?? resolveJobConcurrency(env) + 2;
}

/**
 * The bound on waiting for a sandbox slot. The gate was a FIFO with no
 * deadline and no ceiling, so forty learners pressing the drill's health check
 * in one minute meant the last of them held an open request for about eleven
 * minutes. A caller that has waited this long is told the runner is busy
 * (a 503 at the route, an `unavailable` outcome through SandboxService) rather
 * than being left holding a socket; the ceiling is the second half, so a burst
 * that outruns the deadline is refused at the door instead of accumulating.
 *
 * The default is generous against measured load (thirty submissions on eight
 * cores finished the slowest grading run in 20.8 s) and short enough that no
 * learner watches a spinner for a coffee break.
 */
export function resolveRunnerWait(env = process.env): { maxWaitMs: number; maxWaiting: number } {
  return {
    maxWaitMs: positiveInt(env.RUNNER_MAX_WAIT_MS) ?? 120_000,
    maxWaiting: positiveInt(env.RUNNER_MAX_WAITING) ?? 200,
  };
}
