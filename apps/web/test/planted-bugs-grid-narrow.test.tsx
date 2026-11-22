// @vitest-environment jsdom
/**
 * The finished TaskTrackr's Planted bugs page at 1280 px wide with the brief and the mentor open.
 *
 * - The full planted bugs grid needs 580 px, more than the 500 px box. Narrower than the full grid, the chip moves
 *   under the test's name and the last column is a bug's; only narrower than that does the box scroll, with a line
 *   above it.
 * - A long Python test name breaks after its underscores; the "No planted bug behind it" hint is four words.
 * - Fourteen names are a count, with the names in a fold, not one long sentence.
 *
 * jsdom lays nothing out: the widths a browser would give are set on the boxes here; the drawn look at each width
 * is for a browser to show.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MutantRow } from '@learnsdlc/shared';
import {
  BreakableName,
  IDLE_NAMED,
  MATRIX_SCROLL_CUE,
  MatrixGrid,
  MatrixRead,
  idleHint,
  matrixNarrow,
  matrixTracks,
  matrixTracksNarrow,
} from '@/components/workspace/panels/testing/MatrixDoc';
import { matrixView, type TestFn } from '@/components/workspace/panels/testing/lib';
import { markupLines } from './support/markup-snapshot';

let host: HTMLDivElement, root: Root;
/** The widths a browser would give, by the box's test id: [clientWidth, scrollWidth]. */
const boxes = new Map<string, [number, number]>();
const realClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const realScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth');
beforeEach(() => {
  boxes.clear();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return boxes.get(this.dataset.testid ?? '')?.[0] ?? 0; } });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return boxes.get(this.dataset.testid ?? '')?.[1] ?? 0; } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  if (realClient) Object.defineProperty(HTMLElement.prototype, 'clientWidth', realClient); else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  if (realScroll) Object.defineProperty(Element.prototype, 'scrollWidth', realScroll);
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
});
const render = (node: React.ReactNode) => act(() => root.render(node));
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

/* --------------------------------- the narrow grid --------------------------------- */

const tests = (names: string[]): TestFn[] => names.map((name, i) => ({ name, line: i + 1 }) as unknown as TestFn);
const LONG = 'test_completing_a_task_answers_with_it_finished';
/** Eight bugs, each caught by one of eight tests; two tests catch none (the finished learner's shape). */
function finished() {
  const names = [LONG, ...Array.from({ length: 8 }, (_, i) => `test_catches_${i + 1}`), 'test_idle'];
  const rows = Array.from({ length: 8 }, (_, i) => ({
    mutant: `bug_${i + 1}`,
    description: `Rule ${i + 1} is broken.`,
    killed: true,
    cases: names.map((name) => ({ name, status: name === `test_catches_${i + 1}` ? 'failed' : 'passed' })),
  }) as MutantRow);
  return matrixView(rows, tests(names));
}
const GRID_1280_PANELS = 500;
const GRID_1440_PANELS = 628;

describe('the planted bugs grid at 1280 px with both panels open', () => {
  it('the full grid needs 580 px; under that the chips move under the names and the grid needs 456', () => {
    expect(matrixTracks(8).minWidth).toBe(580);
    expect(matrixTracksNarrow(8).minWidth).toBe(456);
    expect(matrixTracksNarrow(8).template).toBe('minmax(168px, max-content) repeat(8, minmax(36px, 44px))');
    expect(matrixNarrow(GRID_1280_PANELS, 8)).toBe(true);
    expect(matrixTracksNarrow(8).minWidth).toBeLessThanOrEqual(GRID_1280_PANELS);
    // 1440 with both panels open, and anything unmeasured, keep the full grid
    expect(matrixNarrow(GRID_1440_PANELS, 8)).toBe(false);
    expect(matrixNarrow(0, 8)).toBe(false);
  });

  it('at 500 px: no chip column, each chip under its name, the bugs end the row, nothing scrolls', async () => {
    boxes.set('phase-testing-matrix-grid', [GRID_1280_PANELS, GRID_1280_PANELS]);
    await render(<MatrixGrid view={finished()} />);
    const box = q('phase-testing-matrix-grid')!;
    expect(box.dataset.narrow).toBe('true');
    const grid = box.firstElementChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe(matrixTracksNarrow(8).template);
    expect(grid.style.minWidth).toBe('456px');
    expect(host.textContent).not.toContain('What the row tells you');
    // each name cell holds its row's one chip, under the name
    const cells = [...host.querySelectorAll('[data-testid^="phase-testing-matrix-test-"]')];
    expect(cells).toHaveLength(10);
    for (const cell of cells) expect(cell.querySelectorAll('.chip')).toHaveLength(1);
    expect(q('phase-testing-matrix-test-test_catches_1')!.lastElementChild!.textContent).toBe('Load-bearing');
    expect(q('phase-testing-matrix-test-test_idle')!.lastElementChild!.textContent).toBe('No planted bug behind it');
    // every grid row is the name and eight cells: the last thing in a row is a bug's cell
    expect(grid.children.length).toBe(1 + 8 + 10 * 1 + 1 + 8);
    expect(q('phase-testing-matrix-scroll-cue')).toBeNull();
  });

  it('at 628 px (1440 with the panels open) the grid is the full one', async () => {
    boxes.set('phase-testing-matrix-grid', [GRID_1440_PANELS, GRID_1440_PANELS]);
    await render(<MatrixGrid view={finished()} />);
    const box = q('phase-testing-matrix-grid')!;
    expect(box.dataset.narrow).toBeUndefined();
    expect((box.firstElementChild as HTMLElement).style.gridTemplateColumns).toBe(matrixTracks(8).template);
    expect(host.textContent).toContain('What the row tells you');
  });

  it('narrower than even that (1024 px with both panels open) the box scrolls and a line above it says so', async () => {
    boxes.set('phase-testing-matrix-grid', [220, 456]);
    await render(<MatrixGrid view={finished()} />);
    expect(q('phase-testing-matrix-grid')!.dataset.narrow).toBe('true');
    expect(q('phase-testing-matrix-scroll-cue')?.textContent).toBe(MATRIX_SCROLL_CUE);
    expect(MATRIX_SCROLL_CUE).toBe('Scroll sideways to see every planted bug.');
  });
});

describe('a long test name breaks after its underscores', () => {
  it('offers a break after each underscore, and reads and copies as the same name', () => {
    const html = renderToStaticMarkup(<BreakableName text="completing_a_task_answers_with_it_finished" />);
    expect(html.match(/<wbr\/>/g)).toHaveLength(6);
    const div = document.createElement('div');
    div.innerHTML = html;
    expect(div.textContent).toBe('completing_a_task_answers_with_it_finished');
    // a name with spaces (a JavaScript test) is drawn as it is
    expect(renderToStaticMarkup(<BreakableName text="a task due yesterday is overdue" />)).toBe('a task due yesterday is overdue');
  });

  it('the grid draws its names so', async () => {
    await render(<MatrixGrid view={finished()} />);
    expect(q(`phase-testing-matrix-test-${LONG}`)!.querySelectorAll('wbr')).toHaveLength(6);
  });
});

describe('the figure\'s hint and the read of fourteen idle tests', () => {
  it('the hint under "No planted bug behind it" is four words', () => {
    expect(idleHint(14)).toBe('Still the right tests.');
    expect(idleHint(1)).toBe('Still the right test.');
    expect(idleHint(0)).toBeUndefined();
  });

  it('more than three idle tests: counted in the sentence, their names in a fold under it', async () => {
    const names = Array.from({ length: 14 }, (_, i) => `test_idle_${i + 1}`);
    const rows = [{ mutant: 'bug_1', description: 'x', killed: true, cases: [...names.map((name) => ({ name, status: 'passed' })), { name: 'test_k', status: 'failed' }] } as MutantRow];
    await render(<MatrixRead view={matrixView(rows, tests([...names, 'test_k']))} />);
    const sentence = host.querySelector('p')!.textContent;
    expect(sentence).toBe('No planted bug makes 14 of your tests fail. A criterion test with no planted bug behind it is still the right test.');
    const fold = q('phase-testing-matrix-idle')!;
    expect(fold.tagName).toBe('DETAILS');
    expect(fold.querySelector('summary')!.textContent).toBe('The 14 tests');
    expect([...fold.querySelectorAll('li')].map((li) => li.textContent)).toEqual(names.map((n) => n.replace(/^test_/, '')));
  });

  it('up to three are named in the sentence, in one paragraph', async () => {
    const names = Array.from({ length: IDLE_NAMED }, (_, i) => `test_idle_${i + 1}`);
    const rows = [{ mutant: 'bug_1', description: 'x', killed: true, cases: [...names.map((name) => ({ name, status: 'passed' })), { name: 'test_k', status: 'failed' }] } as MutantRow];
    await render(<MatrixRead view={matrixView(rows, tests([...names, 'test_k']))} />);
    expect(host.children).toHaveLength(1);
    expect(host.firstElementChild!.tagName).toBe('P');
    expect(host.textContent).toBe('No planted bug makes idle_1, idle_2 and idle_3 fail. A criterion test with no planted bug behind it is still the right test.');
  });
});

/* ------------------------------ the scroll cue ------------------------------ */

/**
 * At 1024 px the scroll cue sits ABOVE the grid's box, not under all of its rows far below the first view: one line,
 * the same words, shown on the same condition. Where nothing scrolls (1280 and 1440, panels open or hidden) the grid's
 * markup is the recorded one: the narrow grid at 1280 px, and the full grid, the same markup, at 1440 px with the
 * panels open or hidden.
 */
const GRID_1440_HIDDEN = 1286;
const GRID_SNAPSHOT: Record<number, string> = {
  [GRID_1280_PANELS]: '__snapshots__/planted-bugs-grid-narrow.html',
  [GRID_1440_PANELS]: '__snapshots__/planted-bugs-grid-full.html',
  [GRID_1440_HIDDEN]: '__snapshots__/planted-bugs-grid-full.html',
};

describe('the planted bugs cue is above the grid, and only while it scrolls', () => {
  for (const room of [GRID_1280_PANELS, GRID_1440_PANELS, GRID_1440_HIDDEN]) {
    it(`at a ${room} px box nothing scrolls: no cue, no room kept for one, the markup as its snapshot holds`, async () => {
      boxes.set('phase-testing-matrix-grid', [room, room]);
      await render(<MatrixGrid view={finished()} />);
      expect(q('phase-testing-matrix-scroll-cue')).toBeNull();
      expect(host.children).toHaveLength(1);
      expect(host.firstElementChild).toBe(q('phase-testing-matrix-grid'));
      await expect(markupLines(host.innerHTML)).toMatchFileSnapshot(GRID_SNAPSHOT[room]);
    });
  }

  it('at 1024 px with both panels open the cue is the line just above the grid, nothing under it', async () => {
    boxes.set('phase-testing-matrix-grid', [265, 456]);
    await render(<MatrixGrid view={finished()} />);
    const grid = q('phase-testing-matrix-grid')!;
    const cue = q('phase-testing-matrix-scroll-cue')!;
    expect(cue.textContent).toBe(MATRIX_SCROLL_CUE);
    expect(host.children).toHaveLength(2);
    expect(host.firstElementChild).toBe(cue);
    expect(grid.previousElementSibling).toBe(cue);
    expect(grid.nextElementSibling).toBeNull();
  });
});
