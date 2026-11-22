'use client';

/**
 * The Design phase, built in six steps from the teacher's editor.
 *
 * It takes the place of the scenario and task panels for Design, and draws
 * the phase the way a learner meets it, top to bottom: the background they
 * read, the stories their design serves, the design they write and what it is
 * made of, the starting point their room opens on, the floor it is checked
 * against, and the criteria the review judges it by. Everything is a form;
 * nothing is a file and nothing is markdown.
 *
 * Every card saves through a door that already exists: the background
 * through `phases.update`, the starting point through `files.replace`, and
 * the other steps through `tasks.update` with the design body and the
 * rubric. Each save answers with the phase and a fresh report, which
 * `onSaved` hands to the editor exactly as a task save does, and the step bar
 * reads that answer: a step is done when the server holds its work.
 *
 * The task saves wait in one queue (`taskSavesFor`), and each sends the whole
 * design body with only its own part changed, built when its turn comes from
 * the body the server last answered with. A task still in the older format
 * opens already converted (the read-time view the payload carries), and the
 * first save of a step that sends the design body (the stories, the
 * learner's design, the floor or the criteria) sends those converted
 * defaults with its own part, which converts it. A Background save and a
 * sign-off mark alone leave it as it is.
 *
 * Where the version cannot change, every step is drawn without inputs and
 * without a save control.
 */
import { useCallback, useState } from 'react';
import type { DesignSwitches, DraftPhaseView, DraftTaskView, TaskMutationResult } from '@learnsdlc/shared';
import { Button } from '@/components/ui';
import { projectsApi } from '@/lib/api-projects';
import { ProvenanceChip } from '../PhaseScenario';
import { BackgroundCard } from '../requirements/BackgroundCard';
import type { CardState } from '../requirements/BuilderCard';
import { CriteriaCard } from '../requirements/CriteriaCard';
import { StepBar, type BuilderStep } from '../requirements/StepBar';
import { taskSavesFor } from '../requirements/builder-model';
import '../requirements/requirements-builder.css';
import './design-builder.css';
import { DesignFloorCard } from './DesignFloorCard';
import { LearnerDesignCard } from './LearnerDesignCard';
import { StartingPointCard } from './StartingPointCard';
import { StoriesCard } from './StoriesCard';
import {
  DESIGN_OLDER_FORMAT_NOTICE,
  DESIGN_OLDER_FORMAT_NOTICE_READONLY,
  designBodyOf,
  designStepsDone,
  savedDesignBody,
  type DesignTaskWrite,
} from './design-builder-model';

export { designBuilderTask } from './design-builder-model';

const LABELS = ['Background', 'Stories to design for', "The learner's design", 'Starting point', 'The floor', 'Criteria'];

export function DesignBuilder({
  projectId,
  versionId,
  draft,
  phase,
  task,
  editable,
  onSaved,
  onSignOff,
  onToggleRequired,
  busy = false,
}: {
  projectId: string;
  versionId: string;
  /** The whole draft: Copy from Requirements reads its Requirements phase, and the reset its origin. */
  draft: { phases: DraftPhaseView[]; forkedFromVersionId?: string | null; designConversion?: { note: string; removed: string[] } };
  phase: DraftPhaseView;
  task: DraftTaskView;
  /** False on a published version and on a project that is not the caller's. */
  editable: boolean;
  /** The phase and the fresh report a save answered with. */
  onSaved: (result: TaskMutationResult) => void;
  /** The editor's own save of the sign-off mark, `{ signOff }` alone. Absent, the card saves the mark itself. */
  onSignOff?: (signOff: boolean) => void | Promise<void>;
  /** The editor's own required toggle (`tasks.setRequired`). Absent, none is drawn. */
  onToggleRequired?: () => void;
  /** A save of the editor's own is out, so its controls hold still. */
  busy?: boolean;
}) {
  const [focused, setFocused] = useState<number | null>(null);
  const done = designStepsDone(phase, task);
  const steps: BuilderStep[] = LABELS.map((label, at) => ({ n: at + 1, label, done: done[at] }));
  const firstTodo = done.findIndex((one) => !one);
  const current = focused ?? (firstTodo >= 0 ? firstTodo + 1 : null);
  const stateOf = (n: number): CardState => (done[n - 1] ? 'done' : current === n ? 'current' : 'todo');
  const focus = (n: number) => () => setFocused(n);

  // The task's own cards write the task; a task no route addresses, or one
  // that came with the project and cannot be written, is drawn read-only.
  const taskEditable = editable && task.authorable && task.taskKey !== '';
  const older = task.designOlderFormat === true;

  // The switches as step 3 holds them, saved or not: the floor follows them.
  const [switches, setSwitches] = useState<DesignSwitches>(() => {
    const body = designBodyOf(task);
    return { contracts: body.contracts, sequence: body.sequence };
  });

  // What the server holds of the design, from the answer to the last task
  // save, and the one queue every task save waits in. Both outlive this
  // builder, so a save still out when the teacher switches tabs is waited
  // for by the next save after they come back.
  // The starting documents as step 4 holds them, so step 3 can say what a
  // contract switched off would lose (null until step 4 has read them).
  const [documents, setDocuments] = useState<Record<string, string> | null>(null);

  const taskKey = task.taskKey;
  const [saves] = useState(() => taskSavesFor(`design:${projectId}:${versionId}:${taskKey}`, savedDesignBody(task)));
  const writeTask: DesignTaskWrite = useCallback(
    (build) => {
      saves.pending += 1;
      return saves.chain.run(async () => {
        try {
          const result = await projectsApi.updateTask(projectId, versionId, 'design', taskKey, build(saves.server));
          const next = savedDesignBody(result.phase.tasks.find((one) => one.taskKey === taskKey));
          if (next) saves.server = next;
          return result;
        } finally {
          saves.pending -= 1;
        }
      });
    },
    [saves, projectId, versionId, taskKey],
  );
  const whose = phase.provenance?.tasks.find((one) => one.taskKey === task.taskKey)?.provenance ?? null;
  const referenceName = phase.provenance?.referenceName ?? '';
  const doneCount = done.filter(Boolean).length;

  return (
    <div className="tre-panel tde-panel flex min-w-0 flex-col gap-4" data-testid="design-builder">
      <div className="tre-hero">
        <img src="/artwork/dashboard-design-3d.webp" alt="" width={112} height={88} className="tre-hero-art" />
        <div className="tre-hero-text">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="label-sm">Design</span>
            {phase.provenance && (
              <>
                <span className="label-sm">Whose this phase is:</span>
                <ProvenanceChip
                  state={phase.provenance.rollup}
                  referenceName={referenceName}
                  testId={`phase-provenance-${phase.key}`}
                />
              </>
            )}
          </span>
          <h3 className="tre-hero-title">Build the phase the way your learners will meet it.</h3>
          <p className="purpose wrap">
            Six steps, top to bottom. Everything you type here is what they read, write and are judged by. Nothing is a
            file.
          </p>
        </div>
        {taskEditable && onToggleRequired ? (
          <div className="tre-hero-actions">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              testId={`task-required-toggle-${task.taskKey}`}
              onClick={onToggleRequired}
            >
              {task.required ? 'Make optional' : 'Make required'}
            </Button>
          </div>
        ) : null}
      </div>

      <StepBar steps={steps} current={current} label="The six steps" signOff={taskEditable ? task.taskKey : null} />
      {draft.designConversion && (
        <p className="tre-legacy label-sm wrap" data-testid="tde-converted" role="note">
          {`This draft's Design was converted from the older format, and its documents were removed from the phase: ${draft.designConversion.removed.join(', ') || 'none'}. Re-add any reference text to the Background or the task brief. ${draft.designConversion.note}`}
        </p>
      )}
      {older && (
        <p className="tre-legacy label-sm wrap" data-testid="tde-older-format">
          {taskEditable ? DESIGN_OLDER_FORMAT_NOTICE : DESIGN_OLDER_FORMAT_NOTICE_READONLY}
        </p>
      )}

      <BackgroundCard
        projectId={projectId}
        versionId={versionId}
        phase={phase}
        editable={editable}
        state={stateOf(1)}
        onFocusCard={focus(1)}
        onSaved={onSaved}
        testId="tde-background"
        art="/artwork/dashboard-design-3d.webp"
      />
      <StoriesCard
        draft={draft}
        task={task}
        writeTask={writeTask}
        editable={taskEditable}
        state={stateOf(2)}
        onFocusCard={focus(2)}
        onSaved={onSaved}
      />
      <LearnerDesignCard
        task={task}
        switches={switches}
        onSwitches={setSwitches}
        writeTask={writeTask}
        editable={taskEditable}
        state={stateOf(3)}
        onFocusCard={focus(3)}
        onSaved={onSaved}
        whose={whose}
        referenceName={referenceName}
        documents={documents}
      />
      <StartingPointCard
        projectId={projectId}
        versionId={versionId}
        phase={phase}
        task={task}
        forkedFromVersionId={draft.forkedFromVersionId ?? null}
        editable={taskEditable}
        state={stateOf(4)}
        onFocusCard={focus(4)}
        onSaved={onSaved}
        onDocuments={setDocuments}
      />
      <DesignFloorCard
        projectId={projectId}
        versionId={versionId}
        task={task}
        switches={switches}
        writeTask={writeTask}
        editable={taskEditable}
        state={stateOf(5)}
        onFocusCard={focus(5)}
        onSaved={onSaved}
        onSignOff={onSignOff}
      />
      <CriteriaCard
        task={task}
        writeTask={writeTask}
        editable={taskEditable}
        state={stateOf(6)}
        onFocusCard={focus(6)}
        onSaved={onSaved}
        olderFormatBody={() => ({ design: designBodyOf(task) })}
        n={6}
        testId="tde-criteria"
        purpose="What the review judges the design against, in your words."
        work={{ subject: 'A design', verb: 'passes' }}
        floorGraded
      />
      <p className="tde-readiness label-sm" role="status" data-testid="tde-readiness">
        {`${doneCount} of 6 steps done`}
      </p>
    </div>
  );
}
