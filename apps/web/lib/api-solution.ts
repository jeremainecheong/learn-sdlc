'use client';

/**
 * The reference solution's one call.
 *
 * Its own module rather than a line in `lib/api.ts` for the reason
 * `api-mentor.ts` gives: `lib/api.ts` is pulled into every page in the product
 * and none of this is. A learner who never passes a gate never downloads it.
 */
import type { SolutionView } from '@learnsdlc/shared';
import { request } from './api';

export const solutionApi = {
  /**
   * The pack's answer to one task of a phase, once **that task's** gate has
   * passed. A 403 before that.
   *
   * `taskKey` is left out (and the plain phase route is the one that is
   * called) wherever the phase has one task, which
   * the route resolves for itself. It is sent wherever a teacher has split the
   * phase, because the gate, the stamp and the standing line's two numbers are
   * all read from the task's own row and there is no honest default for which
   * task a learner meant.
   */
  read: (phaseStateId: string, taskKey?: string) =>
    request<SolutionView>(
      'GET',
      taskKey === undefined
        ? `/phases/${phaseStateId}/solution`
        : `/phases/${phaseStateId}/tasks/${encodeURIComponent(taskKey)}/solution`,
    ),
};
