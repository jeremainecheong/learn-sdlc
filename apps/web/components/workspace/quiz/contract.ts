'use client';

/**
 * What the quiz room asks the API for, and what it is allowed to be told.
 *
 * **The seal, from the browser's side.** `QuizQuestion.correct` is the answer
 * key and it never leaves the API on any route, at any time, passed or failed:
 * so there is no field for it here, and a reader looking for one finds this
 * paragraph instead. A learner is told, per question, whether they were right
 * and which options they picked; the `explanation` arrives only once they are
 * finished with that question, computed server-side from the attempt row and
 * never sent as a flag this browser could flip. That is why the scored report's
 * per-question field is `outcome: 'right' | 'wrong'` and not `correct: boolean`;
 * the word `correct` appearing nowhere in a learner payload is a property a
 * spec can assert over a whole serialised response.
 *
 * **The response shapes are the shared package's**, re-exported below so this
 * file is still where a reader of the room looks. Declared separately here and
 * in `apps/api/src/quiz/quiz.dto.ts`, they would agree only by hand, each
 * side's specs holding its own copy and nothing holding the pair, so a field
 * renamed on either side would be `undefined` in the room at runtime with both
 * suites green. The compiler holds them together.
 *
 * **The three URLs and the calls on them** are `lib/api-quiz.ts`'s, re-exported
 * below beside the room's other names.
 */

import type {
  QuizOpenPaper,
  QuizPaperQuestion,
  QuizRoomView as SharedQuizRoomView,
} from '@learnsdlc/shared';

export type { QuizOpenPaper, QuizPaperQuestion };

/**
 * The room, as the route answers it.
 *
 * `passCredited` is declared once, on the contract's `QuizRoomView` itself, so
 * this is the contract's type under the name the room already imports.
 */
export type QuizRoomView = SharedQuizRoomView;

export {
  QUIZ_ROUTES,
  QUIZ_ROUTE_KEYS,
  quizApi,
  quizPath,
  type QuizAnswers,
  type QuizRoute,
  type QuizRouteKey,
} from '@/lib/api-quiz';

/** Which quiz of the phase this room is open on, given what the URL asked for. */
export function quizTaskKey(
  tasks: readonly { key: string; artefactType: string }[] | undefined,
  asked: string | null | undefined,
): string | undefined {
  const quizzes = (tasks ?? []).filter((task) => task.artefactType === 'quiz');
  if (asked && quizzes.some((task) => task.key === asked)) return asked;
  // A key the pinned version no longer declares (a stale tab, a link from
  // before a teacher re-cut the phase) falls back to the phase's first quiz
  // rather than asking the API about a task that is not there.
  return quizzes[0]?.key ?? (asked || undefined);
}

/**
 * How a score is said, in one sentence a screen reader can read on its own.
 *
 * It is a sentence rather than a number beside a label because it is announced
 * through a live region the moment a verdict lands, and "4" on its own is not
 * an announcement.
 */
export function scoreLine(correctCount: number, drawn: number, passMark: number, passed: boolean): string {
  const verdict = passed ? 'That is a pass.' : 'That is below the pass mark.';
  return `${correctCount} of ${drawn} correct. The pass mark is ${passMark}%. ${verdict}`;
}
