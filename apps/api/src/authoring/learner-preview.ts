import type {
  LearnerPreviewFile,
  LearnerPreviewInterview,
  LearnerPreviewPhase,
  LearnerPreviewQuiz,
  LearnerPreviewTask,
  LearnerPreviewView,
} from '@learnsdlc/shared';
import type { PhaseContent } from '../content/content.types';
import { checksOf, type CompiledSnapshot, type CompiledTask } from '../content/pack-compiler';
import { evidenceOf } from '../workflow/task-view';
import { phaseDetailStory } from '../workflow/phase-detail-story';
import { phaseDetailDesign } from '../workflow/phase-detail-design';
import { phaseDetailChange, phaseDetailRunbook } from '../workflow/phase-detail-records';
import { learnerChecksText, learnerText } from '../workflow/learner-text';

/**
 * A draft, as a learner of it
 * would first read it.
 *
 * **Pure.** One argument, the version's compiled snapshot, and one answer. No
 * repository, no provider, no sandbox, no grader, no `RunGate` and no DI
 * container: `learner-preview.spec.ts` walks this file's import graph and
 * fails on any of them. The route that serves it reads the
 * stored snapshot behind the owner-only guard and hands it here, so a preview
 * creates no phase state, enrolment, submission, run or audit row, evaluates
 * no gate and calls no model.
 *
 * **A whitelist, field by field, that is the seal.** The snapshot carries
 * every sealed byte of the draft (`checks` is where hidden tests, solutions,
 * references, impl files, mutants, drill faults and a quiz's key live, and
 * `interview.facts` is the stakeholder's hidden truth). Nothing is copied out
 * of it by spread or by walking it: each field below is named, and each is
 * one the learner's own payload already carries for the same phase:
 * `phaseDetail` (title, intro, objectives, taskPanel, files, the task views,
 * canRun, runLabel, the rubric's criterion titles), `InterviewService.state`
 * (persona, opening) and the quiz room and paper (title, drawn, passMark,
 * stem, the options' text, `multiple`). The parity e2e holds every value to
 * the learner's with equal bytes. Two fields are derived and say so: the gate
 * sentence, and `needsSignOff` (exactly `evidence === 'signed-off'`).
 *
 * **What it deliberately leaves out**, though a learner reads some of it
 * elsewhere: the rubric's weights and descriptions, each task's brief and
 * objectives, the interview's fact topics, `maxTurns` and its two fixed
 * replies, the quiz's attempt rules, and every option's authored id (a
 * learner reads options by their paper's own token, never by the id the key
 * is written in).
 */
export function learnerPreviewOf(compiled: CompiledSnapshot): LearnerPreviewView {
  const phases = [...compiled.content.phases].sort((a, b) => a.order - b.order);
  const tasksOf = new Map(compiled.phases.map((one) => [one.key, one.tasks] as const));
  return {
    title: compiled.content.title,
    version: compiled.version,
    phases: phases.map((phase, at) => {
      const tasks = [...(tasksOf.get(phase.key) ?? [])].sort((a, b) => a.order - b.order);
      const previous = at > 0 ? phases[at - 1] : null;
      const previousTasks = previous ? tasksOf.get(previous.key) ?? [] : [];
      return previewPhaseOf(phase, tasks, previous ? previewGateSentence(previous.title, previousTasks) : FIRST_PHASE_GATE);
    }),
  };
}

/** The gate sentence of the first phase, which no earlier phase holds shut. */
export const FIRST_PHASE_GATE = 'Learners open this first.';

/**
 * When a learner opens a later phase: every task in the phase
 * before it has passed and, where a task needs it, has been signed off. A bare
 * "passes" would misstate the sign-off gate. The sentence names its subject
 * in both clauses. Where the phase before holds an optional
 * task, the sentence says **required**, because an optional task moves no
 * gate (`taskCountsOf`) and the sentence must not promise that it does.
 *
 * Shown, never enforced: the preview has no learner whose progress it could
 * change, and `nextPhaseStatus` is never called.
 */
export function previewGateSentence(previousTitle: string, previousTasks: readonly CompiledTask[] = []): string {
  const optional = previousTasks.some((task) => !task.required);
  return `Learners open this after every ${optional ? 'required ' : ''}task in ${previousTitle} has passed and, where a task needs it, has been signed off.`;
}

function previewPhaseOf(phase: PhaseContent, tasks: CompiledTask[], gate: string): LearnerPreviewPhase {
  // the story, design and ticket lines as a learner reads them, converted once for every builder below
  const learnerChecks = learnerChecksText(phase.checks);
  return {
    key: phase.key,
    order: phase.order,
    title: phase.title,
    // what a learner reads of these texts: plain, their HTML comments not shown
    intro: learnerText(phase.intro),
    objectives: phase.objectives.map(learnerText),
    brief: learnerText(phase.taskPanel),
    files: phase.files.map(learnerFileOf),
    story: phaseDetailStory(learnerChecks),
    design: phaseDetailDesign(learnerChecks),
    runbook: phaseDetailRunbook(phase.checks),
    change: phaseDetailChange(learnerChecks),
    tasks: tasks.map((task) => previewTaskOf(phase, task)),
    quizzes: tasks.flatMap((task) => previewQuizOf(phase, task)),
    interview: previewInterviewOf(phase),
    canRun: phase.canRun,
    runLabel: phase.runLabel,
    checkLabels: phase.rubric.criteria.map((criterion) => learnerText(criterion.title)),
    gate,
  };
}

/**
 * A workspace row as a learner's room mounts it before they type: the shape
 * `ContentService.workspaceFiles(phase, null)` answers. `phase.files` is the
 * workspace a learner is given, editable and locked rows both, and it never
 * holds a sealed row (the importer's `HIDDEN_IN_WORKSPACE` and byte rules
 * refuse one, and `phaseFilesFrom` reads `role === 'workspace'` rows only).
 */
function learnerFileOf(file: PhaseContent['files'][number]): LearnerPreviewFile {
  return { path: file.path, content: file.content, editable: file.editable, language: file.language };
}

function previewTaskOf(phase: PhaseContent, task: CompiledTask): LearnerPreviewTask {
  const evidence = evidenceOf(phase, task);
  return {
    key: task.taskKey,
    order: task.order,
    required: task.required,
    title: task.title,
    artefactType: task.artefactType,
    evidence,
    needsSignOff: evidence === 'signed-off',
  };
}

/** A quiz task's pool without its key: no `correct`, no `explanation`, no `concept`, no option id. */
function previewQuizOf(phase: PhaseContent, task: CompiledTask): LearnerPreviewQuiz[] {
  const checks = checksOf(phase, task);
  if (checks.kind !== 'quiz') return [];
  return [
    {
      taskKey: task.taskKey,
      title: task.title,
      drawn: checks.drawn ?? checks.questions.length,
      passMark: checks.passMark,
      questions: checks.questions.map((question) => ({
        id: question.id,
        stem: learnerText(question.stem),
        options: question.options.map((option) => learnerText(option.text)),
        multiple: new Set(question.correct).size > 1,
      })),
    },
  ];
}

/** Persona and opening, and nothing else of the brief. */
function previewInterviewOf(phase: PhaseContent): LearnerPreviewInterview | null {
  const brief = phase.interview;
  if (!brief) return null;
  return { persona: { name: brief.persona.name, role: brief.persona.role }, opening: brief.opening };
}
