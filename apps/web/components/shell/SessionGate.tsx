'use client';

import { sameSession } from '@/lib/session-token';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { api, describeError, getToken, signInHref } from '@/lib/api';
import { getSession, sameProfile, setSession, subscribe } from '@/lib/session';
import { SessionEntry } from './SessionEntry';

const noServerToken = () => null;

/**
 * The longest the gate waits between
 * two checks while the server cannot be reached. The first retry comes after
 * a second and the wait doubles up to this, so a server that returns is
 * picked up within this long with nothing pressed.
 */
export const SESSION_RECONNECT_MAX_MS = 10_000;
const SESSION_RECONNECT_FIRST_MS = 1_000;

/**
 * A failure retrying can change: the request never reached the API (`fetch`
 * rejects with a TypeError), or the API said it was down, slow or busy. A
 * refusal of the account itself is left to the Try again button.
 */
function transient(reason: unknown): boolean {
  if (reason instanceof TypeError) return true;
  const status = (reason as { status?: unknown } | null)?.status;
  return typeof status === 'number' && (status === 0 || status === 408 || status === 429 || status >= 500);
}

/** Stored credentials identify the request; only the API confirms its owner.
 * The gate persists above route changes, so ordinary navigation never rechecks
 * or blanks the workspace. A replacement token must be confirmed separately. */
export function SessionGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const token = useSyncExternalStore(subscribe, getToken, noServerToken);
  const [verifiedToken, setVerifiedToken] = useState<string | null>(null);
  const [error, setError] = useState<{ token: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Consecutive transient failures for this token, for the backoff; and
  // whether the next check is the gate's own (it keeps the notice drawn
  // rather than flickering back to "Checking…").
  const failures = useRef(0);
  const quiet = useRef(false);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (!token) {
      // Hydration first uses the server's empty snapshot. The storage store
      // publishes its client snapshot next; it must not trigger a false logout
      // while an existing credential is waiting to be verified.
      if (getToken()) return;
      setVerifiedToken(null); setError(null);
      const destination = signInHref();
      if (destination) router.replace(destination);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => live && sameSession(getToken(), token);
    if (!quiet.current) setError(null);
    quiet.current = false;
    setWaiting(false);
    api.me().then(fresh => {
      if (!current()) return;
      failures.current = 0;
      if (!sameProfile(fresh, getSession())) setSession(fresh);
      setVerifiedToken(token);
    }).catch(reason => {
      if (!current()) return;
      setError({ token, message: describeError(reason, 'Your sign-in could not be checked. Try again in a moment.') });
      if (!transient(reason)) return;
      // Picked back up by itself: a bounded backoff, and the
      // `online`/`visibilitychange` effect below for an immediate attempt.
      const delay = Math.min(SESSION_RECONNECT_MAX_MS, SESSION_RECONNECT_FIRST_MS * 2 ** failures.current);
      failures.current += 1;
      setWaiting(true);
      timer = setTimeout(() => { if (current()) { quiet.current = true; setAttempt(value => value + 1); } }, delay);
    });
    return () => { live = false; if (timer !== undefined) clearTimeout(timer); };
  }, [token, attempt, router]);

  // A new token starts its own backoff.
  useEffect(() => { failures.current = 0; }, [token]);

  useEffect(() => {
    if (!waiting || typeof window === 'undefined') return;
    const now = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      quiet.current = true;
      setAttempt(value => value + 1);
    };
    window.addEventListener('online', now);
    document.addEventListener('visibilitychange', now);
    return () => { window.removeEventListener('online', now); document.removeEventListener('visibilitychange', now); };
  }, [waiting]);

  if (token && sameSession(verifiedToken, token)) return <>{children}</>;
  const problem = error?.token === token ? error.message : '';
  return <SessionEntry problem={problem} onRetry={() => setAttempt(value => value + 1)} />;
}

