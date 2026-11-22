// @vitest-environment jsdom
/**
 * The gate's finished example figure: the mutation table on Testing chapter 4
 * It plants five illustrative bugs in
 * the supplied lists feature, never the Testing room's eight graded ones, and
 * its kill map is the truth table written beside the data in figures/testing.tsx.
 */
import { repoPath } from './support/paths';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KILLS, MUTANTS, MutationTable, START_TESTS, TESTS, killedBy } from '@/components/learn/figures/testing';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<MutationTable />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const button = (name: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === name)!;
const row = (name: string) => host.querySelector(`tr[data-mutant="${name}"]`)!;
const status = (name: string) => row(name).querySelector('.fig-status')!.textContent;
const score = () => host.querySelector('[data-testid="mutation-score"]')?.textContent ?? null;
const live = () => host.querySelector('[data-testid="mutation-live"]')!;

describe('the mutation table', () => {
  const shelf = repoPath('content/tasktrackr/phases/04-testing/mutants');
  const graded = readdirSync(shelf).sort();

  it('plants five illustrative bugs in the lists feature, none of them one of the Testing room’s', () => {
    expect(graded).toHaveLength(8);
    expect(MUTANTS).toHaveLength(5);
    for (const m of MUTANTS) expect(graded).not.toContain(m.name);
    // The room's eight change tasks, the report, the filters and the row; this set stays off all of it.
    expect(JSON.stringify([MUTANTS, TESTS])).not.toMatch(/overdue|priority|keyword|search|badge|marker|complete|filter/i);
    for (const name of graded) {
      const meta = JSON.parse(readFileSync(resolve(shelf, name, 'meta.json'), 'utf8'));
      expect(meta.description, name).not.toMatch(/\blists?\b(?! query)/);
    }
    expect(host.querySelector('caption')!.textContent).toBe('Illustrative planted bugs, not the ones in your Testing room');
    expect(host.querySelector('.fig-model-tag')?.textContent).toBe('Illustrative planted bugs, not the ones in your Testing room. Your real kill matrix is in the room after you submit.');
  });

  it('kills exactly what the truth table says, each test as its button words it', () => {
    expect(KILLS).toEqual({
      'new-list': [],
      'open-and-done': ['open_count_counts_done'],
      'only-done': ['open_count_counts_done'],
      'empty-name': ['empty_name_accepted'],
      'made-order': ['lists_newest_first'],
    });
    const all = killedBy(TESTS.map((t) => t.value));
    expect(all.size).toBe(3);
    expect(MUTANTS.map((m) => m.name).filter((name) => !all.has(name))).toEqual(['duplicate_name_not_refused', 'task_count_by_id']);
    // The two survivors: no test makes two lists with one name, and COUNT(t.id) equals COUNT(*).
    expect(TESTS.filter((t) => /two lists|again|second/i.test(t.label))).toHaveLength(0);
    expect(MUTANTS.find((m) => m.name === 'task_count_by_id')!.change).toContain('every count comes out the same');
  });

  it('opens on two tests and two kills, every row saying its state in words', () => {
    expect(killedBy(START_TESTS).size).toBe(2);
    expect(score()).toBe('Killed 2 of 5');
    expect(button('One open and one finished task: open_count is 1').getAttribute('aria-pressed')).toBe('true');
    expect(button('An empty name gets 400 invalid_name').getAttribute('aria-pressed')).toBe('true');
    expect(button('Home, then Work: they come back as Home, Work').getAttribute('aria-pressed')).toBe('false');
    expect(button('Passed').getAttribute('aria-pressed')).toBe('true');
    for (const m of MUTANTS) expect(['Killed', 'Survived']).toContain(status(m.name));
    expect(status('empty_name_accepted')).toBe('Killed');
    expect(status('lists_newest_first')).toBe('Survived');
    expect(host.querySelectorAll('thead th[scope="col"]')).toHaveLength(3);
    expect(host.querySelectorAll('tbody th[scope="row"]')).toHaveLength(5);
  });

  it('kills lists_newest_first when the order test goes on, and says so', () => {
    act(() => button('Home, then Work: they come back as Home, Work').click());
    expect(status('lists_newest_first')).toBe('Killed');
    expect(row('lists_newest_first').getAttribute('data-changed')).toBe('true');
    expect(score()).toBe('Killed 3 of 5');
    expect(live().getAttribute('aria-live')).toBe('polite');
    expect(live().textContent).toBe('lists_newest_first is now killed. Killed 3 of 5.');
    act(() => button('Home, then Work: they come back as Home, Work').click());
    expect(live().textContent).toBe('lists_newest_first survives again. Killed 2 of 5.');
  });

  it('says why a test changes nothing: it catches the same bug the same way as one already on', () => {
    act(() => button('One finished task only: open_count is 0').click());
    expect(score()).toBe('Killed 2 of 5');
    expect(live().textContent).toBe('No result changed: open_count_counts_done was already killed by “One open and one finished task: open_count is 1”. This test catches it the same way: a finished task counted as open. Killed 2 of 5.');
    act(() => button('One open and one finished task: open_count is 1').click());
    expect(status('open_count_counts_done')).toBe('Killed');
    expect(live().textContent).toBe('No result changed: open_count_counts_done is still killed by “One finished task only: open_count is 0”, which catches it the same way: a finished task counted as open. Killed 2 of 5.');
  });

  it('says why a test that reaches no planted bug changes nothing', () => {
    act(() => button('A new list Home has task_count 0 and open_count 0').click());
    expect(score()).toBe('Killed 2 of 5');
    expect(live().textContent).toContain('catches none of these planted bugs. A new list has no tasks and a plain name');
  });

  it('marks every row Not evaluated and hides the score while the healthy run fails', () => {
    act(() => button('Failed').click());
    expect(button('Failed').getAttribute('aria-pressed')).toBe('true');
    expect(score()).toBeNull();
    expect(host.textContent).toContain('Fix the healthy run first');
    expect(host.textContent).toContain('the Testing room does not run its planted bugs until your suite passes on the healthy code');
    for (const m of MUTANTS) expect(status(m.name)).toBe('Not evaluated');
    expect(live().textContent).toContain('Fix the healthy run first');
    act(() => button('Passed').click());
    expect(score()).toBe('Killed 2 of 5');
  });

  it('moves between tests with the arrow keys and toggles with the keyboard’s button press', () => {
    const first = button('A new list Home has task_count 0 and open_count 0');
    first.focus();
    act(() => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(document.activeElement).toBe(button('One open and one finished task: open_count is 1'));
  });

  it('draws each planted bug as a small card at a phone’s width, still a table to a screen reader', () => {
    const table = host.querySelector('table')!;
    expect(table.classList.contains('fig-c-mutants')).toBe(true);
    expect(table.getAttribute('role')).toBe('table');
    for (const m of MUTANTS) {
      const r = row(m.name);
      expect(r.getAttribute('role')).toBe('row');
      expect(r.querySelector('th[role="rowheader"] code')!.textContent).toBe(m.name);
      expect(r.querySelector('td[data-col="change"]')!.textContent).toBe(m.change);
      expect(r.querySelector('td[data-col="verdict"] .fig-status')).not.toBeNull();
    }
    expect(host.querySelectorAll('thead th[role="columnheader"]')).toHaveLength(3);
    // The card layout: name and verdict on one line, what it changes across the card below.
    const css = readFileSync(resolve(__dirname, '../components/learn/figures/implementation-testing.css'), 'utf8');
    const phone = css.slice(css.lastIndexOf('@media (max-width: 520px)'));
    expect(phone).toMatch(/\.fig-c-mutants tbody tr \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto;/);
    expect(phone).toContain('.fig-c-mutants td[data-col="change"] { grid-column: 1 / -1; grid-row: 2; }');
    expect(phone).toContain('.fig-c-mutants td[data-col="verdict"] { grid-column: 2; grid-row: 1; }');
    expect(phone).toMatch(/\.fig-c-mutants thead \{ position: absolute;[^}]*clip-path: inset\(50%\)/);
  });

  it('keeps the copy lint’s separators out of its data', () => {
    const words = JSON.stringify([MUTANTS, TESTS]);
    expect(words).not.toMatch(/[·|]/);
  });
});
