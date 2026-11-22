// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '@learnsdlc/shared';
import { clearSession, setAuthSession } from '@/lib/session';
import { SessionGate, SESSION_RECONNECT_MAX_MS } from '@/components/shell/SessionGate';

/**
 * The session gate reconnects by itself (browser proof:
 * e2e/error-recovery-keyboard.spec.ts).
 *
 * A page opened while the API is unreachable is answered by the session gate:
 * "Can't reach the server", one heading, and Try again. Nothing has to be
 * pressed: once the server is back, the page picks the connection up by
 * itself, rather than retrying only on the button. The gate retries a
 * failure that says the server was not reached (or
 * was down: a 5xx, a timeout, a rate limit) on a bounded backoff, and at once
 * when the browser comes back online or the tab is looked at again. A refusal
 * that retrying cannot change is left to the button.
 */

const calls = vi.hoisted(() => ({ me: vi.fn(), replace: vi.fn(), mounted: vi.fn() }));
const router = vi.hoisted(() => ({ replace: calls.replace }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/api', async () => {
  const session = await import('@/lib/session');
  return {
    api: { me: calls.me },
    getToken: session.getToken,
    signInHref: () => '/login?next=%2Fcomplete',
    describeError: (error: Error) =>
      error instanceof TypeError ? "Can't reach the server. Check your connection and try again." : error.message,
  };
});

const learner: UserProfile = { id: 'gate-learner-r', email: 'gate-r@example.test', displayName: 'Learner R', role: 'LEARNER', cohort: 'default', createdAt: '2026-09-13T00:00:00Z', onboardingCompleted: true };
const unreachable = () => new TypeError('Failed to fetch');
const refused = (status: number) => Object.assign(new Error(`Refused ${status}`), { status });

function Private() {
  calls.mounted();
  return <p data-testid="private-page">The completion record becomes available</p>;
}
let host: HTMLDivElement, root: Root;
const mount = () => act(async () => { root.render(<SessionGate><Private /></SessionGate>); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const retryButton = () => host.querySelector('[data-testid="session-retry"]');
const alert = () => host.querySelector('[role="alert"]')?.textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers();
  clearSession(); localStorage.clear(); sessionStorage.clear();
  calls.me.mockReset(); calls.replace.mockReset(); calls.mounted.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  setAuthSession('reconnect-token', learner);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearSession(); vi.useRealTimers(); });

describe('the session gate, when the server was not reached', () => {
  it('comes back by itself once the server answers, with nothing pressed', async () => {
    calls.me.mockRejectedValueOnce(unreachable()).mockResolvedValueOnce(learner);
    await mount();
    expect(alert()).toContain("Can't reach the server");
    expect(retryButton()).not.toBeNull();
    expect(calls.mounted).not.toHaveBeenCalled();

    await advance(SESSION_RECONNECT_MAX_MS);
    expect(calls.me).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="private-page"]')).not.toBeNull();
    expect(retryButton()).toBeNull();
  });

  it('keeps saying so, with its button, while it keeps trying — never flickers to a spinner', async () => {
    calls.me.mockRejectedValue(unreachable());
    await mount();
    for (let tries = 2; tries <= 6; tries += 1) {
      await advance(SESSION_RECONNECT_MAX_MS);
      expect(calls.me).toHaveBeenCalledTimes(tries);
      expect(alert()).toContain("Can't reach the server");
      expect(retryButton()).not.toBeNull();
    }
    // However long the server was away, it is retried at least this often.
    calls.me.mockResolvedValueOnce(learner);
    await advance(SESSION_RECONNECT_MAX_MS);
    expect(host.querySelector('[data-testid="private-page"]')).not.toBeNull();
  });

  it('does not flicker to a spinner while a retry is still in flight', async () => {
    let answer: (value: UserProfile) => void = () => {};
    calls.me
      .mockRejectedValueOnce(unreachable())
      .mockImplementationOnce(() => new Promise<UserProfile>((resolve) => { answer = resolve; }));
    await mount();
    await advance(SESSION_RECONNECT_MAX_MS);
    // The second check has been asked and has not answered yet.
    expect(calls.me).toHaveBeenCalledTimes(2);
    expect(alert()).toContain("Can't reach the server");
    expect(retryButton()).not.toBeNull();
    await act(async () => { answer(learner); });
    expect(host.querySelector('[data-testid="private-page"]')).not.toBeNull();
  });

  it('retries at once when the browser comes back online', async () => {
    calls.me.mockRejectedValueOnce(unreachable()).mockResolvedValueOnce(learner);
    await mount();
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(calls.me).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="private-page"]')).not.toBeNull();
  });

  it('retries a server that answered it was down (5xx) the same way', async () => {
    calls.me.mockRejectedValueOnce(refused(503)).mockResolvedValueOnce(learner);
    await mount();
    await advance(SESSION_RECONNECT_MAX_MS);
    expect(calls.me).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="private-page"]')).not.toBeNull();
  });

  it('leaves a refusal retrying cannot change to the button', async () => {
    calls.me.mockRejectedValueOnce(refused(403)).mockResolvedValueOnce(learner);
    await mount();
    await advance(SESSION_RECONNECT_MAX_MS * 6);
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(calls.me).toHaveBeenCalledTimes(1);
    expect(retryButton()).not.toBeNull();
  });

  it('stops trying once the learner signs out', async () => {
    calls.me.mockRejectedValue(unreachable());
    await mount();
    act(() => clearSession());
    await advance(SESSION_RECONNECT_MAX_MS * 3);
    expect(calls.me).toHaveBeenCalledTimes(1);
  });
});
