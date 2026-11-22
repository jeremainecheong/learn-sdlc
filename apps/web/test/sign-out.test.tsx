// @vitest-environment jsdom
/**
 * The sign-out button, wherever it is offered.
 *
 * Clearing this browser's storage is not enough: the seven-day token would
 * stay good on every other device, and the exit save of whatever was typed
 * would go out unsigned. The order (flush, revoke, clear) is what this
 * file pins.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authResult } from './fixtures';

const push = vi.fn();
const replace = vi.fn();
const closeSocket = vi.fn();
const assign = vi.fn();
// One router for the life of the page, as Next.js gives: the session gate's
// effect lists it, so a fresh object per render would re-run the gate.
const router = { push, replace };
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/login',
  useSearchParams: () => new URLSearchParams(),
}));
// The mounted sign-in page, without the form and its own network reads.
vi.mock('@/components/landing/SignInPanel', () => ({ SignInPanel: () => null }));
vi.mock('@/lib/socket', () => ({ closeSocket: () => closeSocket() }));
// The managed sign-out: jsdom's location cannot be spied on, so the one full navigation goes
// through a location the test hands in; the address is still the real one.
vi.mock('@/lib/auth-signout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-signout')>();
  return { ...actual, leaveForSsoSignOut: () => actual.leaveForSsoSignOut({ assign }) };
});

type Api = typeof import('@/lib/api');
type Session = typeof import('@/lib/session');
let api: Api;
let session: Session;
let useSignOut: typeof import('@/components/shell/useSignOut').useSignOut;
const fetchMock = vi.fn();
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  push.mockReset(); replace.mockReset(); closeSocket.mockClear(); assign.mockReset();
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  session = await import('@/lib/session');
  api = await import('@/lib/api');
  ({ useSignOut } = await import('@/components/shell/useSignOut'));
  api.storeAuth(authResult('jwt-value', { id: 'u1', role: 'LEARNER' }));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

function mount(): () => void {
  let signOut: () => void = () => undefined;
  function Probe() {
    signOut = useSignOut();
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<Probe />);
  });
  return () => signOut();
}

describe('useSignOut', () => {
  it('keeps a new sign-in that arrives after local logout cleanup and before navigation', async () => {
    api.onSignOut(() => { queueMicrotask(() => api.storeAuth(authResult('new-google-token', { id: 'google-user', role: 'LEARNER' }))); });
    const signOut = mount();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(session.getToken()).toBe('new-google-token');
    expect(push).not.toHaveBeenCalled(); expect(closeSocket).not.toHaveBeenCalled();
  });
  it('does not redirect or close the replacement account socket when sign-in changes during the flush', async () => {
    let finish!: () => void;
    const flush = new Promise<void>(resolve => { finish = resolve; });
    api.onSessionLeaving(() => flush);
    const signOut = mount();
    await act(async () => {
      signOut();
      api.storeAuth(authResult('new-google-token', { id: 'google-user', role: 'LEARNER' }));
      finish();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(session.getToken()).toBe('new-google-token');
    expect(session.getSession()?.id).toBe('google-user');
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer jwt-value');
    expect(push).not.toHaveBeenCalled(); expect(closeSocket).not.toHaveBeenCalled();
  });
  /**
   * A session that ends *under* a learner keeps what they had typed, so the
   * words are back in the field when they sign in again. Pressing Sign
   * out is the opposite act: it is the moment they leave the machine, and the
   * flush that runs on the way out must not be what leaves their sentence in a
   * shared browser's storage.
   */
  it('leaves nothing of a learner’s pending work behind after a deliberate sign out', async () => {
    // Both are loaded on every signed-in page through the shell's session
    // notices; their hooks are registered on import.
    const commit = await import('@/lib/commit');
    const pending = await import('@/lib/pending-action');
    commit.setCommitDraft('p1', 'Half a sentence about the boundary');
    pending.rememberPendingAction({ kind: 'submit', phaseId: 'p2', label: 'your submission', text: 'sent but unrecorded' });
    expect(pending.readPendingAction('p2')).not.toBeNull();

    const signOut = mount();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(session.getSession()).toBeNull());

    expect(Object.keys(window.localStorage).filter(key => key.startsWith('lsdlc_pending_'))).toEqual([]);
    expect(commit.commitDraft('p1')).toBe('');
  });

  it('flushes under the live token, revokes it everywhere, then clears it and leaves', async () => {
    const order: string[] = [];
    api.onSessionLeaving(() => {
      order.push(`flush:${api.getToken()}`);
    });
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      order.push(`${init.method}:${url.replace(api.API_URL, '')}`);
      return { ok: true, status: 200, json: async () => ({}) };
    });
    push.mockImplementation(() => order.push(`go:${session.getToken()}`));

    const signOut = mount();
    await act(async () => {
      signOut();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/login'));

    // After the revoke, the server's providers answer (unsigned) says
    // whether this deployment is managed; this one is not, so it ends on /login.
    expect(order).toEqual(['flush:jwt-value', 'POST:/api/v1/auth/logout', 'GET:/api/v1/auth/providers', 'go:null']);
    expect(session.getSession()).toBeNull();
    expect(closeSocket).toHaveBeenCalled();
  });
});

/**
 * In a deployment that signs people in through the managed provider, the
 * provider keeps a session of its own that revoking the LearnSDLC token does
 * not end, so the tab leaves through the provider's sign-out, and /login says
 * what did and did not end. Local mode ends exactly as above.
 */
const MARK = 'lsdlc_signed_out';

function answerProviders(authProvider: 'local' | 'cognito' | 'fail', order?: string[]) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    order?.push(`${init.method}:${url.replace(api.API_URL, '')}:${(init.headers as Record<string, string>).authorization ?? 'unsigned'}`);
    if (url.endsWith('/auth/providers')) {
      if (authProvider === 'fail') throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => ({ google: true, authProvider }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

/** Every address the sign-out opened: its API calls and any full navigation. */
function opened(): string[] {
  return [...fetchMock.mock.calls.map(call => String(call[0])), ...assign.mock.calls.map(call => String(call[0]))];
}

describe('useSignOut in a managed deployment', () => {
  it('reads the providers answer unsigned, only after the revoke, and navigates once', async () => {
    const order: string[] = [];
    answerProviders('cognito', order);
    api.onSessionLeaving(() => { order.push(`flush:${api.getToken()}`); });

    const signOut = mount();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(assign.mock.calls.length + push.mock.calls.length).toBe(1));

    expect(order).toEqual(['flush:jwt-value', 'POST:/api/v1/auth/logout:Bearer jwt-value', 'GET:/api/v1/auth/providers:unsigned']);
    expect(session.getSession()).toBeNull();
    expect(closeSocket).toHaveBeenCalled();
  });

  it('puts no token and no query in any address it opens', async () => {
    answerProviders('cognito');
    const signOut = mount();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(assign.mock.calls.length + push.mock.calls.length).toBe(1));

    for (const url of opened()) {
      expect(url).not.toContain('jwt-value');
      expect(url).not.toContain('?');
      expect(url).not.toContain('#');
    }
  });

  it('leaves the /login mark only in managed mode', async () => {
    answerProviders('cognito');
    const signOut = mount();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(assign.mock.calls.length + push.mock.calls.length).toBe(1));
    expect(window.sessionStorage.getItem(MARK)).toBe('1');
  });

  it('in local mode goes to /login, with no full navigation and no mark', async () => {
    answerProviders('local');
    const signOut = mount();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/login'));
    expect(assign).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(MARK)).toBeNull();
  });

  it('ends on /login, with no mark, when the providers answer does not come', async () => {
    answerProviders('fail');
    const signOut = mount();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/login'));
    expect(assign).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(MARK)).toBeNull();
    expect(session.getSession()).toBeNull();
  });

  it('leaves a sign-in that lands while the providers answer is pending alone', async () => {
    let answer!: () => void;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/providers')) {
        await new Promise<void>(resolve => { answer = resolve; });
        return { ok: true, status: 200, json: async () => ({ google: true, authProvider: 'cognito' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const signOut = mount();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    api.storeAuth(authResult('new-google-token', { id: 'google-user', role: 'LEARNER' }));
    await act(async () => { answer(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(assign).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(MARK)).toBeNull();
    expect(session.getToken()).toBe('new-google-token');
  });
});

describe('the providers read on the way out', () => {
  it('gives up after the sign-out bound, not the ordinary request timeout', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const bounds = new Map<AbortSignal, number>();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { const s = real(ms); bounds.set(s, ms); return s; });
    answerProviders('local');
    const signOut = mount();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/login'));
    const providers = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/auth/providers'));
    expect(bounds.get(providers![1].signal)).toBe(3_000);
    vi.mocked(AbortSignal.timeout).mockRestore();
  });
});

/**
 * With the real shell mounted. The session gate watches the token and sends a
 * browser with none to /login?next=…; if it does that while a deliberate
 * sign-out is still waiting for the providers answer, the sign-in page mounts
 * before the mark exists and never shows the sentence, and the mark is left for
 * whoever opens /login next in the tab. One navigation, after the mark, with
 * and without the managed sign-out.
 */
describe('sign-out under the mounted session gate', () => {
  const learner = { id: 'u1', email: 'u1@example.test', displayName: 'U', role: 'LEARNER', cohort: 'default', createdAt: '2026-09-13T00:00:00Z', onboardingCompleted: true };
  let navigations: string[] = [];
  let answer: (() => void) | null = null;

  function serve(authProvider: 'local' | 'cognito', hold = false) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/me')) return { ok: true, status: 200, json: async () => learner };
      if (url.endsWith('/auth/providers')) {
        if (hold) await new Promise<void>(resolve => { answer = resolve; });
        return { ok: true, status: 200, json: async () => ({ google: true, authProvider }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
  }

  async function mountGated(): Promise<() => void> {
    api.storeAuth({ token: 'jwt-value', user: learner } as never);
    const { SessionGate } = await import('@/components/shell/SessionGate');
    const mark = () => window.sessionStorage.getItem(MARK) ?? 'none';
    navigations = [];
    replace.mockImplementation((to: string) => navigations.push(`replace:${to}:mark=${mark()}`));
    push.mockImplementation((to: string) => navigations.push(`push:${to}:mark=${mark()}`));
    assign.mockImplementation((to: string) => navigations.push(`assign:${to.replace(api.API_URL, '')}:mark=${mark()}`));
    let signOut: () => void = () => undefined;
    function Probe() { signOut = useSignOut(); return <span data-testid="inside" />; }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<SessionGate><Probe /></SessionGate>); });
    await vi.waitFor(() => expect(host!.querySelector('[data-testid="inside"]')).not.toBeNull());
    return () => signOut();
  }

  it('in managed mode leaves once, after the mark, and the next /login says the sentence', async () => {
    serve('cognito', true);
    const signOut = await mountGated();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(answer).not.toBeNull());
    // The session is gone here and the providers answer has not come back.
    expect(session.getToken()).toBeNull();
    expect(navigations).toEqual([]);
    await act(async () => { answer!(); });
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(navigations[0]).toMatch(/^(assign:\/api\/v1\/auth\/sso\/signout|push:\/login):mark=1$/);
    expect(replace).not.toHaveBeenCalled();

    const { SignedOutNotice } = await import('@/app/login/SignedOutNotice');
    const box = document.createElement('div');
    document.body.appendChild(box);
    const r = createRoot(box);
    await act(async () => { r.render(<SignedOutNotice />); });
    expect(box.querySelector('[data-testid="signed-out"]')).not.toBeNull();
    act(() => r.unmount()); box.remove();
  });

  it('in local mode goes to /login once, with no mark', async () => {
    serve('local');
    const signOut = await mountGated();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });
    expect(navigations).toEqual(['push:/login:mark=none']);
  });

  it('lets a session that ends later send the browser to sign in', async () => {
    serve('local');
    const signOut = await mountGated();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(api.signInHref()).toMatch(/^\/login\?next=/);
  });
});

describe('the /login sentence after a managed sign-out', () => {
  const SENTENCE = 'You are signed out of LearnSDLC on this browser. If you used Google, your Google account stays signed in until you sign out of Google.';

  async function renderNotice(): Promise<HTMLDivElement> {
    const { SignedOutNotice } = await import('@/app/login/SignedOutNotice');
    const box = document.createElement('div');
    document.body.appendChild(box);
    const r = createRoot(box);
    await act(async () => { r.render(<SignedOutNotice />); });
    cleanups.push(() => { act(() => r.unmount()); box.remove(); });
    return box;
  }
  const cleanups: Array<() => void> = [];
  afterEach(() => { cleanups.splice(0).forEach(fn => fn()); });

  it('shows the sentence once, then never again on the next visit', async () => {
    window.sessionStorage.setItem('lsdlc_signed_out', '1');
    const first = await renderNotice();
    expect(first.textContent).toBe(SENTENCE);
    expect(first.querySelector('[role="status"]')).not.toBeNull();
    expect(window.sessionStorage.getItem('lsdlc_signed_out')).toBeNull();

    const again = await renderNotice();
    expect(again.textContent).toBe('');
  });

  it('says nothing to a visitor who did not just sign out', async () => {
    const box = await renderNotice();
    expect(box.textContent).toBe('');
  });

  it('is on the sign-in page', async () => {
    window.sessionStorage.setItem(MARK, '1');
    const { default: LoginPage } = await import('@/app/login/page');
    const box = document.createElement('div');
    document.body.appendChild(box);
    const r = createRoot(box);
    await act(async () => { r.render(<LoginPage />); });
    cleanups.push(() => { act(() => r.unmount()); box.remove(); });
    expect(box.querySelector('[data-testid="signed-out"]')?.textContent).toBe(SENTENCE);
  });

  it('a later sign-in spends a mark that was never read, so it cannot surface for someone else', () => {
    window.sessionStorage.setItem(MARK, '1');
    api.storeAuth(authResult('next-person', { id: 'u2', role: 'LEARNER' }));
    expect(window.sessionStorage.getItem(MARK)).toBeNull();
  });

  it('never claims a Google sign-out', async () => {
    const { SIGNED_OUT_NOTICE } = await import('@/lib/auth-signout');
    expect(SIGNED_OUT_NOTICE).toBe(SENTENCE);
    expect(SIGNED_OUT_NOTICE).not.toMatch(/signed out of Google/i);
  });
});

/**
 * The managed provider keeps a session of its own, which revoking the
 * LearnSDLC token does not end. In managed mode the tab leaves through the
 * API's `/auth/sso/signout`, which redirects to the provider's `/logout` and
 * back to /login. This block tests the managed branch of useSignOut alone, so
 * removing that branch removes this block with it.
 */
describe('useSignOut leaves through the provider sign-out', () => {
  const SIGNOUT = '/api/v1/auth/sso/signout';

  it('revokes first, then makes one full navigation to the API sign-out route, and never routes client-side', async () => {
    const order: string[] = [];
    answerProviders('cognito', order);
    api.onSessionLeaving(() => { order.push(`flush:${api.getToken()}`); });
    assign.mockImplementation((url: string) => order.push(`assign:${url.replace(api.API_URL, '')}:${session.getToken()}`));

    const signOut = mount();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));

    expect(order).toEqual([
      'flush:jwt-value',
      'POST:/api/v1/auth/logout:Bearer jwt-value',
      'GET:/api/v1/auth/providers:unsigned',
      `assign:${SIGNOUT}:null`,
    ]);
    expect(assign).toHaveBeenCalledWith(`${api.API_URL}${SIGNOUT}`);
    expect(push).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(MARK)).toBe('1');
  });

  it('opens the sign-out route with no token, no query and no fragment', async () => {
    answerProviders('cognito');
    const signOut = mount();
    await act(async () => { signOut(); });
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const [url] = assign.mock.calls[0] as [string];
    expect(url).toBe(`${api.API_URL}${SIGNOUT}`);
    expect(new URL(url).search).toBe('');
    expect(new URL(url).hash).toBe('');
  });

  it('navigates the location it is given, to the route and nothing else', async () => {
    const actual = await vi.importActual<typeof import('@/lib/auth-signout')>('@/lib/auth-signout');
    const location = { assign: vi.fn() };
    actual.leaveForSsoSignOut(location);
    expect(location.assign).toHaveBeenCalledTimes(1);
    expect(location.assign).toHaveBeenCalledWith(`${api.API_URL}${SIGNOUT}`);
  });
});
