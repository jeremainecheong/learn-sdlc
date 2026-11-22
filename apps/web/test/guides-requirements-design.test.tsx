// @vitest-environment jsdom
/**
 * The Requirements and Design guides' pinned facts and figures. The second
 * block reads the Design figures (the cardinality figure and the invalid-name
 * step-through).
 */
import { repoFile } from './support/paths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { moduleText } from './support/source-text';
import { GATE_RULE } from '@/components/learn/phase-map';
import { Practice } from '@/components/learn/LessonReader';
import { LESSONS } from '@/components/learn/content';
import { PHASE_STUDY } from '@/components/learn/study';
import * as REQ from '@/components/learn/figures/requirements';
import * as DES from '@/components/learn/figures/design';

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });
const render = (node: ReactNode) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  return host;
};
const figure = (map: typeof REQ.REQUIREMENTS_FIGURES, id: string) => {
  const Component = map[id].component;
  return render(<Component />);
};
const press = (host: Element, words: string) => {
  const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === words);
  if (!button) throw new Error(`No button "${words}"`);
  act(() => button.click());
};
const live = (host: Element, id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
const css = readFileSync(resolve(__dirname, '../components/learn/figures/requirements-design.css'), 'utf8');

it('explains the selected misconception and clears old feedback before a retry', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const chapter = LESSONS.design.chapters[1];
  try {
    act(() => root.render(<Practice chapter={chapter} />));
    const check = host.querySelector<HTMLButtonElement>('button')!;
    expect(check.disabled).toBe(true);
    const choose = (index: number) => act(() => host.querySelectorAll<HTMLInputElement>('input')[index].click());
    choose(1);
    act(() => check.click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain('task_count 0');
    expect(host.querySelector('[role="status"]')?.textContent).not.toContain(chapter.optionFeedback[2]);
    choose(2);
    expect(host.querySelector('[role="status"]')).toBeNull();
    act(() => check.click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain('list identity');
    choose(0);
    act(() => check.click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain('That fits this example.');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('one required parent');
  } finally { act(() => root.unmount()); }
});

it('names the sequence and relationship diagrams and keeps their accessible descriptions distinct', () => {
  const Cardinality = DES.DESIGN_FIGURES['design-list-cardinality'].component;
  const Sequence = DES.DESIGN_FIGURES['design-invalid-name-sequence'].component;
  const host = render(<><Cardinality /><Sequence /></>);
  const diagrams = Array.from(host.querySelectorAll('svg[role="img"]'));
  expect(diagrams).toHaveLength(2);
  expect(diagrams[0].querySelector('desc')?.textContent).toContain('every task requires one parent list');
  expect(diagrams[1].querySelector('desc')?.textContent).toContain('the route returns 400 with invalid_name');
  expect(diagrams[0].getAttribute('aria-labelledby')).not.toBe(diagrams[1].getAttribute('aria-labelledby'));
  expect(diagrams[1].querySelectorAll('line[marker-end][stroke-dasharray]')).toHaveLength(2);
});

describe('registration and the words around the figures', () => {
  it('gives every chapter of both guides at least one figure, ids prefixed by the phase, and no "Where you use this" of its own', () => {
    for (const [phase, map] of [['requirements', REQ.REQUIREMENTS_FIGURES], ['design', DES.DESIGN_FIGURES]] as const) {
      for (const chapter of [1, 2, 3, 4]) {
        const ids = Object.entries(map).filter(([, e]) => e.chapter === chapter).map(([id]) => id);
        expect(ids.length).toBeGreaterThanOrEqual(1);
        for (const id of ids) {
          expect(id.startsWith(`${phase}-`)).toBe(true);
          expect(id).not.toContain('-where-');
        }
      }
    }
  });

  it('keeps one walkthrough and one practice per chapter, with three options and distinct feedback', () => {
    for (const phase of ['requirements', 'design'] as const) {
      expect(LESSONS[phase].chapters).toHaveLength(4);
      expect(PHASE_STUDY[phase].chapters).toHaveLength(4);
      for (const chapter of LESSONS[phase].chapters) {
        expect(chapter.options).toHaveLength(3);
        expect(new Set(chapter.optionFeedback).size).toBe(3);
      }
    }
  });

  it('has no middle dot, pipe or em dash in the figures’ exported words or the rewritten chapters', () => {
    const words = JSON.stringify([REQ, DES, LESSONS.requirements.chapters, LESSONS.design.chapters, PHASE_STUDY.requirements, PHASE_STUDY.design]);
    expect(words).not.toMatch(/[·|—]/);
  });

  it('wears an honesty tag on every figure', () => {
    for (const map of [REQ.REQUIREMENTS_FIGURES, DES.DESIGN_FIGURES]) {
      for (const [id, entry] of Object.entries(map)) {
        const Component = entry.component;
        const host = render(<Component />);
        expect(host.querySelector('.fig-model-tag'), id).not.toBeNull();
        cleanup?.(); cleanup = null;
      }
    }
  });
});

describe('Requirements figures', () => {
  it('chapter 1: one note waits above three bins; a bin press drops it in, and Show the answer marks every sorted note', () => {
    const host = figure(REQ.REQUIREMENTS_FIGURES, 'requirements-fact-sorter');
    const bin = (kind: string) => host.querySelector<HTMLButtonElement>(`[data-bin="${kind}"] button`);
    const waiting = () => host.querySelector('[data-note-waiting]')?.getAttribute('data-note-waiting');
    expect(host.querySelectorAll('[data-bin]')).toHaveLength(3);
    expect(host.querySelector('[data-bin="fact"]')?.textContent).toContain('Reported or observed');
    expect(waiting()).toBe('rent');
    expect(live(host, 'sorter-live')).toBe(`Note 1 of 6 is waiting: “${REQ.INTERVIEW_NOTES[0].note}” Choose its bin.`);
    // Never a column of eighteen buttons: Three bins and one answer button.
    expect(host.querySelectorAll('button')).toHaveLength(4);
    act(() => bin('fact')!.click());
    act(() => bin('fact')!.click());
    expect(waiting()).toBe('weekend');
    expect(live(host, 'sorter-live')).toBe(`Put in Fact. Note 3 of 6 is waiting: “${REQ.INTERVIEW_NOTES[2].note}” Choose its bin.`);
    expect(host.querySelectorAll('[data-bin="fact"] [data-note]')).toHaveLength(2);
    const answer = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Show the answer')!;
    // The button says its state in its words, so it carries no aria-pressed as well.
    expect(answer.hasAttribute('aria-pressed')).toBe(false);
    press(host, 'Show the answer');
    expect(answer.textContent).toBe('Hide the answer');
    expect(answer.hasAttribute('aria-pressed')).toBe(false);
    const slip = (id: string) => host.querySelector(`[data-note="${id}"]`)!;
    expect(slip('rent').textContent).toContain('Right bin');
    expect(slip('rent').getAttribute('data-tone')).toBe('pass');
    expect(slip('chart').textContent).toContain('Belongs in Solution idea');
    expect(slip('chart').textContent).toContain('Solution idea.');
    expect(slip('chart').getAttribute('data-tone')).toBe('fail');
    expect(live(host, 'sorter-live')).toBe('1 of 2 sorted notes are in the right bin. 4 not sorted yet.');
    press(host, 'Hide the answer');
    for (const kind of ['assumption', 'fact', 'solution', 'assumption'] as const) act(() => bin(kind)!.click());
    // The last bin press closes the bins: focus moves on to the answer button, never to the page.
    expect(host.querySelectorAll('.fig-rq-bins button')).toHaveLength(0);
    expect(document.activeElement).toBe(answer);
    expect(live(host, 'sorter-live')).toBe('Put in Assumption. All 6 notes are in the bins. Press Show the answer to check them.');
    press(host, 'Show the answer');
    expect(live(host, 'sorter-live')).toBe('5 of 6 sorted notes are in the right bin.');
    press(host, 'Start again');
    expect(waiting()).toBe('rent');
    expect(host.querySelectorAll('[data-note]')).toHaveLength(0);
    expect(document.activeElement).toBe(bin('fact'));
  });

  it('chapter 1: a running count above the bins, the fork kept in every state, and a short drop that stops under reduced motion', () => {
    const host = figure(REQ.REQUIREMENTS_FIGURES, 'requirements-fact-sorter');
    const bin = (kind: string) => host.querySelector<HTMLButtonElement>(`[data-bin="${kind}"] button`)!;
    const count = () => live(host, 'sorter-count');
    const sorter = host.querySelector('.fig-rq-sorter')!;
    // Above the note and the bins.
    expect(sorter.firstElementChild?.getAttribute('data-testid')).toBe('sorter-count');
    expect(count()).toBe('0 of 6 sorted');
    for (const kind of ['fact', 'fact']) act(() => bin(kind).click());
    expect(count()).toBe('2 of 6 sorted');
    press(host, 'Show the answer');
    expect(count()).toBe('2 of 6 sorted1 of 6 in the right bin');
    press(host, 'Hide the answer');
    expect(count()).toBe('2 of 6 sorted');
    for (const kind of ['assumption', 'fact', 'solution', 'assumption'] as const) act(() => bin(kind).click());
    expect(count()).toBe('6 of 6 sorted');
    // All six sorted: the card keeps its fork, so it never sits on the bins.
    expect(host.querySelector('[data-note-waiting=""]')).not.toBeNull();
    expect(host.querySelector('.fig-rq-waiting svg.fig-rq-fork')).not.toBeNull();
    press(host, 'Show the answer');
    expect(count()).toBe('6 of 6 sorted5 of 6 in the right bin');
    // Every bin, the closed ones too, wears the fork's arrowhead.
    const wide = css.slice(css.indexOf('@container (min-width: 600px)'));
    expect(wide).toMatch(/\n  \.fig-rq-bin-mouth::before \{ content: "";/);
    expect(css).toMatch(/\.fig-rq-slip \{[^}]*animation: fig-rq-drop 150ms ease-out;/);
    expect(css).toContain('.fig[data-motion="reduce"] .fig-rq-slip { animation: none; }');
    expect(css).toContain('@media (prefers-reduced-motion: reduce) { .fig-rq-slip { animation: none; } }');
  });

  it('chapter 2: says what completes each level and refuses a dependency that names no prerequisite', () => {
    const host = figure(REQ.REQUIREMENTS_FIGURES, 'requirements-purpose-hierarchy');
    const desc = () => host.querySelector('svg desc')?.textContent ?? '';
    expect(desc()).toContain('An illustrative capture-and-organise epic parents supplied US-1');
    expect(desc()).toContain('this picture does not create backlog records');
    expect(live(host, 'tree-live')).toContain('US-1');
    press(host, 'Subtasks');
    expect(live(host, 'tree-live')).toContain('the user outcome is still missing');
    expect(host.querySelector('[data-testid="dependency-line"]')).toBeNull();
    const line = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Add a dependency line')!;
    expect(line.hasAttribute('aria-pressed')).toBe(false);
    press(host, 'Add a dependency line');
    expect(line.textContent).toBe('Remove the dependency line');
    expect(line.hasAttribute('aria-pressed')).toBe(false);
    expect(host.querySelector('[data-testid="dependency-line"] line[stroke-dasharray]')).not.toBeNull();
    expect(desc()).toContain('neither subtask waits for the other');
    expect(live(host, 'tree-live')).toContain('must name a real prerequisite');
  });

  it('chapter 2: a shorter diagram with its controls and answer beside it, so the depends-on result shows beside the button', () => {
    const host = figure(REQ.REQUIREMENTS_FIGURES, 'requirements-purpose-hierarchy');
    const svg = host.querySelector('svg[role="img"]')!;
    expect(Number(svg.getAttribute('viewBox')!.split(' ')[3])).toBeLessThanOrEqual(260);
    const side = host.querySelector('.fig-rd-side-controls')!;
    expect(side.textContent).toContain('Add a dependency line');
    expect(side.querySelector('[data-testid="tree-live"]')).not.toBeNull();
    expect(side.nextElementSibling).toBe(svg);
    press(host, 'Add a dependency line');
    // The refused line and its head are drawn in the fail colour together.
    expect(host.querySelector('[data-testid="dependency-line"] line')?.getAttribute('marker-end')).toBe('url(#req-tree-arrow-fail)');
    expect(css).toMatch(/@container \(min-width: 960px\) \{\s*\.fig-rd-side-in \{ display: grid; grid-template-columns: 280px minmax\(0, 1fr\)/);
  });

  it('chapter 3: the weak criterion lets stores-then-refuses slip through; the full one catches both wrong versions', () => {
    const host = figure(REQ.REQUIREMENTS_FIGURES, 'requirements-criterion-tester');
    const cell = (id: string) => host.querySelector(`[data-implementation="${id}"] td:last-child`)?.textContent;
    expect(cell('refuses')).toBe('Passes, as it should');
    expect(cell('stores-then-refuses')).toBe('Slips through');
    expect(cell('accepts')).toBe('Caught');
    expect(live(host, 'criterion-live')).toContain('catches 1 of 2');
    press(host, REQ.CRITERIA[1].label);
    expect(cell('stores-then-refuses')).toBe('Caught');
    expect(live(host, 'criterion-live')).toContain('catches 2 of 2');
  });

  it('chapter 4: five cases on a date line, judged one at a time against an illustrative draft, ending on the gate as it decides', () => {
    const host = figure(REQ.REQUIREMENTS_FIGURES, 'requirements-promise-checklist');
    const state = (id: string) => host.querySelector(`[data-case="${id}"]`)?.getAttribute('data-state');
    const card = (id: string) => host.querySelector(`[data-case="${id}"]`)?.textContent ?? '';
    const said = () => host.querySelector('[data-testid="checklist-said"]')?.textContent ?? '';
    const next = () => host.querySelector('[data-testid="checklist-next"]')?.textContent ?? '';
    expect(host.querySelectorAll('[data-case]')).toHaveLength(5);
    expect(host.textContent).toContain(REQ.OVERDUE_DRAFT);
    expect(state('yesterday')).toBe('current');
    expect(['today', 'done', 'no-date', 'order'].map(state)).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
    expect(said()).toBe('');
    expect(next()).toBe('Case 1 of 5: an open task due yesterday. Does the draft decide what the report does with it?');
    // Two answers, never a tick for opening something.
    expect(Array.from(host.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['It decides it', 'It leaves it open']);
    press(host, 'It decides it');
    expect(state('yesterday')).toBe('pass');
    expect(card('yesterday')).toContain('Decided, as the brief says');
    expect(card('yesterday')).toContain('Your call matched');
    expect(said()).toMatch(/^Right: “Before today” takes in yesterday/);
    expect(state('today')).toBe('current');
    press(host, 'It leaves it open');
    expect(state('today')).toBe('pass');
    expect(card('today')).toContain('The draft: not listed');
    expect(card('today')).toContain('Your call differed');
    expect(said()).toMatch(/^Look again: “Before today” leaves today out/);
    press(host, 'It decides it');
    expect(state('done')).toBe('fail');
    expect(card('done')).toContain('Decided against the brief');
    press(host, 'It decides it');
    expect(state('no-date')).toBe('warn');
    expect(card('no-date')).toContain('Gap: a tester must guess');
    expect(said()).toMatch(/^Look again: The draft never mentions a task with no date/);
    press(host, 'It leaves it open');
    expect(state('order')).toBe('warn');
    expect(next()).toBe(`You judged 3 of 5 as a tester would. The draft decides 3 cases, one of them against the brief, and leaves 2 open. Mend the wrong one and close both gaps before you submit: the review records a Pass only when ${GATE_RULE}, and a Pass opens Design.`);
    expect(live(host, 'checklist-live')).not.toMatch(/\b70\b|out of 100/);
    // The answer buttons leave with the last case: focus moves on to Start again, and back.
    expect(document.activeElement?.textContent).toBe('Start again');
    press(host, 'Start again');
    expect(state('yesterday')).toBe('current');
    expect(document.activeElement?.textContent).toBe('It decides it');
  });

  it('chapter 4: a tally beside the date line counts only the judged cases by verdict, in words', () => {
    const host = figure(REQ.REQUIREMENTS_FIGURES, 'requirements-promise-checklist');
    const tally = () => host.querySelector('[data-testid="checklist-tally"]')!;
    const counts = () => Object.fromEntries(Array.from(tally().querySelectorAll('[data-tally]')).map((li) => [li.getAttribute('data-tally'), li.querySelector('.fig-rq-tally-n')?.textContent]));
    expect(tally().textContent).toContain('Judged so far: 0 of 5');
    expect(counts()).toEqual({ agrees: '0', against: '0', gap: '0' });
    expect(Array.from(tally().querySelectorAll('.fig-status-word')).map((w) => w.textContent)).toEqual(['Decided, as the brief says', 'Decided against the brief', 'Gap: a tester must guess']);
    press(host, 'It decides it');
    expect(counts()).toEqual({ agrees: '1', against: '0', gap: '0' });
    for (const words of ['It leaves it open', 'It decides it']) press(host, words);
    expect(counts()).toEqual({ agrees: '2', against: '1', gap: '0' });
    for (const words of ['It decides it', 'It leaves it open']) press(host, words);
    expect(tally().textContent).toContain('Judged so far: 5 of 5');
    // The counts come from the data: 3 decided (one against the brief), 2 left open.
    expect(counts()).toEqual({ agrees: '2', against: '1', gap: '2' });
    expect(REQ.overdueTally(Object.fromEntries(REQ.OVERDUE_CASES.map((c) => [c.id, 'open'])))).toEqual({ judged: 5, agrees: 2, against: 1, gap: 2 });
    // It takes the empty right half: under Today and No due date, beside the order case.
    expect(css).toMatch(/\.fig-rq-tally \{ grid-column: 3 \/ span 2; grid-row: 2;/);
  });

  it('chapter 4: the "Before today" bracket is a clear line with end ticks, drawn below the tinted band', () => {
    const wide = css.slice(css.indexOf('@container (min-width: 640px)'));
    const rule = /\.fig-rq-bracket \{([^}]*)\}/.exec(wide)?.[1] ?? '';
    expect(rule).toContain('margin-top: 12px');
    expect(rule).toContain('border-top: 0');
    expect(rule).not.toContain('border-radius');
    expect(wide).toMatch(/\.fig-rq-bracket::after \{ content: ""; position: absolute; left: 50%; top: 100%;/);
  });

  it('chapter 4: the brief states the three decided outcomes, and nothing printed says what Dana decided about undated tasks or the order', () => {
    const phase = JSON.parse(repoFile('content/tasktrackr/phases/01-requirements/phase.json')) as { taskPanel: string };
    expect(phase.taskPanel).toContain('a task whose due date has passed appears in it');
    expect(phase.taskPanel).toContain('a task due today is not in it yet');
    expect(phase.taskPanel).toContain('a task you have completed is not in it, however late it was');
    const interview = JSON.parse(repoFile('content/tasktrackr/phases/01-requirements/interview.json')) as { facts: { id: string; answer: string }[] };
    const withheld = interview.facts.filter((f) => f.id === 'F4' || f.id === 'F5').map((f) => f.answer);
    expect(withheld).toHaveLength(2);
    const host = figure(REQ.REQUIREMENTS_FIGURES, 'requirements-promise-checklist');
    for (const words of ['It decides it', 'It leaves it open', 'It decides it', 'It decides it', 'It leaves it open']) press(host, words);
    const printed = `${JSON.stringify(REQ.OVERDUE_CASES)} ${host.textContent}`;
    for (const answer of withheld) for (const sentence of answer.split('. ')) expect(printed).not.toContain(sentence.replace(/\.$/, ''));
    expect(printed).not.toMatch(/most overdue|never overdue|higher priority|whole days/i);
    // The undated case's claim about a browser date made from no date.
    expect(new Date(null as unknown as string).getTime()).toBe(0);
    expect(new Date(null as unknown as string) < new Date('2026-11-18')).toBe(true);
  });
});

describe('Design figures', () => {
  const api = JSON.parse(repoFile('content/tasktrackr/phases/02-design/files/shared/contract/api.json')) as { operations: { id: string; summary: string; satisfies: string; success: { status: number; body: string }; errors: string[] }[] };
  const op = (id: string) => api.operations.find((o) => o.id === id)!;

  it('chapter 1: the contract slots carry the supplied listLists row exactly', () => {
    const listLists = op('listLists');
    const slot = (v: string) => DES.CONTRACT_SLOTS.find((s) => s.value === v)!.filled;
    expect(slot('ordering')).toBe(listLists.summary);
    expect(slot('success')).toBe(`success: { status: ${listLists.success.status}, body: ${listLists.success.body} }`);
    expect(slot('story')).toBe(`satisfies: ${listLists.satisfies}`);
    expect(listLists.errors).toEqual([]);
    expect(op('createList').errors).toEqual(['invalid_name', 'duplicate_list']);
    const screens = JSON.parse(repoFile('content/tasktrackr/phases/02-design/files/shared/contract/screens.json')) as { screens: { route: string; component: string; reads: string[] }[] };
    // The caller the figure draws: ListsPage, on #/, reads listLists.
    expect(screens.screens.find((one) => one.component === 'ListsPage')).toMatchObject({ route: '#/', reads: ['listLists'] });
    const host = figure(DES.DESIGN_FIGURES, 'design-contract-builder');
    const guesses = () => Array.from(host.querySelectorAll('[data-guess]')).map((li) => li.getAttribute('data-guess'));
    expect(host.querySelector('[data-party="caller"]')?.textContent).toContain('ListsPage');
    expect(host.querySelector('[data-party="api"]')?.textContent).toContain('listLists');
    // The slots are drawn where they travel: one on the request, three on the response, the story as the row's tag.
    expect(host.querySelectorAll('[data-part="request"] [data-slot]')).toHaveLength(1);
    expect(Array.from(host.querySelectorAll('[data-part="response"] [data-slot]')).map((b) => b.getAttribute('data-slot'))).toEqual(['success', 'ordering', 'errors']);
    expect(host.querySelector('.fig-ds-story [data-slot]')?.getAttribute('data-slot')).toBe('story');
    expect(host.querySelectorAll('button[data-slot][data-filled="false"]')).toHaveLength(5);
    // The slot's words say its state, so it does not say it twice with aria-pressed.
    expect(host.querySelectorAll('button[data-slot][aria-pressed]')).toHaveLength(0);
    for (const b of Array.from(host.querySelectorAll('button[data-slot]'))) expect(b.textContent).toContain('Not promised yet');
    expect(host.querySelectorAll('[data-slot] code')).toHaveLength(0);
    expect(guesses()).toEqual(['request', 'success', 'ordering', 'errors', 'story']);
    expect(live(host, 'contract-live')).toBe('0 of 5 promised. The caller still has to guess 5 things: what do I send; what comes back when it works; in what order, with which counts; can it be refused, and how; which story needs this.');
    // No "Contract slots filled: 0 of 5 on." line under the slots.
    expect(host.textContent).not.toContain('slots filled');
    expect(host.textContent).not.toMatch(/\bon\.$/m);
    act(() => host.querySelector<HTMLButtonElement>('button[data-slot="ordering"]')!.click());
    expect(host.querySelector('[data-slot="ordering"] code')?.textContent).toBe(listLists.summary);
    expect(host.querySelector('button[data-slot="ordering"]')?.getAttribute('data-filled')).toBe('true');
    expect(host.querySelector('button[data-slot="ordering"]')?.hasAttribute('aria-pressed')).toBe(false);
    expect(host.querySelector('button[data-slot="ordering"]')?.textContent).toBe(`OrderingPromised${listLists.summary}`);
    expect(guesses()).toEqual(['request', 'success', 'errors', 'story']);
    expect(live(host, 'contract-live')).toContain('1 of 5 promised. The caller still has to guess 4 things');
    act(() => host.querySelector<HTMLButtonElement>('button[data-slot="ordering"]')!.click());
    expect(host.querySelector('[data-slot="ordering"] code')).toBeNull();
    for (const s of ['request', 'success', 'ordering', 'errors']) act(() => host.querySelector<HTMLButtonElement>(`button[data-slot="${s}"]`)!.click());
    expect(live(host, 'contract-live')).toBe('4 of 5 promised. The caller still has to guess one thing: which story needs this.');
    act(() => host.querySelector<HTMLButtonElement>('button[data-slot="story"]')!.click());
    expect(guesses()).toEqual([]);
    expect(host.querySelector('[data-testid="contract-guesses"]')?.textContent).toContain('Nothing left to guess');
    expect(host.querySelector('[data-testid="contract-guesses"]')?.getAttribute('data-tone')).toBe('pass');
    expect(live(host, 'contract-live')).toContain('All five promised');
  });

  it('chapter 1: the guess count is a large number, the label sits on its slot, the bubble fits its words, and the wires and envelopes are heavier', () => {
    const host = figure(DES.DESIGN_FIGURES, 'design-contract-builder');
    const bubble = () => host.querySelector('[data-testid="contract-guesses"]')!;
    const big = () => bubble().querySelector('.fig-ds-guess-n');
    expect(big()?.textContent).toBe('5');
    expect(big()?.getAttribute('aria-hidden')).toBe('true');
    expect(bubble().querySelector('.fig-ds-guess-head')?.textContent).toBe('5The caller has to guess 5 things');
    act(() => host.querySelector<HTMLButtonElement>('button[data-slot="story"]')!.click());
    expect(big()?.textContent).toBe('4');
    for (const s of ['request', 'success', 'ordering', 'errors']) act(() => host.querySelector<HTMLButtonElement>(`button[data-slot="${s}"]`)!.click());
    expect(big()?.textContent).toBe('0');
    expect(bubble().querySelector('.fig-ds-guess-head')?.textContent).toBe('0Nothing left to guess');
    // Nothing left: one line of words and no empty list holding the bubble open.
    expect(bubble().querySelector('ul')).toBeNull();
    // The last rule for a selector: the wide layout's, where it has one.
    const rule = (selector: string) => [...css.matchAll(new RegExp(`(^|\\n)\\s*${selector.replace(/[.[\]()"]/g, '\\$&')} \\{([^}]*)\\}`, 'g'))].pop()?.[2] ?? '';
    expect(rule('.fig-ds-story')).toMatch(/align-self: start; align-content: start;/);
    expect(rule('.fig-ds-guess')).toMatch(/align-self: start; align-content: start;/);
    expect(rule('.fig-ds-guess-n')).toContain('font-size: 30px');
    expect(rule('.fig-ds-envelope')).toContain('border: 2px solid var(--fig-line)');
    expect(rule('.fig-ds-wire')).toContain('border-top: 2.5px solid var(--fig-line)');
    expect(rule('.fig-ds-flap path')).toContain('stroke-width: 2');
  });

  it('chapter 2: the wrong model rejects the empty list in words, and the right model allows zero, one and three', () => {
    const host = figure(DES.DESIGN_FIGURES, 'design-list-cardinality');
    expect(live(host, 'cardinality-live')).toContain('Allowed');
    expect(host.querySelector('svg[role="img"]')?.textContent).toContain('1 → 0..*');
    press(host, '3 tasks');
    expect(host.querySelector('svg desc')?.textContent).toContain('List 7 holds 3 tasks, each naming list_id 7');
    expect(host.querySelector('[data-testid="cardinality-live"]')?.getAttribute('data-tone')).toBe('pass');
    press(host, '1 task');
    press(host, DES.MODELS[1].label);
    // The wrong model with one task is allowed only by luck: never the pass tone.
    expect(live(host, 'cardinality-live')).toContain('only by luck');
    expect(host.querySelector('[data-testid="cardinality-live"]')?.getAttribute('data-tone')).toBe('warn');
    press(host, '0 tasks');
    expect(host.querySelector('[data-testid="cardinality-live"]')?.getAttribute('data-tone')).toBe('fail');
    expect(live(host, 'cardinality-live')).toContain('Rejected');
    expect(live(host, 'cardinality-live')).toContain('the empty list createList returns');
    expect(host.querySelector('svg desc')?.textContent).toContain('every task requires one parent list');
  });

  it('chapter 2: the drawing is as tall as its rows (no empty band) and keeps a readable minimum width', () => {
    const host = figure(DES.DESIGN_FIGURES, 'design-list-cardinality');
    const svg = () => host.querySelector<SVGSVGElement>('svg[role="img"]')!;
    const fits = () => {
      const height = Number(svg().getAttribute('viewBox')!.split(' ')[3]);
      const rects = Array.from(svg().querySelectorAll('rect'));
      const top = Math.min(...rects.map((r) => Number(r.getAttribute('y'))));
      const bottom = Math.max(...rects.map((r) => Number(r.getAttribute('y')) + Number(r.getAttribute('height'))));
      return { height, top, gap: height - bottom };
    };
    for (const [words, height] of [['0 tasks', 112], ['1 task', 112], ['3 tasks', 200]] as const) {
      press(host, words);
      expect(fits().height).toBe(height);
      expect(fits().top).toBeLessThanOrEqual(14);
      expect(fits().gap).toBeLessThanOrEqual(14);
    }
    expect(DES.cardinalityHeight(3)).toBe(200);
    expect(svg().style.minWidth).toBe('620px');
    expect(svg().classList.contains('fig-rd-svg')).toBe(true);
    expect(host.querySelector('.fig-rd-side-controls [data-testid="cardinality-live"]')).not.toBeNull();
  });

  it('draws SVG text in the page font at about body size: no per-figure font or size, and the diagrams stop growing at 1.2 times their plan', () => {
    for (const file of ['REQUIREMENTS_FIGURES', 'DESIGN_FIGURES']) {
      const source = moduleText(file);
      expect(source, file).not.toMatch(/fontSize|fontFamily|font-size=|font-family=/);
    }
    const svgRules = css.match(/[^{}]*\.fig-svg[^{}]*\{[^}]*\}/g) ?? [];
    expect(svgRules.length).toBeGreaterThan(0);
    for (const rule of svgRules) expect(rule, rule).not.toMatch(/font-size|font-family|font:/);
    // FigureSvg's inline cap is the one that draws; a stylesheet cap would never apply.
    expect(css).not.toMatch(/\.fig-rd-svg[^{]*\{[^}]*max-width/);
    const Sequence = DES.DESIGN_FIGURES['design-invalid-name-sequence'].component;
    const host = render(<Sequence />);
    const drawn = host.querySelector<SVGSVGElement>('svg[role="img"]')!;
    expect(drawn.classList.contains('fig-rd-svg')).toBe(true);
    expect(drawn.getAttribute('viewBox')).toBe('0 0 730 320');
    expect(drawn.style.maxWidth).toBe('876px');
  });

  it('every drawing in both guides keeps its 13-unit text at about 11 px or more while it scrolls in its box', () => {
    const seen: string[] = [];
    for (const map of [REQ.REQUIREMENTS_FIGURES, DES.DESIGN_FIGURES]) {
      for (const [id, entry] of Object.entries(map)) {
        const Component = entry.component;
        const host = render(<Component />);
        for (const svg of Array.from(host.querySelectorAll<SVGSVGElement>('svg[role="img"]'))) {
          const units = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
          const min = parseFloat(svg.style.minWidth);
          expect((13 * min) / units, id).toBeGreaterThanOrEqual(11);
          seen.push(id);
        }
        cleanup?.(); cleanup = null;
      }
    }
    expect(seen).toEqual(['requirements-purpose-hierarchy', 'design-list-cardinality', 'design-invalid-name-sequence']);
  });

  it('chapter 3: steps through the four messages, one marked at a time, and names the deciding layer', () => {
    const host = figure(DES.DESIGN_FIGURES, 'design-invalid-name-sequence');
    const lit = () => host.querySelector('[data-message][data-lit="true"]')?.getAttribute('data-message');
    expect(lit()).toBe('1');
    expect(host.textContent).toContain('Step 1 of 4');
    press(host, 'Next');
    press(host, 'Next');
    expect(lit()).toBe('3');
    expect(host.textContent).toContain('The repository refuses');
    expect(host.querySelector('svg desc')?.textContent).toContain('Message 3 of 4 is marked: ValueError');
    const group = host.querySelector('.fig-steps')!;
    act(() => { group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(lit()).toBe('4');
    expect(host.textContent).toContain('returns 400 with invalid_name');
  });

  it('chapter 4: the slogan misses four parts; the record asks for all six and fills only one as an example', () => {
    const host = figure(DES.DESIGN_FIGURES, 'design-decision-record');
    expect(host.querySelectorAll('[data-status="failed"]')).toHaveLength(4);
    expect(live(host, 'decision-live')).toContain('4 of 6 parts missing');
    // The slogan's reason is stated but weighs the choice against nothing: amber, never a green tick.
    expect(host.querySelector('[data-field="Why"]')?.textContent).toContain('Stated, against no alternative');
    expect(host.querySelector('[data-field="Why"] [data-status]')?.getAttribute('data-status')).toBe('survived');
    expect(host.querySelectorAll('[data-status="passed"]')).toHaveLength(1);
    press(host, 'A decision record');
    expect(host.querySelectorAll('[data-status="failed"]')).toHaveLength(0);
    expect(host.querySelector('[data-field="Cost"]')?.textContent).toContain('consistency test');
    expect(host.querySelectorAll('[data-status="passed"]')).toHaveLength(1);
    expect(live(host, 'decision-live')).toContain('All 6 parts asked for');
    // Field names and one filled part, never a whole record to paste into D1.
    expect(DES.DECISION_FIELDS.filter((f) => f.example)).toHaveLength(1);
    for (const f of DES.DECISION_FIELDS.filter((one) => !one.example)) expect(host.querySelector(`[data-field="${f.field}"]`)?.textContent).toContain(f.asks);
    expect(host.textContent).not.toContain('Compute the marker in the browser');
  });

  it('chapter 4: draws the decision as a fork: context, the choice or its alternative, the reason, then the cost and when to revisit', () => {
    const host = figure(DES.DESIGN_FIGURES, 'design-decision-record');
    const record = host.querySelector('.fig-ds-record')!;
    expect(Array.from(record.querySelectorAll('[data-field]')).map((p) => p.getAttribute('data-field'))).toEqual(['Context', 'Decision', 'Alternative', 'Why', 'Cost', 'Revisit when']);
    expect(Array.from(record.querySelectorAll('svg.fig-ds-link')).map((l) => l.getAttribute('data-shape'))).toEqual(['fork', 'join', 'fork']);
    expect(record.querySelector('.fig-ds-record-two')?.textContent).toMatch(/Decision.*or.*Alternative/);
    expect(['Context', 'Alternative', 'Cost', 'Revisit when'].map((f) => record.querySelector(`[data-field="${f}"]`)?.getAttribute('data-state'))).toEqual(['missing', 'missing', 'missing', 'missing']);
    // Every stretch of the fork's lines draws at least 20 px long.
    const drawn = Number(/\.fig-ds-link \{ display: none; width: 100%; height: (\d+)px; \}/.exec(css)?.[1]);
    // Each link is two rows of vertical stretches, each row half its 24-unit height.
    for (const link of Array.from(record.querySelectorAll('svg.fig-ds-link'))) {
      expect(link.getAttribute('viewBox')).toBe('0 0 100 24');
      expect([...link.querySelector('path')!.getAttribute('d')!.matchAll(/V(\d+)/g)].map((m) => Number(m[1])).every((v) => v === 12 || v === 24)).toBe(true);
    }
    expect(drawn / 2).toBeGreaterThanOrEqual(20);
    expect(css).toContain('.fig-ds-link path { stroke-width: 2; }');
    // At most a version switch: the drawing itself is not a form.
    expect(host.querySelectorAll('button')).toHaveLength(2);
    expect(host.querySelectorAll('input, textarea, select')).toHaveLength(0);
  });
});

describe('Design chapter 4 worked example', () => {
  it('gives only what the supplied screens.json says, and leaves the record’s reasoning to the learner', () => {
    const screens = JSON.parse(repoFile('content/tasktrackr/phases/02-design/files/shared/contract/screens.json')) as { $router_comment: string; router: string };
    expect(screens.router).toBe('hash');
    expect(screens.$router_comment).toContain('no history fallback');
    expect(screens.$router_comment).toContain('sandboxed preview frame');
    const chapter = PHASE_STUDY.design.chapters[3];
    expect(chapter.example).toContain('Choice: hash routing (supplied, screens.json)');
    // No whole decision record to paste into the Decisions tab: the alternative and the cost are not written for the learner.
    const words = [chapter.example, ...chapter.steps].join(' ');
    expect(words).not.toMatch(/path routing|path-based|URLs retain|hash-style URLs/i);
  });
});
