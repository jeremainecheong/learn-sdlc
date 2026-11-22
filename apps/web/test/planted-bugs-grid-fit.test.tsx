// @vitest-environment jsdom
/**
 * The planted bugs page of a finished Testing phase.
 *
 * With the brief and the mentor open at 1440 x 900 the card holds about
 * 660 px, and the grid asked for 762 (270 + 8 x 44 + 140): B7, B8 and the
 * row's chips were cut off and the longest test name ran into B1. The grid now
 * asks for 580 and its names wrap.
 * With every bug caught, "What B8 changes" asked for a test that already
 * exists ("is your own criterion. Write it as a test and this bug dies.").
 * A test no planted bug makes fail was "the happy path", and the
 * evidence fold said such tests "prove nothing"; the Breaks column broke
 * "US-5/AC-2" over three lines.
 * The states a learner is still working in keep their words, word for word.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MutantRow } from '@learnsdlc/shared';
import {
  MATRIX_TRACKS,
  MatrixGrid,
  MatrixRead,
  MutantDiff,
  NO_BUG_MAKES_IT_FAIL,
  PlantedBugs,
  matrixTracks,
  todo,
} from '@/components/workspace/panels/testing/MatrixDoc';
import { matrixView, type TestFn } from '@/components/workspace/panels/testing/lib';

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (node: React.ReactNode) => act(() => root.render(node));
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

const LONG = 'test_US4_AC1_overdue_lists_only_open_tasks_before_requested_day';
const tests = (names: string[]): TestFn[] => names.map((name, i) => ({ name, line: i + 1 }) as unknown as TestFn);
const mutant = (i: number, cases: [string, 'passed' | 'failed'][], covers?: string): MutantRow => ({
  mutant: `bug_${i}`,
  description: `The rule ${i} is broken.`,
  killed: cases.some(([, s]) => s === 'failed'),
  cases: cases.map(([name, status]) => ({ name, status })),
  ...(covers ? { covers } : {}),
}) as MutantRow;

/** Eight bugs, every one caught; test_idle catches none (the finished learner's shape). */
function finished() {
  const names = [LONG, 'test_b', 'test_idle'];
  const rows = Array.from({ length: 8 }, (_, i) =>
    mutant(i + 1, [[LONG, i === 7 ? 'passed' : 'failed'], ['test_b', i === 7 ? 'failed' : 'passed'], ['test_idle', 'passed']], `US-${i + 1}/AC-1`));
  return matrixView(rows, tests(names));
}
/** The same, with B3 alive (a learner still working). */
function working() {
  const names = [LONG, 'test_idle'];
  const rows = Array.from({ length: 4 }, (_, i) =>
    mutant(i + 1, [[LONG, i === 2 ? 'passed' : 'failed'], ['test_idle', 'passed']], i === 2 ? 'US-4/AC-2' : undefined));
  return matrixView(rows, tests(names));
}

describe('the grid fits the card with the brief and the mentor open', () => {
  it('asks for 580 px at eight bugs, inside the 660 px card, where it asked for 762', () => {
    const { template, minWidth } = matrixTracks(8);
    expect(minWidth).toBe(MATRIX_TRACKS.name + 8 * MATRIX_TRACKS.cell + MATRIX_TRACKS.flag);
    expect(minWidth).toBe(580);
    expect(minWidth).toBeLessThanOrEqual(660);
    // Wide, every track still takes what it needs: the names their full width, a bug 44 px, the chip the rest.
    expect(template).toBe('minmax(168px, max-content) repeat(8, minmax(36px, 44px)) minmax(124px, 1fr)');
  });

  it('draws that template, in a box that scrolls on its own below it', async () => {
    await render(<MatrixGrid view={finished()} />);
    const box = q('phase-testing-matrix-grid')!;
    expect(box.className).toContain('overflow-x-auto');
    const grid = box.firstElementChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe(matrixTracks(8).template);
    expect(grid.style.minWidth).toBe('580px');
  });

  it('wraps a long test name instead of running it into B1, the full name kept on its title', async () => {
    await render(<MatrixGrid view={finished()} />);
    const cell = q(`phase-testing-matrix-test-${LONG}`)!;
    expect(cell.title).toBe(LONG);
    expect(cell.className).toContain('min-w-0');
    const name = cell.lastElementChild as HTMLElement;
    expect(name.textContent).toBe(LONG.replace(/^test_/, ''));
    expect(name.className).not.toContain('whitespace-nowrap');
    expect(name.className).toContain('[overflow-wrap:anywhere]');
  });

  it('lets a row chip take a second line where its column is narrow', async () => {
    await render(<MatrixGrid view={finished()} />);
    const chips = [...host.querySelectorAll('.chip')] as HTMLElement[];
    expect(chips.map((c) => c.textContent)).toContain('No planted bug behind it');
    for (const chip of chips) expect(chip.className).toMatch(/\bwhitespace-normal\b.*\bh-auto\b|\bh-auto\b.*\bwhitespace-normal\b/);
  });
});

describe('what the last bug changes, when every bug is caught', () => {
  it('names the test that catches it, and asks for no test', async () => {
    await render(<MutantDiff view={finished()} />);
    const text = q('phase-testing-mutant-diff')!.textContent ?? '';
    expect(text).toContain('What B8 changes');
    expect(text).toContain('+ Your test b fails on it, so this bug is caught.');
    expect(text).not.toContain('is your own criterion');
    expect(text).not.toContain('this bug dies');
  });

  it('two tests that catch it are both named', async () => {
    const view = finished();
    const last = view.rows[view.rows.length - 1];
    last.killers = ['test_b', LONG];
    await render(<MutantDiff view={view} />);
    expect(q('phase-testing-mutant-diff')!.textContent).toContain(
      `+ Your tests b and ${LONG.replace(/^test_/, '')} fail on it, so this bug is caught.`,
    );
  });

  it('a bug still alive reads as it always did', async () => {
    await render(<MutantDiff view={working()} />);
    const text = q('phase-testing-mutant-diff')!.textContent ?? '';
    expect(text).toContain('What B3 changes');
    expect(text).toContain('+ US-4/AC-2 is your own criterion. Write it as a test and this bug dies.');
    const plain = working();
    plain.rows[2].row = { ...plain.rows[2].row, covers: undefined } as MutantRow;
    await render(<MutantDiff view={plain} />);
    expect(q('phase-testing-mutant-diff')!.textContent).toContain('+ Write a test that fails on this behaviour and this bug dies.');
  });
});

describe('a test no planted bug makes fail', () => {
  it('is not called the happy path in the list', () => {
    const items = todo(finished());
    expect(items).toEqual([{ lead: 'Leave idle but do not count on it.', rest: NO_BUG_MAKES_IT_FAIL }]);
    expect(NO_BUG_MAKES_IT_FAIL).toBe('No planted bug makes it fail, so it catches none of them.');
    expect(JSON.stringify(items)).not.toContain('happy path');
  });

  it('a bug still alive leads the list, in the words it had', () => {
    const items = todo(working());
    expect(items[0]).toEqual({
      lead: 'Write a test that fails when the rule 3 is broken.',
      rest: 'It kills B3 and it is your own criterion US-4/AC-2.',
    });
    expect(items[1].rest).toBe(NO_BUG_MAKES_IT_FAIL);
  });

  it('the evidence fold does not say such a test proves nothing', async () => {
    await render(<MatrixRead view={finished()} />);
    expect(host.textContent).toBe('No planted bug makes idle fail. A criterion test with no planted bug behind it is still the right test.');
    await render(<MatrixRead view={working()} />);
    expect(host.textContent).toBe(
      'B3 survives because no test fails on it. Your own US-4/AC-2 is the criterion B3 breaks; write it as a test and this bug dies. '
      + 'No planted bug makes idle fail. A criterion test with no planted bug behind it is still the right test.',
    );
    expect(host.textContent).not.toContain('prove');
  });

  it('the Breaks column takes its own width, so a criterion id stays on one line', async () => {
    await render(<PlantedBugs view={finished()} />);
    const grid = host.querySelector('[role="table"]') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe('minmax(0,1fr) max-content auto');
  });
});
