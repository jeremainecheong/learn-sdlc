import type { PhaseStatus, PhaseTaskCounts, PhaseTaskView } from '@learnsdlc/shared';
import type { PhaseContent } from '../content/content.types';
import { checksOf, type CompiledTask } from '../content/pack-compiler';
import { soleTaskList } from '../content/task-units';
import { referenceFiles } from './solution.reference';
import { learnerRubric, learnerText } from './learner-text';

/**
 * The learner's view of a phase's tasks.
 *
 * A pure module, with no repository, no entity and no request in it: the
 * numbers arrive as the two structural shapes below and the answer is the
 * payload. That is what lets the phase detail, the phase summaries and a spec
 * build the same list from the same code without any of them importing the
 * others. `WorkflowService` mounts it into `phaseDetail` and `phaseSummary`,
 * and this file never learns which caller it is serving.
 *
 * Two facts about a task are **derived and never chosen**, and everything else
 * here follows from where a task's numbers live.
 */

/**
 * The phase row a **sole** task's numbers are read from.
 *
 * A synthesised sole task has no `task_states` row at all: none is ever
 * written and none is ever wanted, so its status, its score, its attempts,
 * its stamp and its door's `readAt` are the phase's own. A builder that read
 * only rows would draw six untouched tasks over a finished TaskTrackr project.
 *
 * Structural, so `PhaseStateEntity` satisfies it without this module importing
 * one.
 */
export interface PhaseRowFacts {
  status: PhaseStatus;
  bestScore: number | null;
  attempts: number;
  passedAt: string | null;
  solutionReadAt: string | null;
}

/**
 * A version phase a board holds no `phase_states` row for.
 *
 * The checklist is the **pinned version's** list, so a phase the version
 * declares and the board has no row for still counts its required tasks in the
 * denominator: nothing in it has passed, because the learner is not in it.
 * `locked` rather than `in_progress` for that reason; only `passed` is read
 * from here, so the word states what the shape means rather than being a value
 * anything branches on. The teacher's dashboard and the gradebook both read
 * this one constant, so they report the same checklist for one board.
 */
export const NO_PHASE_ROW: PhaseRowFacts = {
  status: 'locked',
  bestScore: null,
  attempts: 0,
  passedAt: null,
  solutionReadAt: null,
};

/**
 * One `task_states` row, structurally: `TaskStateEntity` satisfies it.
 *
 * Every field an authored task's view reads, and nothing else: the row also
 * carries `ranBeforeSubmit`, `signedOffBy` and `signedOffAt`
 * (which the instructor's view names and a learner's does not), and those are
 * deliberately absent rather than carried and ignored.
 */
export interface TaskRowFacts {
  taskKey: string;
  status: PhaseStatus;
  bestScore: number | null;
  attempts: number;
  passedAt: string | null;
  solutionReadAt: string | null;
  awaitingSignOff: boolean;
  resetAt: string | null;
}

/** What a task with no row of its own reads as. See `taskViews`. */
const NO_ROW: Omit<TaskRowFacts, 'taskKey'> = {
  status: 'in_progress',
  bestScore: null,
  attempts: 0,
  passedAt: null,
  solutionReadAt: null,
  awaitingSignOff: false,
  resetAt: null,
};

/**
 * Whether a pass of **this task alone** can open the phase.
 *
 * Derived from the task's own checks, never from a field on the task: there is
 * no `sealed` on `CompiledTask` and there is deliberately none, so an
 * authoring surface tells a teacher what kind of proof their task will produce
 * and they strengthen it by adding evidence rather than by picking a stricter
 * word.
 *
 * - **a story or design record is sealed by construction**, and so is a
 *   stored task of the retired written (markdown) kind a learner may still be
 *   pinned to: its rules are the project's and the learner never sees the
 *   pattern they are judged against;
 * - **code** is sealed by a hidden suite the workspace does not carry;
 * - **tests** by a reference suite and the mutants it must kill;
 * - **deployment** by a smoke run of the container the pack declares.
 *
 * Every phase of the shipped project is sealed, which is what makes the
 * countersignature conjunct unreachable there.
 */
export function sealedTask(phase: PhaseContent, task: CompiledTask): boolean {
  const checks = checksOf(phase, task);
  // the retired written kind is no member of the kinds a pack loads, but an older snapshot still holds it
  if (isStoredWritten(checks)) return true;
  switch (checks.kind) {
    case 'story':
    case 'design':
      return true;
    case 'code':
      return Object.keys(checks.hiddenTestFiles).length > 0;
    case 'tests':
      return Object.keys(checks.referenceTestFiles).length > 0 && checks.mutants.length > 0;
    case 'config':
      return checks.smokeCommands.length > 0;
    // A quiz is sealed by its key. The answer never leaves
    // the API on any route at any time, so a pass of the quiz alone can open
    // the phase, and `evidenceOf` below answers `automated`, because a paper
    // is machine-decided and deterministic, which is what that word means
    // here. A quiz with no questions seals nothing, which is the shape
    // `quiz-questions-well-formed` refuses before it can be published.
    case 'quiz':
      return checks.questions.length > 0;
  }
}

/** The older written kind, outside the union, that a pinned version's stored phase can still hold. */
function isStoredWritten(checks: { kind: string }): boolean {
  return checks.kind === 'markdown';
}

/**
 * What kind of proof this task produces, in one word: derived from the same
 * units `sealedTask` reads and from the task's own `signOff` flag.
 *
 * A countersignature answers first because it is the strongest statement about
 * how the task is settled: the evidence may be in and a teacher's name is
 * still the remaining half.
 */
export function evidenceOf(phase: PhaseContent, task: CompiledTask): PhaseTaskView['evidence'] {
  if (task.signOff) return 'signed-off';
  if (!sealedTask(phase, task)) return 'assisted';
  // a story or design record, like older written work, is settled by the strict reviewer over its floor
  const checks = checksOf(phase, task);
  return checks.kind === 'story' || checks.kind === 'design' || isStoredWritten(checks) ? 'reviewed' : 'automated';
}

/**
 * How far a phase's tasks have got, over all of them and over the required set.
 *
 * The two halves are separate because an optional task moves no gate: it is
 * shown, scored and recorded, and only `passedRequired === required` says
 * whether the phase can open. That is what makes *"3 of 4 done, 2 of 2
 * required"* one sentence a tile can draw.
 *
 * Counted off the views rather than off the rows, so the one place a task's
 * status is resolved: `taskViews`, which reads the phase row for a sole task
 * and the task row for an authored one: is the one place it is counted from.
 * A required key with no row is `in_progress` there and is therefore not
 * counted here: a required key with no row is failing, at the surface a
 * learner reads it on.
 */
export function taskCountsOf(views: readonly PhaseTaskView[]): PhaseTaskCounts {
  const required = views.filter((view) => view.required);
  return {
    total: views.length,
    required: required.length,
    passed: views.filter((view) => view.status === 'passed').length,
    passedRequired: required.filter((view) => view.status === 'passed').length,
  };
}

export interface TaskViewInput {
  phase: PhaseContent;
  /** The **pinned** version's list, in the order it declares them. */
  tasks: readonly CompiledTask[];
  /** The phase row, which is where a sole task's numbers live. */
  state: PhaseRowFacts;
  /** This phase state's `task_states` rows. Empty on a sole-task phase. */
  rows?: readonly TaskRowFacts[];
  /** The newest revision of each task, by key, where the caller has read them. */
  lastSubmissionIds?: ReadonlyMap<string, string | null>;
  /**
   * `summary` omits the four heavy fields. The shell holds a summary of every
   * open phase, and a rubric is a list of criteria with titles and weights:
   * carrying one per task per phase is the payload the summaries view exists
   * to keep small. The room fetches the full view it already fetches.
   */
  view?: 'summary' | 'full';
}

/**
 * This phase's tasks, as the learner's client reads them.
 *
 * **Where the numbers come from is the whole of it.** A sole task's are the
 * phase row's, because no `task_states` row exists to hold them; an authored
 * task's are its own row's, and a task whose row is missing reads exactly as a
 * task nobody has started: `in_progress`, no score, no attempts, no stamp.
 * That last case is not a fallback to be tidied away later: a required key
 * with no row is a key that has not been passed, so the surface and the gate
 * say the same thing about it.
 *
 * The door is `referenceFiles`' own answer for **this task**, never the
 * phase's, so a room is never offered a door that belongs to nobody, and on
 * written work it is shut whatever the gate says, because the pack ships no
 * answer for prose.
 */
export function taskViews(input: TaskViewInput): PhaseTaskView[] {
  const { phase, tasks, state, view = 'full' } = input;
  const sole = soleTaskList(tasks);
  const byKey = new Map((input.rows ?? []).map((row) => [row.taskKey, row]));
  return tasks.map((task) => {
    // A sole task IS the phase, so its facts are the phase row's; an
    // authored task's are its own row's, and a missing row is an unstarted one.
    const facts: Omit<TaskRowFacts, 'taskKey'> = sole
      ? { ...NO_ROW, ...state }
      : byKey.get(task.taskKey) ?? NO_ROW;
    const answer = referenceFiles(phase, task);
    const heavy =
      view === 'full'
        ? {
            // what a learner reads of the version, plain, its HTML comments not shown
            brief: learnerText(task.brief),
            objectives: task.objectives.map(learnerText),
            files: task.owns,
            rubric: learnerRubric(task.rubric),
          }
        : {};
    // **Field by field, and that is the seal.** What a
    // task is scored by (`checks`) is deliberately not here: it is where a
    // code phase's `hiddenTestFiles` and `solutionFiles` live, where the
    // customer interview's answers live, and where a quiz's `correct` and
    // `explanation` live. A field added below carries whatever it names into
    // every learner's browser, so `task-view.spec.ts` asserts this list
    // **exactly** and a new field is a red spec until somebody has said why it
    // is safe.
    return {
      key: task.taskKey,
      order: task.order,
      required: task.required,
      title: task.title,
      artefactType: task.artefactType,
      // Null on the compiled task means "this room reads no single file", and
      // the view's field is absent rather than null for exactly that reason.
      ...(task.artefactPath ? { artefactPath: task.artefactPath } : {}),
      // What the IDE opens where there is no artefact file: the first path the
      // task owns, which is the per-task form of the fallback the workspace
      // already takes over the phase's editable files.
      ...(task.owns.length ? { primaryPath: task.owns[0] } : {}),
      evidence: evidenceOf(phase, task),
      sealed: sealedTask(phase, task),
      status: facts.status,
      awaitingSignOff: facts.awaitingSignOff,
      attempts: facts.attempts,
      bestScore: facts.bestScore,
      passedAt: facts.passedAt,
      lastSubmissionId: input.lastSubmissionIds?.get(task.taskKey) ?? null,
      resetAt: facts.resetAt,
      solution: {
        available: answer.available,
        files: answer.files.length,
        readAt: facts.solutionReadAt,
      },
      ...heavy,
    };
  });
}
