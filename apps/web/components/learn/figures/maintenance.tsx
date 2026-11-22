'use client';
import { useState } from 'react';
import { ScrollRegion } from '@/components/experience/ScrollRegion';
import { PHASE_ORDER, PHASE_TITLES } from '@learnsdlc/shared';
import type { PhaseFigures } from './types';
import { Figure, FigureSvg } from './Figure';
import { StatusMark, type FigureStatus } from './StatusMark';
import { ToggleSet } from './ToggleSet';
import { PhaseGlyph } from './PhaseGlyph';
import './deployment-maintenance.css';

/* The Maintenance guide's figures. Every name is
 * CR-2's: comments.py, TASK_SELECT and its three readers, TaskRow's badge,
 * the two contracts and the 2.1.0 release. */

/* ------------------------------ chapter 1 ------------------------------- */

type Part = 'query' | 'repo' | 'routes' | 'row' | 'api' | 'design' | 'release';
export const IMPACT_PARTS: readonly { value: Part; label: string; file: string; detail: string; x: number; y: number }[] = [
  { value: 'query', label: 'Shared task query', file: 'TASK_SELECT', detail: 'Every task the API returns now needs a comment_count, and TASK_SELECT is where it goes. Three functions read this one query, so a change here reaches the list view, the overdue report and every single-task answer the API sends.', x: 370, y: 290 },
  { value: 'repo', label: 'Repository', file: 'api/repository/comments.py', detail: 'add_comment and list_comments. Comments come back newest first. An unknown task raises KeyError; a blank author or body raises ValueError.', x: 30, y: 40 },
  { value: 'routes', label: 'Routes', file: 'api/routes/comments.py', detail: 'GET and POST /api/tasks/{id}/comments. POST answers 201, 400 invalid_comment or 404 task_not_found.', x: 30, y: 150 },
  { value: 'row', label: 'Row component', file: 'web/src/components/TaskRow.tsx', detail: 'The badge says 1 comment or 4 comments. A task with none shows nothing.', x: 30, y: 260 },
  { value: 'api', label: 'API contract', file: 'shared/contract/api.json', detail: 'Publish listComments and addComment in the shape of their neighbours, with the error code addComment answers.', x: 710, y: 40 },
  { value: 'design', label: 'Design contract', file: 'design/contracts.json', detail: 'The operations you promised in Design. Add the two comment operations, their inputs, what they return and their errors.', x: 710, y: 150 },
  { value: 'release', label: 'Release note', file: 'Release tab, 2.1.0', detail: 'What changed, written for the person who upgrades, and how to roll it back.', x: 710, y: 260 },
];
/** The three readers of TASK_SELECT (`06-maintenance/files/api/repository/
 * tasks.py`) and what each reaches. list_tasks feeds the list view
 * (TasksPage, #/lists/:listId) and overdue_tasks the overdue report
 * (OverduePage, #/overdue); get_task feeds no screen of its own (screens.json
 * has three, and the lists page reads LIST_SELECT): it is the one task the
 * API answers with on GET /api/tasks/{id} and after a create, a change, a
 * complete or a reopen. */
export const QUERY_READERS: readonly { fn: string; label: string; reaches: string }[] = [
  { fn: 'get_task', label: 'single-task answers', reaches: 'every single-task answer' },
  { fn: 'list_tasks', label: 'list view', reaches: 'the list view' },
  { fn: 'overdue_tasks', label: 'overdue report', reaches: 'the overdue report' },
];

/** The drawn width of a part's box and of a reader's box, in viewBox units. */
export const PART_BOX = 260;
export const READER_BOX = 200;
const readerX = (i: number) => 170 + i * 230;

export function ImpactMap() {
  const [part, setPart] = useState<Part>('repo');
  const chosen = IMPACT_PARTS.find((p) => p.value === part)!;
  const queryOn = part === 'query';
  const description = `CR-2, comments on a task, sits at the centre. It touches seven parts: ${IMPACT_PARTS.map((p) => `${p.label} (${p.file})`).join(', ')}. ${queryOn
    ? `The shared task query is selected, and its three readers are lit: ${QUERY_READERS.map((r) => `${r.fn}, ${r.reaches}`).join('; ')}.`
    : `${chosen.label} is selected. The shared task query's three readers are drawn dashed until you select it.`}`;
  return (
    <Figure
      title="The change boundary of CR-2"
      howTo="Select a part. Then select the shared task query."
      model
      scroll
      description="The same chain already exists for lists: creating or completing a task changes task rows, the list-count query observes them, and the list screen shows the new counts. A changed file can affect a view you did not open."
    >
      <div className="fig-dm-controls">
        <div><span>Part of the change</span><ToggleSet label="Part of the change" options={IMPACT_PARTS} value={part} onChange={setPart} /></div>
      </div>
      {/* A 1000-unit width so it fills the figure at 1440 with body-size
          text. Every part box is PART_BOX wide, which holds the longest path,
          web/src/components/TaskRow.tsx (30 characters of 12-unit monospace,
          about 216 units), with room on both sides. At 860 px or
          wider, its 13-unit text never draws under about 11 px while it
          scrolls in its box. */}
      <FigureSvg className="fig-dm-svg" title="What CR-2 touches" description={description} viewBox="0 0 1000 470" minWidth={860}>
        {IMPACT_PARTS.map((p) => (
          <line key={`e-${p.value}`} className={p.value === part ? 'edge-lit' : 'edge'} x1={500} y1={195} x2={p.x + PART_BOX / 2} y2={p.y + 25} />
        ))}
        {QUERY_READERS.map((r, i) => (
          <line key={`r-${r.fn}`} className={queryOn ? 'edge-lit' : 'edge'} strokeDasharray={queryOn ? undefined : '4 3'} x1={500} y1={340} x2={readerX(i) + READER_BOX / 2} y2={400} />
        ))}
        <rect className="node-lit" x="420" y="170" width="160" height="50" rx="8" />
        <text x="500" y="191" textAnchor="middle" className="word-strong">CR-2</text>
        <text x="500" y="210" textAnchor="middle" className="word-muted">comments on a task</text>
        {IMPACT_PARTS.map((p) => (
          <g key={p.value}>
            <rect className={p.value === part ? 'node-lit' : 'node'} x={p.x} y={p.y} width={PART_BOX} height="50" rx="8" data-part={p.value} />
            <text x={p.x + PART_BOX / 2} y={p.y + 21} textAnchor="middle" className="word-strong">{p.label}</text>
            <text x={p.x + PART_BOX / 2} y={p.y + 40} textAnchor="middle" className="mono">{p.file}</text>
          </g>
        ))}
        {QUERY_READERS.map((r, i) => (
          <g key={r.fn}>
            <rect className={queryOn ? 'node-lit' : 'node-dim'} x={readerX(i)} y="400" width={READER_BOX} height="50" rx="8" />
            <text x={readerX(i) + READER_BOX / 2} y="421" textAnchor="middle" className="mono">{r.fn}</text>
            <text x={readerX(i) + READER_BOX / 2} y="440" textAnchor="middle" className={queryOn ? undefined : 'word-muted'}>{r.label}</text>
          </g>
        ))}
      </FigureSvg>
      <div className="fig-dm-detail" aria-live="polite" data-testid="impact-detail">
        <p><strong>{chosen.label}</strong> <code>{chosen.file}</code></p>
        <p>{chosen.detail}</p>
        {queryOn && <p>Read by {QUERY_READERS.map((r) => `${r.fn} (${r.reaches})`).join(', ')}.</p>}
      </div>
    </Figure>
  );
}

/* ------------------------------ chapter 2 ------------------------------- */

type Join = 'inner' | 'left' | 'grouped' | 'subquery';
const JOINS = [
  { value: 'inner', label: 'Inner join' },
  { value: 'left', label: 'Left join' },
  { value: 'grouped', label: 'Left join with GROUP BY count' },
  { value: 'subquery', label: 'Count in a subquery' },
] as const;
/** Taught on the supplied list query, not on CR-2's: the subquery form is
 * LIST_SELECT's own task_count line (`06-maintenance/readonly/api/repository/
 * lists.py`, read-only in the room). Each statement was run in sqlite3 over
 * the three lists below; JOIN_RESULTS is what it returned. */
export const JOIN_SQL: Record<Join, string> = {
  inner: 'SELECT l.name, t.title FROM lists l JOIN tasks t ON t.list_id = l.id',
  left: 'SELECT l.name, t.title FROM lists l LEFT JOIN tasks t ON t.list_id = l.id',
  grouped: 'SELECT l.name, COUNT(t.id) AS task_count FROM lists l LEFT JOIN tasks t ON t.list_id = l.id GROUP BY l.id',
  subquery: 'SELECT l.name, (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id) AS task_count FROM lists l',
};
/** Three lists with 0, 1 and 3 tasks: lists 1 Home, 2 Errands and 3
 * Reading; tasks 20 to 23 in id order. */
export const LIST_TASKS: Record<string, string[]> = { Home: [], Errands: ['Post the form'], Reading: ['Review notes', 'Write summary', 'Return books'] };
/** Every row each statement returned, in the order sqlite3 returned it. With
 * no ORDER BY the order is SQLite's own: the left join, read through an
 * automatic index, returned Reading's tasks in title order. null is SQL
 * NULL; a number is task_count. */
export const JOIN_RESULTS: Record<Join, readonly (readonly [string, string | number | null])[]> = {
  inner: [['Errands', 'Post the form'], ['Reading', 'Review notes'], ['Reading', 'Write summary'], ['Reading', 'Return books']],
  left: [['Home', null], ['Errands', 'Post the form'], ['Reading', 'Return books'], ['Reading', 'Review notes'], ['Reading', 'Write summary']],
  grouped: [['Home', 0], ['Errands', 1], ['Reading', 3]],
  subquery: [['Home', 0], ['Errands', 1], ['Reading', 3]],
};
type OutRow = { list: string; value: string; task: string | null; mark?: { status: FigureStatus; label: string } };
export function joinRows(join: Join): OutRow[] {
  const result = JOIN_RESULTS[join];
  return result.map(([list, got]) => {
    const many = result.filter(([other]) => other === list).length > 1;
    return {
      list,
      task: typeof got === 'string' ? got : null,
      value: got === null ? 'no task (NULL)' : typeof got === 'number' ? `task_count ${got}` : got,
      mark: many ? { status: 'failed', label: 'Duplicated a list' } : { status: 'passed', label: 'One row' },
    };
  });
}
export function joinSummary(join: Join): string {
  const rows = joinRows(join);
  const names = Object.keys(LIST_TASKS);
  const lost = names.filter((l) => !rows.some((r) => r.list === l));
  const dup = names.filter((l) => rows.filter((r) => r.list === l).length > 1);
  const parts = [`3 lists in, ${rows.length} rows out.`];
  if (lost.length) parts.push(`Lost a list: ${lost.join(', ')}.`);
  if (dup.length) parts.push(`Duplicated a list: ${dup.join(', ')}.`);
  if (!lost.length && !dup.length) parts.push('One row per list, with counts 0, 1 and 3.');
  if (join === 'grouped') parts.push('Right rows, wrong place: list_lists and get_list add their own ORDER BY or WHERE after LIST_SELECT, and a GROUP BY at its end would come before the WHERE, which SQLite refuses.');
  if (join === 'subquery') parts.push('This is the supplied LIST_SELECT’s own task_count line: the FROM clause is unchanged, so the callers’ WHERE and ORDER BY still fit after it.');
  return parts.join(' ');
}

/* The join drawing. Each
 * list is a box holding its task rows (Home a dashed "no tasks" row); a line
 * runs from a task row to each row the query returns from it, so a list with
 * no line is lost and a list drawn three times on the right is duplicated.
 * The two count forms run every task row of a list into that list's one
 * row: solid where the rows are joined then grouped, dashed where a subquery
 * counts them. Rows out sit level with the task they carry; the table under
 * the drawing lists them in the order sqlite3 returned them. */
export const JOIN_PLAN = { width: 1000, listX: 30, listW: 260, rowX: 46, rowW: 228, rowH: 30, step: 38, outX: 480, outW: 260, markX: 764 } as const;
type Placed = { list: string; id: number; top: number; height: number; rows: { task: string | null; y: number }[] };
export function joinLayout(): { lists: Placed[]; height: number } {
  let top = 40;
  const lists = Object.entries(LIST_TASKS).map(([list, tasks], i) => {
    const slots = tasks.length ? tasks : [null];
    const rows = slots.map((task, j) => ({ task, y: top + 30 + j * JOIN_PLAN.step }));
    const placed = { list, id: i + 1, top, height: 30 + slots.length * JOIN_PLAN.step, rows };
    top += placed.height + 12;
    return placed;
  });
  return { lists, height: top + 2 };
}
const LINE_HEAD: Record<Join, string> = { inner: 'JOIN', left: 'LEFT JOIN', grouped: 'LEFT JOIN, GROUP BY', subquery: 'Subquery count' };

function Glyph({ ok, x, y }: { ok: boolean; x: number; y: number }) {
  return <path className={ok ? 'glyph-pass' : 'glyph-fail'} d={ok ? `M${x} ${y} l3 3 6-7` : `M${x} ${y - 4} l8 8 M${x + 8} ${y - 4} l-8 8`} />;
}

function JoinDrawing({ join }: { join: Join }) {
  const P = JOIN_PLAN;
  const { lists, height } = joinLayout();
  const rows = joinRows(join);
  const counted = join === 'grouped' || join === 'subquery';
  const mid = (y: number) => y + P.rowH / 2;
  // Where each row out sits: level with the task it carries, or with its
  // list's middle row when it is a count (or a NULL row, with the ghost row).
  const outY = (r: OutRow) => {
    const list = lists.find((l) => l.list === r.list)!;
    if (r.task) return list.rows.find((row) => row.task === r.task)!.y;
    return list.rows[Math.floor((list.rows.length - 1) / 2)].y;
  };
  const lost = lists.filter((l) => !rows.some((r) => r.list === l.list));
  const dup = lists.filter((l) => rows.filter((r) => r.list === l.list).length > 1);
  const description = `Three lists, each a box holding its task rows: Home holds none, Errands one, Reading three. ${JOINS.find((j) => j.value === join)!.label}: a line runs from each task row to each row the query returns. ${joinSummary(join)}`;
  return (
    <FigureSvg className="fig-dm-svg" title="Lists joined to the rows the query returns" description={description} viewBox={`0 0 ${P.width} ${height}`} minWidth={860}>
      <text x={P.listX} y="24" className="word-muted">lists l, each with its tasks</text>
      <text x={(P.listX + P.listW + P.outX) / 2} y="24" textAnchor="middle" className="word-muted" data-label="lines">{LINE_HEAD[join]}</text>
      <text x={P.outX} y="24" className="word-muted">{`Rows out: ${rows.length}`}</text>
      {lists.map((l) => (
        <g key={l.list} data-list={l.list} data-state={lost.includes(l) ? 'lost' : dup.includes(l) ? 'duplicated' : 'one'}>
          <rect className={lost.includes(l) || dup.includes(l) ? 'node-fail' : 'node'} x={P.listX} y={l.top} width={P.listW} height={l.height} rx="8" />
          <text x={P.listX + 16} y={l.top + 21} className="word-strong">{l.list}</text>
          <text x={P.listX + P.listW - 16} y={l.top + 21} textAnchor="end" className="word-muted">{`list id ${l.id}`}</text>
          {l.rows.map((row) => (
            <g key={row.task ?? 'none'}>
              <rect className={row.task ? 'node' : 'node-dim'} x={P.rowX} y={row.y} width={P.rowW} height={P.rowH} rx="6" />
              <text x={P.rowX + 12} y={row.y + 20} className={row.task ? undefined : 'word-muted'}>{row.task ?? 'no tasks'}</text>
              {row.task && <text x={P.rowX + P.rowW - 12} y={row.y + 20} textAnchor="end" className="mono">{`list_id ${l.id}`}</text>}
            </g>
          ))}
        </g>
      ))}
      {lists.flatMap((l) => l.rows.map((row) => {
        const out = rows.find((r) => r.list === l.list && (counted || r.task === row.task));
        if (!out) return null;
        return <line key={`${l.list}-${row.task ?? 'none'}`} className="edge-join" strokeDasharray={join === 'subquery' ? '6 4' : undefined} x1={P.rowX + P.rowW} y1={mid(row.y)} x2={P.outX} y2={mid(outY(out))} data-from={row.task ?? `${l.list}, no tasks`} />;
      }))}
      {rows.map((r, i) => {
        const y = outY(r);
        const many = r.mark?.status === 'failed';
        return (
          <g key={`out-${i}`} data-out={r.list}>
            <rect className={many ? 'node-fail' : 'node'} x={P.outX} y={y} width={P.outW} height={P.rowH} rx="6" />
            <text x={P.outX + 14} y={y + 20} className="word-strong">{r.list}</text>
            <text x={P.outX + 96} y={y + 20} className={r.task ? undefined : 'mono'}>{r.task ?? (counted ? r.value : 'NULL')}</text>
            {!many && <><Glyph ok x={P.markX} y={mid(y)} /><text x={P.markX + 18} y={mid(y) + 5} className="word-pass">One row</text></>}
          </g>
        );
      })}
      {lost.map((l) => {
        const y = l.rows[0].y;
        return (
          <g key={`lost-${l.list}`} data-lost={l.list}>
            <rect className="node-lost" x={P.outX} y={y} width={P.outW} height={P.rowH} rx="6" />
            <text x={P.outX + 14} y={y + 20} className="word-fail">{`No row for ${l.list}`}</text>
            <Glyph ok={false} x={P.markX} y={mid(y)} />
            <text x={P.markX + 18} y={mid(y) + 5} className="word-fail">Lost a list</text>
          </g>
        );
      })}
      {dup.map((l) => {
        const ys = rows.filter((r) => r.list === l.list).map(outY);
        const top = Math.min(...ys);
        const bottom = Math.max(...ys) + P.rowH;
        const centre = (top + bottom) / 2;
        return (
          <g key={`dup-${l.list}`} data-duplicated={l.list}>
            <path className="edge-fail-solid" d={`M${P.outX + P.outW + 6} ${top} H${P.outX + P.outW + 12} V${bottom} H${P.outX + P.outW + 6}`} />
            <Glyph ok={false} x={P.markX} y={centre - 8} />
            <text x={P.markX + 18} y={centre - 3} className="word-fail">Duplicated a list</text>
            <text x={P.markX + 18} y={centre + 17} className="word-muted">{`${l.list}, ${ys.length} rows`}</text>
          </g>
        );
      })}
    </FigureSvg>
  );
}

export function JoinCardinality() {
  const [join, setJoin] = useState<Join>('inner');
  const rows = joinRows(join);
  const lost = Object.keys(LIST_TASKS).filter((l) => !rows.some((r) => r.list === l));
  return (
    <Figure
      title="One row per parent"
      howTo="Change how the query reaches the tasks and follow the lines from each list to the rows that come out."
      model="A teaching model on the supplied list query, not on CR-2’s. Each statement was run over these three lists."
      description="Home has no tasks, Errands has one, Reading has three. A join returns one row per matching pair, so it can drop Home and repeat Reading. A count that keeps one row per parent and a numeric zero is the shape the supplied list query already uses; CR-2 asks the same of every task and its comments."
    >
      <div className="fig-dm-controls">
        <div><span>Query</span><ToggleSet label="Query" options={JOINS} value={join} onChange={setJoin} /></div>
      </div>
      <pre className="fig-dm-code"><span>{JOIN_SQL[join]}</span></pre>
      <ScrollRegion label="Lists joined to the rows the query returns" hint="Scroll sideways to see the whole drawing.">
        <JoinDrawing join={join} />
      </ScrollRegion>
      <p className="fig-live" aria-live="polite" data-testid="join-live">{joinSummary(join)}</p>
      {/* The drawing's text alternative: every row, in the order sqlite3 returned it. */}
      <details className="fig-dm-alt">
        <summary>The same rows as a table</summary>
        <ScrollRegion label="Rows the query returns" hint="Scroll sideways to see every column.">
          <table className="fig-table fig-dm-table">
            <caption>Rows the query returns for the lists Home, Errands and Reading, in the order sqlite3 returned them</caption>
            <thead><tr><th scope="col">List</th><th scope="col">Task or count</th><th scope="col">Result</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.list}-${i}`}><th scope="row">{r.list}</th><td><code>{r.value}</code></td><td data-mark>{r.mark && <StatusMark status={r.mark.status} label={r.mark.label} />}</td></tr>
              ))}
              {lost.map((l) => (
                <tr key={`lost-${l}`}><th scope="row">{l}</th><td>missing</td><td data-mark><StatusMark status="failed" label="Lost a list" /></td></tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </details>
    </Figure>
  );
}

/* ------------------------------ chapter 3 ------------------------------- */

export const DIFF_LINES: readonly { n: number; kind: 'add' | 'ctx'; text: string }[] = [
  { n: 44, kind: 'ctx', text: '    </span>' },
  { n: 45, kind: 'ctx', text: '    {late ? <OverdueBadge days={daysLate(task, today)} /> : null}' },
  { n: 46, kind: 'add', text: '+   {task.comment_count && (' },
  { n: 47, kind: 'add', text: '+     <span className="badge badge-comments" data-testid="comment-count">' },
  { n: 48, kind: 'add', text: '+       {task.comment_count} comments' },
  { n: 49, kind: 'add', text: '+     </span>' },
  { n: 50, kind: 'add', text: '+   )}' },
];
/** The two lines the concrete comment names. */
const NAMED_LINES = [46, 48];
type Comment = 'lgtm' | 'rewrite' | 'concrete';
const COMMENT_OPTIONS = [
  { value: 'lgtm', label: 'Looks good to me.' },
  { value: 'rewrite', label: 'This is messy. Please rewrite the whole row.' },
  { value: 'concrete', label: 'Lines 46 and 48: zero shows a bare 0, one says 1 comments' },
] as const;
export const COMMENT_VERDICTS: Record<Comment, { helps: boolean; full: string; why: string }> = {
  lgtm: { helps: false, full: 'Looks good to me.', why: 'It gives the author nothing to check. Both defects ship, and a later reader cannot tell what was reviewed.' },
  rewrite: { helps: false, full: 'This is messy. Please rewrite the whole row.', why: 'It names no defect and throws away the change boundary. The controls, status, tags and dates in the row worked before.' },
  concrete: { helps: true, full: 'Line 46: when comment_count is 0, this draws a bare 0 on the row, because React draws the number. Line 48 says "1 comments" for one. CR-2 asks for no badge at zero and "1 comment" for one. A TaskRow test with a zero task and a one-comment task would show both.', why: 'It names the lines, the behaviour, the promise it breaks and the test that would catch it. The author can act on it today.' },
};

export function ReviewGrader() {
  const [comment, setComment] = useState<Comment | null>(null);
  const verdict = comment ? COMMENT_VERDICTS[comment] : null;
  return (
    <Figure
      title="Grade a review comment"
      howTo="Pick a comment for this diff and read why it helps or not."
      model
      description="The diff adds the comment badge to TaskRow. It has two defects a user would see: a task with no comments shows 0, and a task with one comment says 1 comments."
    >
      <pre className="fig-dm-code" aria-label="Diff of web/src/components/TaskRow.tsx">
        {DIFF_LINES.map((l) => (
          <span key={l.n} data-kind={l.kind} data-target={comment === 'concrete' && NAMED_LINES.includes(l.n) ? 'true' : undefined}>{`${String(l.n).padStart(3, ' ')} ${l.text}`}</span>
        ))}
      </pre>
      <div className="fig-dm-controls" style={{ marginTop: 12 }}>
        <div><span>Your review comment</span>
          <ToggleSet label="Review comment" options={COMMENT_OPTIONS} value={(comment ?? '') as Comment} onChange={setComment} />
        </div>
      </div>
      <div className="fig-dm-detail" aria-live="polite" data-testid="review-verdict">
        {verdict ? (
          <>
            <p><StatusMark status={verdict.helps ? 'passed' : 'failed'} label={verdict.helps ? 'Helps' : 'Does not help'} /></p>
            <p>&ldquo;{verdict.full}&rdquo;</p>
            <p>{verdict.why}</p>
          </>
        ) : <p>No comment chosen yet.</p>}
      </div>
    </Figure>
  );
}

/* ------------------------------ chapter 4 ------------------------------- */

type Note = 'vague' | 'useful';
const NOTES = [
  { value: 'vague', label: 'Vague note' },
  { value: 'useful', label: 'Useful note' },
] as const;
/** An illustrative patch release (a list's open count corrected), not the
 * graded 2.1.0: the vague note as written, and the useful note as its four
 * parts (the Release tab's version, summary, changes and rollback), the
 * version named and each other part saying what it must hold, with ONE part,
 * the summary, filled as an example. */
export const NOTE_VAGUE: readonly string[] = ['2.0.1', 'Counts fixed and some bugs fixed. Everything tested.'];
export const NOTE_PARTS: readonly { part: string; asks: string; example?: string }[] = [
  { part: 'Version', asks: '2.0.1, an illustrative patch release.' },
  { part: 'Summary', asks: 'What changed, in words the person upgrading uses.', example: 'Each list’s open count shows only unfinished tasks again, as it did before the last release.' },
  { part: 'Changes', asks: 'Each change, and the acceptance item and check that cover it. Nothing that was not checked.' },
  { part: 'Rollback', asks: 'The version to go back to, how, and what going back does not undo.' },
];
export const NOTE_CHECKS: readonly { label: string; vague: boolean; useful: boolean }[] = [
  { label: 'Says what changed, in a user’s words', vague: false, useful: true },
  { label: 'Says what changes for someone upgrading', vague: false, useful: true },
  { label: 'Says how to roll back', vague: false, useful: true },
  { label: 'Claims only what was checked', vague: false, useful: true },
];
type Gate = 'passed' | 'open';
const GATES = [
  { value: 'passed', label: 'Maintenance passed' },
  { value: 'open', label: 'Maintenance not yet passed' },
] as const;

export function ReleaseNote() {
  const [note, setNote] = useState<Note>('vague');
  const [gate, setGate] = useState<Gate>('passed');
  const complete = gate === 'passed';
  return (
    <Figure
      title="A release note, and what completes the project"
      howTo="Switch between the two notes. Then take away the Maintenance pass."
      model="A teaching model on an illustrative patch release, not your 2.1.0. The useful note shows what each part must hold; your own note is yours to write."
      description="A release note tells the person upgrading what changed and how to undo it. It does not complete the project. Completion needs a recorded Pass in every phase."
    >
      <div className="fig-dm-controls">
        <div><span>Release note</span><ToggleSet label="Release note" options={NOTES} value={note} onChange={setNote} /></div>
      </div>
      <div className="fig-dm-note" data-testid="release-note">
        {note === 'vague'
          ? NOTE_VAGUE.map((line, i) => (i === 0 ? <p key={line}><strong>{line}</strong></p> : <p key={line}>{line}</p>))
          : (
            <dl className="fig-dm-parts">
              {NOTE_PARTS.map((p) => (
                <div key={p.part} data-part={p.part} data-example={p.example ? 'true' : undefined}><dt>{p.part}</dt><dd>{p.example ? <><span>{p.example}</span> <small>Filled as an example.</small></> : p.asks}</dd></div>
              ))}
            </dl>
          )}
      </div>
      <ul className="fig-dm-checks" aria-live="polite">
        {NOTE_CHECKS.map((c) => (
          <li key={c.label}><span>{c.label}</span><StatusMark status={c[note] ? 'passed' : 'failed'} label={c[note] ? 'Has its part' : 'No'} /></li>
        ))}
      </ul>
      <div className="fig-dm-controls" style={{ marginTop: 14 }}>
        <div><span>Maintenance review</span><ToggleSet label="Maintenance review" options={GATES} value={gate} onChange={setGate} /></div>
      </div>
      <ul className="fig-dm-phases" aria-label="Recorded phase verdicts">
        {PHASE_ORDER.map((p) => {
          const passed = p !== 'maintenance' || complete;
          return (
            <li key={p}><PhaseGlyph phaseKey={p} /><span>{PHASE_TITLES[p]}</span><StatusMark status={passed ? 'passed' : 'not-run'} label={passed ? 'Pass' : 'No Pass yet'} /></li>
          );
        })}
      </ul>
      <p className="fig-verdict" data-tone={complete ? 'pass' : 'fail'} aria-live="polite" data-testid="completion-verdict">
        {complete ? 'Project complete: every phase has a recorded Pass.' : 'Not complete: Maintenance has no recorded Pass, however good the release note is.'}
      </p>
    </Figure>
  );
}

/** One line per figure. Chapters are numbered as the reader shows them (1 to 4). */
export const MAINTENANCE_FIGURES: PhaseFigures = {
  'maintenance-impact-map': { chapter: 1, component: ImpactMap },
  'maintenance-join-cardinality': { chapter: 2, component: JoinCardinality },
  'maintenance-review-grader': { chapter: 3, component: ReviewGrader },
  'maintenance-release-note': { chapter: 4, component: ReleaseNote },
};
