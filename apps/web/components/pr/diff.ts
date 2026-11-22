/**
 * A real line diff between two revisions of a file.
 *
 * The pull request shows what a submission changed, so the page needs the
 * change itself, not a summary of it: the base is the previous revision's
 * workspace snapshot (or nothing, for the first revision, since the scaffold
 * only exists on the API side), the head is the revision being read, and what
 * comes out is the unified diff a reviewer would comment on.
 *
 * Nothing here fetches and nothing here is specific to a phase.
 */

export type DiffKind = ' ' | '+' | '-';

export interface DiffLine {
  kind: DiffKind;
  /** Line number in the base, or null for an added line. */
  oldNo: number | null;
  /** Line number in the head, or null for a removed line. */
  newNo: number | null;
  text: string;
}

/** The tint behind a line: green where it was added, red where it was removed, none for context. */
export function diffLineTone(kind: DiffKind): string {
  return kind === '+' ? 'bg-passtint' : kind === '-' ? 'bg-failtint' : '';
}

/** The colour of a line's `+` or `-` mark; a context line's is muted. */
export function diffLineMark(kind: DiffKind): string {
  return kind === '+' ? 'text-pass' : kind === '-' ? 'text-fail' : 'text-muted';
}

export interface DiffHunk {
  /** Unchanged lines skipped before this hunk, for the "… n unchanged lines" rule. */
  skipped: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  adds: number;
  dels: number;
  hunks: DiffHunk[];
  /** Head line count, so a caller can say how big the file is. */
  lines: number;
  /** No base to compare against: every line reads as added. */
  added: boolean;
}

/** Lines of unchanged context kept either side of a change. */
const CONTEXT = 3;
/** Two changes closer than this share one hunk rather than splitting. */
const JOIN = CONTEXT * 2 + 1;
/** Above this the quadratic table is not worth building; the file reads as replaced. */
const CELLS = 4_000_000;

function split(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
}

/**
 * The longest common subsequence, trimmed at both ends first. Real revisions
 * change a few lines in the middle of a file, so the trim usually leaves a
 * table small enough to build in a frame.
 */
function lcs(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** Every line of the two texts, marked, in reading order. */
function diffLines(baseText: string, headText: string): DiffLine[] {
  const a = split(baseText);
  const b = split(headText);
  const out: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1;
  }

  for (let i = 0; i < head; i += 1) {
    out.push({ kind: ' ', oldNo: oldNo++, newNo: newNo++, text: a[i] });
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  if (midA.length * midB.length > CELLS) {
    for (const text of midA) out.push({ kind: '-', oldNo: oldNo++, newNo: null, text });
    for (const text of midB) out.push({ kind: '+', oldNo: null, newNo: newNo++, text });
  } else {
    const table = lcs(midA, midB);
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        out.push({ kind: ' ', oldNo: oldNo++, newNo: newNo++, text: midA[i] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        out.push({ kind: '-', oldNo: oldNo++, newNo: null, text: midA[i] });
        i += 1;
      } else {
        out.push({ kind: '+', oldNo: null, newNo: newNo++, text: midB[j] });
        j += 1;
      }
    }
    while (i < midA.length) out.push({ kind: '-', oldNo: oldNo++, newNo: null, text: midA[i++] });
    while (j < midB.length) out.push({ kind: '+', oldNo: null, newNo: newNo++, text: midB[j++] });
  }

  for (let i = b.length - tail; i < b.length; i += 1) {
    out.push({ kind: ' ', oldNo: oldNo++, newNo: newNo++, text: b[i] });
  }
  return out;
}

/**
 * The marked lines cut into hunks: changes with context around them, and a
 * count of what was skipped between one hunk and the next.
 *
 * `keep` lists head line numbers that must stay on screen whatever else is
 * elided: the lines reviewers left a thread on, which is the whole point of
 * showing the diff on this page. `keepOld` does the same for the base's line
 * numbers, which is where a thread the previous revision carried was left.
 */
function hunksOf(lines: DiffLine[], keep: number[] = [], keepOld: number[] = []): DiffHunk[] {
  const wanted = new Set(keep);
  const wantedOld = new Set(keepOld);
  const interesting = lines.map(
    (l) =>
      l.kind !== ' ' ||
      (l.newNo !== null && wanted.has(l.newNo)) ||
      (l.oldNo !== null && wantedOld.has(l.oldNo)),
  );
  const show = new Array<boolean>(lines.length).fill(false);
  interesting.forEach((yes, i) => {
    if (!yes) return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k += 1) {
      show[k] = true;
    }
  });

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let skipped = 0;
  let gap = 0;
  lines.forEach((line, i) => {
    if (show[i]) {
      // A short gap between two hunks is cheaper to read whole than to cut.
      if (current.length > 0 && gap > 0 && gap <= JOIN) {
        for (let k = i - gap; k < i; k += 1) current.push(lines[k]);
      } else if (gap > 0 && current.length > 0) {
        hunks.push({ skipped, lines: current });
        current = [];
        skipped = gap;
      } else if (gap > 0) {
        skipped += gap;
      }
      gap = 0;
      current.push(line);
    } else {
      gap += 1;
    }
  });
  if (current.length > 0) hunks.push({ skipped, lines: current });
  return hunks;
}

/** One file's diff, ready to draw. */
export function fileDiff(
  path: string,
  baseText: string | undefined,
  headText: string,
  keep: number[] = [],
  keepOld: number[] = [],
): FileDiff {
  const added = baseText === undefined;
  const lines = diffLines(baseText ?? '', headText);
  return {
    path,
    adds: lines.filter((l) => l.kind === '+').length,
    dels: lines.filter((l) => l.kind === '-').length,
    hunks: hunksOf(lines, keep, keepOld),
    lines: split(headText).length,
    added,
  };
}
