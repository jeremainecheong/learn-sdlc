'use client';

import type {
  AssistantChatResponse,
  AssistantMessageView,
  AuthProviders,
  AuthResponse,
  RegisterResponse,
  DrillState,
  EnrollmentView,
  ExecutionRunView,
  LearnerAnalytics,
  PhaseDetail,
  PhaseLink,
  ProjectMapData,
  ProjectMeta,
  RunClockSaved,
  SubmissionView,
  UserProfile,
} from '@learnsdlc/shared';
import { AI_BROWSER_DEADLINE_MS, REQUEST_ID_HEADER } from '@learnsdlc/shared';
import { forgetPendingAction, rememberPendingAction } from './pending-action';
import { TOKEN_KEY, clearSession, getSession, getToken as storedToken, replaceSessionToken, setAuthSession } from './session';
import { SESSION_RENEWED_EVENT, sameSession, tokenExpiresAt } from './session-token';
import { viewAsPath, viewAsRefusal, viewingAs } from './view-as';
import { DEFAULT_API_URL } from '../public-env';
import { apiErrorMessage, authHeader, isTimeout, timeoutSignal } from './api-fetch';

/**
 * What a submission calls itself inside a sentence.
 *
 * Not the button's own words: the control reads "Submit for review" in the
 * first two phases and "Submit PR-3" and up after them, and a notice drawn by
 * the shell does not know which room the learner was in. This names the act
 * rather than the control, so the sentence is true in every phase.
 */
const SUBMISSION_LABEL = 'your submission';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL;
/** Every API route's prefix: the address and the version every call is made under. */
export const API_BASE = `${API_URL}/api/v1`;

let storageRefuses = false;

/** The token every caller and per-learner cache signs with. */
export function getToken(): string | null { return storedToken(); }

/**
 * True when this browser refused to keep the session. The session works for as
 * long as the tab is open and is gone on reload, which is worth saying out loud
 * on the way in rather than discovering at the next refresh.
 */
export function isSiteDataBlocked(): boolean {
  return storageRefuses;
}

/**
 * Whether this browser will keep anything at all, asked before there is a
 * session to lose. A write that throws is one refusal; a write that is accepted
 * and then reads back as nothing is the other, so the probe reads it back.
 */
export function probeSiteData(): boolean {
  if (typeof window === 'undefined') return true;
  const key = `${TOKEN_KEY}_probe`;
  try {
    window.localStorage.setItem(key, '1');
    const kept = window.localStorage.getItem(key) === '1';
    window.localStorage.removeItem(key);
    return kept;
  } catch {
    return false;
  }
}

/**
 * The token the session ended with.
 *
 * A 401 clears the session and sends the browser to /login, and that navigation
 * fires `pagehide`, which is what the workspace uses to flush the keystrokes
 * no debounce has fired for yet. That flush runs after `clearAuth()`, so it
 * would send its PUT with no credentials at all. The token the session had is
 * kept here for the length of that teardown so the last write is at least signed.
 */
let endingToken: string | null = null;
export function tokenAtSessionEnd(): string | null {
  return endingToken;
}

/**
 * A deliberate sign-out is on its way out (components/shell/useSignOut).
 *
 * It clears the session before it knows where it ends, and the session gate,
 * watching the token, would send the browser to /login?next=… in that gap: the
 * sign-in page then mounts before the sign-out has left its mark and never
 * says what ended. While this is held, `signInHref` answers null and the
 * sign-out makes the one navigation itself. Released as soon as it has.
 */
let leavingOnPurpose = false;
export function holdSignInRedirect(held: boolean): void {
  leavingOnPurpose = held;
}

/** The per-tab mark a managed sign-out leaves for /login (lib/auth-signout). */
export const SIGNED_OUT_KEY = 'lsdlc_signed_out';

/**
 * Where a signed-in page sends a browser that has no session, or null for
 * "do not navigate".
 *
 * Null in two cases. The session ended a moment ago, in which case the 401
 * handler below is already taking the browser to the sign-in page carrying
 * both where the learner was and why they are being asked to sign in again,
 * and a second navigation to a bare `/login` (from a page's own guard, say)
 * would erase the pair, so a learner whose token expired mid-lesson would get
 * an unexplained sign-in screen and lose their place. And the page is already
 * the sign-in page, where there is nothing to do.
 */
export function signInHref(): string | null {
  if (typeof window === 'undefined') return null;
  if (endingToken) return null;
  if (leavingOnPurpose) return null;
  const here = `${window.location.pathname}${window.location.search}`;
  if (here.startsWith('/login')) return null;
  const next = `/login?next=${encodeURIComponent(here)}`;
  return sessionEnded() ? `${next}&reason=expired` : next;
}

/** The key that carries "a session ended in this tab" across a document load. */
const ENDED_KEY = 'lsdlc_session_ended';

/**
 * Did a session end in this tab?
 *
 * `endingToken` is module state and does not survive a page load, and the load
 * is exactly when it is needed: the room the learner was in can be half-way
 * through committing when the 401 lands, so the document that then asks "is
 * there a session here?" is a new one with a fresh module and no memory of it.
 * Without this the new document would send the browser to a bare sign-in page
 * and the learner would never be told why. Per tab, and cleared by
 * the next successful sign-in.
 */
function sessionEnded(): boolean {
  try {
    return window.sessionStorage.getItem(ENDED_KEY) === '1';
  } catch {
    return false;
  }
}

/** The key that carries "and it left an unsent message behind" with it. */
const KEPT_KEY = 'lsdlc_session_kept_message';

function rememberSessionEnded(ended: boolean): void {
  try {
    if (ended) window.sessionStorage.setItem(ENDED_KEY, '1');
    // Whether anything was kept is decided by the leaving hooks, which have
    // not run yet; clearing it here is what stops the last expiry's answer
    // being read as this one's.
    else window.sessionStorage.removeItem(ENDED_KEY);
    window.sessionStorage.removeItem(KEPT_KEY);
  } catch {
    // A browser with no session storage simply loses the sentence, not the
    // redirect: `next` is in the URL either way.
  }
}

/**
 * Note that the session ending in this tab wrote an unsent message out.
 *
 * Called by whoever really wrote it: `lib/commit.ts`, from its leaving hook,
 * and only when the words can be read back. The sign-in page is a different
 * document with no session, so it cannot ask `lib/pending-action.ts` whose the
 * record is; this is the one bit it needs, and it says nothing about what was
 * typed or who typed it. Per tab, and cleared by the next sign-in.
 */
export function rememberUnsentMessageKept(): void {
  try {
    window.sessionStorage.setItem(KEPT_KEY, '1');
  } catch {
    // Then the page says only what it can keep: that the files are kept.
  }
}

/** Whether the sign-in page may say a message is waiting. */
export function unsentMessageKept(): boolean {
  try {
    return window.sessionStorage.getItem(KEPT_KEY) === '1';
  } catch {
    return false;
  }
}

/** Run before the session is torn down and the browser leaves for /login. */
type LeavingHook = () => void | Promise<void>;
const leaving = new Set<LeavingHook>();

/**
 * Register work that has to happen while the session still exists: writing
 * out what is typed, above all. Returns the unregister function.
 */
export function onSessionLeaving(fn: LeavingHook): () => void {
  leaving.add(fn);
  return () => {
    leaving.delete(fn);
  };
}

/** The longest the leaving hooks may hold a sign-out or a session ending. */
const LEAVING_HOOKS_MAX_MS = 2_000;

/** Every hook, or two seconds, whichever comes first: leaving cannot hang. */
async function runLeavingHooks(): Promise<void> {
  if (leaving.size === 0) return;
  const all = Promise.allSettled([...leaving].map(async (fn) => fn()));
  await Promise.race([all, new Promise((resolve) => setTimeout(resolve, LEAVING_HOOKS_MAX_MS))]);
}

/**
 * The signed-in profile. One read of one store: the bar, the sidebar and any
 * page that names the learner all see the same object, and none of them has to
 * wait for an effect to fill it in.
 */
export function getStoredUser(): UserProfile | null {
  return getSession();
}

export function storeAuth(auth: AuthResponse, options: { persist?: boolean } = {}): void {
  endingToken = null;
  rememberSessionEnded(false);
  // A sign-out mark /login never read belongs to the session before this one.
  try { window.sessionStorage.removeItem(SIGNED_OUT_KEY); } catch { /* nothing to spend */ }
  storageRefuses = !setAuthSession(auth.token, auth.user, options);
}

/** Validate an OAuth callback credential without replacing a live browser
 * session before the API has confirmed which profile belongs to that token. */
export async function verifyAuthToken(token: string): Promise<UserProfile> {
  const response = await fetch(`${API_BASE}/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new ApiError(response.status, 'The sign-in session could not be verified.');
  return response.json() as Promise<UserProfile>;
}

/** Ends the session here: the token, the profile and every cache keyed on it. */
export function clearAuth(): void {
  storageRefuses = false;
  clearSession();
}

/**
 * Tell the API this token is finished, everywhere.
 *
 * The token lives seven days and the API checks its version on every request,
 * so a bump there is what actually signs a learner out: clearing this
 * browser's storage alone left a token copied from a shared lab machine
 * working for the rest of the week. `keepalive` so the call survives the
 * navigation to /login that follows it, and best effort: a browser that is
 * offline still gets to sign out here.
 */
const SIGN_OUT_REVOKE_MS = 3000;

export function signOutEverywhere(token: string | null = getToken()): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (!token) return Promise.resolve();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), SIGN_OUT_REVOKE_MS);
  return fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    keepalive: true,
    signal: controller.signal,
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => clearTimeout(deadline));
}

/**
 * Work that belongs to a deliberate sign-out and to nothing else: sweeping
 * what the workspace keeps in this browser, above all.
 *
 * Not the same event as the session ending. A token the API refuses mid-edit
 * ends the session too, but the learner is still at the keyboard and about to
 * sign back in, and the draft their last keystrokes went into is the only copy
 * (see the 401 branch in `request`, and e2e/edges.spec.ts). Pressing Sign out
 * is the moment they leave the machine, and that is when their things go.
 */
type SignOutHook = () => void;
const signingOut = new Set<SignOutHook>();

/** Register work for a deliberate sign-out. Returns the unregister function. */
export function onSignOut(fn: SignOutHook): () => void {
  signingOut.add(fn);
  return () => {
    signingOut.delete(fn);
  };
}

/**
 * Sign out, in the order that loses nothing: the keystrokes no debounce has
 * fired for are written under the live token, then the token is revoked on the
 * server, then what the browser kept for this learner is swept and the session
 * is cleared here. The flush is bounded (two seconds) so the button cannot
 * hang.
 */
export async function endSession(): Promise<boolean> {
  // The button belongs to the session present when it was pressed. A Google
  // callback in another tab may replace it while saving or revoking finishes.
  const token = getToken();
  await runLeavingHooks();
  await signOutEverywhere(token);
  // The leaving hooks' saves go through `request` and may renew the token:
  // that is still this session, and it is still the one to clear.
  if (!sameSession(getToken(), token)) return false;
  signingOut.forEach((fn) => {
    try {
      fn();
    } catch {
      // one sweep failing must not keep the learner signed in
    }
  });
  if (!sameSession(getToken(), token)) return false;
  clearAuth();
  return true;
}

/**
 * The mark this tab leaves before it goes to Google, and reads back when it
 * returns.
 *
 * The callback page takes whatever token is in its URL fragment; without this
 * mark, a link somebody else built (`/login/callback#token=<their token>`)
 * would sign the learner who opened it into that somebody's account, where
 * everything they then wrote could be read back. Session storage is per tab
 * and survives the round trip through Google, and a tab that never pressed
 * the button never has the mark.
 */
const OAUTH_STARTED_KEY = 'lsdlc_oauth_started';

export function markGoogleSignInStarted(): boolean {
  try {
    window.sessionStorage.setItem(OAUTH_STARTED_KEY, '1');
    return window.sessionStorage.getItem(OAUTH_STARTED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Whether this tab started the sign-in that is now landing. Read once; the mark is spent. */
export function takeGoogleSignInStart(): boolean {
  try {
    const started = window.sessionStorage.getItem(OAUTH_STARTED_KEY) === '1';
    window.sessionStorage.removeItem(OAUTH_STARTED_KEY);
    return started;
  } catch {
    return false;
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The x-request-id the API logged the failure under; set on 5xx so a learner can quote it. */
    public requestId?: string,
    /**
     * The API's own body, for the few refusals that carry facts the page has
     * to act on rather than only a sentence: a 409 from the workspace save
     * carries the stored copy and the version to retry against.
     */
    public body?: unknown,
  ) {
    super(message);
  }
}

/**
 * `fetch` rejects with a TypeError when the request never reached the API at
 * all: server down, DNS, a blocked CORS preflight. That is not the caller's
 * credentials being wrong, and saying so sends people off resetting a password
 * that was fine.
 */
export function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) {
    return "Can't reach the server. Check your connection and try again.";
  }
  return fallback;
}

/**
 * How long a request may hold a button before it is given up on.
 *
 * Comfortably above the slowest graded route (a submission's enqueue answers
 * in milliseconds; the grading itself happens on the queue and is polled), and
 * well below "for ever". Without it a proxy holding the connection open, or
 * any route the API has not been taught to bound, spins the button until the
 * learner reloads the page.
 */
export const REQUEST_TIMEOUT_MS = 20_000;
/**
 * How long a mentor or AI call may hold its button: a reviewed reply may need
 * generation, review and one bounded revision, and the API answers within its
 * own budget below this.
 */
export const REVIEWED_AI_TIMEOUT_MS = AI_BROWSER_DEADLINE_MS;

/**
 * A managed session (the API's AUTH_PROVIDER=cognito) signs in for three
 * hours and is renewed in the background while the person is using the app,
 * so a class is not signed out mid-work. Every authenticated call passes
 * through `request`, and when the token it is about to send has less than
 * this long left, `request` also asks `POST /auth/renew` for a fresh one.
 * A local-mode token lives a week and never comes this close, so the local
 * mode and the e2e stack never renew.
 */
export const RENEW_WHEN_LEFT_MS = 2 * 60 * 60_000;
/** At most one renewal attempt this often, whatever its outcome. */
export const RENEW_RETRY_MS = 5 * 60_000;

let lastRenewalAttempt: number | null = null;

/**
 * Renew the session in the background when its token is close to running out.
 *
 * Fire and forget: the call that triggered it goes ahead with the token it
 * has, which still has the best part of two hours left. On success the new
 * token goes where the sign-in put the old one (lib/session
 * `replaceSessionToken`), and the socket is told to reconnect with it. On any
 * failure (the API's twelve-hour cap, a 401, the network) nothing changes:
 * the session runs to its `exp` and then ends through the 401 branch below,
 * with the learner's place kept. Its own fetch, not
 * `request`, so a refused renewal never takes that 401 branch itself.
 */
function renewIfDue(token: string, now: number = Date.now()): void {
  const expiresAt = tokenExpiresAt(token);
  if (expiresAt === null) return;
  const left = expiresAt - now;
  if (left <= 0 || left >= RENEW_WHEN_LEFT_MS) return;
  if (lastRenewalAttempt !== null && now - lastRenewalAttempt < RENEW_RETRY_MS) return;
  lastRenewalAttempt = now;
  void renewSession(token);
}

async function renewSession(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/auth/renew`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as Partial<AuthResponse> | null;
    if (typeof data?.token !== 'string' || !replaceSessionToken(token, data.token)) return false;
    try {
      window.dispatchEvent(new Event(SESSION_RENEWED_EVENT));
    } catch {
      // The socket then picks the new token up at its next reconnect.
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * One call to the API, signed with the session's token. Exported so feature
 * modules (lib/api-admin.ts, lib/api-instructor.ts, …) build on the same auth,
 * 401 and error handling.
 */
export async function request<T>(method: string, path: string, body?: unknown, options?: { timeoutMs?: number }): Promise<T> {
  const token = getToken();
  if (token && typeof window !== 'undefined' && !path.startsWith('/auth/')) renewIfDue(token);
  // No session, so there is nothing to sign the call with. Without this a
  // deep link opened while signed out would send the shell's whole opening
  // round anyway and log a 401 for each one in the console before the
  // redirect; the answer is known here. `/auth/` is how a session begins, so
  // it is sent unsigned.
  if (!token && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
    throw new ApiError(401, 'Sign in to see this.');
  }
  // Viewing a learner's work. The reads become their
  // instructor-scoped twins and the writes never leave the browser: this is
  // the first of the two refusals, and the API's own guards are the second.
  // `/auth/` is exempt because signing in or out is not a write to the
  // learner's work, though sign-out ends the session, and the session ending
  // ends this (lib/view-as). `/notifications` is exempt for the same reason:
  // the bell is the *instructor's own*, it names no learner, and
  // refusing to let them clear their own row while they are reading somebody's
  // work would be a refusal about the wrong account.
  const viewing = viewingAs();
  if (viewing && !path.startsWith('/auth/') && !path.startsWith('/notifications')) {
    if (method !== 'GET') throw new ApiError(403, viewAsRefusal(viewing));
    path = viewAsPath(path, viewing.userId) ?? path;
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...authHeader(token),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutSignal(options?.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // The raw abort reads "AbortError: The operation was aborted", which tells
    // a learner nothing. Say what happened and what to do.
    if (isTimeout(err)) {
      throw new ApiError(0, 'The server did not answer. Try again in a moment.');
    }
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const verifiesSession = path === '/auth/me';
    if (res.status === 401 && typeof window !== 'undefined' && (!path.startsWith('/auth/') || verifiesSession) && token === getToken()) {
      // A token that stopped working is still the only credential this session
      // has, and there may be keystrokes that no debounce has fired for yet.
      // Write them out first, while the session is still whole: `clearAuth()`
      // and the navigation below both destroy it, and the navigation's
      // `pagehide` is too late for the workspace to save.
      endingToken = getToken();
      // Written before anything else: the navigation below can be overtaken by
      // a document that was already loading, and that document has to be able
      // to tell an expired session from a visitor who never had one.
      rememberSessionEnded(true);
      await runLeavingHooks();
      // A different account can arrive while the old request or its final
      // save is pending. Its credentials and private state belong to it.
      if (getToken() !== token) throw new ApiError(401, 'The earlier session has ended.');
      clearAuth();
      // The socket authenticates once, at handshake time, so it stays joined to
      // this user's room long after the token stops working. Pulled in lazily:
      // a static import would put the socket client in the bundle of every page
      // that talks to the API, and where no socket was opened this is a no-op.
      import('./socket')
        .then((m) => { if (!getToken()) m.closeSocket(); })
        .catch(() => undefined);
      const here = `${window.location.pathname}${window.location.search}`;
      // Already there. A room fires several calls at once, so the second and
      // third 401s land after the first has taken the browser to the sign-in
      // page, and navigating again to a bare `/login` would throw away both
      // the place the learner was and the sentence saying why they are here.
      // Nothing to do: the page is the one this handler would have asked for.
      if (here.startsWith('/login')) throw new ApiError(401, 'Sign in to see this.');
      // Carry where they were, so signing back in returns them to the phase
      // they were mid-way through instead of a generic dashboard.
      // The sign-in page says why it is being shown. A room that turned into
      // a sign-in screen with no sentence would read as the product losing
      // the learner's place rather than the session ending.
      window.location.href = `/login?next=${encodeURIComponent(here)}&reason=expired`;
    }
    const message = apiErrorMessage(data, `request failed (${res.status})`);
    // A 4xx message already tells the learner what to change. A 5xx tells
    // them nothing they can act on, so it carries the reference the API
    // logged the failure under: the one thing support can search for.
    const requestId =
      res.status >= 500 ? (data as { requestId?: string }).requestId || res.headers.get(REQUEST_ID_HEADER) || undefined : undefined;
    throw new ApiError(
      res.status,
      requestId ? `${message} (reference ${requestId})` : message,
      requestId,
      data,
    );
  }
  return data as T;
}

/** What the learner writes into INCIDENT-1 to close the drill. */
export type DrillIncident = NonNullable<DrillState['incident']>;

/**
 * Starting the drill also runs the smoke check against the faulted copy, so the
 * learner can read the failure they were paged for before touching anything.
 */
export interface DrillStartResult extends DrillState {
  beforeStderr?: string;
}

/** One run of the smoke check against whatever the learner has saved now. */
export interface DrillHealthResult {
  exit: number;
  stdout: string;
  stderr: string;
  /** The command the check ran, taken from the learner's own ENTRYPOINT. */
  startedBy?: string;
}

/**
 * Where the browser goes to start a Google sign-in. A full navigation to the
 * API rather than a fetch: the whole point of the flow is that the person
 * visits Google themselves, and the API needs to set the redirect. `next` is
 * carried through Google and comes back on the callback page.
 */
export function googleSignInUrl(next?: string): string {
  const query = next ? `?next=${encodeURIComponent(next)}` : '';
  return `${API_BASE}/auth/google${query}`;
}

export function ssoSignInUrl(provider: string, next?: string): string {
  const query = new URLSearchParams({ provider });
  if (next) query.set('next', next);
  return `${API_BASE}/auth/sso/start?${query}`;
}

export const api = {
  /** Which ways in this deployment has. Cheap, public, and read before the page draws. */
  providers: () => request<AuthProviders>('GET', '/auth/providers'),
  register: (email: string, password: string, displayName: string) =>
    request<RegisterResponse>('POST', '/auth/register', { email, password, displayName }),
  confirmRegistration: (email: string, code: string) => request<{ confirmed: true }>('POST', '/auth/confirm', { email, code }),
  resendConfirmation: (email: string) => request<{ sent: true; message?: string }>('POST', '/auth/confirm/resend', { email }),
  login: (email: string, password: string) =>
    request<AuthResponse>('POST', '/auth/login', { email, password }),
  me: () => request<UserProfile>('GET', '/auth/me'),

  projects: () => request<ProjectMeta[]>('GET', '/projects'),
  /**
   * Start a project.
   *
   * Called with nothing, it asks the server to start **the project this
   * learner has been given**: their class's, or the one this deployment
   * starts everybody on. That is the call setup makes, because the browser
   * does not know the answer and what it has instead is the slug the tab
   * remembered, which on a shared machine is the previous account's.
   *
   * Called with a slug, the slug is a claim the server checks against the
   * same answer and refuses in one sentence. No page sends one: a caller that
   * sent `catalogue[0]` would, for a member of staff, start whichever
   * published project sorted first.
   */
  enroll: (projectSlug?: string) =>
    request<EnrollmentView>('POST', '/enrollments', projectSlug ? { projectSlug } : {}),
  /**
   * The caller's enrolment in one project, or in **the project the server
   * resolves for them** when none is named.
   *
   * The argument has no default: a default slug would always be sent, and
   * `GET /enrollments/mine`'s server-side resolution (the learner's own
   * enrolment, then their class's assignment, then the deployment's named
   * project, then the default) could never run. Called with nothing, it
   * sends no query string at all, which is the request that asks the server
   * the question.
   */
  myEnrollment: (project?: string) =>
    request<EnrollmentView | null>(
      'GET',
      project
        ? `/enrollments/mine?project=${encodeURIComponent(project)}`
        : '/enrollments/mine',
    ),

  phase: (id: string) => request<PhaseDetail>('GET', `/phases/${id}`),
  /**
   * The same phase without its file bodies and without its brief. What the
   * shell holds for every open phase: `files` is an index
   * carrying `lines` and `touched`, and `view` is `'summary'` so a reader that
   * needs a body knows to ask for one. See PhaseDetail.view.
   */
  phaseSummary: (id: string) => request<PhaseDetail>('GET', `/phases/${id}?view=summary`),
  /**
   * Every open phase of one enrolment, in the summary view, in one request.
   * Six separate requests would give the same answer for six round trips.
   */
  phaseSummaries: (slug: string) =>
    request<PhaseDetail[]>('GET', `/phases/summaries?project=${encodeURIComponent(slug)}`),
  /**
   * Every open phase's submissions, runs and reviewer thread, in one request.
   * Asked three per phase, /journal would cost 31 requests and /dossier 42;
   * this is the same answer asked once.
   */
  phaseRecords: (slug: string) =>
    request<
      Record<
        string,
        { submissions: SubmissionView[]; runs: ExecutionRunView[]; chat: AssistantMessageView[] }
      >
    >('GET', `/phases/records?project=${encodeURIComponent(slug)}`),
  /**
   * The project map, built by the API from the files it already holds.
   *
   * `compact` folds given stories and per-function tests into blocks (Home's
   * card) and `showLocked` adds the "opens in phase N" placeholders. Neither
   * shape can be derived from the other, so the caller says which it draws.
   */
  projectMap: (project: string, opts: { compact?: boolean; showLocked?: boolean } = {}) =>
    request<ProjectMapData>(
      'GET',
      `/projects/${project}/map?compact=${opts.compact ? 1 : 0}&showLocked=${opts.showLocked === false ? 0 : 1}`,
    ),
  /**
   * `baseVersion` is the `workspaceUpdatedAt` this tab last saw. Sent, the API
   * refuses with 409 rather than writing over a save this tab never saw; left
   * out, the write lands unconditionally.
   */
  saveWorkspace: (id: string, files: Record<string, string>, baseVersion?: string) =>
    request<{ saved: boolean; version: string }>('PUT', `/phases/${id}/workspace`, {
      files,
      ...(baseVersion === undefined ? {} : { baseVersion }),
    }),
  run: (id: string) => request<ExecutionRunView>('POST', `/phases/${id}/run`),
  /**
   * Submit, with what the learner said this revision changes.
   *
   * The message is optional in fact as well as in type: with nothing typed the
   * body is left off entirely, which is the shape the journey scripts and e2e
   * specs send. Submitting is never gated on the prose.
   *
   * `taskKey` names which task of the phase this revision answers. It is left
   * out (and the plain phase route is the one that is called) wherever the
   * phase has one task, which is every phase of every project until a teacher
   * splits a written one or adds a quiz beside its work. The phase
   * route resolves *the phase's only task* itself and refuses a phase that has
   * several by name, so the rule about when to send a key lives in one place
   * (`taskKeyToSubmit`) and never in a room's own judgement.
   *
   * The intent is written down around the request, because a session can end
   * under the click and the 401 branch above takes the
   * browser away before any `catch` here can draw a thing. A 401 leaves the
   * record for the shell to speak for once the learner is back; every other
   * answer, refusal included, clears it, so the only thing that can ever claim
   * a submission was not recorded is a submission that really was interrupted.
   * The record stays keyed by **phase**: there is one workspace and one
   * interrupted click to speak for, whichever task it named.
   */
  submit: async (id: string, message?: string, taskKey?: string): Promise<SubmissionView> => {
    rememberPendingAction({ kind: 'submit', phaseId: id, label: SUBMISSION_LABEL, text: message });
    const path =
      taskKey === undefined
        ? `/phases/${id}/submit`
        : `/phases/${id}/tasks/${encodeURIComponent(taskKey)}/submit`;
    try {
      const started = await request<SubmissionView>('POST', path, message ? { message } : undefined);
      forgetPendingAction(id);
      return started;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) forgetPendingAction(id);
      throw err;
    }
  },
  /**
   * Pin what the sandbox calls today for this phase, or clear it back to the
   * machine's clock with `null`. Testing only; the API refuses
   * any other phase. It spends no attempt and invalidates no verdict.
   */
  setClock: (id: string, date: string | null) =>
    request<RunClockSaved>('PUT', `/phases/${id}/clock`, { date }),
  reflect: (id: string, reflection: string) =>
    request<{ saved: boolean }>('POST', `/phases/${id}/reflect`, { reflection }),
  advance: (id: string) => request<EnrollmentView>('POST', `/phases/${id}/advance`),

  /**
   * Every verdict for a phase, oldest first, capped at 50 by the API. No
   * snapshots.
   *
   * The phase route resolves the phase's **only** task and refuses a phase a
   * teacher has split, exactly as the submit route does, so the task is named
   * the same way here as it is there: nothing at all where the phase has one
   * task, and the task's own route where it has more.
   */
  submissions: (id: string, taskKey?: string) =>
    request<SubmissionView[]>(
      'GET',
      taskKey === undefined
        ? `/phases/${id}/submissions`
        : `/phases/${id}/tasks/${encodeURIComponent(taskKey)}/submissions`,
    ),
  /** Every sandbox run for a phase, oldest first, capped at 50 by the API. */
  runs: (id: string) => request<ExecutionRunView[]>('GET', `/phases/${id}/runs`),
  /** Replaces the phase's link set; the API caps it at 200. */
  saveLinks: (id: string, links: PhaseLink[]) =>
    request<{ saved: boolean }>('PUT', `/phases/${id}/links`, { links }),

  drillStart: (id: string) => request<DrillStartResult>('POST', `/phases/${id}/drill/start`),
  drillHealth: (id: string) => request<DrillHealthResult>('POST', `/phases/${id}/drill/health`),
  /** 409 while the smoke check still fails, with the message to show the learner. Answers the drill and its own new save stamp, which the next save quotes. */
  drillResolve: (id: string, incident: DrillIncident) =>
    request<DrillState & { workspaceUpdatedAt: string | null }>('POST', `/phases/${id}/drill/resolve`, { incident }),

  getRun: (id: string) => request<ExecutionRunView>('GET', `/runs/${id}`),
  getSubmission: (id: string) => request<SubmissionView>('GET', `/submissions/${id}`),
  /**
   * The same submission with the files it was graded on. Separate because this
   * one is polled every 1.2s while a submission grades and the other is opened
   * once, by hand: the snapshot is a full copy of the workspace.
   */
  getSubmissionWithFiles: (id: string) =>
    request<SubmissionView>('GET', `/submissions/${id}?include=snapshot`),

  chat: (phaseStateId: string, message: string) =>
    request<AssistantChatResponse>('POST', '/assistant/chat', { phaseStateId, message }, { timeoutMs: REVIEWED_AI_TIMEOUT_MS }),
  chatHistory: (phaseStateId: string) =>
    request<AssistantMessageView[]>('GET', `/assistant/history/${phaseStateId}`),

  analyticsMe: (project?: string) =>
    request<LearnerAnalytics>(
      'GET',
      project ? `/analytics/me?project=${encodeURIComponent(project)}` : '/analytics/me',
    ),

  updateProfile: (displayName: string, baseVersion?: number) =>
    request<UserProfile>('PATCH', '/account/profile', { displayName, baseVersion }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ changed: true }>('POST', '/account/password', { currentPassword, newPassword }),
  exportAccount: () => request<Record<string, unknown>>('GET', '/account/export'),
  // The email is echoed back and checked server-side against the account row,
  // so a mis-click cannot destroy a term's work.
  deleteAccount: (email: string) => request<{ deleted: true }>('DELETE', '/account', { email }),
};
