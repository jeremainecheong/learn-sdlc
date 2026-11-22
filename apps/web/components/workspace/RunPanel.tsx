'use client';

import { useEffect, useRef, useState } from 'react';
import type { ExecutionRunView, RunResult, RunStep, TestCaseResult } from '@learnsdlc/shared';
import { isRunnerUnavailable, RUNNER_UNAVAILABLE_MESSAGE } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import type { PersonaThread } from '@/components/shell';
import { Chip, EmptyState, Notice, StatusSquare } from '@/components/ui';
import { ExplainTestButton } from './ExplainTest';
import { splitTrace, type Trace } from './trace';
import { QueueLine } from './QueueLine';
import { messageHead } from './message-head';
import { TestingRunEvidence } from './TestingRunEvidence';
import { clockTime } from './preview/copy';
import { clockWords } from './panels/testing/lib';

// Re-exported for the panel's own suite, which imports it from here.
export { splitTrace, type Trace } from './trace';

/**
 * What a case row needs to ask the reviewer about itself. Optional
 * throughout: the panel is also drawn where there is no thread to ask in.
 */
export interface ExplainProps {
  thread?: PersonaThread | null;
  onOpenThread?: () => void;
}

const TH = 'label-sm border-b-1.5 border-edge2 pb-1.5 text-left font-medium';
const TD = 'border-b-1.5 border-edge py-2.5 align-top';

const caseLabel = (status: TestCaseResult['status']) =>
  status === 'passed' ? 'Passed' : status === 'errored' ? 'Errored' : 'Failed';

/** Past this the message is a traceback, not a sentence, and folds away. */
const MESSAGE_HEAD = 240;
const MESSAGE_TEXT = 'mt-1 break-words font-mono text-[12px] leading-relaxed text-muted';

/**
 * A run the sandbox never ran.
 *
 * The result's stderr is the runner's own sentence when the transport cannot
 * run this kind of job at all, a TypeScript step where there is no node,
 * and that is shown verbatim, because the limit does not go away on the next
 * press. An empty stderr is the transport failing, which does go away, so the
 * sentence that says "try again" is the right one. Neither is a verdict, so
 * neither is drawn as one: no pass or fail box, no count, no cases.
 */
export function UnavailableNotice({ result }: { result: RunResult }) {
  const sentence = result.stderr.trim();
  return (
    <Notice tone="warn" testId="run-unavailable">
      {sentence || RUNNER_UNAVAILABLE_MESSAGE}
    </Notice>
  );
}


/**
 * What is happening to a run that has not finished.
 *
 * The page that owns the run polls it slowly on purpose, a verdict is worth
 * waiting for and a fast poll is forty learners hammering the API, so the row
 * it holds still says `queued` for a while after the sandbox has actually
 * picked the job up. The queue line polls every two seconds and is therefore
 * the first thing here to know, so it is what moves this sentence on.
 */
function Pending({ run }: { run: ExecutionRunView }) {
  const [startedRunning, setStartedRunning] = useState(false);
  useEffect(() => setStartedRunning(false), [run.id]);
  const waiting = run.status === 'queued' && !startedRunning;
  if (run.status === 'failed' && run.result && isRunnerUnavailable(run.result)) {
    // The row is failed because nothing ran, and the result it carries says
    // why: the runner's own sentence, or the transport's "try again".
    return <UnavailableNotice result={run.result} />;
  }
  return (
    <div>
      <p className="text-[13.5px] text-muted" data-testid="run-pending" role={run.status === 'failed' ? 'alert' : undefined}>
        {run.status === 'failed'
          ? run.error || 'The run failed to execute.'
          : waiting
            ? 'Waiting for a sandbox.'
            : 'Running in the sandbox…'}
      </p>
      <QueueLine
        kind="run"
        id={run.id}
        active={waiting}
        onLeftTheQueue={() => setStartedRunning(true)}
      />
    </div>
  );
}

/** One test as a sentence: state square, name, the assertion if it failed, and the result on the right. */
export function CaseRow({
  name,
  status,
  message,
  hidden,
  step,
  thread,
  onOpenThread,
}: TestCaseResult & ExplainProps) {
  const tone = status === 'passed' ? 'pass' : 'fail';
  const flat = message?.trim() ?? '';
  // A full traceback pushes every other case off the screen, so anything longer
  // than its first line opens on demand instead of by default.
  const folds = flat.length > MESSAGE_HEAD || flat.includes('\n');
  const trace = flat.includes('\n') ? splitTrace(flat) : null;
  return (
    <tr>
      <td className={`${TD} pr-3`}>
        <div className="flex items-start gap-2">
          <span className="pt-[3px]">
            <StatusSquare state={tone} size={11} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-all font-mono text-[12.5px] text-ink">{name}</span>
              {hidden && <Chip>Hidden</Chip>}
            </div>
            {flat &&
              (trace ? (
                <TraceView trace={trace} />
              ) : folds ? (
                <details className="mt-1">
                  <summary className="cursor-pointer break-words font-mono text-[12px] leading-relaxed text-muted marker:text-dim">
                    {messageHead(flat, MESSAGE_HEAD)}
                  </summary>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-muted">
                    {flat}
                  </pre>
                </details>
              ) : (
                <p className={MESSAGE_TEXT}>{flat}</p>
              ))}
          </div>
        </div>
      </td>
      <td className={`${TD} text-right`}>
        <div className="flex flex-col items-end gap-1.5">
          <Chip tone={tone}>{caseLabel(status)}</Chip>
          {/* Only where there is something to explain. A passing
              case has nothing to answer for, and there is no disabled ghost. */}
          {status !== 'passed' && (
            <ExplainTestButton
              testName={name}
              source="run"
              step={step}
              thread={thread}
              onOpenThread={onOpenThread}
            />
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * The cases of a run, grouped by the layer that produced them.
 *
 * A full-stack phase is graded by two runs, pytest over the API, the DOM
 * harness over the front end, merged into one result with a `steps[]` and a
 * `step` on each case. One flat list of thirty cases across two languages
 * hides which half is red, so each step draws its own block with its own
 * counts. A single-run result carries no `steps` and renders flat: no group,
 * no heading, one table.
 */
export function groupCases(result: RunResult): { step: RunStep; cases: TestCaseResult[] }[] {
  const steps = result.steps ?? [];
  if (!result.tests) return [];
  const cases = result.tests.cases;
  const groups = steps.map((step) => ({
    step,
    cases: cases.filter((c) => c.step === step.id),
  }));
  // A case that names no step, or names one the result does not carry, would
  // vanish between the groups. Nothing may disappear from a verdict, so an
  // orphan keeps the flat table: and that is also what answers a result with
  // no `steps` at all, every case in which is an orphan, so that case needs no
  // guard of its own.
  const grouped = groups.reduce((n, g) => n + g.cases.length, 0);
  if (grouped !== cases.length) return [];
  return groups;
}

export function RunResultView({
  result,
  thread,
  onOpenThread,
}: { result: RunResult } & ExplainProps) {
  // Not a verdict, whatever row it arrived on: the history endpoint can hand
  // back an unavailable result, and a pass or fail box over it would grade an
  // outage.
  if (isRunnerUnavailable(result)) return <UnavailableNotice result={result} />;
  const groups = groupCases(result);
  const total = result.tests?.total ?? 0;
  const passedCount = result.tests?.passed ?? 0;
  const allPassed = result.tests ? passedCount === total : result.ok;
  const summary = result.tests
    ? `${passedCount}/${total} tests passed`
    : result.ok
      ? 'Run completed successfully'
      : result.exitKind === 'timeout'
        ? 'Timed out'
        : 'Run failed';
  const chip = result.tests
    ? `${passedCount} of ${total}`
    : allPassed
      ? 'Passed'
      : result.exitKind === 'timeout'
        ? 'Timed out'
        : 'Failed';

  return (
    <div>
      {(result.stdout || result.stderr) && (
        <pre className="mono mb-2.5 max-h-44 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-[1.6] text-ink2">
          {result.stdout}
          {result.stderr && <span className="font-semibold text-fail">{result.stderr}</span>}
        </pre>
      )}
      <div
        className={`flex items-center justify-between gap-3 rounded-ctl border-1.5 border-edge px-3.5 py-2.5 ${
          allPassed ? 'bg-passtint' : 'bg-failtint'
        }`}
      >
        <p
          className="flex min-w-0 items-center gap-2 text-[13.5px] font-semibold text-ink"
          data-testid="run-summary"
        >
          <StatusSquare state={allPassed ? 'pass' : 'fail'} size={11} />
          <span>{summary}</span>
        </p>
        <Chip tone={allPassed ? 'pass' : 'fail'}>{chip}</Chip>
      </div>
      <p className="mt-1.5 text-right font-mono text-[12px] text-muted">
        Ran in {result.durationMs} ms
      </p>

      {result.tests &&
        (groups.length > 0 ? (
          groups.map((g) => (
            <section key={g.step.id} className="mt-3" data-testid={`run-step-${g.step.id}`}>
              <div className="flex items-center justify-between gap-3">
                <p className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-ink">
                  <StatusSquare state={g.step.ok ? 'pass' : 'fail'} size={10} />
                  <span className="truncate">{g.step.label}</span>
                </p>
                <Chip tone={g.step.ok ? 'pass' : 'fail'}>
                  {g.step.passed} of {g.step.total}
                </Chip>
              </div>
              <CaseTable cases={g.cases} thread={thread} onOpenThread={onOpenThread} />
            </section>
          ))
        ) : (
          <CaseTable cases={result.tests.cases} thread={thread} onOpenThread={onOpenThread} />
        ))}

    </div>
  );
}


/**
 * A failure, read the way a person reads one: what went wrong, then where in
 * their own code, then, only if they ask, everything the sandbox added.
 */
function TraceView({ trace }: { trace: Trace }) {
  return (
    <div className="mt-1" data-testid="case-trace">
      <p className={MESSAGE_TEXT}>{trace.headline}</p>
      {trace.own.length > 0 && (
        <ul className="mt-1 list-none space-y-0.5 p-0" data-testid="case-trace-own">
          {trace.own.map((line) => (
            <li key={line} className="break-words font-mono text-[12px] leading-relaxed text-ink2">
              {line}
            </li>
          ))}
        </ul>
      )}
      {trace.library.length > 0 && (
        <details className="mt-1">
          <summary
            className="cursor-pointer font-mono text-[12px] leading-relaxed text-muted marker:text-dim"
            data-testid="case-trace-more"
          >
            {trace.library.length === 1
              ? 'One more line, from the test framework'
              : `${trace.library.length} more lines, from the test framework`}
          </summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-muted">
            {trace.library.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}

/** One layer's cases, or every case when the run had only one layer. */
function CaseTable({
  cases,
  thread,
  onOpenThread,
}: { cases: TestCaseResult[] } & ExplainProps) {
  return (
    <table className="mt-2 w-full border-collapse">
      <thead>
        <tr>
          <th scope="col" className={TH}>
            Test
          </th>
          <th scope="col" className={`${TH} text-right`}>
            Result
          </th>
        </tr>
      </thead>
      <tbody>
        {cases.map((c) => (
          <CaseRow
            key={`${c.step ?? ''}${c.name}${String(c.hidden)}`}
            {...c}
            thread={thread}
            onOpenThread={onOpenThread}
          />
        ))}
      </tbody>
    </table>
  );
}

/**
 * What a run was run on, in a learner's words: the saved files at the run's local time, the
 * date the tests were given where one was pinned, and that later edits are not in it. The recorded inputs' hash is
 * the handle a person checking the record needs, so it is the line's title, not a word in it.
 */
export function runProvenance(run: Pick<ExecutionRunView, 'inputHash' | 'runClock' | 'createdAt'>): { text: string; title?: string } {
  if (!run.inputHash) return { text: 'An older run: the files it ran on were not kept.' };
  const dated = run.runClock ? `, with the date set to ${clockWords(run.runClock)}` : '';
  return {
    text: `Ran on your saved files at ${clockTime(run.createdAt)}${dated}. Edits since then are not in this result.`,
    title: `Recorded inputs ${run.inputHash}`,
  };
}

export function RunPanel({
  run,
  canRun,
  runLabel,
  busy,
  onRun,
  thread,
  onOpenThread,
  appearance = 'standard',
  readOnly = false,
}: {
  run: ExecutionRunView | null;
  canRun: boolean;
  runLabel: string;
  busy: boolean;
  onRun: () => void;
  appearance?: 'standard' | 'testing';
  /** Historical evidence must never start a run against today's editor. */
  readOnly?: boolean;
} & ExplainProps) {
  /*
   * A run that finishes while the panel is open opens on its headline: the pane's own scroll goes back
   * to its top, where the summary is, and the pane is brought into view in the room. A run that was already there
   * when the panel mounted (the room coming back to a phase) moves nothing.
   */
  const resultRef = useRef<HTMLDivElement>(null);
  const shownRun = useRef<string | null>(run && run.status === 'completed' ? run.id : null);
  useEffect(() => {
    if (!run || run.status !== 'completed' || !run.result || shownRun.current === run.id) return;
    shownRun.current = run.id;
    const box = resultRef.current;
    if (!box) return;
    box.scrollTop = 0;
    box.scrollIntoView?.({ block: 'nearest' });
  }, [run]);
  return (
    // The pane under the code is a console, not a document: it opens on the
    // run itself. The only chrome is the button that starts another one, on
    // the same line as the tab labels rather than over a heading of its own.
    <div className={`flex h-full flex-col ${appearance === 'testing' ? 'testing-run-panel' : ''}`} data-testid="run-panel">
      {run && <p className="shrink-0 px-3.5 pt-2 text-[12px] text-muted" data-testid="run-input-provenance" title={runProvenance(run).title}>
        {runProvenance(run).text}
      </p>}
      {canRun && !readOnly && (
        <div className="flex shrink-0 justify-end px-3.5 pt-2">
          <button
            onClick={onRun}
            disabled={busy}
            data-testid="run-button"
            className="btn-ghost btn-sm shrink-0"
          >
            <Icon name="run" size={13} />
            {busy ? 'Running…' : runLabel}
          </button>
        </div>
      )}
      <div ref={resultRef} className={`flex-1 overflow-y-auto px-3.5 pb-3 pt-1.5 ${appearance === 'testing' ? 'testing-run-content' : ''}`} aria-live="polite" aria-busy={busy}>
        {!canRun ? (
          <EmptyState
            icon="clipboard"
            title="Nothing to run"
            body="Write the artefact, then open the pull request for review."
          />
        ) : run && run.status !== 'completed' ? (
          // A queued run is a place in a line, not a spinner. The
          // sentence and its test id do not move: the line is a second
          // element under them, drawn only while the job is actually queued.
          <Pending run={run} />
        ) : busy ? (
          // The press comes first. A run asked for on a busy queue would
          // otherwise leave the last run's verdict standing, "0/6 tests
          // passed", stamped four minutes ago, as though it were the answer
          // to what was just pressed. The old verdict goes on the
          // same frame as the press, and the pane says what is happening
          // until the run itself arrives to say it.
          <p className="text-[13.5px] text-muted" data-testid="run-pending">
            Waiting for a sandbox.
          </p>
        ) : !run ? (
          <EmptyState
            icon="run"
            title="No run yet"
            body="Run early and often. This is the fast loop before you open the pull request."
          />
        ) : run.result ? (
          appearance === 'testing' && !isRunnerUnavailable(run.result)
            ? <TestingRunEvidence key={run.id} result={run.result} thread={thread} onOpenThread={onOpenThread}/>
            : <RunResultView result={run.result} thread={thread} onOpenThread={onOpenThread} />
        ) : null}
      </div>
    </div>
  );
}
