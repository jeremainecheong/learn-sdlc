import * as path from 'path';

/**
 * The Shelf pack (`shelf`): where it is, what it is called, and the marker
 * strings planted in its sealed roles (read by the upload, sealing,
 * validation and learner-walk specs).
 *
 * Every file of a sealed role carries its role's marker, and no file a
 * learner is served carries any of them, so a test can prove a sealed byte
 * never left the seal by grepping a response, a request body or a log for
 * these six strings:
 *
 * - `hidden`    the implementation and maintenance phases' sealed suites;
 * - `solution`  the implementation and maintenance phases' reference answers;
 * - `reference` the testing phase's own acceptance suites;
 * - `impl`      the implementation the testing phase grades against;
 * - `mutant`    the planted bugs of the testing phase;
 * - `drill`     the deployment drill's faulted copy.
 *
 * The markers are deliberately not secret-shaped (no long hex, no key
 * prefixes), so a sealing test that prints one is harmless.
 */

/** The Shelf pack directory, in the `docs/authoring-format.md` layout. */
export const SHELF_DIR = path.join(__dirname, 'shelf');
export const SHELF_SLUG = 'shelf';
export const SHELF_VERSION = '1.0.0';

export const SHELF_MARKERS = {
  hidden: 'SHELF-SEALED-HIDDEN-5F3K',
  solution: 'SHELF-SEALED-SOLUTION-8M2Q',
  reference: 'SHELF-SEALED-REFERENCE-4T7W',
  impl: 'SHELF-SEALED-IMPL-9B6D',
  mutant: 'SHELF-SEALED-MUTANT-2R8N',
  drill: 'SHELF-SEALED-DRILL-6H1Z',
} as const;

export type ShelfSealedRole = keyof typeof SHELF_MARKERS;

/** Every marker, for a byte grep that does not care which role leaked. */
export const ALL_SHELF_MARKERS: readonly string[] = Object.values(SHELF_MARKERS);

/**
 * TaskTrackr's name, paths and facts. The Shelf pack carries none of them, so
 * any of these in a request or a page about the Shelf pack came from somewhere
 * else.
 */
export const TASKTRACKR_SENTINELS: readonly string[] = [
  'TaskTrackr',
  'tasktrackr',
  'due_date',
  'TASK_SELECT',
  'CR-2',
  'schema.sql',
  'web/dist',
  'completeTask',
  'US-4',
  'Dana',
];
