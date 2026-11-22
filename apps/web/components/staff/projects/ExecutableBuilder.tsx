'use client';

/**
 * The Implementation and Testing phases, each built in three steps from the
 * teacher's editor, and the code-and-runs step they share with Maintenance.
 *
 * Each takes the place of the scenario, the task panels and the executable
 * panels for its phase, and draws the phase the way a learner meets it, top
 * to bottom: the brief they read, the code or tests and the runs that grade
 * them (the executable summary and editor, without the brief field, which is
 * step 1's alone), and the grader's own criteria, whose sentences and weights
 * are the teacher's. Everything is a form;
 * nothing is markdown.
 *
 * Every card saves through a door that already exists: the background
 * through `phases.update`; the task's words, the runs and the rubric through
 * `tasks.update` (the executable arm); the sealed files through
 * `sealed.write`. Each save answers with the phase and a fresh report, which
 * `onSaved` hands to the editor exactly as a task save does, and the step bar
 * reads that answer. The task saves wait in one queue (`taskSavesFor`), and a
 * step's own save first flushes what waits on the Brief card, so the words
 * reach the server before it.
 *
 * Where the version cannot change, every step is drawn without inputs and
 * without a save control.
 */
import { useCallback, useRef, useState } from 'react';
import {
  applicationPhasesSentence,
  type DraftPhaseView,
  type DraftTaskView,
  type TaskMutationResult,
  type UpdateTaskBody,
} from '@learnsdlc/shared';
import { Button, Notice } from '@/components/ui';
import { describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { BriefCard, type BriefCardHandle } from './BriefCard';
import { ExecutableEditor } from './ExecutableEditor';
import { ExecutableSummary } from './ExecutableTask';
import { ProvenanceChip } from './PhaseScenario';
import { SignOffHelp, SignOffToggle, signOffHelpIds } from './TaskEditor';
import { executableOf } from './executable';
import { BuilderCard, type CardState } from './requirements/BuilderCard';
import { CriteriaCard } from './requirements/CriteriaCard';
import { StepBar, type BuilderStep } from './requirements/StepBar';
import { taskSavesFor } from './requirements/builder-model';
import './requirements/requirements-builder.css';
import './design/design-builder.css';
import './executable-builder.css';

/** A task save through a builder's one queue: given what the server holds when its turn comes, the body to send. */
type ExecutableTaskWrite = (build: (held: unknown) => UpdateTaskBody) => Promise<TaskMutationResult>;

/** What tells the Implementation builder from the Testing one. */
export interface ExecutableBuilderKind {
  /** The phase's title in the hero. */
  name: 'Implementation' | 'Testing';
  /** The phase's work as the criteria card's pass-mark line opens with it, with its verb ("The code passes"). */
  work: { subject: string; verb: 'pass' | 'passes' };
  /** The three steps' labels. */
  labels: readonly [string, string, string];
  /** The test-id prefix of every card. */
  prefix: string;
  /** The root's test id. */
  testId: string;
  /** The phase's own artwork. */
  art: string;
  /** Step 2's purpose line. */
  runsPurpose: string;
  /** Step 2's Edit button. */
  editLabel: string;
  /** The keys the grader scores itself: their rows' key and Remove are locked. */
  fixed: readonly string[];
  /** Which of the three steps are done. */
  stepsDone: (phase: DraftPhaseView, task: DraftTaskView) => boolean[];
  /** The hero's line under its title. */
  heroLine: string;
}

export function ExecutableBuilder({
  kind,
  projectId,
  versionId,
  phase,
  task,
  editable,
  onSaved,
  onSignOff,
  onSealed,
  busy = false,
}: {
  kind: ExecutableBuilderKind;
  projectId: string;
  versionId: string;
  phase: DraftPhaseView;
  task: DraftTaskView;
  /** False on a published version and on a project that is not the caller's. */
  editable: boolean;
  /** The phase and the fresh report a save answered with. */
  onSaved: (result: TaskMutationResult) => void;
  /** The editor's own save of the sign-off mark, `{ signOff }` alone. Absent, the card saves the mark itself. */
  onSignOff?: (signOff: boolean) => void | Promise<void>;
  /** A sealed file was written: the editor reads the draft again, as it does for its own executable editor. */
  onSealed?: () => void;
  /** A save of the editor's own is out, so its controls hold still. */
  busy?: boolean;
}) {
  const [focused, setFocused] = useState<number | null>(null);
  const done = kind.stepsDone(phase, task);
  const steps: BuilderStep[] = kind.labels.map((label, at) => ({ n: at + 1, label, done: done[at] }));
  const firstTodo = done.findIndex((one) => !one);
  const current = focused ?? (firstTodo >= 0 ? firstTodo + 1 : null);
  const stateOf = (n: number): CardState => (done[n - 1] ? 'done' : current === n ? 'current' : 'todo');
  const focus = (n: number) => () => setFocused(n);

  // A code or tests task is not authorable, but its words, runs and rubric are
  // written through the executable arm; one no route addresses is read-only.
  const taskEditable = editable && task.taskKey !== '';

  // The one queue every task save waits in. The task carries no record, so
  // what the server holds is always enough to send a body alone. It outlives
  // this builder, so a save still out when the teacher switches tabs is
  // waited for by the next save after they come back.
  const taskKey = task.taskKey;
  const [saves] = useState(() => taskSavesFor<true>(`${phase.key}:${projectId}:${versionId}:${taskKey}`, true));
  const writeTask: ExecutableTaskWrite = useCallback(
    (build) => {
      saves.pending += 1;
      return saves.chain.run(async () => {
        try {
          return await projectsApi.updateTask(projectId, versionId, phase.key, taskKey, build(saves.server));
        } finally {
          saves.pending -= 1;
        }
      });
    },
    [saves, projectId, versionId, phase.key, taskKey],
  );
  const brief = useRef<BriefCardHandle>(null);
  const flushBrief = useCallback(async () => {
    await brief.current?.flush();
  }, []);

  const doneCount = done.filter(Boolean).length;
  const referenceName = phase.provenance?.referenceName ?? '';
  const application = phase.provenance?.application ?? null;

  return (
    <div className="tre-panel tdx-panel flex min-w-0 flex-col gap-4" data-testid={kind.testId}>
      <div className="tre-hero">
        <img src={kind.art} alt="" width={112} height={88} className="tre-hero-art" />
        <div className="tre-hero-text">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="label-sm">{kind.name}</span>
            {phase.provenance && (
              <>
                <span className="label-sm">Whose this phase is:</span>
                <ProvenanceChip state={phase.provenance.rollup} referenceName={referenceName} testId={`phase-provenance-${phase.key}`} />
              </>
            )}
          </span>
          <h3 className="tre-hero-title">Build the phase the way your learners will meet it.</h3>
          <p className="purpose wrap">{kind.heroLine}</p>
        </div>
      </div>

      {application && (
        <Notice tone="info" testId={`phase-application-notice-${phase.key}`}>
          <span data-testid={`phase-application-${phase.key}`}>{applicationPhasesSentence(application)}</span>
        </Notice>
      )}

      <StepBar steps={steps} current={current} label="The three steps" signOff={editable ? task.taskKey : null} />

      <BriefCard
        ref={brief}
        projectId={projectId}
        versionId={versionId}
        phase={phase}
        task={task}
        writeTask={writeTask}
        editable={editable}
        taskEditable={taskEditable}
        state={stateOf(1)}
        onFocusCard={focus(1)}
        onSaved={onSaved}
        oldFile={null}
        testId={`${kind.prefix}-brief`}
        art={kind.art}
      />
      <CodeAndRunsCard
        n={2}
        title={kind.labels[1]}
        purpose={kind.runsPurpose}
        testId={`${kind.prefix}-code`}
        editTestId="exec-edit-open"
        editLabel={kind.editLabel}
        projectId={projectId}
        versionId={versionId}
        phase={phase}
        task={task}
        writeTask={writeTask}
        beforeSave={flushBrief}
        editable={taskEditable}
        busy={busy}
        state={stateOf(2)}
        onFocusCard={focus(2)}
        onSaved={onSaved}
        onSealed={onSealed}
        signOff={{ onSignOff, readOnly: !editable }}
      />
      <CriteriaCard
        task={task}
        writeTask={writeTask}
        editable={taskEditable}
        state={stateOf(3)}
        onFocusCard={focus(3)}
        onSaved={onSaved}
        olderFormatBody={() => ({})}
        n={3}
        locked={[...kind.fixed]}
        allowAdd={false}
        testId={`${kind.prefix}-criteria`}
        purpose="What the review judges, in your words: the grader's own criteria, their sentences and weights."
        work={kind.work}
        floorGraded={false}
      />
      <p className="tdx-readiness label-sm" role="status" data-testid={`${kind.prefix}-readiness`}>
        {`${doneCount} of 3 steps done`}
      </p>
    </div>
  );
}

/**
 * The code learners start from (or write their tests against) and the runs
 * that grade it, drawn by today's executable summary, and on Edit by today's
 * executable editor. Its saves go through the builder's one task queue, each
 * after `beforeSave` (the Brief card's flush), so a words edit waiting there
 * goes first; its sealed writes go through `sealed.write`, after which the
 * editor reads the draft again. The editor holds no brief: step 1 does. A
 * refusal stays on the card once the editor is closed, until it is opened again.
 */
export function CodeAndRunsCard({
  n,
  title,
  purpose,
  testId,
  editTestId,
  editLabel = 'Edit the code and runs',
  projectId,
  versionId,
  phase,
  task,
  writeTask,
  beforeSave,
  editable,
  busy,
  state,
  onFocusCard,
  onSaved,
  onSealed,
  signOff,
}: {
  n: number;
  title: string;
  purpose: string;
  testId: string;
  /** The Edit button's test id. */
  editTestId: string;
  editLabel?: string;
  projectId: string;
  versionId: string;
  phase: DraftPhaseView;
  task: DraftTaskView;
  writeTask: ExecutableTaskWrite;
  /** Called before a save is queued, and waited for: the Brief card's flush. */
  beforeSave: () => Promise<void>;
  editable: boolean;
  busy: boolean;
  state: CardState;
  onFocusCard: () => void;
  onSaved: (result: TaskMutationResult) => void;
  onSealed?: () => void;
  /** Draws the task's sign-off mark here, where the phase draws no other step for it. */
  signOff?: { onSignOff?: (signOff: boolean) => void | Promise<void>; readOnly: boolean };
}) {
  const executable = executableOf(task);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState('');
  const signOffHelp = `task-signoff-help-${phase.key}`;
  return (
    <BuilderCard n={n} title={title} purpose={purpose} state={state} testId={testId} onFocusCard={onFocusCard}>
      {!executable ? (
        <p className="purpose">This task carries no runs to show.</p>
      ) : open && editable ? (
        <ExecutableEditor
          phaseKey={phase.key}
          phaseTitle={phase.title}
          task={task}
          executable={executable}
          busy={saving || busy}
          error={error}
          onCancel={() => setOpen(false)}
          onSave={(body) => {
            setSaving(true);
            setError('');
            beforeSave()
              .then(() => writeTask(() => body))
              .then((result) => {
                onSaved(result);
                setOpen(false);
              })
              .catch((err) => setError(describeError(err, 'That change could not be saved. Try again in a moment.')))
              .finally(() => setSaving(false));
          }}
          onWriteSealed={(body) => projectsApi.writeSealed(projectId, versionId, phase.key, task.taskKey, body)}
          onSealed={onSealed}
        />
      ) : (
        <>
          <ExecutableSummary phaseTitle={phase.title} executable={executable} />
          {error && (
            <p role="alert" className="label-sm wrap text-fail" data-testid={`${testId}-error`}>
              {error}
            </p>
          )}
          {editable && (
            <div>
              <Button
                size="sm"
                variant="secondary"
                icon="edit"
                testId={editTestId}
                onClick={() => {
                  setError('');
                  setOpen(true);
                }}
              >
                {editLabel}
              </Button>
            </div>
          )}
        </>
      )}
      {signOff && signOff.readOnly && task.signOff === true && (
        <p className="label-sm wrap" data-testid={`${testId}-signoff-read`}>
          Needs your sign-off.
        </p>
      )}
      {signOff && !signOff.readOnly && (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid={`${testId}-signoff`}>
          <SignOffHelp id={signOffHelp} readOnlyReason={null} />
          <SignOffToggle
            task={task}
            off={false}
            describedBy={signOffHelpIds(signOffHelp, null)}
            busy={signing || busy}
            onChange={async (next) => {
              if (signOff.onSignOff) {
                await signOff.onSignOff(next);
                return;
              }
              setSigning(true);
              setSignError('');
              try {
                onSaved(await projectsApi.updateTask(projectId, versionId, phase.key, task.taskKey, { signOff: next }));
              } catch (err) {
                setSignError(describeError(err, 'The mark could not be saved. Try again in a moment.'));
              } finally {
                setSigning(false);
              }
            }}
          />
          {signError && (
            <p role="alert" className="label-sm wrap text-fail" data-testid={`${testId}-signoff-error`}>
              {signError}
            </p>
          )}
        </div>
      )}
    </BuilderCard>
  );
}
