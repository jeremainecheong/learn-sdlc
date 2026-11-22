import { positiveInt } from './parse';
import { DEFAULT_PREVIEW_MEMORY_MB, resolvePreviewEnabled, resolvePreviewSessions } from './preview';
import { resolveRunnerSlots } from './runner';

/** Memory one sandbox run may use when RUN_MEMORY_MB names none, in MB. */
export const DEFAULT_RUN_MEMORY_MB = 256;

/**
 * The memory the runner container is provisioned for, and the arithmetic that
 * has to fit inside it, in one executable place.
 *
 * Three files encode this figure (the compose `mem_limit`, the comment above
 * it and the runbook) and a container over its limit is killed and takes
 * every in-flight learner's run with it. `config.spec.ts` runs the container
 * profile through the function below and refuses a change that does not fit,
 * so the next person to raise a slot count finds out here rather than in a
 * class.
 */
export const RUNNER_CONTAINER_MB = 3072;

/** The runner's own server, its Node heap and the esbuild service, in MB. */
export const RUNNER_SERVER_MB = 512;

/** What the runner container needs for a given profile, in MB. See RUNNER_CONTAINER_MB. */
export function runnerContainerBudgetMb(env = process.env): number {
  const runs = resolveRunnerSlots(env) * (positiveInt(env.RUN_MEMORY_MB) ?? DEFAULT_RUN_MEMORY_MB);
  const previews = resolvePreviewEnabled(env)
    ? resolvePreviewSessions(env) * (positiveInt(env.PREVIEW_MEMORY_MB) ?? DEFAULT_PREVIEW_MEMORY_MB)
    : 0;
  return runs + previews + RUNNER_SERVER_MB;
}
