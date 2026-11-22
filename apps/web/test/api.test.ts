/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authResult } from './fixtures';

/**
 * The one function every request in the app goes through.
 *
 * What it decides is not "did the call work": it is what a learner is told
 * when it did not. A dead connection must not read as a wrong password, a 5xx
 * must carry the reference support can search for, an expiring token must not
 * take the keystrokes with it, and a browser that keeps nothing must not
 * become a sign-in loop. All four are one-line branches that otherwise only a
 * browser walking the whole product would execute.
 */

type Api = typeof import('@/lib/api');
type Session = typeof import('@/lib/session');
type ViewAs = typeof import('@/lib/view-as');

let api: Api;
let session: Session;
let viewAs: ViewAs;
const fetchMock = vi.fn();

/** What `fetch` gives back, without a real Response. */
const answer = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  }) as unknown as Response;

beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  fetchMock.mockReset().mockResolvedValue(answer(200, { ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  session = await import('@/lib/session');
  viewAs = await import('@/lib/view-as');
  api = await import('@/lib/api');
  // Signed in, because that is what every case below is about: what a learner
  // is told when a call they made goes wrong. A call made with no session at
  // all is refused before it is sent and has its own case.
  window.localStorage.setItem(session.TOKEN_KEY, 'jwt-value');
});

const realLocation = window.location;

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: realLocation,
  });
});

const lastCall = () => fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
const lastInit = () => lastCall()[1] as RequestInit & { headers: Record<string, string> };

describe('managed authentication request contracts', () => {
  it('returns registration confirmation without storing an application session', async () => {
    session.clearSession();
    fetchMock.mockResolvedValue(answer(201, { confirmationRequired: true, email: 'learner@example.test' }));
    await expect(api.api.register('learner@example.test', 'example-password', 'Learner')).resolves.toEqual({ confirmationRequired: true, email: 'learner@example.test' });
    expect(api.getToken()).toBeNull();
    expect(lastCall()[0]).toContain('/api/v1/auth/register');
    expect(JSON.parse(lastInit().body as string)).toEqual({ email: 'learner@example.test', password: 'example-password', displayName: 'Learner' });
  });

  it('sends explicit code confirmation and resend bodies over the unsigned auth endpoints', async () => {
    session.clearSession();
    await api.api.confirmRegistration('learner@example.test', '123456');
    expect(lastCall()[0]).toContain('/auth/confirm');
    expect(JSON.parse(lastInit().body as string)).toEqual({ email: 'learner@example.test', code: '123456' });
    expect(lastInit().headers.Authorization).toBeUndefined();
    await api.api.resendConfirmation('learner@example.test');
    expect(lastCall()[0]).toContain('/auth/confirm/resend');
    expect(JSON.parse(lastInit().body as string)).toEqual({ email: 'learner@example.test' });
  });

  it('keeps code and local token reset payloads distinct and preserves structured confirmation errors', async () => {
    session.clearSession();
    const recovery = (await import('@/lib/api-recovery')).recoveryApi;
    await recovery.resetWithCode('learner@example.test', '123456', 'new-password');
    expect(JSON.parse(lastInit().body as string)).toEqual({ email: 'learner@example.test', code: '123456', password: 'new-password' });
    await recovery.reset('local-reset-token', 'new-password');
    expect(JSON.parse(lastInit().body as string)).toEqual({ token: 'local-reset-token', password: 'new-password' });
    const refusal = { code: 'CONFIRMATION_REQUIRED', email: 'learner@example.test', message: 'Confirm your email.' };
    fetchMock.mockResolvedValue(answer(403, refusal));
    await expect(api.api.login('learner@example.test', 'password')).rejects.toMatchObject({ status: 403, body: refusal });
  });
});

/**
 * Where the browser was sent. jsdom will not navigate, so `location` is
 * replaced with a plain object for the length of a case: the assertion is
 * about the URL this code chose, which is the part the app owns.
 */
function watchNavigation(from: string): { get href(): string } {
  const [pathname, search] = from.split(/(?=\?)/);
  const fake = { pathname, search: search ?? '', href: '' };
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: fake });
  return fake;
}

describe('a request', () => {
  it('goes to the API under /api/v1 and carries what it was given', async () => {
    await api.request('POST', '/phases/p1/run', { file: 'manager.py' });

    expect(lastCall()[0]).toBe(`${api.API_URL}/api/v1/phases/p1/run`);
    expect(lastInit().method).toBe('POST');
    expect(lastInit().body).toBe(JSON.stringify({ file: 'manager.py' }));
    expect(lastInit().headers['content-type']).toBe('application/json');
  });

  it('sends no body at all when there is none, rather than "undefined"', async () => {
    await api.request('GET', '/enrollments/mine');
    expect(lastInit().body).toBeUndefined();
  });

  it('signs the request when there is a token', async () => {
    await api.request('GET', '/enrollments/mine');
    expect(lastInit().headers.authorization).toBe('Bearer jwt-value');
  });

  it('sends signing in unsigned, and refuses everything else with no session', async () => {
    window.localStorage.clear();

    // How a session begins: no token, and the call goes out without one.
    await api.request('POST', '/auth/login', { email: 'a@b.c', password: 'x' });
    expect(lastInit().headers.authorization).toBeUndefined();

    // A deep link opened while signed out must not send the shell's whole
    // opening round unsigned and log a 401 for each one in the console on the
    // way to /login.
    const before = fetchMock.mock.calls.length;
    const err = await api.request('GET', '/enrollments/mine').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect((err as InstanceType<Api['ApiError']>).status).toBe(401);
    expect(fetchMock.mock.calls.length, 'a call with no session was still sent').toBe(before);
  });

  it('gives up on a request that hangs and offers a retry without asserting it saved', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'TimeoutError'));
    const err = await api.request('GET', '/enrollments/mine').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(api.ApiError);
    expect((err as InstanceType<Api['ApiError']>).status).toBe(0);
    expect((err as Error).message).toBe('The server did not answer. Try again in a moment.');
  });

  it('passes a dead connection through as itself, for describeError to name', async () => {
    const dead = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValueOnce(dead);
    await expect(api.request('GET', '/enrollments/mine')).rejects.toBe(dead);
  });
});

describe('what a failure says', () => {
  it('shows the API’s own sentence for a 4xx, and joins a list of them', async () => {
    fetchMock.mockResolvedValueOnce(answer(400, { message: 'displayName must be longer' }));
    await expect(api.request('PATCH', '/account/profile')).rejects.toThrow(
      'displayName must be longer',
    );

    fetchMock.mockResolvedValueOnce(answer(400, { message: ['too short', 'not an email'] }));
    await expect(api.request('POST', '/auth/register')).rejects.toThrow('too short; not an email');
  });

  it('falls back to the status when the API said nothing', async () => {
    fetchMock.mockResolvedValueOnce(answer(409, {}));
    await expect(api.request('POST', '/enrollments')).rejects.toThrow('request failed (409)');
  });

  it('carries the reference a 5xx was logged under, from the body or the header', async () => {
    fetchMock.mockResolvedValueOnce(answer(500, { message: 'boom', requestId: 'req-7' }));
    const fromBody = await api.request('GET', '/enrollments/mine').catch((e: unknown) => e);
    expect((fromBody as InstanceType<Api['ApiError']>).requestId).toBe('req-7');
    expect((fromBody as Error).message).toBe('boom (reference req-7)');

    fetchMock.mockResolvedValueOnce(answer(503, { message: 'later' }, { 'x-request-id': 'req-8' }));
    const fromHeader = await api.request('GET', '/enrollments/mine').catch((e: unknown) => e);
    expect((fromHeader as InstanceType<Api['ApiError']>).requestId).toBe('req-8');
  });

  it('does not put a reference on a 4xx, which names something the learner can change', async () => {
    fetchMock.mockResolvedValueOnce(answer(400, { message: 'nope', requestId: 'req-9' }));
    const err = await api.request('POST', '/enrollments').catch((e: unknown) => e);
    expect((err as InstanceType<Api['ApiError']>).requestId).toBeUndefined();
    expect((err as Error).message).toBe('nope');
  });

  it('retains the withheld Guided code and diagnostic reference for the mentor UI', async () => {
    const body = { statusCode: 503, code: 'GUIDED_REPLY_WITHHELD', message: 'No suitable Guided reply is available.', requestId: 'guided-reference' };
    fetchMock.mockResolvedValueOnce(answer(503, body));
    const error = await api.api.chat('requirements-id', 'Help me reason about one outcome.').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(api.ApiError);
    expect((error as InstanceType<Api['ApiError']>).body).toEqual(body);
    expect((error as InstanceType<Api['ApiError']>).requestId).toBe('guided-reference');
  });

  it('retains the withheld stakeholder code, retry message and diagnostic reference', async () => {
    const body = { statusCode: 503, code: 'STAKEHOLDER_REPLY_WITHHELD', message: 'The stakeholder could not provide a reliable reply. Try again.', requestId: 'stakeholder-reference' };
    fetchMock.mockResolvedValueOnce(answer(503, body));
    const { mentorApi } = await import('@/lib/api-mentor');
    const error = await mentorApi.ask('requirements-id', 'Is a task due today overdue?').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(api.ApiError);
    expect((error as InstanceType<Api['ApiError']>).body).toEqual(body);
    expect((error as Error).message).toBe(`${body.message} (reference stakeholder-reference)`);
    expect((error as InstanceType<Api['ApiError']>).requestId).toBe('stakeholder-reference');
  });

  it('does not claim an unacknowledged workspace write was saved after a timeout', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out', 'TimeoutError'));
    const error = await api.api.saveWorkspace('phase', { 'notes.md': 'My unsaved changes' }, '2026-09-15T10:00:00.000Z').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(api.ApiError);
    expect((error as Error).message).toBe('The server did not answer. Try again in a moment.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows reviewed AI calls 60 seconds while ordinary reads retain 20 seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { mentorApi, agentApi } = await import('@/lib/api-mentor');
    await api.api.chat('phase', 'A question');
    await mentorApi.lessonChat('phase', 'A lesson question');
    await mentorApi.explainTest('phase', { testName: 'boundary', source: 'run', sourceId: 'run-id' });
    await mentorApi.ask('phase', 'A stakeholder question');
    await agentApi.propose('phase', 'Change the title while preserving its criteria.');
    await agentApi.explain('phase', { id: 'proposal', proposalHash: 'reviewed-hash' } as Parameters<typeof agentApi.explain>[1], 'My explanation');
    await mentorApi.interview('phase');
    await api.request('GET', '/phases/phase');
    expect(timeout.mock.calls.map(([duration]) => duration)).toEqual([60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 20_000, 20_000]);
  });
});

describe('describeError', () => {
  it('names a dead connection rather than blaming the learner’s credentials', () => {
    expect(api.describeError(new TypeError('Failed to fetch'), 'Could not sign in.')).toBe(
      "Can't reach the server. Check your connection and try again.",
    );
  });

  it('passes an API refusal through, and falls back for anything else', () => {
    expect(api.describeError(new api.ApiError(400, 'That email is taken.'), 'x')).toBe(
      'That email is taken.',
    );
    expect(api.describeError(new Error('who knows'), 'Could not sign in.')).toBe('Could not sign in.');
  });
});

describe('an expiring token', () => {
  // Every case here ends with the browser being sent to /login, which jsdom
  // will not do; each one watches that navigation instead.
  beforeEach(() => {
    watchNavigation('/dashboard');
  });

  it('flushes what is unsaved while the session is still whole, then ends it', async () => {
    window.localStorage.setItem(session.TOKEN_KEY, 'about-to-expire');
    api.storeAuth(authResult('about-to-expire', { id: 'u1' }));

    // The workspace registers the flush of the keystrokes no debounce fired for.
    const tokenSeenByTheFlush: (string | null)[] = [];
    api.onSessionLeaving(() => {
      tokenSeenByTheFlush.push(api.getToken() ?? api.tokenAtSessionEnd());
    });

    fetchMock.mockResolvedValueOnce(answer(401, { message: 'token expired' }));
    await expect(api.request('GET', '/enrollments/mine')).rejects.toThrow();

    // It ran, and it ran with a token: an unsigned last write is thrown away
    // by the API, and the learner would lose the last thing they typed.
    expect(tokenSeenByTheFlush).toEqual(['about-to-expire']);
    expect(api.tokenAtSessionEnd()).toBe('about-to-expire');
    // And the session is over.
    expect(session.getSession()).toBeNull();
    expect(window.localStorage.getItem(session.TOKEN_KEY)).toBeNull();
  });

  it('returns a refused session verification to sign-in with the exact route', async () => {
    const location = watchNavigation('/teacher/class?class=unowned');
    fetchMock.mockResolvedValueOnce(answer(401, { message: 'invalid or expired token' }));
    await expect(api.api.me()).rejects.toThrow();
    expect(api.getToken()).toBeNull();
    expect(location.href).toBe('/login?next=%2Fteacher%2Fclass%3Fclass%3Dunowned&reason=expired');
  });

  it('does not sign out a replacement account when the former token receives a late401', async () => {
    const location = watchNavigation('/profile');
    let reply!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { reply = resolve; }));
    const earlier = api.request('GET', '/enrollments/mine').catch(() => undefined);
    api.storeAuth(authResult('replacement-token', { id: 'replacement-owner' }));
    reply(answer(401, { message: 'former token expired' })); await earlier;
    expect(api.getToken()).toBe('replacement-token');
    expect(session.getSession()?.id).toBe('replacement-owner'); expect(location.href).toBe('');
  });

  it('rechecks the session owner after an interrupted-operation flush', async () => {
    const location = watchNavigation('/profile');
    const unregister = api.onSessionLeaving(async () => {
      api.storeAuth(authResult('replacement-during-flush', { id: 'next-owner' }));
    });
    fetchMock.mockResolvedValueOnce(answer(401, { message: 'old token expired' }));
    await expect(api.request('GET', '/enrollments/mine')).rejects.toThrow(); unregister();
    expect(api.getToken()).toBe('replacement-during-flush');
    expect(session.getSession()?.id).toBe('next-owner'); expect(location.href).toBe('');
  });

  it('carries where the learner was, so signing back in returns them to it', async () => {
    const location = watchNavigation('/workspace/p1?file=manager.py');
    window.localStorage.setItem(session.TOKEN_KEY, 'about-to-expire');

    fetchMock.mockResolvedValueOnce(answer(401, { message: 'token expired' }));
    await expect(api.request('GET', '/phases/p1')).rejects.toThrow();

    // `reason=expired` is what lets the sign-in page say the session ended
    // rather than leaving the room the learner was in looking like a sign-in
    // screen with no explanation.
    expect(location.href).toBe(
      '/login?next=%2Fworkspace%2Fp1%3Ffile%3Dmanager.py&reason=expired',
    );
  });

  it('does not send /login back to itself, and keeps what it is already saying', async () => {
    const location = watchNavigation('/login?next=%2Fmap&reason=expired');
    window.localStorage.setItem(session.TOKEN_KEY, 'about-to-expire');

    fetchMock.mockResolvedValueOnce(answer(401, {}));
    await expect(api.request('GET', '/enrollments/mine')).rejects.toThrow();

    // A room fires several calls at once, so the second and third 401s land
    // after the first has already taken the browser here. Navigating again to
    // a bare `/login` would throw away both the place the learner was and the
    // sentence saying why they are looking at a sign-in page. The page is
    // already the one this handler would ask for, so it is left exactly as it
    // is.
    expect(location.href).toBe('');
  });

  it('leaves a failed sign-in alone: a 401 from /auth is not an expiring session', async () => {
    window.localStorage.setItem(session.TOKEN_KEY, 'still-good');
    const flush = vi.fn();
    api.onSessionLeaving(flush);

    fetchMock.mockResolvedValueOnce(answer(401, { message: 'email or password is wrong' }));
    await expect(api.request('POST', '/auth/login', {})).rejects.toThrow();

    expect(flush).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(session.TOKEN_KEY)).toBe('still-good');
  });

  it('stops calling a hook that has been unregistered', async () => {
    const flush = vi.fn();
    api.onSessionLeaving(flush)();
    fetchMock.mockResolvedValueOnce(answer(401, {}));
    await expect(api.request('GET', '/enrollments/mine')).rejects.toThrow();
    expect(flush).not.toHaveBeenCalled();
  });
});

/**
 * The one call that is worth more than its answer.
 *
 * If a session expires at the moment a learner presses Submit, the browser
 * leaves for the sign-in page and nothing would say the attempt was not
 * made. The 401 branch above cannot change (a room fires several calls at
 * once and one 401 cannot be told from another) so the intent is written
 * down around the request instead, and only a 401 leaves it behind.
 */
describe('a submission the session ended under', () => {
  type Pending = typeof import('@/lib/pending-action');
  let pending: Pending;

  beforeEach(async () => {
    pending = await import('@/lib/pending-action');
    watchNavigation('/workspace/p1');
    api.storeAuth(authResult('about-to-expire', { id: 'u1' }));
  });

  /** Signing back in, which is the only state the record can be read from. */
  const backIn = () => api.storeAuth(authResult('signed-in-again', { id: 'u1' }));

  it('keeps a submission pending when the session ends under it', async () => {
    fetchMock.mockResolvedValueOnce(answer(401, { message: 'token expired' }));
    await expect(api.api.submit('p1', 'Fix the overdue boundary')).rejects.toThrow();

    expect(session.getSession()).toBeNull();
    backIn();
    expect(pending.readPendingAction('p1')).toMatchObject({
      kind: 'submit',
      phaseId: 'p1',
      text: 'Fix the overdue boundary',
    });
  });

  it('forgets a submission the API refused for any other reason', async () => {
    fetchMock.mockResolvedValueOnce(answer(400, { message: 'Write what this revision changes.' }));
    const err = await api.api.submit('p1', 'Fix the overdue boundary').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(api.ApiError);
    expect((err as Error).message).toBe('Write what this revision changes.');
    expect(pending.readPendingAction('p1')).toBeNull();
  });

  it('forgets it the moment the API has it, and still sends no body when nothing was typed', async () => {
    fetchMock.mockResolvedValueOnce(answer(201, { id: 's1' }));
    await api.api.submit('p1');
    // The no-body shape the journey scripts and e2e specs send.
    expect(lastInit().body).toBeUndefined();
    expect(pending.readPendingAction('p1')).toBeNull();

    fetchMock.mockResolvedValueOnce(answer(201, { id: 's2' }));
    await api.api.submit('p1', 'With a message');
    expect(JSON.parse(lastInit().body as string)).toEqual({ message: 'With a message' });
    expect(pending.readPendingAction('p1')).toBeNull();
  });

  /**
   * The sign-in page is a different document with no session, so it cannot ask
   * whose record is in storage. This one bit is what lets it say a message is
   * waiting when one is, and it must never be last time's answer.
   */
  it('forgets whether a message was kept before the hooks decide this time', async () => {
    api.rememberUnsentMessageKept();
    expect(api.unsentMessageKept()).toBe(true);
    const seenByTheFlush: boolean[] = [];
    api.onSessionLeaving(() => { seenByTheFlush.push(api.unsentMessageKept()); });

    fetchMock.mockResolvedValueOnce(answer(401, { message: 'token expired' }));
    await expect(api.api.submit('p1', 'Fix the overdue boundary')).rejects.toThrow();

    expect(seenByTheFlush).toEqual([false]);
  });

  it('forgets it again the moment a new session starts', async () => {
    api.rememberUnsentMessageKept();
    api.storeAuth(authResult('signed-in-again', { id: 'u1' }));
    expect(api.unsentMessageKept()).toBe(false);
  });

  it('records nothing for another learner, so a shared browser hands nothing on', async () => {
    fetchMock.mockResolvedValueOnce(answer(401, { message: 'token expired' }));
    await expect(api.api.submit('p1', 'The first learner’s words')).rejects.toThrow();

    api.storeAuth(authResult('the-next-learner', { id: 'u2' }));
    expect(pending.readPendingAction('p1')).toBeNull();
    expect(window.localStorage.getItem('lsdlc_pending_p1')).toBeNull();
  });
});

describe('a browser that keeps nothing', () => {
  it('holds the token in memory and says so, instead of looping back to sign in', async () => {
    // Safari's private window and a locked-down lab profile: the write is
    // accepted and reads back as nothing.
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    });
    vi.resetModules();
    const blocked: Api = await import('@/lib/api');

    expect(blocked.probeSiteData()).toBe(false);
    blocked.storeAuth(authResult('held-in-memory', { id: 'u1' }));

    expect(blocked.isSiteDataBlocked()).toBe(true);
    expect(blocked.getToken()).toBe('held-in-memory');
    await blocked.request('GET', '/enrollments/mine');
    expect(lastInit().headers.authorization).toBe('Bearer held-in-memory');
  });

  it('trusts storage that works, so another tab signing out still ends it here', () => {
    api.storeAuth(authResult('written-through', { id: 'u1' }));
    expect(api.isSiteDataBlocked()).toBe(false);
    expect(api.probeSiteData()).toBe(true);

    window.localStorage.removeItem(session.TOKEN_KEY);
    expect(api.getToken()).toBeNull();
  });
});

describe('while an instructor is viewing a learner’s work', () => {
  beforeEach(() => {
    viewAs.startViewAs({ userId: 'u9', displayName: 'Ada Lovelace' } as never);
  });

  it('reads the learner’s copy through the instructor’s own routes', async () => {
    await api.request('GET', '/enrollments/mine');
    expect(lastCall()[0]).toBe(`${api.API_URL}/api/v1/instructor/learners/u9/enrollment`);

    await api.request('GET', '/phases/p1/runs');
    expect(lastCall()[0]).toBe(`${api.API_URL}/api/v1/instructor/learners/u9/phases/p1/runs`);
  });

  it('sends the dashboard’s batch reads to their twins, not to a phase route or the teacher’s own', async () => {
    fetchMock.mockImplementation(async () => answer(200, []));
    await api.request('GET', '/phases/summaries?project=room-desk');
    expect(lastCall()[0]).toBe(`${api.API_URL}/api/v1/instructor/learners/u9/phases/summaries?project=room-desk`);

    await api.request('GET', '/phases/records?project=room-desk');
    expect(lastCall()[0]).toBe(`${api.API_URL}/api/v1/instructor/learners/u9/phases/records?project=room-desk`);

    await api.request('GET', '/projects/room-desk/map?compact=1&showLocked=1');
    expect(lastCall()[0]).toBe(
      `${api.API_URL}/api/v1/instructor/learners/u9/projects/room-desk/map?compact=1&showLocked=1`,
    );

    // The learner-only review history has a teacher's door already, with the
    // same pages and the same query.
    await api.request('GET', '/submissions/review-history/pages?project=room-desk&after=c2');
    expect(lastCall()[0]).toBe(
      `${api.API_URL}/api/v1/submissions/learner-history/u9?project=room-desk&after=c2`,
    );
  });

  it('sends a split phase’s per-task revision list to its twin', async () => {
    fetchMock.mockImplementation(async () => answer(200, []));
    await api.request('GET', '/phases/p1/tasks/booking-story/submissions');
    expect(lastCall()[0]).toBe(
      `${api.API_URL}/api/v1/instructor/learners/u9/phases/p1/tasks/booking-story/submissions`,
    );
    await api.api.submissions('p1', 'a key/with space');
    expect(lastCall()[0]).toBe(
      `${api.API_URL}/api/v1/instructor/learners/u9/phases/p1/tasks/a%20key%2Fwith%20space/submissions`,
    );
  });

  it('refuses every write before it leaves the browser', async () => {
    const err = await api.request('PUT', '/phases/p1/workspace', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect((err as InstanceType<Api['ApiError']>).status).toBe(403);
    expect((err as Error).message).toContain('You are viewing Ada’s work'.replace('’', "'"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the instructor’s own session and their own bell alone', async () => {
    await api.request('POST', '/auth/logout', {});
    expect(lastCall()[0]).toBe(`${api.API_URL}/api/v1/auth/logout`);
    await api.request('POST', '/notifications/read', {});
    expect(lastCall()[0]).toBe(`${api.API_URL}/api/v1/notifications/read`);
  });
});

describe('signing out', () => {
  it.each(['flush', 'revocation'])('preserves a replacement sign-in arriving during %s while revoking only the original token', async stage => {
    api.storeAuth(authResult('original-token', { id: 'original-user' }));
    let finish!: () => void;
    const paused = new Promise<void>(resolve => { finish = resolve; });
    const clearDrafts = vi.fn(); api.onSignOut(clearDrafts);
    if (stage === 'flush') api.onSessionLeaving(() => paused);
    if (stage === 'revocation') fetchMock.mockImplementation(async () => { await paused; return answer(200, { signedOut: true }); });
    const operation = api.endSession();
    if (stage === 'revocation') await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    api.storeAuth(authResult('replacement-token', { id: 'replacement-user' }));
    finish(); expect(await operation).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastInit().headers.authorization).toBe('Bearer original-token');
    expect(api.getToken()).toBe('replacement-token');
    expect(session.getSession()?.id).toBe('replacement-user');
    expect(clearDrafts).not.toHaveBeenCalled();
  });
  it('tells the API the token is finished, with keepalive, before clearing it here', async () => {
    api.storeAuth(authResult('jwt-value', { id: 'u1' }));
    const order: string[] = [];
    // The workspace's flush of the keystrokes no debounce has fired for.
    api.onSessionLeaving(() => {
      order.push(`flush:${api.getToken()}`);
    });
    fetchMock.mockImplementation(async (url: string) => {
      order.push(`fetch:${url.replace(api.API_URL, '')}`);
      return answer(200, { signedOut: true });
    });

    await api.endSession();

    // Flushed under the live token, then revoked, then cleared: a token
    // copied from a shared machine stops working the moment the button is
    // pressed rather than seven days later.
    expect(order).toEqual(['flush:jwt-value', 'fetch:/api/v1/auth/logout']);
    expect(lastInit().method).toBe('POST');
    expect(lastInit().headers.authorization).toBe('Bearer jwt-value');
    expect(lastInit().keepalive).toBe(true);
    expect(window.localStorage.getItem(session.TOKEN_KEY)).toBeNull();
    expect(session.getSession()).toBeNull();
  });

  it('still signs out here when the API cannot be reached', async () => {
    api.storeAuth(authResult('jwt-value', { id: 'u1' }));
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(api.endSession()).resolves.toBe(true);

    expect(window.localStorage.getItem(session.TOKEN_KEY)).toBeNull();
  });

  it('ends the local session when a revocation request stalls during an outage', async () => {
    vi.useFakeTimers();
    try {
      api.storeAuth(authResult('jwt-value', { id: 'u1' }));
      fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      const signingOut = api.endSession();
      await vi.advanceTimersByTimeAsync(3001);
      await signingOut;
      expect(lastInit().signal?.aborted).toBe(true);
      expect(api.getToken()).toBeNull();
      expect(session.getSession()).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('sends nothing when there is no token to revoke' , async () => {
    window.localStorage.clear();
    await api.signOutEverywhere();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the mark a tab leaves before it goes to Google', () => {
  it('is spent by the first read, and never there for a tab that did not press the button', () => {
    // A link somebody else built, with their token in the fragment, opened
    // cold: this tab never started a sign-in, so the callback refuses it.
    expect(api.takeGoogleSignInStart()).toBe(false);

    api.markGoogleSignInStarted();
    expect(window.sessionStorage.getItem('lsdlc_oauth_started')).toBe('1');
    expect(api.takeGoogleSignInStart()).toBe(true);
    // Read once: a second landing on the same tab is not covered by the first press.
    expect(api.takeGoogleSignInStart()).toBe(false);
    expect(window.sessionStorage.getItem('lsdlc_oauth_started')).toBeNull();
  });
});

describe('sign-in persistence choice', () => {
  it('signs API requests using the unchecked temporary session and keeps profile edits temporary', async () => {
    api.storeAuth({ token: 'temporary-api-token', user: { id: 'u1', displayName: 'Ada' } } as never, { persist: false });
    await api.request('GET', '/enrollments/mine');
    expect(lastInit().headers.authorization).toBe('Bearer temporary-api-token');
    expect(api.isSiteDataBlocked()).toBe(false);
    session.setSession({ id: 'u1', displayName: 'Changed' } as never);
    expect(window.localStorage.getItem(session.TOKEN_KEY)).toBeNull();
    expect(window.localStorage.getItem(session.USER_KEY)).toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem(session.USER_KEY)!)).toMatchObject({ displayName: 'Changed' });
    api.clearAuth();
    expect(window.sessionStorage.getItem(session.TOKEN_KEY)).toBeNull();
    expect(api.getToken()).toBeNull();
  });
});


describe('validating a new OAuth identity beside an existing temporary session', () => {
  it('uses the callback credential explicitly and leaves the existing session untouched until adoption', async () => {
    api.storeAuth({ token: 'existing-temporary', user: { id: 'u1' } } as never, { persist: false });
    fetchMock.mockResolvedValueOnce(answer(200, { id: 'u2', displayName: 'New identity' }));
    const user = await api.verifyAuthToken('callback-token');
    expect(lastInit().headers.authorization).toBe('Bearer callback-token');
    expect(api.getToken()).toBe('existing-temporary');
    expect(api.getStoredUser()?.id).toBe('u1');
    api.storeAuth({ token: 'callback-token', user });
    expect(api.getToken()).toBe('callback-token');
    expect(api.getStoredUser()?.id).toBe('u2');
    expect(window.sessionStorage.getItem(session.TOKEN_KEY)).toBeNull();
  });
  it('does not clear another valid session when the callback credential is refused', async () => {
    api.storeAuth({ token: 'existing-temporary', user: { id: 'u1' } } as never, { persist: false });
    fetchMock.mockResolvedValueOnce(answer(401, {}));
    await expect(api.verifyAuthToken('rejected-callback')).rejects.toBeInstanceOf(api.ApiError);
    expect(api.getToken()).toBe('existing-temporary');
    expect(api.getStoredUser()?.id).toBe('u1');
  });
});


/**
 * Which grader a room's submit reaches.
 *
 * A teacher may split a written phase into several tasks, and each task is
 * graded against its own rules. The phase route still exists and still grades
 * *the phase's only task*, so the client sends a key only where there is a
 * choice to make, and where there is one, sending none would be picking one
 * for the learner, which is how their work goes to the wrong grader.
 */
describe('submitting one task of a phase', () => {
  const lastUrl = () => String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]);

  it('posts to the per-task route only when the phase has more than one task', async () => {
    const { taskKeyToSend } = await import('@/components/workspace/TaskPanel');
    const task = (key: string, order: number) =>
      ({
        key,
        order,
        required: true,
        title: key,
        artefactType: 'document',
        evidence: 'reviewed',
        sealed: true,
        status: 'in_progress',
        awaitingSignOff: false,
        attempts: 0,
        bestScore: null,
        passedAt: null,
        lastSubmissionId: null,
        resetAt: null,
        solution: { available: false, files: 0, readAt: null },
      }) as never;

    // A phase with one task (every phase of every project until a teacher
    // splits one) sends nothing and reaches the phase route.
    fetchMock.mockResolvedValueOnce(answer(201, { id: 's1' }));
    await api.api.submit('p1', 'A revision', taskKeyToSend([task('main', 1)], 'main'));
    expect(lastUrl()).toMatch(/\/phases\/p1\/submit$/);
    expect(JSON.parse(lastInit().body as string)).toEqual({ message: 'A revision' });

    // Two tasks and the room says which.
    fetchMock.mockResolvedValueOnce(answer(201, { id: 's2' }));
    await api.api.submit('p1', 'A revision', taskKeyToSend([task('story', 1), task('scope', 2)], 'scope'));
    expect(lastUrl()).toMatch(/\/phases\/p1\/tasks\/scope\/submit$/);
    expect(JSON.parse(lastInit().body as string)).toEqual({ message: 'A revision' });
  });

  it('sends no body on a task submit with nothing typed, exactly as the phase route does', async () => {
    fetchMock.mockResolvedValueOnce(answer(201, { id: 's3' }));
    await api.api.submit('p1', undefined, 'story');
    expect(lastUrl()).toMatch(/\/phases\/p1\/tasks\/story\/submit$/);
    expect(lastInit().body).toBeUndefined();
  });

  it('escapes a key rather than letting it write the path', async () => {
    fetchMock.mockResolvedValueOnce(answer(201, { id: 's4' }));
    await api.api.submit('p1', undefined, 'a/b');
    expect(lastUrl()).toMatch(/\/phases\/p1\/tasks\/a%2Fb\/submit$/);
  });

  it('keeps the interrupted-submission record on the phase, because a workspace is one', async () => {
    const pending = await import('@/lib/pending-action');
    api.storeAuth(authResult('about-to-expire', { id: 'u1' }));
    fetchMock.mockResolvedValueOnce(answer(401, { message: 'token expired' }));
    await expect(api.api.submit('p1', 'Split-phase words', 'story')).rejects.toThrow();
    api.storeAuth(authResult('signed-in-again', { id: 'u1' }));
    expect(pending.readPendingAction('p1')).toMatchObject({ kind: 'submit', phaseId: 'p1', text: 'Split-phase words' });
  });
});
