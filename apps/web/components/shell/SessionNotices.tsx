'use client';

/**
 * Two lines about the session itself, drawn once for every signed-in page.
 *
 * A managed deployment signs a session that lives one hour
 * (`apps/api/src/auth/auth.service.ts`, `issueSession`), and there is no
 * refresh endpoint to extend it: the `auth` controllers mint a session at
 * sign-in, at registration and at the two provider callbacks and nowhere else.
 * So the hour can end in the middle of work, and the first Submit after it
 * would go nowhere with nothing on screen to say so. These are the two
 * sentences that say so:
 *
 * - {@link SessionEndingLine}, while the hour is nearly up, offering the one
 *   action that actually helps: signing in again, back to this page.
 * - {@link SessionInterruptedLine}, once the learner is back, naming the
 *   submission that was not recorded and putting their words back in the
 *   field, and taking itself off the screen the moment that submission is
 *   recorded, because the shell outlives the navigation back into the room.
 *
 * Both say only what the product really keeps. The files are saved as they are
 * typed; what is typed into the mentor panel is not, so neither line claims
 * "your work".
 *
 * Both are modelled on `OfflineBanner` in AppFrame, the shell's existing
 * one-line notice: the same slot and the same shape, so nothing below them
 * moves. Both are `role="status"` with `aria-live="polite"` and never `alert`;
 * neither takes focus; neither animates.
 *
 * What this does **not** do, deliberately: it does not extend the token, it
 * does not refresh it silently (there is nothing on the server to refresh
 * against), and it changes nothing about how a 401 is handled. It reads the
 * `exp` claim the browser already holds, which is a decision about a line of
 * text and never about authorisation; the API re-verifies every request. The
 * token itself is never rendered, never logged and never copied anywhere.
 */
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getToken } from '@/lib/api';
import { restoreCommitDrafts, stashCommitDrafts } from '@/lib/commit';
import {
  forgetPendingAction,
  onPendingActionsChanged,
  readAnyPendingAction,
  readPendingAction,
  type PendingAction,
} from '@/lib/pending-action';
import { expiryState, minutesLeftLabel, tokenExpiresAt } from '@/lib/session-expiry';
import { useSession } from '@/lib/session';

/** The shell's one-line notice, as the offline banner draws it. */
const LINE = 'print-hide shrink-0 border-b-1.5 border-warn/30 bg-warntint px-4 py-1.5 text-center text-[12.5px] text-warn';
/** The shared style of the two controls these lines offer. */
const CONTROL = 'font-medium underline decoration-warn/40 underline-offset-2';
/** Often enough to be current, rarely enough to be free beside the polls already running. */
const RECHECK_MS = 30_000;

/**
 * Put the keyboard back on the page after a notice the learner dismissed goes
 * away.
 *
 * Both controls here are inside the line they remove, so without this the
 * caret is dropped on the document and the learner's next Tab starts again at
 * the top of the shell: several stops from the room they were working in.
 * `#main` is the target of the skip link in app/layout.tsx, and it is the page
 * shells that carry it: `WorkPage` and `DocPage` for the signed-in rooms,
 * `PageLoading`, `SessionEntry` and the two landing layouts for the rest, each
 * with `tabIndex={-1}`. That is the stop the shell already treats as "the
 * page". A route drawn without one of those shells carries no `#main`, which
 * is why the call below is optional rather than asserted.
 */
function returnFocusToPage(): void {
  if (typeof document === 'undefined') return;
  document.getElementById('main')?.focus();
}

function SessionEndingLine() {
  const user = useSession();
  const path = usePathname();
  /** Hidden for the rest of this document, and back after a reload. */
  const [hidden, setHidden] = useState(false);
  const [left, setLeft] = useState<string | null>(null);
  const [here, setHere] = useState('/');

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const read = () => {
      const expiresAt = tokenExpiresAt(getToken());
      const now = Date.now();
      const state = expiryState(expiresAt, now);
      // Read from the document rather than from a hook, so the link carries
      // the query the learner was on without any page becoming dynamic for it.
      setHere(`${window.location.pathname}${window.location.search}`);
      setLeft(state === 'ending' && expiresAt !== null ? minutesLeftLabel(expiresAt, now) : null);
      // Nothing left to watch: either no expiry this can read, or the hour is
      // already up, in which case the next request is what says so.
      if (state === 'unknown' || state === 'ended') stop();
    };
    timer = setInterval(read, RECHECK_MS);
    read();
    // A laptop that slept comes back with the hour gone, and the tick alone
    // would be up to half a minute late saying it.
    document.addEventListener('visibilitychange', read);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', read);
    };
  }, [user?.id, path]);

  if (hidden || !left) return null;
  return (
    <div role="status" aria-live="polite" data-testid="session-ending" className={LINE}>
      {/* `role="status"` is atomic: any change inside it is the whole sentence
          read out again, and the minutes change five times across the warning
          window. So the count is drawn for the eye alone and the words a
          screen reader is handed never move: announced once, when the line
          appears. "soon" is true for every minute of that window. */}
      Your sign-in ends <span aria-hidden="true">in {left}</span>
      <span className="sr-only">soon</span>. Your files are saved as you type.{' '}
      <a
        data-testid="session-ending-signin"
        href={`/login?next=${encodeURIComponent(here)}`}
        // Under the live session, so the sentence a learner is part-way
        // through survives a voluntary re-entry too. The workspace's own
        // `pagehide` listener already writes out the files.
        onClick={() => stashCommitDrafts()}
        className={CONTROL}
      >
        Sign in again to keep going
      </a>
      <button
        type="button"
        data-testid="session-ending-hide"
        onClick={() => {
          returnFocusToPage();
          setHidden(true);
        }}
        className={`ml-3 ${CONTROL}`}
      >
        Hide
      </button>
    </div>
  );
}

function SessionInterruptedLine() {
  const user = useSession();
  const [record, setRecord] = useState<PendingAction | null>(null);

  useEffect(() => {
    // The words first, so they are in the field before the learner goes looking
    // for them. Then the sentence, and only for an attempt that was really
    // made: a message typed and never sent is not a submission that was lost.
    restoreCommitDrafts();
    const pending = readAnyPendingAction();
    const interrupted = pending?.kind === 'submit' ? pending : null;
    setRecord(interrupted);
    if (!interrupted) return;
    // The shell is mounted once for the whole tab, so this sentence outlives
    // every navigation: including the one back into the room the learner
    // then submits from. `api.submit` forgets the record the moment the API
    // has the submission; without hearing that, the line goes on saying the
    // submission was not recorded over the room where it now has been, with
    // "Submit again" under it. Only the record this line is about is watched:
    // the same call writes the record again as it sends, and that is the
    // attempt being made rather than one that was lost.
    return onPendingActionsChanged(() => {
      if (!readPendingAction(interrupted.phaseId)) setRecord(null);
    });
  }, [user?.id]);

  if (!record) return null;
  return (
    <div role="status" aria-live="polite" data-testid="session-interrupted" className={LINE}>
      You were signed out before {record.label} was recorded. Your files are kept
      {record.text ? ' and what you typed is back in the field' : ''}. Submit again when you are
      ready.
      <button
        type="button"
        data-testid="session-interrupted-dismiss"
        onClick={() => {
          returnFocusToPage();
          forgetPendingAction(record.phaseId);
          setRecord(null);
        }}
        className={`ml-3 ${CONTROL}`}
      >
        Dismiss
      </button>
    </div>
  );
}

export function SessionNotices() {
  return (
    <>
      <SessionEndingLine />
      <SessionInterruptedLine />
    </>
  );
}
