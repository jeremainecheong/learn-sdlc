// @vitest-environment jsdom
/**
 * The Implementation and Testing guides' pinned facts. When a figure or a sentence is rebuilt, update the quoted words and keep
 * each fact; never weaken an assertion.
 */
import { repoPath } from './support/paths';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { closureText } from './support/source-text';
import { StudyWalkthrough } from '@/components/learn/StudyWalkthrough';
import { PHASE_STUDY } from '@/components/learn/study';
import { TESTING_FIGURES } from '@/components/learn/figures/testing';

it('lets learners reveal authored reasoning and resets the disclosure for a different chapter', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    const first = PHASE_STUDY.testing.chapters[1];
    act(() => root.render(<StudyWalkthrough key="defaults" chapter={first} />));
    let disclosure = host.querySelector('details')!;
    expect(disclosure.open).toBe(false);
    expect(host.textContent).toContain(first.practice);
    act(() => disclosure.querySelector('summary')!.click());
    expect(disclosure.open).toBe(true);
    expect(disclosure.textContent).toContain('It tests that an explicit supported priority is retained.');
    act(() => root.render(<StudyWalkthrough key="mutations" chapter={PHASE_STUDY.testing.chapters[3]} />));
    disclosure = host.querySelector('details')!;
    expect(disclosure.open).toBe(false);
    act(() => disclosure.querySelector('summary')!.click());
    expect(disclosure.textContent).toContain('First diagnose the healthy failure');
    expect(disclosure.textContent).not.toContain(first.reasoning);
    expect(host.querySelector('form')).toBeNull();
  } finally { act(() => root.unmount()); host.remove(); }
});

it('keeps later-read and restart evidence separate in the worked example and diagram', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    // The chapter's evidence table moved into the rebuilt diagram's figure.
    const ReadRestart = TESTING_FIGURES['testing-response-read-restart'].component;
    act(() => root.render(<><StudyWalkthrough chapter={PHASE_STUDY.testing.chapters[1]} /><ReadRestart /></>));
    expect(host.querySelector('caption')?.textContent).toContain('not every claim');
    expect(host.querySelector('svg desc')?.textContent).toContain('separate restart and read');
    expect(host.querySelector('svg desc')?.textContent).toContain('not recorded executions');
    expect(host.querySelectorAll('tbody th[scope="row"]')).toHaveLength(3);
  } finally { act(() => root.unmount()); }
});

/* ------------------------------------------------------------------------
 * The Implementation and Testing figures and their words (the
 * chapters' "Where you use this" words are pinned in test/guide-where-chips.test.ts).
 * ---------------------------------------------------------------------- */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe } from 'vitest';
import type { ReactElement } from 'react';
import { DIMENSION_LABEL, DIMENSION_ORDER } from '@/components/workspace/mentor/ExplanationFindings';
import { DatabaseSync } from 'node:sqlite';
import { IMPLEMENTATION_FIGURES, CHECKS, CHOOSE_ARROW, CLAIMS, FILE_LANES, GAPS, LISTS_IN_DATABASE, NAMES, PROPOSE_STEPS, SCENARIOS, VISIBLE_TESTS, arrowPath, buildLookup, ledgerTally, type TypedName } from '@/components/learn/figures/implementation';
import { BOUNDARY_CASES, ISOLATION_TESTS, KILLS, LEVELS, MUTANTS, NOTE_X, OBSERVATIONS, PYRAMID, REPORTING_DAY, START_TESTS, TESTS, bandWidthAt, isolationRun, overdueUnder, tasks } from '@/components/learn/figures/testing';
import * as IMPLEMENTATION_MODULE from '@/components/learn/figures/implementation';
import * as TESTING_MODULE from '@/components/learn/figures/testing';
import { IMPLEMENTATION_LESSON } from '@/components/learn/content/implementation';
import { TESTING_LESSON } from '@/components/learn/content/testing';
import { typeInto } from './support/dom';

const PHASES = repoPath('content/tasktrackr/phases');
const mount = (Component: () => ReactElement | null) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Component />));
  const press = (name: string) => act(() => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === name)!.click());
  return { host, press, done: () => { act(() => root.unmount()); host.remove(); } };
};
const fig = (map: Record<string, { component: unknown }>, id: string) => map[id].component as () => ReactElement;

describe('the Implementation figures', () => {
  it('registers one or more figures on every chapter', () => {
    const chapters = Object.values(IMPLEMENTATION_FIGURES).map((f) => f.chapter).sort();
    expect([...new Set(chapters)]).toEqual([1, 2, 3, 4]);
  });

  it('maps the four editable files and five gaps the phase declares', () => {
    const phase = JSON.parse(readFileSync(resolve(PHASES, '03-implementation/phase.json'), 'utf8'));
    expect([...new Set(GAPS.map((g) => g.file))].sort()).toEqual([...phase.checks.editableTargets].sort());
    for (const gap of GAPS) expect(readFileSync(resolve(PHASES, '03-implementation/files', gap.file), 'utf8')).toMatch(new RegExp(`(def|function) ${gap.value}\\(`));
    const { host, done } = mount(fig(IMPLEMENTATION_FIGURES, 'implementation-file-map'));
    expect(host.querySelector('[data-testid="file-map-panel"]')!.textContent).toContain('reopen_task');
    act(() => host.querySelector<HTMLButtonElement>('button[data-gap="useTasks"]')!.click());
    expect(host.querySelector('[data-testid="file-map-panel"]')!.textContent).toContain('useLists');
    done();
  });

  it('draws the file map as two lanes of files, each gap a hole with an arrow from what to read first', () => {
    const { host, done } = mount(fig(IMPLEMENTATION_FIGURES, 'implementation-file-map'));
    const lanes = Array.from(host.querySelectorAll('section.fig-c-lane'));
    expect(lanes.map((lane) => lane.getAttribute('aria-label'))).toEqual(['Python API', 'TypeScript front end']);
    // Each gap is a hole in its own file's box, in its own lane.
    const holesIn = (lane: Element) => Array.from(lane.querySelectorAll('button.fig-c-hole')).map((b) => b.getAttribute('data-gap'));
    expect(holesIn(lanes[0])).toEqual(['list_tasks', 'overdue_tasks', 'complete_task']);
    expect(holesIn(lanes[1])).toEqual(['isOverdue', 'useTasks']);
    for (const g of GAPS) {
      const box = host.querySelector(`button[data-gap="${g.value}"]`)!.closest('.fig-c-file')!;
      expect(box.querySelector('.fig-c-file-head code')!.textContent).toBe(g.file);
      expect(box.closest('section')!.getAttribute('aria-label')).toBe(g.side);
    }
    // Exactly one finished thing to read first per gap, with its arrow; the chosen one is marked in words.
    for (const g of GAPS) {
      expect(host.querySelectorAll(`[data-read-for="${g.value}"]`), g.value).toHaveLength(1);
      act(() => host.querySelector<HTMLButtonElement>(`button[data-gap="${g.value}"]`)!.click());
      expect(host.querySelector(`button[data-gap="${g.value}"]`)!.getAttribute('aria-pressed')).toBe('true');
      expect(host.querySelectorAll('button.fig-c-hole[aria-pressed="true"]')).toHaveLength(1);
      const read = host.querySelector(`[data-read-for="${g.value}"]`)!;
      expect(read.getAttribute('data-on')).toBe('true');
      expect(read.textContent).toContain('Read this first');
      expect(host.querySelectorAll('.fig-c-given[data-on="true"]')).toHaveLength(1);
      expect(host.querySelectorAll('[data-on="true"]:is(.fig-c-link, .fig-c-cross)')).toHaveLength(1);
      expect(host.querySelector('[data-testid="file-map-panel"]')!.textContent).toContain(g.read);
    }
    // The arrow keys move between the five holes.
    const first = host.querySelector<HTMLButtonElement>('button[data-gap="list_tasks"]')!;
    first.focus();
    act(() => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(document.activeElement).toBe(host.querySelector('button[data-gap="overdue_tasks"]'));
    act(() => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    expect(document.activeElement).toBe(host.querySelector('button[data-gap="useTasks"]'));
    const drawn = host.querySelector('[data-testid="file-map"]')!.textContent!;
    done();
    // Every name drawn is a real one, in the file's own order (supplied files or the room's locked ones).
    const source = (file: string) => {
      const editable = resolve(PHASES, '03-implementation/files', file);
      try { return readFileSync(editable, 'utf8'); } catch { return readFileSync(resolve(PHASES, '03-implementation/readonly', file), 'utf8'); }
    };
    const at = (text: string, name: string) => {
      const found = new RegExp(`(?:def|function) ${name}\\(|^${name} = `, 'm').exec(text);
      expect(found, name).not.toBeNull();
      return found!.index;
    };
    for (const lane of FILE_LANES) for (const file of lane.files) {
      const text = source(file.file);
      const places = file.rows.filter((r) => r.kind !== 'read').map((r) => at(text, r.kind === 'gap' ? r.gap : r.name.match(/[A-Za-z]+_[A-Za-z_]+|[a-z]+[A-Z][A-Za-z]*/)![0]));
      expect(places, file.file).toEqual([...places].sort((a, b) => a - b));
      for (const r of file.rows) if (r.kind === 'given') for (const name of r.name.match(/[A-Za-z]+_[A-Za-z_]+|[a-z]+[A-Z][A-Za-z]*/g)!) at(text, name);
    }
    // Grading integrity: the map shows where the gaps are, never a line of a gap's answer.
    for (const g of GAPS) {
      const stub = readFileSync(resolve(PHASES, '03-implementation/files', g.file), 'utf8');
      const solution = readFileSync(resolve(PHASES, '03-implementation/solution', g.file), 'utf8');
      const answer = solution.split('\n').map((line) => line.trim()).filter((line) => line.length > 6 && !stub.includes(line));
      expect(answer.length, g.file).toBeGreaterThan(0);
      for (const line of answer) expect(drawn, line).not.toContain(line);
    }
    expect(drawn).not.toMatch(/WHERE|SELECT \*|<|useEffect|fetch|\.then|return /);
  });

  it('says who calls whom on the file map exactly as the supplied files do, in the drawing and the panel alike', () => {
    const files = ['files/web/src/lib/overdue.ts', 'readonly/web/src/components/TaskRow.tsx'].map((file) => readFileSync(resolve(PHASES, '03-implementation', file), 'utf8'));
    // A function's body: from its declaration to the next top-level declaration.
    const body = (name: string) => {
      for (const text of files) {
        const start = text.search(new RegExp(`function ${name}\\(`));
        if (start < 0) continue;
        const rest = text.slice(start + 1);
        const end = rest.search(/\n(?:export |function |const [A-Z_]+ =)/);
        return end < 0 ? rest : rest.slice(0, end);
      }
      throw new Error(`no function ${name}`);
    };
    const calls = (caller: string, callee: string) => new RegExp(`\\b${callee}\\(`).test(body(caller));
    // "X calls Y", where "it" is the gap the row sits under.
    const claims = (words: string, it: string) => [...words.matchAll(/(\w+)(?: below it)? calls (it|\w+)/g)].map((m) => [m[1], m[2] === 'it' ? it : m[2]] as const);
    let checked = 0;
    for (const lane of FILE_LANES) for (const file of lane.files) {
      let above = '';
      for (const r of file.rows) {
        if (r.kind === 'gap') above = r.gap;
        if (r.kind !== 'given' || !/\bcall/i.test(r.note)) continue;
        const said = claims(r.note, above);
        // Every function the row names is the subject of its own true claim: no loose "they call it".
        const named = r.name.match(/[A-Za-z]+_[A-Za-z_]+|[a-z]+[A-Z][A-Za-z]*/g)!;
        expect(said.map(([caller]) => caller).sort(), r.note).toEqual([...named].sort());
        for (const [caller, callee] of said) { expect(calls(caller, callee), `${caller} calls ${callee}`).toBe(true); checked += 1; }
      }
    }
    expect(checked).toBe(2);
    // The panel's sentence for the same gap makes the same claims, and they hold too.
    const panel = claims(GAPS.find((g) => g.value === 'isOverdue')!.helper, 'isOverdue');
    expect(panel).toEqual([['daysLate', 'isOverdue'], ['byMostOverdue', 'daysLate'], ['TaskRow', 'isOverdue']]);
    for (const [caller, callee] of panel) expect(calls(caller, callee), `${caller} calls ${callee}`).toBe(true);
    // And the loose form is wrong: byMostOverdue never calls isOverdue itself.
    expect(calls('byMostOverdue', 'isOverdue')).toBe(false);
  });

  it('teaches binding on an illustrative lookup by name, every result of it run again in SQLite', () => {
    // The lookup is shaped like the supplied get_list, on the real LIST_SELECT.
    const repository = readFileSync(resolve(PHASES, '03-implementation/readonly/api/repository/lists.py'), 'utf8');
    expect(repository).toContain('LIST_SELECT + " WHERE l.id = ?", (list_id,)');
    const LIST_SELECT = /LIST_SELECT = """([\s\S]*?)"""/.exec(repository)![1];
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(resolve(PHASES, '03-implementation/readonly/api/schema.sql'), 'utf8'));
    for (const name of LISTS_IN_DATABASE) db.prepare('INSERT INTO lists (name, created_at) VALUES (?, ?)').run(name, '2026-03-01');
    // Tasks in two of the three lists, so LIST_SELECT's counts have rows to count.
    db.exec("INSERT INTO tasks (list_id, title, status, created_at) VALUES (1, 'Pay the rent', 'open', 'x'), (1, 'Water the plants', 'done', 'x'), (2, 'Write the report', 'open', 'x')");
    const run = (name: TypedName, binding: 'bound' | 'pasted') => {
      const { where } = buildLookup(name, binding);
      const statement = `${LIST_SELECT} ${where.sql}${where.injected ?? ''}`;
      try {
        const found = (binding === 'bound' ? db.prepare(statement).all(name) : db.prepare(statement).all()) as { name: string }[];
        return found.map((row) => row.name).sort();
      } catch { return 'error'; }
    };
    for (const { value } of NAMES) for (const binding of ['bound', 'pasted'] as const) {
      const said = buildLookup(value, binding).returns;
      expect(run(value, binding), `${value} ${binding}`).toEqual(said === 'error' ? 'error' : [...said].sort());
    }
    // What each verdict says is what SQLite did.
    expect(run("x' OR 1=1 --", 'pasted')).toEqual([...LISTS_IN_DATABASE].sort());
    expect(run("x' OR 1=1 --", 'bound')).toEqual([]);
    expect(run("Sam's reading", 'pasted')).toBe('error');
    expect(run("Sam's reading", 'bound')).toEqual(["Sam's reading"]);
    expect(buildLookup("x' OR 1=1 --", 'pasted').verdict).toMatch(/^Unsafe: .*every list/);
    expect(buildLookup("Sam's reading", 'pasted').verdict).toMatch(/^Broken: .*syntax error/);
    expect(buildLookup('Home', 'pasted').verdict).toMatch(/^Works this time: it finds Home/);
    for (const { value } of NAMES) expect(buildLookup(value, 'bound').verdict).toMatch(/^Safe: /);
    expect(buildLookup("Sam's reading", 'bound').values).toBe(`("Sam's reading",)`);
    // Nothing of a graded gap: no tasks columns, no LIKE, and not a line of the solution.
    const solution = readFileSync(resolve(PHASES, '03-implementation/solution/api/repository/tasks.py'), 'utf8');
    for (const { value } of NAMES) for (const binding of ['bound', 'pasted'] as const) {
      const { where } = buildLookup(value, binding);
      expect(where.sql).not.toMatch(/\bt\.|LIKE|status|title/);
      expect(solution).not.toContain(where.sql);
    }
    const { host, press, done } = mount(fig(IMPLEMENTATION_FIGURES, 'implementation-query-builder'));
    expect(host.querySelector('[data-testid="query-sql"]')!.textContent).toBe('LIST_SELECT\nWHERE l.name = ?');
    expect(host.querySelector('[data-testid="query-values"]')!.textContent).toBe("('Home',)");
    expect(host.querySelector('[data-testid="query-live"]')!.textContent).toContain('Safe');
    press("x' OR 1=1 --");
    press('Pasted into the SQL');
    expect(host.querySelector('[data-testid="query-sql"] mark[data-kind="injected"]')!.textContent).toBe("' OR 1=1 --'");
    expect(host.querySelector('[data-testid="query-live"]')!.textContent).toContain('Unsafe');
    expect(host.querySelector('[data-testid="query-returns"]')!.textContent).toContain("Home, Work, Sam's reading");
    press("Sam's reading");
    expect(host.querySelector('[data-testid="query-returns"]')!.textContent).toContain('SQLite refuses the statement');
    expect(host.querySelector('.fig-model-tag')?.textContent).toBe('Illustrative lookup by name on the supplied lists table. TaskTrackr looks a list up by its id, and no gap uses this query.');
    done();
    db.close();
  });

  it('draws the request states, states the cleanup fact and plays the late answer', () => {
    const { host, press, done } = mount(fig(IMPLEMENTATION_FIGURES, 'implementation-request-states'));
    expect(host.textContent).toContain('Cleanup makes the former request context inactive so its later callbacks cannot overwrite the current state.');
    expect(host.querySelector('[data-testid="race-lanes"]')).toBeNull();
    press('The request fails');
    expect(host.querySelector('[data-testid="states-live"]')!.textContent).toContain('Not “no tasks”');
    expect(host.querySelector('svg desc')!.textContent).toContain('Now showing: The request fails');
    press('Choose list B before A answers');
    expect(host.querySelector('[data-testid="race-lanes"]')!.textContent).toMatch(/Applied[\s\S]*Dropped/);
    expect(SCENARIOS).toHaveLength(4);
    done();
  });

  it('draws each arrowhead with its own line’s stroke, and "choose" above the line, clear of the head', () => {
    const { host, press, done } = mount(fig(IMPLEMENTATION_FIGURES, 'implementation-request-states'));
    // No marker: a marker keeps its own grey fill on a highlighted line.
    expect(host.querySelector('marker')).toBeNull();
    expect(host.querySelector('[marker-end], [markerEnd]')).toBeNull();
    const arrows = Array.from(host.querySelectorAll('path.fig-c-svg-arrow'));
    expect(arrows).toHaveLength(4);
    // Line and head are one path: two subpaths, the head ending where the line does.
    for (const arrow of arrows) {
      const d = arrow.getAttribute('d')!;
      expect(d.match(/M/g)).toHaveLength(2);
      const [line, head] = d.split(/(?=M)/);
      const end = line.trim().split(/[ L]+/).slice(-2).join(' ');
      expect(head).toContain(`L${end} `);
    }
    press('The request fails');
    expect(host.querySelector('path[data-edge="failed"]')!.getAttribute('data-on')).toBe('true');
    expect(host.querySelector('path[data-edge="rows"]')!.getAttribute('data-on')).toBe('false');
    // The label sits at least 8 units above the line and ends well before the head starts.
    const label = Array.from(host.querySelectorAll('text')).find((t) => t.textContent === 'choose')!;
    expect(Number(label.getAttribute('y'))).toBe(CHOOSE_ARROW.label.y);
    expect(CHOOSE_ARROW.y - CHOOSE_ARROW.label.y).toBeGreaterThanOrEqual(10);
    const halfWidth = ('choose'.length * 0.6 * 16) / 2;
    expect(CHOOSE_ARROW.label.x + halfWidth).toBeLessThan(CHOOSE_ARROW.x2 - 12);
    expect(CHOOSE_ARROW.label.x - halfWidth).toBeGreaterThan(CHOOSE_ARROW.x1);
    expect(arrowPath(0, 0, 100, 0)).toBe('M0 0 L100 0 M91.2 -4.8 L100 0 L91.2 4.8');
    done();
  });

  it('keeps long names inside the figures at a phone’s width', () => {
    // Every Implementation and Testing figure carries the class the wrap rule hangs on.
    const ids = [...Object.keys(IMPLEMENTATION_FIGURES), ...Object.keys(TESTING_FIGURES)];
    for (const id of ids) {
      const { host, done } = mount(fig(id.startsWith('testing') ? TESTING_FIGURES : IMPLEMENTATION_FIGURES, id));
      expect(host.querySelector('figure.fig.fig-c'), id).not.toBeNull();
      done();
    }
    const css = readFileSync(resolve(__dirname, '../components/learn/figures/implementation-testing.css'), 'utf8');
    expect(css).toMatch(/\.fig-c \.fig-live,\s*\.fig-c :is\(p, dd, li\) code \{ overflow-wrap: anywhere; \}/);
    // The ledger's long test name is code inside the live line, so it may break.
    const { host, done } = mount(fig(IMPLEMENTATION_FIGURES, 'implementation-evidence-ledger'));
    expect(host.querySelector('[data-testid="ledger-live"] code')!.textContent).toBe('test_completing_a_task_nobody_has_is_a_404');
    done();
    // The reader draws a chapter's words as plain text: no word there is longer than a phone's line can hold.
    // (Worked examples are code blocks that wrap anywhere; sources are links by title.)
    for (const study of [PHASE_STUDY.implementation, PHASE_STUDY.testing]) for (const chapter of study.chapters) {
      const { example: _example, ...words } = chapter;
      for (const word of JSON.stringify(words).replace(/\\n/g, ' ').split(/[\s"]+/)) expect(word.length, word).toBeLessThanOrEqual(30);
    }
    for (const lesson of [IMPLEMENTATION_LESSON, TESTING_LESSON]) for (const chapter of lesson.chapters) {
      for (const word of JSON.stringify(chapter).replace(/\\n/g, ' ').split(/[\s"]+/)) expect(word.length, word).toBeLessThanOrEqual(30);
    }
  });

  it('backs only the claims a visible test checks, and names useTasks as unobserved', () => {
    const api = readFileSync(resolve(PHASES, '03-implementation/readonly/tests/test_tasks_api.py'), 'utf8');
    const web = readFileSync(resolve(PHASES, '03-implementation/readonly/web/src/lib/overdue.test.ts'), 'utf8');
    for (const t of VISIBLE_TESTS) expect(api.includes(`def ${t.name}(`) || web.includes(`test('${t.name}'`)).toBe(true);
    expect(VISIBLE_TESTS).toHaveLength(6);
    for (const c of CLAIMS) if (c.by) expect(VISIBLE_TESTS.map((t) => t.name)).toContain(c.by);
    const { host, press, done } = mount(fig(IMPLEMENTATION_FIGURES, 'implementation-evidence-ledger'));
    press('useTasks shows an error, not an empty list');
    expect(host.querySelector('[data-testid="ledger-live"]')!.textContent).toContain('Not observed');
    done();
  });

  it('walks propose, explain, apply in the room’s own words', () => {
    expect([...CHECKS]).toEqual(DIMENSION_ORDER.map((d) => DIMENSION_LABEL[d]));
    const panel = closureText('AgenticPanel');
    for (const words of ['Understanding accepted', 'Explain this proposal', 'Apply this reviewed proposal', 'it does not run, submit or pass the phase']) {
      expect(panel).toContain(words);
      expect((JSON.stringify(PROPOSE_STEPS.map((s) => s.text)) + 'Understanding accepted').toLowerCase()).toContain(words.toLowerCase());
    }
    const { host, press, done } = mount(fig(IMPLEMENTATION_FIGURES, 'implementation-propose-explain-apply'));
    expect(host.textContent).toContain('Step 1 of 5');
    const seen = [host.textContent];
    press('Next'); seen.push(host.textContent);
    press('Next'); seen.push(host.textContent);
    expect(host.textContent).toContain('Conflicts with the proposal or a record');
    press('Next'); seen.push(host.textContent);
    expect(host.textContent).toContain('Understanding accepted');
    expect(host.textContent).toContain('return deleteJson(`tasks/${taskId}`);');
    press('Next'); seen.push(host.textContent);
    done();
    // The walk proposes an illustrative helper, never a gap's body:
    // no gap's name or graded line is drawn, and deleteTask exists nowhere in the phase.
    const drawn = seen.join('\n');
    for (const gap of GAPS) expect(drawn).not.toContain(gap.value === 'useTasks' ? 'useTasks(' : gap.value);
    expect(drawn).not.toMatch(/due_date|today/);
    const files = ['files/web/src/hooks/useTasks.ts', 'solution/web/src/hooks/useTasks.ts', 'readonly/web/src/pages/TasksPage.tsx'];
    for (const file of files) expect(readFileSync(resolve(PHASES, '03-implementation', file), 'utf8')).not.toContain('deleteTask');
    expect(readFileSync(resolve(PHASES, '03-implementation/readonly/web/src/api/client.ts'), 'utf8')).toContain('export function deleteJson(path: string): Promise<void>');
    const contract = JSON.parse(readFileSync(resolve(PHASES, '03-implementation/readonly/shared/contract/api.json'), 'utf8'));
    expect(contract.operations.find((op: { id: string }) => op.id === 'deleteTask')).toMatchObject({ method: 'DELETE', path: '/api/tasks/{id}', success: { status: 204 } });
    expect(JSON.parse(readFileSync(resolve(PHASES, '03-implementation/phase.json'), 'utf8')).checks.editableTargets).toContain('web/src/hooks/useTasks.ts');
  });
});

describe('the Testing figures', () => {
  it('rebuilds the pyramid with a tool and a blind spot per level, widths worded as checks', () => {
    expect(LEVELS.map((l) => l.width)).toEqual(['Fewer checks', 'Some checks', 'More checks']);
    const { host, press, done } = mount(fig(TESTING_FIGURES, 'testing-pyramid'));
    expect(host.querySelector('.testing-pyramid')).not.toBeNull();
    expect(host.querySelector('[data-testid="pyramid-panel"]')!.textContent).toContain('isOverdue');
    press('Integration');
    expect(host.querySelector('[data-testid="pyramid-panel"]')!.textContent).toContain('opens no socket');
    done();
  });

  it('keeps every word of the pyramid inside its own level, in both drawings and every state', () => {
    // Widths are estimated for text up to 16 px (about body size): bold 0.62 em a letter, regular 0.56 em.
    const SIZE = 16;
    const wide = (text: string, strong?: boolean) => text.length * (strong ? 0.62 : 0.56) * SIZE;
    for (const [name, plan] of Object.entries(PYRAMID)) {
      for (const level of LEVELS) {
        const band = plan.bands[level.value];
        for (const line of band.lines) {
          const top = line.y - 0.75 * SIZE;
          expect(top, `${name} ${line.text}`).toBeGreaterThanOrEqual(band.top);
          expect(line.y + 0.25 * SIZE, `${name} ${line.text}`).toBeLessThanOrEqual(band.bottom);
          // The shape is narrowest at the line's top: the words and 6 units each side fit there.
          expect(wide(line.text, line.strong) + 12, `${name} ${line.text}`).toBeLessThanOrEqual(bandWidthAt(plan, top));
        }
      }
      // The base fits the drawing.
      const base = bandWidthAt(plan, plan.bands.unit.bottom);
      expect(plan.apexX - base / 2).toBeGreaterThanOrEqual(0);
      expect(plan.apexX + base / 2).toBeLessThanOrEqual(name === 'wide' ? NOTE_X - 20 : plan.width);
      for (const notes of Object.values(plan.notes ?? {})) notes.forEach((note, i) => expect(NOTE_X + wide(note, i === 0), note).toBeLessThanOrEqual(plan.width));
    }
    // The whole label, in both drawings, never one line wider than the apex.
    expect(PYRAMID.wide.bands.e2e.lines.map((l) => l.text).join(' ')).toBe('Browser journey');
    expect(PYRAMID.compact.bands.e2e.lines.map((l) => l.text).join(' ')).toBe('Browser journey');
    const { host, press, done } = mount(fig(TESTING_FIGURES, 'testing-pyramid'));
    const svgs = host.querySelectorAll('svg.fig-c-pyramid');
    expect(svgs).toHaveLength(2);
    for (const level of LEVELS) {
      press(level.label);
      for (const svg of Array.from(svgs)) {
        expect(svg.querySelectorAll('.fig-c-pyramid-layer[data-on="true"]')).toHaveLength(1);
        expect(svg.querySelector(`[data-level="${level.value}"] .fig-c-pyramid-layer`)!.getAttribute('data-on')).toBe('true');
        expect(svg.querySelector('desc')!.textContent).toContain(`Chosen: ${level.label}.`);
        // No per-figure font: the page's own font and size come from figures.css.
        for (const text of Array.from(svg.querySelectorAll('text'))) {
          expect(text.getAttribute('font-size')).toBeNull();
          expect(text.getAttribute('style')).toBeNull();
        }
      }
      expect(host.querySelector('.fig-c-panel-head')!.textContent).toBe(`${level.label}${level.width}`);
    }
    // The top level is dashed and says why; the wide drawing notes each level's checks and reach.
    expect(host.querySelector('[data-level="e2e"] .fig-c-pyramid-layer')!.getAttribute('data-room')).toBe('none');
    expect(svgs[0].textContent).toContain('No browser in the Testing room');
    for (const level of LEVELS) expect(svgs[0].textContent).toContain(level.width);
    expect(host.textContent).toContain('The top level is dashed because the Testing room has no real browser.');
    done();
    const phase = readFileSync(resolve(PHASES, '04-testing/phase.json'), 'utf8');
    expect(phase).toContain('"harness": "pytest"');
    expect(phase).not.toMatch(/playwright|cypress|selenium/i);
  });

  it('counts tasks in words, "1 task" and "2 tasks"', () => {
    expect([tasks(1), tasks(2), tasks(3)]).toEqual(['1 task', '2 tasks', '3 tasks']);
    const { host, press, done } = mount(fig(TESTING_FIGURES, 'testing-fixture-isolation'));
    for (const order of ['A then B', 'B then A']) for (const database of ['Shared by both tests', 'Fresh for each test']) {
      press(order); press(database);
      expect(host.querySelector('table')!.textContent).not.toMatch(/\b1 tasks\b/);
    }
    press('A then B');
    expect(host.querySelector('tr[data-test="A"]')!.textContent).toContain('1 task1 task');
    done();
  });

  it('fails whichever test runs second on a shared database, and neither on fresh ones', () => {
    expect(isolationRun('shared', 'ab').map((r) => r.passed)).toEqual([true, false]);
    expect(isolationRun('shared', 'ba').map((r) => r.passed)).toEqual([true, false]);
    expect(isolationRun('fresh', 'ba').every((r) => r.passed)).toBe(true);
    expect(ISOLATION_TESTS).toHaveLength(2);
    const { host, press, done } = mount(fig(TESTING_FIGURES, 'testing-fixture-isolation'));
    expect(host.querySelector('[data-testid="isolation-live"]')!.textContent).toContain('Test B failed');
    press('B then A');
    expect(host.querySelector('[data-testid="isolation-live"]')!.textContent).toContain('Test A failed');
    press('Fresh for each test');
    expect(host.querySelector('[data-testid="isolation-live"]')!.textContent).toContain('Both tests passed');
    done();
  });

  it('marks how far each observation reaches', () => {
    const { host, press, done } = mount(fig(TESTING_FIGURES, 'testing-response-read-restart'));
    expect(host.querySelectorAll('rect[data-on="true"]')).toHaveLength(1);
    press('Restart and read');
    expect(host.querySelectorAll('rect[data-on="true"]')).toHaveLength(3);
    expect(host.querySelector('[data-testid="read-live"]')!.textContent).toContain('Every client and every failure mode');
    expect(OBSERVATIONS).toHaveLength(3);
    done();
  });

  it('disagrees on the reporting day only, on the visible equal-day test’s date', () => {
    const web = readFileSync(resolve(PHASES, '03-implementation/readonly/web/src/lib/overdue.test.ts'), 'utf8');
    expect(web).toContain(`'${REPORTING_DAY}'), false`);
    expect(BOUNDARY_CASES.map((c) => overdueUnder('lt', c) !== overdueUnder('le', c))).toEqual([false, true, false, false, false]);
    const { host, done } = mount(fig(TESTING_FIGURES, 'testing-boundary-slider'));
    expect(host.querySelectorAll('.fig-c-disagree')).toHaveLength(1);
    expect(host.querySelector('tr[data-case="1"]')!.textContent).toContain('They disagree here');
    const slider = host.querySelector('input[type="range"]') as HTMLInputElement;
    act(() => {
      typeInto(slider, '1');
    });
    expect(slider.getAttribute('aria-valuetext')).toBe('Due 2026-03-14, the reporting day');
    expect(host.querySelector('[data-testid="boundary-live"]')!.textContent).toContain('due < today: Not overdue. due <= today: Overdue. They disagree here');
    done();
  });
});

describe('the two guides’ words', () => {
  it('states the model passage’s facts on Testing chapter 4 and keeps every figure’s data free of the lint’s separators', () => {
    const body = TESTING_LESSON.chapters[3].body;
    expect(body).toContain('six in the API and two in the browser code');
    expect(body).toContain('Run your suite against the healthy code first');
    expect(IMPLEMENTATION_LESSON.chapters[0].body).toContain('three in the Python API, two in the TypeScript front end');
    // Every exported piece of words in the two figure files, the figures' data (FILE_LANES, PYRAMID, ...) with it.
    const guarded = { GAPS, FILE_LANES, LISTS_IN_DATABASE, NAMES, SCENARIOS, CHOOSE_ARROW, VISIBLE_TESTS, CLAIMS, CHECKS, PROPOSE_STEPS, LEVELS, PYRAMID, NOTE_X, ISOLATION_TESTS, OBSERVATIONS, REPORTING_DAY, BOUNDARY_CASES, MUTANTS, TESTS, KILLS, START_TESTS };
    expect(JSON.stringify(Object.values(guarded))).not.toMatch(/[·|]/);
    // A new exported constant in either file joins the list above, or this fails.
    const data = (module: Record<string, unknown>) => Object.keys(module).filter((name) => typeof module[name] !== 'function' && !name.endsWith('_FIGURES'));
    expect([...data(IMPLEMENTATION_MODULE), ...data(TESTING_MODULE)].sort()).toEqual(Object.keys(guarded).sort());
  });

  it('names none of the Testing room’s planted bugs, and says when the room shows them', () => {
    const shelf = resolve(PHASES, '04-testing/mutants');
    const words = JSON.stringify([TESTING_LESSON, PHASE_STUDY.testing]);
    for (const name of readdirSync(shelf)) expect(words, name).not.toContain(name);
    const body = TESTING_LESSON.chapters[3].body;
    expect(body).not.toContain('as it is in the room');
    expect(body).toContain('shows them only after your first submission');
    expect(body).toContain('only once your suite passes on the healthy code');
    // The room's own words for both facts.
    expect(closureText('Matrix')).toContain('Submit, and the grid lands here.');
    expect(closureText('Matrix')).toContain('Your suite has to pass on the reference implementation before the planted bugs run.');
    // The two planted bugs the words name are the figure's own.
    for (const named of ['duplicate_name_not_refused', 'task_count_by_id']) expect(MUTANTS.map((m) => m.name)).toContain(named);
  });

  it('works Implementation chapter 4 on a visible test the phase has', () => {
    const chapter = PHASE_STUDY.implementation.chapters[3];
    const words = JSON.stringify(chapter);
    const cited = [...new Set(words.match(/test_[a-z_0-9]+/g) ?? [])];
    expect(cited).toEqual(['test_completing_a_task_nobody_has_is_a_404']);
    for (const name of cited) expect(VISIBLE_TESTS.map((t) => t.name)).toContain(name);
    const api = readFileSync(resolve(PHASES, '03-implementation/readonly/tests/test_tasks_api.py'), 'utf8');
    expect(api).toContain('client.post("/api/tasks/404/complete")');
    expect(api).toContain('assert response.status_code == 404');
    expect(api).toContain('assert response.get_json()["error"]["code"] == "task_not_found"');
    expect(words).toContain('POST /api/tasks/404/complete');
    expect(words).not.toMatch(/new-list|list tests?\b|status 201/);
    // errors.py answers the framework's own 404 as not_found, as the steps say.
    expect(readFileSync(resolve(PHASES, '03-implementation/readonly/api/errors.py'), 'utf8')).toContain('fail("not_found"');
  });

  it('spells the two guides in UK English and names chapter 1 "Read the neighbourhood"', () => {
    expect(IMPLEMENTATION_LESSON.chapters[0].title).toBe('Read the neighbourhood');
    const words = JSON.stringify([IMPLEMENTATION_LESSON, TESTING_LESSON, PHASE_STUDY.implementation, PHASE_STUDY.testing, GAPS, CLAIMS, SCENARIOS, LEVELS, OBSERVATIONS, MUTANTS, TESTS, PROPOSE_STEPS.map((step) => [step.title, step.text])]);
    expect(words).not.toMatch(/behavior|neighbor(?!u)|organiz/i);
  });
});

/* ------------------------------------------------------------------------
 * How the Implementation and Testing figures are drawn.
 * ---------------------------------------------------------------------- */
/** Every drawn text node that holds a pair the page font may join, and is not
 * inside code (a screen reader's summary line is not drawn). */
const LIGATURE = /--|->|<-|<=|>=|!=|=>|==/;
const outsideCode = (root: Element) => {
  const found: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (LIGATURE.test(node.textContent ?? '') && !node.parentElement?.closest('code, pre, title, desc, .sr-only')) found.push(node.textContent!);
  }
  return found;
};

describe('how the Implementation and Testing figures are drawn', () => {
  it('draws the attack text with its two hyphens: in code type on the button, in the sentences and the SQL', () => {
    const { host, press, done } = mount(fig(IMPLEMENTATION_FIGURES, 'implementation-query-builder'));
    // Every typed name is drawn as typed, in code type; so is the placeholder.
    for (const { label } of NAMES) {
      const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;
      expect(button.querySelector('code.code-fragment')!.textContent, label).toBe(label);
    }
    expect(Array.from(host.querySelectorAll('button code.code-fragment')).map((c) => c.textContent)).toContain('?');
    expect(host.querySelector('.fig-description')!.querySelectorAll('code')).toHaveLength(4);
    for (const { value } of NAMES) for (const binding of ['Bound with ?', 'Pasted into the SQL']) {
      press(value); press(binding);
      expect(outsideCode(host.querySelector('figure')!), `${value} ${binding}`).toEqual([]);
    }
    press("x' OR 1=1 --");
    press('Pasted into the SQL');
    const live = host.querySelector('[data-testid="query-live"]')!;
    const codes = Array.from(live.querySelectorAll('code')).map((c) => c.textContent);
    expect(codes).toEqual(['OR 1=1', '--', "LIST_SELECT WHERE l.name = 'x' OR 1=1 --'"]);
    expect(live.textContent).toContain('and -- turns the leftover quote into a comment');
    done();
    // The boundary figure's two rules are code wherever its words name them.
    const slider = mount(fig(TESTING_FIGURES, 'testing-boundary-slider'));
    expect(Array.from(slider.host.querySelectorAll('figcaption strong code')).map((c) => c.textContent)).toEqual(['due < today', 'due <= today']);
    expect(Array.from(slider.host.querySelectorAll('[data-testid="boundary-live"] code')).map((c) => c.textContent)).toEqual(['due < today', 'due <= today']);
    expect(slider.host.querySelector('.fig-description code')!.textContent).toBe('due < today');
    expect(outsideCode(slider.host)).toEqual([]);
    slider.done();
  });

  it('draws no ligature pair in the page font in any Implementation or Testing figure', () => {
    for (const [map, ids] of [[IMPLEMENTATION_FIGURES, Object.keys(IMPLEMENTATION_FIGURES)], [TESTING_FIGURES, Object.keys(TESTING_FIGURES)]] as const) {
      for (const id of ids) {
        const { host, done } = mount(fig(map, id));
        // Press every control once, so each figure's other states are read too.
        for (const button of Array.from(host.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))) {
          act(() => button.click());
          expect(outsideCode(host), `${id} after ${button.textContent}`).toEqual([]);
        }
        done();
      }
    }
  });

  it('breaks the planted bugs’ names only after an underscore', () => {
    const { host, press, done } = mount(TESTING_MODULE.MutationTable);
    for (const mutant of MUTANTS) {
      const code = host.querySelector(`tr[data-mutant="${mutant.name}"] th code`)!;
      expect(code.textContent).toBe(mutant.name);
      expect(code.innerHTML).toBe(mutant.name.replace(/_/g, '_<wbr>'));
    }
    press('Home, then Work: they come back as Home, Work');
    expect(host.querySelector('[data-testid="mutation-live"]')!.innerHTML).toContain('lists_<wbr>newest_<wbr>first is now killed.');
    done();
    // The ledger's long test name and the file map's names and paths break the same way.
    const ledger = mount(fig(IMPLEMENTATION_FIGURES, 'implementation-evidence-ledger'));
    expect(ledger.host.querySelector('[data-testid="ledger-live"] code')!.innerHTML).toBe('test_<wbr>completing_<wbr>a_<wbr>task_<wbr>nobody_<wbr>has_<wbr>is_<wbr>a_<wbr>404');
    ledger.done();
    const map = mount(fig(IMPLEMENTATION_FIGURES, 'implementation-file-map'));
    expect(map.host.querySelector('button[data-gap="overdue_tasks"] code')!.innerHTML).toBe('overdue_<wbr>tasks');
    expect(map.host.querySelector('button[data-gap="useTasks"] code')!.innerHTML).toBe('use<wbr>Tasks');
    expect(Array.from(map.host.querySelectorAll('.fig-c-file-head code')).map((c) => c.innerHTML)).toContain('web/<wbr>src/<wbr>hooks/<wbr>use<wbr>Tasks.ts');
    map.done();
  });

  it('draws the phone pyramid’s names at about 12 px', () => {
    // A phone's figure body is about 225 px wide at 390; the text is 13 units.
    const drawn = (plan: (typeof PYRAMID)['compact']) => 13 * Math.min(225, 1.2 * plan.width) / plan.width;
    expect(drawn(PYRAMID.compact)).toBeGreaterThanOrEqual(12);
    expect(PYRAMID.compact.width).toBe(240);
    // The fit of every name inside its level, at body size, is tested above.
  });

  it('keeps Implementation 3’s and Testing 2’s 1000-unit plans at 860 px or more in their boxes', () => {
    for (const [map, id] of [[IMPLEMENTATION_FIGURES, 'implementation-request-states'], [TESTING_FIGURES, 'testing-response-read-restart']] as const) {
      const { host, done } = mount(fig(map, id));
      const svg = host.querySelector<SVGSVGElement>('svg.fig-svg')!;
      expect(svg.getAttribute('viewBox')!.split(' ')[2]).toBe('1000');
      expect(svg.style.minWidth, id).toBe('860px');
      done();
    }
  });

  it('shows a faint "read first" arrow for every gap before any press, and makes the pressed one heavy', () => {
    const { host, done } = mount(fig(IMPLEMENTATION_FIGURES, 'implementation-file-map'));
    expect(host.querySelectorAll('button.fig-c-hole[aria-pressed="true"]')).toHaveLength(0);
    const arrows = Array.from(host.querySelectorAll(':is(.fig-c-link, .fig-c-cross)'));
    expect(arrows).toHaveLength(GAPS.length);
    for (const arrow of arrows) expect(arrow.getAttribute('data-on')).toBe('false');
    expect(host.querySelectorAll('.fig-c-given[data-on="true"]')).toHaveLength(0);
    // The panel names what to read before each of the five gaps.
    const firsts = host.querySelector('[data-testid="file-map-firsts"]')!;
    expect(Array.from(firsts.querySelectorAll('dt')).map((dt) => dt.textContent)).toEqual(GAPS.map((g) => g.value));
    expect(Array.from(firsts.querySelectorAll('dd')).map((dd) => dd.textContent)).toEqual(GAPS.map((g) => g.first));
    // Each "first" names the row its arrow starts from.
    for (const g of GAPS) {
      const from = host.querySelector(`[data-read-for="${g.value}"] .fig-c-given-name`)!.textContent!;
      const named = g.first.match(/[A-Za-z]+_[A-Za-z_]+|[a-z]+[A-Z][A-Za-z]*/)?.[0];
      if (named) expect(from, g.value).toContain(named);
      else expect(from.toLowerCase(), g.value).toMatch(/docstring|comment/);
    }
    act(() => host.querySelector<HTMLButtonElement>('button[data-gap="list_tasks"]')!.click());
    expect(host.querySelectorAll('[data-on="true"]:is(.fig-c-link, .fig-c-cross)')).toHaveLength(1);
    expect(host.querySelector('[data-testid="file-map-firsts"]')).toBeNull();
    done();
    const css = readFileSync(resolve(__dirname, '../components/learn/figures/implementation-testing.css'), 'utf8');
    expect(css).toMatch(/\.fig-c-link-arrow \{[^}]*stroke: var\(--fig-line\); stroke-width: 1\.5;/);
    expect(css).toMatch(/:is\(\.fig-c-link, \.fig-c-cross\)\[data-on="true"\] \.fig-c-link-arrow \{ stroke: var\(--fig-ink\); stroke-width: 2\.5; \}/);
  });

  it('puts a Backed and Not observed tally, counted from the claims, above the ledger', () => {
    expect(ledgerTally()).toEqual({ backed: 3, notObserved: 3, total: 6 });
    expect(ledgerTally([{ by: 'x' }, { by: null }])).toEqual({ backed: 1, notObserved: 1, total: 2 });
    const { host, press, done } = mount(fig(IMPLEMENTATION_FIGURES, 'implementation-evidence-ledger'));
    const tally = host.querySelector('[data-testid="ledger-tally"]')!;
    expect(tally.compareDocumentPosition(host.querySelector('table')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Array.from(tally.querySelectorAll('.fig-status-word')).map((w) => w.textContent)).toEqual(['Backed: 3 of 6 claims', 'Not observed: 3 of 6']);
    const squares = Array.from(tally.querySelectorAll('rect'));
    expect(squares.map((r) => r.getAttribute('class'))).toEqual(CLAIMS.map((c) => (c.by ? 'fig-c-tally-backed' : 'fig-c-tally-open')));
    expect(squares.map((r) => r.getAttribute('data-on'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false']);
    press('Search ignores upper and lower case');
    expect(Array.from(tally.querySelectorAll('rect')).map((r) => r.getAttribute('data-on'))).toEqual(['false', 'false', 'false', 'true', 'false', 'false']);
    done();
  });

  it('fills the chosen pyramid level with the selected ink at a tenth, not only an outline', () => {
    const css = readFileSync(resolve(__dirname, '../components/learn/figures/implementation-testing.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const body = /\.fig-c-pyramid-layer\[data-on="true"\] \{([^}]*)\}/.exec(css)![1];
    expect(body).toMatch(/fill: var\(--fig-selected\); fill-opacity: 0\.1;/);
    expect(body).toMatch(/stroke: var\(--fig-accent\); stroke-width: 2\.5;/);
    // Ink #17323f at a tenth over white, and the muted words on it still read at 4.5:1.
    const over = [0x17, 0x32, 0x3f].map((c) => c * 0.1 + 255 * 0.9);
    const lum = (rgb: number[]) => { const [r, g, b] = rgb.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const muted = [0x4f, 0x64, 0x70];
    expect((lum(over) + 0.05) / (lum(muted) + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(lum(over)).toBeLessThan(lum([0xf5, 0xf8, 0xfa]));
  });
});
