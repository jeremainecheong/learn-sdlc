// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The managed session renews itself while in use.
 *
 * The API signs a managed session for three hours and answers
 * `POST /auth/renew` with a fresh token for the same sign-in (same `orig`)
 * until twelve hours after it. `request` (lib/api.ts) asks for one in the
 * background once the token it is about to send has under two hours left, at
 * most once every five minutes; a renewed token replaces the old one in the
 * store the sign-in chose, the socket reconnects with it, and a refusal
 * changes nothing. A week-long local token never comes near the threshold.
 */

const NOW = Date.UTC(2026, 10, 9, 4, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const sockets = vi.hoisted(() => ({ made: [] as Array<{ options: Record<string, unknown>; instance: any }> }));

vi.mock('socket.io-client', () => ({
  io: (_url: string, options: Record<string, unknown>) => {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const instance: any = {
      connected: true,
      active: true,
      on(event: string, fn: (...a: unknown[]) => void) { (handlers[event] ??= []).push(fn); return instance; },
      emit(event: string, ...a: unknown[]) { (handlers[event] ?? []).forEach((fn) => fn(...a)); },
    };
    instance.connect = vi.fn(() => { instance.active = true; instance.connected = true; return instance; });
    instance.disconnect = vi.fn(() => {
      instance.active = false; instance.connected = false; instance.emit('disconnect', 'io client disconnect'); return instance;
    });
    sockets.made.push({ options, instance });
    return instance;
  },
}));

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A token shaped as the API signs it; the signature is never checked here. */
function jwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.signature`;
}

const ORIG = NOW - 70 * MIN;
const managed = (left: number, extra: Record<string, unknown> = {}) =>
  jwt({ sub: 'user-1', ver: 0, provider: 'cognito', orig: ORIG, iat: Math.floor((NOW + left - 3 * HOUR) / 1000), exp: Math.floor((NOW + left) / 1000), ...extra });

const profile = { id: 'user-1', email: 'learner@learnsdlc.test', displayName: 'Learner', role: 'LEARNER', cohort: 'default' } as never;

let renewAnswer: () => Promise<unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

const renewCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/renew'));
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); };

async function load() {
  const api = await import('@/lib/api');
  const session = await import('@/lib/session');
  const tokens = await import('@/lib/session-token');
  return { api, session, tokens };
}

beforeEach(() => {
  vi.resetModules();
  sockets.made.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  renewAnswer = async () => ({ ok: false, status: 401, json: async () => ({ code: 'session-cap-reached' }) });
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith('/auth/renew')) return renewAnswer();
    return { ok: true, status: 200, json: async () => ({}), headers: new Headers() };
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the token decoder', () => {
  it('reads exp and never throws on a malformed token', async () => {
    const { tokenExpiresAt, sameSession } = await import('@/lib/session-token');
    expect(tokenExpiresAt(managed(HOUR))).toBe(Math.floor((NOW + HOUR) / 1000) * 1000);
    for (const bad of ['', 'token-a', 'a.b', 'a.b.c', 'a.%%%.c', `x.${btoa('[1]')}.y`, `x.${b64url({ exp: 'soon' })}.y`]) {
      expect(() => tokenExpiresAt(bad)).not.toThrow();
      expect(tokenExpiresAt(bad)).toBeNull();
      expect(sameSession(bad, managed(HOUR))).toBe(false);
    }
  });

  it('counts a renewal as the same session, and nothing else', async () => {
    const { sameSession } = await import('@/lib/session-token');
    expect(sameSession(managed(HOUR), managed(3 * HOUR))).toBe(true);
    expect(sameSession(managed(HOUR), managed(3 * HOUR, { orig: ORIG + 1 }))).toBe(false);
    expect(sameSession(managed(HOUR), managed(3 * HOUR, { sub: 'user-2' }))).toBe(false);
    // A local token has no orig: only the identical token is the same session.
    const local = jwt({ sub: 'user-1', ver: 0, provider: 'local', exp: 1 });
    expect(sameSession(local, local)).toBe(true);
    expect(sameSession(local, jwt({ sub: 'user-1', ver: 0, provider: 'local', exp: 2 }))).toBe(false);
  });

  it('a malformed stored token sends no renewal and does not break the call', async () => {
    const { api, session } = await load();
    session.setAuthSession('token-a', profile);
    await expect(api.request('GET', '/projects')).resolves.toEqual({});
    await settle();
    expect(renewCalls()).toHaveLength(0);
  });
});

describe('when request renews', () => {
  it('renews under two hours left, not at two hours and a minute, never for a week-long token', async () => {
    const { api, session } = await load();
    session.setAuthSession(managed(2 * HOUR + MIN), profile);
    await api.request('GET', '/projects');
    session.setAuthSession(jwt({ sub: 'user-1', ver: 0, provider: 'local', iat: NOW / 1000, exp: NOW / 1000 + 7 * 24 * 3600 }), profile);
    await api.request('GET', '/projects');
    await settle();
    expect(renewCalls()).toHaveLength(0);

    session.setAuthSession(managed(2 * HOUR - MIN), profile);
    await api.request('GET', '/projects');
    await settle();
    expect(renewCalls()).toHaveLength(1);
    const [url, init] = renewCalls()[0];
    expect(String(url)).toMatch(/\/api\/v1\/auth\/renew$/);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${managed(2 * HOUR - MIN)}`);
  });

  it('tries at most once in five minutes', async () => {
    const { api, session } = await load();
    session.setAuthSession(managed(90 * MIN), profile);
    await api.request('GET', '/projects');
    await api.request('GET', '/projects');
    vi.setSystemTime(NOW + 4 * MIN);
    await api.request('GET', '/projects');
    await settle();
    expect(renewCalls()).toHaveLength(1);
    vi.setSystemTime(NOW + 5 * MIN + 1_000);
    await api.request('GET', '/projects');
    await settle();
    expect(renewCalls()).toHaveLength(2);
  });

  it('stores the renewed token where the sign-in did and the socket reconnects with it', async () => {
    const { api, session } = await load();
    const socketModule = await import('@/lib/socket');
    const old = managed(90 * MIN);
    const renewed = managed(3 * HOUR);
    session.setAuthSession(old, profile, { persist: false });
    // A cache tied to the token must survive a renewal: it is the same learner.
    const dropped = vi.fn();
    const own = session.ownedByToken(dropped);
    own();
    dropped.mockClear();
    const ended = vi.fn();
    session.onSessionEnd(ended);
    const sock = socketModule.getSocket();
    expect(sock).not.toBeNull();
    renewAnswer = async () => ({ ok: true, status: 200, json: async () => ({ token: renewed, user: profile }) });

    await api.request('GET', '/projects');
    await settle();

    expect(api.getToken()).toBe(renewed);
    expect(window.sessionStorage.getItem(session.TOKEN_KEY)).toBe(renewed);
    expect(window.localStorage.getItem(session.TOKEN_KEY)).toBeNull();
    expect(session.getSession()).toEqual(profile);
    own();
    expect(dropped).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
    // The same instance reconnects, and its handshake reads the new token.
    expect(sockets.made).toHaveLength(1);
    const { instance, options } = sockets.made[0];
    expect(instance.disconnect).toHaveBeenCalled();
    expect(instance.connect).toHaveBeenCalled();
    let sent: unknown;
    (options.auth as (cb: (d: unknown) => void) => void)((d) => { sent = d; });
    expect(sent).toEqual({ token: renewed });
    expect(socketModule.getSocket()).toBe(sock);
    // The next call signs with the renewed token.
    await api.request('GET', '/projects');
    expect(fetchMock.mock.calls.at(-1)?.[1].headers.authorization).toBe(`Bearer ${renewed}`);
  });

  it('a refused or failed renewal leaves the old token in place and the learner where they are', async () => {
    const { api, session } = await load();
    const old = managed(90 * MIN);
    session.setAuthSession(old, profile);
    const href = window.location.href;

    await api.request('GET', '/projects');
    await settle();
    expect(renewCalls()).toHaveLength(1);
    expect(api.getToken()).toBe(old);
    expect(window.location.href).toBe(href);

    vi.setSystemTime(NOW + 6 * MIN);
    renewAnswer = async () => { throw new TypeError('network down'); };
    await api.request('GET', '/projects');
    await settle();
    expect(renewCalls()).toHaveLength(2);
    expect(api.getToken()).toBe(old);

    // An answer that is not a renewal of this sign-in is not taken either.
    vi.setSystemTime(NOW + 12 * MIN);
    renewAnswer = async () => ({ ok: true, status: 200, json: async () => ({ token: managed(3 * HOUR, { sub: 'user-2' }), user: profile }) });
    await api.request('GET', '/projects');
    await settle();
    expect(renewCalls()).toHaveLength(3);
    expect(api.getToken()).toBe(old);
    expect(session.getSession()).toEqual(profile);
  });
});
