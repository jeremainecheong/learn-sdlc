'use client';

/**
 * A quiz, as the teacher who owns it writes it, and the one thing this panel
 * does not start with.
 *
 * **The key is not in the draft payload, so it is not on this screen until it
 * is asked for.** `DraftTaskView.quiz` is `AuthoredQuizView`: stems, options,
 * settings, and a *count* of how many options each question keys. It carries
 * neither `correct` nor `explanation`, because `readDraft` is guarded by
 * `requireVisibleProject`: every instructor on the deployment can read a
 * platform-owned project's draft, and any admin can read anybody's. The whole
 * quiz comes back from one route only, `tasks.quizKey`, which is guarded by
 * ownership and audited the way reading a reference solution is. So a quiz a
 * teacher opens to edit is drawn as a **readout** with an explicit *Show the
 * answers*, and only once that route has answered is there a form at all.
 *
 * That is also why a sealed quiz saves nothing: `UpdateTaskBody.quiz` is the
 * whole quiz replaced, so a save that sent this screen's version of it would
 * replace every explanation with an empty string and every key with none. The
 * task's title, brief and objectives are still the teacher's to change; the
 * quiz is left exactly as it is until they have it in front of them.
 *
 * **Five things the form refuses before the network**, each the editor's own
 * sentence for a row the fast tier would fail:
 *
 *   1. the questions: no questions, an unwritten stem or explanation, an
 *      option with nothing on it, fewer than two options or more than eight,
 *      no option keyed, or every option keyed (`quiz-questions-well-formed`);
 *   2. the draw, a paper the pool cannot fill (`quiz-draw-fits-pool`);
 *   3. the pass mark, a whole number from 0 to 100;
 *   4. the attempts, a whole number from 1 up, or empty for no limit;
 *   5. the retake, a **required** quiz that is the same paper every time, or
 *      can be re-sat for ever (`quiz-retake-is-a-new-paper`).
 *
 * `quiz-pass-mark-reachable` is the one row that **warns** rather than
 * refuses (a mark of 70 on a paper of five is a mark of 80 under another name)
 * so it is a note under the box and never a refusal. The editor says the
 * same thing the report would, before the teacher has to go and read it.
 *
 * **What it deliberately does not ask for.** No timer and no cooldown control:
 * the product's rule is that nothing counts down while a learner reads, and a cooldown
 * a route can carry but no screen sets is a control this codebase refuses by
 * name. A cooldown a quiz already holds is carried back untouched rather than
 * quietly cleared. No artefact path either: a quiz writes no workspace file at
 * all, which is `quiz-owns-no-file` and is why there is nothing to mint.
 *
 * **When the explanations are released** is offered on an
 * **optional** quiz only, as two options: after a pass or the last attempt, or
 * after every attempt. A required quiz ignores the choice at runtime and the
 * route refuses it (`quiz-reveal-optional-only`), so it draws no control and
 * its save never carries the field. Untouched, the control shows the rule the
 * quiz already has and the save sends no field at all.
 */
import { useState } from 'react';
import type {
  AuthoredQuiz,
  AuthoredQuizView,
  QuizQuestion,
  QuizRevealExplanation,
} from '@learnsdlc/shared';
import {
  DEFAULT_QUIZ_CRITERION,
  DEFAULT_QUIZ_PASS_MARK,
  QUIZ_REVEAL_EXPLANATIONS,
  isAuthoredTaskKey,
  pluralWord,
} from '@learnsdlc/shared';
import { Field } from '@/components/Field';
import { Button, Notice } from '@/components/ui';

/** One option as the form holds it: its id, its words, and whether it is an answer. */
interface QuizOptionDraft {
  id: string;
  text: string;
  /** Part of the key. False for every option while the key is sealed. */
  correct: boolean;
}

/** One question as the form holds it. */
interface QuizQuestionDraft {
  /** The id the pack will carry. Empty until a save mints one. */
  id: string;
  stem: string;
  explanation: string;
  concept: string;
  options: QuizOptionDraft[];
  /** How many options the key holds. The only thing a sealed quiz knows about it. */
  answerCount: number;
}

/** A quiz as the form holds it: every number a string, so an input can own it. */
export interface QuizDraft {
  questions: QuizQuestionDraft[];
  /**
   * Whether the key and the explanations are in hand. False on a quiz read
   * back from the draft payload, and the whole reason the panel has two
   * shapes: a save sends the quiz only when this is true.
   */
  keyed: boolean;
  /** Empty draws the whole pool, in order. */
  drawn: string;
  shuffleOptions: boolean;
  passMark: string;
  /** Null while the teacher has not touched the box, when the gate decides it. */
  attemptsMax: string | null;
  /** Carried, never set here: nothing counts down while a learner reads. */
  cooldownSeconds: number | null;
  /**
   * The one rubric key a quiz scores. Pre-filled and fallen back to from
   * `DEFAULT_QUIZ_CRITERION`, which is the contract's, the same constant the
   * route writes when a quiz names none, so the box cannot show one default
   * while the save records another.
   */
  criterion: string;
  /**
   * When an optional quiz releases its explanations, as the teacher chose it.
   * Null while nobody has chosen, when the quiz keeps its current rule and the save
   * sends no field (see `revealShown`).
   */
  revealExplanation: QuizRevealExplanation | null;
}

const OPTION_KEYS = 'abcdefgh';

/**
 * An option id no option in the question already holds.
 *
 * Minted rather than asked for: an option id is what an answer is submitted
 * as, never something a learner reads, so a teacher typing one would be
 * keeping a machine's book for it. The count of options on screen is not an
 * identity (remove the first of three and add another, and a length-minted id
 * is the one a surviving option carries) so this takes the first free key.
 */
function nextOptionId(held: QuizOptionDraft[]): string {
  const taken = new Set(held.map((one) => one.id));
  for (const key of OPTION_KEYS) if (!taken.has(key)) return key;
  let at = 1;
  while (taken.has(`option-${at}`)) at += 1;
  return `option-${at}`;
}

function blankOption(held: QuizOptionDraft[]): QuizOptionDraft {
  return { id: nextOptionId(held), text: '', correct: false };
}

/** A question with the two options a multiple-choice question is at least. */
function blankQuestion(): QuizQuestionDraft {
  const first = blankOption([]);
  return {
    id: '',
    stem: '',
    explanation: '',
    concept: '',
    options: [first, blankOption([first])],
    answerCount: 0,
  };
}

/** The quiz a teacher who has just chosen the type starts from. */
export function blankQuiz(): QuizDraft {
  return {
    questions: [blankQuestion()],
    keyed: true,
    drawn: '',
    shuffleOptions: true,
    passMark: String(DEFAULT_QUIZ_PASS_MARK),
    attemptsMax: null,
    cooldownSeconds: null,
    criterion: DEFAULT_QUIZ_CRITERION,
    revealExplanation: null,
  };
}

/** The quiz as the draft payload shows it: everything but the key. */
export function quizDraftOfView(view: AuthoredQuizView): QuizDraft {
  return {
    questions: view.questions.map((question) => ({
      id: question.id,
      stem: question.stem,
      explanation: '',
      concept: question.concept ?? '',
      options: question.options.map((option) => ({ ...option, correct: false })),
      answerCount: question.answerCount,
    })),
    keyed: false,
    drawn: view.drawn === undefined ? '' : String(view.drawn),
    shuffleOptions: view.shuffleOptions,
    passMark: String(view.passMark),
    attemptsMax: view.attempts.max === null ? '' : String(view.attempts.max),
    cooldownSeconds: view.attempts.cooldownSeconds,
    criterion: view.criterion,
    revealExplanation: view.revealExplanation ?? null,
  };
}

/**
 * The quiz as the audited key route reads it back: the key and all.
 *
 * `held` is the reveal rule the form already has from the view. It is used only
 * when the key payload carries no rule, so a key route that does not echo the
 * field cannot make a re-save erase a stored rule.
 */
export function quizDraftOfKey(
  quiz: AuthoredQuiz,
  held: QuizRevealExplanation | null = null,
): QuizDraft {
  return {
    questions: quiz.questions.map((question) => ({
      id: question.id,
      stem: question.stem,
      explanation: question.explanation,
      concept: question.concept ?? '',
      options: question.options.map((option) => ({
        ...option,
        correct: question.correct.includes(option.id),
      })),
      answerCount: question.correct.length,
    })),
    keyed: true,
    drawn: quiz.drawn === undefined ? '' : String(quiz.drawn),
    shuffleOptions: quiz.shuffleOptions ?? true,
    passMark: String(quiz.passMark ?? DEFAULT_QUIZ_PASS_MARK),
    attemptsMax: quiz.attempts ? (quiz.attempts.max === null ? '' : String(quiz.attempts.max)) : null,
    cooldownSeconds: quiz.attempts?.cooldownSeconds ?? null,
    criterion: quiz.criterion ?? DEFAULT_QUIZ_CRITERION,
    revealExplanation: quiz.revealExplanation ?? held,
  };
}

/**
 * A whole number as the door would read it: the number, `undefined` for an
 * empty box, or null for something that is neither.
 *
 * `Number('two')` is `NaN` and `JSON.stringify` turns `NaN` into `null`, so an
 * unguarded box ends as a pass mark of null on a quiz a learner is graded by.
 */
function readWhole(raw: string): number | null | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}

/**
 * How many attempts the box is showing.
 *
 * Untouched, it follows the gate: `3` on a quiz that gates the phase, because
 * an unlimited re-sit of a gate is a gate that opens on persistence, and no
 * limit at all on one that gates nothing, because a formative quiz a learner
 * can take again is the whole point of a formative quiz. The moment a teacher
 * types in it, it is theirs.
 */
function attemptsShown(draft: QuizDraft, required: boolean): string {
  return draft.attemptsMax ?? (required ? '3' : '');
}

/**
 * The reveal rule a learner of this quiz actually gets.
 *
 * The teacher's choice when there is one. Untouched, it is the rule the
 * runtime applies to an absent field: an optional quiz with no attempt limit
 * is formative and releases at once (`'always'`), and any other waits for a
 * pass or the last attempt (`'on-pass'`). A required quiz ignores the field, as
 * `revealRuleFor` does on the API, so it is always `'on-pass'`.
 */
export function revealShown(draft: QuizDraft, required: boolean): QuizRevealExplanation {
  if (required) return 'on-pass';
  if (draft.revealExplanation) return draft.revealExplanation;
  return readWhole(attemptsShown(draft, false)) === undefined ? 'always' : 'on-pass';
}

/** The two options, each in the words the control and the readout share. */
const QUIZ_REVEAL_LABELS: Record<QuizRevealExplanation, string> = {
  'on-pass': 'After a pass, or when their attempts run out',
  always: 'After every attempt, pass or fail',
};

/**
 * An option's label for this quiz. With no attempt limit a learner's attempts
 * never run out, so `'on-pass'` names the pass alone.
 */
export function revealLabel(
  rule: QuizRevealExplanation,
  draft: QuizDraft,
  required: boolean,
): string {
  if (rule === 'on-pass' && readWhole(attemptsShown(draft, required)) === undefined) {
    return 'After a pass';
  }
  return QUIZ_REVEAL_LABELS[rule];
}

/** When the explanation under a question is released, for the rule in force. */
function explanationNote(draft: QuizDraft, required: boolean): string {
  const never = 'The answer itself never is.';
  if (revealShown(draft, required) === 'always') {
    return `Released after every marked attempt, pass or fail. ${never}`;
  }
  const unlimited = readWhole(attemptsShown(draft, required)) === undefined;
  return unlimited
    ? `Released when they pass. ${never}`
    : `Released when they pass, or when their attempts are spent. ${never}`;
}

/** The base a minted question id is built on: the task's own key. */
function idBase(taskKey: string): string {
  const key = taskKey.trim();
  if (!isAuthoredTaskKey(key)) return 'question';
  return key.slice(0, 28).replace(/-+$/, '') || 'question';
}

/**
 * The body the save sends.
 *
 * A question keeps the id it already has (a learner's answers are recorded
 * against it and it is a graded unit's id) and a new one is minted from the
 * task's key, which is unique within the phase and so keeps two quizzes in one
 * phase from both claiming `q-1`.
 */
export function toAuthoredQuiz(draft: QuizDraft, taskKey: string, required: boolean): AuthoredQuiz {
  const base = idBase(taskKey);
  const taken = new Set(draft.questions.map((one) => one.id).filter(Boolean));
  let at = 1;
  const questions: QuizQuestion[] = draft.questions.map((one) => {
    let id = one.id;
    if (!id) {
      while (taken.has(`${base}-${at}`)) at += 1;
      id = `${base}-${at}`;
      taken.add(id);
    }
    const question: QuizQuestion = {
      id,
      stem: one.stem.trim(),
      options: one.options.map((option) => ({ id: option.id, text: option.text.trim() })),
      correct: one.options.filter((option) => option.correct).map((option) => option.id),
      explanation: one.explanation.trim(),
    };
    if (one.concept.trim()) question.concept = one.concept.trim();
    return question;
  });

  const attempts = readWhole(attemptsShown(draft, required));
  const quiz: AuthoredQuiz = {
    questions,
    shuffleOptions: draft.shuffleOptions,
    passMark: Number(draft.passMark.trim()),
    attempts: {
      max: typeof attempts === 'number' ? attempts : null,
      cooldownSeconds: draft.cooldownSeconds,
    },
    criterion: draft.criterion.trim() || DEFAULT_QUIZ_CRITERION,
  };
  const drawn = readWhole(draft.drawn);
  if (typeof drawn === 'number') quiz.drawn = drawn;
  // Only a chosen rule, and only on an optional quiz: the route refuses the
  // field on a required one, and an untouched rule stays absent so a re-save
  // changes nothing.
  if (!required && draft.revealExplanation) quiz.revealExplanation = draft.revealExplanation;
  return quiz;
}

/* ------------------------------ the refusals ------------------------------ */

export const QUIZ_NEEDS_A_QUESTION =
  'A quiz is the questions it asks, and this one asks none. Write the first question.';

export const QUIZ_PASS_MARK_INVALID =
  'A pass mark is a whole number of percent, from 0 to 100. It is the score a paper has to reach.';

export const QUIZ_ATTEMPTS_INVALID =
  'The number of attempts is a whole number from 1 up. Leave the box empty for no limit at all.';

export function quizDrawRefusal(drawn: string, pool: number): string {
  return `This quiz draws ${drawn} questions from a pool of ${pool}, and a paper cannot ask a question the pool does not hold. Draw between 1 and ${pool}, or leave the box empty to draw the whole pool in order.`;
}

export function quizRetakeRefusal(pool: number, unlimited: boolean): string {
  return unlimited
    ? `This quiz gates the phase and can be re-sat without limit, so a learner passes it by persistence rather than by knowing the answer. Give it a finite number of attempts, or make it optional.`
    : `This quiz gates the phase and draws all ${pool} of its questions every time, so a retake is the same paper twice. Draw fewer questions than the pool holds, or make it optional.`;
}

/** What is wrong with the questions, in one sentence, or null. */
function questionsRefusal(questions: QuizQuestionDraft[]): string | null {
  for (const [at, question] of questions.entries()) {
    const n = at + 1;
    if (!question.stem.trim()) {
      return `Question ${n} has no text, so a learner would be asked nothing. Write the question.`;
    }
    if (!question.explanation.trim()) {
      return `Question ${n} has no explanation, and the explanation is the only thing a learner is given once they are finished with the question. The answer never is, so write it.`;
    }
    if (question.options.length < 2 || question.options.length > 8) {
      return `Question ${n} offers ${question.options.length} ${pluralWord(question.options.length, 'option')}, and a multiple-choice question offers between 2 and 8.`;
    }
    for (const option of question.options) {
      if (!option.text.trim()) {
        return `Question ${n} offers an option with nothing written on it. Write the option, or remove it.`;
      }
    }
    const keyed = question.options.filter((option) => option.correct).length;
    if (keyed === 0) {
      return `Question ${n} marks no option as an answer, so no learner could answer it. Mark at least one.`;
    }
    if (keyed === question.options.length) {
      return `Question ${n} marks every option as an answer, so it asks nothing. Leave at least one option wrong.`;
    }
  }
  return null;
}

/**
 * What the save would be refused for, in the editor's own words, or null.
 *
 * Asked only where the quiz is actually being sent, a sealed quiz is not on
 * this screen to be right or wrong about.
 */
export function quizRefusal(draft: QuizDraft, required: boolean): string | null {
  if (draft.questions.length === 0) return QUIZ_NEEDS_A_QUESTION;

  const shape = questionsRefusal(draft.questions);
  if (shape) return shape;

  const pool = draft.questions.length;
  const drawn = readWhole(draft.drawn);
  if (drawn === null || (typeof drawn === 'number' && (drawn < 1 || drawn > pool))) {
    return quizDrawRefusal(draft.drawn.trim(), pool);
  }

  const mark = readWhole(draft.passMark);
  if (typeof mark !== 'number' || mark > 100) return QUIZ_PASS_MARK_INVALID;

  const attempts = readWhole(attemptsShown(draft, required));
  if (attempts === null || attempts === 0) return QUIZ_ATTEMPTS_INVALID;

  if (required && (attempts === undefined || drawn === undefined || drawn === pool)) {
    return quizRetakeRefusal(pool, attempts === undefined);
  }
  return null;
}

/* ------------------------------- the warning ------------------------------ */

/**
 * The first score at or above the mark, and how many right answers it takes.
 *
 * A twin of `firstPassingScore` in `apps/api/src/authoring/validation.ts`, and
 * a twin on purpose rather than a guess: the arithmetic needs only the size of
 * the paper and the mark, both of which are on this screen, and a teacher who
 * reads *"70% is 80% under another name"* in the report should have read it
 * under the box that says 70.
 */
export function firstPassingScore(
  drawn: number,
  passMark: number,
): { right: number; score: number } | null {
  for (let right = 0; right <= drawn; right += 1) {
    const score = Math.round((100 * right) / drawn);
    if (score >= passMark) return { right, score };
  }
  return null;
}

/** What the pass mark actually means on a paper this size. */
function passMarkNote(draft: QuizDraft): string {
  const pool = draft.questions.length;
  const asked = readWhole(draft.drawn);
  const drawn = typeof asked === 'number' ? asked : pool;
  const mark = readWhole(draft.passMark);
  if (typeof mark !== 'number' || drawn < 1) {
    return 'The score a paper has to reach to pass.';
  }
  const first = firstPassingScore(drawn, mark);
  if (first === null) {
    return `No paper of ${drawn} can reach ${mark}%, so nobody could pass this quiz.`;
  }
  if (first.score === mark) {
    return `A paper of ${drawn} passes at ${first.right} right, which is exactly ${mark}%.`;
  }
  return `A paper of ${drawn} cannot land on ${mark}%. The first passing score is ${first.right} of ${drawn}, which is ${first.score}% — so ${mark}% is ${first.score}% under another name.`;
}

/* ------------------------------- the panel -------------------------------- */

/** One fact of a sealed quiz, read back rather than offered as a box. */
function Line({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="min-w-0">
      <span className="label-sm font-medium">{label}</span>
      <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink2" data-testid={testId}>
        {value}
      </p>
    </div>
  );
}

export function QuizEditor({
  value,
  required,
  editing,
  busy,
  reading,
  answersError,
  onChange,
  onShowAnswers,
}: {
  value: QuizDraft;
  /** Whether this quiz gates the phase, which is what decides the attempts default. */
  required: boolean;
  /** True on a task that already exists, which is the only case with a key to fetch. */
  editing: boolean;
  busy: boolean;
  /** The key route is in flight. */
  reading: boolean;
  /** The key route's refusal, word for word. */
  answersError: string;
  onChange: (next: QuizDraft) => void;
  /** Reads the key back through the audited route. Absent draws no control. */
  onShowAnswers?: () => void;
}) {
  const [said, setSaid] = useState('');

  const pool = value.questions.length;
  const asked = readWhole(value.drawn);
  const drawn = typeof asked === 'number' ? asked : pool;

  const patch = (at: number, one: Partial<QuizQuestionDraft>) => {
    onChange({
      ...value,
      questions: value.questions.map((question, i) => (i === at ? { ...question, ...one } : question)),
    });
  };

  const patchOption = (at: number, of: number, one: Partial<QuizOptionDraft>) => {
    patch(at, {
      options: value.questions[at].options.map((option, i) =>
        i === of ? { ...option, ...one } : option,
      ),
    });
  };

  const move = (at: number, by: -1 | 1) => {
    const to = at + by;
    if (to < 0 || to >= value.questions.length) return;
    const questions = [...value.questions];
    [questions[at], questions[to]] = [questions[to], questions[at]];
    onChange({ ...value, questions });
    setSaid(`Question ${at + 1} moved ${by === -1 ? 'up' : 'down'}. It is now question ${to + 1}.`);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="quiz-editor">
      <h3 className="m-0 text-[13.5px] font-semibold text-ink">Questions</h3>
      <p className="purpose wrap">
        A quiz is scored on its questions and nothing else, with no model asked and no file written.
        The answers and the explanations are sealed the way the hidden tests are: a learner is told
        right or wrong on every attempt, and reads the explanation once they are finished with the
        question.
      </p>

      <p className="sr-only" role="status" aria-live="polite" data-testid="quiz-live">
        {said}
      </p>

      {answersError && (
        <Notice tone="fail" role="alert" testId="quiz-answers-error">
          {answersError}
        </Notice>
      )}

      {!value.keyed && (
        <Notice tone="info" testId="quiz-answers-sealed">
          <span className="block">
            The answers and the explanations are not on this screen, because this project’s draft is
            readable by other instructors and the key is not. Saving now leaves the quiz exactly as
            it is. Show the answers to change a question, and that read is recorded against your
            account the way reading a reference solution is.
          </span>
          {onShowAnswers && (
            <span className="mt-2 flex flex-wrap items-center gap-2.5">
              <Button
                size="sm"
                variant="secondary"
                icon="eye"
                busy={reading}
                busyLabel="Reading…"
                disabled={busy}
                testId="quiz-answers-show"
                onClick={onShowAnswers}
              >
                Show the answers
              </Button>
            </span>
          )}
        </Notice>
      )}

      {value.keyed && editing && (
        <Notice tone="info" testId="quiz-answers-open">
          The answers are on this screen, and that read is on this project’s audit trail.
        </Notice>
      )}

      {value.questions.map((question, at) => (
        <fieldset
          key={question.id || `new-${at}`}
          className="m-0 flex min-w-0 flex-col gap-2.5 rounded-ctl border-1.5 border-edge px-3 py-3"
          data-testid={`quiz-question-${at}`}
        >
          <legend className="label-sm px-1">Question {at + 1}</legend>

          {value.keyed ? (
            <>
              <div className="min-w-0">
                <label
                  htmlFor={`quiz-question-stem-${at}`}
                  className="block text-[13px] font-medium text-ink"
                >
                  What the learner is asked
                </label>
                <textarea
                  id={`quiz-question-stem-${at}`}
                  className="field mt-1.5 min-h-[72px]"
                  data-testid={`quiz-question-stem-${at}`}
                  value={question.stem}
                  onChange={(e) => patch(at, { stem: e.target.value })}
                />
              </div>

              <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
                <legend className="label-sm">Options, and which of them are answers</legend>
                {question.options.map((option, of) => (
                  <div key={option.id} className="flex min-w-0 items-start gap-2.5">
                    <label
                      className="flex shrink-0 items-center gap-1.5 pt-2"
                      htmlFor={`quiz-option-correct-${at}-${of}`}
                    >
                      <input
                        id={`quiz-option-correct-${at}-${of}`}
                        type="checkbox"
                        data-testid={`quiz-option-correct-${at}-${of}`}
                        checked={option.correct}
                        onChange={(e) => patchOption(at, of, { correct: e.target.checked })}
                      />
                      {/* The option's own letter, so the box a teacher ticks
                          has a name of its own rather than being the third
                          "Answer" in the question. */}
                      <span className="text-[12.5px] text-ink">Answer {option.id}</span>
                    </label>
                    <span className="min-w-0 flex-1">
                      <Field
                        id={`quiz-option-${at}-${of}`}
                        label={`Option ${option.id}`}
                        value={option.text}
                        data-testid={`quiz-option-${at}-${of}`}
                        onChange={(e) => patchOption(at, of, { text: e.target.value })}
                      />
                    </span>
                    {question.options.length > 2 && (
                      <span className="shrink-0 pt-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          ariaLabel={`Remove option ${option.id} from question ${at + 1}`}
                          testId={`quiz-option-remove-${at}-${of}`}
                          onClick={() =>
                            patch(at, { options: question.options.filter((_, i) => i !== of) })
                          }
                        >
                          Remove
                        </Button>
                      </span>
                    )}
                  </div>
                ))}
                {question.options.length < 8 && (
                  <div>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="plus"
                      testId={`quiz-option-add-${at}`}
                      onClick={() =>
                        patch(at, { options: [...question.options, blankOption(question.options)] })
                      }
                    >
                      Add an option
                    </Button>
                  </div>
                )}
              </fieldset>

              <div className="min-w-0">
                <label
                  htmlFor={`quiz-question-explanation-${at}`}
                  className="block text-[13px] font-medium text-ink"
                >
                  What a learner reads once they are finished with it
                </label>
                <textarea
                  id={`quiz-question-explanation-${at}`}
                  className="field mt-1.5 min-h-[72px]"
                  data-testid={`quiz-question-explanation-${at}`}
                  value={question.explanation}
                  onChange={(e) => patch(at, { explanation: e.target.value })}
                />
                <p
                  className="mt-1.5 text-[12.5px] leading-relaxed text-muted"
                  data-testid={`quiz-explanation-note-${at}`}
                >
                  {explanationNote(value, required)}
                </p>
              </div>

              <Field
                id={`quiz-question-concept-${at}`}
                label="What it tests"
                hint="Your own words, read beside the explanation. Optional."
                value={question.concept}
                data-testid={`quiz-question-concept-${at}`}
                onChange={(e) => patch(at, { concept: e.target.value })}
              />
            </>
          ) : (
            <>
              <p className="text-[13px] leading-relaxed text-ink" data-testid={`quiz-stem-${at}`}>
                {question.stem}
              </p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {question.options.map((option) => (
                  <li key={option.id} className="min-w-0 text-[12.5px] text-ink2">
                    <span className="mono text-muted">{option.id}</span> {option.text}
                  </li>
                ))}
              </ul>
              <p className="label-sm" data-testid={`quiz-answer-count-${at}`}>
                {question.answerCount === 1
                  ? `1 of these ${question.options.length} options is the answer.`
                  : `${question.answerCount} of these ${question.options.length} options are the answer.`}
              </p>
              {question.concept && (
                <p className="label-sm" data-testid={`quiz-concept-${at}`}>
                  {`It tests ${question.concept}.`}
                </p>
              )}
            </>
          )}

          {value.keyed && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                icon="arrow-up"
                disabled={at === 0}
                reason={at === 0 ? 'This question is already first.' : undefined}
                ariaLabel={`Move question ${at + 1} up`}
                testId={`quiz-question-up-${at}`}
                onClick={() => move(at, -1)}
              >
                Move up
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="arrow-down"
                disabled={at === value.questions.length - 1}
                reason={at === value.questions.length - 1 ? 'This question is already last.' : undefined}
                ariaLabel={`Move question ${at + 1} down`}
                testId={`quiz-question-down-${at}`}
                onClick={() => move(at, 1)}
              >
                Move down
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                ariaLabel={`Remove question ${at + 1}`}
                testId={`quiz-question-remove-${at}`}
                onClick={() => {
                  onChange({ ...value, questions: value.questions.filter((_, i) => i !== at) });
                  setSaid(`Question ${at + 1} was removed. ${value.questions.length - 1} left.`);
                }}
              >
                Remove this question
              </Button>
            </div>
          )}
        </fieldset>
      ))}

      {value.keyed && (
        <div>
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            testId="quiz-question-add"
            onClick={() => onChange({ ...value, questions: [...value.questions, blankQuestion()] })}
          >
            Add a question
          </Button>
        </div>
      )}

      <div className="min-w-0 rounded-ctl border-1.5 border-edge px-3 py-3" data-testid="quiz-settings">
        {value.keyed ? (
          <div className="flex min-w-0 flex-col gap-3">
            <Field
              id="quiz-pass-mark"
              label="Pass mark"
              hint="Percent. A required quiz below it leaves the phase shut."
              inputMode="numeric"
              value={value.passMark}
              data-testid="quiz-pass-mark"
              onChange={(e) => onChange({ ...value, passMark: e.target.value })}
            />
            <p className="text-[12.5px] leading-relaxed text-muted" data-testid="quiz-pass-mark-note">
              {passMarkNote(value)}
            </p>
            <Field
              id="quiz-drawn"
              label="Questions a paper draws"
              hint={`Out of ${pool} written. Leave it empty to ask all of them, in order.`}
              inputMode="numeric"
              value={value.drawn}
              data-testid="quiz-drawn"
              onChange={(e) => onChange({ ...value, drawn: e.target.value })}
            />
            <Field
              id="quiz-attempts"
              label="Attempts"
              hint="Leave it empty for no limit. A quiz that gates the phase needs one, so that a retake is a different paper rather than the same one again."
              inputMode="numeric"
              value={attemptsShown(value, required)}
              data-testid="quiz-attempts"
              onChange={(e) => onChange({ ...value, attemptsMax: e.target.value })}
            />
            <label className="flex items-start gap-2.5" htmlFor="quiz-shuffle">
              <input
                id="quiz-shuffle"
                type="checkbox"
                className="mt-0.5"
                data-testid="quiz-shuffle"
                checked={value.shuffleOptions}
                onChange={(e) => onChange({ ...value, shuffleOptions: e.target.checked })}
              />
              <span className="min-w-0 text-[13px] text-ink">
                Shuffle the options. An answer is submitted as an option id, so the order a learner
                sees changes nothing about the score.
              </span>
            </label>
            {!required && (
              <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" data-testid="quiz-reveal">
                <legend className="text-[13px] font-medium text-ink">
                  When a learner reads the explanations
                </legend>
                {QUIZ_REVEAL_EXPLANATIONS.map((rule) => (
                  <div key={rule} className="flex items-start gap-2.5">
                    <input
                      id={`quiz-reveal-${rule}`}
                      type="radio"
                      name="quiz-reveal"
                      className="mt-0.5"
                      data-testid={`quiz-reveal-${rule}`}
                      checked={revealShown(value, required) === rule}
                      onChange={() => onChange({ ...value, revealExplanation: rule })}
                      // A click on the option already shown fires no change,
                      // but it is still the teacher's choice: record it, so a
                      // later change to the attempts cannot move it.
                      onClick={() => {
                        if (value.revealExplanation !== rule) {
                          onChange({ ...value, revealExplanation: rule });
                        }
                      }}
                    />
                    <label htmlFor={`quiz-reveal-${rule}`} className="min-w-0 text-[13px] text-ink">
                      {revealLabel(rule, value, required)}
                    </label>
                  </div>
                ))}
                <p className="text-[12.5px] leading-relaxed text-muted" data-testid="quiz-reveal-note">
                  Offered on a quiz that gates nothing. A required quiz always waits for a pass or the
                  last attempt.
                </p>
              </fieldset>
            )}
            <Field
              id="quiz-criterion"
              label="The criterion it scores"
              hint="One key, printed on a learner’s report. The quiz scores this and nothing else."
              value={value.criterion}
              data-testid="quiz-criterion"
              onChange={(e) => onChange({ ...value, criterion: e.target.value })}
            />
            <p className="text-[12.5px] leading-relaxed text-muted" data-testid="quiz-rubric-note">
              {`A quiz scores one criterion, keyed “${value.criterion.trim() || DEFAULT_QUIZ_CRITERION}”, and carries the whole mark. There is nothing here to make add up.`}
            </p>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-2.5">
            <Line
              label="Pass mark"
              value={`${value.passMark}%`}
              testId="quiz-pass-mark-readout"
            />
            <Line
              label="Questions a paper draws"
              value={
                value.drawn
                  ? `${value.drawn} of the ${pool} written.`
                  : `All ${pool} of them, in order.`
              }
              testId="quiz-drawn-readout"
            />
            <Line
              label="Attempts"
              value={value.attemptsMax === '' ? 'No limit.' : `${value.attemptsMax} allowed.`}
              testId="quiz-attempts-readout"
            />
            <Line
              label="The criterion it scores"
              value={value.criterion}
              testId="quiz-criterion-readout"
            />
            {!required && (
              <Line
                label="When a learner reads the explanations"
                value={`${revealLabel(revealShown(value, required), value, required)}.`}
                testId="quiz-reveal-readout"
              />
            )}
          </div>
        )}
      </div>

      {value.keyed && drawn >= 1 && (
        <p className="label-sm" data-testid="quiz-summary">
          {`${pool} ${pluralWord(pool, 'question')} written, ${drawn} asked of each learner.`}
        </p>
      )}
    </div>
  );
}
