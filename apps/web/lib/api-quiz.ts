'use client';

/**
 * The learner's quiz doors and the calls on them.
 *
 * **The three URLs are cross-checked rather than shared.** They are built
 * here and declared again in `apps/api/src/quiz/quiz.controller.ts`; with each
 * side's suite pinning its own literals, renaming a segment on one side and
 * fixing that side's test would leave both suites green and the room 404ing.
 * So they are a table, `QUIZ_ROUTES`, and `quiz-contract.test.ts` reads the
 * doors the controller actually mounts and holds the two lists against each
 * other. The table would belong in `packages/shared`, beside
 * `AUTHORING_ROUTES`, which is the same table for the teacher's surface and is
 * imported by both sides; the cross-check keeps the two lists in step without
 * that move.
 *
 * The response shapes are the shared package's; the quiz room re-exports
 * these names from `components/workspace/quiz/contract.ts`.
 */

import type { QuizOpenPaper, QuizRoomView, SubmissionView } from '@learnsdlc/shared';
import { request } from '@/lib/api';

/** What a learner picked, per question: option ids, in no particular order. */
export type QuizAnswers = Record<string, string[]>;

/** One learner quiz door: the method it answers on and the path it sits at. */
export interface QuizRoute {
  readonly method: 'GET' | 'POST';
  /** The controller's own path, parameters and all, so the two can be compared. */
  readonly path: string;
}

/**
 * The learner's three doors, written once.
 *
 * The paths are the controller's verbatim, `:id` is the phase state, not the
 * phase key, because that is the parameter `QuizController` declares, so the
 * cross-check in the spec is a comparison rather than a translation.
 */
export const QUIZ_ROUTES = {
  room: { method: 'GET', path: '/phases/:id/tasks/:taskKey/quiz' },
  start: { method: 'POST', path: '/phases/:id/tasks/:taskKey/quiz/attempts' },
  handIn: { method: 'POST', path: '/phases/:id/tasks/:taskKey/quiz/attempts/:attemptId' },
} as const satisfies Record<string, QuizRoute>;

export type QuizRouteKey = keyof typeof QUIZ_ROUTES;

/** The keys, in the order a learner meets the doors. */
export const QUIZ_ROUTE_KEYS = ['room', 'start', 'handIn'] as const satisfies readonly QuizRouteKey[];

/**
 * Fill a door in.
 *
 * Throws rather than sending `:taskKey` down the wire: a path with a
 * placeholder still in it is a request that can only be refused, and a refusal
 * that names what is missing is worth more than a 404 whose body says nothing.
 * Every id is percent-encoded, so an id carrying a slash cannot open a path of
 * its own: the same rule `authoringPath` keeps for the teacher's surface.
 */
export function quizPath(key: QuizRouteKey, params: Record<string, string>): string {
  return QUIZ_ROUTES[key].path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') {
      throw new Error(`The ${key} quiz route needs a ${name}.`);
    }
    return encodeURIComponent(value);
  });
}

export const quizApi = {
  /** The quiz, the counters, and the open paper if there is one. */
  read: (phaseId: string, taskKey: string) =>
    request<QuizRoomView>(QUIZ_ROUTES.room.method, quizPath('room', { id: phaseId, taskKey })),
  /**
   * Start a paper. Idempotent: while a paper is open the route hands that one
   * back rather than drawing a second, so a double click is one paper and a
   * reload is the paper the learner was already reading.
   */
  start: (phaseId: string, taskKey: string) =>
    request<QuizOpenPaper>(QUIZ_ROUTES.start.method, quizPath('start', { id: phaseId, taskKey })),
  /**
   * Hand the sheet in. The verdict is produced by the submission job rather
   * than by this request, so how long the answer takes says nothing about how
   * many were right; the room watches the submission it gets back.
   */
  handIn: (phaseId: string, taskKey: string, attemptId: string, answers: QuizAnswers) =>
    request<SubmissionView>(
      QUIZ_ROUTES.handIn.method,
      quizPath('handIn', { id: phaseId, taskKey, attemptId }),
      { answers },
    ),
};
