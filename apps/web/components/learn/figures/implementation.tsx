'use client';
import { Fragment, useRef, useState, type KeyboardEvent } from 'react';
import type { PhaseFigures } from './types';
import { ScrollRegion } from '@/components/experience/ScrollRegion';
import { Figure, FigureSvg } from './Figure';
import { StatusMark, type FigureStatus } from './StatusMark';
import { StepThrough } from './StepThrough';
import { ToggleSet } from './ToggleSet';
import { codeFragments, wordBreaks } from './CodeText';
import './implementation-testing.css';

/* The Implementation guide's figures. Every file
 * name, function, test and rule below is read from the TaskTrackr
 * Implementation phase (content/tasktrackr/phases/03-implementation). */

/* ------------------------------ chapter 1: the file map ------------------------------ */

/** The four editable files and their five gaps, with what to read first. */
export const GAPS = [
  { value: 'list_tasks', file: 'api/repository/tasks.py', side: 'Python API', story: 'US-3', first: 'get_task, in the same file', layer: 'Repository: reads and writes the database, never speaks HTTP.', helper: 'TASK_SELECT and PRIORITY_ORDER at the top of the file are already written.', read: 'get_task in the same file: it adds WHERE t.id = ? to TASK_SELECT and passes the value separately.' },
  { value: 'overdue_tasks', file: 'api/repository/tasks.py', side: 'Python API', story: 'US-4', first: 'Its own docstring', layer: 'Repository: one SELECT over the tasks table.', helper: 'TASK_SELECT and PRIORITY_ORDER again. The day arrives as an argument.', read: 'Its own docstring: open tasks strictly before today, no due date is never overdue, most overdue first.' },
  { value: 'complete_task', file: 'api/routes/tasks.py', side: 'Python API', story: 'US-2', first: 'reopen_task, just below it', layer: 'Route: turns a repository answer into HTTP.', helper: 'repository.tasks.complete_task already raises for an unknown id, and errors.py builds the 404.', read: 'reopen_task just below it: the finished neighbour that catches KeyError and answers task_not_found.' },
  { value: 'isOverdue', file: 'web/src/lib/overdue.ts', side: 'TypeScript front end', story: 'US-4, US-5', first: 'The comment above it', layer: 'Browser helper: a pure function over data the browser already has.', helper: 'daysLate below it calls it, and byMostOverdue calls daysLate; TaskRow calls it too, so its answer reaches the row.', read: 'The comment above it: three sentences, three conditions, one of them the boundary.' },
  { value: 'useTasks', file: 'web/src/hooks/useTasks.ts', side: 'TypeScript front end', story: 'US-3', first: 'useLists, in its own read-only file', layer: 'Browser hook: asks the API and holds tasks, loading and error.', helper: 'queryFor above it builds a query of only the filters that are set; getJson is in ../api/client.', read: 'useLists in web/src/hooks/useLists.ts: the finished hook that loads the lists.' },
] as const;
export type GapName = (typeof GAPS)[number]['value'];

/* The map draws each editable file as a box of its rows, in the file's own
 * order: a finished row (written for you), a gap (a dashed hole, a real
 * button) and, between a gap and the finished thing to read before it, a
 * "read first" arrow. Only names are drawn, each one already in the phase
 * brief or in a file the room shows: never a line of a gap's body. */
export type MapRow =
  | { kind: 'given'; name: string; note: string; readFor?: GapName }
  | { kind: 'gap'; gap: GapName }
  | { kind: 'read'; gap: GapName; dir: 'down' | 'up' };
export type MapFile = { file: string; locked?: boolean; rows: readonly MapRow[] };
export const FILE_LANES: readonly { lane: string; note: string; files: readonly MapFile[] }[] = [
  {
    lane: 'Python API',
    note: 'Flask routes over a SQLite repository',
    files: [
      {
        file: 'api/repository/tasks.py',
        rows: [
          { kind: 'given', name: 'TASK_SELECT, PRIORITY_ORDER', note: 'Written above the stubs' },
          { kind: 'given', name: 'get_task', note: 'Finished', readFor: 'list_tasks' },
          { kind: 'read', gap: 'list_tasks', dir: 'down' },
          { kind: 'gap', gap: 'list_tasks' },
          { kind: 'given', name: 'The docstring of overdue_tasks', note: 'The rule in words', readFor: 'overdue_tasks' },
          { kind: 'read', gap: 'overdue_tasks', dir: 'down' },
          { kind: 'gap', gap: 'overdue_tasks' },
          { kind: 'given', name: 'complete_task', note: 'The supplied repository helper' },
        ],
      },
      {
        file: 'api/routes/tasks.py',
        rows: [
          { kind: 'gap', gap: 'complete_task' },
          { kind: 'read', gap: 'complete_task', dir: 'up' },
          { kind: 'given', name: 'reopen_task', note: 'Finished, just below', readFor: 'complete_task' },
        ],
      },
    ],
  },
  {
    lane: 'TypeScript front end',
    note: 'React hooks and helpers in the browser',
    files: [
      {
        file: 'web/src/lib/overdue.ts',
        rows: [
          { kind: 'given', name: 'The comment above isOverdue', note: 'The rule in three sentences', readFor: 'isOverdue' },
          { kind: 'read', gap: 'isOverdue', dir: 'down' },
          { kind: 'gap', gap: 'isOverdue' },
          { kind: 'given', name: 'daysLate, byMostOverdue', note: 'Finished: daysLate calls it, byMostOverdue calls daysLate' },
        ],
      },
      {
        file: 'web/src/hooks/useTasks.ts',
        rows: [
          { kind: 'given', name: 'queryFor', note: 'Finished' },
          { kind: 'gap', gap: 'useTasks' },
        ],
      },
      {
        file: 'web/src/hooks/useLists.ts',
        locked: true,
        rows: [{ kind: 'given', name: 'useLists', note: 'The finished hook for lists', readFor: 'useTasks' }],
      },
    ],
  },
];

/** A row's name with each identifier (snake_case, camelCase or CONSTANT) set as code. */
function codeWords(name: string) {
  return name.split(/(\s+)/).map((word, i) => {
    const bare = word.replace(/,$/, '');
    return /_|^[a-z]+[A-Z]/.test(bare)
      ? <Fragment key={i}><code>{wordBreaks(bare)}</code>{word.endsWith(',') ? ',' : ''}</Fragment>
      : word;
  });
}

/** The arrow glyph of a "read first" link: a line and an open head, one stroke. */
function ReadArrow({ dir }: { dir: 'down' | 'up' | 'left' }) {
  const d = dir === 'down' ? 'M8 2 V20 M3 15 L8 20 L13 15' : dir === 'up' ? 'M8 20 V2 M3 7 L8 2 L13 7' : 'M26 8 H2 M7 3 L2 8 L7 13';
  const box = dir === 'left' ? '0 0 28 16' : '0 0 16 22';
  return (
    <svg className="fig-c-link-arrow" viewBox={box} aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

function FileMap() {
  // No gap is chosen before the first press: every gap's "read first" arrow
  // is drawn faint, and the panel lists what to read before each gap, so the
  // map makes its point unpressed. A press makes that
  // gap's arrow heavy and opens its panel.
  const [gap, setGap] = useState<GapName | null>(null);
  const chosen = gap ? GAPS.find((item) => item.value === gap)! : null;
  const holes = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(holes.current?.querySelectorAll<HTMLButtonElement>('button.fig-c-hole') ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const to =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (at + 1) % buttons.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (at - 1 + buttons.length) % buttons.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
      : null;
    if (to === null) return;
    event.preventDefault();
    buttons[to].focus();
  };
  const row = (item: MapRow, i: number) => {
    if (item.kind === 'gap') {
      const g = GAPS.find((x) => x.value === item.gap)!;
      return (
        <li key={i}>
          <button
            type="button"
            className="fig-button fig-c-hole"
            data-gap={g.value}
            aria-pressed={gap === g.value}
            aria-label={`${g.value}: your gap, ${g.story}`}
            onClick={() => setGap(g.value)}
          >
            <span className="fig-c-hole-name">
              {gap === g.value && (
                <svg className="fig-toggle-tick" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              <code>{wordBreaks(g.value)}</code>
            </span>
            <span className="fig-c-hole-note">TODO(learner), {g.story}</span>
          </button>
        </li>
      );
    }
    if (item.kind === 'read') {
      return (
        <li key={i} className="fig-c-link" data-on={gap === item.gap} data-dir={item.dir} aria-hidden="true">
          <ReadArrow dir={item.dir} /><span>read first</span>
        </li>
      );
    }
    return (
      <li key={i} className="fig-c-given" data-on={item.readFor === gap} data-read-for={item.readFor}>
        <span className="fig-c-given-name">{codeWords(item.name)}</span>
        <span className="fig-c-given-note">{item.readFor === gap ? `Read this first. ${item.note}` : item.note}</span>
      </li>
    );
  };
  return (
    <Figure
      className="fig-c"
      title="Four files, five gaps"
      howTo="Choose a gap, a dashed hole in the map, to see its layer, what is already there and what to read first."
      model="Read from the supplied TaskTrackr files, not from your saved work"
      description="TaskTrackr's Implementation room lets you edit four files. Three gaps are in the Python API and two in the TypeScript front end; each is marked TODO(learner). Every gap has a finished neighbour, and the arrow points from it to the gap: read it before you write."
    >
      <ul className="fig-c-legend" aria-label="How to read the map">
        <li><span className="fig-c-key" data-kind="given" aria-hidden="true" />Written for you</li>
        <li><span className="fig-c-key" data-kind="gap" aria-hidden="true" />Your gap</li>
        <li><span className="fig-c-key" data-kind="read" aria-hidden="true"><ReadArrow dir="left" /></span>Read this first</li>
      </ul>
      <div ref={holes} className="fig-c-lanes-map" role="group" aria-label="The five gaps" onKeyDown={onKeyDown} data-testid="file-map">
        {FILE_LANES.map((lane) => (
          <section key={lane.lane} className="fig-c-lane" aria-label={lane.lane}>
            <header className="fig-c-lane-head">
              <strong>{lane.lane}</strong>
              <span>{lane.note}</span>
            </header>
            <div className="fig-c-lane-files" data-count={lane.files.length}>
              {lane.files.map((file) => (
                <Fragment key={file.file}>
                  {file.locked && (
                    <div className="fig-c-cross" data-on={file.rows.some((r) => r.kind === 'given' && r.readFor === gap)} aria-hidden="true">
                      <ReadArrow dir="left" /><span>read first</span>
                    </div>
                  )}
                  <div className="fig-c-file" data-locked={file.locked ? 'true' : undefined}>
                    <p className="fig-c-file-head">
                      <code>{wordBreaks(file.file)}</code>
                      <span className="fig-c-file-tag">{file.locked ? 'Read only' : 'You edit this file'}</span>
                    </p>
                    <ol className="fig-c-file-rows">{file.rows.map(row)}</ol>
                  </div>
                </Fragment>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="fig-c-panel" aria-live="polite" data-testid="file-map-panel">
        {chosen ? (
          <dl>
            <dt>Gap</dt><dd><code>{wordBreaks(chosen.value)}</code> in <code>{wordBreaks(chosen.file)}</code></dd>
            <dt>Layer</dt><dd>{wordBreaks(chosen.layer)}</dd>
            <dt>Already there</dt><dd>{wordBreaks(chosen.helper)}</dd>
            <dt>Read first</dt><dd>{wordBreaks(chosen.read)}</dd>
          </dl>
        ) : (
          <>
            <p className="fig-c-panel-head"><strong>Each gap, and what to read before it</strong></p>
            <dl data-testid="file-map-firsts">
              {GAPS.map((g) => (
                <Fragment key={g.value}>
                  <dt><code>{wordBreaks(g.value)}</code></dt><dd>{codeWords(g.first)}</dd>
                </Fragment>
              ))}
            </dl>
          </>
        )}
      </div>
    </Figure>
  );
}

/* ------------------------------ chapter 2: the lookup by name ------------------------------ */

/* The supplied lists repository (readonly/api/repository/lists.py) builds every
 * read from LIST_SELECT, and get_list adds `WHERE l.id = ?` with (list_id,).
 * This figure's lookup has the same shape on the name instead of the id. It is
 * illustrative: TaskTrackr has no lookup by name, and no gap of any phase uses
 * it, so nothing here can be pasted into a graded gap. Every result below was
 * run in SQLite over the three lists in LISTS_IN_DATABASE (the test runs the
 * printed SQL again, on the real LIST_SELECT). */

/** The three lists in the figure's database. Illustrative rows, not the seed. */
export const LISTS_IN_DATABASE = ['Home', 'Work', "Sam's reading"] as const;

/** Names a person might type, exactly as they reach the code (a straight apostrophe). */
export const NAMES = [
  { value: 'Home', label: 'Home', code: true },
  { value: "Sam's reading", label: "Sam's reading", code: true },
  { value: "x' OR 1=1 --", label: "x' OR 1=1 --", code: true },
] as const;
export type TypedName = (typeof NAMES)[number]['value'];
type Binding = 'bound' | 'pasted';

/** Python's repr of a one-item tuple, as the driver's values read in the code. */
const tupleOf = (text: string) => (text.includes("'") ? `("${text}",)` : `('${text}',)`);

/**
 * The lookup's WHERE line, the values sent beside it, and what SQLite does with
 * it over LISTS_IN_DATABASE: the lists it returns, or `error` when it refuses
 * the statement.
 */
export function buildLookup(name: TypedName, binding: Binding) {
  const quote = name.indexOf("'");
  const where: { sql: string; injected?: string } =
    binding === 'bound' ? { sql: 'WHERE l.name = ?' }
    : quote < 0 ? { sql: `WHERE l.name = '${name}'` }
    : { sql: `WHERE l.name = '${name.slice(0, quote)}`, injected: `${name.slice(quote)}'` };
  const attack = name === "x' OR 1=1 --";
  const returns: readonly string[] | 'error' =
    binding === 'bound' ? LISTS_IN_DATABASE.filter((list) => list === name)
    : attack ? LISTS_IN_DATABASE
    : quote >= 0 ? 'error'
    : LISTS_IN_DATABASE.filter((list) => list === name);
  const verdict =
    binding === 'bound'
      ? name === 'Home' ? 'Safe: the SQL keeps its shape and the name travels on its own. It finds Home.'
      : attack ? 'Safe: the whole text is one name, and no list has that name, so it finds no list.'
      : 'Safe: the apostrophe stays part of the name, so it finds Sam\'s reading.'
    : attack ? 'Unsafe: the quote ends the name, OR 1=1 is true on every row, and -- turns the leftover quote into a comment. It returns every list in the database.'
    : quote >= 0 ? 'Broken: the apostrophe ends the quoted name early, so SQLite refuses the statement with a syntax error near "s".'
    : 'Works this time: it finds Home, but only because the name holds no quote. The next name may not be so kind.';
  const tone: 'pass' | 'warn' | 'fail' = binding === 'bound' ? 'pass' : quote < 0 ? 'warn' : 'fail';
  return { where, values: binding === 'bound' ? tupleOf(name) : null, returns, verdict, tone };
}

/** The SQL in the verdicts' words, drawn in code type. */
const VERDICT_CODE = ['OR 1=1'];

function QueryBuilder() {
  const [name, setName] = useState<TypedName>('Home');
  const [binding, setBinding] = useState<Binding>('bound');
  const query = buildLookup(name, binding);
  const sqlWords = `LIST_SELECT ${query.where.sql}${query.where.injected ?? ''}`;
  const returned = query.returns === 'error' ? 'Nothing: SQLite refuses the statement.' : query.returns.length ? query.returns.join(', ') : 'No list';
  return (
    <Figure
      className="fig-c"
      title="Values travel apart from the SQL"
      howTo="Pick the name a person typed, then switch how it reaches the database."
      model="Illustrative lookup by name on the supplied lists table. TaskTrackr looks a list up by its id, and no gap uses this query."
      description={<>The supplied <code>get_list</code> adds <code>WHERE l.id = ?</code> to <code>LIST_SELECT</code> and passes the id separately. This lookup has the same shape on the name, over three lists: {LISTS_IN_DATABASE.join(', ')}. With <code>?</code> the driver receives the name apart from the SQL, so a quote stays part of the name. Pasted into the SQL, the typed text can end the quote and change the statement.</>}
    >
      <div className="fig-c-row">
        <div><span className="fig-c-label">Name the person typed</span>
          <ToggleSet label="Typed name" options={NAMES} value={name} onChange={setName} />
        </div>
        <div><span className="fig-c-label">How the name reaches the database</span>
          <ToggleSet label="Value handling" options={[{ value: 'bound', label: 'Bound with ?', code: ['?'] }, { value: 'pasted', label: 'Pasted into the SQL' }]} value={binding} onChange={setBinding} />
        </div>
      </div>
      <div className="fig-c-row" data-cols="2" style={{ marginTop: 12 }}>
        <div><span className="fig-c-label">SQL the driver receives</span>
          <pre className="fig-c-code" data-testid="query-sql">{'LIST_SELECT\n'}{query.where.sql.split('?').map((piece, j, all) => <span key={j}>{piece}{j < all.length - 1 && <mark>?</mark>}</span>)}{query.where.injected && <mark data-kind="injected">{query.where.injected}</mark>}</pre>
        </div>
        <div><span className="fig-c-label">Values, sent separately</span>
          <pre className="fig-c-code" data-testid="query-values">{query.values ?? 'None: the name is inside the SQL'}</pre>
        </div>
      </div>
      <p className="fig-c-returns" data-testid="query-returns"><span className="fig-c-label">Lists it returns</span>{returned}</p>
      <p className="fig-verdict" data-tone={query.tone}>
        {binding === 'bound' ? 'Bound' : 'Pasted'}
      </p>
      <p className="fig-live" aria-live="polite" data-testid="query-live">{codeFragments(query.verdict, VERDICT_CODE)} The SQL reads: <code>{sqlWords}</code></p>
    </Figure>
  );
}

/* ------------------------------ chapter 3: request states ------------------------------ */

export const SCENARIOS = [
  { value: 'rows', label: 'Rows come back' },
  { value: 'empty', label: 'No rows come back' },
  { value: 'fails', label: 'The request fails' },
  { value: 'race', label: 'Choose list B before A answers' },
] as const;
type Scenario = (typeof SCENARIOS)[number]['value'];
const SCENARIO_TEXT: Record<Scenario, { end: 'rows' | 'empty' | 'failed'; screen: string; state: string }> = {
  rows: { end: 'rows', screen: 'The rows, in contract order.', state: 'loading false, error null, tasks has 3 items' },
  empty: { end: 'empty', screen: 'Empty-state guidance: this list has no tasks yet.', state: 'loading false, error null, tasks is []' },
  fails: { end: 'failed', screen: 'The error and a way to try again. Not “no tasks”.', state: 'loading false, error says the request failed, tasks is []' },
  race: { end: 'rows', screen: 'List B’s rows. List A’s late answer is dropped.', state: 'B’s answer is applied; A’s context ended, so its answer changes nothing' },
};

/**
 * A line from (x1, y1) to (x2, y2) with an open arrowhead at its end, as ONE
 * path: the head is drawn by the same stroke as the line, so it always takes
 * the line's colour and width (a marker keeps its own fill and stays grey on a
 * highlighted line).
 */
export function arrowPath(x1: number, y1: number, x2: number, y2: number, head = 10): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const wing = (turn: number) => {
    const a = angle + Math.PI + turn;
    return `${(x2 + head * Math.cos(a)).toFixed(1)} ${(y2 + head * Math.sin(a)).toFixed(1)}`;
  };
  return `M${x1} ${y1} L${x2} ${y2} M${wing(0.5)} L${x2} ${y2} L${wing(-0.5)}`;
}

/* Request states, drawn at a width close to the figure's own at 1440, so the
 * diagram's words come out at about the size of the page's. */
const STATE_BOXES = {
  idle: { x: 20, y: 86, w: 200 },
  loading: { x: 360, y: 86, w: 200 },
  rows: { x: 720, y: 14, w: 260 },
  empty: { x: 720, y: 86, w: 260 },
  failed: { x: 720, y: 158, w: 260 },
} as const;
const STATE_H = 52;
/** Where the "choose" arrow runs, and where its label sits: above the line and clear of the head. */
export const CHOOSE_ARROW = { x1: 220, x2: 356, y: 112, label: { x: 280, y: 100 } } as const;

function RequestStates() {
  const [scenario, setScenario] = useState<Scenario>('rows');
  const s = SCENARIO_TEXT[scenario];
  const box = (at: { x: number; y: number; w: number }, label: string, sub: string, on: boolean, tone?: 'fail') => (
    <g>
      <rect className="fig-c-svg-box" data-on={on} data-tone={tone} x={at.x} y={at.y} width={at.w} height={STATE_H} rx={8} />
      <text x={at.x + at.w / 2} y={at.y + 22} textAnchor="middle" className="fig-c-svg-strong">{label}</text>
      <text x={at.x + at.w / 2} y={at.y + 42} textAnchor="middle" className="fig-c-svg-note">{sub}</text>
    </g>
  );
  const from = STATE_BOXES.loading.x + STATE_BOXES.loading.w;
  const to = STATE_BOXES.rows.x - 4;
  const mid = (key: 'rows' | 'empty' | 'failed') => STATE_BOXES[key].y + STATE_H / 2;
  return (
    <Figure
      className="fig-c"
      title="One empty array, three different states"
      howTo="Choose what happens to the request. The highlighted path is the one the hook takes."
      model
      description="An active request starts loading and can resolve with data or an error. Cleanup makes the former request context inactive so its later callbacks cannot overwrite the current state. Loading, an empty answer and a failure can all hold an empty array; only loading and error tell them apart."
      scroll
    >
      <ToggleSet label="What the request does" options={SCENARIOS} value={scenario} onChange={setScenario} />
      <FigureSvg
        title="The list hook's request states"
        description={`No list chosen asks for nothing. Choosing a list starts Loading. Loading ends in Rows, No rows or Failed. Now showing: ${SCENARIOS.find((o) => o.value === scenario)!.label}. Hook state: ${s.state}.`}
        viewBox="0 0 1000 224"
        minWidth={760}
        className="fig-c-states"
      >
        {box(STATE_BOXES.idle, 'No list chosen', 'listId is null', false)}
        {box(STATE_BOXES.loading, 'Loading', 'tasks is []', true)}
        {box(STATE_BOXES.rows, 'Rows', 'tasks has items', s.end === 'rows')}
        {box(STATE_BOXES.empty, 'No rows', 'tasks is [] after success', s.end === 'empty')}
        {box(STATE_BOXES.failed, 'Failed', 'error set, tasks is []', s.end === 'failed', s.end === 'failed' ? 'fail' : undefined)}
        <path className="fig-c-svg-arrow" data-on="true" data-edge="choose" d={arrowPath(CHOOSE_ARROW.x1, CHOOSE_ARROW.y, CHOOSE_ARROW.x2, CHOOSE_ARROW.y)} />
        <path className="fig-c-svg-arrow" data-on={s.end === 'rows'} data-edge="rows" d={arrowPath(from, mid('empty') - 8, to, mid('rows'))} />
        <path className="fig-c-svg-arrow" data-on={s.end === 'empty'} data-edge="empty" d={arrowPath(from, mid('empty'), to, mid('empty'))} />
        <path className="fig-c-svg-arrow" data-on={s.end === 'failed'} data-edge="failed" d={arrowPath(from, mid('empty') + 8, to, mid('failed'))} />
        <text x={CHOOSE_ARROW.label.x} y={CHOOSE_ARROW.label.y} textAnchor="middle" className="fig-c-svg-note">choose</text>
      </FigureSvg>
      {scenario === 'race' && (
        <ol className="fig-c-lanes" data-testid="race-lanes">
          <li>1. Request A starts for list A (Reading).</li>
          <li>2. You choose list B. Cleanup marks A’s context inactive; request B starts.</li>
          <li>3. B answers [Reading, Revision]. <StatusMark status="passed" label="Applied" /></li>
          <li>4. A answers late with [Reading]. Its live flag is false. <StatusMark status="not-run" label="Dropped" /></li>
        </ol>
      )}
      <p className="fig-live" aria-live="polite" data-testid="states-live">Screen: {s.screen} Hook state: {s.state}.</p>
    </Figure>
  );
}

/* ------------------------------ chapter 4: the evidence ledger ------------------------------ */

/** The six visible tests (readonly/tests/test_tasks_api.py and
 * readonly/web/src/lib/overdue.test.ts) and the gap each one reaches. */
export const VISIBLE_TESTS = [
  { name: 'test_completing_a_task_marks_it_done', gap: 'complete_task' },
  { name: 'test_completing_a_task_nobody_has_is_a_404', gap: 'complete_task' },
  { name: 'test_status_open_leaves_out_the_finished_tasks', gap: 'list_tasks' },
  { name: 'test_a_task_due_before_today_is_in_the_overdue_report', gap: 'overdue_tasks' },
  { name: 'a task due yesterday is overdue', gap: 'isOverdue' },
  { name: 'a task due today is not overdue yet', gap: 'isOverdue' },
] as const;

/** Claims a learner might make after six green tests, and what backs each. */
export const CLAIMS = [
  { value: 'unknown-404', label: 'Completing an unknown id answers 404', by: 'test_completing_a_task_nobody_has_is_a_404' },
  { value: 'open-filter', label: 'status=open leaves out finished tasks', by: 'test_status_open_leaves_out_the_finished_tasks' },
  { value: 'today', label: 'isOverdue: a task due today is not overdue', by: 'a task due today is not overdue yet' },
  { value: 'search', label: 'Search ignores upper and lower case', by: null },
  { value: 'overdue-done', label: 'The overdue report leaves out done tasks', by: null },
  { value: 'use-tasks', label: 'useTasks shows an error, not an empty list', by: null },
] as const;
type Claim = (typeof CLAIMS)[number]['value'];

/** The ledger's tally, counted from CLAIMS: how many claims a visible test backs. */
export function ledgerTally(claims: readonly { by: string | null }[] = CLAIMS) {
  const backed = claims.filter((item) => item.by).length;
  return { backed, notObserved: claims.length - backed, total: claims.length };
}

function EvidenceLedger() {
  const [claim, setClaim] = useState<Claim>('unknown-404');
  const chosen = CLAIMS.find((item) => item.value === claim)!;
  const tally = ledgerTally();
  const verdict = chosen.by
    ? <>Backed: the visible test <code>{wordBreaks(chosen.by)}</code> checks this.</>
    : 'Not observed: no visible test reaches this. Plan a check, or look in the running app, before you claim it.';
  return (
    <Figure
      className="fig-c"
      title="What six passing tests prove"
      howTo="Choose a claim. The ledger says which visible test backs it, if any."
      model="Teaching model: it assumes all six visible tests passed on your saved code"
      description="The Implementation room runs six visible tests: four API tests and two front-end tests. They back the claims they check and nothing else. No visible test reaches useTasks."
    >
      <ToggleSet label="Claim" options={CLAIMS} value={claim} onChange={setClaim} />
      <div className="fig-c-tally" data-testid="ledger-tally">
        <svg viewBox={`0 0 ${CLAIMS.length * 19} 18`} aria-hidden="true" focusable="false">
          {CLAIMS.map((item, i) => (
            <rect key={item.value} x={i * 19 + 1.5} y={1.5} width={15} height={15} rx={3} className={item.by ? 'fig-c-tally-backed' : 'fig-c-tally-open'} data-on={item.value === claim} />
          ))}
        </svg>
        <StatusMark status="passed" label={`Backed: ${tally.backed} of ${tally.total} claims`} />
        <StatusMark status="not-run" label={`Not observed: ${tally.notObserved} of ${tally.total}`} />
      </div>
      <ScrollRegion label="The six visible tests" hint="Scroll sideways to see every column.">
      <table className="fig-table fig-c-table" style={{ marginTop: 12 }}>
        <caption>The six visible tests and the gap each reaches</caption>
        <thead><tr><th scope="col">Visible test</th><th scope="col">Gap</th><th scope="col">Result</th></tr></thead>
        <tbody>
          {VISIBLE_TESTS.map((test) => (
            <tr key={test.name} data-on={chosen.by === test.name}>
              <th scope="row"><code>{test.name}</code></th>
              <td><code>{test.gap}</code></td>
              <td><StatusMark status="passed" /></td>
            </tr>
          ))}
          <tr data-on={!chosen.by}>
            <th scope="row">No visible test</th>
            <td><code>useTasks</code>, search, tags, ordering</td>
            <td><StatusMark status="not-run" label="Not observed" /></td>
          </tr>
        </tbody>
      </table>
      </ScrollRegion>
      <p className="fig-verdict" data-tone={chosen.by ? 'pass' : 'warn'}>{chosen.by ? 'Backed' : 'Not observed'}</p>
      <p className="fig-live" aria-live="polite" data-testid="ledger-live">{chosen.label}. {verdict}</p>
    </Figure>
  );
}

/* ------------------------------ chapter 4: propose, explain, apply ------------------------------ */

/** The explanation review's four checks, in the room's words and order
 * (components/workspace/mentor/ExplanationFindings.tsx DIMENSION_LABEL). */
export const CHECKS = ['What the change does', 'Why it meets the request', 'What is and is not verified', 'Whether the claims match the proposal'] as const;
type Finding = { status: FigureStatus; label: string };
const SUPPORTED: Finding = { status: 'passed', label: 'Supported' };
const MISSING: Finding = { status: 'not-run', label: 'Not explained yet' };
const CONFLICT: Finding = { status: 'failed', label: 'Conflicts with the proposal or a record' };

function Findings({ rows, verdict, tone }: { rows: Finding[]; verdict: string; tone: 'pass' | 'warn' }) {
  return (
    <div className="fig-c-panel">
      <ScrollRegion label="Explanation review" hint="Scroll sideways to see every column.">
        <table className="fig-table"><caption>Explanation review</caption><tbody>
          {CHECKS.map((check, i) => <tr key={check}><th scope="row">{check}</th><td><StatusMark status={rows[i].status} label={rows[i].label} /></td></tr>)}
        </tbody></table>
      </ScrollRegion>
      <p className="fig-verdict" data-tone={tone}>{verdict}</p>
    </div>
  );
}

/* The walk proposes an illustrative helper in an editable file, never a gap's
 * body: deleteTask sends the contract's deleteTask operation (DELETE
 * /api/tasks/{id}, 204) through the supplied client's deleteJson. TaskTrackr
 * has no deleteTask helper and no phase grades one. */
const PROPOSAL_LINE = '// web/src/hooks/useTasks.ts: an illustrative helper, not one of your gaps';
export const PROPOSE_STEPS = [
  { title: 'Ask in Agentic mode', text: 'In the Code tab, switch the mentor from Guided to Agentic and ask for one change: a deleteTask helper beside completeTask that sends the contract’s DELETE /api/tasks/{id}.', content: <pre className="fig-c-code">{'You: Add a deleteTask helper beside completeTask that sends DELETE /api/tasks/{id}.'}</pre> },
  { title: 'The mentor proposes', text: 'The proposal is a change to a file you may edit; deleteTask is not one of your five gaps. Nothing is applied yet. Read it before you explain it: this one sends a POST to tasks/{id}/delete, an address the API has no route for.', content: <pre className="fig-c-code">{PROPOSAL_LINE}{'\n'}<ins>{'+ export function deleteTask(taskId: number): Promise<Task> {\n+   return postJson<Task>(`tasks/${taskId}/delete`);\n+ }'}</ins></pre> },
  { title: 'You explain it without reading it', text: 'You press Explain this proposal and write: “deleteTask sends DELETE /api/tasks/{id}, so the API removes the task and answers 204.” The proposal sends a POST to another address, so the review finds a conflict and Apply stays locked.', content: <Findings rows={[MISSING, MISSING, MISSING, CONFLICT]} verdict="Explanation review: Apply stays locked" tone="warn" /> },
  { title: 'A corrected proposal, explained', text: 'You ask for the contract’s DELETE instead. Then you explain: “deleteTask now calls the client’s deleteJson on tasks/{id}, so the API’s DELETE route removes the task and answers 204. No visible test and no screen calls it yet, so nothing has checked it.”', content: <><pre className="fig-c-code">{PROPOSAL_LINE}{'\n'}<del>{"- import { getJson, postJson } from '../api/client';"}</del>{'\n'}<ins>{"+ import { deleteJson, getJson, postJson } from '../api/client';\n+ export function deleteTask(taskId: number): Promise<void> {\n+   return deleteJson(`tasks/${taskId}`);\n+ }"}</ins></pre><Findings rows={[SUPPORTED, SUPPORTED, SUPPORTED, SUPPORTED]} verdict="Understanding accepted" tone="pass" /></> },
  { title: 'You apply it, and you own it', text: 'Apply this reviewed proposal saves your work. It does not run, submit or pass the phase: run the visible tests next, and the phase review judges the result.', content: <p className="fig-verdict" data-tone="pass">Applied: saved to your work, not yet run</p> },
];

function ProposeExplainApply() {
  return (
    <Figure
      className="fig-c"
      title="Propose, explain, apply"
      howTo="Press Next to follow one Agentic change from request to Apply. The arrow keys move too."
      model="Illustrative. The review's verdicts in your room come from your own words."
      description="In the code rooms the mentor can propose a change, but Apply waits until your explanation of that proposal is accepted on four checks. Applying saves your work; it does not run, submit or pass the phase."
    >
      <StepThrough label="Propose, explain, apply" steps={PROPOSE_STEPS} />
    </Figure>
  );
}

/** One line per figure. Chapters are numbered as the reader shows them (1 to 4). */
export const IMPLEMENTATION_FIGURES: PhaseFigures = {
  'implementation-file-map': { chapter: 1, component: FileMap },
  'implementation-query-builder': { chapter: 2, component: QueryBuilder },
  'implementation-request-states': { chapter: 3, component: RequestStates },
  'implementation-evidence-ledger': { chapter: 4, component: EvidenceLedger },
  'implementation-propose-explain-apply': { chapter: 4, component: ProposeExplainApply },
};
export { FileMap, QueryBuilder, RequestStates, EvidenceLedger, ProposeExplainApply };
