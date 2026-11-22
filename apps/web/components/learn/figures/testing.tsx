'use client';
import { useState } from 'react';
import { pluralWord } from '@learnsdlc/shared';
import { ScrollRegion } from '@/components/experience/ScrollRegion';
import type { PhaseFigures } from './types';
import { Figure, FigureSvg } from './Figure';
import { StatusMark } from './StatusMark';
import { ToggleSet } from './ToggleSet';
import { arrowPath } from './implementation';
import { wordBreaks } from './CodeText';
import './implementation-testing.css';

/* The Testing guide's figures. The mutation table below is the gate's
 * finished example: the model of quality for every guide figure. */

/* ----------------------------- chapter 1: the pyramid ----------------------------- */

/** The three levels, top to bottom, with TaskTrackr's tool at each. */
export const LEVELS = [
  { value: 'e2e', label: 'Browser journey', width: 'Fewer checks', tool: 'A real browser against the running app. The Testing room’s runner has none: it runs pytest and a DOM harness.', claim: 'A learner creates a list through the form.', blind: 'Which rule broke. A red journey has many possible causes.' },
  { value: 'integration', label: 'Integration', width: 'Some checks', tool: 'The Flask test client (route, JSON and database in one process) and the DOM harness on jsdom (a component with a canned API answer).', claim: 'POST /api/lists answers 400 with invalid_name for an empty name.', blind: 'A real socket and a real browser. The Flask client opens no socket; jsdom is not a browser.' },
  { value: 'unit', label: 'Unit', width: 'More checks', tool: 'A pure function check, such as isOverdue(task, today).', claim: 'The overdue rule leaves out a task due today.', blind: 'The route, the database and the screen.' },
] as const;
type Level = (typeof LEVELS)[number]['value'];

/* The pyramid is drawn twice from one plan: a wide picture with a note beside
 * each level (how many checks, how much of TaskTrackr it reaches), and a
 * compact one for a phone's width with the names alone. Each level's words sit
 * inside its own shape: the plan gives every line its baseline, and
 * `bandWidthAt` says how wide the shape is at any height, so the test can
 * check that every line fits, with room to spare, in both drawings. */
export type PyramidLine = { text: string; y: number; strong?: boolean };
export type PyramidPlan = {
  width: number; height: number; apexX: number; apexY: number; slope: number;
  bands: Record<Level, { top: number; bottom: number; lines: readonly PyramidLine[] }>;
  notes?: Record<Level, readonly string[]>;
};
/** Where TaskTrackr's Testing room stands: its runner has no real browser (phase.json runs pytest and the DOM harness). */
const NOT_IN_ROOM = 'No browser in the Testing room';
export const PYRAMID: Record<'wide' | 'compact', PyramidPlan> = {
  wide: {
    width: 760, height: 306, apexX: 230, apexY: 12, slope: 0.74,
    bands: {
      e2e: { top: 12, bottom: 118, lines: [{ text: 'Browser', y: 88, strong: true }, { text: 'journey', y: 108, strong: true }] },
      integration: { top: 124, bottom: 206, lines: [{ text: 'Integration', y: 162, strong: true }, { text: 'Flask client, DOM harness', y: 188 }] },
      unit: { top: 212, bottom: 294, lines: [{ text: 'Unit', y: 246, strong: true }, { text: 'isOverdue(task, today)', y: 270 }] },
    },
    notes: {
      e2e: ['Fewer checks', 'Reaches the whole running app', NOT_IN_ROOM],
      integration: ['Some checks', 'Reaches a route and its', 'database, or a component'],
      unit: ['More checks', 'Reaches one function'],
    },
  },
  /* 240 units wide, so on a phone (the figure's body about 225 px wide) its
   * 13-unit names draw at about 12 px (at 340 units they would draw at
   * 8.6 px). */
  compact: {
    width: 240, height: 278, apexX: 120, apexY: 8, slope: 0.45,
    bands: {
      e2e: { top: 8, bottom: 140, lines: [{ text: 'Browser', y: 112, strong: true }, { text: 'journey', y: 133, strong: true }] },
      integration: { top: 146, bottom: 206, lines: [{ text: 'Integration', y: 181, strong: true }] },
      unit: { top: 212, bottom: 270, lines: [{ text: 'Unit', y: 246, strong: true }] },
    },
  },
};
/** The pyramid's width at height y. */
export const bandWidthAt = (plan: PyramidPlan, y: number) => 2 * (y - plan.apexY) * plan.slope;
export const NOTE_X = 470;

function PyramidSvg({ plan, level, compact }: { plan: PyramidPlan; level: Level; compact?: boolean }) {
  const chosen = LEVELS.find((item) => item.value === level)!;
  const half = (y: number) => bandWidthAt(plan, y) / 2;
  const shape = (value: Level) => {
    const { top, bottom } = plan.bands[value];
    const [l, r] = [plan.apexX - half(bottom), plan.apexX + half(bottom)];
    return value === 'e2e'
      ? `M${plan.apexX} ${top} L${r} ${bottom} L${l} ${bottom} Z`
      : `M${plan.apexX - half(top)} ${top} L${plan.apexX + half(top)} ${top} L${r} ${bottom} L${l} ${bottom} Z`;
  };
  return (
    <FigureSvg
      title="Three test levels"
      description={`Browser journey at the top (fewer checks, it reaches the whole running app, and the Testing room has no browser), integration in the middle (some checks, a route and its database or a component), unit at the bottom (more checks, one function). Chosen: ${chosen.label}.`}
      viewBox={`0 0 ${plan.width} ${plan.height}`}
      className={`fig-c-pyramid ${compact ? 'fig-c-pyramid-compact' : 'fig-c-pyramid-wide'}`}
    >
      {LEVELS.map((item) => {
        const band = plan.bands[item.value];
        const on = item.value === level;
        const middle = (band.top + band.bottom) / 2;
        const notes = plan.notes?.[item.value];
        return (
          <g key={item.value} data-level={item.value}>
            <path className="fig-c-pyramid-layer" data-on={on} data-room={item.value === 'e2e' ? 'none' : undefined} d={shape(item.value)} />
            {band.lines.map((line) => (
              <text key={line.text} x={plan.apexX} y={line.y} textAnchor="middle" className={line.strong ? 'fig-c-svg-strong' : 'fig-c-svg-note'}>{line.text}</text>
            ))}
            {notes && (
              <>
                <path className="fig-c-svg-arrow fig-c-pyramid-leader" data-on={on} d={`M${plan.apexX + half(middle) + 8} ${middle} H${NOTE_X - 10}`} />
                {notes.map((note, i) => (
                  <text key={note} x={NOTE_X} y={middle - 4 + (i - (notes.length - 1) / 2) * 20} className={i === 0 ? 'fig-c-svg-strong' : 'fig-c-svg-note'}>{note}</text>
                ))}
              </>
            )}
          </g>
        );
      })}
    </FigureSvg>
  );
}

function TestingPyramid() {
  const [level, setLevel] = useState<Level>('unit');
  const chosen = LEVELS.find((item) => item.value === level)!;
  return (
    <Figure
      className="fig-c testing-pyramid"
      title="The testing pyramid"
      model
      howTo="Choose a level to see TaskTrackr’s tool there and what that tool cannot see."
      description="Width means how many checks you usually keep at a level: more at the bottom, fewer at the top. It is not a quota. Each level answers a different question, and each has a boundary it does not cross. The top level is dashed because the Testing room has no real browser."
    >
      <ToggleSet label="Test level" options={LEVELS} value={level} onChange={setLevel} />
      <div className="fig-c-pyramid-layout">
      <div className="fig-c-pyramid-art">
        <PyramidSvg plan={PYRAMID.wide} level={level} />
        <PyramidSvg plan={PYRAMID.compact} level={level} compact />
      </div>
      <div className="fig-c-panel" aria-live="polite" data-testid="pyramid-panel">
        <p className="fig-c-panel-head"><strong>{chosen.label}</strong><span>{chosen.width}</span></p>
        <dl>
          <dt>Tool</dt><dd>{chosen.tool}</dd>
          <dt>A claim it fits</dt><dd>{chosen.claim}</dd>
          <dt>Cannot see</dt><dd>{chosen.blind}</dd>
        </dl>
      </div>
      </div>
    </Figure>
  );
}

/* ----------------------------- chapter 2: fixture isolation ----------------------------- */

/** Two tests that each count the tasks in the Home list. */
export const ISOLATION_TESTS = [
  { name: 'A', adds: ['Pay the rent'], expects: 1 },
  { name: 'B', adds: ['Water the plants', 'Book the dentist'], expects: 2 },
] as const;
/** A count of tasks in words: "1 task", "2 tasks". */
export const tasks = (n: number) => `${n} ${pluralWord(n, 'task')}`;
type Database = 'shared' | 'fresh';
type Order = 'ab' | 'ba';

/** What each test counts, given the database and the order they run in. */
export function isolationRun(database: Database, order: Order) {
  const run = order === 'ab' ? ISOLATION_TESTS : [...ISOLATION_TESTS].reverse();
  let stored = 0;
  return run.map((test) => {
    stored = (database === 'shared' ? stored : 0) + test.adds.length;
    return { ...test, saw: stored, passed: stored === test.expects };
  });
}

function FixtureIsolation() {
  const [database, setDatabase] = useState<Database>('shared');
  const [order, setOrder] = useState<Order>('ab');
  const results = isolationRun(database, order);
  const failing = results.filter((r) => !r.passed).map((r) => `Test ${r.name}`);
  return (
    <Figure
      className="fig-c"
      title="Same tests, other order"
      howTo="Switch the database between shared and fresh, then run the tests in the other order."
      model
      description="Each test adds tasks to the Home list and counts them. With one shared database the second test also counts the first test’s tasks, so whichever runs second fails. With a fresh database per test, both pass in either order."
    >
      <div className="fig-c-row">
        <div><span className="fig-c-label">Database</span>
          <ToggleSet label="Database" options={[{ value: 'shared', label: 'Shared by both tests' }, { value: 'fresh', label: 'Fresh for each test' }]} value={database} onChange={setDatabase} />
        </div>
        <div><span className="fig-c-label">Run order</span>
          <ToggleSet label="Run order" options={[{ value: 'ab', label: 'A then B' }, { value: 'ba', label: 'B then A' }]} value={order} onChange={setOrder} />
        </div>
      </div>
      <ScrollRegion label="Fixture isolation results" hint="Scroll sideways to see every column.">
        <table className="fig-table" style={{ marginTop: 12 }}>
          <caption>What each test saw, in run order</caption>
          <thead><tr><th scope="col">Test</th><th scope="col">Adds</th><th scope="col">Expects</th><th scope="col">Saw</th><th scope="col">Result</th></tr></thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.name} data-test={r.name}>
                <th scope="row">Test {r.name}</th>
                <td>{r.adds.join(', ')}</td>
                <td>{tasks(r.expects)}</td>
                <td>{tasks(r.saw)}</td>
                <td><StatusMark status={r.passed ? 'passed' : 'failed'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <p className="fig-live" aria-live="polite" data-testid="isolation-live">
        {failing.length ? `${failing.join(' and ')} failed: it counted tasks another test left behind. The product did nothing wrong.` : 'Both tests passed. Each started from its own empty list.'}
      </p>
    </Figure>
  );
}

/* ----------------------------- chapter 2: response, later read, restart ----------------------------- */

/** Three observations of one created task, and how far each reaches. The
 * rows are the claims of the chapter's evidence table. */
export const OBSERVATIONS = [
  { value: 'post', label: 'POST response', sub: 'Creation boundary', supports: 'Creation response matches those fields', outside: 'A later read returns the same state', observation: 'POST returns the promised defaults' },
  { value: 'get', label: 'Later GET', sub: 'Read boundary', supports: 'That read path exposes the stored task', outside: 'State survives a process restart', observation: 'GET returns the created task in this test process' },
  { value: 'restart', label: 'Restart and read', sub: 'Restart boundary', supports: 'That restart scenario retained those records', outside: 'Every client and every failure mode', observation: 'A fresh process reads the same persisted data' },
] as const;
type Observation = (typeof OBSERVATIONS)[number]['value'];

function ReadRestart() {
  const [seen, setSeen] = useState<Observation>('post');
  const reach = OBSERVATIONS.findIndex((item) => item.value === seen);
  return (
    <Figure
      className="fig-c"
      title="A later read strengthens one claim, not every claim"
      howTo="Choose an observation. The boxes it reaches are marked; the table says what it supports and what it leaves out."
      model="Proposed observations, not recorded executions"
      scroll
    >
      <ToggleSet label="Observation" options={OBSERVATIONS} value={seen} onChange={setSeen} />
      <FigureSvg
        title="Response, later read and restart are different observations"
        description="A POST response checks returned fields. A later GET in the same test process checks that read path. Restart durability requires a separate restart and read against the same persisted data. These are proposed observations, not recorded executions."
        viewBox="0 0 1000 84"
        minWidth={720}
      >
        {OBSERVATIONS.map((item, i) => (
          <g key={item.value}>
            <rect className="fig-c-svg-box" data-on={i <= reach} x={10 + i * 340} y={12} width={300} height={60} rx={8} />
            <text x={160 + i * 340} y={37} textAnchor="middle" className="fig-c-svg-strong">{item.label}</text>
            <text x={160 + i * 340} y={58} textAnchor="middle" className="fig-c-svg-note">{i <= reach ? `${item.sub}: reached` : `${item.sub}: not reached`}</text>
            {i < 2 && <path className="fig-c-svg-arrow" data-on={i < reach} d={arrowPath(314 + i * 340, 42, 346 + i * 340, 42, 8)} />}
          </g>
        ))}
      </FigureSvg>
      <ScrollRegion label="What each observation supports" hint="Scroll sideways to see every column.">
      <table className="fig-table fig-c-table" style={{ marginTop: 12 }}>
        <caption>A later read strengthens one claim, not every claim</caption>
        <thead><tr><th scope="col">Observation</th><th scope="col">Supported inference</th><th scope="col">Still outside that observation</th></tr></thead>
        <tbody>
          {OBSERVATIONS.map((item) => (
            <tr key={item.value} data-on={item.value === seen}>
              <th scope="row">{item.observation}</th><td>{item.supports}</td><td>{item.outside}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </ScrollRegion>
      <p className="fig-live" aria-live="polite" data-testid="read-live">{OBSERVATIONS[reach].label}: supports “{OBSERVATIONS[reach].supports}”. Still outside: {OBSERVATIONS[reach].outside}.</p>
    </Figure>
  );
}

/* ----------------------------- chapter 3: the boundary slider ----------------------------- */

/** The reporting day of the visible equal-day test (overdue.test.ts). */
export const REPORTING_DAY = '2026-03-14';
/** Five tasks the learner slides between, as the overdue rule sees them. */
export const BOUNDARY_CASES = [
  { label: 'Due 2026-03-13, the day before', due: '2026-03-13', done: false },
  { label: 'Due 2026-03-14, the reporting day', due: '2026-03-14', done: false },
  { label: 'Due 2026-03-15, the day after', due: '2026-03-15', done: false },
  { label: 'No due date', due: null, done: false },
  { label: 'Done, was due 2026-03-13', due: '2026-03-13', done: true },
] as const;

/** Overdue under one comparison; undated and done tasks are never overdue under either. */
export function overdueUnder(rule: 'lt' | 'le', c: (typeof BOUNDARY_CASES)[number]): boolean {
  if (!c.due || c.done) return false;
  return rule === 'lt' ? c.due < REPORTING_DAY : c.due <= REPORTING_DAY;
}
const word = (overdue: boolean) => (overdue ? 'Overdue' : 'Not overdue');

/** The two rules, drawn in code type wherever the figure's words name them. */
const RULES_AS_CODE = ['due < today', 'due <= today'];

function BoundarySlider() {
  const [at, setAt] = useState(0);
  const c = BOUNDARY_CASES[at];
  const lt = overdueUnder('lt', c);
  const le = overdueUnder('le', c);
  return (
    <Figure
      className="fig-c"
      title="Where due < today and due <= today disagree"
      howTo="Move the slider through five tasks. Watch the two rule columns."
      model
      code={RULES_AS_CODE}
      description={`The reporting day is fixed at ${REPORTING_DAY}. Both rules agree on the day before, the day after, an undated task and a done task. They disagree only on the reporting day itself, so only an equal-day test can tell them apart. US-4 says strictly before: due < today.`}
    >
      <label className="fig-c-slider">
        <span className="fig-c-label">Task (reporting day {REPORTING_DAY})</span>
        <input type="range" min={0} max={BOUNDARY_CASES.length - 1} step={1} value={at} aria-valuetext={c.label} onChange={(event) => setAt(Number(event.currentTarget.value))} />
        <span className="fig-c-ticks" aria-hidden="true"><span>Before</span><span>Equal</span><span>After</span><span>None</span><span>Done</span></span>
      </label>
      <ScrollRegion label="Overdue rules compared" hint="Scroll sideways to see every column.">
        <table className="fig-table fig-c-table">
          <caption>Two overdue rules on five tasks</caption>
          <thead><tr><th scope="col">Task</th><th scope="col"><code>due &lt; today</code> (US-4)</th><th scope="col"><code>due &lt;= today</code></th></tr></thead>
          <tbody>
            {BOUNDARY_CASES.map((item, i) => {
              const a = overdueUnder('lt', item);
              const b = overdueUnder('le', item);
              return (
                <tr key={item.label} data-on={i === at} data-case={i}>
                  <th scope="row">{item.label}{a !== b && <span className="fig-c-disagree">They disagree here</span>}</th>
                  <td>{word(a)}</td><td>{word(b)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollRegion>
      <p className="fig-live" aria-live="polite" data-testid="boundary-live">
        {c.label}. <code className="code-fragment">due &lt; today</code>: {word(lt)}. <code className="code-fragment">due &lt;= today</code>: {word(le)}. {lt === le ? 'The rules agree here.' : 'They disagree here: only this case can catch the wrong comparison.'}
      </p>
    </Figure>
  );
}

/* ----------------------------- the mutation table ----------------------------- */

/* Illustrative planted bugs, not the ones in the Testing room. The room's
 * eight planted bugs (content/tasktrackr/phases/04-testing/mutants) all change
 * tasks, the overdue report, the filters or the row's late marker; none of them
 * touches lists. These five are planted in the supplied lists feature
 * (api/repository/lists.py and api/routes/lists.py), so the table teaches how
 * to read a kill matrix without naming, or hinting at, a graded bug.
 *
 * The kill map below follows from each test as its button words it and each
 * bug as its row describes it; the truth table, one clause per cell:
 *
 *                     open_count  empty_name  lists_newest  duplicate_name  task_count
 *                     _counts_    _accepted   _first        _not_refused    _by_id
 *                     done
 *   new-list          survives    survives    survives      survives        survives
 *   open-and-done     KILLS       survives    survives      survives        survives
 *   only-done         KILLS       survives    survives      survives        survives
 *   empty-name        survives    KILLS       survives      survives        survives
 *   made-order        survives    survives    KILLS         survives        survives
 *
 * - new-list: a new list has no tasks (both counts are 0 with or without a
 *   finished task counted, and with COUNT(t.id) as with COUNT(*)), its name
 *   Home is not empty, one list has one order, and one name cannot clash.
 * - open-and-done: the bug counts the finished task, so open_count is 2, not 1.
 *   It sends a valid name, reads one list, and makes no second list of one name.
 * - only-done: the bug counts the finished task, so open_count is 1, not 0.
 *   Otherwise as open-and-done.
 * - empty-name: the bug saves the empty name and answers 201, not 400. The test
 *   makes one list at most and reads no counts.
 * - made-order: the bug answers Work, Home. Home and Work are different,
 *   non-empty names, and the lists hold no tasks.
 * - duplicate_name_not_refused survives every test: none makes two lists with
 *   one name. task_count_by_id survives every test, and would survive any:
 *   t.id is never empty, so COUNT(t.id) equals COUNT(*). It is an equivalent
 *   mutant.
 */

/** Five illustrative planted bugs in the supplied lists feature. */
export const MUTANTS = [
  { name: 'open_count_counts_done', change: 'A list’s open_count also counts its finished tasks.' },
  { name: 'empty_name_accepted', change: 'An empty name is saved: POST /api/lists answers 201, not 400 invalid_name.' },
  { name: 'lists_newest_first', change: 'GET /api/lists returns the newest list first, not the order the lists were made in.' },
  { name: 'duplicate_name_not_refused', change: 'A second list called Home is no longer refused with 409 duplicate_list.' },
  { name: 'task_count_by_id', change: 'task_count counts t.id instead of every row. Every task has an id, so every count comes out the same.' },
] as const;
export type MutantName = (typeof MUTANTS)[number]['name'];

/** Five illustrative tests a learner might write for the lists feature. `how`
 * says how a test catches its bug, for the line that explains a test that
 * changes nothing. */
export const TESTS = [
  { value: 'new-list', label: 'A new list Home has task_count 0 and open_count 0', how: 'A new list has no tasks and a plain name, so every planted copy answers as the healthy code does.' },
  { value: 'open-and-done', label: 'One open and one finished task: open_count is 1', how: 'a finished task counted as open' },
  { value: 'only-done', label: 'One finished task only: open_count is 0', how: 'a finished task counted as open' },
  { value: 'empty-name', label: 'An empty name gets 400 invalid_name', how: 'an empty name that is not refused' },
  { value: 'made-order', label: 'Home, then Work: they come back as Home, Work', how: 'lists returned out of the order they were made in' },
] as const;
export type TestId = (typeof TESTS)[number]['value'];

/** Which planted bugs each test kills: the truth table above. */
export const KILLS: Record<TestId, readonly MutantName[]> = {
  'new-list': [],
  'open-and-done': ['open_count_counts_done'],
  'only-done': ['open_count_counts_done'],
  'empty-name': ['empty_name_accepted'],
  'made-order': ['lists_newest_first'],
};

/** The suite the figure opens with: two tests, two kills. */
export const START_TESTS: readonly TestId[] = ['open-and-done', 'empty-name'];

export function killedBy(tests: readonly TestId[]): Set<MutantName> {
  return new Set(tests.flatMap((test) => KILLS[test]));
}

const labelOf = (test: TestId) => TESTS.find((t) => t.value === test)!.label;

/**
 * Why switching one test on or off changed no result: it catches nothing
 * here, or every bug it catches is caught the same way by a test still on.
 */
export function noChangeReason(toggled: TestId, on: boolean, others: readonly TestId[]): string {
  const kills = KILLS[toggled];
  const test = TESTS.find((t) => t.value === toggled)!;
  if (!kills.length) return `“${test.label}” catches none of these planted bugs. ${test.how}`;
  const twin = others.find((other) => kills.every((name) => KILLS[other].includes(name)))!;
  return on
    ? `${kills.join(' and ')} was already killed by “${labelOf(twin)}”. This test catches it the same way: ${test.how}.`
    : `${kills.join(' and ')} is still killed by “${labelOf(twin)}”, which catches it the same way: ${test.how}.`;
}

type Healthy = 'passed' | 'failed';
const HEALTHY_OPTIONS = [
  { value: 'passed', label: 'Passed' },
  { value: 'failed', label: 'Failed' },
] as const;

export function MutationTable() {
  const [tests, setTests] = useState<TestId[]>([...START_TESTS]);
  const [healthy, setHealthy] = useState<Healthy>('passed');
  const [message, setMessage] = useState('');
  const [changed, setChanged] = useState<{ names: ReadonlySet<MutantName>; pulse: number }>({ names: new Set(), pulse: 0 });
  const killed = killedBy(tests);
  const score = `Killed ${killed.size} of ${MUTANTS.length}`;

  const changeTests = (next: TestId[]) => {
    const after = killedBy(next);
    const nowKilled = MUTANTS.filter((m) => after.has(m.name) && !killed.has(m.name)).map((m) => m.name);
    const nowSurvive = MUTANTS.filter((m) => killed.has(m.name) && !after.has(m.name)).map((m) => m.name);
    const total = `Killed ${after.size} of ${MUTANTS.length}.`;
    const parts = [
      ...nowKilled.map((name) => `${name} is now killed.`),
      ...nowSurvive.map((name) => `${name} survives again.`),
    ];
    const toggled = [...next.filter((t) => !tests.includes(t)), ...tests.filter((t) => !next.includes(t))][0];
    const on = next.includes(toggled);
    setTests(next);
    setChanged({ names: new Set([...nowKilled, ...nowSurvive]), pulse: changed.pulse + 1 });
    if (healthy === 'failed') setMessage('The healthy run still fails, so the planted bugs are not evaluated yet.');
    else setMessage(parts.length ? `${parts.join(' ')} ${total}` : `No result changed: ${noChangeReason(toggled, on, on ? tests : next)} ${total}`);
  };
  const changeHealthy = (next: Healthy) => {
    setHealthy(next);
    setChanged({ names: new Set(MUTANTS.map((m) => m.name)), pulse: changed.pulse + 1 });
    setMessage(next === 'failed'
      ? 'The healthy run failed, so every planted bug is Not evaluated. Fix the healthy run first.'
      : `The healthy run passed, so the results mean something again. ${score}.`);
  };

  return (
    <Figure
      className="fig-c"
      title="The mutation table"
      howTo="Switch tests on and off to see which planted bugs they kill. Then set the healthy run to Failed."
      model="Illustrative planted bugs, not the ones in your Testing room. Your real kill matrix is in the room after you submit."
      description="Each row is a copy of TaskTrackr with one bug planted on purpose in its lists feature. Killed means at least one switched-on test failed on that copy. Survived means every test still passed, so the suite cannot tell that copy from the real one. The Testing room plants its own eight bugs elsewhere and shows them after your first submission."
    >
      <div className="fig-mutation-controls">
        <div>
          <span>Healthy run</span>
          <ToggleSet label="Healthy run" options={HEALTHY_OPTIONS} value={healthy} onChange={changeHealthy} />
        </div>
        <div>
          <span>Your suite</span>
          <ToggleSet multiple label="Tests in your suite" options={TESTS} value={tests} onChange={changeTests} />
        </div>
      </div>
      {healthy === 'passed' ? (
        <p className="fig-mutation-score" data-testid="mutation-score">
          <svg viewBox={`0 0 ${MUTANTS.length * 19} 18`} aria-hidden="true" focusable="false">
            {MUTANTS.map((m, i) => (
              <rect
                key={m.name}
                x={i * 19 + 1}
                y={1.5}
                width={15}
                height={15}
                rx={3}
                strokeWidth={1.5}
                className={killed.has(m.name) ? 'fig-score-killed' : 'fig-score-survived'}
              />
            ))}
          </svg>
          <span>{score}</span>
        </p>
      ) : (
        <p className="fig-mutation-blocked">Fix the healthy run first. While the healthy code fails, a failure on a mutant proves nothing, and the Testing room does not run its planted bugs until your suite passes on the healthy code.</p>
      )}
      <ScrollRegion label="Mutation table" hint="Scroll sideways to see every column.">
        {/* At a phone's width each row draws as a small card (bug and verdict on
          * one line, what it changes below); the roles keep it a table for a
          * screen reader whatever its display. */}
        <table className="fig-table fig-c-mutants" role="table">
          <caption>Illustrative planted bugs, not the ones in your Testing room</caption>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">Planted bug</th>
              <th scope="col" role="columnheader">What it changes</th>
              <th scope="col" role="columnheader">Your suite</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {MUTANTS.map((m) => {
              const isChanged = changed.names.has(m.name);
              return (
                <tr key={`${m.name}-${isChanged ? changed.pulse : 0}`} role="row" data-mutant={m.name} data-changed={isChanged ? 'true' : undefined}>
                  <th scope="row" role="rowheader"><code>{wordBreaks(m.name)}</code></th>
                  <td role="cell" data-col="change">{m.change}</td>
                  <td role="cell" data-col="verdict">
                    {healthy === 'failed' ? (
                      <StatusMark status="not-run" label="Not evaluated" />
                    ) : (
                      <StatusMark status={killed.has(m.name) ? 'killed' : 'survived'} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollRegion>
      <p className="fig-live" aria-live="polite" data-testid="mutation-live">{wordBreaks(message)}</p>
    </Figure>
  );
}

/** One line per figure. Chapters are numbered as the reader shows them (1 to 4). */
export const TESTING_FIGURES: PhaseFigures = {
  'testing-pyramid': { chapter: 1, component: TestingPyramid },
  'testing-fixture-isolation': { chapter: 2, component: FixtureIsolation },
  'testing-response-read-restart': { chapter: 2, component: ReadRestart },
  'testing-boundary-slider': { chapter: 3, component: BoundarySlider },
  'testing-mutation-table': { chapter: 4, component: MutationTable },
};
