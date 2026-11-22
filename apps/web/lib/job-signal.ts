'use client';

import type { JobEvent } from '@learnsdlc/shared';
import { SOCKET_EVENTS } from '@learnsdlc/shared';
import { getSocket, getSocketState } from './socket';

/**
 * A wake for {@link pollUntil}, fed by the `job.update` the API already emits.
 *
 * A run and a submission are watched by a poll the learner is sitting in front
 * of, and the socket usually knows the job has landed most of an interval
 * before the next ask does. This spends that: the event only says "ask now",
 * and the refetch the poll makes is the answer. Nothing from the payload is
 * passed on (not the status, not the id) because polling stays the source of
 * truth and a wrong or repeated event must cost one request and never a wrong
 * screen.
 *
 * It wakes on **any** status, including `running` and `failed`: what counts as
 * done is the caller's `isDone`, and a job that failed deserves the same fast
 * refetch as one that finished. Filtering on the status would mean reading the
 * payload to decide something, which is the one thing this module must not do.
 * The `running` event is the honest cost of that rule: no caller renders the
 * value that refetch brings back, so it buys one request per job and, at most,
 * a fresher last value if the watch later runs long enough to say so.
 *
 * Three deliberate limits:
 *
 * - It never opens a connection. `getSocket()` builds and connects one when
 *   none exists (`lib/socket.ts`), which a wait decoration has no business
 *   doing, so the socket is only reached while the shell's own state says a
 *   connected instance is there. A page without one keeps the plain cadence.
 * - It is therefore best effort in one more case: a poll that starts in the
 *   second or so before the shell's socket has finished its handshake watches
 *   at the plain cadence for its whole life. That costs latency, never
 *   correctness, which is the same bargain the socket itself documents.
 * - The state store answers "a socket is connected", not "the connected socket
 *   is still the right one". `getSocket()` replaces an instance whose token has
 *   changed under it, and a tab that lost that race is holding its own
 *   `job.update` listener on the instance that gets dropped. Reaching the live
 *   instance without that risk needs a non-constructing accessor in
 *   `lib/socket.ts`, which this module does not own.
 */
export function jobWake(
  type: JobEvent['type'],
  id: string,
): (resume: () => void) => () => void {
  return (resume) => {
    // A shortcut to watching a job must never be able to fail the job: the API
    // has accepted the run, and a socket that refuses costs the shortcut only.
    // The same stance the badge takes in `events.gateway.ts` and the queue line
    // takes in `QueueLine.tsx`. Both socket calls are inside this, including
    // the one that decides whether to make the other: a suite that mocks
    // `lib/socket` without `getSocketState` makes that call itself throw, and
    // the guarantee above would then hold for only half the module.
    try {
      if (getSocketState() !== 'live') return () => {};
      const socket = getSocket();
      if (!socket) return () => {};
      const onJob = (event: JobEvent) => {
        if (event?.type !== type || event.id !== id) return;
        resume();
      };
      socket.on(SOCKET_EVENTS.job, onJob);
      return () => {
        try {
          socket.off(SOCKET_EVENTS.job, onJob);
        } catch {
          // Nothing to undo: the instance has gone, and with it the listener.
        }
      };
    } catch {
      return () => {};
    }
  };
}
