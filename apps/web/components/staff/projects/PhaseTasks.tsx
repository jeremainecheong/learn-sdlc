'use client';

/**
 * One phase's tasks, in order.
 *
 * **An inherited task carries a Notice, not a disabled control.** `code`,
 * `tests`, `runbook` and `change-request` tasks arrive with the project a
 * teacher copied and are graded exactly as the reference project grades them;
 * this editor cannot write them, so the row says `INHERITED_TASK_NOTICE` and simply has no Edit,
 * no Remove and no required toggle. A greyed control is a promise that trying
 * harder would work.
 *
 * **Reordering carries the whole phase.** An ordering is one fact, so Move up
 * and Move down send every key in the phase (inherited ones included) in the
 * order wanted, rather than a pairwise swap that leaves two tasks claiming
 * position 3. They are buttons rather than a drag surface because a button is
 * reachable from a keyboard without a second implementation, and the move is
 * announced in a polite live region so it is not a silent reshuffle. The button
 * that finishes a move goes off (the task is now first, or last) so
 * `ProjectEditor` hands focus to the live control on the same row rather than
 * letting the browser drop it to `<body>`.
 *
 * **A row is the task, not its file.** It shows the title, the type word, the
 * required chip and the sign-off mark, with the brief's first line and what
 * scores it. No task a teacher adds here writes a file or is scored by rules,
 * so a row names no artefact path and counts no rules.
 *
 * **The gate is drawn beside the phase that would trip it.** A phase holds one
 * piece of its own work beside any number of concept quizzes, so a phase
 * holding more than one says why publish would refuse, in
 * `multiTaskPublishRefusal`'s own words: the same sentence the report carries
 * and the same one the door would answer with. The phase's `checkKind` is
 * passed, and where the payload lacks it the phase's own kind answers,
 * which is what keeps the two wordings one.
 */
import type { DraftPhaseView, DraftTaskView } from '@learnsdlc/shared';
import { multiTaskPublishRefusal } from '@learnsdlc/shared';
import { Button, Chip, EmptyState, Notice } from '@/components/ui';
import { ProvenanceChip } from './PhaseScenario';
// The sign-off mark on a task's row.
import { SignOffHelp, SignOffToggle, signOffHelpIds, takesSignOff } from './TaskEditor';

/**
 * What scores a task, in one line: a quiz's questions, or the criteria the
 * task carries. No task a teacher writes here is scored by rules, so the line
 * never counts any.
 */
export function scoringLine(task: DraftTaskView): string {
  const criteria = task.rubric?.criteria?.length ?? 0;
  const scored = criteria === 1 ? '1 criterion' : `${criteria} criteria`;
  if (!task.authorable) return `Scored on the ${scored} it came with.`;
  // A quiz is scored on its questions, so the row names them: how many, how
  // many a paper draws, and the mark that passes.
  if (task.quiz) {
    const pool = task.quiz.questions.length;
    const drawn = task.quiz.drawn ?? pool;
    const questions = pool === 1 ? '1 question' : `${pool} questions`;
    const paper = drawn < pool ? `, ${drawn} on each paper` : '';
    return `${questions}${paper}, pass mark ${task.quiz.passMark}%.`;
  }
  return `Scored on ${scored}.`;
}

/**
 * The one line a task row shows of its brief: its first line that is not
 * blank, trimmed.
 *
 * A brief is plain text: no heading opens it and nothing in it is
 * markup, so its first line is its summary, a list's marker and a backtick
 * included, as the learner reads them. A draft still holding markdown shows
 * its first line as written until its first save makes it plain.
 */
export function briefSummary(brief: string): string {
  return brief.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
}

/** "This phase passes when …", the one line that says what gates it. */
function gateLine(phase: DraftPhaseView): string {
  const required = phase.tasks.filter((one) => one.required).length;
  const optional = phase.tasks.length - required;
  const first =
    required === 0
      ? 'No task in this phase is required, so no learner could pass it.'
      : required === 1
        ? 'This phase passes when its 1 required task passes.'
        : `This phase passes when all ${required} required tasks pass.`;
  const second =
    optional === 0
      ? ''
      : optional === 1
        ? ' 1 optional task is extra credit and never blocks.'
        : ` ${optional} optional tasks are extra credit and never block.`;
  return `${first}${second}`;
}

function TaskRow({
  task,
  phase,
  editable,
  at,
  busy,
  onMove,
  onToggleRequired,
  onEdit,
  onRemove,
  readOnlyReason,
  onSignOff,
  signOffHelp,
}: {
  task: DraftTaskView;
  phase: DraftPhaseView;
  editable: boolean;
  at: number;
  busy: boolean;
  onMove: (taskKey: string, by: -1 | 1) => void;
  onToggleRequired: (task: DraftTaskView) => void;
  onEdit: (task: DraftTaskView) => void;
  onRemove: (task: DraftTaskView) => void;
  readOnlyReason?: string | null;
  onSignOff?: (task: DraftTaskView, signOff: boolean) => Promise<void> | void;
  /** The phase's `SignOffHelp` id, where the phase draws marks. */
  signOffHelp?: string;
}) {
  const mine = editable && task.authorable;
  const orderable = editable && phase.tasks.length > 1;
  const first = at === 0;
  const last = at === phase.tasks.length - 1;
  // Whose this task is, from the phase's provenance.
  const origin = phase.provenance?.tasks.find((one) => one.taskKey === task.taskKey) ?? null;

  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-b-1.5 border-edge px-4 py-3.5 last:border-b-0"
      data-testid={`task-row-${task.taskKey}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="mono shrink-0 text-[12px] text-muted">{task.order}</span>
        <span
          className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink"
          data-testid={`task-title-${task.taskKey}`}
        >
          {task.title}
        </span>
        <Chip tone="outline" testId={`task-type-${task.taskKey}`}>
          {task.artefactType}
        </Chip>
        <Chip
          tone={task.required ? 'accent' : 'neutral'}
          testId={`task-required-${task.taskKey}`}
        >
          {task.required ? 'Required' : 'Optional'}
        </Chip>
        {origin && (
          <ProvenanceChip
            state={origin.provenance}
            referenceName={phase.provenance?.referenceName ?? ''}
            testId={`task-provenance-${task.taskKey}`}
          />
        )}
      </div>

      {briefSummary(task.brief ?? '') && (
        <p className="purpose wrap" data-testid={`task-summary-${task.taskKey}`}>
          {briefSummary(task.brief ?? '')}
        </p>
      )}

      <p className="label-sm" data-testid={`task-scoring-${task.taskKey}`}>
        {scoringLine(task)}
      </p>

      {task.notice && (
        <Notice tone="info" testId={`task-notice-box-${task.taskKey}`}>
          <span data-testid={`task-notice-${task.taskKey}`}>{task.notice}</span>
        </Notice>
      )}

      {/* The mark, where the version can change
          or says why it cannot; a task kind that takes none draws nothing. */}
      {onSignOff && signOffHelp && takesSignOff(task) && (
        <SignOffToggle
          task={task}
          off={!editable}
          describedBy={signOffHelpIds(signOffHelp, editable ? null : (readOnlyReason ?? null))}
          busy={busy}
          onChange={(signOff) => onSignOff(task, signOff)}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {orderable && (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon="arrow-up"
              disabled={first || busy}
              reason={first ? 'This task is already first.' : undefined}
              ariaLabel={`Move ${task.title} up`}
              testId={`task-up-${task.taskKey}`}
              onClick={() => onMove(task.taskKey, -1)}
            >
              Move up
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="arrow-down"
              disabled={last || busy}
              reason={last ? 'This task is already last.' : undefined}
              ariaLabel={`Move ${task.title} down`}
              testId={`task-down-${task.taskKey}`}
              onClick={() => onMove(task.taskKey, 1)}
            >
              Move down
            </Button>
          </>
        )}
        {mine && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              testId={`task-required-toggle-${task.taskKey}`}
              onClick={() => onToggleRequired(task)}
            >
              {task.required ? 'Make optional' : 'Make required'}
            </Button>
            {/* The task editor opens only a quiz; any other task is edited
                where it is built. */}
            {task.checkKind === 'quiz' && (
              <Button
                size="sm"
                variant="secondary"
                icon="edit"
                disabled={busy}
                testId={`task-edit-${task.taskKey}`}
                onClick={() => onEdit(task)}
              >
                Edit
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              disabled={busy}
              testId={`task-remove-${task.taskKey}`}
              onClick={() => onRemove(task)}
            >
              Remove
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

export function PhaseTasks({
  phase,
  editable,
  busy,
  onMove,
  onToggleRequired,
  onEdit,
  onRemove,
  showIntro = true,
  readOnlyReason = null,
  onSignOff,
  drawnElsewhere,
}: {
  phase: DraftPhaseView;
  /**
   * Tasks another panel draws (the Requirements builder's story task). Their
   * rows are left out, but they still count in the gate line and in the
   * order, so a quiz beside one can still move past it.
   */
  drawnElsewhere?: ReadonlySet<string>;
  /**
   * False where `PhaseScenario` draws the intro with its
   * chip and its door, so one intro is not printed twice.
   */
  showIntro?: boolean;
  /** False on a published version and on a project that is not the caller's. */
  editable: boolean;
  busy: boolean;
  onMove: (taskKey: string, by: -1 | 1) => void;
  onToggleRequired: (task: DraftTaskView) => void;
  onEdit: (task: DraftTaskView) => void;
  onRemove: (task: DraftTaskView) => void;
  /** Why the version cannot change (the editor's own sentence), or null. */
  readOnlyReason?: string | null;
  /** Save a task's sign-off mark, alone. Absent, no mark is drawn. */
  onSignOff?: (task: DraftTaskView, signOff: boolean) => Promise<void> | void;
}) {
  // Marks are drawn where the version can change
  // or says why it cannot, and their help once per phase.
  // A task drawn elsewhere carries its mark (and the mark's help) there.
  const marks =
    Boolean(onSignOff) &&
    (editable || Boolean(readOnlyReason)) &&
    phase.tasks.some((task) => takesSignOff(task) && !drawnElsewhere?.has(task.taskKey));
  const signOffHelp = marks ? `task-signoff-help-${phase.key}` : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={`project-phase-${phase.key}`}>
      {showIntro && <p className="purpose wrap">{phase.intro}</p>}
      <p className="label-sm" data-testid={`project-phase-gating-${phase.key}`}>
        {gateLine(phase)}
      </p>

      {phase.blocksPublish && (
        <Notice tone="warn" role="status" testId={`project-phase-gate-box-${phase.key}`}>
          <span data-testid={`project-phase-gate-${phase.key}`}>
            {/* The check kind, so this is the sentence the report's gate row
                carries and not a near-miss of it. */}
            {/* The **non-quiz** count, because that is what `blocksPublish`
                is derived from (`draft.ts`) and what the compiler's own
                wall counts. A phase of two executable tasks and a quiz draws
                this box about the split it really has; counting the quiz would
                say "3 tasks" about a wall that refused 2. */}
            {multiTaskPublishRefusal(
              phase.title,
              phase.tasks.filter((one) => one.checkKind !== 'quiz').length,
              phase.checkKind ?? phase.artifactKind,
            )}
          </span>
        </Notice>
      )}

      {signOffHelp && <SignOffHelp id={signOffHelp} readOnlyReason={editable ? null : (readOnlyReason ?? null)} />}

      {phase.tasks.length === 0 ? (
        <EmptyState
          icon="list"
          title="This phase has no tasks"
          body="A phase needs a required task that produces its artefact, and a quiz alone cannot be that task, so publish refuses this phase."
          testId={`project-phase-empty-${phase.key}`}
        />
      ) : (
        <ul className="m-0 flex list-none flex-col rounded-ctl border-1.5 border-edge p-0">
          {phase.tasks.map((task, at) => drawnElsewhere?.has(task.taskKey) ? null : (
            <TaskRow
              key={task.taskKey}
              task={task}
              phase={phase}
              editable={editable}
              at={at}
              busy={busy}
              onMove={onMove}
              onToggleRequired={onToggleRequired}
              onEdit={onEdit}
              onRemove={onRemove}
              readOnlyReason={readOnlyReason}
              onSignOff={onSignOff}
              signOffHelp={signOffHelp}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
