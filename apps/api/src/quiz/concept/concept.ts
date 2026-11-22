import { ConflictException, NotFoundException } from '@nestjs/common';
import type { FeedbackReport, PhaseKey, QuizChecks, SubmissionView } from '@learnsdlc/shared';
import { randomInt } from 'crypto';
import type { CompiledTask } from '../../content/pack-compiler';
import type { QuizAttemptEntity } from '../../db/entities';
import type { ScoredPaper } from '../../feedback/quiz-scoring';
import { optionToken } from '../quiz-attempts.service';
import { learnerQuizQuestions } from '../../workflow/learner-text';
import { CONCEPT_BANK, CONCEPT_BANK_VERSION } from './bank';

/**
 * The before/after concept checks.
 *
 * A concept check is a **virtual** quiz task. Its two keys resolve only on the
 * three quiz routes and on `GET /phases/:id/concept-quizzes`; they are never in
 * `getTasksForEnrollment`, a task panel, a phase view or a gate, so task lists,
 * gate maths and strict evidence are unaffected. Its papers go only
 * into `quiz_attempts` (epoch 0): no `task_states` row is read or written, no
 * submission is created and no event or progress is recorded. If a pack
 * declares a task with one of these keys, the pack's task wins and the concept
 * check is off for that phase.
 */
export const CONCEPT_BEFORE = 'concept-before';
export const CONCEPT_AFTER = 'concept-after';
export const CONCEPT_TASK_KEYS = [CONCEPT_BEFORE, CONCEPT_AFTER] as const;
export type ConceptTaskKey = (typeof CONCEPT_TASK_KEYS)[number];

export function isConceptTaskKey(key: unknown): key is ConceptTaskKey {
  return key === CONCEPT_BEFORE || key === CONCEPT_AFTER;
}

/** A concept check has no attempt epoch: nothing resets it. */
export const CONCEPT_EPOCH = 0;

/** Not graded: every handed-in paper counts as taken, so nothing reads as a fail. */
export const CONCEPT_PASS_MARK = 0;

/**
 * `closed` is the before check's own: once work for the
 * phase is handed in, a "before" score would come after the learning.
 */
export type ConceptSlotStatus = 'locked' | 'open' | 'taken' | 'closed';

export interface ConceptSlot {
  taskKey: ConceptTaskKey;
  status: ConceptSlotStatus;
  scorePct: number | null;
  questionCount: number;
}

export interface ConceptQuizzesView {
  phaseKey: string;
  before: ConceptSlot;
  after: ConceptSlot;
}

export function conceptBankFor(phaseKey: string) {
  return Object.prototype.hasOwnProperty.call(CONCEPT_BANK, phaseKey)
    ? CONCEPT_BANK[phaseKey as PhaseKey]
    : null;
}

/** 404 for a phase whose key has no bank (cannot happen for the six product phases). */
export function noConceptCheckRefusal(): NotFoundException {
  return new NotFoundException('There is no concept check for this phase.');
}

/** The one slot a learner may take once. */
export function conceptTakenRefusal(): ConflictException {
  return new ConflictException({
    error: 'concept_quiz_taken',
    message: 'You have already taken this quick check. Each check is taken once.',
  });
}

/** The after-check, asked for before the phase is passed. */
export function conceptLockedRefusal(): ConflictException {
  return new ConflictException({
    error: 'concept_quiz_locked',
    message: 'The "What did you learn?" check opens once you have passed this phase.',
  });
}

/**
 * The before check, asked for once the learner has handed
 * in work for this phase.
 */
export function conceptClosedRefusal(): ConflictException {
  return new ConflictException({
    error: 'concept_quiz_closed',
    message: 'The before check closes once you have handed in work for this phase.',
  });
}

/**
 * The checks slice for this phase, in the shape `quizChecksFor` returns. The
 * question order is shuffled on every call (crypto, not seeded), and the paper
 * is drawn from it in that order, so each attempt shows all six in a fresh
 * order. Options are shuffled by `drawPaper` (`shuffleOptions`).
 */
export function conceptChecks(phaseKey: string, shuffle = false): QuizChecks | null {
  const bank = conceptBankFor(phaseKey);
  if (!bank) return null;
  const questions = bank.questions.map((question) => ({
    ...question,
    options: question.options.map((option) => ({ ...option })),
    correct: [...question.correct],
  }));
  if (shuffle) {
    for (let i = questions.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [questions[i], questions[j]] = [questions[j], questions[i]];
    }
  }
  return {
    kind: 'quiz',
    questions,
    shuffleOptions: true,
    passMark: CONCEPT_PASS_MARK,
    attempts: { max: 1, cooldownSeconds: null },
    criterion: 'concepts',
    revealExplanation: 'always',
  };
}

/** The virtual task the quiz routes resolve a concept key to. */
export function conceptTask(phaseKey: string, taskKey: ConceptTaskKey, checks: QuizChecks): CompiledTask {
  const chapter = conceptBankFor(phaseKey)?.title ?? phaseKey;
  const before = taskKey === CONCEPT_BEFORE;
  return {
    taskKey,
    order: before ? -1 : 9999,
    required: false,
    signOff: false,
    checkKind: 'quiz',
    artefactType: 'quiz',
    artefactPath: null,
    title: before ? 'Quick check before you start' : 'What did you learn?',
    brief: before
      ? `${checks.questions.length} quick questions on what the ${chapter} chapter teaches. It is not graded and does not lock anything; it helps us see what the chapter teaches you.`
      : `The same ${checks.questions.length} quick questions on the ${chapter} chapter, now that you have finished it. It is not graded; it shows what you learnt.`,
    objectives: [],
    owns: [],
    gradedUnits: [],
    rubric: { passThreshold: CONCEPT_PASS_MARK, criteria: [] },
    checks,
  } as CompiledTask;
}

/** A handed-in, scored paper's mark as a whole percentage, or null. */
export function conceptScorePct(row: Pick<QuizAttemptEntity, 'score'> | null | undefined): number | null {
  const score = row?.score;
  return typeof score === 'number' && Number.isFinite(score) ? Math.round(score) : null;
}

/**
 * The status of one slot.
 *
 * before: taken once a non-voided handed-in attempt exists. Otherwise closed
 * once the learner has handed in work for the phase (`handedInWork`: at least
 * one `submissions` row on the phase state, any task, any status; a concept
 * check writes none) or the phase reads `submitted` or `passed`: a "before"
 * score taken after the learning would skew the pair.
 * Otherwise open.
 * after: locked until the phase state is passed, then open, then taken. A
 * phase reads `passed` only once every required sign-off is countersigned.
 */
export function conceptSlotStatus(
  taskKey: ConceptTaskKey,
  phaseStatus: string | null | undefined,
  taken: boolean,
  handedInWork = false,
): ConceptSlotStatus {
  if (taken) return 'taken';
  if (taskKey === CONCEPT_AFTER) return phaseStatus === 'passed' ? 'open' : 'locked';
  if (handedInWork || phaseStatus === 'submitted' || phaseStatus === 'passed') return 'closed';
  return 'open';
}

/**
 * The scored paper as the hand-in route answers it: a completed
 * `SubmissionView` whose report carries the per-question `quiz` section, the
 * same shape a pack quiz's revision has, so `QuizResult` can draw it. The `id`
 * is the attempt's: there is no submission row behind a concept check.
 * The before check answers with the score only (no per-question rows, no
 * explanations): the after check asks the same questions, so releasing them
 * here would make the after score measure recall of this feedback, not what
 * the phase taught. The after check releases every explanation. The key never
 * leaves: options carry this paper's tokens and each question only says
 * right/wrong.
 */
export function conceptSubmissionView(
  row: Pick<QuizAttemptEntity, 'id' | 'taskKey' | 'submittedAt' | 'startedAt'>,
  scored: ScoredPaper,
  scorePct: number,
): SubmissionView {
  const withheld = row.taskKey === CONCEPT_BEFORE;
  // the result as a learner reads it: its stems, options, explanations and concept labels plain, HTML comments not shown, converted once here
  const questions = withheld ? [] : learnerQuizQuestions(scored.questions).map((question) => ({
    ...question,
    options: question.options.map((option) => ({
      id: optionToken(row.id, question.id, option.id),
      text: option.text,
    })),
    selected: question.selected.map((optionId) => optionToken(row.id, question.id, optionId)),
  }));
  const report: FeedbackReport = {
    overall: scorePct,
    passed: true,
    criteria: [],
    checks: [
      {
        id: 'quiz',
        label: 'Concept check',
        status: 'info',
        detail: `${scored.correctCount} of ${scored.drawn} right.`,
      },
    ],
    aiReview: { summary: '', strengths: [], improvements: [], processNote: '', provider: 'none' },
    aiReliance: { hintsThisPhase: 0, index: 0 },
    integrity: { relianceFlag: false, relianceIndex: 0, mentorPasteFlag: false, noEffortFlag: false, note: '' },
    quiz: {
      correctCount: scored.correctCount,
      drawn: scored.drawn,
      passMark: CONCEPT_PASS_MARK,
      attempt: 1,
      attemptsLeft: 0,
      questions,
    },
  };
  return {
    id: row.id,
    taskKey: row.taskKey,
    status: 'completed',
    score: scorePct,
    passed: true,
    report,
    createdAt: row.submittedAt ?? row.startedAt,
    attempt: 1,
  };
}

export { CONCEPT_BANK_VERSION };
