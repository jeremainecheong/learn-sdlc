'use client';

/**
 * The Deployment phase, built in four steps from the teacher's editor.
 *
 * It takes the place of the scenario and task panels for Deployment, and
 * draws the phase the way a learner meets it, top to bottom: the brief they
 * read, the files they start from and the checks that grade them (read-only:
 * they change only when the project is uploaded again), the runbook's floor
 * and the starting record their Runbook tab opens on, and the criteria the
 * review judges it by. Everything is a form; nothing is markdown.
 *
 * Every card saves through a door that already exists: the background
 * through `phases.update`, the task's words, the floor, the sign-off mark and
 * the rubric through `tasks.update` (the runbook arm), and the starting
 * record through `files.replace`. Each save answers with the phase and a
 * fresh report, which `onSaved` hands to the editor exactly as a task save
 * does, and the step bar reads that answer.
 *
 * The task saves wait in one queue (`taskSavesFor`). A task still in the
 * older format opens already converted (the read-time view the payload
 * carries), and its first save of the brief, the runbook floor or the
 * criteria converts it: each carries the read-time runbook body until the
 * server holds one, since the API takes the task's words alone only on a
 * converted task.
 *
 * Where the version cannot change, every step is drawn without inputs and
 * without a save control.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RUNBOOK_JSON,
  type AuthoringFileView,
  type DraftPhaseView,
  type DraftTaskView,
  type RunbookChecksBody,
  type TaskMutationResult,
} from '@learnsdlc/shared';
import { describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { BriefCard } from '../BriefCard';
import { ProvenanceChip } from '../PhaseScenario';
import { type CardState } from '../requirements/BuilderCard';
import { CriteriaCard } from '../requirements/CriteriaCard';
import { StepBar, type BuilderStep } from '../requirements/StepBar';
import { taskSavesFor } from '../requirements/builder-model';
import '../requirements/requirements-builder.css';
import '../design/design-builder.css';
import './deployment-builder.css';
import { FilesAndChecksCard } from './FilesAndChecksCard';
import { RunbookCard } from './RunbookCard';
import {
  DEPLOYMENT_STEP_LABELS,
  RUNBOOK_OLDER_FORMAT_NOTICE,
  RUNBOOK_OLDER_FORMAT_NOTICE_READONLY,
  deploymentStepsDone,
  lockedDeploymentKeys,
  runbookBodyOf,
  savedRunbookBody,
  type DeploymentTaskWrite,
} from './deployment-builder-model';

export { deploymentBuilderTask } from './deployment-builder-model';

export function DeploymentBuilder({
  projectId,
  versionId,
  phase,
  task,
  editable,
  onSaved,
  onSignOff,
  onStartingText,
  busy = false,
}: {
  projectId: string;
  versionId: string;
  /** The whole draft, as the other builders take it. */
  draft: { phases: DraftPhaseView[]; forkedFromVersionId?: string | null };
  phase: DraftPhaseView;
  task: DraftTaskView;
  /** False on a published version and on a project that is not the caller's. */
  editable: boolean;
  /** The phase and the fresh report a save answered with. */
  onSaved: (result: TaskMutationResult) => void;
  /** The editor's own save of the sign-off mark, `{ signOff }` alone. Absent, the card saves the mark itself. */
  onSignOff?: (signOff: boolean) => void | Promise<void>;
  /** The starting record's bytes as the server holds them, whenever they are read or saved: the editor's publish warning reads them. */
  onStartingText?: (text: string) => void;
  /** A save of the editor's own is out, so its controls hold still. */
  busy?: boolean;
}) {
  const [focused, setFocused] = useState<number | null>(null);
  const [runbookSaved, setRunbookSaved] = useState(false);
  const done = deploymentStepsDone(phase, task, { runbook: runbookSaved });
  const steps: BuilderStep[] = DEPLOYMENT_STEP_LABELS.map((label, at) => ({ n: at + 1, label, done: done[at] }));
  const firstTodo = done.findIndex((one) => !one);
  const current = focused ?? (firstTodo >= 0 ? firstTodo + 1 : null);
  const stateOf = (n: number): CardState => (done[n - 1] ? 'done' : current === n ? 'current' : 'todo');
  const focus = (n: number) => () => setFocused(n);

  // A config task is not authorable, but its words, floor, record and rubric
  // are written through the runbook arm; one no route addresses is read-only.
  const taskEditable = editable && task.taskKey !== '';
  const older = task.recordOlderFormat === true;

  // What the server holds of the runbook, from the answer to the last task
  // save, and the one queue every task save waits in. Both outlive this
  // builder, so a save still out when the teacher switches tabs is waited
  // for by the next save after they come back.
  const taskKey = task.taskKey;
  const [saves] = useState(() =>
    taskSavesFor<RunbookChecksBody>(`deployment:${projectId}:${versionId}:${taskKey}`, savedRunbookBody(task)),
  );
  const writeTask: DeploymentTaskWrite = useCallback(
    (build) => {
      saves.pending += 1;
      return saves.chain.run(async () => {
        try {
          const result = await projectsApi.updateTask(projectId, versionId, phase.key, taskKey, build(saves.server));
          const next = savedRunbookBody(result?.phase?.tasks.find((one) => one.taskKey === taskKey));
          if (next) saves.server = next;
          return result;
        } finally {
          saves.pending -= 1;
        }
      });
    },
    [saves, projectId, versionId, phase.key, taskKey],
  );

  // The draft's file rows, read at mount, again after the record is written
  // over whole, and again when the task stops being older-format: step 2
  // lists the phase's, step 3 opens on the record.
  const [rows, setRows] = useState<AuthoringFileView[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [starting, setStarting] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reload = useCallback(async () => {
    setLoadError('');
    try {
      const all = (await projectsApi.files(projectId, versionId)) ?? [];
      if (!alive.current) return;
      setRows(all);
      setStarting(all.find((one) => one.phaseKey === phase.key && one.path === RUNBOOK_JSON)?.content ?? '');
    } catch (err) {
      if (alive.current) setLoadError(describeError(err, 'The files could not be read. Try again in a moment.'));
    }
  }, [projectId, versionId, phase.key]);
  // The save that converts an older task writes the starting record server
  // side (the teacher's RUNBOOK.md becomes it), so it is read again,
  // as Design's starting point is; until it is, the forms wait rather than
  // open on the empty record and write over the converted one.
  const wasOlder = useRef(older);
  useEffect(() => {
    if (wasOlder.current && !older) setStarting(null);
    wasOlder.current = older;
    void reload();
  }, [reload, older]);
  const told = useRef(onStartingText);
  told.current = onStartingText;
  useEffect(() => {
    if (starting !== null) told.current?.(starting);
  }, [starting]);

  const doneCount = done.filter(Boolean).length;
  const referenceName = phase.provenance?.referenceName ?? '';

  return (
    <div className="tre-panel tdp-panel flex min-w-0 flex-col gap-4" data-testid="deployment-builder">
      <div className="tre-hero">
        <img src="/artwork/dashboard-deployment-3d.webp" alt="" width={112} height={88} className="tre-hero-art" />
        <div className="tre-hero-text">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="label-sm">Deployment</span>
            {phase.provenance && (
              <>
                <span className="label-sm">Whose this phase is:</span>
                <ProvenanceChip state={phase.provenance.rollup} referenceName={referenceName} testId={`phase-provenance-${phase.key}`} />
              </>
            )}
          </span>
          <h3 className="tre-hero-title">Build the phase the way your learners will meet it.</h3>
          <p className="purpose wrap">
            Four steps, top to bottom. The files and checks come with the project; the brief, the runbook and the criteria
            are yours.
          </p>
        </div>
      </div>

      <StepBar steps={steps} current={current} label="The four steps" signOff={taskEditable ? task.taskKey : null} />
      {older && (
        <p className="tre-legacy label-sm wrap" data-testid="tdp-older-format">
          {taskEditable ? RUNBOOK_OLDER_FORMAT_NOTICE : RUNBOOK_OLDER_FORMAT_NOTICE_READONLY}
        </p>
      )}

      <BriefCard
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
        olderFormatBody={() => ({ runbook: runbookBodyOf(task) })}
      />
      <FilesAndChecksCard
        phase={phase}
        task={task}
        rows={rows}
        loadError={loadError}
        state={stateOf(2)}
        onFocusCard={focus(2)}
      />
      <RunbookCard
        projectId={projectId}
        versionId={versionId}
        phase={phase}
        task={task}
        writeTask={writeTask}
        starting={starting}
        onStartingSaved={setStarting}
        onReload={reload}
        editable={taskEditable}
        busy={busy}
        state={stateOf(3)}
        onFocusCard={focus(3)}
        onSaved={onSaved}
        onRunbookSaved={() => setRunbookSaved(true)}
        onSignOff={onSignOff}
      />
      <CriteriaCard
        task={task}
        writeTask={writeTask}
        editable={taskEditable}
        state={stateOf(4)}
        onFocusCard={focus(4)}
        onSaved={onSaved}
        olderFormatBody={() => ({ runbook: runbookBodyOf(task) })}
        n={4}
        locked={lockedDeploymentKeys(task)}
        testId="tdp-criteria"
        purpose="What the review judges the runbook and the files against. The rows the phase's own checks grade stay in the rubric; their title, sentence and weight are yours."
        work={{ subject: 'The runbook and the files', verb: 'pass' }}
        floorGraded={false}
      />
      <p className="tdp-readiness label-sm" role="status" data-testid="tdp-readiness">
        {`${doneCount} of 4 steps done`}
      </p>
    </div>
  );
}
