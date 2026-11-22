/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '@learnsdlc/shared';

/**
 * Who is signed in, as an external store.
 *
 * The store is module state, deliberately: it is read synchronously by
 * everything that draws the shell. So each case re-imports the module to get a
 * fresh one, exactly as a page load would.
 */

type Session = typeof import('@/lib/session');

const learner: UserProfile = {
  id: 'u1',
  email: 'ada@example.test',
  displayName: 'Ada',
  role: 'LEARNER',
  cohort: 'default',
} as UserProfile;

let session: Session;

beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.resetModules();
  session = await import('@/lib/session');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading the session', () => {
  it('is null when nothing is stored', () => {
    expect(session.getSession()).toBeNull();
    expect(session.getToken()).toBeNull();
  });

  it('reads the stored profile, and keeps handing back the same object', () => {
    window.localStorage.setItem(session.USER_KEY, JSON.stringify(learner));
    const first = session.getSession();
    expect(first).toMatchObject({ id: 'u1', displayName: 'Ada' });
    // useSyncExternalStore re-renders for ever if the snapshot changes identity.
    expect(session.getSession()).toBe(first);
  });

  it('drops a stored profile it cannot parse rather than throwing on every render', () => {
    window.localStorage.setItem(session.USER_KEY, '{not json');
    expect(session.getSession()).toBeNull();
    expect(window.localStorage.getItem(session.USER_KEY)).toBeNull();
  });

  it('is null, not a crash, in a browser that refuses storage', async () => {
    vi.resetModules();
    const boom = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
    const blocked: Session = await import('@/lib/session');
    expect(blocked.getSession()).toBeNull();
    expect(blocked.getToken()).toBeNull();
    expect(() => blocked.setSession(learner)).not.toThrow();
    // The store still holds the truth for this page even with nothing written.
    expect(blocked.getSession()).toEqual(learner);
  });
});

describe('writing the session', () => {
  it('writes through to storage and tells everything that shows it', () => {
    const told = vi.fn();
    session.subscribe(told);

    session.setSession(learner);

    expect(told).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.localStorage.getItem(session.USER_KEY) as string)).toEqual(learner);
    expect(session.getSession()).toEqual(learner);
  });

  it('ends the session: the token, the profile and every cache keyed on them', () => {
    window.localStorage.setItem(session.TOKEN_KEY, 'jwt-value');
    session.setSession(learner);
    const emptied = vi.fn();
    session.onSessionEnd(emptied);

    session.clearSession();

    expect(session.getSession()).toBeNull();
    expect(window.localStorage.getItem(session.TOKEN_KEY)).toBeNull();
    expect(window.localStorage.getItem(session.USER_KEY)).toBeNull();
    expect(emptied).toHaveBeenCalledTimes(1);
  });

  it('does not call the enders when a profile is merely written', () => {
    const emptied = vi.fn();
    session.onSessionEnd(emptied);
    session.setSession(learner);
    expect(emptied).not.toHaveBeenCalled();
  });

  it('stops telling a subscriber that has unsubscribed', () => {
    const told = vi.fn();
    session.subscribe(told)();
    session.setSession(learner);
    expect(told).not.toHaveBeenCalled();
  });
});

describe('another tab', () => {
  it('adopts a sign-in made in the other tab', () => {
    const told = vi.fn();
    // The shell reads the store as it renders and subscribes to it; the
    // listener on `storage` is attached by that subscription.
    session.getSession();
    session.subscribe(told);

    window.dispatchEvent(
      new StorageEvent('storage', { key: session.USER_KEY, newValue: JSON.stringify(learner) }),
    );

    expect(session.getSession()).toEqual(learner);
    expect(told).toHaveBeenCalled();
  });

  it('ends the session here when the other tab drops the token', () => {
    session.subscribe(() => undefined);
    session.setSession(learner);
    window.dispatchEvent(new StorageEvent('storage', { key: session.TOKEN_KEY, newValue: null }));
    expect(session.getSession()).toBeNull();
  });

  it('ignores a key that is not ours', () => {
    session.subscribe(() => undefined);
    session.setSession(learner);
    window.dispatchEvent(new StorageEvent('storage', { key: 'something_else', newValue: null }));
    expect(session.getSession()).toEqual(learner);
  });
});

describe('ownedByToken', () => {
  it('adopts the token it was first asked under, and leaves the cache alone after that', () => {
    window.localStorage.setItem(session.TOKEN_KEY, 'first-token');
    const drop = vi.fn();
    const own = session.ownedByToken(drop);

    own();
    own();
    own();
    expect(drop).toHaveBeenCalledTimes(1);
  });

  it('has nothing to empty before anyone has signed in', () => {
    const drop = vi.fn();
    session.ownedByToken(drop)();
    expect(drop).not.toHaveBeenCalled();
  });

  it('empties it when a second learner signs in over the first', () => {
    window.localStorage.setItem(session.TOKEN_KEY, 'first-token');
    const drop = vi.fn();
    const own = session.ownedByToken(drop);
    own();
    drop.mockClear();

    // Signing in as somebody else in the same tab never ends a session, so a
    // cache that only listened for the end would hand over the first
    // learner's work.
    window.localStorage.setItem(session.TOKEN_KEY, 'second-token');
    own();

    expect(drop).toHaveBeenCalledTimes(1);
  });
});

describe('sameProfile', () => {
  it('is true for the same five facts and false for any change to them', () => {
    expect(session.sameProfile(learner, { ...learner })).toBe(true);
    expect(session.sameProfile(null, null)).toBe(true);
    expect(session.sameProfile(learner, null)).toBe(false);
    expect(session.sameProfile(learner, { ...learner, displayName: 'Ada L' })).toBe(false);
    expect(session.sameProfile(learner, { ...learner, role: 'INSTRUCTOR' } as UserProfile)).toBe(false);
    expect(session.sameProfile(learner, { ...learner, cohort: 'cohort-b' } as UserProfile)).toBe(false);
  });
});

describe('remembered and temporary credentials', () => {
  it('keeps an unchecked sign-in through refresh without leaving a remembered token', async () => {
    session.setAuthSession('temporary-token', learner, { persist: false });
    expect(window.localStorage.getItem(session.TOKEN_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(session.TOKEN_KEY)).toBe('temporary-token');
    vi.resetModules();
    const refreshed: Session = await import('@/lib/session');
    expect(refreshed.getToken()).toBe('temporary-token');
    expect(refreshed.getSession()).toEqual(learner);
    refreshed.setSession({ ...learner, displayName: 'Ada updated' });
    expect(JSON.parse(window.sessionStorage.getItem(session.USER_KEY)!)).toMatchObject({ displayName: 'Ada updated' });
    expect(window.localStorage.getItem(session.USER_KEY)).toBeNull();
    window.sessionStorage.clear();
    vi.resetModules();
    const newBrowsingSession: Session = await import('@/lib/session');
    expect(newBrowsingSession.getToken()).toBeNull();
    expect(newBrowsingSession.getSession()).toBeNull();
  });

  it('defaults to remembered credentials and moves credentials when the choice changes', () => {
    session.setAuthSession('remembered-token', learner);
    expect(window.localStorage.getItem(session.TOKEN_KEY)).toBe('remembered-token');
    session.setAuthSession('temporary-token', learner, { persist: false });
    expect(window.localStorage.getItem(session.TOKEN_KEY)).toBeNull();
    session.setAuthSession('remembered-again', learner, { persist: true });
    expect(window.sessionStorage.getItem(session.TOKEN_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(session.USER_KEY)).toBeNull();
    expect(session.getToken()).toBe('remembered-again');
  });

  it('does not adopt a different tab’s persistent identity while signed in temporarily', () => {
    session.setAuthSession('temporary-token', learner, { persist: false });
    session.subscribe(() => undefined);
    window.dispatchEvent(new StorageEvent('storage', { key: session.USER_KEY, newValue: JSON.stringify({ ...learner, id: 'u2' }), storageArea: window.localStorage }));
    window.dispatchEvent(new StorageEvent('storage', { key: session.TOKEN_KEY, newValue: null, storageArea: window.localStorage }));
    expect(session.getToken()).toBe('temporary-token');
    expect(session.getSession()?.id).toBe('u1');
  });

  it('holds a refused temporary token in the same store that protects per-user caches', () => {
    const boom = () => { throw new DOMException('Blocked', 'SecurityError'); };
    vi.stubGlobal('sessionStorage', { getItem: boom, setItem: boom, removeItem: boom });
    expect(session.setAuthSession('held-first', learner, { persist: false })).toBe(false);
    expect(session.getToken()).toBe('held-first');
    const drop = vi.fn();
    const own = session.ownedByToken(drop);
    own(); drop.mockClear();
    session.setAuthSession('held-second', { ...learner, id: 'u2' }, { persist: false });
    own();
    expect(drop).toHaveBeenCalledTimes(1);
    expect(session.getToken()).toBe('held-second');
    expect(window.localStorage.getItem(session.TOKEN_KEY)).toBeNull();
    session.clearSession();
    expect(session.getToken()).toBeNull();
    expect(session.getSession()).toBeNull();
  });

  it('clears both stores, including stale credentials left by an earlier version', () => {
    session.setAuthSession('temporary-token', learner, { persist: false });
    window.localStorage.setItem(session.TOKEN_KEY, 'stale-token');
    window.localStorage.setItem(session.USER_KEY, JSON.stringify({ ...learner, id: 'other' }));
    session.clearSession();
    for (const store of [window.localStorage, window.sessionStorage]) {
      expect(store.getItem(session.TOKEN_KEY)).toBeNull();
      expect(store.getItem(session.USER_KEY)).toBeNull();
    }
  });
});
