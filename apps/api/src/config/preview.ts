import * as path from 'path';
import { DEFAULT_DB_PATH } from './database';
import { positiveInt } from './parse';
import { resolveRunnerMode } from './runner';

/** Memory one preview session's app may use when PREVIEW_MEMORY_MB names none, in MB. */
export const DEFAULT_PREVIEW_MEMORY_MB = 512;

/**
 * Whether this deployment can run a learner's own application at all.
 *
 * Off on the Lambda transport whatever anyone sets: a Lambda invoke returns
 * and the process goes away, so there is nowhere for an app to keep running,
 * and pretending otherwise would give a learner a Start button that can only
 * ever fail. Everywhere else it is on unless PREVIEW_ENABLED says otherwise,
 * which is the switch an operator throws when a machine is too small.
 */
export function resolvePreviewEnabled(env = process.env): boolean {
  if (resolveRunnerMode(env) === 'lambda') return false;
  if (env.PREVIEW_ENABLED === 'false') return false;
  return true;
}

/**
 * Live preview sessions this API process will hold at once.
 *
 * Two where the runner has a container of its own, one where it does not:
 * RUNNER_MODE=local puts the learner's app on the same machine as the API, the
 * database, the browser and the editor, so one is all that machine can spare. It
 * is the API's half of a bound the runner also enforces (PREVIEW_SESSIONS in
 * runner/app_session.py), because the API's gate is per API process and the
 * runner's is per runner (the same reason `docker-compose.yml` pins
 * RUNNER_SLOTS on both services).
 */
export function resolvePreviewSessions(env = process.env): number {
  return positiveInt(env.PREVIEW_SESSIONS) ?? (resolveRunnerMode(env) === 'local' ? 1 : 2);
}

/**
 * The socket the preview lives behind.
 *
 * In RUNNER_MODE=socket it is the runner's own socket, the one every job
 * already goes to. In local mode there is nothing listening: the local
 * transport spawns a fresh sandbox_runner.py per run and a preview has to
 * outlive a run, so SandboxService starts one serve.py of its own on this
 * path. Beside the database rather than in /run, because that directory is the
 * one a laptop deployment already owns and creates.
 */
export function resolvePreviewSocket(env = process.env): string {
  const named = (env.PREVIEW_SOCKET || '').trim();
  if (named) return named;
  const dataDir = path.dirname(env.DB_PATH || DEFAULT_DB_PATH);
  return path.join(dataDir, 'preview.sock');
}
