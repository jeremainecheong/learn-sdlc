import * as fs from 'fs';
import * as path from 'path';

/**
 * A file that exists only at the repository root, so the root can be found
 * from wherever the API runs: the sources under ts-node or the compiled
 * output in an image.
 */
export const REPO_ROOT_MARKER = 'content/tasktrackr/project.json';

/** The nearest directory at or above startDir that holds probe, looking at most maxLevels up. */
export function findUp(startDir: string, probe: string, maxLevels = 6): string | null {
  let dir = startDir;
  for (let i = 0; i < maxLevels; i++) {
    if (fs.existsSync(path.join(dir, probe))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The repository root, or null when the API runs without the repository
 * around it. The search starts in the directory that holds the API's
 * sources (or their compiled output), one level above this file.
 */
export const repoRoot = findUp(path.resolve(__dirname, '..'), REPO_ROOT_MARKER);
