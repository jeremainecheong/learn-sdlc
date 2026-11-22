import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  DEFAULT_QUIZ_CRITERION,
  DEFAULT_QUIZ_PASS_MARK,
  INHERITED_TASK_KEY,
  QUIZ_REVEAL_EXPLANATIONS,
  TASK_BRIEF_MAX,
  TASK_OBJECTIVES_MAX,
  TASK_OBJECTIVE_MAX,
  TASK_TITLE_MAX,
  plainTextOf,
  type AuthoredQuiz,
  type PhaseRubric,
  type QuizChecks,
  type QuizQuestion,
  isObject,
} from '@learnsdlc/shared';
import type { ProjectTaskEntity } from '../content/project.entities';
import { plainPath } from '../content/secret-paths';
import { overCapRefusal, plainOrRefuse, requirePlainText } from './draft';
import { quizRevealOptionalOnlyRefusal } from './validation';

/**
 * A concept quiz as a task row, from the editor's quiz door and from an
 * uploaded archive's `quizzes/<task key>.json` alike: one set of
 * refusals, so a quiz file reaches the archive with the editor's own
 * sentences.
 *
 * `checkedQuiz` is the editor's check, shared by both doors, and `echo` is
 * its one difference: every value the archive chose that a sentence prints
 * goes through it. The editor passes the identity, so its sentences print the
 * value whole; the upload door passes `clipEcho`, so no
 * refusal carries more than 48 characters of a value or an unsafe byte, and
 * `UPLOAD_REFUSAL_DETAIL_MAX` still bounds the whole detail.
 *
 * Pure: no database, no clock.
 */

/** A rubric criterion key, and a rule id: lower case, opening on a letter. */
export const CRITERION_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;

/**
 * What the editor writes for `attempts` when the teacher names nothing.
 *
 * A **required** quiz is created with a finite limit, because an unlimited
 * re-sit of a fixed paper is a gate that opens on persistence rather than on
 * understanding, which is what `quiz-retake-is-a-new-paper` refuses at
 * publish. An optional one is free to be either, and unlimited is the kinder
 * default for formative work.
 */
export const defaultQuizAttempts = (required: boolean): QuizChecks['attempts'] =>
  required ? { max: 3, cooldownSeconds: null } : { max: null, cooldownSeconds: null };

const identity = (value: string): string => value;

/** A value an archive chose, as a refusal prints it: `plainPath`'s rule over its first 48 characters. */
export function clipEcho(value: string): string {
  return plainPath(String(value).slice(0, 48));
}

/** `artefactType: 'quiz'` with no questions: the type is right, the body is empty. */
export function quizNeedsQuestionsRefusal(): string {
  return (
    'A quiz task is scored by the questions you write, and this one carries none. Send the quiz with the task, ' +
    'because a quiz with no paper is a task a learner opens on nothing.'
  );
}

/**
 * The quiz a teacher wrote, as the slice that will score it.
 *
 * Four things are checked here and nothing else is, and the line between
 * them is which reader a wrong answer would reach. The **questions** (how
 * many, how many options, duplicate ids, a key that is not an option, every
 * option keyed) are the fast tier's four rows and the compiler's, which is
 * where a teacher reads them beside the rest of their draft; re-asking them
 * here would be a second wording for one refusal. What the fast tier cannot
 * catch is a field that is not a *number a report can read*: a `passMark` of
 * 500 only **warns** through `quiz-pass-mark-reachable`, so a required quiz
 * would publish with a bar nobody can clear; an `attempts.max` of 0 is a
 * gate with no attempts at all; and a `criterion` that is not a rubric key
 * is a criterion `assembleCriteria` scores as a flat zero.
 *
 * `title` is the task's, for the one refusal that names it
 * (`quiz-reveal-optional-only`); `echo` prints every value the sentences
 * carry (the identity in the editor, `clipEcho` at the upload door).
 */
export function checkedQuiz(
  quiz: AuthoredQuiz,
  required: boolean,
  title = 'This quiz',
  echo: (value: string) => string = identity,
): QuizChecks {
  const criterion = String(quiz.criterion ?? DEFAULT_QUIZ_CRITERION).trim();
  if (!CRITERION_PATTERN.test(criterion)) {
    throw new BadRequestException(
      `"${echo(criterion)}" is not a criterion name this can store. A criterion is lower case, opens on a letter and ` +
        "is at most 48 characters, because it is the one key a quiz's report writes its score under.",
    );
  }

  const passMark = quiz.passMark ?? DEFAULT_QUIZ_PASS_MARK;
  if (!Number.isInteger(passMark) || passMark < 0 || passMark > 100) {
    throw new BadRequestException(
      `A pass mark is a whole percentage from 0 to 100, and this one is ${echo(String(passMark))}. A mark above 100 is a gate ` +
        'no paper can clear.',
    );
  }

  const attempts = quiz.attempts ?? defaultQuizAttempts(required);
  // An absent field is `null` here rather than a refusal about `undefined`,
  // because `null` is what this contract already calls *no limit* and *no
  // cooldown*. The DTO defaults both, so an HTTP body never reaches this
  // line short of one; a service-level caller that builds an `AuthoredQuiz`
  // by hand (and a quiz file) is the case this coalesce is for.
  const max = attempts.max ?? null;
  if (max !== null && (!Number.isInteger(max) || max < 1)) {
    throw new BadRequestException(
      `A quiz allows at least one attempt, or no limit at all, and this one allows ${echo(String(max))}. Leave the limit ` +
        'empty for an unlimited quiz.',
    );
  }
  const cooldownSeconds = attempts.cooldownSeconds ?? null;
  if (cooldownSeconds !== null && (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0)) {
    throw new BadRequestException(
      `A cooldown is a whole number of seconds, or none at all, and this one is ${echo(String(cooldownSeconds))}.`,
    );
  }

  const checks: QuizChecks = {
    kind: 'quiz',
    // Cloned, and the teacher's own text stored plain: each
    // stem, option text, explanation and concept label through `plainTextOf`
    // (`plainQuestion`), after every refusal above, so a refusal names what
    // was sent; an option or a concept that converts to nothing is refused in
    // its own sentence. Ids and the key are as sent. What is well formed about
    // them is the fast tier's four rows.
    questions: clone(quiz.questions ?? []).map(plainQuestion),
    shuffleOptions: quiz.shuffleOptions ?? true,
    passMark,
    attempts: { max, cooldownSeconds },
    criterion,
  };
  // Absent draws the whole pool in order, which is a different fact from
  // drawing all of it: `quiz-retake-is-a-new-paper` reads both.
  if (quiz.drawn !== undefined) checks.drawn = quiz.drawn;
  // When an optional quiz releases its
  // explanations. Written only when chosen, so an absent choice leaves the
  // row, the compiled snapshot and its digest exactly as they were (no
  // `COMPILER_IDENTITY` change). A required quiz is refused by name: the
  // runtime would ignore the field on one (`revealRuleFor`), and a choice
  // that does nothing is a teacher who thinks it does something.
  if (quiz.revealExplanation !== undefined) {
    const reveal: unknown = quiz.revealExplanation;
    if (!(QUIZ_REVEAL_EXPLANATIONS as readonly unknown[]).includes(reveal)) {
      throw new BadRequestException(
        `"${echo(String(reveal).slice(0, 48))}" is not a reveal this can store: a practice quiz shows its explanations ` +
          'after a pass or when the attempts run out, or after every attempt.',
      );
    }
    if (required) throw new BadRequestException(quizRevealOptionalOnlyRefusal(echo(title)));
    checks.revealExplanation = quiz.revealExplanation;
  }
  return checks;
}

/**
 * A quiz task's rubric: one criterion, the quiz's own, at the quiz's pass mark.
 *
 * **`passThreshold` is the quiz's own `passMark`**, and that is a choice. The
 * two numbers answer the same question (*what does this task have to score*)
 * and `quizPassed(overall, passMark)` is what actually decides the pass, so a
 * rubric carrying `DEFAULT_PASS_THRESHOLD` beside a paper passed at 60 would
 * put two gates on one screen and only one of them would be true. It is also
 * the score a countersignature writes (`instructor.service.ts`'s
 * `Math.max(bestScore ?? 0, task.rubric.passThreshold)`), which should be the
 * mark the quiz is passed at rather than a number from another kind of task.
 *
 * The description is in the learner's voice: the rubric
 * is stored on the task row and compiled straight into the pack, and the pack's
 * rubric is what a learner's report prints.
 */
export function quizRubricFor(checks: QuizChecks): PhaseRubric {
  return {
    passThreshold: checks.passMark,
    criteria: [
      {
        key: checks.criterion,
        title: criterionTitle(checks.criterion),
        weight: 1,
        description: 'Scored by the quiz your teacher set.',
      },
    ],
  };
}

/** A criterion key as a heading: `design-concepts` reads *Design concepts*. */
function criterionTitle(key: string): string {
  const words = key.replace(/[-_]+/g, ' ').trim();
  return words.length === 0 ? key : words[0].toUpperCase() + words.slice(1);
}

/**
 * The editor's sentences for a quiz option's text and a concept label the
 * conversion leaves blank. The upload door (`plainSource`) refuses
 * the same blank results in these same constants, so the two cannot drift.
 */
export const QUIZ_OPTION_BLANK = 'A quiz option cannot be empty.';
export const CONCEPT_BLANK = 'A concept label cannot be empty.';

/**
 * A quiz question with its stem, each option's text, its explanation and its
 * concept label stored plain (every text member). An option's
 * text or a concept label the conversion turns blank is refused in its own
 * empty sentence (`plainOrRefuse`); a stem or an explanation left blank meets
 * the fast tier's own sentence for it. At the upload door `plainSource` has
 * already refused these in the same sentences and left a blank stem or
 * explanation to the quiz wall.
 */
export function plainQuestion(question: QuizQuestion): QuizQuestion {
  return {
    ...question,
    stem: plainTextOf(question.stem),
    options: question.options.map((option) => ({ ...option, text: plainOrRefuse(option.text, QUIZ_OPTION_BLANK) })),
    explanation: plainTextOf(question.explanation),
    ...(typeof question.concept === 'string' ? { concept: plainOrRefuse(question.concept, CONCEPT_BLANK) } : {}),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/* ------------------------------ a quiz file's row ------------------------------ */

/** A quiz file's body: what `quizzes/<task key>.json` holds. */
export interface QuizFileBody {
  title: string;
  brief: string;
  order: number;
  objectives: string[];
  required: boolean;
  checks: unknown;
}

/** The members a quiz file may hold, as an export writes them. */
export const QUIZ_FILE_MEMBERS = ['title', 'brief', 'order', 'objectives', 'required', 'checks'] as const;

const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isText = (value: unknown, min: number, max: number): boolean => typeof value === 'string' && value.length >= min && value.length <= max;

/**
 * The editor's outer wall (`AddTaskDto`, `AuthoredQuizDto`, `QuizQuestionDto`,
 * `QuizOptionDto` in `authoring.dto.ts`) over a quiz file, which no DTO
 * reads: its members, their types and the DTO's caps, each refusal naming the
 * member and never its value. A refusal is a `BadRequestException` whose
 * message the door files as "<path> is not a quiz: <message>".
 */
export function quizFileBody(raw: unknown): QuizFileBody {
  const refuse = (sentence: string): never => {
    throw new BadRequestException(sentence);
  };
  if (!isObject(raw)) refuse('A quiz file holds one JSON object: its title, brief, order, objectives, required and checks.');
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).filter((one) => !(QUIZ_FILE_MEMBERS as readonly string[]).includes(one));
  if (unknown.length) {
    refuse(`It holds ${unknown.length === 1 ? 'a member' : `${unknown.length} members`} a quiz file does not have; a quiz file holds only title, brief, order, objectives, required and checks.`);
  }
  if (body.title !== undefined && typeof body.title !== 'string') refuse('Its title must be text.');
  if (body.brief !== undefined && typeof body.brief !== 'string') refuse('Its brief must be text.');
  if (!Number.isInteger(body.order) || (body.order as number) < 1) refuse('Its order must be a whole number from 1: its place among the phase\'s tasks.');
  if (body.objectives !== undefined) {
    const list = body.objectives;
    if (!Array.isArray(list) || list.some((one) => typeof one !== 'string')) refuse('Its objectives must be a list of text.');
    if ((list as string[]).length > TASK_OBJECTIVES_MAX) refuse(`It holds ${(list as string[]).length} objectives, and a task holds at most ${TASK_OBJECTIVES_MAX} objectives.`);
    const long = (list as string[]).find((one) => one.length > TASK_OBJECTIVE_MAX);
    if (long !== undefined) refuse(overCapRefusal('objective', TASK_OBJECTIVE_MAX, long.length));
  }
  if (body.required !== undefined && typeof body.required !== 'boolean') refuse('Its required must be true or false.');
  return {
    title: (body.title as string | undefined) ?? '',
    brief: (body.brief as string | undefined) ?? '',
    order: body.order as number,
    objectives: [...((body.objectives as string[] | undefined) ?? [])],
    required: body.required !== false,
    checks: body.checks,
  };
}

/** The quiz DTO's wall over a quiz file's `checks`, before `checkedQuiz` reads it. */
function authoredQuizOf(checks: unknown): AuthoredQuiz {
  const refuse = (sentence: string): never => {
    throw new BadRequestException(sentence);
  };
  if (!isObject(checks) || !Array.isArray(checks.questions) || checks.questions.length === 0) refuse(quizNeedsQuestionsRefusal());
  const quiz = checks as Record<string, unknown>;
  if (has(quiz, 'kind') && quiz.kind !== 'quiz') refuse('Its checks are a quiz\'s, so their kind is quiz.');
  const questions = quiz.questions as unknown[];
  if (questions.length > 200) refuse(`It holds ${questions.length} questions, and a quiz holds at most 200.`);
  questions.forEach((question, i) => {
    const at = `Question ${i + 1}`;
    if (!isObject(question)) refuse(`${at} must be an object holding its id, stem, options, correct and explanation.`);
    const q = question as Record<string, unknown>;
    if (!isText(q.id, 1, 32)) refuse(`${at}'s id must be text of 1 to 32 characters.`);
    if (!isText(q.stem, 1, 4000)) refuse(`${at}'s stem must be text of 1 to 4000 characters.`);
    if (!Array.isArray(q.options) || q.options.length > 8) refuse(`${at}'s options must be a list of at most 8 options.`);
    for (const option of q.options as unknown[]) {
      if (!isObject(option) || !isText(option.id, 1, 48) || !isText(option.text, 1, 2000)) {
        refuse(`${at}'s options must each hold an id of 1 to 48 characters and a text of 1 to 2000 characters.`);
      }
    }
    const correct = q.correct;
    if (!Array.isArray(correct) || correct.length > 8 || correct.some((one) => !isText(one, 0, 48)) || new Set(correct).size !== correct.length) {
      refuse(`${at}'s correct must be a list of at most 8 different option ids.`);
    }
    if (!isText(q.explanation, 1, 4000)) refuse(`${at}'s explanation must be text of 1 to 4000 characters.`);
    if (q.concept !== undefined && !isText(q.concept, 0, 200)) refuse(`${at}'s concept must be text of at most 200 characters.`);
  });
  if (quiz.drawn !== undefined && (!Number.isInteger(quiz.drawn) || (quiz.drawn as number) < 1 || (quiz.drawn as number) > 200)) {
    refuse('Its drawn must be a whole number from 1 to 200.');
  }
  if (quiz.shuffleOptions !== undefined && typeof quiz.shuffleOptions !== 'boolean') refuse('Its shuffleOptions must be true or false.');
  if (quiz.passMark !== undefined && typeof quiz.passMark !== 'number') refuse('Its passMark must be a number.');
  if (quiz.attempts !== undefined) {
    const attempts = quiz.attempts;
    if (!isObject(attempts)) refuse('Its attempts must be an object holding max and cooldownSeconds.');
    const { max, cooldownSeconds } = attempts as Record<string, unknown>;
    if (max !== undefined && max !== null && typeof max !== 'number') refuse('Its attempts.max must be a number, or null for no limit.');
    if (cooldownSeconds !== undefined && cooldownSeconds !== null && typeof cooldownSeconds !== 'number') {
      refuse('Its attempts.cooldownSeconds must be a number, or null for none.');
    }
  }
  if (quiz.criterion !== undefined && typeof quiz.criterion !== 'string') refuse('Its criterion must be text.');
  const { kind: _kind, ...authored } = quiz;
  return authored as unknown as AuthoredQuiz;
}

/** A quiz task's row, as the importer writes it beside its phase's work task. */
export type QuizRowInput = Omit<ProjectTaskEntity, 'id' | 'projectPhaseId'>;

/**
 * A quiz file as the editor's quiz door writes it (`AuthoringService.addTask`'s
 * quiz arm): the inherited key refused, the paper required, `checkedQuiz`'s
 * checks with the task key as the title it names (at most 32 characters),
 * then the title and brief stored plain under their caps (`requirePlainText`),
 * the objectives plain. `order` is the file's, its place among the phase's
 * tasks; the importer sequences and renumbers the phase.
 */
export function quizTaskRow(body: QuizFileBody, taskKey: string, echo: (value: string) => string = identity): QuizRowInput {
  if (taskKey === INHERITED_TASK_KEY) {
    throw new ConflictException(
      `"${INHERITED_TASK_KEY}" is the key the task you inherited already holds, so a new task cannot take it. ` +
        'Give this one a key of its own.',
    );
  }
  const checks = checkedQuiz(authoredQuizOf(body.checks), body.required, taskKey, echo);
  const title = requirePlainText(body.title, 'title', TASK_TITLE_MAX);
  const brief = requirePlainText(body.brief, 'brief', TASK_BRIEF_MAX);
  return {
    taskKey,
    order: body.order,
    required: body.required,
    signOff: false,
    artefactType: 'quiz',
    // `quiz-owns-no-file`: no path, so the phase's work task keeps every
    // editable file the phase mounts.
    artefactPath: null,
    title,
    brief,
    objectives: body.objectives.map(plainTextOf),
    primaryPath: null,
    anchor: null,
    rubric: quizRubricFor(checks),
    checks,
  } as QuizRowInput;
}
