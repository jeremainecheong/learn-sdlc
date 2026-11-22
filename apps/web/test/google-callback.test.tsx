// @vitest-environment jsdom
/**
 * Where Google sign-in lands, and the one thing it must refuse.
 *
 * The page takes a token out of its URL fragment and keeps it. Without a mark
 * left by the tab that pressed the button, a link anybody could build
 * (`/login/callback#token=<their token>`) signed whoever opened it into the
 * builder's account, where everything written afterwards could be read back.
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
const verify = vi.fn();
const router = { replace, push: vi.fn() };

vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/landing/AuthLayout', () => ({
  AuthLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AuthNotice: ({ children, testId }: { children: React.ReactNode; testId?: string }) => (
    <p data-testid={testId}>{children}</p>
  ),
}));

type Api = typeof import('@/lib/api');
let api: Api;
let Page: typeof import('@/app/login/callback/page').default;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  // jsdom keeps one window for the whole file, so what the head script would
  // have published has to be cleared between cases like storage is.
  delete window.__lsdlcAuthHandoff;
  vi.clearAllMocks();
  vi.resetModules();
  api = await import('@/lib/api');
  vi.spyOn(api, 'verifyAuthToken').mockImplementation(token => verify(token));
  verify.mockResolvedValue({ id: 'u-incoming', role: 'LEARNER' });
  Page = (await import('@/app/login/callback/page')).default;
  window.history.replaceState(null, '', '/login/callback#token=somebody-elses-token');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Page />);
  });
  // The page's own work is one awaited call away.
  await act(async () => {
    await Promise.resolve();
  });
}

describe('the Google callback page', () => {
  it('preserves a valid same-browser handoff through StrictMode effect replay', async () => {
    api.markGoogleSignInStarted();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<StrictMode><Page /></StrictMode>));
    expect(verify).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/dashboard');
    expect(host.querySelector('[data-testid="google-callback-error"]')).toBeNull();
    expect(location.hash).toBe('');
  });

  it('preserves a safe return target on the retry link after callback refusal', async () => {
    history.replaceState(null, '', '/login/callback?next=%2Fprogress#token=unstarted');
    await render();
    expect(host!.querySelector('a')?.getAttribute('href')).toBe('/login?next=%2Fprogress');
    expect(verify).not.toHaveBeenCalled();
  });
  it('refuses a token when this tab never started a sign-in', async () => {
    await render();

    expect(host!.querySelector('[data-testid="google-callback-error"]')?.textContent).toContain(
      'did not carry a session',
    );
    // Nothing was stored, nothing was asked, nobody was moved.
    expect(window.localStorage.getItem('lsdlc_token')).toBeNull();
    expect(verify).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('keeps the token when it is this tab coming back from Google', async () => {
    api.markGoogleSignInStarted();
    await render();

    expect(verify).toHaveBeenCalledWith('somebody-elses-token');
    expect(window.localStorage.getItem('lsdlc_token')).toBe('somebody-elses-token');
    expect(replace).toHaveBeenCalledWith('/dashboard');
    // And the mark is spent: the next landing needs its own press.
    expect(window.sessionStorage.getItem('lsdlc_oauth_started')).toBeNull();
    expect(window.location.hash).toBe('');
  });

  it('validates the incoming token while preserving a different temporary session', async () => {
    window.sessionStorage.setItem('lsdlc_token', 'existing-temporary-token');
    verify.mockImplementation(async (token) => {
      expect(token).toBe('somebody-elses-token');
      expect(api.getToken()).toBe('existing-temporary-token');
      return { id: 'u-incoming', role: 'LEARNER' };
    });
    api.markGoogleSignInStarted();
    await render();
    expect(api.getToken()).toBe('somebody-elses-token');
    expect(window.sessionStorage.getItem('lsdlc_token')).toBeNull();
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });

  it('keeps the existing session when the incoming callback token is refused', async () => {
    window.localStorage.setItem('lsdlc_token', 'existing-valid-token');
    verify.mockRejectedValue(new api.ApiError(401, 'Invalid credential'));
    api.markGoogleSignInStarted();
    await render();
    expect(api.getToken()).toBe('existing-valid-token');
    expect(host!.querySelector('[data-testid="google-callback-error"]')?.textContent).toContain('session was not accepted');
    expect(replace).not.toHaveBeenCalled();
  });

  it('takes the session the head script captured, with nothing left in the address bar', async () => {
    // What a real browser does now: the inline script in <head> scrubbed the
    // fragment before this page existed and is holding the token in memory.
    // Every case above is the same page with no script in front of it, which
    // is also a client-side navigation and jsdom.
    history.replaceState(null, '', '/login/callback');
    window.__lsdlcAuthHandoff = { token: 'from-head', hash: true };
    api.markGoogleSignInStarted();

    await render();

    expect(verify).toHaveBeenCalledWith('from-head');
    expect(window.localStorage.getItem('lsdlc_token')).toBe('from-head');
    expect(replace).toHaveBeenCalledWith('/dashboard');
    // Collected once. Nothing is left on the window for a later reader.
    expect(window.__lsdlcAuthHandoff).toBeUndefined();
    expect(window.location.hash).toBe('');
  });
});
