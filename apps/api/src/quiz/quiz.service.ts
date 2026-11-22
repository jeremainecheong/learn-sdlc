import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import type { QuizChecks, SubmissionView } from '@learnsdlc/shared';
import type { PhaseContent } from '../content/content.types';
import { ContentService } from '../content/content.service';
import { checksOf, isQuizTask, type CompiledTask } from '../content/pack-compiler';
import { olderFormatRoomSentence } from '../content/phase-grading';
import { InjectRepository } from '../db/inject';
import {
  QuizAttemptEntity,
  SubmissionEntity,
  TaskStateEntity,
  type PhaseStateEntity,
} from '../db/entities';
import { FeedbackService } from '../feedback/feedback.service';
import { taskForRequest } from '../feedback/task-resolution';
import { paperPercent, QUIZ_PAPER_REFUSAL, scorePaper } from '../feedback/quiz-scoring';
import { quizPassed } from '../feedback/strict-evidence';
import { WorkflowService } from '../workflow/workflow.service';
import { taskHasStrictEvidence } from '../workflow/strict-gate';
import { soleTaskList } from '../content/task-units';
import { learnerText } from '../workflow/learner-text';
import {
  attemptEpochOf,
  optionToken,
  QuizAttemptsService,
  sheetInTokens,
} from './quiz-attempts.service';
import type { QuizOpenPaper, QuizRoomView } from './quiz.dto';
// The before/after concept checks, virtual quiz tasks.
import {
  CONCEPT_AFTER,
  CONCEPT_BANK_VERSION,
  CONCEPT_BEFORE,
  CONCEPT_EPOCH,
  conceptChecks,
  conceptClosedRefusal,
  conceptLockedRefusal,
  conceptScorePct,
  conceptSlotStatus,
  conceptSubmissionView,
  conceptTakenRefusal,
  conceptTask,
  isConceptTaskKey,
  noConceptCheckRefusal,
  type ConceptQuizzesView,
  type ConceptSlot,
  type ConceptTaskKey,
} from './concept/concept';

/* ----------------------------- the refusals ------------------------------- */

/**
 * A task that is not a quiz, asked for its paper.
 *
 * 404 rather than 400, and in `unknownTask`'s own register: the three routes
 * below are the quiz's, and a task with no quiz has no paper to open, no
 * attempts to draw and no sheet to hand in. It is raised **here**, above
 * everything else, so that all three doors give one answer: `submit` would
 * otherwise answer the hand-in with `notAQuizRefusal`'s different sentence
 * while the other two answered with this one.
 */
export function notAQuizRoomRefusal(task: CompiledTask): NotFoundException {
  return new NotFoundException(`"${task.title}" is not a quiz, so it has no paper to open.`);
}

/**
 * The teacher's limit, spent.
 *
 * Counted on **closed** rows, so what this sentence names is the number of
 * papers actually handed in: an abandoned paper costs nothing and a replayed
 * one costs nothing. The title is named because a phase can hold more than
 * one quiz.
 */
export function attemptsSpentRefusal(task: CompiledTask, max: number): BadRequestException {
  return new BadRequestException(
    `You have handed in all ${max} ${max === 1 ? 'attempt' : 'attempts'} at "${task.title}".`,
  );
}

/** The teacher's cooldown, still running. See `cooldownLeft` for what it is. */
export function cooldownRefusal(task: CompiledTask, seconds: number): BadRequestException {
  return new BadRequestException(
    `The next attempt at "${task.title}" opens in ${seconds} seconds.`,
  );
}

/**
 * A paper drawn against a version this enrolment is no longer pinned to.
 *
 * A published version is immutable, so a paper can only go stale across a
 * **re-pin**, and then its questions, its options and its key are all another
 * version's. Refused by name rather than scored against a guess, and refused
 * before the sheet is written, so the row is left exactly as it was drawn.
 *
 * It deliberately tells the learner nothing to do: a re-pin leaves the open
 * paper where it is, and an instruction that would not work is worse than
 * none. Reopening it is a teacher's action, and no route offers it.
 */
export function stalePaperRefusal(task: CompiledTask): BadRequestException {
  return new BadRequestException(
    `"${task.title}" has changed since this paper was drawn, so it cannot be marked against it.`,
  );
}

/**
 * A quiz on an enrolment with no published version to pin a paper to.
 *
 * `quiz_attempts.projectVersionId` is NOT NULL with no default because the pin
 * is the whole of *"which key was this scored against"*. An enrolment resolves
 * a null version id only where the deployment holds no `project_versions` rows
 * at all (a content directory walked from disk) and a quiz reaching that
 * path is a data fault rather than a case to serve. Refused, rather than
 * pinned to an empty string that would compare equal to the next fault's.
 */
export function unpinnedQuizRefusal(task: CompiledTask): BadRequestException {
  return new BadRequestException(
    `"${task.title}" cannot be started: this enrolment is not on a published version of the project.`,
  );
}

/**
 * A new paper asked for while the last one is still being marked.
 *
 * **This is a correctness refusal and not politeness.** The grader scores *the
 * newest handed-in row* for the task, and `submit` refuses an attempt id that
 * is not that row: the two agree at hand-in. What they cannot agree about is
 * a paper drawn and handed in while the previous paper's verdict is still
 * queued: `inFlightFor` would answer the second hand-in with the first paper's
 * in-flight revision, the second paper would now be the newest closed row, and
 * the first paper's job would score the second paper's sheet. One sheet, two
 * papers, one verdict, and nothing anywhere would have refused.
 *
 * `UQ_quiz_attempts_open` cannot hold this line: it constrains nothing once a
 * row is closed, which is exactly the state a paper waiting for its verdict is
 * in. So it is refused here, where the second paper would be drawn, rather
 * than at the hand-in, where the first paper's counter has already been spent.
 */
export function stillMarkingRefusal(task: CompiledTask): BadRequestException {
  return new BadRequestException(
    `Your last attempt at "${task.title}" is still being marked. The result arrives on its own; ` +
      'a new paper opens once it has.',
  );
}

/**
 * A sheet that is not an answer to the paper that was drawn.
 *
 * **One sentence for four facts**: an unknown question id, an unknown
 * option id, a duplicate selection, and a value that is not a list of option
 * ids. It names neither the question nor the key, so an error message is not an
 * oracle a caller can probe a paper with: the same rule
 * `QUIZ_PAPER_REFUSAL` follows for the four ways an attempt id can be wrong.
 */
export const QUIZ_SHEET_REFUSAL =
  'This answer sheet does not match the paper that was drawn. Open the quiz again and answer the paper that is there.';

/* ---------------------------- the derivations ----------------------------- */

/**
 * The quiz slice that scores this task, or null when the task is not a quiz.
 *
 * `isQuizTask` is the one predicate: asked of the kind that **scores**
 * the task rather than of the artefact type, and the narrow below is its type
 * consequence rather than a second copy of it. The two can only disagree on a
 * snapshot whose `checkKind` and whose slice were written by different hands,
 * and *"not a quiz"* is the safe answer to that: no paper is drawn and nothing
 * is scored.
 */
export function quizChecksFor(phase: PhaseContent, task: CompiledTask): QuizChecks | null {
  if (!isQuizTask(task)) return null;
  const slice = checksOf(phase, task);
  return slice.kind === 'quiz' ? slice : null;
}

/**
 * The paper, as the learner reads it: `{ id, stem, options: [{ id, text }],
 * multiple }` and nothing else, where an option's `id` is **this paper's
 * token** for it (`optionToken`), never the id the teacher wrote.
 *
 * **This is the only reader of `QuizQuestion` on any learner route**, and the
 * seal is the shape rather than a filter: `QuizPaperQuestion` has no field
 * `correct` or `explanation` could travel in, so proofs 1 and 5 are assertions
 * about a type and not about the care taken here.
 *
 * `multiple` is the one expression in this file that touches the key, and it
 * touches only *how many distinct options it names*: a question that admits
 * several answers has to be drawn as a checkbox group and one that admits a
 * single answer as a radio group, or the control lies about what it will
 * accept. *How many*, never *which*.
 *
 * It is measured over a **set**, which is the same fold `scorePaper` makes
 * before it compares (`new Set(question.correct)`, and then
 * `picked.size === wanted.size`). A key that names one option twice is one
 * answer to the scorer, and nothing upstream refuses the repeat: the shape
 * check folds `correct` into a set before asking whether every option is
 * keyed, and the DTO's `correct` carries no `@ArrayUnique()`. Measured as an
 * array, such a question would be drawn as a checkbox group, told the learner
 * to pick every answer that applies, and marked them wrong for doing it. Two
 * readers of one key, one answer.
 *
 * The row carries a draw and a permutation, never a copy of the bank, so the
 * stems and the option texts are read back out of the **pinned** version's
 * sealed slice. A question the pinned version no longer declares is dropped
 * rather than thrown over: this function answers a read, and the hand-in
 * refuses the same paper by name before anything is scored.
 *
 * **A closed row is drawn too, and it says so.** The room offers back a sheet
 * whose marking never happened, and such a paper is not an open one: handing
 * it in re-enqueues the answers already in the record and does not overwrite
 * them (`handIn` writes the sheet only `if (!paper.submittedAt)`), so a client
 * that drew it as a blank paper would take answers it then discarded without a
 * word. `handedInAt` and `selected` are therefore filled from the row rather
 * than left to the caller, and both are **absent** on an open paper: a field
 * that is there only when it is true is a field a client cannot read the wrong
 * way round.
 */
export function quizOpenPaper(row: QuizAttemptEntity, checks: QuizChecks): QuizOpenPaper {
  const pool = new Map(checks.questions.map((question) => [question.id, question]));
  return {
    attemptId: row.id,
    startedAt: row.startedAt,
    // The sheet in the record is in the teacher's ids; the learner reads it in
    // this paper's tokens, the same tokens the options below are named by.
    ...(row.submittedAt
      ? { handedInAt: row.submittedAt, selected: sheetInTokens(row.id, row.answers ?? {}) }
      : {}),
    questions: row.paper.flatMap((drawn) => {
      const question = pool.get(drawn.questionId);
      if (!question) return [];
      const byId = new Map(question.options.map((option) => [option.id, option]));
      return [
        {
          id: question.id,
          // The stem and each option's text as a learner reads them: plain, HTML comments not shown.
          stem: learnerText(question.stem),
          // Named by this paper's own token and never by the authored id,
          // which is the order the teacher wrote them in (`optionToken`).
          options: drawn.optionIds.flatMap((id) => {
            const option = byId.get(id);
            return option ? [{ id: optionToken(row.id, question.id, option.id), text: learnerText(option.text) }] : [];
          }),
          multiple: new Set(question.correct).size > 1,
        },
      ];
    }),
  };
}

/**
 * Is this sheet an answer to **this** paper?
 *
 * Every key must be a question the paper drew, every value must be a list of
 * option ids that question offers, and no option may be picked twice. A
 * question left out is not an error: a paper handed in half answered is a
 * paper, and the blanks are scored wrong like any other answer, which is what
 * *"no time pressure"* costs and is meant to cost.
 *
 * The runtime tests below say what the DTO cannot: `@IsObject()` can police the
 * body's shape but not the shape of values whose keys are the learner's own
 * question ids. A value that is not a list of strings reaches the scorer as a
 * sheet that would compare a `Set` against a number, which is a refusal, not a
 * zero.
 */
export function assertSheetAnswersPaper(
  paper: readonly { questionId: string; optionIds: string[] }[],
  answers: Record<string, unknown>,
): void {
  const drawn = new Map(paper.map((one) => [one.questionId, new Set(one.optionIds)]));
  for (const [questionId, picked] of Object.entries(answers)) {
    const options = drawn.get(questionId);
    if (!options || !Array.isArray(picked)) throw new BadRequestException(QUIZ_SHEET_REFUSAL);
    const seen = new Set<string>();
    for (const optionId of picked) {
      if (typeof optionId !== 'string' || !options.has(optionId) || seen.has(optionId)) {
        throw new BadRequestException(QUIZ_SHEET_REFUSAL);
      }
      seen.add(optionId);
    }
  }
}

/**
 * The sheet a learner sent, in this paper's tokens, as the sheet in the
 * teacher's ids, or the one sentence.
 *
 * The learner only ever holds tokens (`quizOpenPaper`), so the sheet is read
 * through the paper it answers: each question the paper drew maps its own
 * tokens back to the ids the teacher wrote, and anything else, a question the
 * paper did not draw, a value that is not a list of strings, and a string that
 * is not one of that question's tokens on **this** paper, the authored id
 * included, is `QUIZ_SHEET_REFUSAL`, the same sentence every other bad sheet
 * gets, so a refusal says nothing about which ids exist. A duplicate maps to a
 * duplicate and is refused by `assertSheetAnswersPaper` straight after, over
 * the translated sheet, so the paper's own rule is still asked of what is
 * stored.
 *
 * What is written, scored, regraded and read by the teacher is the translated
 * sheet; the tokens are the wire's and go no further than it.
 */
export function sheetFromTokens(
  paper: { id: string; paper: readonly { questionId: string; optionIds: string[] }[] },
  answers: Record<string, unknown>,
): Record<string, string[]> {
  const drawn = new Map(
    paper.paper.map((one) => [
      one.questionId,
      new Map(one.optionIds.map((optionId) => [optionToken(paper.id, one.questionId, optionId), optionId])),
    ]),
  );
  const sheet: Record<string, string[]> = {};
  for (const [questionId, picked] of Object.entries(answers)) {
    const tokens = drawn.get(questionId);
    if (!tokens || !Array.isArray(picked)) throw new BadRequestException(QUIZ_SHEET_REFUSAL);
    sheet[questionId] = picked.map((token: unknown) => {
      const optionId = typeof token === 'string' ? tokens.get(token) : undefined;
      if (optionId === undefined) throw new BadRequestException(QUIZ_SHEET_REFUSAL);
      return optionId;
    });
  }
  assertSheetAnswersPaper(paper.paper, sheet);
  return sheet;
}

/**
 * Seconds still owed on the teacher's cooldown, or null when none is.
 *
 * **The only clock anywhere near a quiz, and it is between papers rather than
 * inside one**: there is no per-question timer and nothing counts down while a
 * learner reads. It defaults to null, so most quizzes never reach this at all.
 * Measured from the newest handed-in paper's `submittedAt`, which is the one
 * column the replay refusal and the attempt count also read.
 */
export function cooldownLeft(
  checks: QuizChecks,
  latest: { submittedAt: string | null } | null,
): number | null {
  const seconds = checks.attempts.cooldownSeconds;
  if (!seconds || seconds <= 0 || !latest?.submittedAt) return null;
  const left = Math.ceil((Date.parse(latest.submittedAt) + seconds * 1000 - Date.now()) / 1000);
  return left > 0 ? left : null;
}

/** Everything the three routes resolve before they do anything at all. */
interface QuizRequest {
  state: PhaseStateEntity;
  phase: PhaseContent;
  task: CompiledTask;
  checks: QuizChecks;
  /** The pin this enrolment resolves **now**: what a paper is drawn against. */
  versionId: string | null;
  packVersion: string | null;
  /** This task's own row, or null where the learner has never touched it. */
  row: TaskStateEntity | null;
  /**
   * Which run of this quiz the request is about: `task_states.resetCount`.
   *
   * Read once, here, and carried, because every one of the three routes asks a
   * question about attempts and all three must be asking it about the same
   * run. A teacher's reset between two of these reads is a reset that wins,
   * which is what the hand-in's own refusal is for.
   */
  epoch: number;
  /** Set when the key is a virtual concept check. */
  concept?: ConceptTaskKey;
}

/**
 * The learner's three quiz routes.
 *
 * `GET …/quiz` is the room, `POST …/quiz/attempts` draws a paper and
 * `POST …/quiz/attempts/:attemptId` hands one in. Nothing here scores: the
 * sheet is written, the grader is called through the one `FeedbackService`
 * entry point that takes an attempt id, and the verdict arrives on the
 * submission the room already polls. That separation is not tidiness: it is
 * what keeps request latency from carrying how many answers were right.
 *
 * **Every route resolves the same way** (`resolve`, below), and that is where
 * the ownership check, the phase gate, the pinned task list and the quiz slice
 * all come from. A caller cannot reach a paper by naming a phase state that is
 * not theirs, a phase their class has not opened, or a task the pinned version
 * does not declare, because none of those gets past `loadOwnedState` and
 * `taskForRequest`: the product's own two, never a third copy.
 *
 * **It writes to `quiz_attempts` only through `QuizAttemptsService`**, which is
 * that table's one writer. Nothing here calls `save` on a row.
 */
@Injectable()
export class QuizService {
  constructor(
    private readonly workflow: WorkflowService,
    private readonly content: ContentService,
    private readonly feedback: FeedbackService,
    private readonly attempts: QuizAttemptsService,
    @InjectRepository(TaskStateEntity)
    private readonly taskStates: Repository<TaskStateEntity>,
    @InjectRepository(SubmissionEntity)
    private readonly submissions: Repository<SubmissionEntity>,
  ) {}

  /** The quiz as a learner reads it, with the open paper if there is one. */
  async room(userId: string, phaseStateId: string, taskKey: string): Promise<QuizRoomView> {
    const request = await this.resolve(userId, phaseStateId, taskKey);
    if (request.concept) return this.conceptView(request);
    return this.view(request);
  }

  /**
   * `GET /phases/:id/concept-quizzes`, where this
   * learner stands on the phase's two concept checks. A pack that declares a
   * task with a concept key switches that check off (404 on the quiz routes);
   * the status route then reports it as taken with no score, so no prompt is
   * shown for it.
   */
  async conceptQuizzes(userId: string, phaseStateId: string): Promise<ConceptQuizzesView> {
    const { state, enrollment } = await this.workflow.loadOwnedState(userId, phaseStateId);
    const checks = conceptChecks(state.phaseKey);
    if (!checks) throw noConceptCheckRefusal();
    const declared = new Set(
      this.content.getTasksForEnrollment(enrollment, state.phaseKey).map((task) => task.taskKey),
    );
    // Handed-in work closes the before check.
    const work = await this.conceptHandedInWork(state.id);
    const slot = async (taskKey: ConceptTaskKey): Promise<ConceptSlot> => {
      if (declared.has(taskKey)) {
        return { taskKey, status: 'taken', scorePct: null, questionCount: checks.questions.length };
      }
      const taken = await this.attempts.latestHandedIn(state.id, taskKey, CONCEPT_EPOCH);
      return {
        taskKey,
        status: conceptSlotStatus(taskKey, state.status, !!taken, work),
        scorePct: conceptScorePct(taken),
        questionCount: checks.questions.length,
      };
    };
    return { phaseKey: state.phaseKey, before: await slot(CONCEPT_BEFORE), after: await slot(CONCEPT_AFTER) };
  }

  /**
   * Draw a paper, or hand back the one already open.
   *
   * **A double start is not a second paper.** The open row is the answer
   * before the limit and the cooldown are even asked about, and the order
   * matters: a learner who reloads is a learner reading the questions they
   * were already reading, and a limit or a cooldown that moved under them
   * while a paper was open would otherwise refuse them their own paper back.
   *
   * **It spends nothing.** The limit is counted on closed rows, so an
   * abandoned paper costs no attempt. Spending the limit here and resting the
   * replay defence on the in-flight guard would make an abandoned paper cost
   * an attempt and a replayed one cost none, which is exactly backwards.
   */
  async start(userId: string, phaseStateId: string, taskKey: string): Promise<QuizOpenPaper> {
    const request = await this.resolve(userId, phaseStateId, taskKey);
    if (request.concept) return this.conceptStart(request);
    // A phase its pinned version holds in an older form grades nothing, so a
    // paper drawn there could never be marked: the room's sentence, before
    // anything is drawn.
    const older = olderFormatRoomSentence(request.phase);
    if (older) throw new ConflictException(older);
    const { state, task, checks, epoch } = request;
    const held = await this.attempts.open(state.id, task.taskKey);
    // The learner's own paper back, but only if it belongs to the run this
    // quiz is in now. A paper left open by a teacher's reset is a paper drawn
    // against a run they have closed; `QuizAttemptsService.start` is what
    // closes it, below, rather than handing it back here.
    if (held && held.epoch === epoch) return quizOpenPaper(held, checks);

    const max = checks.attempts.max;
    if (max !== null && (await this.attempts.handedIn(state.id, task.taskKey, epoch)) >= max) {
      throw attemptsSpentRefusal(task, max);
    }
    const cooldown = await this.cooldownOwed(request);
    if (cooldown !== null) throw cooldownRefusal(task, cooldown);
    // Above the draw, because a refusal that has already drawn a paper is not
    // a refusal. See `stillMarkingRefusal` for what the second paper would
    // otherwise do to the first one's verdict.
    if (await this.stillMarking(request)) throw stillMarkingRefusal(task);
    if (!request.versionId) throw unpinnedQuizRefusal(task);

    // `start` re-reads the open row and the unique index decides a race, so
    // the paper this returns is the paper the learner holds even when two
    // presses landed together.
    const drawn = await this.attempts.start({
      phaseStateId: state.id,
      userId: state.userId,
      taskKey: task.taskKey,
      projectVersionId: request.versionId,
      packVersion: request.packVersion,
      epoch,
      checks,
    });
    return quizOpenPaper(drawn, checks);
  }

  /**
   * Hand a paper in.
   *
   * The order of what follows is the whole of this method, because every one
   * of these refusals has to land **before** anything is written:
   *
   * 1. the phase is not one its pinned version holds in an older form, which
   *    nothing grades (the room's sentence);
   * 2. the paper is this learner's, on this task, and is not already graded:
   *    one sentence for all four ways it is not (`QUIZ_PAPER_REFUSAL`);
   * 3. the teacher's limit is not already spent, counted **without** the paper
   *    in hand, which would otherwise refuse the last attempt on a retry;
   * 4. the pin still matches, so a re-pinned paper is refused rather than
   *    marked against another version's key;
   * 5. the sheet answers the paper that was drawn, one sentence again.
   *
   * Then the sheet is written, and only then is the grader called. `submit`
   * reads *the newest closed paper* and refuses a hand-in that does not name
   * it, so the paper verified here and the paper scored there are one row by
   * construction, which is why the write comes first and not after.
   */
  async handIn(
    userId: string,
    phaseStateId: string,
    taskKey: string,
    attemptId: string,
    answers: Record<string, string[]>,
  ): Promise<SubmissionView> {
    const request = await this.resolve(userId, phaseStateId, taskKey);
    if (request.concept) return this.conceptHandIn(request, attemptId, answers);
    // `submit` refuses an older-format phase too, but only after the sheet
    // below has closed the paper, which would spend an attempt on a refusal.
    // The room's sentence, then, before anything is written.
    const older = olderFormatRoomSentence(request.phase);
    if (older) throw new ConflictException(older);
    const { state, phase, task, checks, epoch } = request;
    const paper = await this.paperToHandIn(request, attemptId);

    const max = checks.attempts.max;
    if (max !== null) {
      // The paper in hand does not count against the limit it is being
      // measured by: on the retry path below it is already a closed row, and
      // counting it would refuse the very last attempt a learner is owed.
      const spent = (await this.attempts.handedIn(state.id, task.taskKey, epoch))
        - (paper.submittedAt ? 1 : 0);
      if (spent >= max) throw attemptsSpentRefusal(task, max);
    }
    if (paper.projectVersionId !== request.versionId) throw stalePaperRefusal(task);
    // The learner answered in this paper's tokens; the record is in the
    // teacher's ids. Translated and checked in one step, one sentence.
    const sheet = sheetFromTokens(paper, answers);

    // `handIn` is scoped to a row that is still open, so a replayed request
    // cannot overwrite a sheet that is already in the record, and a paper
    // whose revision never reached the queue is handed in again with the sheet
    // it was handed in with, which is the one in the record.
    if (!paper.submittedAt) await this.attempts.handIn(paper.id, sheet);

    return this.feedback.submit(phase, state, undefined, task.taskKey, { attemptId: paper.id });
  }

  /* ------------------------------- internals ------------------------------ */

  /**
   * The phase, the task and the slice: through the product's own two doors.
   *
   * `loadOwnedState` is the ownership check and the schedule gate; a phase
   * state that is not this learner's is a 403 and a phase their class has not
   * opened is refused there, not here. `taskForRequest` is the one
   * resolution of *which task a request is about*, so a key the **pinned**
   * version does not declare is `unknownTask`'s 404 and never a silent fall
   * back to some other task.
   */
  private async resolve(
    userId: string,
    phaseStateId: string,
    taskKey: string,
  ): Promise<QuizRequest> {
    const { state, phase, enrollment } = await this.workflow.loadOwnedState(userId, phaseStateId);
    const declared = this.content.getTasksForEnrollment(enrollment, state.phaseKey);
    // A concept key the pack does not declare is a
    // virtual concept check. No task_states row is read (epoch 0).
    if (isConceptTaskKey(taskKey) && !declared.some((one) => one.taskKey === taskKey)) {
      const checks = conceptChecks(state.phaseKey);
      if (!checks) throw noConceptCheckRefusal();
      const resolved = this.content.resolveForEnrollment(enrollment);
      return {
        state,
        phase,
        task: conceptTask(state.phaseKey, taskKey, checks),
        checks,
        row: null,
        epoch: CONCEPT_EPOCH,
        versionId: resolved.versionId,
        packVersion: CONCEPT_BANK_VERSION,
        concept: taskKey,
      };
    }
    const task = taskForRequest(declared, taskKey);
    const checks = quizChecksFor(phase, task);
    if (!checks) throw notAQuizRoomRefusal(task);
    const resolved = this.content.resolveForEnrollment(enrollment);
    // One read of the task's own row, for all three routes. `resetCount` is
    // the attempt epoch (`attemptEpochOf`), and the room reads `status` and
    // `bestScore` off the same row rather than asking for it twice.
    const row = await this.taskStates.findOne({
      where: { phaseStateId: state.id, taskKey: task.taskKey },
    });
    return {
      state,
      phase,
      task,
      checks,
      row,
      epoch: attemptEpochOf(row),
      versionId: resolved.versionId,
      // Beside `submissions.packVersion`, and read from the same resolution
      // the pin above came from, so a paper's two stamps cannot name two
      // different versions.
      packVersion: resolved.content.version,
    };
  }

  /** The room, built from the rows rather than from anything a caller said. */
  private async view(request: QuizRequest): Promise<QuizRoomView> {
    const { state, task, checks, epoch, row } = request;
    const [attemptsUsed, open, latest] = await Promise.all([
      this.attempts.handedIn(state.id, task.taskKey, epoch),
      this.attempts.open(state.id, task.taskKey),
      this.attempts.latestHandedIn(state.id, task.taskKey, epoch),
    ]);
    const attemptsLeft =
      checks.attempts.max === null ? null : Math.max(0, checks.attempts.max - attemptsUsed);
    // The open paper of THIS run. A paper left open by a reset belongs to a
    // run the teacher has closed and `start` will not hand it back, so drawing
    // it here would be a room offering a paper that cannot be handed in. The
    // reset voids the one it finds, so this clause is the room agreeing with
    // `start` rather than a case either of them can reach.
    const held = open && open.epoch === epoch ? open : null;
    // One read of the revision the newest sheet names, and two facts come out
    // of it: whether a verdict is still coming, and whether one is never
    // coming. `paperToHandIn` asks the same question of the same row, through
    // the same method, so the room cannot offer a paper the route would refuse
    // nor withhold one it would take.
    const { marking, unmarked } = await this.latestVerdict(latest);
    // The sheet that was written and never marked, offered back. This is the
    // surface the widening in `paperToHandIn` was built for: `open()` answers
    // null on a closed row, so without this clause the recovery exists in the
    // route and nowhere a learner can reach. It is offered whatever the
    // counters read: a spent limit is exactly when it matters most, and the
    // paper in hand is discounted from the limit it is measured against.
    const unsent = !held && unmarked && latest?.userId === state.userId ? latest : null;
    // A row that reads `passed` without a pass the gate
    // accepts. A teacher's Sign off writes a quiz's row `passed` with no paper
    // behind it, and on a REQUIRED quiz the strict-evidence gate still waits on
    // a passing one, so a learner with no papers left is as stuck as one who
    // never passed, and "your best score is already recorded" is the one
    // sentence that is false to them. Asked of the gate's own predicate, and
    // only in the one state it can change the answer in.
    //
    // The same question, asked of any passed row, is also whether
    // `bestScore` is a paper's mark at all. A Sign off or a phase-wide Pass
    // writes the pass mark as the row's best score, and the room would print
    // it as "Best score" beside papers that scored less. `credited` is the
    // gate's own predicate (the row passed, no paper has a pass it accepts)
    // asked only of a passed row, so an open quiz pays nothing for it.
    const credited =
      row?.status === 'passed' &&
      !(await taskHasStrictEvidence(this.submissions.manager, state, task, soleTaskList([task]), state.userId));
    const creditedWithoutPaper = attemptsLeft === 0 && task.required && credited;
    return {
      taskKey: task.taskKey,
      title: task.title,
      // the room's brief as a learner reads it: plain, HTML comments not shown
      brief: learnerText(task.brief),
      required: task.required,
      // This task's own row, and `in_progress` where there is none: the
      // column's own default, so a quiz nobody has opened reads as a quiz
      // nobody has opened rather than as the phase around it.
      status: row?.status ?? 'in_progress',
      drawn: checks.drawn ?? checks.questions.length,
      passMark: checks.passMark,
      attemptsUsed,
      attemptsLeft,
      // **The rule, decided here rather than in a browser.** Every paper this
      // run allowed has been handed in, none of them passed, and there is
      // nothing left for the learner to press, so no further paper can be
      // drawn until a teacher resets the task. It is deliberately a fact about
      // the *paper* and not about the gate: an optional quiz in this state is
      // also out of papers, and whether that blocks anything is what
      // `required` beside it says.
      //
      // The last two conjuncts are what keep this from saying *ask a person*
      // over a state a person cannot help with. A sheet whose marking never
      // happened is handed in again, not reset: a reset would start an epoch
      // that leaves that sheet behind, and it is the hand-in control the
      // learner needs. And while the newest sheet is still being marked the
      // two halves of this expression simply disagree: `attemptsUsed` counts a
      // paper the instant it is written, the row reads `passed` only once the
      // job lands, and the paper in between may well pass.
      needsInstructorReset:
        attemptsLeft === 0 &&
        ((row?.status ?? 'in_progress') !== 'passed' || creditedWithoutPaper) &&
        !unsent &&
        !marking,
      cooldownSecondsLeft: cooldownLeft(checks, latest),
      // The task's own row. `task_states.attempts` is deliberately not read
      // here: it is the reliance index's denominator and counts every hand-in
      // of every kind, where `attemptsUsed` above is this quiz's own limit.
      bestScore: row?.bestScore ?? null,
      // Spread so that a quiz a paper passed, or nobody has, carries no field.
      ...(credited ? { passCredited: true as const } : {}),
      lastSubmissionId: latest?.submissionId ?? null,
      // The paper in front of the learner: the one they have open, or the
      // sheet nobody marked, offered back.
      paper: held
        ? quizOpenPaper(held, checks)
        : unsent
          ? quizOpenPaper(unsent, checks)
          : null,
    };
  }

  /* ---------------- the concept checks ---------------- */

  /** The concept check as the quiz room reads it, in `QuizRoomView`'s shape. */
  private async conceptView(request: QuizRequest): Promise<QuizRoomView> {
    const { state, task, checks } = request;
    const [taken, open, work] = await Promise.all([
      this.attempts.latestHandedIn(state.id, task.taskKey, CONCEPT_EPOCH),
      this.attempts.open(state.id, task.taskKey),
      this.conceptHandedInWork(state.id),
    ]);
    const status = conceptSlotStatus(request.concept!, state.status, !!taken, work);
    return {
      taskKey: task.taskKey,
      title: task.title,
      // the room's brief as a learner reads it: plain, HTML comments not shown
      brief: learnerText(task.brief),
      required: false,
      // A closed before check reads as locked in the room.
      status: status === 'taken' ? 'passed' : status === 'locked' || status === 'closed' ? 'locked' : 'in_progress',
      drawn: checks.questions.length,
      passMark: checks.passMark,
      attemptsUsed: taken ? 1 : 0,
      attemptsLeft: taken ? 0 : 1,
      needsInstructorReset: false,
      cooldownSecondsLeft: null,
      bestScore: conceptScorePct(taken),
      lastSubmissionId: null,
      paper: open && !taken && open.userId === state.userId ? quizOpenPaper(open, checks) : null,
    };
  }

  /**
   * Whether the learner has handed in any work for this
   * phase state: at least one `submissions` row, any task, any status. A
   * concept check writes none, so its own papers never count.
   */
  private async conceptHandedInWork(phaseStateId: string): Promise<boolean> {
    const row = await this.submissions.findOne({ select: ['id'], where: { phaseStateId } });
    return !!row;
  }

  /** Draw the one paper a slot allows, or hand back the one already open. */
  private async conceptStart(request: QuizRequest): Promise<QuizOpenPaper> {
    const { state, task } = request;
    if (await this.attempts.latestHandedIn(state.id, task.taskKey, CONCEPT_EPOCH)) {
      throw conceptTakenRefusal();
    }
    const work = request.concept === CONCEPT_BEFORE && (await this.conceptHandedInWork(state.id));
    const status = conceptSlotStatus(request.concept!, state.status, false, work);
    if (status === 'locked') throw conceptLockedRefusal();
    // No new before paper once work is handed in. A paper
    // drawn while the slot was open is still handed back by the room and may
    // be handed in (`conceptHandIn` does not ask the slot).
    if (status === 'closed') throw conceptClosedRefusal();
    const held = await this.attempts.open(state.id, task.taskKey);
    if (held && held.userId === state.userId) return quizOpenPaper(held, request.checks);
    // A fresh question order for this paper; the options are shuffled by the draw.
    const shuffled = conceptChecks(state.phaseKey, true)!;
    const drawn = await this.attempts.start({
      phaseStateId: state.id,
      userId: state.userId,
      taskKey: task.taskKey,
      // The column is NOT NULL; the bank is code, so the enrolment's pin is a
      // stamp only and the bank's own version is in packVersion.
      projectVersionId: request.versionId ?? CONCEPT_BANK_VERSION,
      packVersion: CONCEPT_BANK_VERSION,
      epoch: CONCEPT_EPOCH,
      checks: shuffled,
    });
    return quizOpenPaper(drawn, request.checks);
  }

  /**
   * Score the sheet in the request and close the paper with its mark. No
   * submission, no grading job, no task_states, event or progress write. A
   * replayed hand-in of the paper already scored answers with the same result.
   */
  private async conceptHandIn(
    request: QuizRequest,
    attemptId: string,
    answers: Record<string, string[]>,
  ): Promise<SubmissionView> {
    const { state, task, checks } = request;
    const open = await this.attempts.open(state.id, task.taskKey);
    let paper: QuizAttemptEntity | null = null;
    if (open && open.id === attemptId && open.userId === state.userId && open.epoch === CONCEPT_EPOCH) {
      const sheet = sheetFromTokens(open, answers);
      const scored = scorePaper(checks, open.paper, sheet);
      const pct = paperPercent(scored);
      await this.attempts.handInScored(open.id, sheet, pct, quizPassed(pct, checks.passMark));
      paper = await this.attempts.byId(open.id);
    } else {
      const latest = await this.attempts.latestHandedIn(state.id, task.taskKey, CONCEPT_EPOCH);
      if (latest && latest.id === attemptId && latest.userId === state.userId) paper = latest;
    }
    if (!paper || !paper.submittedAt || paper.voidedAt) throw new BadRequestException(QUIZ_PAPER_REFUSAL);
    const scored = scorePaper(checks, paper.paper, paper.answers ?? {});
    return conceptSubmissionView(paper, scored, conceptScorePct(paper) ?? 0);
  }

  /** Seconds still owed on the teacher's cooldown, or null when none is. */
  private async cooldownOwed(request: QuizRequest): Promise<number | null> {
    if (!request.checks.attempts.cooldownSeconds) return null;
    return cooldownLeft(
      request.checks,
      await this.attempts.latestHandedIn(request.state.id, request.task.taskKey, request.epoch),
    );
  }

  /**
   * What the revision a handed-in sheet names says about that sheet: the one
   * reader of a paper's verdict, and the two facts every caller here wants.
   *
   * Read off the **paper** rather than off the phase: `quiz_attempts` is the
   * row that names which submission marked which sheet, so a submission this
   * learner started on another task of the same phase is not this quiz's
   * business and must not shut its door.
   *
   * **`marking`**: the verdict is still in flight (`queued` or `running`).
   * `start` refuses a second paper while this is true, because the grader
   * scores the newest handed-in row and a second sheet would take the first
   * one's job; and the room does not send a learner to their instructor while
   * it is true, because the paper being marked may well pass.
   *
   * **`unmarked`**: no verdict exists and none is coming, so the sheet may be
   * handed in again. Two shapes reach it. A closed paper naming **no**
   * revision is one whose submission never reached the queue: `submit` unlinks
   * it on a 503 precisely so it can be handed in again. A paper naming a
   * revision that **failed** is a marking that was lost: the stall age-out,
   * which writes off a job nobody is running, and a pipeline failure on a
   * queue that does not retry, both leave the link behind. A learner on either
   * path has a spent attempt, no verdict and a sheet nobody has marked, for a
   * worker death they did not cause; on the last attempt of a required quiz,
   * that is the phase and the rest of the project.
   *
   * `completed` is neither: that paper has its verdict, and this widening is a
   * lost marking rather than a second bite at a scored one. A submission id
   * that resolves to no row is neither either: the absence of a record is not
   * evidence that no verdict exists.
   *
   * One method rather than two, because `paperToHandIn` and `view` must not be
   * able to disagree about which sheet is still owed a mark: the room would
   * then offer a paper the route refuses, or withhold one it would take.
   */
  private async latestVerdict(
    latest: QuizAttemptEntity | null,
  ): Promise<{ marking: boolean; unmarked: boolean }> {
    if (!latest) return { marking: false, unmarked: false };
    if (!latest.submissionId) return { marking: false, unmarked: true };
    const named = await this.submissions.findOne({
      where: { id: latest.submissionId },
      select: ['id', 'status'],
    });
    return {
      marking: named?.status === 'queued' || named?.status === 'running',
      unmarked: named?.status === 'failed',
    };
  }

  /** Is the previous paper's verdict still in flight? */
  private async stillMarking(request: QuizRequest): Promise<boolean> {
    const { state, task, epoch } = request;
    const latest = await this.attempts.latestHandedIn(state.id, task.taskKey, epoch);
    return (await this.latestVerdict(latest)).marking;
  }

  /**
   * The paper this request is handing in, or one sentence.
   *
   * Two rows can be handed in, and the second is not an oversight:
   *
   * - the paper **still open** on this task, which is the mainline;
   * - a paper already **closed** whose marking never happened, it names no
   *   revision, which is what `FeedbackService` leaves behind when the queue
   *   refuses a submission, or it names one that **failed**, which is what the
   *   stall age-out and a non-durable pipeline failure leave behind
   *   (`latestVerdict`'s `unmarked`). `submit` accepts exactly these rows, and
   *   `view` offers exactly these rows back, through the same method: a route
   *   that refused them would leave the learner with a spent attempt and a
   *   sheet nobody can hand in, for an outage they did not cause, and a room
   *   that did not draw them would leave that route with no surface.
   *
   * Everything else: an id that does not exist, an id belonging to somebody
   * else, a paper already graded or still being graded, and a paper voided by
   * a teacher's reset: is **one** sentence,
   * which is `FeedbackService`'s own rather than a second copy of it. The
   * lookups are keyed on this learner's phase state and this task **and this
   * attempt epoch**, so another learner's paper and a paper from before a
   * reset are both simply not found: the refusal cannot be used to ask whether
   * an attempt id exists, nor what became of one.
   */
  private async paperToHandIn(
    request: QuizRequest,
    attemptId: string,
  ): Promise<QuizAttemptEntity> {
    const { state, task, epoch } = request;
    const open = await this.attempts.open(state.id, task.taskKey);
    if (open && open.id === attemptId && open.userId === state.userId && open.epoch === epoch) {
      return open;
    }
    const latest = await this.attempts.latestHandedIn(state.id, task.taskKey, epoch);
    if (latest && latest.id === attemptId && latest.userId === state.userId) {
      if ((await this.latestVerdict(latest)).unmarked) return latest;
    }
    throw new BadRequestException(QUIZ_PAPER_REFUSAL);
  }
}
