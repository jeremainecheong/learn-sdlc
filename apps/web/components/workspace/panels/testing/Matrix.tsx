'use client';

/**
 * The kill matrix: the planted bugs down the rows, the learner's tests
 * across the columns. A filled cell is a test that failed on that bug, which
 * is the only proof a test has any detection power.
 */
import { andList } from '@learnsdlc/shared';
import type { PersonaThread } from '@/components/shell';
import { Chip, EmptyState, Notice, Section, StatusSquare } from '@/components/ui';
import { ExplainTestButton } from '@/components/workspace/ExplainTest';
import { ListRow, SubHead } from './Rows';
import { NO_BUG_BEHIND, clockWords, type MatrixView } from './lib';

/** "Catches B1 and B2, the same bugs as T2."; one bug reads "the same bug as". */
export function twinDetail(kills: string[], twinOf: string | undefined): string {
  return `Catches ${andList(kills)}, the same bug${kills.length === 1 ? '' : 's'} as ${twinOf}.`;
}

/**
 * The one sentence for the planted bugs before the first submission,
 * said the same way wherever the grid is entered before it exists: this
 * panel, the Planted bugs view and the room's Planted bugs tab.
 */
export const PLANTED_BUGS_EMPTY =
  'The planted bugs run against your tests when the pull request goes in. Submit, and the grid lands here.';

const TH = 'label-sm border-b-1.5 border-edge2 pb-1.5 text-left align-bottom font-medium';
const TD = 'border-b-1.5 border-edge py-2.5 align-top';

/** One figure from the grid, said in words above it. */
function MatrixStat({
  value,
  label,
  tone,
}: {
  value: string;
  label: string;
  tone: 'pass' | 'fail' | 'warn' | 'muted';
}) {
  const ink =
    tone === 'pass' ? 'text-pass' : tone === 'fail' ? 'text-fail' : tone === 'warn' ? 'text-warn' : 'text-ink';
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-ctl border-1.5 border-edge bg-raised px-2.5 py-2">
      <span className={`text-[17px] font-bold leading-none tabular-nums ${ink}`}>{value}</span>
      <span className="label-sm wrap">{label}</span>
    </div>
  );
}

/**
 * The clock line above the grid, and the notice when the grid was run at a
 * different one from the phase's now.
 *
 * Every mutant in one report saw the same day, which is the property the grid
 * is read for. Two submissions at different clocks are two different
 * questions, so the page says so rather than letting the rows be compared.
 */
export function MatrixClock({
  matrixClock,
  runClock,
}: {
  /** The clock the report was graded at; undefined when it does not carry one. */
  matrixClock: string | null | undefined;
  /** The clock the phase is set to now. */
  runClock: string | null | undefined;
}) {
  if (matrixClock === undefined) return null;
  const moved = (matrixClock ?? null) !== (runClock ?? null);
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {/* The date the run gave the tests, in words a learner reads (not "the machine's clock"). */}
      <p className="label-sm" data-testid="matrix-clock">
        {matrixClock ? `Run with the date set to ${clockWords(matrixClock)}.` : 'Run with the real date, not a pinned one.'}
      </p>
      {moved && (
        <Notice tone="info" testId="matrix-clock-changed">
          The last submission ran at a different clock, so these rows are not comparable. Submit again
          to redraw the matrix.
        </Notice>
      )}
    </div>
  );
}

export function Matrix({
  view,
  submitLabel,
  busy,
  onSubmit,
  matrixClock,
  runClock,
  unrunCase,
  thread,
  onOpenThread,
}: {
  view: MatrixView;
  submitLabel: string;
  busy: boolean;
  onSubmit: () => void;
  /** The clock the report behind this grid was graded at. */
  matrixClock?: string | null;
  /** The clock the phase is set to now. */
  runClock?: string | null;
  /**
   * The first case of this report that did not pass on the reference copy.
   * It is why the grid did not run, so it is the one thing worth
   * asking the reviewer about here: a surviving mutant is a different
   * question, and the grid itself answers that one.
   */
  unrunCase?: { name: string; step?: string } | null;
  thread?: PersonaThread | null;
  onOpenThread?: () => void;
}) {
  const { columns, rows, killed, total } = view;
  const survivors = rows.filter((r) => !r.row.killed);
  const soleFor = (key: string) => rows.filter((r) => r.killers.length === 1 && r.killers[0] === key).map((r) => r.id);
  /** A load-bearing test: only say "the only test" twice when the two sets differ. */
  const soleDetail = (kills: string[], sole: string[]) =>
    kills.length === sole.length
      ? `The only test that catches ${andList(sole)}.`
      : `Catches ${andList(kills)}, and the only test that catches ${andList(sole)}.`;

  return (
    <Section
      // The row's name for the view: one name for the planted bugs, as the planted bugs page says.
      title="Planted bugs"
      purpose="The planted bugs down the rows, your tests across the columns as T1 up. A filled cell is a test that fails on that bug, which is what you want; the test each column stands for is named under the grid."
      right={
        total > 0 ? (
          <Chip tone={killed === total ? 'pass' : 'outline'}>
            {killed} of {total} caught
          </Chip>
        ) : undefined
      }
      pad={false}
      testId="phase-testing-matrix"
    >
      {total === 0 ? (
        <div className="px-4">
          <EmptyState
            icon="bug"
            title="No planted bugs have run yet"
            body={PLANTED_BUGS_EMPTY}
            action={
              <button type="button" className="btn btn-sm" onClick={onSubmit} disabled={busy}>
                {submitLabel}
              </button>
            }
          />
        </div>
      ) : (
        <>
          <div className="px-4">
            <MatrixClock matrixClock={matrixClock} runClock={runClock} />
          </div>
          {view.unrun && (
            <div className="flex flex-col items-start gap-2 px-4">
              <Notice tone="warn">
                Your suite has to pass on the reference implementation before the planted bugs run. Every test has to be
                green there first.
              </Notice>
              {unrunCase && (
                <ExplainTestButton
                  testName={unrunCase.name}
                  source="submission"
                  step={unrunCase.step}
                  thread={thread}
                  onOpenThread={onOpenThread}
                />
              )}
            </div>
          )}

          {columns.length > 0 && (
            <div className="flex flex-col gap-3">
              {/* The four numbers the grid is read for, before the grid: a
                  learner scanning the panel wants "how many are still alive"
                  without counting cells. */}
              <div className="grid grid-cols-2 gap-2 px-4 sm:grid-cols-4" data-testid="phase-testing-matrix-stats">
                <MatrixStat value={`${killed} of ${total}`} label="Bugs caught" tone={killed === total ? 'pass' : 'warn'} />
                <MatrixStat value={String(survivors.length)} label="Still alive" tone={survivors.length ? 'fail' : 'pass'} />
                {/* Not "tests that catch nothing": a test with no planted bug
                    behind it is a fact about the mutant table, not a verdict
                    on the learner's test, and a learner who has just scored
                    100 would be told fourteen of their tests caught nothing.
                    `MatrixDoc` says it the same way. */}
                <MatrixStat
                  value={String(columns.filter((c) => c.verdict === 'kills-nothing').length)}
                  label="Tests with no bug behind them"
                  tone="muted"
                />
                <MatrixStat value={String(columns.length)} label="Tests you wrote" tone="muted" />
              </div>

              {/* `relative` so the sr-only caption (position: absolute) is
                  contained by this scroller instead of widening the page. */}
              <div className="relative overflow-x-auto px-4">
                <table className="min-w-max border-collapse">
                  <caption className="sr-only">
                    Planted bugs down the rows, your tests across the columns. A cell says whether that test fails on
                    that bug.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" className={`${TH} w-[176px] pr-3`}>
                        Planted bug
                      </th>
                      {columns.map((c) => (
                        <th key={c.key} scope="col" className={`${TH} w-7 px-0 text-center`} title={c.name}>
                          <span className="mono block text-center font-semibold text-ink">{c.label}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ row, id, killers, ran }) => (
                      <tr key={row.mutant} data-testid={`phase-testing-matrix-row-${row.mutant}`}>
                        <th scope="row" className={`${TD} pr-3 text-left font-normal`}>
                          <div className="flex items-start gap-2.5">
                            <StatusSquare
                              state={row.killed ? 'pass' : 'fail'}
                              size={11}
                              className="mt-[5px]"
                              label={row.killed ? 'Caught' : 'Still alive'}
                            />
                            <span className="flex min-w-0 flex-col gap-0.5">
                              <span className="mono wrap font-semibold text-ink">
                                {id} {row.mutant}
                              </span>
                              <span className="wrap text-[12.5px] leading-[1.4] text-ink2">{row.description}</span>
                              {row.covers && <span className="label-sm wrap">Breaks {row.covers}</span>}
                            </span>
                          </div>
                        </th>
                        {columns.map((c) => {
                          const hit = killers.includes(c.key);
                          if (!ran.includes(c.key)) {
                            return (
                              <td key={c.key} className={`${TD} px-0 align-middle`}>
                                <span
                                  className="flex justify-center text-ink2"
                                  title="This test is in the other suite, so it never ran against this bug"
                                >
                                  <span className="sr-only">Not run against this bug</span>
                                  <span aria-hidden>—</span>
                                </span>
                              </td>
                            );
                          }
                          return (
                            <td key={c.key} className={`${TD} px-0 align-middle`}>
                              <span className="flex justify-center">
                                <StatusSquare
                                  state={hit ? 'pass' : 'todo'}
                                  size={16}
                                  label={hit ? 'Catches it' : 'Does not catch it'}
                                />
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" className="label-sm pt-2 pr-3 text-left font-medium">
                        Tests that catch it
                      </th>
                      {columns.map((c) => (
                        <td key={c.key} className="mono pt-2 text-center font-semibold text-ink2">
                          {c.kills.length}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="flex flex-col gap-1.5 px-4">
                {[
                  ['pass', 'The test fails on this bug, so it catches it'],
                  ['todo', 'The test still passes with the bug in'],
                  ['fail', 'No test catches this bug'],
                ].map(([state, text]) => (
                  <span key={text} className="flex items-center gap-2.5 text-[12.5px] text-ink2">
                    <StatusSquare state={state as 'pass' | 'todo' | 'fail'} size={12} />
                    {text}
                  </span>
                ))}
                <span className="flex items-center gap-2.5 text-[12.5px] text-ink2">
                  <span aria-hidden className="w-3 text-center">
                    —
                  </span>
                  The test is in the other suite, so it never ran against this bug
                </span>
              </div>
            </div>
          )}

          {columns.length > 0 && (
            <div className="flex flex-col gap-2">
              <SubHead
                title="What each test catches"
                purpose="A test only proves something if it fails when the code is wrong."
              />
              {columns.map((c) => (
                <ListRow
                  key={c.key}
                  state={c.verdict === 'kills-nothing' ? 'now' : 'pass'}
                  mono
                  title={`${c.label} ${c.name}`}
                  detail={
                    c.verdict === 'kills-nothing'
                      ? 'No planted bug depends on this one, so the matrix has nothing to say about it.'
                      : c.verdict === 'twin'
                        ? twinDetail(c.kills, c.twinOf)
                        : c.verdict === 'load-bearing'
                          ? soleDetail(c.kills, soleFor(c.key))
                          : `Catches ${andList(c.kills)}.`
                  }
                  right={
                    c.verdict === 'kills-nothing' ? (
                      <Chip tone="neutral">{NO_BUG_BEHIND}</Chip>
                    ) : c.verdict === 'load-bearing' ? (
                      <Chip tone="pass">Load-bearing</Chip>
                    ) : c.verdict === 'twin' ? (
                      <Chip tone="outline">Twin</Chip>
                    ) : (
                      <Chip>Catches {c.kills.length}</Chip>
                    )
                  }
                />
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <SubHead
              title="Bugs still alive"
              purpose="Each one passes every test you have written, so the criterion it breaks is unproven."
            />
            {survivors.length === 0 ? (
              <div className="px-4">
                <Notice tone="pass">Every planted bug fails on at least one of your tests.</Notice>
              </div>
            ) : (
              survivors.map(({ row, id }) => (
                <ListRow
                  key={row.mutant}
                  state="fail"
                  mono
                  title={`${id} ${row.mutant}`}
                  detail={
                    row.covers
                      ? `${row.description} It leaves ${row.covers} unproven.`
                      : row.description
                  }
                  right={<Chip tone="fail">Not caught</Chip>}
                />
              ))
            )}
          </div>
        </>
      )}
    </Section>
  );
}
