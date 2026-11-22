/**
 * Where the tests find files on disk.
 *
 * Every folder is worked out from this file's own place, never from the
 * working directory, so a run started from the repository root, from
 * `apps/web` or from an editor reads the same files.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The web app's folder, `apps/web`. */
export const WEB_ROOT = resolve(__dirname, '../..');

/** The repository's root folder, which holds `apps/`, `content/` and `packages/`. */
export const REPO_ROOT = resolve(WEB_ROOT, '../..');

/** A path under the repository root, given from there (for example `content/tasktrackr`). */
export function repoPath(rel: string): string {
  return join(REPO_ROOT, rel);
}

/** The text of a file under the repository root, given by its path from there. */
export function repoFile(rel: string): string {
  return readFileSync(repoPath(rel), 'utf8');
}

/** A path under `apps/web`, given from there (for example `public/lessons`). */
export function webPath(rel: string): string {
  return join(WEB_ROOT, rel);
}
