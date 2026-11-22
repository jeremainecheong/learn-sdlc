// @vitest-environment jsdom
/**
 * The Deployment and Maintenance guides' pinned facts. When a figure or a sentence is rebuilt, update the quoted words and keep
 * each fact; never weaken an assertion.
 */
import { repoFile } from './support/paths';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { StudyRecap, StudyWalkthrough } from '@/components/learn/StudyWalkthrough';
import { PHASE_STUDY } from '@/components/learn/study';

it('keeps comparison-table headings and phase transfer guidance accessible without the mentor', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(<><StudyWalkthrough chapter={PHASE_STUDY.deployment.chapters[1]} /><StudyRecap study={PHASE_STUDY.deployment} /></>));
    expect(host.querySelector('table caption')?.textContent).toBe('Match each claim to its evidence');
    expect(host.querySelectorAll('thead th[scope="col"]')).toHaveLength(3);
    expect(host.querySelectorAll('tbody th[scope="row"]')).toHaveLength(3);
    expect(host.querySelector('[aria-label="Phase recap and transfer"]')?.textContent).toContain('which image-build/live HTTP checks a real release still requires');
    expect(host.querySelector('iframe')).toBeNull();
  } finally { act(() => root.unmount()); }
});

/* ------------------- the eight figures and the room links ------------------- */
import type { ReactElement } from 'react';
import { describe } from 'vitest';
import { figuresFor } from '@/components/learn/figures/registry';
import * as Deployment from '@/components/learn/figures/deployment';
import * as Maintenance from '@/components/learn/figures/maintenance';
import { DEPLOYMENT_LESSON } from '@/components/learn/content/deployment';
import { MAINTENANCE_LESSON } from '@/components/learn/content/maintenance';

function mount(node: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  const press = (words: string) => {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === words);
    if (!button) throw new Error(`No button "${words}"`);
    act(() => button.click());
  };
  const done = () => { act(() => root.unmount()); host.remove(); };
  return { host, press, done };
}
const text = (host: HTMLElement, testId: string) => host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';

describe('Deployment and Maintenance figures', () => {
  it('registers a figure on every chapter of both guides, each id starting with its phase', () => {
    for (const phase of ['deployment', 'maintenance'] as const) {
      for (const chapter of [1, 2, 3, 4]) {
        const figures = figuresFor(phase, chapter);
        expect(figures.length).toBe(1);
        expect(figures[0].id.startsWith(`${phase}-`)).toBe(true);
      }
    }
  });

  it('lifecycle: a rebuild and a restart keep the 12 tasks, removing the volume drops them to 0 and says why', () => {
    const { host, press, done } = mount(<Deployment.LifecycleFigure />);
    try {
      expect(text(host, 'lifecycle-tasks')).toBe('Tasks stored: 12');
      press('Rebuild image');
      expect(text(host, 'lifecycle-tasks')).toBe('Tasks stored: 12');
      press('Restart container');
      expect(text(host, 'lifecycle-live')).toContain('same tasktrackr.db');
      press('Remove volume');
      expect(text(host, 'lifecycle-tasks')).toBe('Tasks stored: 0');
      expect(text(host, 'lifecycle-live')).toContain('deletes the tasks');
      expect(host.textContent).toContain('Data gone');
      press('Reset');
      expect(text(host, 'lifecycle-tasks')).toBe('Tasks stored: 12');
    } finally { done(); }
  });

  it('pipeline: v2 with a bad API_URL passes health, fails the user path and is blocked; a rollback keeps the data', () => {
    const { host, press, done } = mount(<Deployment.PipelineRollback />);
    try {
      expect(host.textContent).toContain('not GitHub Actions');
      press('Ship v2 with a bad API_URL');
      expect(text(host, 'stage-2')).toContain('Passed');
      expect(text(host, 'stage-3')).toContain('Failed');
      expect(text(host, 'stage-4')).toContain('Blocked');
      expect(text(host, 'pipeline-live')).toContain('http://localhost:8000');
      press('Roll back to v1');
      for (const i of [0, 1, 2, 3]) expect(text(host, `stage-${i}`)).toContain('Passed');
      expect(text(host, 'stage-4')).toContain('v1 restored');
      expect(text(host, 'pipeline-tasks')).toBe('Tasks stored: 12');
      expect(text(host, 'pipeline-live')).toContain('12 tasks are still there');
    } finally { done(); }
  });

  it('viewpoints: localhost is said per caller, and naming the api service turns the loop into a path to api', () => {
    const { host, press, done } = mount(<Deployment.NetworkViewpoints />);
    try {
      expect(text(host, 'viewpoint-live')).toContain('http://localhost:8000');
      expect(host.querySelector('svg desc')?.textContent).toContain('loops back into the web container');
      expect(host.querySelector('svg desc')?.textContent).toContain('not evidence that a deployment ran');
      press('From the api container');
      expect(host.querySelector('.fig-description')?.textContent).toContain('http://127.0.0.1:8000/api/health');
      const name = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Name the api service')!;
      expect(name.hasAttribute('aria-pressed')).toBe(false);
      press('Name the api service');
      expect(name.textContent).toBe('Put the faulted line back');
      expect(name.hasAttribute('aria-pressed')).toBe(false);
      expect(text(host, 'viewpoint-live')).toContain('http://api:8000');
      expect(host.querySelector('svg desc')?.textContent).toContain('reaches the api container');
      expect(host.querySelector('svg[role="img"]')?.getAttribute('aria-labelledby')?.split(' ')).toHaveLength(2);
    } finally { done(); }
  });

  /* A 12-unit monospace character is 0.6 em wide in Menlo and SF Mono;
   * 0.62 leaves a margin. */
  const MONO = 12 * 0.62;

  it('viewpoints: "localhost:5173" sits clear of the browser and web boxes', () => {
    const { host, done } = mount(<Deployment.NetworkViewpoints />);
    try {
      const svg = host.querySelector('svg.fig-dm-svg')!;
      expect(svg.getAttribute('viewBox')).toBe('0 0 1000 260');
      const rect = (node: string) => svg.querySelector(`rect[data-node="${node}"]`)!;
      const label = svg.querySelector('text[data-label="published"]')!;
      expect(label.textContent).toBe('localhost:5173');
      const half = (label.textContent!.length * MONO) / 2;
      const x = Number(label.getAttribute('x'));
      const browserRight = Number(rect('browser').getAttribute('x')) + Number(rect('browser').getAttribute('width'));
      const webLeft = Number(rect('web').getAttribute('x'));
      expect(x - half - browserRight).toBeGreaterThanOrEqual(30);
      expect(webLeft - (x + half)).toBeGreaterThanOrEqual(30);
    } finally { done(); }
  });

  it('impact map: every file path fits inside its part box with room on both sides', () => {
    const longest = Math.max(...Maintenance.IMPACT_PARTS.map((p) => p.file.length));
    expect(Maintenance.IMPACT_PARTS.find((p) => p.file.length === longest)?.file).toBe('web/src/components/TaskRow.tsx');
    expect(Maintenance.PART_BOX - longest * MONO).toBeGreaterThanOrEqual(24);
    for (const reader of Maintenance.QUERY_READERS) expect(Maintenance.READER_BOX - reader.label.length * 13 * 0.6).toBeGreaterThanOrEqual(24);
    const { host, done } = mount(<Maintenance.ImpactMap />);
    try {
      const svg = host.querySelector('svg.fig-dm-svg')!;
      expect(svg.getAttribute('viewBox')).toBe('0 0 1000 470');
      const boxes = [...svg.querySelectorAll('rect[data-part]')];
      expect(boxes).toHaveLength(7);
      for (const box of boxes) {
        expect(box.getAttribute('width')).toBe(String(Maintenance.PART_BOX));
        const x = Number(box.getAttribute('x'));
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x + Maintenance.PART_BOX).toBeLessThanOrEqual(1000);
      }
    } finally { done(); }
  });

  /* The incident is a timeline: one
   * rail, five ticks each placed at its time since the page, "Resolved" at
   * the rail's end, the evidence opening from a pressed tick, and skipping the
   * re-check breaking the rail before Resolved. */
  it('incident: five ticks on one rail, each at its time, with Resolved at the end', () => {
    const { host, done } = mount(<Deployment.IncidentTimeline />);
    try {
      const rail = host.querySelector('ol.fig-tl-rail')!;
      expect(rail.getAttribute('aria-label')).toBe('Incident timeline');
      const ticks = [...rail.querySelectorAll<HTMLButtonElement>('button.fig-tl-tick')];
      expect(ticks.map((t) => t.textContent)).toEqual(['0:00Paged', '1:40Symptom', '3:10Hypothesis', '5:20Fix applied', '6:30Re-checked']);
      // Spaced by time: 0, 100, 190, 320 and 390 seconds over 80 percent of the rail.
      expect(Deployment.INCIDENT_AT).toEqual([0, 20.5, 39, 65.6, 80]);
      const items = [...rail.querySelectorAll<HTMLElement>(':scope > li')];
      expect(items.map((li) => li.style.getPropertyValue('--at'))).toEqual(['0%', '20.5%', '39%', '65.6%', '80%', '100%']);
      expect(items.slice(0, 5).map((li) => li.style.getPropertyValue('--next'))).toEqual(['20.5%', '39%', '65.6%', '80%', '100%']);
      expect(text(host, 'incident-end')).toBe('Resolved');
      expect(host.textContent).toContain('Minutes and seconds since the page');
    } finally { done(); }
  });

  it('incident: a pressed tick opens its evidence under the rail, and only one is open', () => {
    const { host, done } = mount(<Deployment.IncidentTimeline />);
    try {
      const ticks = [...host.querySelectorAll<HTMLButtonElement>('button.fig-tl-tick')];
      const panel = host.querySelector<HTMLElement>('[data-testid="incident-evidence"]')!;
      expect(ticks.every((t) => t.getAttribute('aria-controls') === panel.id)).toBe(true);
      expect(ticks[0].getAttribute('aria-expanded')).toBe('true');
      expect(panel.textContent).toBe('0:00 Paged. INCIDENT-1: the faulted copy did not start.Evidence to keep: The page time and the selfcheck exit code on the faulted copy.');
      act(() => ticks[2].click());
      expect(ticks.map((t) => t.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'true', 'false', 'false']);
      expect(panel.textContent).toContain('3:10 Hypothesis. Requests never leave web, because API_URL is http://localhost:8000.');
      expect(panel.textContent).toContain('Evidence to keep: The config line');
      expect(panel.style.getPropertyValue('--at-fraction')).toBe('0.39');
      expect(panel.getAttribute('aria-live')).toBe('polite');
      act(() => ticks[2].click());
      expect(ticks.every((t) => t.getAttribute('aria-expanded') === 'false')).toBe(true);
      expect(panel.textContent).toBe('Press a tick to read what happened then and the evidence to keep.');
    } finally { done(); }
  });

  it('incident: skipping the re-check breaks the rail before Resolved and says Not shown resolved', () => {
    const { host, press, done } = mount(<Deployment.IncidentTimeline />);
    try {
      const last = () => [...host.querySelectorAll<HTMLElement>('ol.fig-tl-rail > li')][4];
      expect(last().getAttribute('data-segment')).toBe('whole');
      expect(text(host, 'incident-verdict')).toContain('Resolved');
      press('Skip the re-check');
      // One label, so its state is aria-pressed alone.
      expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'Skip the re-check')?.getAttribute('aria-pressed')).toBe('true');
      expect(last().getAttribute('data-segment')).toBe('broken');
      expect(last().getAttribute('data-state')).toBe('skipped');
      expect(last().textContent).toBe('6:30Re-check skipped');
      expect(text(host, 'incident-end')).toBe('Not shown resolved');
      expect(host.querySelector('[data-testid="incident-end"]')?.getAttribute('data-state')).toBe('unresolved');
      expect(text(host, 'incident-verdict')).toContain('Not shown resolved');
      act(() => last().querySelector('button')!.click());
      expect(text(host, 'incident-evidence')).toBe('6:30 Re-check skipped. Nobody re-ran the check that failed, so there is no passing output to keep.Evidence to keep: none, so the incident is not shown resolved.');
      press('Skip the re-check');
      expect(last().getAttribute('data-segment')).toBe('whole');
      expect(text(host, 'incident-end')).toBe('Resolved');
      expect(text(host, 'incident-evidence')).toContain('6:30 Re-checked. The same check that failed now passes on your files.');
    } finally { done(); }
  });

  it('incident: the verdict tag ends in a full stop and sits on its sentence’s baseline', () => {
    const { host, press, done } = mount(<Deployment.IncidentTimeline />);
    try {
      expect(text(host, 'incident-verdict')).toBe('Resolved. The check that failed now passes on the changed source.');
      press('Skip the re-check');
      expect(text(host, 'incident-verdict')).toBe('Not shown resolved. The fix was applied, but nobody checked the path that failed. A passing health check does not count.');
      expect(host.querySelector('[data-testid="incident-verdict"]')?.classList.contains('fig-tl-verdict')).toBe(true);
    } finally { done(); }
    const css = readFileSync(resolve(__dirname, '../components/learn/figures/deployment-maintenance.css'), 'utf8');
    expect(css).toContain('.fig-tl-verdict .fig-status { align-items: baseline; font-size: inherit; vertical-align: baseline; }');
    expect(css).toContain('.fig-tl-verdict .fig-status svg { align-self: center; }');
  });

  it('incident: the rail turns upright with a fixed time column below 780 px of figure, and its strokes follow the house style', () => {
    const css = readFileSync(resolve(__dirname, '../components/learn/figures/deployment-maintenance.css'), 'utf8');
    expect(css).toMatch(/\.fig-tl \{ container: fig-tl \/ inline-size; \}/);
    const upright = css.slice(css.indexOf('@container fig-tl (max-width: 779px)'));
    expect(upright).toMatch(/grid-template-columns: 44px 26px minmax\(0, 1fr\)/);
    expect(css).toMatch(/li\[data-segment="broken"\]::before \{ right: 62%; border-top: 1\.5px dashed var\(--fig-fail\); \}/);
    expect(css).toMatch(/\.fig-tl-tick\[aria-expanded="true"\] \{ border-color: var\(--fig-selected\)/);
    expect(css).not.toMatch(/fig-dm-timeline|fig-dm-row/);
  });

  it('impact map: selecting the shared task query names its three readers', () => {
    const { host, press, done } = mount(<Maintenance.ImpactMap />);
    try {
      expect(text(host, 'impact-detail')).toContain('api/repository/comments.py');
      press('Shared task query');
      expect(text(host, 'impact-detail')).toContain('get_task (every single-task answer), list_tasks (the list view), overdue_tasks (the overdue report)');
      expect(text(host, 'impact-detail')).toContain('reaches the list view, the overdue report and every single-task answer');
      expect(host.textContent).not.toMatch(/three screens|single task\b/);
      expect(host.querySelector('svg desc')?.textContent).toContain('its three readers are lit');
    } finally { done(); }
  });

  it('impact map: says what TaskTrackr really has, three screens and no single-task screen', () => {
    const screens = (JSON.parse(repoFile('content/tasktrackr/phases/02-design/files/shared/contract/screens.json')) as { screens: { route: string }[] }).screens.map((one) => one.route);
    expect(screens).toEqual(['#/', '#/lists/:listId', '#/overdue']);
    const tasks = repoFile('content/tasktrackr/phases/06-maintenance/files/api/repository/tasks.py');
    for (const reader of Maintenance.QUERY_READERS) expect(tasks).toMatch(new RegExp(`def ${reader.fn}\\(`));
    // get_task is the single-task answer of create, change, complete and reopen.
    for (const fn of ['create_task', 'update_task', 'complete_task', 'reopen_task']) {
      const body = tasks.slice(tasks.indexOf(`def ${fn}(`), tasks.indexOf('\ndef ', tasks.indexOf(`def ${fn}(`) + 4));
      expect(body, fn).toContain('return get_task(conn,');
    }
    expect(MAINTENANCE_LESSON.chapters[0].feedback).toBe('A change to the shared query reaches the list view, the overdue report and every single-task answer at once.');
  });

  it('join: on the supplied list query, an inner join loses Home and duplicates Reading; a count in a subquery keeps one row per list', () => {
    const { host, press, done } = mount(<Maintenance.JoinCardinality />);
    try {
      expect(text(host, 'join-live')).toBe('3 lists in, 4 rows out. Lost a list: Home. Duplicated a list: Reading.');
      expect(host.textContent).toContain('Lost a list');
      press('Left join');
      expect(text(host, 'join-live')).toBe('3 lists in, 5 rows out. Duplicated a list: Reading.');
      press('Left join with GROUP BY count');
      expect(text(host, 'join-live')).toContain('Right rows, wrong place');
      press('Count in a subquery');
      expect(text(host, 'join-live')).toContain('3 lists in, 3 rows out. One row per list, with counts 0, 1 and 3.');
    } finally { done(); }
  });

  it('join: teaches on the supplied LIST_SELECT and never prints the CR-2 answer', () => {
    const flat = (sql: string) => sql.replace(/\s+/g, ' ');
    const lists = flat(repoFile('content/tasktrackr/phases/06-maintenance/readonly/api/repository/lists.py'));
    const subquery = Maintenance.JOIN_SQL.subquery.slice(Maintenance.JOIN_SQL.subquery.indexOf('(SELECT'), Maintenance.JOIN_SQL.subquery.indexOf(' FROM lists l', 30));
    expect(lists).toContain(subquery);
    const solution = flat(repoFile('content/tasktrackr/phases/06-maintenance/solution/api/repository/tasks.py'));
    const answer = solution.slice(solution.indexOf('(SELECT COUNT(*) FROM comments'), solution.indexOf('AS comment_count') + 'AS comment_count'.length);
    expect(answer.length).toBeGreaterThan(20);
    const printed = JSON.stringify([Maintenance.JOIN_SQL, Maintenance.joinSummary('subquery'), Maintenance.joinSummary('grouped')]);
    expect(printed).not.toContain(answer);
    expect(printed).not.toMatch(/comment/i);
  });

  /* The figure draws each list as a box holding its task rows, a line from a task
   * row to each row the query returns, so a lost list and a duplicated list
   * are seen, in all four forms; the rows are what SQLite returns. */
  type Sqlite = { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { all(): Record<string, unknown>[] }; close(): void } };
  const sqlite = (process as unknown as { getBuiltinModule(id: string): unknown }).getBuiltinModule('node:sqlite') as Sqlite;

  it('join: every row the figure draws is the row SQLite returns, in its order, over round one’s three lists', () => {
    const db = new sqlite.DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
        CREATE TABLE tasks (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES lists(id), title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
        INSERT INTO lists (id, name) VALUES (1, 'Home'), (2, 'Errands'), (3, 'Reading');
        INSERT INTO tasks (id, list_id, title) VALUES (20, 2, 'Post the form'), (21, 3, 'Review notes'), (22, 3, 'Write summary'), (23, 3, 'Return books');`);
      // The figure's lists hold exactly these tasks, in id order.
      const held = db.prepare('SELECT l.name, t.title FROM lists l LEFT JOIN tasks t ON t.list_id = l.id ORDER BY l.id, t.id').all();
      const lists: Record<string, string[]> = {};
      for (const row of held) (lists[row.name as string] ??= []).push(...(row.title === null ? [] : [row.title as string]));
      expect(lists).toEqual(Maintenance.LIST_TASKS);
      for (const join of ['inner', 'left', 'grouped', 'subquery'] as const) {
        const got = db.prepare(Maintenance.JOIN_SQL[join]).all().map((row) => Object.values(row));
        expect(got, join).toEqual(Maintenance.JOIN_RESULTS[join].map((row) => [...row]));
        expect(Maintenance.joinRows(join).map((r) => r.list), join).toEqual(got.map((row) => row[0]));
      }
    } finally { db.close(); }
  });

  it('join: draws the lists as boxes of task rows joined by lines, so a lost list and a duplicated list are seen in each form', () => {
    const { host, press, done } = mount(<Maintenance.JoinCardinality />);
    const svg = () => host.querySelector('svg.fig-dm-svg')!;
    const lines = () => [...svg().querySelectorAll('line.edge-join')];
    const outs = () => [...svg().querySelectorAll('[data-out]')].map((g) => g.getAttribute('data-out'));
    const state = (list: string) => svg().querySelector(`[data-list="${list}"]`)?.getAttribute('data-state');
    try {
      expect(svg().getAttribute('role')).toBe('img');
      expect([...svg().querySelectorAll('[data-list]')].map((g) => g.getAttribute('data-list'))).toEqual(['Home', 'Errands', 'Reading']);
      // Each list box holds its task rows; Home's one row says it has none.
      expect(svg().querySelector('[data-list="Reading"]')?.textContent).toBe('Readinglist id 3Review noteslist_id 3Write summarylist_id 3Return bookslist_id 3');
      expect(svg().querySelector('[data-list="Home"]')?.textContent).toBe('Homelist id 1no tasks');

      // Inner join: no line leaves Home, and Reading comes out three times.
      expect(lines().map((l) => l.getAttribute('data-from'))).toEqual(['Post the form', 'Review notes', 'Write summary', 'Return books']);
      expect(outs()).toEqual(['Errands', 'Reading', 'Reading', 'Reading']);
      expect(state('Home')).toBe('lost');
      expect(state('Reading')).toBe('duplicated');
      expect(svg().querySelector('[data-lost="Home"]')?.textContent).toBe('No row for HomeLost a list');
      expect(svg().querySelector('[data-duplicated="Reading"]')?.textContent).toBe('Duplicated a listReading, 3 rows');
      expect(svg().textContent).toContain('Rows out: 4');

      press('Left join');
      expect(lines()).toHaveLength(5);
      expect(lines()[0].getAttribute('data-from')).toBe('Home, no tasks');
      expect(outs()).toEqual(['Home', 'Errands', 'Reading', 'Reading', 'Reading']);
      expect(svg().querySelector('[data-out="Home"]')?.textContent).toBe('HomeNULLOne row');
      expect(state('Home')).toBe('one');
      expect(svg().querySelector('[data-lost]')).toBeNull();
      expect(svg().querySelector('[data-duplicated="Reading"]')).not.toBeNull();

      for (const [form, dashed] of [['Left join with GROUP BY count', false], ['Count in a subquery', true]] as const) {
        press(form);
        // Every task row of a list runs into that list's one row.
        expect(outs(), form).toEqual(['Home', 'Errands', 'Reading']);
        expect(lines(), form).toHaveLength(5);
        const reading = lines().slice(2);
        expect(new Set(reading.map((l) => l.getAttribute('y2'))).size, form).toBe(1);
        expect(lines().every((l) => l.hasAttribute('stroke-dasharray') === dashed), form).toBe(true);
        expect([...svg().querySelectorAll('[data-out]')].map((g) => g.textContent), form).toEqual(['Hometask_count 0One row', 'Errandstask_count 1One row', 'Readingtask_count 3One row']);
        expect(svg().querySelector('[data-lost], [data-duplicated]'), form).toBeNull();
        expect(['Home', 'Errands', 'Reading'].map(state), form).toEqual(['one', 'one', 'one']);
      }
      expect(svg().querySelector('desc')?.textContent).toContain('3 lists in, 3 rows out. One row per list, with counts 0, 1 and 3.');
    } finally { done(); }
  });

  it('join: keeps the table as the drawing’s text alternative, rows in the order sqlite3 returned them', () => {
    const { host, press, done } = mount(<Maintenance.JoinCardinality />);
    const rows = () => [...host.querySelectorAll('details.fig-dm-alt tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent));
    try {
      expect(host.querySelector('details.fig-dm-alt > summary')?.textContent).toBe('The same rows as a table');
      expect(rows()).toEqual([['Errands', 'Post the form', 'One row'], ['Reading', 'Review notes', 'Duplicated a list'], ['Reading', 'Write summary', 'Duplicated a list'], ['Reading', 'Return books', 'Duplicated a list'], ['Home', 'missing', 'Lost a list']]);
      press('Left join');
      expect(rows().map((r) => r[1])).toEqual(['no task (NULL)', 'Post the form', 'Return books', 'Review notes', 'Write summary']);
      press('Count in a subquery');
      expect(rows()).toEqual([['Home', 'task_count 0', 'One row'], ['Errands', 'task_count 1', 'One row'], ['Reading', 'task_count 3', 'One row']]);
    } finally { done(); }
  });

  it('join: no line of the graded Maintenance solution is printed in any form', () => {
    const base = 'content/tasktrackr/phases/06-maintenance/solution';
    const files = ['api/repository/tasks.py', 'api/repository/comments.py', 'api/routes/comments.py', 'web/src/components/TaskRow.tsx'];
    const solutionLines = files.flatMap((f) => repoFile(`${base}/${f}`).split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l.length >= 16));
    expect(solutionLines.length).toBeGreaterThan(40);
    const { host, press, done } = mount(<Maintenance.JoinCardinality />);
    try {
      const printed: string[] = [JSON.stringify([Maintenance.JOIN_SQL, Maintenance.JOIN_RESULTS, Maintenance.LIST_TASKS])];
      for (const form of ['Inner join', 'Left join', 'Left join with GROUP BY count', 'Count in a subquery']) {
        press(form);
        printed.push(host.textContent ?? '', host.querySelector('svg desc')?.textContent ?? '');
      }
      const flat = printed.join('\n').replace(/\s+/g, ' ');
      // A count only: a failure never prints a solution line.
      expect(solutionLines.filter((line) => flat.includes(line)).length).toBe(0);
      expect(host.querySelector('svg.fig-dm-svg')?.textContent).not.toMatch(/comment/i);
    } finally { done(); }
  });

  it('review grader: only the concrete comment helps, and it names the lines', () => {
    const { host, press, done } = mount(<Maintenance.ReviewGrader />);
    try {
      press('Looks good to me.');
      expect(text(host, 'review-verdict')).toContain('Does not help');
      press('Lines 46 and 48: zero shows a bare 0, one says 1 comments');
      expect(text(host, 'review-verdict')).toContain('Helps');
      expect(host.querySelectorAll('[data-target="true"]')).toHaveLength(2);
    } finally { done(); }
  });

  it('review grader: the spoken summary ends each comment with one full stop', () => {
    const { host, press, done } = mount(<Maintenance.ReviewGrader />);
    const spoken = () => host.querySelector('.fig-toggles + p[aria-live="polite"]')?.textContent;
    try {
      expect(spoken()).toBe('Review comment: none chosen.');
      press('Looks good to me.');
      expect(spoken()).toBe('Review comment: Looks good to me.');
      press('Lines 46 and 48: zero shows a bare 0, one says 1 comments');
      expect(spoken()).toBe('Review comment: Lines 46 and 48: zero shows a bare 0, one says 1 comments.');
    } finally { done(); }
  });

  it('release note: the useful note has a part for each check, one filled, and completion needs the Maintenance pass', () => {
    const { host, press, done } = mount(<Maintenance.ReleaseNote />);
    try {
      expect(host.querySelectorAll('.fig-dm-checks li')).toHaveLength(4);
      expect([...host.querySelectorAll('.fig-dm-checks li')].every((li) => li.textContent?.includes('No'))).toBe(true);
      press('Useful note');
      expect([...host.querySelectorAll('.fig-dm-checks li')].every((li) => li.textContent?.includes('Has its part'))).toBe(true);
      expect([...host.querySelectorAll('[data-part]')].map((d) => d.getAttribute('data-part'))).toEqual(['Version', 'Summary', 'Changes', 'Rollback']);
      expect(host.querySelectorAll('[data-example="true"]')).toHaveLength(1);
      expect(text(host, 'completion-verdict')).toContain('Project complete');
      press('Maintenance not yet passed');
      expect(text(host, 'completion-verdict')).toContain('Not complete');
    } finally { done(); }
  });

  it('release note: prints no 2.1.0 release text a learner could paste into the Release tab', () => {
    expect(Maintenance.NOTE_PARTS.filter((p) => p.example)).toHaveLength(1);
    const printed = JSON.stringify([Maintenance.NOTE_VAGUE, Maintenance.NOTE_PARTS]);
    expect(printed).not.toMatch(/2\.1\.0|comment|2\.0\.0 again/i);
  });

  it('every drawing keeps its 13-unit text at about 11 px or more while it scrolls in its box, the 1000-unit plans at 860 px', () => {
    const all = [Deployment.LifecycleFigure, Deployment.PipelineRollback, Deployment.NetworkViewpoints, Deployment.IncidentTimeline, Maintenance.ImpactMap, Maintenance.JoinCardinality, Maintenance.ReviewGrader, Maintenance.ReleaseNote];
    const wide: string[] = [];
    all.forEach((Component) => {
      const { host, done } = mount(<Component />);
      try {
        for (const svg of host.querySelectorAll<SVGSVGElement>('svg[role="img"]')) {
          const units = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
          const min = parseFloat(svg.style.minWidth);
          expect(min, Component.name).toBeGreaterThan(0);
          expect((13 * min) / units, Component.name).toBeGreaterThanOrEqual(11);
          if (units >= 1000) { expect(min, Component.name).toBe(860); wide.push(Component.name); }
        }
      } finally { done(); }
    });
    expect(wide).toEqual(['NetworkViewpoints', 'ImpactMap', 'JoinCardinality']);
  });

  it('every figure wears the honesty tag and leaves "Where you use this" to the chapter header', () => {
    const all = [Deployment.LifecycleFigure, Deployment.PipelineRollback, Deployment.NetworkViewpoints, Deployment.IncidentTimeline, Maintenance.ImpactMap, Maintenance.JoinCardinality, Maintenance.ReviewGrader, Maintenance.ReleaseNote];
    all.forEach((Component) => {
      const { host, done } = mount(<Component />);
      try {
        expect(host.querySelector('.fig-model-tag')?.textContent).toMatch(/teaching model/i);
        expect(host.textContent).not.toContain('Where you use this');
      } finally { done(); }
    });
  });

  it('keeps the chapters’ pinned facts and no pipe or middle dot in any exported words', () => {
    expect(DEPLOYMENT_LESSON.chapters[1].body).toContain('It does not run GitHub Actions, build Docker images or call a running proxy.');
    expect(MAINTENANCE_LESSON.chapters[3].body).toContain('Completion needs a recorded Pass in every phase of the project.');
    expect(MAINTENANCE_LESSON.chapters[2].body).toContain('one says 1 comment, four say 4 comments');
    expect(MAINTENANCE_LESSON.chapters[3].question).toBe('What completes the project?');
    const words = JSON.stringify([Deployment, Maintenance, DEPLOYMENT_LESSON, MAINTENANCE_LESSON, PHASE_STUDY.deployment, PHASE_STUDY.maintenance]);
    expect(words).not.toMatch(/[|·—]/);
  });
});
