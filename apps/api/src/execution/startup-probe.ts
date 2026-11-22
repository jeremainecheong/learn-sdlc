import { randomUUID } from 'crypto';
import { resolveStartupOwnerId } from '../config/execution';

/** Platform identity is supplied only by the API operator, never a job body. */
export const STARTUP_PROBE_STEP_ID = 'platform-prebake-v1';

/**
 * The trace step every deep-validation job is sent with, followed by the
 * check and an index. The sandbox's metrics label such a run `validation`. A pack run id is
 * `^[a-z][a-z0-9-]{0,15}$` and a learner's smoke step is `smoke`, so nothing a
 * learner presses can carry a colon: the prefix is unambiguous, and it fits the
 * controller's `[A-Za-z0-9_.:-]{1,80}`.
 */
export const DEEP_VALIDATION_STEP_PREFIX = 'deep-validation:';

export function startupProbeOwner(raw = resolveStartupOwnerId()): {
  kind: 'run'; ownerId: string; stepId: typeof STARTUP_PROBE_STEP_ID;
} {
  if (raw !== undefined && (raw.length !== 36 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(raw))) {
    throw new Error('Invalid platform startup owner');
  }
  return { kind: 'run', ownerId: raw ?? randomUUID(), stepId: STARTUP_PROBE_STEP_ID };
}
