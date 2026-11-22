import * as path from 'path';

/** The repository root: the directory the config, its servers and its commands run from. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * The suite's own API data, relative to the repository root. The config's API
 * command clears it before the server starts, so every run begins empty, and
 * git ignores it.
 */
export const E2E_DATA_DIR = 'apps/api/.e2e-data';

/** The suite API's SQLite file, as an absolute path for specs that read it. */
export const E2E_SQLITE = path.join(REPO_ROOT, E2E_DATA_DIR, 'e2e.sqlite');
