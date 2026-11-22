'use client';

/**
 * The live preview, as one hook.
 *
 * Everything the panel draws is derived here and every derivation that can be
 * a pure function is one, exported above the hook: the pane's state, how often
 * to poll it, the console tail's cursor arithmetic and the minutes left. The
 * hook itself is the part that cannot be pure: the request, the interval and
 * the one piece of state the API hands over exactly once.
 *
 * Three rules it keeps:
 *  - the capability is held, never rederived. `POST` answers `url` once; a
 *    status poll never repeats it, so losing it means the frame goes back to
 *    a restart/stop recovery state rather than pointing at a guess;
 *  - polling stops when the tab is hidden and when the session is settled. A
 *    class of thirty with a workspace open in a background tab is thirty polls
 *    a second the API does not owe anybody;
 *  - a failed poll is swallowed. The app is running or it is not, and the
 *    panel saying "could not reach the server" about a decoration on top of an
 *    iframe that is working is worse than the panel being a second old.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PreviewLogLine,
  PreviewSessionView,
  PreviewStatus,
  PreviewUnsupported,
} from '@learnsdlc/shared';
import { ApiError } from '@/lib/api';
import { previewApi, stopPreviewOnExit } from '@/lib/api-preview';
import { problemCount } from './preview/log';

/* ------------------------------ the pure half ----------------------------- */

/**
 * How many console lines the panel keeps. The runner's own ring is 400 lines,
 * so anything above that only ever holds what the runner has
 * already forgotten.
 */
export const CONSOLE_MAX = 400;

/** Every two seconds while it boots, every fifteen once it is up. */
export const POLL_STARTING_MS = 2_000;
export const POLL_READY_MS = 15_000;

/**
 * The first ask after a start, which is not the cadence.
 *
 * A small application is serving well inside two seconds, and a first ask at
 * the cadence would leave a panel with nothing to say yet: the one wait in
 * this feature a learner watches from the moment they press. The cadence above
 * is right for the fifth ask and wrong for the first, so they are two numbers.
 * One extra request per start, and only while the app is booting.
 */
export const POLL_FIRST_MS = 750;

/** Under this much of the hard cap left, the panel says so. */
export const WARN_MINUTES = 2;

const STOP_ERROR = 'Your app could not be stopped. It may still be running. Try Stop again.';

/**
 * What the pane is showing.
 *
 * `idle` is the client's own word for "the GET answered null": the learner
 * has never started anything on this phase. The other six are the API's own
 * `status`, unchanged, because a second vocabulary for the same six states is
 * a second place to be wrong.
 */
const STATUSES: PreviewStatus[] = [
  'idle',
  'starting',
  'ready',
  'failed',
  'stopped',
  'busy',
  'unavailable',
];

export function paneState(
  session: PreviewSessionView | null,
  unsupported: PreviewUnsupported = null,
): PreviewStatus {
  // A deployment that cannot preview says so before anything is asked of it:
  // the phase carries the reason, so the tab is never drawn empty while a
  // request finds out what the page already knew.
  if (unsupported) return 'unavailable';
  // Anything that is not one of the seven is "nothing is running", not a
  // seventh state the panel has no block for. The panel draws exactly one of
  // these and a value outside the set would draw none of them: which is what
  // an empty body from the API did, until `previewApi.status` normalised it.
  if (!session || !STATUSES.includes(session.status)) return 'idle';
  return session.status;
}

/** How long until the next poll, or null when there is nothing to watch. */
export function pollIntervalMs(status: PreviewStatus): number | null {
  if (status === 'starting') return POLL_STARTING_MS;
  if (status === 'ready') return POLL_READY_MS;
  return null;
}

/**
 * How long until the *first* poll of a state, which only a booting app
 * shortens. Null wherever {@link pollIntervalMs} is null: a state nothing
 * watches is not watched sooner either.
 */
export function firstPollDelayMs(status: PreviewStatus): number | null {
  if (status === 'starting') return POLL_FIRST_MS;
  return pollIntervalMs(status);
}

export interface ConsoleTail {
  lines: PreviewLogLine[];
  /** What to send as `?cursor=` on the next poll. */
  cursor: number;
}

export const EMPTY_TAIL: ConsoleTail = { lines: [], cursor: 0 };

/**
 * The console tail after an answer, and the cursor to ask with next time.
 *
 * The API answers only what was written since the cursor it was given, so the
 * ordinary case is an append. Two cases are not: an answer whose cursor is
 * behind the one we hold is a *different* session (a second start restarts the
 * count at zero), and its lines replace the tail rather than being appended to
 * somebody else's; and an answer that carries no new lines must still move the
 * cursor, or a quiet app is asked for the same nothing for ever.
 */
export function nextTail(held: ConsoleTail, answer: PreviewSessionView | null): ConsoleTail {
  if (!answer) return EMPTY_TAIL;
  const incoming = answer.console ?? [];
  const cursor = typeof answer.cursor === 'number' ? answer.cursor : held.cursor;
  if (cursor < held.cursor) return { lines: incoming.slice(-CONSOLE_MAX), cursor };
  if (incoming.length === 0) return held.cursor === cursor ? held : { ...held, cursor };
  return { lines: [...held.lines, ...incoming].slice(-CONSOLE_MAX), cursor };
}

/**
 * The lines a learner should look at, which is the count the tab carries.
 *
 * Not the lines on stderr. Flask writes its startup banner and every
 * access log line there, so the stream count would put a red "4" on a working app's
 * Console tab before it had served anything but a 200. `problemCount` reads
 * the lines instead.
 */
export function errorCount(lines: PreviewLogLine[]): number {
  return problemCount(lines);
}

/**
 * Minutes left of the hard cap, or null while there are more than two: the
 * panel says nothing about a limit that is not close.
 */
export function minutesLeftOf(expiresAt: string | null, now: number = Date.now()): number | null {
  if (!expiresAt) return null;
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return null;
  const minutes = (at - now) / 60_000;
  if (minutes > WARN_MINUTES) return null;
  return Math.max(0, minutes);
}

/* --------------------------------- the hook -------------------------------- */

export interface PreviewController {
  status: PreviewStatus;
  session: PreviewSessionView | null;
  /** `/api/v1/preview/<capability>/`, held from the answer to the start. */
  url: string | null;
  /** Bumped by Refresh, so the frame reloads rather than being left to cache. */
  nonce: number;
  console: PreviewLogLine[];
  errors: number;
  /** True between the button being pressed and the first answer. */
  starting: boolean;
  error: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => void;
}

export function usePreview({
  phaseId,
  canPreview,
  unsupported = null,
}: {
  phaseId: string;
  canPreview: boolean;
  unsupported?: PreviewUnsupported;
}): PreviewController {
  const [session, setSession] = useState<PreviewSessionView | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [tail, setTail] = useState<ConsoleTail>(EMPTY_TAIL);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const sessionIdRef = useRef<string | null>(null);
  // The cursor the next poll asks with, read inside the interval without
  // making the interval depend on it.
  const tailRef = useRef(tail);
  tailRef.current = tail;
  const alive = useRef(true);
  // The phase this hook is currently for. The sidebar swaps phases without
  // remounting the workspace, so an answer that arrives after the swap must
  // not be written into the new phase's panel.
  const phaseRef = useRef(phaseId);
  phaseRef.current = phaseId;
  /**
   * Which session this panel is about, counted up by every start and every
   * stop.
   *
   * A start stops the learner's previous session before
   * it makes the new one, so a status poll that was already in flight comes
   * back saying `stopped`, reason `learner`: and if it lands after the start's
   * own answer it overwrites a booting application with "You stopped the app.",
   * where `pollIntervalMs` is null and nothing ever asks again. The panel would
   * sit there, correct about a session that was two seconds old and wrong about
   * the one the learner was waiting for.
   */
  const epoch = useRef(0);
  /**
   * How many starts or stops are in flight. A poll that *begins* while one is
   * would come back with an epoch that still looks current, so the epoch alone
   * is not enough: a poll fired inside that window is skipped outright.
   */
  const inFlight = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A phase change is a different application: drop everything, including the
  // capability, rather than pointing the frame at the previous phase's app.
  useEffect(() => {
    epoch.current += 1;
    setSession(null);
    sessionIdRef.current = null;
    setUrl(null);
    setTail(EMPTY_TAIL);
    tailRef.current = EMPTY_TAIL;
    setError('');
    setStarting(false);
  }, [phaseId]);

  const take = useCallback((phase: string, at: number, next: PreviewSessionView | null, replaceConsole = false) => {
    if (!alive.current || phaseRef.current !== phase || epoch.current !== at) return;
    // A preview started in another tab has a different private door. Never
    // leave this tab displaying the old capability beside the new session.
    const changedSession = (next?.id ?? null) !== sessionIdRef.current;
    if (changedSession && !next?.url) setUrl(null);
    sessionIdRef.current = next?.id ?? null;
    setSession(next);
    const nextConsole = nextTail(changedSession || replaceConsole ? EMPTY_TAIL : tailRef.current, next);
    tailRef.current = nextConsole;
    setTail(nextConsole);
    // A lost Stop response can still have stopped the process. Once a later
    // status confirms that, the old retry guidance is no longer accurate.
    if (next?.status === 'stopped') setError(held => held === STOP_ERROR ? '' : held);
    if (next?.url) setUrl(next.url);
    // The door is dead the moment the session is: keeping the url would leave
    // a frame pointing at a 404 and an "Open in a new tab" that lies.
    if (!next || (next.status !== 'starting' && next.status !== 'ready')) setUrl(null);
  }, []);

  const start = useCallback(async () => {
    if (!canPreview) return;
    const phase = phaseId;
    const at = ++epoch.current;
    inFlight.current += 1;
    setStarting(true);
    setError('');
    // A second start is a new application with a new console; keeping the old
    // tail would attribute the last app's traceback to this one.
    setTail(EMPTY_TAIL);
    tailRef.current = EMPTY_TAIL;
    try {
      take(phase, at, await previewApi.start(phase));
    } catch (err) {
      if (!alive.current || phaseRef.current !== phase || epoch.current !== at) return;
      // A refusal the API worded is the reason, and "try again" is not true of
      // it, so it is shown rather than replaced by the generic sentence. A
      // transport failure or a 5xx still gets the generic sentence.
      const refused = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.message.trim();
      setError(refused ? err.message.trim() : 'Your app could not be started. Try again in a moment.');
    } finally {
      inFlight.current -= 1;
      if (alive.current && phaseRef.current === phase && epoch.current === at) setStarting(false);
    }
  }, [phaseId, canPreview, take]);

  const stop = useCallback(async () => {
    const phase = phaseId;
    const at = ++epoch.current;
    inFlight.current += 1;
    setError('');
    try {
      const answer = await previewApi.stop(phase);
      if (answer?.stopped !== true) throw new Error('Stop was not confirmed');
    } catch {
      if (alive.current && phaseRef.current === phase && epoch.current === at) {
        setError(STOP_ERROR);
      }
      // Keep the last known session and its private link so the learner can
      // retry. A failed request is not evidence that the process stopped.
      return;
    } finally {
      inFlight.current -= 1;
    }
    if (!alive.current || phaseRef.current !== phase || epoch.current !== at) return;
    setUrl(null);
    setSession((held) =>
      held ? { ...held, status: 'stopped', url: null, stopReason: 'learner' } : held,
    );
  }, [phaseId]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const status = paneState(session, unsupported);

  /* -------------------------------- the poll ------------------------------- */

  useEffect(() => {
    if (!canPreview || unsupported) return;
    const every = pollIntervalMs(status);
    if (every === null) return;
    // Only the timer armed here is shortened; every re-arm inside `ask` keeps
    // the cadence.
    const first = firstPollDelayMs(status);
    const phase = phaseId;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let live = true;

    const ask = async (): Promise<void> => {
      const at = epoch.current;
      // A start or a stop is a better answer than any poll, and it is already
      // on its way.
      if (inFlight.current > 0) {
        if (live) timer = setTimeout(() => void ask(), every);
        return;
      }
      // A hidden tab is a learner who is not looking. The poll resumes on the
      // visibility change below, and the session's idle cap is what decides
      // whether the app is still there when they come back.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        if (live) timer = setTimeout(() => void ask(), every);
        return;
      }
      try {
        const cursor = tailRef.current.cursor;
        const next = await previewApi.status(phase, cursor);
        if (!live) return;
        if (!alive.current || phaseRef.current !== phase || epoch.current !== at) return;
        if (next && next.id !== sessionIdRef.current && cursor > 0) {
          // This answer was requested with the previous app's cursor. Even a
          // larger new cursor may omit this app's first lines; never append it
          // to the old console or mistake it for a complete replacement.
          take(phase, at, { ...next, console: [], cursor: 0 });
          const replacementId = next.id;
          const complete = await previewApi.status(phase, 0);
          if (sessionIdRef.current === replacementId) take(phase, at, complete, true);
        } else {
          take(phase, at, next);
        }
      } catch {
        // Swallowed: see the header. The next poll is the retry.
      }
      if (live) timer = setTimeout(() => void ask(), every);
    };

    timer = setTimeout(() => void ask(), first ?? every);
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void ask();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [phaseId, canPreview, unsupported, status, take]);

  // The first poll on arrival: a learner who reloads the workspace with their
  // app already running gets the frame back rather than an idle panel. It asks
  // once and then the interval above takes over.
  useEffect(() => {
    if (!canPreview || unsupported) return;
    const phase = phaseId;
    const at = epoch.current;
    let live = true;
    void previewApi
      .status(phase, 0)
      .then((next) => {
        if (live) take(phase, at, next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [phaseId, canPreview, unsupported, take]);

  return {
    status,
    session,
    url,
    nonce,
    console: tail.lines,
    errors: errorCount(tail.lines),
    starting: starting || status === 'starting',
    error,
    start,
    stop,
    refresh,
  };
}

export { stopPreviewOnExit };
