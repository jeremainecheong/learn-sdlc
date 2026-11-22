'use client';

/**
 * The Requirements phase, built in five steps from the teacher's editor.
 *
 * It takes the place of the scenario and task panels for Requirements, and it
 * draws the phase the way a learner meets it, top to bottom: the background
 * they read, the stakeholder they interview, the stories the backlog already
 * holds, the story they write with the floor it is checked against, and the
 * criteria the review judges it by. Everything is a form; nothing is a file
 * and nothing is markdown.
 *
 * Every card saves through a door that already exists: the background through
 * `phases.update`, the stakeholder through `interview.replace`, and steps 3 to
 * 5 through `tasks.update` with the story body and the rubric. Each save
 * answers with the phase and a fresh report, which `onSaved` hands to the
 * editor exactly as a task save does, and the step bar reads that answer: a
 * step is done when the server holds its work.
 *
 * A task the draft still holds in the older, markdown format opens on the
 * defaults (no provided stories, the default floor, an id the learner picks)
 * and is converted by its first story save, which the door accepts on a
 * Requirements task.
 *
 * Where the version cannot change, every step is drawn without inputs and
 * without a save control.
 */
import { useCallback, useMemo, useState } from 'react';
import type { DraftPhaseView, DraftTaskView, StoryChecksBody, TaskMutationResult, UpdateTaskBody } from '@learnsdlc/shared';
import { Button } from '@/components/ui';
import { projectsApi } from '@/lib/api-projects';
import { ProvenanceChip } from '../PhaseScenario';
import { BackgroundCard } from './BackgroundCard';
import type { CardState } from './BuilderCard';
import { CriteriaCard } from './CriteriaCard';
import { LearnerStoryCard } from './LearnerStoryCard';
import { ProvidedStoriesCard } from './ProvidedStoriesCard';
import { StakeholderCard } from './StakeholderCard';
import { StepBar, type BuilderStep } from './StepBar';
import { savedStoryBody, stepsDone, storyBodyOf, taskSavesFor } from './builder-model';
import './requirements-builder.css';

export {
  criterionKey,
  forgetTaskSaves,
  requirementsBuilderTask,
  savedStoryBody,
  stepsDone,
} from './builder-model';

/**
 * A save that writes the task: given the story body the server holds when
 * its turn comes (null on a task still in the older format), the body to send.
 */
export type TaskWrite = (build: (story: StoryChecksBody | null) => UpdateTaskBody) => Promise<TaskMutationResult>;

const LABELS = ['Background', 'Stakeholder', 'Provided stories', "The learner's story", 'Criteria'];

export function RequirementsBuilder({
  projectId,
  versionId,
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
  phase: DraftPhaseView;
  task: DraftTaskView;
  /** False on a published version and on a project that is not the caller's. */
  editable: boolean;
  /** The phase and the fresh report a save answered with. */
  onSaved: (result: TaskMutationResult) => void;
  /**
   * The editor's own save of the sign-off mark, `{ signOff }` alone, which
   * says its refusal and its outcome where the rest of the page does. Absent,
   * the card saves the mark itself.
   */
  onSignOff?: (signOff: boolean) => Promise<void>;
  /**
   * The editor's own required toggle (`tasks.setRequired`), the control the
   * task row carries on every other phase. Absent, none is drawn.
   */
  onToggleRequired?: () => void;
  /** A save of the editor's own is out, so its controls hold still. */
  busy?: boolean;
}) {
  const [focused, setFocused] = useState<number | null>(null);
  const [learnerTitle, setLearnerTitle] = useState(task.title);
  const done = stepsDone(phase, task);
  const steps: BuilderStep[] = LABELS.map((label, at) => ({ n: at + 1, label, done: done[at] }));
  const firstTodo = done.findIndex((one) => !one);
  const current = focused ?? (firstTodo >= 0 ? firstTodo + 1 : null);
  const stateOf = (n: number): CardState => (done[n - 1] ? 'done' : current === n ? 'current' : 'todo');
  const focus = (n: number) => () => setFocused(n);

  // The task's own cards write the task; a task no route addresses, or one
  // that came with the project and cannot be written, is drawn read-only.
  const taskEditable = editable && task.authorable && task.taskKey !== '';
  const legacy = !task.story;
  const saved = useMemo(() => savedStoryBody(task), [task]);

  // What the server holds of the story, from the answer to the last story
  // save rather than from a render that may not have happened yet, and the
  // one queue every task save waits in (see `createSaveChain`). Both outlive
  // this builder (see `taskSavesFor`), so a save still out when the teacher
  // switches tabs is waited for by the next save after they come back.
  const taskKey = task.taskKey;
  const [saves] = useState(() => taskSavesFor(`${projectId}:${versionId}:${taskKey}`, storyBodyOf(task)));
  const writeTask: TaskWrite = useCallback(
    (build) => {
      saves.pending += 1;
      return saves.chain.run(async () => {
        try {
          const result = await projectsApi.updateTask(projectId, versionId, 'requirements', taskKey, build(saves.server));
          const next = storyBodyOf(result.phase.tasks.find((one) => one.taskKey === taskKey));
          if (next) saves.server = next;
          return result;
        } finally {
          saves.pending -= 1;
        }
      });
    },
    [saves, projectId, versionId, taskKey],
  );
  const currentStory = useCallback(() => saves.server, [saves]);

  return (
    <div className="tre-panel flex min-w-0 flex-col gap-4" data-testid="requirements-builder">
      <div className="tre-hero">
        <img src="/artwork/dashboard-requirements-3d.webp" alt="" width={112} height={88} className="tre-hero-art" />
        <div className="tre-hero-text">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="label-sm">Requirements</span>
            {phase.provenance && (
              <>
                <span className="label-sm">Whose this phase is:</span>
                <ProvenanceChip
                  state={phase.provenance.rollup}
                  referenceName={phase.provenance.referenceName ?? ''}
                  testId={`phase-provenance-${phase.key}`}
                />
              </>
            )}
          </span>
          <h3 className="tre-hero-title">Build the phase the way your learners will meet it.</h3>
          <p className="purpose wrap">
            Five steps, top to bottom. Everything you type here is what they read, ask and are judged by. Nothing is a
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

      <StepBar steps={steps} current={current} signOff={taskEditable ? task.taskKey : null} />

      <BackgroundCard
        projectId={projectId}
        versionId={versionId}
        phase={phase}
        editable={editable}
        state={stateOf(1)}
        onFocusCard={focus(1)}
        onSaved={onSaved}
      />
      <StakeholderCard
        projectId={projectId}
        versionId={versionId}
        phase={phase}
        editable={editable}
        state={stateOf(2)}
        onFocusCard={focus(2)}
        onSaved={onSaved}
      />
      <ProvidedStoriesCard
        saved={saved}
        writeTask={writeTask}
        currentStory={currentStory}
        learnerTitle={learnerTitle}
        editable={taskEditable}
        state={stateOf(3)}
        onFocusCard={focus(3)}
        onSaved={onSaved}
      />
      <LearnerStoryCard
        projectId={projectId}
        versionId={versionId}
        task={task}
        saved={saved}
        writeTask={writeTask}
        currentStory={currentStory}
        legacy={legacy}
        whose={phase.provenance?.tasks.find((one) => one.taskKey === task.taskKey)?.provenance ?? null}
        referenceName={phase.provenance?.referenceName ?? ''}
        editable={taskEditable}
        state={stateOf(4)}
        onFocusCard={focus(4)}
        onSaved={onSaved}
        onSignOff={onSignOff}
        onTitle={setLearnerTitle}
      />
      <CriteriaCard
        task={task}
        writeTask={writeTask}
        editable={taskEditable}
        state={stateOf(5)}
        onFocusCard={focus(5)}
        onSaved={onSaved}
      />
    </div>
  );
}
