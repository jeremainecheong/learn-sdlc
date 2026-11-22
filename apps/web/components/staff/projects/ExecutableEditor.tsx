'use client';

/**
 * The editor for a phase's sole executable task.
 *
 * What a teacher may change on a coding or testing task they own is what the
 * API's `editedExecutableSlice` accepts (the API's slice is the truth): each
 * run's label and what it collects, a coding run's visible tests, and (on a
 * testing task) how many tests the learner's suite must hold. The brief is
 * not here: it is the Brief step's, so no save of this editor carries one. What the API refuses to change is shown read-only, with no control:
 * the starter files a learner works in, each run's shape (a closed list,
 * `RUN_SHAPES`: there is no command to type), a testing run's learner test
 * files and the coverage keywords. They change by uploading the project again.
 * `owns` and the coverage keywords are never sent; a run's shape and learner
 * test files ride in its body only as echoes of what the API answered, which
 * the API accepts unchanged.
 *
 * **The sealed files are written, never shown.** A hidden test, the reference
 * solution and a mutant are each chosen as a file and sent as base64
 * through `sealed.write`; the answer is a path, a digest and a size, and that
 * is all this editor keeps or draws. The bytes are read from the file into the
 * request body and dropped there.
 *
 * **The smoke check and the drill are not here.** They come from the
 * archive and change by uploading it again; the deployment phase says so.
 */
import { useId, useState } from 'react';
import type {
  ExecutableRunBody,
  ExecutableTaskView,
  PhaseKey,
  SealedFileView,
  SealedFileWriteBody,
  TestRunShapeId,
  UpdateExecutableTaskBody,
} from '@learnsdlc/shared';
import { MIN_TESTS_MAX } from '@learnsdlc/shared';
import { Field } from '@/components/Field';
import { Button, Notice } from '@/components/ui';
import { BudgetCeiling } from '@/components/staff/projects/BudgetCeiling';
import { SealedFileRows, shapeSummary } from '@/components/staff/projects/ExecutableTask';
import { SealedUpload, withSealed } from '@/components/staff/projects/SealedUpload';
// Mutants in the editor.
import { MutantsEditor } from '@/components/staff/projects/MutantsEditor';

/** What a save sends: the executable members, never the task's brief. */
type ExecutableSaveBody = UpdateExecutableTaskBody;

/**
 * What a save sends, as the API accepts it (`editedExecutableSlice`):
 * the runs and (on a testing task) `minTests`. Never `owns` or
 * `coverageKeywords`: the API refuses any change to either, so the editor
 * shows them and does not send them. A run is sent whole, as
 * `ExecutableRunBody` types it, with its shape and its learner files exactly
 * as the API answered them.
 */
type ExecutableAcceptedBody = Pick<ExecutableSaveBody, 'runs' | 'minTests'>;

/** Why a member is read-only here, in the words the API refuses a change with. */
const SET_AT_UPLOAD = 'Set when the project is uploaded. Upload the project again to change it.';

/** A read-only list: what the API holds, with no control to change it. */
function ReadOnlyList({
  id,
  label,
  items,
  testId,
  hint = SET_AT_UPLOAD,
}: {
  id: string;
  label: string;
  items: readonly string[];
  testId: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <span id={`${id}-label`} className="block text-[13px] font-medium text-ink">
        {label}
      </span>
      {items.length === 0 ? (
        <p className="label-sm mt-1.5">None listed.</p>
      ) : (
        <ul aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} className="m-0 mt-1.5 flex list-none flex-col gap-0.5 p-0">
          {items.map((item, at) => (
            // The whole path, wrapped, never cut off behind a tooltip.
            <li key={`${at}-${item}`} className="mono break-all text-[12.5px] text-ink" title={item}>
              {item}
            </li>
          ))}
        </ul>
      )}
      <p id={`${id}-hint`} className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
        {hint}
      </p>
    </div>
  );
}

/** One path or word per line; blanks and surrounding space dropped. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

interface RunDraft {
  id: string;
  /** Read-only: sent back as the API answered it. */
  shape: TestRunShapeId;
  label: string;
  testPaths: string;
  visibleTests: string;
  /** Read-only: sent back as the API answered it. */
  learnerTestFiles: string[];
}

export function ExecutableEditor({
  phaseKey,
  phaseTitle,
  task,
  executable,
  busy = false,
  error = '',
  onSave,
  onWriteSealed,
  onSealed,
  onCancel,
}: {
  phaseKey: PhaseKey;
  phaseTitle: string;
  task: { taskKey: string; title: string };
  executable: ExecutableTaskView;
  busy?: boolean;
  /** The API's refusal of the last save, word for word. */
  error?: string;
  onSave: (body: ExecutableAcceptedBody) => void;
  onWriteSealed: (body: SealedFileWriteBody) => Promise<SealedFileView>;
  /** Told after every sealed write, so the draft's report and deep run are read again. */
  onSealed?: () => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const tests = executable.checkKind === 'tests';
  const [runs, setRuns] = useState<RunDraft[]>(() =>
    executable.runs.map((run) => ({
      id: run.id,
      shape: run.shape,
      label: run.label,
      testPaths: run.testPaths.join('\n'),
      visibleTests: run.visibleTests.join('\n'),
      learnerTestFiles: [...run.learnerTestFiles],
    })),
  );
  const [minTests, setMinTests] = useState(executable.minTests === null ? '' : String(executable.minTests));
  const [hidden, setHidden] = useState<Record<string, SealedFileView[]>>(() =>
    Object.fromEntries(executable.runs.map((run) => [run.id, run.hidden.map((one) => ({ ...one }))])),
  );
  const [solution, setSolution] = useState<SealedFileView[]>(executable.solution);
  const [ownError, setOwnError] = useState('');

  const editRun = (runId: string, patch: Partial<RunDraft>) =>
    setRuns((was) => was.map((run) => (run.id === runId ? { ...run, ...patch } : run)));

  const sealed = () => onSealed?.();

  const save = () => {
    const body: ExecutableAcceptedBody = {
      runs: runs.map(
        (run): ExecutableRunBody => ({
          id: run.id,
          // the shape and the learner files go back as the API answered them
          shape: run.shape,
          label: run.label.trim(),
          testPaths: lines(run.testPaths),
          visibleTests: tests ? [] : lines(run.visibleTests),
          learnerTestFiles: run.learnerTestFiles,
        }),
      ),
    };
    if (tests) {
      const wanted = Number(minTests.trim());
      if (!Number.isInteger(wanted) || wanted < 1 || wanted > MIN_TESTS_MAX) {
        setOwnError(`The smallest suite a learner may hand in is a whole number of tests from 1 to ${MIN_TESTS_MAX}.`);
        return;
      }
      body.minTests = wanted;
    }
    if (body.runs?.some((run) => !run.label)) {
      setOwnError('Every run needs a label: it is the heading a learner reads above its tests.');
      return;
    }
    setOwnError('');
    onSave(body);
  };

  const shown = ownError || error;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="exec-editor">
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="m-0 text-[14px] font-semibold text-ink">{`Edit ${task.title}`}</h3>
        <p className="purpose wrap">
          {`The ${tests ? 'testing' : 'coding'} task ${phaseTitle} grades. Every run uses a shape the platform already grades with, and the sealed files are written here and never shown again.`}
        </p>
      </div>

      {shown && (
        <Notice tone="fail" role="alert" testId="exec-error-box">
          <span data-testid={ownError ? 'exec-own-error' : 'exec-error'}>{shown}</span>
        </Notice>
      )}

      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0" disabled={busy}>
        <legend className="mb-1 p-0 text-[13px] font-semibold text-ink">The starter files</legend>
        <ReadOnlyList
          id={`${id}-owns`}
          label="Starter files a learner works in"
          items={executable.owns}
          testId="exec-owns"
          hint={`A learner’s work lands in these files, and no sealed file may be one of them. ${SET_AT_UPLOAD}`}
        />
      </fieldset>

      {runs.map((run) => (
        <fieldset
          key={run.id}
          className="m-0 flex min-w-0 flex-col gap-3 rounded-ctl border-1.5 border-edge p-3"
          disabled={busy}
          data-testid={`exec-run-${run.id}`}
        >
          <legend className="px-1 text-[13px] font-semibold text-ink">{`Run: ${run.label || run.id}`}</legend>
          <Field
            id={`${id}-run-${run.id}-label`}
            label="Label"
            hint="The heading a learner reads above this run's tests."
            value={run.label}
            data-testid={`exec-run-${run.id}-label`}
            onChange={(e) => editRun(run.id, { label: e.target.value })}
          />
          <div
            className="min-w-0"
            role="group"
            aria-labelledby={`${id}-run-${run.id}-shape-label`}
            aria-describedby={`${id}-run-${run.id}-shape-hint`}
            data-testid={`exec-run-${run.id}-shape`}
          >
            <span id={`${id}-run-${run.id}-shape-label`} className="block text-[13px] font-medium text-ink">
              Run shape
            </span>
            <span className="mono mt-1.5 block text-[12.5px] text-ink">{run.shape}</span>
            <p id={`${id}-run-${run.id}-shape-hint`} className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
              {`${shapeSummary(run.shape)} ${SET_AT_UPLOAD}`}
            </p>
          </div>
          <div className="min-w-0">
            <label htmlFor={`${id}-run-${run.id}-paths`} className="block text-[13px] font-medium text-ink">
              What the graded run collects
            </label>
            <textarea
              id={`${id}-run-${run.id}-paths`}
              className="field mono mt-1.5 min-h-[56px] text-[12.5px]"
              data-testid={`exec-run-${run.id}-paths`}
              value={run.testPaths}
              onChange={(e) => editRun(run.id, { testPaths: e.target.value })}
            />
          </div>
          {tests ? (
            <ReadOnlyList
              id={`${id}-run-${run.id}-learner`}
              label="The learner’s own test files in this run"
              items={run.learnerTestFiles}
              testId={`exec-run-${run.id}-learner`}
            />
          ) : (
            <div className="min-w-0">
              <label htmlFor={`${id}-run-${run.id}-visible`} className="block text-[13px] font-medium text-ink">
                Tests a learner can see and run
              </label>
              <textarea
                id={`${id}-run-${run.id}-visible`}
                className="field mono mt-1.5 min-h-[56px] text-[12.5px]"
                data-testid={`exec-run-${run.id}-visible`}
                value={run.visibleTests}
                onChange={(e) => editRun(run.id, { visibleTests: e.target.value })}
              />
            </div>
          )}

          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-1 p-0 text-[13px] font-medium text-ink">
              {tests ? 'Reference tests (sealed)' : 'Hidden tests (sealed)'}
            </legend>
            <SealedFileRows
              files={hidden[run.id] ?? []}
              group={`hidden-${run.id}`}
              empty="No sealed file in this run yet."
            />
            <SealedUpload
              group={`hidden-${run.id}`}
              role="hidden"
              runId={run.id}
              learnerFiles={tests ? run.learnerTestFiles : undefined}
              label={tests ? 'Add or replace a reference test file' : 'Add or replace a hidden test file'}
              hint={
                tests
                  ? 'The suite the reference implementation and every mutant are run against. Sealed: only its digest and size are shown after this.'
                  : 'A test the learner never sees, run against their code when they submit. Sealed: only its digest and size are shown after this.'
              }
              onWrite={onWriteSealed}
              onWritten={(view) => {
                setHidden((was) => ({ ...was, [run.id]: withSealed(was[run.id] ?? [], view) }));
                sealed();
              }}
            />
          </fieldset>
        </fieldset>
      ))}

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 rounded-ctl border-1.5 border-edge p-3" disabled={busy}>
        <legend className="px-1 text-[13px] font-semibold text-ink">
          {tests ? 'Reference implementation (sealed)' : 'Reference solution (sealed)'}
        </legend>
        <SealedFileRows files={solution} group="solution" empty="No reference solution yet." />
        <SealedUpload
          group="solution"
          role="solution"
          // SEAL files a solution by its path alone (`solution/<path>`), so no run is named.
          runId={null}
          label={tests ? 'Add or replace a reference implementation file' : 'Add or replace a reference solution file'}
          hint="Deep validation runs it against the sealed tests and it must pass. Sealed: only its digest and size are shown after this."
          onWrite={onWriteSealed}
          onWritten={(view) => {
            setSolution((was) => withSealed(was, view));
            sealed();
          }}
        />
      </fieldset>

      {tests && (
        <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0" disabled={busy}>
          <legend className="mb-1 p-0 text-[13px] font-semibold text-ink">What a learner&rsquo;s suite must hold</legend>
          <Field
            id={`${id}-min-tests`}
            label="Fewest tests"
            hint={`A whole number from 1 to ${MIN_TESTS_MAX}.`}
            inputMode="numeric"
            value={minTests}
            data-testid="exec-min-tests"
            onChange={(e) => setMinTests(e.target.value)}
          />
          <ReadOnlyList
            id={`${id}-coverage`}
            label="Words the suite must cover"
            items={executable.coverageKeywords}
            testId="exec-coverage"
            hint={`The words of every acceptance criterion, in one list. ${SET_AT_UPLOAD}`}
          />
        </fieldset>
      )}

      {/* Mutants in the editor. */}
      {tests && <MutantsEditor mutants={executable.mutants} onWriteSealed={onWriteSealed} onSealed={sealed} busy={busy} />}

      <BudgetCeiling phases={[{ title: phaseTitle, microVMs: executable.sandboxBudget }]} version={false} testId={`exec-budget-${phaseKey}`} />

      <div className="flex flex-wrap items-center gap-2.5">
        <Button busy={busy} busyLabel="Saving…" testId="exec-save" onClick={save}>
          Save the task
        </Button>
        {onCancel && (
          <Button variant="ghost" testId="exec-cancel" onClick={onCancel}>
            Close the editor
          </Button>
        )}
        <span className="label-sm">A sealed file is saved the moment it is sealed. Save the task for everything else.</span>
      </div>
    </div>
  );
}
