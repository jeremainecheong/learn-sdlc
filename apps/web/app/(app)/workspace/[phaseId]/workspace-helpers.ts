/**
 * The workspace room's module-level helpers: which editors it opens on, the
 * folded tree it remembers, its tabs and panes, the widths it watches, the
 * sentences it says when a save or a job goes wrong, and how it follows a
 * queued job and names a language. Nothing here holds component state.
 */
import type { AnalyzerFunction, JobStatus, PhaseKey, SubmissionView, WorkspaceFile } from '@learnsdlc/shared';
import { ApiError } from '@/lib/api';
import { PollTimeoutError, SLOW_POLL_INTERVAL_MS, SLOW_POLL_TIMEOUT_MS, pollUntil, type PollOptions } from '@/lib/poll';
import { learnerMessage } from '@/lib/useProject';
import { changeFirst } from '@/components/workspace/opening-file';

/**
 * How many editors the strip opens on. Past this it is a scrollbar, and the
 * Explorer is the better way in.
 */
const SEED_MAX = 6;

/**
 * The read-only file one editable file is checked against, by name:
 * `overdue.ts` is checked by `overdue.test.ts`, `tasks.py` by
 * `test_tasks_api.py`. Nothing is invented: a pack that does not name its
 * suites after the code simply gets no twin.
 */
function twinOf(path: string, files: WorkspaceFile[]): string | undefined {
  const stem = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
  if (!stem) return undefined;
  return files.find((f) => {
    if (f.editable || f.path === path) return false;
    const other = f.path.split('/').pop() ?? f.path;
    return (
      other.startsWith(`${stem}.test.`) ||
      other === `test_${stem}.py` ||
      other.startsWith(`test_${stem}_`) ||
      other === `${stem}_test.py`
    );
  })?.path;
}

/**
 * Which editors an IDE opens on: every file you are asked to change, in the
 * order the phase declares them, then the first read-only file each of them is
 * checked against.
 *
 * A full-stack phase gives four gaps across two layers, and opening three of
 * four is worse than opening none: the fourth is the one the learner does not
 * know is there. Everything else is in the Explorer.
 */
export function seedTabs(files: WorkspaceFile[], phaseKey: PhaseKey, owned?: string[]): string[] {
  // On a phase a teacher has split, the tabs a task opens on are the
  // files that task owns. Its siblings' files are in the Explorer like
  // everything else: opening them would say this is your work when it is not.
  // The file to change leads, then its test: `changeFirst` keeps the phase's order otherwise.
  const open = (owned?.length ? owned : changeFirst(files).map((f) => f.path)).slice();
  const add = (path?: string) => {
    if (path && !open.includes(path) && open.length < SEED_MAX) open.push(path);
  };
  for (const path of [...open]) add(twinOf(path, files));
  // Nothing named after it: the artefact the phase is judged against.
  const find = (frag: string) => files.find((f) => f.path.includes(frag) && !open.includes(f.path));
  if (open.length < SEED_MAX) {
    add((phaseKey === 'testing' ? find('repository/') : find('contract/'))?.path);
  }
  return open.length ? open : files.slice(0, 1).map((f) => f.path);
}

/**
 * Where a phase's folded folders are remembered. One key per room: the phase
 * on a phase with one task, and the phase and the task where a teacher has
 * split one. The key must not
 * change shape for a one-task phase: it lives in `localStorage`, so it would
 * silently reset every learner's file tree in the product.
 */
const TREE_KEY = 'lsdlc_tree_';

export function readCollapsed(phaseId: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(`${TREE_KEY}${phaseId}`);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
  } catch {
    return null;
  }
}

export function keepCollapsed(phaseId: string, closed: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(`${TREE_KEY}${phaseId}`, JSON.stringify([...closed]));
  } catch {
    // A tree that forgets how it was folded costs one click.
  }
}

/**
 * The tabs of the right column. The third is named after the reviewer; the
 * fourth is the learner's own application, and it exists only on a phase whose
 * pack declares one.
 */
export type RightTab = 'brief' | 'map' | 'mentor' | 'preview';
/**
 * Which column the small screen is showing. `files` is the explorer's own
 * pane: below `xl` the explorer steps out of the row so the editor keeps its
 * 420px, and without a pane of its own a phone would have no file tree at all
 * and the activity bar's first button would set the pane it was already on.
 */
export type Pane = 'task' | 'files' | 'code' | 'panel' | 'preview';


/**
 * The analyzer's answer before there is one, as one array rather than a new one
 * every render.
 *
 * `report?.staticAnalysis?.functions ?? []` is a dependency of the spans, the
 * map, the problems and the notes, so until the learner's first submission a
 * fresh fallback would hand every one of those memos a new identity on every
 * commit (a caret move would rebuild the lot) and their consumers with it.
 * The work itself is
 * hundredths of a millisecond; what it would cost is the memo chain.
 */
export const NO_ANALYZER_FNS: AnalyzerFunction[] = [];

/**
 * The switcher below `lg` chooses a COLUMN, not a panel.
 *
 * Brief and Files share the mounted left column. Code is the flexible center;
 * Mentor is the right column. Choosing either side also opens its preference,
 * while hiding an active side always leaves Code available.
 */
export const PANES: [Pane, string][] = [
  ['task', 'Brief'],
  ['files', 'Files'],
  ['code', 'Code'],
  ['panel', 'Mentor'],
  // Filtered out on a phase with no application to run: a switcher entry that
  // selects an empty column is worse than four buttons.
  ['preview', 'Preview'],
];
// The row's words (WORKING_AREA_LABELS) live with the document pages' row (components/workspace/AreaNav), one list for both.

export const narrowWorkspaceSnapshot = () => window.matchMedia('(max-width: 1023px)').matches;
export const wideWorkspaceServerSnapshot = () => false;
export function subscribeWorkspaceWidth(listener: () => void) {
  const media = window.matchMedia('(max-width: 1023px)');
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
// Phones keep the panel switches on a row of their own (from 701 px they sit
// at the right end of the view tabs).
export const phoneWorkspaceSnapshot = () => window.matchMedia('(max-width: 700px)').matches;
export function subscribePhoneWidth(listener: () => void) {
  const media = window.matchMedia('(max-width: 700px)');
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

export const SAVE_FAILED_SUBMIT = 'Your changes could not be saved, so nothing was submitted.';
export const SAVE_FAILED_RUN = 'Your changes could not be saved, so nothing was run.';
export const SAVE_FAILED_RUN_APP = 'Your changes could not be saved, so the app was not started.';
export const SAVE_FAILED_ADVANCE = 'Your changes could not be saved. Try again before continuing.';
export const STILL_RUNNING =
  'Still running. This is taking longer than usual; the result will appear here as soon as it lands.';
export const GAVE_UP =
  'Still no result after a long wait. Reload this page to check on it, or submit again.';

export const settled = (job: { status: JobStatus }) =>
  job.status === 'completed' || job.status === 'failed';

/** Keep `prev` when it is settled and at least as new as `next`; otherwise take `next`. */
export function pickNewer(prev: SubmissionView | null, next: SubmissionView | null): SubmissionView | null {
  if (!prev || !next) return next ?? prev;
  if (prev.id === next.id) return next;
  if (!settled(prev)) return next;
  return String(next.createdAt) <= String(prev.createdAt) ? prev : next;
}

/**
 * The id of the verdict this browser last watched land, per phase.
 *
 * `pickNewer` can only defend a verdict the page is still holding. Coming back
 * to a phase (the sidebar, a reload, a link from the map) starts from
 * nothing, and the server names a phase's "last" submission by createdAt,
 * which is stored to the second: two submissions made inside one second tie
 * and the older one can come back. Remembering the id lets the page ask for
 * the right one by name instead of trusting that tie-break.
 */
const VERDICT_KEY = 'lsdlc_verdict';

export function readVerdict(phaseId: string): { id: string; createdAt: string } | null {
  try {
    const raw = sessionStorage.getItem(`${VERDICT_KEY}:${phaseId}`);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.id === 'string' && typeof v.createdAt === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function rememberVerdict(phaseId: string, s: SubmissionView | null): void {
  if (!s || !settled(s)) return;
  try {
    sessionStorage.setItem(
      `${VERDICT_KEY}:${phaseId}`,
      JSON.stringify({ id: s.id, createdAt: s.createdAt }),
    );
  } catch {
    // a lost note only costs the tie-break
  }
}

/**
 * Why the room did not open, in the product's voice.
 *
 * The API's own words ("not your phase", "phase not found") are written for
 * the log, not for a learner, so none is pasted after a product sentence.
 * Every branch here is one whole sentence, so nothing is prefixed to it.
 */
export function loadFailure(err: unknown): string {
  if (err instanceof ApiError) {
    const said = String(err.message ?? '').toLowerCase();
    if (err.status === 403 && said.includes('not your phase')) {
      return 'That phase belongs to another learner.';
    }
    if (err.status === 404) return 'There is no phase with that address.';
  }
  return learnerMessage(err, 'This phase could not be loaded. Try again in a moment.');
}

/**
 * A field the keystroke belongs to. Monaco's own textarea counts as one, which
 * is why the caller also asks where the target sits.
 */
export function isTextField(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Reads `?tab=`; anything that is not one of the four is ignored. */
export function wantedTab(): RightTab | null {
  if (typeof window === 'undefined') return null;
  const t = new URLSearchParams(window.location.search).get('tab');
  return t === 'brief' || t === 'map' || t === 'mentor' || t === 'preview' ? t : null;
}

/**
 * Watch a queued job to its end. Running out of the normal wait does not mean
 * the job died (a busy queue or a slow sandbox looks exactly the same from
 * here) so instead of failing the learner we say so and keep watching at a
 * gentler pace. A second timeout still surfaces as `PollTimeoutError`.
 *
 * `wake` is the socket saying the job has landed, which is worth most of an
 * interval to a learner watching the pane: most of five seconds once the
 * watch has slowed down. It only shortens the wait: the value always comes
 * from the fetch it triggers.
 */
export async function follow<T extends { status: JobStatus }>(
  fetcher: () => Promise<T>,
  onSlow: (last: T | undefined) => void,
  wake?: PollOptions['wake'],
): Promise<T> {
  try {
    return await pollUntil(fetcher, settled, { wake });
  } catch (err) {
    if (!(err instanceof PollTimeoutError)) throw err;
    onSlow(err.last as T | undefined);
    return pollUntil(fetcher, settled, { intervalMs: SLOW_POLL_INTERVAL_MS, timeoutMs: SLOW_POLL_TIMEOUT_MS, wake });
  }
}

/** The language the status bar names, from the file being edited. */
export function languageLabel(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const named: Record<string, string> = {
    // The label names the reference pack's runtime: the pack builds on
    // python:3.11-slim (content/tasktrackr/canonical/api/Dockerfile).
    python: 'Python 3.11',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    markdown: 'Markdown',
    yaml: 'YAML',
    json: 'JSON',
    dockerfile: 'Dockerfile',
    react: 'React',
  };
  return named[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
}

