/**
 * The socket's nudge to a poll that is already watching a job.
 *
 * The event is a nudge and never the answer: `pollUntil` refetches, and the
 * fetched value is the only thing a learner ever sees. That is what keeps the
 * socket contract intact ("polling remains the source of truth, a dropped
 * socket only costs latency, never correctness" (`lib/socket.ts`)) so the
 * tests below assert what is *not* passed on as much as what is.
 *
 * It also must never be the reason a connection opens: a page with no socket
 * gets a no-op, and the poll keeps its own cadence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobEvent } from '@learnsdlc/shared';

/** A hand-rolled stand-in for the one socket the shell already holds. */
const listeners = new Map<string, Set<(event: JobEvent) => void>>();
const socket = {
  on: vi.fn((name: string, fn: (event: JobEvent) => void) => {
    const held = listeners.get(name) ?? new Set();
    held.add(fn);
    listeners.set(name, held);
  }),
  off: vi.fn((name: string, fn: (event: JobEvent) => void) => {
    listeners.get(name)?.delete(fn);
  }),
};
const state = {
  value: 'live' as 'live' | 'paused',
  /**
   * What a suite that mocks `@/lib/socket` without `getSocketState` does to
   * this module: Vitest throws on the missing export. It is the shape of
   * refusal a suite in this repository can produce, so it is the one the
   * guard is tested against.
   */
  refuses: false,
};
const getSocket = vi.fn(() => socket);

vi.mock('@/lib/socket', () => ({
  getSocket: () => getSocket(),
  getSocketState: () => {
    if (state.refuses) throw new TypeError('No "getSocketState" export is defined on the mock');
    return state.value;
  },
}));

const { jobWake } = await import('@/lib/job-signal');

function emit(event: JobEvent): void {
  listeners.get('job.update')?.forEach((fn) => fn(event));
}

const job = (over: Partial<JobEvent> = {}): JobEvent => ({
  type: 'run',
  id: 'run-1',
  phaseStateId: 'testing-a',
  status: 'completed',
  ...over,
});

beforeEach(() => {
  listeners.clear();
  state.value = 'live';
  state.refuses = false;
  socket.on.mockClear();
  socket.off.mockClear();
  getSocket.mockClear();
});

describe('jobWake', () => {
  it('resumes only for the run or submission it was asked about', () => {
    const resume = vi.fn();
    const stop = jobWake('run', 'run-1')(resume);

    emit(job({ id: 'run-2' }));
    emit(job({ type: 'submission', id: 'run-1' }));
    expect(resume).not.toHaveBeenCalled();

    emit(job());
    expect(resume).toHaveBeenCalledTimes(1);
    // The event is not the answer, so nothing about it is handed on: the poll
    // asks the API again and that reply is what the learner sees.
    expect(resume.mock.calls[0]).toEqual([]);

    stop();
    expect(socket.off).toHaveBeenCalledWith('job.update', socket.on.mock.calls[0][1]);
    emit(job());
    expect(resume).toHaveBeenCalledTimes(1);
  });

  /**
   * A failed job deserves the same fast refetch as a finished one: what "done"
   * means is the poll's decision, not this module's.
   */
  it('wakes on any status, including a job that failed or has only started running', () => {
    const resume = vi.fn();
    jobWake('submission', 'sub-9')(resume);

    emit(job({ type: 'submission', id: 'sub-9', status: 'running' }));
    emit(job({ type: 'submission', id: 'sub-9', status: 'failed' }));

    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('does nothing, and opens nothing, when there is no connected socket', () => {
    state.value = 'paused';
    const resume = vi.fn();

    const stop = jobWake('run', 'run-1')(resume);

    expect(getSocket).not.toHaveBeenCalled();
    expect(socket.on).not.toHaveBeenCalled();
    emit(job());
    expect(resume).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  /**
   * A decoration on a wait must never be able to fail the thing it decorates.
   * A run or a submission the API has already accepted is worth more than any
   * shortcut to watching it, so a socket that refuses costs the shortcut only.
   */
  it('never fails the poll it is decorating when the socket refuses', () => {
    getSocket.mockImplementationOnce(() => {
      throw new Error('no token');
    });
    const resume = vi.fn();

    let stop: (() => void) | undefined;
    expect(() => {
      stop = jobWake('run', 'run-1')(resume);
    }).not.toThrow();
    expect(() => stop?.()).not.toThrow();
    expect(resume).not.toHaveBeenCalled();
  });

  /**
   * The same promise, for the call that decides whether to reach for the socket
   * at all. It has to sit inside the same guard as the reaching: a throw from
   * here travels out through `pollUntil` and tells a learner that a run the API
   * has accepted and is still working on "could not be checked on".
   */
  it('never fails the poll when even the socket state refuses to answer', () => {
    state.refuses = true;
    const resume = vi.fn();

    let stop: (() => void) | undefined;
    expect(() => {
      stop = jobWake('run', 'run-1')(resume);
    }).not.toThrow();
    expect(getSocket).not.toHaveBeenCalled();
    expect(() => stop?.()).not.toThrow();
    expect(resume).not.toHaveBeenCalled();
  });

  /** Regression guard: the subscribe itself is inside that guard too. */
  it('never fails the poll when the subscribe itself refuses (regression guard)', () => {
    socket.on.mockImplementationOnce(() => {
      throw new TypeError('the instance has gone');
    });
    const resume = vi.fn();

    let stop: (() => void) | undefined;
    expect(() => {
      stop = jobWake('run', 'run-1')(resume);
    }).not.toThrow();
    expect(() => stop?.()).not.toThrow();
    expect(resume).not.toHaveBeenCalled();
  });

  /** Naming a job must cost nothing: only the poll's subscribe touches the socket. */
  it('touches the socket only when a poll subscribes', () => {
    jobWake('run', 'run-1');
    expect(getSocket).not.toHaveBeenCalled();
    expect(socket.on).not.toHaveBeenCalled();
  });
});
