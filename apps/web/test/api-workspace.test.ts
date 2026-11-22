/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseDetail } from '@learnsdlc/shared';
import { API_URL } from '@/lib/api';
import { detail, file, phase, userProfile } from './fixtures';

/**
 * The last save, made on the way out, and the local copy that catches it when
 * it does not land.
 *
 * This is the path a learner's work is actually lost on: they type, click the
 * sidebar before the debounce fires, and the request goes out into a session
 * that may already be over. Every rule here (write it down first, sign it
 * with the token the session ended with, drop only the files that landed, give
 * up on keepalive above 64 KiB) exists because one of them was missing once.
 */

const request = vi.fn();
const getToken = vi.fn<() => string | null>(() => 'live-token');
const tokenAtSessionEnd = vi.fn<() => string | null>(() => null);

/** What the module registered for a deliberate sign-out; the test presses the button by calling them. */
const signOutHooks: Array<() => void> = [];
const signOut = () => signOutHooks.forEach((fn) => fn());

vi.mock('@/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api')>();
  return {
    API_URL: real.API_URL,
    API_BASE: real.API_BASE,
    REQUEST_TIMEOUT_MS: real.REQUEST_TIMEOUT_MS,
    request: (...args: unknown[]) => request(...args),
    getToken: () => getToken(),
    tokenAtSessionEnd: () => tokenAtSessionEnd(),
    onSignOut: (fn: () => void) => {
      signOutHooks.push(fn);
      return () => undefined;
    },
  };
});

type Workspace = typeof import('@/lib/api-workspace');
type Session = typeof import('@/lib/session');
let workspace: Workspace;
let session: Session;
const fetchMock = vi.fn();

const DRAFT = 'lsdlc_draft_p1';
const STORY = 'requirements/draft.md';
/** The learner every draft below belongs to. */
const ME = 'u1';

/** A draft as the app writes it: stamped with the account that typed it. */
const owed = (files: Record<string, string>, over: Partial<{ at: number; by: string }> = {}) =>
  JSON.stringify({ at: Date.now(), by: ME, files, ...over });

const serverPhase = (content: string): PhaseDetail =>
  detail(phase('requirements', 1, 'p1', 'in_progress'), [
    file(STORY, content, true, 'markdown'),
    file('requirements/backlog.md', 'given', false, 'markdown'),
  ]);

const draftIn = (): { at: number; by: string; files: Record<string, string> } | null => {
  const raw = window.localStorage.getItem(DRAFT);
  return raw ? JSON.parse(raw) : null;
};

beforeEach(async () => {
  window.localStorage.clear();
  request.mockReset();
  getToken.mockReset().mockReturnValue('live-token');
  tokenAtSessionEnd.mockReset().mockReturnValue(null);
  fetchMock.mockReset().mockResolvedValue({ ok: true } as Response);
  vi.stubGlobal('fetch', fetchMock);
  signOutHooks.length = 0;
  vi.resetModules();
  session = await import('@/lib/session');
  // Signed in, because a draft belongs to somebody: it is written under the
  // account that typed it and read back only under that account.
  session.setSession(userProfile({ id: ME, email: 'ada@example.test', role: 'LEARNER' }));
  workspace = await import('@/lib/api-workspace');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saveWorkspaceOnExit', () => {
  it('writes the files down before it sends them, and forgets them once they land', async () => {
    await workspace.saveWorkspaceOnExit('p1', { [STORY]: 'typed on the way out' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_URL}/api/v1/phases/p1/workspace`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ files: { [STORY]: 'typed on the way out' } });
    // It landed, so nothing is owed.
    expect(draftIn()).toBeNull();
  });

  it('keeps the draft when the request never lands', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await workspace.saveWorkspaceOnExit('p1', { [STORY]: 'never reached the server' });
    expect(draftIn()?.files).toEqual({ [STORY]: 'never reached the server' });

    // And when the server refuses it.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    await workspace.saveWorkspaceOnExit('p1', { [STORY]: 'refused' });
    expect(draftIn()?.files).toEqual({ [STORY]: 'refused' });
  });

  it('keeps what was typed while the request was in flight', async () => {
    let land: (res: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          land = resolve;
        }),
    );

    const sending = workspace.saveWorkspaceOnExit('p1', { [STORY]: 'what was sent' });
    // Another keystroke, while the request above is still out. The save that
    // is about to land is not evidence that this one reached anybody.
    window.localStorage.setItem(
      DRAFT,
      owed({ [STORY]: 'newer still' }),
    );
    land({ ok: true } as Response);
    await sending;

    expect(draftIn()?.files).toEqual({ [STORY]: 'newer still' });
  });

  it('adds to a draft that is already owed rather than replacing it', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await workspace.saveWorkspaceOnExit('p1', { [STORY]: 'the story' });
    await workspace.saveWorkspaceOnExit('p1', { 'requirements/notes.md': 'the notes' });

    expect(draftIn()?.files).toEqual({
      [STORY]: 'the story',
      'requirements/notes.md': 'the notes',
    });
  });

  it('signs the write with the token the session ended with', async () => {
    getToken.mockReturnValue(null);
    tokenAtSessionEnd.mockReturnValue('the-expiring-one');

    await workspace.saveWorkspaceOnExit('p1', { [STORY]: 'last words' });

    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers.authorization).toBe('Bearer the-expiring-one');
  });

  it('gives up keepalive rather than the save when the body is too big for it', async () => {
    await workspace.saveWorkspaceOnExit('p1', { [STORY]: 'a'.repeat(100) });
    expect((fetchMock.mock.calls[0][1] as RequestInit).keepalive).toBe(true);

    // The Fetch standard gives a page 64 KiB of keepalive body; the API accepts
    // 200,000 characters a file, and a browser rejects an over-budget
    // keepalive request whole and silently.
    fetchMock.mockClear();
    await workspace.saveWorkspaceOnExit('p1', { [STORY]: 'b'.repeat(70_000) });
    expect((fetchMock.mock.calls[0][1] as RequestInit).keepalive).toBe(false);
  });

  it('sends nothing when there is nothing to send', async () => {
    await workspace.saveWorkspaceOnExit('p1', {});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('loading a phase', () => {
  it('is the server’s copy when nothing is owed', async () => {
    request.mockResolvedValueOnce(serverPhase('what the server has'));

    const got = await workspace.workspaceApi.phase('p1');
    expect(got.files[0].content).toBe('what the server has');
    expect(request).toHaveBeenCalledWith('GET', '/phases/p1');
  });

  it('puts back the edits that never reached the server, under the new session', async () => {
    window.localStorage.setItem(
      DRAFT,
      owed({ [STORY]: 'the text the learner typed' }),
    );
    request
      .mockResolvedValueOnce(serverPhase('the older text the server has'))
      .mockResolvedValueOnce({ saved: true });

    const got = await workspace.workspaceApi.phase('p1');

    expect(request).toHaveBeenLastCalledWith('PUT', '/phases/p1/workspace', {
      files: { [STORY]: 'the text the learner typed' },
    });
    // The learner opens the file and their text is in it.
    expect(got.files[0].content).toBe('the text the learner typed');
    expect(draftIn()).toBeNull();
  });

  it('drops a draft the server has already caught up with', async () => {
    window.localStorage.setItem(
      DRAFT,
      owed({ [STORY]: 'the same text' }),
    );
    request.mockResolvedValueOnce(serverPhase('the same text'));

    await workspace.workspaceApi.phase('p1');

    expect(request).toHaveBeenCalledTimes(1);
    expect(draftIn()).toBeNull();
  });

  it('keeps the draft, and shows the server’s copy, when the replay is refused too', async () => {
    window.localStorage.setItem(
      DRAFT,
      owed({ [STORY]: 'still owed' }),
    );
    request
      .mockResolvedValueOnce(serverPhase('the server copy'))
      .mockRejectedValueOnce(new Error('401'));

    const got = await workspace.workspaceApi.phase('p1');

    // A version of the file that exists nowhere would be worse than either.
    expect(got.files[0].content).toBe('the server copy');
    expect(draftIn()?.files).toEqual({ [STORY]: 'still owed' });
  });

  it('never replays a file the phase no longer lets the learner write', async () => {
    window.localStorage.setItem(
      DRAFT,
      owed({ 'requirements/backlog.md': 'edited what is given' }),
    );
    request.mockResolvedValueOnce(serverPhase('untouched'));

    await workspace.workspaceApi.phase('p1');

    // The API refuses any other path outright, which would strand the draft.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('forgets a draft a day old, because the server’s copy is the better guess', async () => {
    window.localStorage.setItem(
      DRAFT,
      owed({ [STORY]: 'from yesterday' }, { at: Date.now() - 25 * 60 * 60 * 1000 }),
    );
    request.mockResolvedValueOnce(serverPhase('todays copy'));

    const got = await workspace.workspaceApi.phase('p1');

    expect(got.files[0].content).toBe('todays copy');
    expect(draftIn()).toBeNull();
  });

  it('ignores a draft that is not a draft', async () => {
    window.localStorage.setItem(DRAFT, 'not json at all');
    request.mockResolvedValueOnce(serverPhase('the server copy'));
    await expect(workspace.workspaceApi.phase('p1')).resolves.toMatchObject({ id: 'p1' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('whose draft it is', () => {
  it('is stamped with the account that typed it', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await workspace.saveWorkspaceOnExit('p1', { [STORY]: 'mine' });
    expect(draftIn()?.by).toBe(ME);
  });

  it('holds nothing when nobody is signed in, though the request still goes out', async () => {
    session.setSession(null);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await workspace.saveWorkspaceOnExit('p1', { [STORY]: 'typed after the session ended' });
    // A copy of a learner's file left in a shared browser after they have gone
    // is the thing the next person at the keyboard reads from storage.
    expect(draftIn()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is never replayed, or even read, under another account', async () => {
    window.localStorage.setItem(DRAFT, owed({ [STORY]: 'the first learner’s story' }, { by: 'u0' }));
    request.mockResolvedValueOnce(serverPhase('the second learner’s own copy'));

    const got = await workspace.workspaceApi.phase('p1');

    // One GET, no PUT: the first learner's text is not sent to the server as
    // the second learner's work, and it is not shown to them either.
    expect(request).toHaveBeenCalledTimes(1);
    expect(got.files[0].content).toBe('the second learner’s own copy');
    expect(draftIn()).toBeNull();
  });

  it('is gone from this browser when the learner signs out, along with the folded tree', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await workspace.saveWorkspaceOnExit('p1', { [STORY]: 'left behind' });
    window.localStorage.setItem('lsdlc_tree_p1', '["api"]');
    window.localStorage.setItem('lsdlc_theme', 'paper');

    // The button: the sweep runs, then the session is cleared.
    signOut();
    session.clearSession();

    expect(draftIn()).toBeNull();
    expect(window.localStorage.getItem('lsdlc_tree_p1')).toBeNull();
    // Only the learner's things go; a preference that names nobody stays.
    expect(window.localStorage.getItem('lsdlc_theme')).toBe('paper');
  });

  // The session ending is not the learner leaving. A token the API refuses
  // mid-edit ends the session with the draft as the only copy of the last
  // keystrokes, and the learner signs straight back in: sweeping here is what
  // lost the edit (e2e/edges.spec.ts, "an expiring token does not take the
  // last edit with it"). The draft is stamped with their account, so nobody
  // else can be handed it in the meantime.
  it('stays through a session that ended under the learner, and is replayed when they are back', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await workspace.saveWorkspaceOnExit('p1', { [STORY]: 'typed as the token died' });
    window.localStorage.setItem('lsdlc_tree_p1', '["api"]');

    session.clearSession();
    expect(draftIn()?.files[STORY]).toBe('typed as the token died');
    expect(window.localStorage.getItem('lsdlc_tree_p1')).toBe('["api"]');

    session.setSession(userProfile({ id: ME, email: 'ada@example.test', role: 'LEARNER' }));
    request
      .mockResolvedValueOnce(serverPhase('the server never got it'))
      .mockResolvedValueOnce({ saved: true });
    const got = await workspace.workspaceApi.phase('p1');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toBe('PUT');
    expect(got.files[0].content).toBe('typed as the token died');
    expect(draftIn()).toBeNull();
  });

  it('goes when somebody else signs in on top, and theirs is left alone', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await workspace.saveWorkspaceOnExit('p1', { [STORY]: 'the first learner’s story' });
    window.localStorage.setItem('lsdlc_draft_p2', owed({ [STORY]: 'the second learner’s' }, { by: 'u2' }));
    window.localStorage.setItem('lsdlc_tree_p1', '["api"]');
    window.localStorage.setItem('lsdlc_theme', 'paper');

    // Walked away from an expired session without pressing Sign out; the next
    // learner at the keyboard signs in.
    session.clearSession();
    session.setSession(userProfile({ id: 'u2', email: 'bo@example.test', role: 'LEARNER' }));

    expect(draftIn()).toBeNull();
    expect(window.localStorage.getItem('lsdlc_tree_p1')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('lsdlc_draft_p2') ?? 'null')?.by).toBe('u2');
    expect(window.localStorage.getItem('lsdlc_theme')).toBe('paper');
  });
});

describe('a draft against a newer save from somewhere else', () => {
  const savedAt = (detail: PhaseDetail, when: number): PhaseDetail => ({
    ...detail,
    workspaceUpdatedAt: new Date(when).toISOString(),
  });

  it('is dropped, not written over the newer save', async () => {
    // Left on one machine an hour ago; the learner has saved from another since.
    const then = Date.now() - 60 * 60 * 1000;
    window.localStorage.setItem(DRAFT, owed({ [STORY]: 'the stale copy' }, { at: then }));
    request.mockResolvedValueOnce(
      savedAt(serverPhase('what was saved since, elsewhere'), then + 10 * 60 * 1000),
    );

    const got = await workspace.workspaceApi.phase('p1');

    expect(request).toHaveBeenCalledTimes(1);
    expect(got.files[0].content).toBe('what was saved since, elsewhere');
    expect(draftIn()).toBeNull();
  });

  it('is still replayed when it is the newer of the two', async () => {
    const now = Date.now();
    window.localStorage.setItem(DRAFT, owed({ [STORY]: 'typed after the last save' }, { at: now }));
    request
      .mockResolvedValueOnce(savedAt(serverPhase('the last save'), now - 10 * 60 * 1000))
      .mockResolvedValueOnce({ saved: true });

    const got = await workspace.workspaceApi.phase('p1');

    expect(request).toHaveBeenLastCalledWith('PUT', '/phases/p1/workspace', {
      files: { [STORY]: 'typed after the last save' },
    });
    expect(got.files[0].content).toBe('typed after the last save');
  });
});
