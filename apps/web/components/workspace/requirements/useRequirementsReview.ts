'use client';

import { sameSession } from '@/lib/session-token';
import { useEffect, useRef, useState } from 'react';
import type { SubmissionView } from '@learnsdlc/shared';
import { api, getToken } from '@/lib/api';

export const reviewPending = (submission: SubmissionView | null | undefined) =>
  submission?.status === 'queued' || submission?.status === 'running';

/** A delayed phase read must not undo a result or replace a newer revision. */
export function latestSubmission(current: SubmissionView | null, next: SubmissionView | null): SubmissionView | null {
  if (!current) return next;
  if (!next) return current;
  if (current.id === next.id && !reviewPending(current) && reviewPending(next)) return current;
  if (Date.parse(current.createdAt) > Date.parse(next.createdAt)) return current;
  return next;
}

/** Watch the persisted job ID, including one restored after a reload. */
export function useRequirementsReview(
  submission: SubmissionView | null,
  onUpdate: (submission: SubmissionView) => void,
  onSettled: () => void,
) {
  const [connectionError, setConnectionError] = useState('');
  const callbacks = useRef({ onUpdate, onSettled });
  callbacks.current = { onUpdate, onSettled };
  const pendingId = reviewPending(submission) ? submission!.id : null;

  useEffect(() => {
    setConnectionError('');
    if (!pendingId) return;
    const owner = getToken();
    let stopped = false;
    let requesting = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !stopped && sameSession(getToken(), owner);
    const poll = async () => {
      if (!current() || requesting) return;
      if (timer) clearTimeout(timer);
      requesting = true;
      try {
        const result = await api.getSubmission(pendingId);
        if (!current()) return;
        if (result.id !== pendingId) throw new Error('The review response did not match this submission.');
        failures = 0;
        setConnectionError('');
        callbacks.current.onUpdate(result);
        if (!reviewPending(result)) {
          stopped = true;
          callbacks.current.onSettled();
          return;
        }
      } catch {
        if (!current()) return;
        failures += 1;
        setConnectionError('Your review is still pending. Reconnecting to retrieve its result…');
      } finally {
        requesting = false;
        if (current()) timer = setTimeout(() => void poll(), Math.min(10_000, 1200 * 2 ** Math.min(failures, 4)));
      }
    };
    const reconnect = () => { if (document.visibilityState !== 'hidden') void poll(); };
    void poll();
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', reconnect);
      document.removeEventListener('visibilitychange', reconnect);
    };
  }, [pendingId]);

  return connectionError;
}
