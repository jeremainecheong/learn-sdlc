'use client';

/**
 * The Maintenance phase, built in five steps from the teacher's editor.
 *
 * It takes the place of the scenario, the task panels and the executable
 * panels for Maintenance, and draws the phase the way a learner meets it, top
 * to bottom: the brief they read, the ticket their change answers, the code
 * and the runs that grade it (the executable summary and editor, without the
 * brief, which is step 1's alone), the change
 * request's floor and the starting record their change room opens on, and
 * the criteria the review judges it by. Everything is a form; nothing is
 * markdown.
 *
 * Every card saves through a door that already exists: the background
 * through `phases.update`; the task's words, the ticket, the contract switch
 * and floor, the runs, the sign-off mark and the rubric through `tasks.update`
 * (the executable arm); the sealed files through `sealed.write`; the starting
 * record through `files.replace`. Each save answers with the phase and a
 * fresh report, which `onSaved` hands to the editor exactly as a task save
 * does, and the step bar reads that answer.
 *
 * The task saves wait in one queue (`taskSavesFor`). A task still in the
 * older format opens already converted (the read-time view the payload
 * carries), and its first save of the brief, the ticket, the floor or the
 * criteria converts it: each carries the read-time switch and floor until
 * the server holds them, since the door converts on a change, ticket or
 * rubric and takes the words alone without converting.
 *
 * Where the version cannot change, every step is drawn without inputs and
 * without a save control.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHANGE_REQUEST_JSON,
  type AuthoringFileView,
  type ChangeChecksBody,
  type DraftPhaseView,
  type DraftTaskView,
  type TaskMutationResult,
} from '@learnsdlc/shared';
import { describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { BriefCard, type BriefCardHandle } from '../BriefCard';
import { CodeAndRunsCard } from '../ExecutableBuilder';
import { ProvenanceChip } from '../PhaseScenario';
import { type CardState } from '../requirements/BuilderCard';
import { CriteriaCard } from '../requirements/CriteriaCard';
import { StepBar, type BuilderStep } from '../requirements/StepBar';
import { taskSavesFor } from '../requirements/builder-model';
import '../requirements/requirements-builder.css';
import '../design/design-builder.css';
import './maintenance-builder.css';
import { ChangeRequestCard } from './ChangeRequestCard';
import { TicketCard } from './TicketCard';
import {
  CHANGE_OLDER_FORMAT_NOTICE,
  CHANGE_OLDER_FORMAT_NOTICE_READONLY,
  LOCKED_MAINTENANCE_KEYS,
  MAINTENANCE_STEP_LABELS,
  changeBodyOf,
  maintenanceStepsDone,
  savedChangeBody,
  type MaintenanceTaskWrite,
} from './maintenance-builder-model';

export { maintenanceBuilderTask } from './maintenance-builder-model';

const ART = '/artwork/dashboard-maintenance-3d.webp';

export function MaintenanceBuilder({
  projectId,
  versionId,
  phase,
  task,
  editable,
  onSaved,
  onSignOff,
  onStartingText,
  onSealed,
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
  /** A sealed file was written: the editor reads the draft again, as it does for its own executable editor. */
  onSealed?: () => void;
  /** A save of the editor's own is out, so its controls hold still. */
  busy?: boolean;
}) {
  const [focused, setFocused] = useState<number | null>(null);
  const [changeSaved, setChangeSaved] = useState(false);
  const done = maintenanceStepsDone(phase, task, { change: changeSaved });
  const steps: BuilderStep[] = MAINTENANCE_STEP_LABELS.map((label, at) => ({ n: at + 1, label, done: done[at] }));
  const firstTodo = done.findIndex((one) => !one);
  const current = focused ?? (firstTodo >= 0 ? firstTodo + 1 : null);
  const stateOf = (n: number): CardState => (done[n - 1] ? 'done' : current === n ? 'current' : 'todo');
  const focus = (n: number) => () => setFocused(n);

  // A code task is not authorable, but its words, ticket, change request and
  // rubric are written through the executable arm; one no route addresses is read-only.
  const taskEditable = editable && task.taskKey !== '';
  const older = task.recordOlderFormat === true;

  // What the server holds of the change request's switch and floor, from the
  // answer to the last task save, and the one queue every task save waits in.
  // Both outlive this builder, so a save still out when the teacher switches
  // tabs is waited for by the next save after they come back.
  const taskKey = task.taskKey;
  const [saves] = useState(() =>
    taskSavesFor<ChangeChecksBody>(`maintenance:${projectId}:${versionId}:${taskKey}`, savedChangeBody(task)),
  );
  const writeTask: MaintenanceTaskWrite = useCallback(
    (build) => {
      saves.pending += 1;
      return saves.chain.run(async () => {
        try {
          const result = await projectsApi.updateTask(projectId, versionId, phase.key, taskKey, build(saves.server));
          const next = savedChangeBody(result?.phase?.tasks.find((one) => one.taskKey === taskKey));
          if (next) saves.server = next;
          return result;
        } finally {
          saves.pending -= 1;
        }
      });
    },
    [saves, projectId, versionId, phase.key, taskKey],
  );
  const olderFormatBody = () => ({ change: changeBodyOf(task) });
  // Step 1 alone edits the task's words; step 3 flushes what waits there before its own save goes out.
  const brief = useRef<BriefCardHandle>(null);
  const flushBrief = useCallback(async () => {
    await brief.current?.flush();
  }, []);

  // The draft's file rows, read at mount, again after the record is written
  // over whole, and again when the task stops being older-format: step 4
  // opens on the record and offers the phase's editable files.
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
      setStarting(all.find((one) => one.phaseKey === phase.key && one.path === CHANGE_REQUEST_JSON)?.content ?? '');
    } catch (err) {
      if (alive.current) setLoadError(describeError(err, 'The files could not be read. Try again in a moment.'));
    }
  }, [projectId, versionId, phase.key]);
  // The save that converts an older task writes the starting record server
  // side (the teacher's CHANGELOG.md becomes it), so it is read
  // again; until it is, the forms wait rather than open on the empty record
  // and write over the converted one.
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
    <div className="tre-panel tdm-panel flex min-w-0 flex-col gap-4" data-testid="maintenance-builder">
      <div className="tre-hero">
        <img src={ART} alt="" width={112} height={88} className="tre-hero-art" />
        <div className="tre-hero-text">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="label-sm">Maintenance</span>
            {phase.provenance && (
              <>
                <span className="label-sm">Whose this phase is:</span>
                <ProvenanceChip state={phase.provenance.rollup} referenceName={referenceName} testId={`phase-provenance-${phase.key}`} />
              </>
            )}
          </span>
          <h3 className="tre-hero-title">Build the phase the way your learners will meet it.</h3>
          <p className="purpose wrap">
            Five steps, top to bottom: the brief, the ticket, the code and its runs, the change request and the criteria.
          </p>
        </div>
      </div>

      <StepBar steps={steps} current={current} label="The five steps" signOff={taskEditable ? task.taskKey : null} />
      {older && (
        <p className="tre-legacy label-sm wrap" data-testid="tdm-older-format">
          {taskEditable ? CHANGE_OLDER_FORMAT_NOTICE : CHANGE_OLDER_FORMAT_NOTICE_READONLY}
        </p>
      )}
      {loadError && (
        <p role="alert" className="label-sm wrap text-fail" data-testid="tdm-files-error">
          {loadError}
        </p>
      )}

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
        oldFile="CHANGELOG.md"
        testId="tdm-brief"
        art={ART}
        olderFormatBody={olderFormatBody}
      />
      <TicketCard
        task={task}
        writeTask={writeTask}
        starting={starting}
        editable={taskEditable}
        state={stateOf(2)}
        onFocusCard={focus(2)}
        onSaved={onSaved}
      />
      <CodeAndRunsCard
        n={3}
        title="Code and runs"
        purpose="What learners start from and what grades it: the starter, the visible tests, the hidden suite and the reference solution."
        testId="tdm-code"
        editTestId="tdm-code-edit"
        projectId={projectId}
        versionId={versionId}
        phase={phase}
        task={task}
        writeTask={writeTask}
        beforeSave={flushBrief}
        editable={taskEditable}
        busy={busy}
        state={stateOf(3)}
        onFocusCard={focus(3)}
        onSaved={onSaved}
        onSealed={onSealed}
      />
      <ChangeRequestCard
        projectId={projectId}
        versionId={versionId}
        phase={phase}
        task={task}
        writeTask={writeTask}
        starting={starting}
        rows={rows}
        onStartingSaved={setStarting}
        onReload={reload}
        editable={taskEditable}
        busy={busy}
        state={stateOf(4)}
        onFocusCard={focus(4)}
        onSaved={onSaved}
        onChangeSaved={() => setChangeSaved(true)}
        onSignOff={onSignOff}
      />
      <CriteriaCard
        task={task}
        writeTask={writeTask}
        editable={taskEditable}
        state={stateOf(5)}
        onFocusCard={focus(5)}
        onSaved={onSaved}
        olderFormatBody={olderFormatBody}
        n={5}
        locked={[...LOCKED_MAINTENANCE_KEYS]}
        testId="tdm-criteria"
        purpose="What the review judges the change request and the code against. The four rows the grader scores itself stay in the rubric; their title, sentence and weight are yours."
        work={{ subject: 'The change', verb: 'passes' }}
        floorGraded={false}
      />
      <p className="tdm-readiness label-sm" role="status" data-testid="tdm-readiness">
        {`${doneCount} of 5 steps done`}
      </p>
    </div>
  );
}
