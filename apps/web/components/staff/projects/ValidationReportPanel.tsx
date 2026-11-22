'use client';

/**
 * The fast tier's report.
 *
 * Three things it is careful about.
 *
 * **A failed row reads exactly what publish would refuse with.** The sentence
 * is the server's, carried on the check, and this panel prints it unchanged. A
 * teacher who reads one wording while drafting and another at the door learns
 * to distrust both.
 *
 * **`not-applicable` is neutral, not a near-miss.** Eighteen of the content
 * checks do not apply to a project with no application, and eighteen grey rows
 * are a worse first impression than one line saying so, which is what
 * `notApplicableLine` is. The rows are collapsed behind it and can be opened.
 *
 * **It says which tier ran.** The fast tier touches no microVM and runs on
 * every save, and its line says the sandbox proofs are deep validation's, not
 * its own, which is better than leaving a teacher to assume this report is the
 * whole of it. Its time names the month ("10 November at 00:56"), so no
 * browser's locale can read it as another day.
 *
 * **A check id is not a row's identity.** `fastValidation` pushes one
 * `phase-holds-one-task` row *per phase*, one gating row *per phase* and one
 * supported-stack row *per unsupported package*, so a copied six-phase project
 * carries six rows under each of two ids. What tells two rows apart is the id
 * **and what the row is about**, its phase, its task, or, where it is about
 * neither, where it sits in the run. `checkRowId` is that, and it is what both
 * the React key and the test id are built from.
 *
 * **A row that does not hold never wears the passed marker.** On
 * a draft the server keeps a few rows `passed` so they do not block publish,
 * and marks them `advisory`: a warning to fix, a note of a fact, and the deep
 * validation receipt of a phase whose deep validation has not run on these
 * bytes ("Not run yet"; "Out of date" when the editor's deep validation read
 * shows a run on earlier bytes; "Failed" when it shows a run on these bytes
 * that failed; "Passed" when it shows one that passed, since a deep run does
 * not refresh the saved checks). Each reads as what it is, in its marker, its spoken name and a word
 * beside the heading: the heading states the rule, the word says whether it
 * holds. `checkState` only names the state; what blocks publish is still the
 * report's `failed` rows and nothing else.
 */
import { useState } from 'react';
import type { DeepValidationView, PhaseKey, ValidationCheck, ValidationReport } from '@learnsdlc/shared';
import { pluralWord } from '@learnsdlc/shared';
import { PHASE_META, type StatusState } from '@/lib/phase';
import { Button, Chip, Notice, Section, StatusSquare } from '@/components/ui';
import { describeInstant } from '@/lib/schedule';

/**
 * The deep validation receipt's check id. The API's own constant of the same
 * name (`apps/api/src/authoring/validation.ts`) is the source; the web cannot
 * import it, so `validation-states` reads that file and fails if the two
 * ever differ, rather than letting "Not run yet" silently read as "Warning".
 */
export const DEEP_RECEIPT_CHECK_ID = 'deep-validation-current';

/** How one row reads. Only `failed` blocks publish; the others are words. */
type CheckState = 'passed' | 'failed' | 'not-applicable' | 'warning' | 'note' | 'not-run' | 'out-of-date';

/**
 * Whether the draft's last deep validation ran on bytes it no longer holds.
 * The receipt row cannot say (its sentence is the same for never and for
 * stale); the deep validation read can, and this is the editor rail's own
 * rule for "Out of date": a run that finished, passed or failed, and is not
 * current. No read, or a run in flight, is not out of date.
 */
export function deepRunOutOfDate(deep: DeepValidationView | null | undefined): boolean {
  return Boolean(deep && !deep.current && (deep.status === 'passed' || deep.status === 'failed'));
}

/**
 * Whether the draft's last deep validation ran on the bytes it holds now and
 * failed. The receipt row reads the same sentence as for a run never made (the
 * API counts only a passed receipt as current); the deep validation read says
 * "Failed", and the row says the same. Words only: the row stays a `passed`
 * advisory in the report, so what publish decides does not change.
 */
export function deepRunFailed(deep: DeepValidationView | null | undefined): boolean {
  return Boolean(deep && deep.current && deep.status === 'failed');
}

/**
 * Whether the draft's last deep validation ran on the bytes it holds now and
 * passed. A deep run never refreshes the saved checks, so until "Run the
 * checks" the receipt row may still hold the refusal from before the run.
 */
export function deepRunPassed(deep: DeepValidationView | null | undefined): boolean {
  return Boolean(deep && deep.current && deep.status === 'passed');
}

/**
 * How a row reads. For the deep validation receipt, a finished run on these
 * bytes says what the receipt is, whatever the saved list held: passed reads
 * "Passed", failed reads "Failed". A run on older
 * bytes makes a receipt the list holds as passed "Out of date"; one failed at
 * the door stays "Failed", which is still true. Words only: the report and
 * what publish decides do not read this.
 */
export function checkState(row: ValidationCheck, deepOutOfDate = false, deepFailed = false, deepPassed = false): CheckState {
  if (row.id === DEEP_RECEIPT_CHECK_ID && row.status !== 'not-applicable') {
    if (deepPassed) return 'passed';
    if (deepFailed) return 'failed';
    if (deepOutOfDate && row.status === 'passed') return 'out-of-date';
  }
  if (row.status !== 'passed' || !row.advisory) return row.status;
  if (row.id === DEEP_RECEIPT_CHECK_ID) return 'not-run';
  return row.advisory;
}

/**
 * The receipt's sentence when the saved one says the opposite of the state
 * drawn: the refusal ("it has no current deep validation") is true of a run
 * not made, failed or out of date, and false of a pass; the pass ("passed
 * against these exact bytes") is true of a pass only. Any other row, and a
 * receipt whose sentence holds, prints the server's sentence unchanged.
 */
const RECEIPT_SENTENCE: Partial<Record<CheckState, string>> = {
  passed:
    'Deep validation passed against these exact bytes after these checks last ran. Run the checks to bring this list up to date.',
  failed:
    'Deep validation failed against these exact bytes after these checks last ran, and publishing needs a passing run. Run the checks to bring this list up to date.',
  'out-of-date':
    'The last deep validation was made against an earlier state of the draft. Run deep validation again before you publish.',
};

function checkSentence(row: ValidationCheck, state: CheckState): string {
  if (row.id !== DEEP_RECEIPT_CHECK_ID) return row.sentence;
  const refusal = row.status === 'failed' || Boolean(row.advisory);
  const holds = refusal ? state !== 'passed' : state === 'passed';
  return holds ? row.sentence : (RECEIPT_SENTENCE[state] ?? row.sentence);
}

const TONE: Record<CheckState, StatusState> = {
  passed: 'pass',
  failed: 'fail',
  'not-applicable': 'todo',
  warning: 'warn',
  note: 'todo',
  'not-run': 'todo',
  // The rail draws its "Out of date" step with the warning marker.
  'out-of-date': 'warn',
};

/** The word beside the heading, and the marker's spoken name. */
export const CHECK_WORD: Record<CheckState, string> = {
  passed: 'Passed',
  failed: 'Failed',
  'not-applicable': 'Does not apply',
  warning: 'Warning, does not block publishing',
  note: 'Note, does not block publishing',
  'not-run': 'Not run yet, run deep validation before you publish',
  'out-of-date': 'Out of date, run deep validation again before you publish',
};

/** The word drawn beside the heading; a plain pass and a row that does not apply keep their rows as they were. */
const SHORT_WORD: Record<CheckState, string> = {
  passed: '',
  failed: 'Failed',
  'not-applicable': '',
  warning: 'Warning',
  note: 'Note',
  'not-run': 'Not run yet',
  'out-of-date': 'Out of date',
};

/**
 * What identifies one row of one report: its id, plus the phase and the task it
 * is about. A row about neither takes the place it holds in the run, because an
 * id alone repeats and a repeated key is a list React cannot re-render
 * honestly, and a repeated test id is six rows a test reads as one.
 */
function checkRowId(row: ValidationCheck, at: number): string {
  const scope = [row.phaseKey, row.taskKey].filter(Boolean).join('-');
  return scope ? `${row.id}-${scope}` : `${row.id}-${at + 1}`;
}

/**
 * The report's failed rows, plus the receipts a failed deep run on these bytes
 * names "Failed", less a receipt failed at the door that a pass on these bytes
 * names "Passed".
 */
function failedCount(report: ValidationReport | null, rows: readonly ValidationCheck[], states: readonly CheckState[]): number {
  return (
    (report?.failed ?? 0) +
    rows.filter((row, at) => row.status !== 'failed' && states[at] === 'failed').length -
    rows.filter((row, at) => row.status === 'failed' && states[at] !== 'failed').length
  );
}

/**
 * The "N failed" the panel's count line says, for the editor's Validate tab
 * so the tab and the panel never disagree.
 */
export function failedCheckCount(report: ValidationReport | null, deep: DeepValidationView | null | undefined): number {
  const rows = report?.checks ?? [];
  const states = rows.map((row) => checkState(row, deepRunOutOfDate(deep), deepRunFailed(deep), deepRunPassed(deep)));
  return failedCount(report, rows, states);
}

/**
 * The line under the panel's heading: which tier ran, and when.
 *
 * A fast report says when its checks ran. A deep run never refreshes the saved
 * checks, so once one on these bytes finishes after them, its receipt rows
 * read that run ("Passed" or "Failed") while the line still names the fast
 * run's earlier time. The line then says which rows read the deep
 * run, and its time, so the count under it ("20 passed, 0 failed.") is not
 * read as twenty checks run at the earlier time. In every other state, the one
 * before any deep run among them, the line is the fast tier's own sentence.
 */
export function tierLine(report: ValidationReport, deep: DeepValidationView | null | undefined): string {
  if (report.tier !== 'fast') return `The deep tier ran on ${describeInstant(report.ranAt)}, sandbox proofs included.`;
  const fast = `These checks ran on ${describeInstant(report.ranAt)} and touch no sandbox`;
  const receipts = report.checks.filter((row) => row.id === DEEP_RECEIPT_CHECK_ID && row.status !== 'not-applicable').length;
  const finished = deep?.finishedAt ? Date.parse(deep.finishedAt) : NaN;
  const after = Number.isFinite(finished) && finished > Date.parse(report.ranAt);
  const verdict = deepRunPassed(deep) ? 'passed' : deepRunFailed(deep) ? 'failed' : null;
  if (receipts === 0 || !after || verdict === null || !deep?.finishedAt) {
    return `${fast}. Deep validation runs the sandbox proofs.`;
  }
  const which = receipts === 1 ? 'the row on deep validation, which reads' : `the ${receipts} rows on deep validation, which read`;
  return `${fast}, except ${which} its run that ${verdict} on ${describeInstant(deep.finishedAt)}.`;
}

/** Where a failed row takes the teacher: its phase, and its task when it names one. */
type GoToField = (phaseKey: PhaseKey, taskKey: string | null) => void;

/** A task's title by its phase and key, from the draft the editor holds; undefined where it has none. */
type TaskTitleOf = (phaseKey: PhaseKey, taskKey: string) => string | undefined;

/** A row's phase by its title: the phase key is never drawn where the title exists. */
function phaseName(row: ValidationCheck): string {
  return row.phaseKey ? (PHASE_META[row.phaseKey as PhaseKey]?.title ?? row.phaseKey) : '';
}

/** A row's task by its title where the editor knows it, or its key, the only handle left. */
function taskName(row: ValidationCheck, taskTitleOf?: TaskTitleOf): string {
  if (!row.taskKey) return '';
  return (row.phaseKey && taskTitleOf?.(row.phaseKey as PhaseKey, row.taskKey)) || row.taskKey;
}

function goToLabel(row: ValidationCheck, taskTitleOf?: TaskTitleOf): string {
  const phase = phaseName(row);
  return row.taskKey ? `Go to ${phase}, task ${taskName(row, taskTitleOf)}` : `Go to ${phase}`;
}

function CheckRow({
  row,
  rowId,
  onGoTo,
  taskTitleOf,
  deepOutOfDate = false,
  deepFailed = false,
  deepPassed = false,
}: {
  row: ValidationCheck;
  rowId: string;
  onGoTo?: GoToField;
  taskTitleOf?: TaskTitleOf;
  deepOutOfDate?: boolean;
  deepFailed?: boolean;
  deepPassed?: boolean;
}) {
  const state = checkState(row, deepOutOfDate, deepFailed, deepPassed);
  return (
    <li
      className="flex min-w-0 flex-col gap-1 border-b-1.5 border-edge px-4 py-3 last:border-b-0"
      data-testid={`project-check-${rowId}`}
      data-state={state}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusSquare state={TONE[state]} label={CHECK_WORD[state]} />
        {/* On a phone the heading wraps beside its state word; from `sm` up it keeps one line, and its title holds the whole rule. */}
        <span
          className="wrap min-w-0 flex-1 text-[13px] font-semibold text-ink sm:truncate"
          title={row.label}
          data-testid={`project-rule-${rowId}`}
        >
          {row.label}
        </span>
        {SHORT_WORD[state] && (
          <span
            className={`label-sm flex-none font-medium${state === 'warning' || state === 'out-of-date' ? ' text-warn' : state === 'failed' ? ' text-fail' : ''}`}
            data-testid={`project-state-word-${rowId}`}
            aria-hidden="true"
          >
            {SHORT_WORD[state]}
          </span>
        )}
        {/* The phase's and the task's names, as the editor's tabs and rows write them. */}
        {row.phaseKey && <Chip tone="outline">{phaseName(row)}</Chip>}
        {row.taskKey && <Chip tone="outline">{taskName(row, taskTitleOf)}</Chip>}
      </div>
      <p className="purpose wrap">{checkSentence(row, state)}</p>
      {row.files.length > 0 && (
        <p className="mono text-[12px] text-ink2">{row.files.join(', ')}</p>
      )}
      {/* A failure the teacher can fix in the editor links to it; nothing they typed is cleared. A receipt failed at the door that a later pass now reads as passed has none. */}
      {row.status === 'failed' && state === 'failed' && row.phaseKey && onGoTo && (
        <span>
          <Button
            size="sm"
            variant="ghost"
            testId={`project-goto-${rowId}`}
            onClick={() => onGoTo(row.phaseKey as PhaseKey, row.taskKey)}
          >
            {goToLabel(row, taskTitleOf)}
          </Button>
        </span>
      )}
    </li>
  );
}

export function ValidationReportPanel({
  report,
  running,
  onRun,
  onGoTo,
  deep,
  taskTitleOf,
}: {
  report: ValidationReport | null;
  running: boolean;
  onRun: () => void;
  /** Opens the phase (and task) a failed row is about, and focuses its first field. */
  onGoTo?: GoToField;
  /** Names a row's task by its title; without it the row names the task by its key. */
  taskTitleOf?: TaskTitleOf;
  /** The draft's last deep validation as the editor read it, so a receipt run on older bytes reads "Out of date", and one that failed or passed on these bytes "Failed" or "Passed". Words only. */
  deep?: DeepValidationView | null;
}) {
  const [showNeutral, setShowNeutral] = useState(false);
  const outOfDate = deepRunOutOfDate(deep);
  const deepFailed = deepRunFailed(deep);
  const deepPassed = deepRunPassed(deep);
  // Identified over the whole run, before the split, so the place a row holds is
  // the place it held in the report rather than in one of the two lists.
  const rows = (report?.checks ?? []).map((row, at) => ({ row, rowId: checkRowId(row, at) }));
  const loud = rows.filter(({ row }) => row.status !== 'not-applicable');
  const neutral = rows.filter(({ row }) => row.status === 'not-applicable');
  // The count says a pass only of a row that holds; the rows publish lets
  // through without holding are counted as what they are.
  const states = rows.map(({ row }) => checkState(row, outOfDate, deepFailed, deepPassed));
  const count = (state: CheckState) => states.filter((one) => one === state).length;
  const plain = count('passed');
  const warnings = count('warning');
  const notes = count('note');
  const unrun = count('not-run');
  const stale = count('out-of-date');
  const failed = failedCount(report, rows.map(({ row }) => row), states);
  const countLine = [
    `${plain} passed`,
    ...(warnings ? [`${warnings} ${pluralWord(warnings, 'warning')}`] : []),
    ...(notes ? [`${notes} ${pluralWord(notes, 'note')}`] : []),
    ...(unrun ? [`${unrun} not run yet`] : []),
    ...(stale ? [`${stale} out of date`] : []),
    `${failed} failed`,
  ].join(', ');

  return (
    <Section
      title="Validate"
      purpose="Every check publish would re-run, with the sentence it would refuse with."
      testId="project-validation"
      pad={false}
      right={
        <Button size="sm" busy={running} busyLabel="Checking…" testId="project-validate" onClick={onRun}>
          Run the checks
        </Button>
      }
    >
      {report === null ? (
        <div className="px-4 pb-4">
          <Notice tone="info" testId="project-validation-empty">
            Validation has not run on this draft. These checks touch no sandbox, so they cost
            nothing to run now.
          </Notice>
        </div>
      ) : (
        <>
          <p className="purpose px-4" data-testid="project-validation-tier">
            {tierLine(report, deep)}
          </p>
          <div className="flex flex-col gap-1.5 px-4">
            <p className="label-sm" data-testid="project-validation-counts">
              {`${countLine}.`}
            </p>
            {report.passed + report.failed > 0 && (
              // One segment per state the rows and the count line name, in the
              // rows' marker colours: notes and receipts not run yet are the
              // neutral marker's edge, so a draft of only those is not drawn empty;
              // a receipt out of date is the warning colour, as its marker is.
              <span
                className="flex h-1.5 w-full overflow-hidden rounded-full bg-raised"
                role="img"
                aria-label={`Check results: ${countLine}`}
                data-testid="project-validation-bar"
              >
                <span className="bg-pass" style={{ flexGrow: plain }} data-state="passed" />
                <span className="bg-warn" style={{ flexGrow: warnings }} data-state="warning" />
                <span className="bg-edge2" style={{ flexGrow: notes }} data-state="note" />
                <span className="bg-edge2" style={{ flexGrow: unrun }} data-state="not-run" />
                <span className="bg-warn" style={{ flexGrow: stale }} data-state="out-of-date" />
                <span className="bg-fail" style={{ flexGrow: failed }} data-state="failed" />
              </span>
            )}
          </div>
          {loud.length > 0 && (
            <ul className="m-0 flex list-none flex-col p-0" aria-busy={running || undefined}>
              {loud.map(({ row, rowId }) => (
                <CheckRow
                  key={rowId}
                  row={row}
                  rowId={rowId}
                  onGoTo={onGoTo}
                  taskTitleOf={taskTitleOf}
                  deepOutOfDate={outOfDate}
                  deepFailed={deepFailed}
                  deepPassed={deepPassed}
                />
              ))}
            </ul>
          )}
          {report.notApplicableLine && (
            <div className="flex flex-wrap items-center gap-2 px-4 pb-4 pt-3">
              <span className="label-sm" data-testid="project-validation-skipped">
                {report.notApplicableLine}
              </span>
              <Button
                size="sm"
                variant="ghost"
                testId="project-validation-skipped-toggle"
                onClick={() => setShowNeutral((was) => !was)}
              >
                {showNeutral ? 'Hide them' : 'Show them'}
              </Button>
            </div>
          )}
          {showNeutral && neutral.length > 0 && (
            <ul className="m-0 flex list-none flex-col border-t-1.5 border-edge p-0">
              {neutral.map(({ row, rowId }) => (
                <CheckRow key={rowId} row={row} rowId={rowId} taskTitleOf={taskTitleOf} />
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}
