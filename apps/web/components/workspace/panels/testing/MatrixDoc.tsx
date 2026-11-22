'use client';

/**
 * The kill matrix as a document, not a side panel.
 *
 * The panel's grid read bugs down and tests across; the page reads it the way
 * a learner talks about it, "my six tests against their six bugs", so the
 * tests are the rows and B1…B6 are the columns. Nothing here derives anything
 * new: {@link matrixView} still owns the counts, the verdicts and the twins,
 * and this file is the drawing.
 */
import { andList, numberWord, type MutantRow, type PhaseDetail } from '@learnsdlc/shared';
import { Fragment } from 'react';
import { Chip, Section, SectionHead, Stat, StatusSquare, Table, CellTitle } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useScrollFocusRef } from '@/lib/scroll-focus';
import { sidewaysCue, useSidewaysBox } from '@/lib/use-sideways-box';
import { MatrixClock } from './Matrix';
import { NO_BUG_BEHIND, type MatrixView } from './lib';
import { AWAITING_SIGN_OFF, SIGN_OFF_TONE, phaseAwaitingSignOff } from '../../signoff-status';
import { STATE_LABEL, isCredited } from '../../gate-state';

/* --------------------------------- stats --------------------------------- */

/**
 * One headline number. A tinted box, the way /dossier and /complete
 * draw the identical pattern: one number in a tinted box, with a label and an
 * optional hint.
 */
function Figure({
  value,
  label,
  tone,
  hint,
}: {
  value: string;
  label: string;
  tone: 'ink' | 'fail';
  hint?: string;
}) {
  return (
    <Stat
      value={value}
      label={label}
      hint={hint}
      tone={tone === 'fail' ? 'fail' : 'neutral'}
      className="min-w-0"
    />
  );
}

/* ---------------------------------- grid --------------------------------- */

/**
 * One cell: filled when the test fails on that bug, outlined red when nothing
 * catches it, and empty when the test is in the other suite and never ran
 * against this bug at all.
 */
function Cell({ hit, dead, ran }: { hit: boolean; dead: boolean; ran: boolean }) {
  if (!ran) {
    // A blank cell reads as neither killed nor alive, and a grid whose
    // whole job is to be complete cannot have holes in it. The dash is the
    // fourth state, drawn rather than left out.
    return (
      <span
        className="flex h-10 w-full items-center justify-center"
        title="This test is in the other suite, so it never ran against this bug"
        data-testid="matrix-cell-not-run"
      >
        <span className="inline-flex h-7 w-7 items-center justify-center">
          <span
            aria-hidden
            className="inline-block h-[2px] w-3 rounded-sm"
            style={{ background: 'rgb(var(--c-edge2))' }}
          />
        </span>
      </span>
    );
  }
  const style: React.CSSProperties = hit
    ? { background: 'rgb(var(--c-pass))' }
    : dead
      ? { border: '1.5px solid rgb(var(--c-fail))' }
      : { border: '1.5px dashed rgb(var(--c-edge2))' };
  return (
    <span className="flex h-10 w-full items-center justify-center">
      <span
        className="inline-flex h-7 w-7 items-center justify-center rounded-chip"
        style={{ ...style, boxSizing: 'border-box' }}
      >
        {hit && <Icon name="check" size={15} strokeWidth={2.5} className="text-onstatus" />}
      </span>
    </span>
  );
}

/**
 * The row label. Every test in the column starts `test_`, so six copies of the
 * prefix say nothing; the full name stays on the element's title and its id.
 */
const rowLabel = (name: string) => name.replace(/^test_/, '');

/** A test no planted bug depends on, in one phrase wherever the page says it; kept in ./lib, which the workspace's grid reads too. */
export { NO_BUG_BEHIND };

/**
 * The row's chip may wrap onto a second line where its column is narrow (the
 * brief and the mentor both open); a chip that fits keeps its one-line height.
 */
const FLAG_WRAP = 'h-auto min-h-6 whitespace-normal py-[3px] leading-tight';

function RowFlag({ view, index }: { view: MatrixView; index: number }) {
  const col = view.columns[index];
  // Not "Catches nothing": no planted bug depends on it, which is a fact about
  // the mutant table rather than a verdict on the learner's test. One phrase
  // for it on the page: the chip, the figure and the row's square.
  if (col.kills.length === 0) return <Chip tone="neutral" className={FLAG_WRAP}>{NO_BUG_BEHIND}</Chip>;
  if (col.verdict === 'load-bearing') return <Chip tone="pass" className={FLAG_WRAP}>Load-bearing</Chip>;
  if (col.verdict === 'twin') return <Chip tone="outline" className={FLAG_WRAP}>Twin</Chip>;
  return null;
}

/**
 * The grid's columns. The test names take what they need where
 * there is room (`max-content`) and wrap down to {@link MATRIX_TRACKS}.name
 * where there is not; a bug's column is 44 px, down to 36 px; the row's chip
 * column keeps enough for its chip on two lines. With the brief and the mentor
 * both open at 1440 px the card holds about 660 px, and 168 + 8 x 36 + 124 =
 * 580 of it is the least the grid asks, so eight bugs fit there.
 *
 * At 1280 px with both panels open the grid's box is about
 * 500 px, under those 580, and the box scrolled with the chips' column cut
 * ("No p", "Twi") and nothing to say so. Where the box is narrower than the
 * full grid, the chip moves under the test's name and the grid drops its last
 * column ({@link matrixTracksNarrow}: 168 + 8 x 36 = 456 px at eight bugs), so
 * nothing at its right edge is cut; only a box narrower even than that (1024 px
 * with both panels open) scrolls, and then a line above it says so.
 */
export const MATRIX_TRACKS = { name: 168, cell: 36, cellMax: 44, flag: 124 } as const;

/** The grid's column template and the least width it needs, for `bugs` planted bugs. */
export function matrixTracks(bugs: number): { template: string; minWidth: number } {
  const t = MATRIX_TRACKS;
  return {
    template: `minmax(${t.name}px, max-content) repeat(${bugs}, minmax(${t.cell}px, ${t.cellMax}px)) minmax(${t.flag}px, 1fr)`,
    minWidth: t.name + bugs * t.cell + t.flag,
  };
}

/** The same grid with each row's chip under its test's name: no chip column, so the bugs' columns end the row. */
export function matrixTracksNarrow(bugs: number): { template: string; minWidth: number } {
  const t = MATRIX_TRACKS;
  return {
    template: `minmax(${t.name}px, max-content) repeat(${bugs}, minmax(${t.cell}px, ${t.cellMax}px))`,
    minWidth: t.name + bugs * t.cell,
  };
}

/** Whether a box `width` px wide draws the grid with its chips under the names: measured, and too narrow for the full grid. */
export function matrixNarrow(width: number, bugs: number): boolean {
  return width > 0 && width < matrixTracks(bugs).minWidth;
}

/** The line above the grid while its box scrolls sideways (above it: under 24 rows a line below would be out of view). */
export const MATRIX_SCROLL_CUE = sidewaysCue('every planted bug');

/**
 * A test's name with a place to break after each underscore and dot: a long Python name wraps between
 * its words ("completing_a_task_" / "answers_with_it_finished"), as the dossier's names do, rather than wherever the
 * column runs out ("completing_a_task_ans" / "wers_..."). `<wbr>` adds no text, so the name reads and copies unchanged.
 */
export function BreakableName({ text }: { text: string }) {
  const parts = text.split(/(?<=[_.])/);
  if (parts.length < 2) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/**
 * The grid: your tests down the side, the planted bugs across the top, one
 * cell each, the count of tests that catch each bug under it.
 */
export function MatrixGrid({ view }: { view: MatrixView }) {
  const cols = view.rows; // the planted bugs
  const box = useSidewaysBox();
  const ref = useScrollFocusRef<HTMLDivElement>(box.ref);
  const narrow = matrixNarrow(box.width, cols.length);
  const { template, minWidth } = narrow ? matrixTracksNarrow(cols.length) : matrixTracks(cols.length);
  return (
    <>
    {box.scrolls && (
      <p className="label-sm" data-testid="phase-testing-matrix-scroll-cue">
        {MATRIX_SCROLL_CUE}
      </p>
    )}
    <div ref={ref} className="min-w-0 overflow-x-auto" data-testid="phase-testing-matrix-grid" data-narrow={narrow ? 'true' : undefined}>
      <div
        className="grid items-center gap-y-0.5"
        style={{ gridTemplateColumns: template, minWidth }}
      >
        <span className="label-sm pb-1.5">Your test</span>
        {cols.map((b) => (
          <span
            key={b.id}
            title={b.row.mutant}
            className={`mono pb-1.5 text-center text-[12px] font-semibold ${
              b.killers.length ? 'text-ink' : 'text-fail'
            }`}
          >
            {b.id}
          </span>
        ))}
        {!narrow && <span className="label-sm pb-1.5 pl-3.5">What the row tells you</span>}

        {view.columns.map((c, i) => (
          <div key={c.key} className="contents">
            {/* The name wraps where its column is narrow: it never runs into B1. */}
            {narrow ? (
              <span className="flex min-w-0 flex-col items-start gap-1 py-1 pr-2" data-testid={`phase-testing-matrix-test-${c.name}`} title={c.name}>
                <span className="mono flex min-w-0 items-center gap-2 text-[12px]">
                  <StatusSquare
                    state={c.kills.length ? 'pass' : 'todo'}
                    size={10}
                    label={c.kills.length ? 'Catches a bug' : NO_BUG_BEHIND}
                  />
                  <span className="min-w-0 [overflow-wrap:anywhere]"><BreakableName text={rowLabel(c.name)} /></span>
                </span>
                <RowFlag view={view} index={i} />
              </span>
            ) : (
              <span
                className="mono flex min-w-0 items-center gap-2 pr-2 text-[12px]"
                data-testid={`phase-testing-matrix-test-${c.name}`}
                title={c.name}
              >
                <StatusSquare
                  state={c.kills.length ? 'pass' : 'todo'}
                  size={10}
                  label={c.kills.length ? 'Catches a bug' : NO_BUG_BEHIND}
                />
                <span className="min-w-0 [overflow-wrap:anywhere]"><BreakableName text={rowLabel(c.name)} /></span>
              </span>
            )}
            {cols.map((b) => (
              <Cell
                key={b.id}
                hit={b.killers.includes(c.key)}
                dead={b.killers.length === 0}
                ran={b.ran.includes(c.key)}
              />
            ))}
            {!narrow && (
              <span className="min-w-0 pl-3.5">
                <RowFlag view={view} index={i} />
              </span>
            )}
          </div>
        ))}

        <span className="label-sm pt-2">Tests that catch it</span>
        {cols.map((b) => (
          <span
            key={b.id}
            className={`mono pt-2 text-center text-[12px] font-semibold ${
              b.killers.length ? 'text-ink2' : 'text-fail'
            }`}
          >
            {b.killers.length}
          </span>
        ))}
        {!narrow && <span />}
      </div>
    </div>
    </>
  );
}

function Legend() {
  const items: { style: React.CSSProperties; text: string }[] = [
    { style: { background: 'rgb(var(--c-pass))' }, text: 'The test fails on this bug, so it catches it' },
    { style: { border: '1.5px dashed rgb(var(--c-edge2))' }, text: 'The test still passes with the bug in' },
    { style: { border: '1.5px solid rgb(var(--c-fail))' }, text: 'No test catches this bug' },
    {
      // The same dash the cell draws, so the legend and the grid agree.
      style: { background: 'rgb(var(--c-edge2))', height: 2, borderRadius: 2, alignSelf: 'center' },
      text: 'The test is in the other suite, so it never ran against this bug',
    },
  ];
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2 text-[12px] text-ink2">
      {items.map((it) => (
        <span key={it.text} className="inline-flex items-center gap-[7px]">
          <span
            aria-hidden
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[4px]"
            style={
              it.style.height === 2
                ? undefined
                : { ...it.style, boxSizing: 'border-box' }
            }
          >
            {it.style.height === 2 && (
              <span className="inline-block h-[2px] w-3 rounded-sm" style={it.style} />
            )}
          </span>
          {it.text}
        </span>
      ))}
    </div>
  );
}

/* --------------------------------- the card ------------------------------ */

/**
 * The hint under the "No planted bug behind it" figure. The whole sentence ("A criterion test with no
 * planted bug behind it is still the right test.") ran to four lines of small type in a quarter of a 1280 px card; the
 * figure's own label already says "No planted bug behind it", so the hint says the rest in four words. None at zero.
 */
export function idleHint(idle: number): string | undefined {
  if (idle === 0) return undefined;
  return idle === 1 ? 'Still the right test.' : 'Still the right tests.';
}

/** The panel the page is named for: the four figures, the grid, the legend. */
export function MatrixCard({
  view,
  detail,
  /** The clock the report behind this grid was graded at. */
  matrixClock,
}: {
  view: MatrixView;
  detail: PhaseDetail;
  matrixClock?: string | null;
}) {
  const survivors = view.rows.filter((r) => !r.killers.length);
  const idle = view.columns.filter((c) => c.kills.length === 0);
  const need = view.total;
  const credited = isCredited(detail.id, detail);
  return (
    <div className="panel flex min-w-0 flex-col gap-3.5 px-4 py-4" data-testid="phase-testing-matrix">
      {/* The four figures share one row of four equal columns from 1280 px (two by two
          below it), so one long label no longer pushes the last figure onto a
          line of its own; the verdict chip sits at the row's end. */}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3" data-testid="phase-testing-matrix-stats">
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-3 xl:grid-cols-4" data-testid="phase-testing-matrix-figures">
        <Figure value={`${view.killed} of ${view.total}`} label="Bugs caught" tone="ink" />
        <Figure value={String(survivors.length)} label="Still alive" tone={survivors.length ? 'fail' : 'ink'} />
        {/* A criterion test with no planted bug behind it is still the
            right test, so the figure names the fact rather than scolding a
            learner who killed every bug and scored 100. */}
        <Figure
          value={String(idle.length)}
          label={NO_BUG_BEHIND}
          tone="ink"
          hint={idleHint(idle.length)}
        />
        <Figure value={`${need} of ${view.total}`} label="Needed for the gate" tone="ink" />
        </div>
        {/* A passing review waiting on the teacher's countersignature
            has met the evidence; what it waits on is the teacher. */}
        {/* A phase passed on the board by a teacher's credit, with no
            reviewed pass behind it, says so: the gate band's source. */}
        <Chip tone={credited ? 'warn' : detail.status === 'passed' ? 'pass' : phaseAwaitingSignOff(detail) ? SIGN_OFF_TONE : 'outline'}>{credited ? STATE_LABEL.credited : detail.status === 'passed' ? 'Pass' : phaseAwaitingSignOff(detail) ? AWAITING_SIGN_OFF : 'All required evidence must be met'}</Chip>
      </div>
      {/* Which day the sandbox called today when these rows were produced,
          and whether the phase has been moved off it since. */}
      <MatrixClock matrixClock={matrixClock} runClock={detail.runClock ?? null} />
      <MatrixGrid view={view} />
      <Legend />
    </div>
  );
}

/* ------------------------------ what to do ------------------------------- */

/** The order to work in: the bugs still alive first, then the tests that prove nothing. */
export function todo(view: MatrixView): { lead: string; rest: string }[] {
  const out: { lead: string; rest: string }[] = [];
  for (const { row, id } of view.rows.filter((r) => !r.killers.length)) {
    out.push({
      lead: `Write a test that fails when ${sentence(row.description)}`,
      rest: `It kills ${id}${row.covers ? ` and it is your own criterion ${row.covers}` : ''}.`,
    });
  }
  // Not "the happy path": a test no planted bug makes fail may be
  // a boundary ("a task due today has no late marker"); what is true of every
  // such test is that no planted bug makes it fail.
  for (const c of view.columns.filter((c) => c.kills.length === 0)) {
    out.push({
      lead: `Leave ${rowLabel(c.name)} but do not count on it.`,
      rest: NO_BUG_MAKES_IT_FAIL,
    });
  }
  return out.slice(0, 4);
}

/** What the list says of a test no planted bug makes fail. */
export const NO_BUG_MAKES_IT_FAIL = 'No planted bug makes it fail, so it catches none of them.';

/** A mutant description as the middle of a sentence: no capital, no full stop. */
function sentence(text: string): string {
  const t = text.trim().replace(/\.$/, '');
  return t ? `${t[0].toLowerCase()}${t.slice(1)}.` : '';
}

/**
 * The line over the list. The grid draws a bug no test catches in
 * red (its column's id, its count and its cells); a test no bug depends on is
 * not red. So the line points at red only where a bug survives, and says
 * nothing is red where every bug is caught.
 */
export function whatToDoPurpose(view: MatrixView, items: number): string {
  if (view.rows.some((r) => !r.killers.length)) return 'Read the red columns first: the bugs no test catches. In order:';
  return items === 1 ? 'Nothing is red: every planted bug is caught. One thing to know:' : 'Nothing is red: every planted bug is caught. In order:';
}

export function WhatToDo({ view }: { view: MatrixView }) {
  const items = todo(view);
  if (items.length === 0) return null;
  return (
    <Section
      title="What to do about it"
      purpose={whatToDoPurpose(view, items.length)}
      testId="phase-testing-matrix-todo"
    >
      <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-[1.45] text-ink2">
        {items.map((it) => (
          <li key={it.lead} className="wrap">
            <b className="text-ink">{it.lead}</b> {it.rest}
          </li>
        ))}
      </ol>
    </Section>
  );
}

/* --------------------------------- blocks -------------------------------- */

/**
 * A block on the reviewer's rail. The rail is already a panel, so the blocks
 * inside it are a heading and a body: no second border around each one.
 */
function Block({
  flat,
  title,
  purpose,
  testId,
  children,
}: {
  flat?: boolean;
  title: React.ReactNode;
  purpose?: React.ReactNode;
  testId?: string;
  children: React.ReactNode;
}) {
  if (flat)
    return (
      <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
        <SectionHead title={title} purpose={purpose} />
        {children}
      </div>
    );
  return (
    <Section title={title} purpose={purpose} testId={testId}>
      {children}
    </Section>
  );
}

/* ------------------------------ planted bugs ----------------------------- */

/** The six, each with the criterion it breaks and how many tests caught it. */
export function PlantedBugs({ view, flat = false }: { view: MatrixView; flat?: boolean }) {
  return (
    <Block
      flat={flat}
      title={`The ${count(view.total)} planted bug${view.total === 1 ? '' : 's'}`}
      purpose="Each one breaks a criterion. A bug is dead when at least one of your tests fails on it."
      testId="phase-testing-planted-bugs"
    >
      <Table
        minWidth={300}
        cols={[
          { label: 'Bug', width: 'minmax(0,1fr)' },
          // Its own width: a 56 px column broke "US-5/AC-2" over three lines.
          { label: 'Breaks', width: 'max-content', mono: true, muted: true },
          { label: 'Caught', width: 'auto', align: 'right' },
        ]}
        rowTestId={(i) => `phase-testing-matrix-row-${view.rows[i].row.mutant}`}
        rows={view.rows.map(({ row, id, killers }) => [
          <CellTitle
            key="b"
            state={killers.length ? 'pass' : 'fail'}
            title={`${id} ${row.mutant}`}
            detail={row.description}
          />,
          row.covers ?? '—',
          killers.length ? (
            <Chip key="c" tone="pass">
              Caught by {killers.length}
            </Chip>
          ) : (
            <Chip key="c" tone="fail">
              Not caught
            </Chip>
          ),
        ])}
      />
    </Block>
  );
}

const count = (n: number) => numberWord(n, 6);

/**
 * The line under the title. It says the two numbers the page is about, your
 * tests, their bugs, in words, because that is how a learner says it.
 */
export function matrixPurpose(view: MatrixView | null): string {
  const tail = 'A green cell means the test failed on that bug, which is what you want.';
  if (!view || view.total === 0) return `Your tests run against the planted bugs. ${tail}`;
  const tests = view.columns.length;
  return `Your ${count(tests)} test${tests === 1 ? ' runs' : 's run'} against ${count(view.total)} planted bug${
    view.total === 1 ? '' : 's'
  }. ${tail}`;
}

/* --------------------------------- the diff ------------------------------ */

/**
 * The plus line where every bug is caught: the bug drawn is one a
 * test already kills, so the line names the test that fails on it rather than
 * asking for a test that exists.
 */
export function caughtPlusLine(killers: string[]): string {
  const names = andList(killers.map(rowLabel));
  return killers.length === 1
    ? `Your test ${names} fails on it, so this bug is caught.`
    : `Your tests ${names} fail on it, so this bug is caught.`;
}

/**
 * The one line a planted bug changes, drawn as the diff it is: the first bug
 * still alive, or, when every one is caught, the last, with the test that
 * catches it.
 */
export function MutantDiff({ view, flat = false }: { view: MatrixView; flat?: boolean }) {
  const alive = view.rows.find((r) => !r.killers.length) ?? view.rows[view.rows.length - 1];
  if (!alive) return null;
  const { row, id, killers }: { row: MutantRow; id: string; killers: string[] } = alive;
  const plus = killers.length
    ? caughtPlusLine(killers)
    : row.covers
      ? `${row.covers} is your own criterion. Write it as a test and this bug dies.`
      : 'Write a test that fails on this behaviour and this bug dies.';
  return (
    <Block
      flat={flat}
      title={`What ${id} changes`}
      purpose="Revealed after you submit. One line, one wrong comparison."
      testId="phase-testing-mutant-diff"
    >
      <div className="mono overflow-x-auto rounded-ctl border-1.5 border-edge bg-code px-3 py-2 text-[12px] leading-[1.7] text-ink2">
        <p className="wrap m-0">
          @@ planted bug {id} @@ {row.mutant}
        </p>
        <p className="wrap m-0 text-fail">- {row.description}</p>
        <p className="wrap m-0 text-pass">+ {plus}</p>
      </div>
    </Block>
  );
}

/* -------------------------------- the hint ------------------------------- */

/** How many tests the evidence's read names in its sentence; more are counted there and listed under it. */
export const IDLE_NAMED = 3;

/**
 * The QA lead's read of the grid, above the thread. It names what is missing
 * without naming the test, which is the rule the persona works under.
 *
 * A finished project with fourteen tests no planted bug makes fail read all fourteen names in one
 * sentence before "fail." Up to {@link IDLE_NAMED} are named in the sentence; more are counted in it,
 * and their names are listed in a fold under it.
 */
export function MatrixRead({ view, className = '' }: { view: MatrixView; className?: string }) {
  const alive = view.rows.filter((r) => !r.killers.length);
  const idle = view.columns.filter((c) => c.kills.length === 0);
  if (alive.length === 0 && idle.length === 0) return null;
  const covered = alive.find((a) => a.row.covers);
  const folded = idle.length > IDLE_NAMED;
  const sentence = (
    <p className={`wrap text-[13.5px] leading-[1.5] text-ink ${className}`}>
      {alive.length > 0 &&
        `${alive.map((a) => a.id).join(' and ')} ${alive.length === 1 ? 'survives' : 'survive'} because no test fails on ${
          alive.length === 1 ? 'it' : 'them'
        }. `}
      {covered &&
        `Your own ${covered.row.covers} is the criterion ${covered.id} breaks; write it as a test and this bug dies. `}
      {/* Not "passes with every bug in place, so it proves nothing": a test in the other suite
          never ran against most bugs, and a criterion test no bug breaks is still the right test. */}
      {idle.length > 0 &&
        `No planted bug makes ${folded ? `${idle.length} of your tests` : andList(idle.map((c) => rowLabel(c.name)))} fail. A criterion test with no planted bug behind it is still the right test.`}
    </p>
  );
  if (!folded) return sentence;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="phase-testing-matrix-read">
      {sentence}
      <details className="text-[13px] text-ink2" data-testid="phase-testing-matrix-idle">
        <summary className="cursor-pointer">The {idle.length} tests</summary>
        <ul className="mono m-0 mt-1 flex list-disc flex-col gap-0.5 pl-5 text-[12px]">
          {idle.map((c) => (
            <li key={c.key} className="[overflow-wrap:anywhere]">
              <BreakableName text={rowLabel(c.name)} />
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
