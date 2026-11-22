// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '@learnsdlc/shared';
import { clearSession, getSession, setAuthSession, setSession } from '@/lib/session';
import { SessionGate } from '@/components/shell/SessionGate';

const calls = vi.hoisted(() => ({ me: vi.fn(), replace: vi.fn(), mounted: vi.fn() }));
const router = vi.hoisted(() => ({ replace: calls.replace }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/api', async () => {
  const session = await import('@/lib/session');
  return { api: { me: calls.me }, getToken: session.getToken, signInHref: () => '/login?next=%2Fprofile', describeError: (error: Error) => error.message };
});
const learner: UserProfile = { id: 'gate-learner-a', email: 'gate-a@example.test', displayName: 'Learner A', role: 'LEARNER', cohort: 'default', createdAt: '2026-09-13T00:00:00Z', onboardingCompleted: true };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function PrivatePage() {
  const [draft, setDraft] = useState('Private workspace');
  useEffect(() => { calls.mounted(); }, []);
  return <button data-testid="private-page" onClick={() => setDraft('Unsent private draft')}>{draft}</button>;
}
let host: HTMLDivElement, root: Root;
const mount = () => act(async () => { root.render(<SessionGate><PrivatePage /></SessionGate>); });
beforeEach(() => { clearSession(); localStorage.clear(); sessionStorage.clear(); calls.me.mockReset(); calls.replace.mockReset(); calls.mounted.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); clearSession(); });

describe('server-confirmed session gate', () => {
  it('hydrates a returning session without redirecting its initial server snapshot to sign-in', async () => {
    act(() => root.unmount());
    setAuthSession('returning-token', learner, { persist: false });
    const pending = deferred<UserProfile>(); calls.me.mockReturnValueOnce(pending.promise);
    host.innerHTML = renderToString(<SessionGate><PrivatePage /></SessionGate>);
    await act(async () => { root = hydrateRoot(host, <SessionGate><PrivatePage /></SessionGate>); });
    expect(calls.replace).not.toHaveBeenCalled();
    expect(calls.me).toHaveBeenCalledTimes(1); expect(calls.mounted).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(learner); });
    expect(calls.mounted).toHaveBeenCalledTimes(1);
  });
  it('never renders private route markup on the server or mounts it without credentials', async () => {
    expect(renderToString(<SessionGate><PrivatePage /></SessionGate>)).not.toContain('private-page');
    await mount();
    expect(calls.mounted).not.toHaveBeenCalled(); expect(calls.me).not.toHaveBeenCalled();
    expect(calls.replace).toHaveBeenCalledWith('/login?next=%2Fprofile');
  });
  it('does not trust a stored role or token until the API confirms the account', async () => {
    const pending = deferred<UserProfile>(); calls.me.mockReturnValueOnce(pending.promise);
    setAuthSession('pending-token', { ...learner, role: 'ADMIN' }); await mount();
    expect(calls.mounted).not.toHaveBeenCalled(); expect(host.querySelector('[data-testid="private-page"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Checking');
    await act(async () => { pending.resolve(learner); });
    expect(getSession()?.role).toBe('LEARNER'); expect(calls.mounted).toHaveBeenCalledTimes(1);
  });
  it('keeps ordinary route and profile changes smooth without re-verifying or remounting private state', async () => {
    setAuthSession('confirmed-token', learner); calls.me.mockResolvedValueOnce(learner); await mount();
    const button = host.querySelector<HTMLButtonElement>('[data-testid="private-page"]')!;
    act(() => button.click());
    act(() => setSession({ ...learner, displayName: 'Updated name' })); await mount();
    expect(host.querySelector('[data-testid="private-page"]')).toBe(button);
    expect(button.textContent).toBe('Unsent private draft'); expect(calls.me).toHaveBeenCalledTimes(1);
  });
  it('offers recovery on provider-independent API failure without showing a private route', async () => {
    setAuthSession('unavailable-token', learner); calls.me.mockRejectedValueOnce(new Error('Service unavailable. Reference check-ref.')).mockResolvedValueOnce(learner);
    await mount(); expect(calls.mounted).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('check-ref');
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="session-retry"]')!.click(); });
    expect(calls.me).toHaveBeenCalledTimes(2); expect(calls.mounted).toHaveBeenCalledTimes(1);
  });
  it('removes private state immediately on logout and ignores a late verification', async () => {
    const pending = deferred<UserProfile>(); calls.me.mockReturnValueOnce(pending.promise);
    setAuthSession('ending-token', learner); await mount();
    act(() => clearSession()); await act(async () => { pending.resolve(learner); });
    expect(calls.mounted).not.toHaveBeenCalled(); expect(getSession()).toBeNull();
    expect(calls.replace).toHaveBeenCalledWith('/login?next=%2Fprofile');
  });
  it('verifies a replacement account separately and discards the former account’s late reply', async () => {
    const old = deferred<UserProfile>(), fresh = deferred<UserProfile>();
    calls.me.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    setAuthSession('old-token', learner); await mount();
    const next = { ...learner, id: 'gate-learner-b', displayName: 'Learner B' };
    act(() => setAuthSession('new-token', next));
    await act(async () => { old.resolve(learner); });
    expect(calls.mounted).not.toHaveBeenCalled(); expect(getSession()?.id).toBe(next.id);
    await act(async () => { fresh.resolve(next); });
    expect(calls.mounted).toHaveBeenCalledTimes(1); expect(getSession()?.id).toBe(next.id);
  });
});
