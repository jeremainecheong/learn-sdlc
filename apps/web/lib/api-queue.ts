'use client';

/**
 * Where a job of yours sits in the line.
 *
 * One route, and it only ever answers about the caller's own job: the API
 * refuses an id that is not theirs with a 404, so there is no state in which
 * this tells one learner about another learner's run.
 */
import type { QueuePositionView } from '@learnsdlc/shared';
import { request } from './api';

export const queueApi = {
  position: (kind: 'run' | 'submission', id: string) =>
    request<QueuePositionView>(
      'GET',
      `/queue/position?kind=${kind}&id=${encodeURIComponent(id)}`,
    ),
};
