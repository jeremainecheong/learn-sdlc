import { describe, expect, it } from 'vitest';
import type { SolutionView } from '@learnsdlc/shared';
import {
  sameText,
  solutionRows,
  solutionSummary,
  standingLine,
} from '@/components/solution/derive';

/**
 * The reveal's arithmetic.
 *
 * Three states, and the whole feature reads as broken if any of them is drawn
 * as another: an identical file is an achievement, a pruned file is a fact
 * about retention, and a changed file is the only one with a diff to read.
 */

const view = (files: SolutionView['files']): SolutionView => ({
  phaseStateId: 'p1',
  phaseKey: 'implementation',
  phaseTitle: 'Implementation',
  available: true,
  unavailableReason: null,
  files,
  bestScore: 86,
  passedAt: '2026-09-03T10:00:00.000Z',
  readAt: '2026-09-03T11:00:00.000Z',
  packVersion: '2.0.0',
});

const file = (
  path: string,
  yours: string | null,
  theirs: string,
  language = 'python',
): SolutionView['files'][number] => ({ path, yours, theirs, language });

describe('sameText', () => {
  it('ignores a trailing newline and trailing spaces', () => {
    expect(sameText('a\nb', 'a\nb\n')).toBe(true);
    expect(sameText('a  \nb\t', 'a\nb')).toBe(true);
    expect(sameText('a\r\nb', 'a\nb')).toBe(true);
  });

  it('treats everything else as a difference', () => {
    expect(sameText('a\nb', 'a\nc')).toBe(false);
    // Leading whitespace is indentation, and indentation is the code.
    expect(sameText('  a', 'a')).toBe(false);
    expect(sameText('a\n\nb', 'a\nb')).toBe(false);
  });
});

describe('solutionRows', () => {
  it('marks a file the learner matched as identical, with no diff to read', () => {
    const [row] = solutionRows(view([file('api/repository/tasks.py', 'x = 1\n', 'x = 1')]));
    expect(row.state).toBe('identical');
    expect(row.diff).toBeNull();
    expect(row.adds).toBe(0);
    expect(row.dels).toBe(0);
  });

  it('marks a pruned file not-kept, and still carries the pack’s text', () => {
    const [row] = solutionRows(view([file('api/routes/tasks.py', null, 'theirs\n')]));
    expect(row.state).toBe('not-kept');
    expect(row.diff).toBeNull();
    expect(row.theirs).toBe('theirs\n');
  });

  it('diffs a changed file with the learner on the left and the pack on the right', () => {
    const [row] = solutionRows(
      view([file('web/src/lib/overdue.ts', 'one\ntwo\n', 'one\nTWO\nthree\n', 'typescript')]),
    );
    expect(row.state).toBe('differs');
    expect(row.diff).not.toBeNull();
    // "two" is the learner's and is removed; "TWO" and "three" are the pack's.
    expect(row.dels).toBe(1);
    expect(row.adds).toBe(2);
    expect(row.language).toBe('typescript');
  });

  it('keeps the pack’s own order', () => {
    const rows = solutionRows(
      view([
        file('api/repository/tasks.py', 'a', 'a'),
        file('web/src/hooks/useTasks.ts', 'b', 'c', 'typescript'),
      ]),
    );
    expect(rows.map((r) => r.path)).toEqual(['api/repository/tasks.py', 'web/src/hooks/useTasks.ts']);
  });
});

describe('solutionSummary', () => {
  it('says so when every file matched', () => {
    const rows = solutionRows(view([file('a.py', 'x', 'x'), file('b.py', 'y', 'y')]));
    expect(solutionSummary(rows)).toBe('All two files are the same as yours, line for line.');
  });

  it('writes one file in the singular', () => {
    const rows = solutionRows(view([file('a.py', 'x', 'x')]));
    expect(solutionSummary(rows)).toBe('Your file and the pack are the same, line for line.');
  });

  it('counts the three states in one sentence, with no pipes or middle dots', () => {
    const rows = solutionRows(
      view([
        file('a.py', 'x', 'y'),
        file('b.py', 'z', 'z'),
        file('c.py', null, 'q'),
        file('d.py', 'm', 'n'),
      ]),
    );
    const line = solutionSummary(rows);
    expect(line).toBe('Two files differ, one file is the same as yours and one file was not kept.');
    expect(line).not.toMatch(/[|·]/);
  });

  it('has an honest line for a phase the pack answers nothing for', () => {
    expect(solutionSummary([])).toBe('The pack answers no files for this phase.');
  });
});

describe('standingLine', () => {
  it('names the score and the day the gate went in', () => {
    expect(standingLine(view([]), 'Implementation')).toBe(
      'You passed Implementation with 86 on 3 September. This is the answer the hidden tests were written against.',
    );
  });

  it('drops what it does not know rather than printing a null', () => {
    expect(standingLine({ ...view([]), bestScore: null, passedAt: null }, 'Testing')).toBe(
      'You passed Testing. This is the answer the hidden tests were written against.',
    );
  });
});
