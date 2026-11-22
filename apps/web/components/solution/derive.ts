import { andList, numberWord, pluralWord, type SolutionFileView, type SolutionView } from '@learnsdlc/shared';
import { fileDiff, type FileDiff } from '@/components/pr';
import { capitalise } from '@/lib/capitalise';
import { DISPLAY_LOCALE } from '@/lib/locale';

/**
 * What the reveal draws, worked out before anything is drawn.
 *
 * Pure on purpose: the page renders rows, and the decision about what a row is
 * (the same file, a changed file, or a file whose copy is gone) is arithmetic
 * on two strings and belongs where a test can reach it.
 */

export type SolutionFileState = 'identical' | 'differs' | 'not-kept';

export interface SolutionFileRow {
  path: string;
  language: string;
  state: SolutionFileState;
  /** The learner's text, or null when their copy was not kept. */
  yours: string | null;
  /** The pack's text. */
  theirs: string;
  /** Null for `identical` and for `not-kept`: neither has a diff to draw. */
  diff: FileDiff | null;
  adds: number;
  dels: number;
}

/**
 * Trailing whitespace and a trailing newline are not a difference.
 *
 * A learner whose editor strips a final newline has not written a different
 * file, and telling them they have would make the one screen that says "you
 * got there" say "you nearly got there" instead.
 */
export function sameText(a: string, b: string): boolean {
  return normalise(a) === normalise(b);
}

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/** One row per file the pack answers, in the pack's own order. */
export function solutionRows(view: SolutionView): SolutionFileRow[] {
  return view.files.map(rowOf);
}

function rowOf(file: SolutionFileView): SolutionFileRow {
  const base = { path: file.path, language: file.language, yours: file.yours, theirs: file.theirs };
  if (file.yours === null) {
    return { ...base, state: 'not-kept', diff: null, adds: 0, dels: 0 };
  }
  if (sameText(file.yours, file.theirs)) {
    return { ...base, state: 'identical', diff: null, adds: 0, dels: 0 };
  }
  // Left is the learner's, right is the pack's: a removed line is theirs, an
  // added line is the pack's, which is what the legend on the page says in
  // words. The direction is a decision, so it is made once, here.
  const diff = fileDiff(file.path, file.yours, file.theirs);
  return { ...base, state: 'differs', diff, adds: diff.adds, dels: diff.dels };
}

/**
 * The page's one-line summary, in the product's voice.
 *
 * It counts files rather than lines because a learner opening this screen wants
 * to know how much of it they have to read before they know how much of it they
 * got right.
 */
export function solutionSummary(rows: SolutionFileRow[]): string {
  if (rows.length === 0) return 'The pack answers no files for this phase.';
  const differ = rows.filter((r) => r.state === 'differs').length;
  const same = rows.filter((r) => r.state === 'identical').length;
  const gone = rows.filter((r) => r.state === 'not-kept').length;
  if (differ === 0 && gone === 0) {
    return same === 1
      ? 'Your file and the pack are the same, line for line.'
      : `All ${count(same)} are the same as yours, line for line.`;
  }
  const parts: string[] = [];
  if (differ > 0) parts.push(`${count(differ)} ${pluralWord(differ, 'differs', 'differ')}`);
  if (same > 0) parts.push(`${count(same)} ${pluralWord(same, 'is', 'are')} the same as yours`);
  if (gone > 0) parts.push(`${count(gone)} ${pluralWord(gone, 'was', 'were')} not kept`);
  return `${joinedSentence(parts)}.`;
}

/** "three files": the count in words up to ten, then in digits. */
function count(n: number): string {
  return `${numberWord(n, 10)} ${pluralWord(n, 'file')}`;
}

/** "A", "A and b", "A, b and c": the product writes lists out, never with a pipe. */
function joinedSentence(parts: string[]): string {
  return capitalise(andList(parts));
}

/** The sentence under the title: what was passed, at what, and when. */
export function standingLine(view: SolutionView, phaseTitle: string): string {
  const score = view.bestScore === null ? '' : ` with ${Math.round(view.bestScore)}`;
  const when = view.passedAt ? ` on ${longDate(view.passedAt)}` : '';
  return `You passed ${phaseTitle}${score}${when}. This is the answer the hidden tests were written against.`;
}

/** "3 September", the date the rest of the product writes. */
export function longDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString(DISPLAY_LOCALE, { day: 'numeric', month: 'long' });
}
