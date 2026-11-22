// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseDetail } from '@learnsdlc/shared';
import { clearSession, getToken, setAuthSession } from '@/lib/session';
import { useRequirementsSave } from '@/components/workspace/requirements/useRequirementsSave';
import { readVersionedWorkspaceDraft, workspaceApi } from '@/lib/api-workspace';
import { detail, file, phase } from './fixtures';

const mocks = vi.hoisted(() => ({ save: vi.fn(), phase: vi.fn(), request: vi.fn(), leaving: new Set<() => void>(), signOut: new Set<() => void>() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api')>();
  return {
    api: { saveWorkspace: mocks.save, phase: mocks.phase }, request: mocks.request,
    API_URL: real.API_URL, API_BASE: real.API_BASE, REQUEST_TIMEOUT_MS: real.REQUEST_TIMEOUT_MS, getToken: () => getToken(), tokenAtSessionEnd: () => null,
    describeError: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
    onSessionLeaving: (callback: () => void) => { mocks.leaving.add(callback); return () => mocks.leaving.delete(callback); },
    onSignOut: (callback: () => void) => { mocks.signOut.add(callback); return () => mocks.signOut.delete(callback); },
  };
});

const JSON_PATH = 'requirements/story.json';
const MD_PATH = 'requirements/draft.md';
const REFERENCE = 'requirements/backlog.md';
const V1 = '2026-09-11T01:00:00.000Z';
const V2 = '2026-09-11T01:00:01.000Z';
const V3 = '2026-09-11T01:00:02.000Z';
const user = (id: string) => ({ id, email: `${id}@example.test`, displayName: id, role: 'LEARNER' as const, cohort: 'default', createdAt: V1 });
const phaseDetail = (version: string | null = V1) => detail(phase('requirements', 1, 'req', 'in_progress'), [file(JSON_PATH, 'initial JSON'), file(MD_PATH, 'initial Markdown'), file(REFERENCE, 'provided', false)], { workspaceUpdatedAt: version });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let root: Root; let host: HTMLDivElement;
let current: ReturnType<typeof useRequirementsSave>;
const fetchMock = vi.fn();
function Room({ source }: { source: PhaseDetail | null }) { current = useRequirementsSave('req', source); return <output>{current.saveError}</output>; }
const mount = (source: PhaseDetail | null = phaseDetail()) => act(() => root.render(<Room source={source} />));
const pair = (value: string) => act(() => { current.setFile(MD_PATH, `${value} Markdown`); current.setFile(JSON_PATH, `${value} JSON`); });
const tick = () => act(async () => { await Promise.resolve(); });
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); sessionStorage.clear();
  setAuthSession('token-one', user('one'));
  mocks.save.mockReset(); mocks.phase.mockReset().mockResolvedValue(phaseDetail(V2)); mocks.request.mockReset();
  fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { act(() => root.unmount()); await tick(); host.remove(); clearSession(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Requirements saves retain one ordered, versioned source', () => {
  it('rejects a clean stale callback after token rotation and refuses preparation before a phase loads', async () => {
    mount(null); await expect(current.flushSave()).rejects.toThrow('editing session changed');
    mount(); const oldFlush = current.flushSave;
    act(() => setAuthSession('token-rotated', user('one')));
    await expect(oldFlush()).rejects.toThrow('editing session changed');
    await current.flushSave(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('keeps an acknowledged draft unresolved when a newer differing server copy arrives during its save', async () => {
    const pending = deferred<{ version: string }>(); mocks.save.mockReturnValueOnce(pending.promise);
    mount(); pair('mine'); await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    const other = phaseDetail(V3); other.files[0].content = 'other JSON'; other.files[1].content = 'other Markdown'; mount(other);
    await act(async () => { pending.resolve({ version: V2 }); await Promise.resolve(); });
    expect(current.files[JSON_PATH]).toBe('mine JSON'); expect(current.dirty).toBe(true);
    expect(current.conflict?.workspaceUpdatedAt).toBe(V3); expect(current.saveError).toContain('changed elsewhere');
    expect(readVersionedWorkspaceDraft('req')).toEqual({ baseVersion: V2, files: { [MD_PATH]: 'mine Markdown', [JSON_PATH]: 'mine JSON' } });
    await act(async () => { await expect(current.flushSave()).rejects.toThrow('changed elsewhere'); });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new Event('pagehide'))); await tick(); expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => current.resolveConflict('saved', V3));
    expect(current.files[JSON_PATH]).toBe('other JSON'); expect(current.dirty).toBe(false);
  });

  it('retries only the comparison GET after a 409 whose saved copy was unavailable', async () => {
    mocks.save.mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409 }));
    mocks.phase.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(phaseDetail(V2));
    mount(); pair('mine'); await act(async () => { await expect(current.flushSave()).rejects.toThrow(); });
    await act(async () => { await expect(current.flushSave()).rejects.toThrow('changed elsewhere'); });
    expect(current.conflict?.workspaceUpdatedAt).toBe(V2); expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.phase).toHaveBeenCalledTimes(2);
  });

  it('joins an in-flight autosave and drains the newer canonical pair only after its revision arrives', async () => {
    const first = deferred<{ version: string }>(); const second = deferred<{ version: string }>();
    mocks.save.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mount(); pair('A'); await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(mocks.save).toHaveBeenCalledWith('req', { [MD_PATH]: 'A Markdown', [JSON_PATH]: 'A JSON' }, V1);
    pair('B'); let flush!: Promise<void>; act(() => { flush = current.flushSave(); });
    let finished = false; void flush.then(() => { finished = true; });
    await tick(); expect(mocks.save).toHaveBeenCalledTimes(1); expect(current.saving).toBe(true);
    await act(async () => { first.resolve({ version: V2 }); await Promise.resolve(); });
    expect(mocks.save).toHaveBeenNthCalledWith(2, 'req', { [MD_PATH]: 'B Markdown', [JSON_PATH]: 'B JSON' }, V2);
    expect(finished).toBe(false);
    await act(async () => { second.resolve({ version: V3 }); await flush; });
    expect(current.files[MD_PATH]).toBe('B Markdown'); expect(current.saving).toBe(false); expect(finished).toBe(true);
    expect(readVersionedWorkspaceDraft('req')).toBeNull();
  });

  it('surfaces a conflict, retains both files, and never adopts a newer server revision beneath the dirty draft', async () => {
    mocks.save.mockRejectedValue(new Error('This workspace changed elsewhere.'));
    mount(); pair('mine'); await act(async () => { await expect(current.flushSave()).rejects.toThrow('changed elsewhere'); });
    expect(current.saveError).toContain('changed elsewhere');
    expect(readVersionedWorkspaceDraft('req')).toEqual({ baseVersion: V1, files: { [MD_PATH]: 'mine Markdown', [JSON_PATH]: 'mine JSON' } });
    mount(phaseDetail(V2));
    await act(async () => { await expect(current.flushSave()).rejects.toThrow(); });
    expect(mocks.save).toHaveBeenCalledTimes(1); expect(current.files[JSON_PATH]).toBe('mine JSON');
    expect(readVersionedWorkspaceDraft('req')?.baseVersion).toBe(V1);
  });

  it('makes autosave failure visible and retries the retained pair with the same base', async () => {
    mocks.save.mockRejectedValueOnce(new TypeError('Disconnected')).mockResolvedValueOnce({ version: V2 });
    mount(); pair('offline'); await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(current.saveError).toContain('Disconnected'); expect(current.files[MD_PATH]).toBe('offline Markdown');
    await act(async () => { await current.flushSave(); });
    expect(mocks.save.mock.calls[1][2]).toBe(V1); expect(current.saveError).toBe('');
  });

  it('only saves the retained draft against the exact saved revision the learner reviewed', async () => {
    mocks.save.mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409 })).mockResolvedValueOnce({ version: V3 });
    const saved = phaseDetail(V2); saved.files[0].content = 'someone else JSON'; mocks.phase.mockResolvedValueOnce(saved);
    mount(); pair('mine'); await act(async () => { await expect(current.flushSave()).rejects.toThrow(); });
    expect(current.conflict?.files[0].content).toBe('someone else JSON');
    await expect(current.resolveConflict('draft', V1)).rejects.toThrow('comparison changed');
    expect(mocks.save).toHaveBeenCalledTimes(1);
    await act(async () => { await current.resolveConflict('draft', V2); });
    expect(mocks.save).toHaveBeenLastCalledWith('req', { [MD_PATH]: 'mine Markdown', [JSON_PATH]: 'mine JSON' }, V2);
    expect(current.conflict).toBeNull(); expect(current.files[MD_PATH]).toBe('mine Markdown');
  });

  it('keeps a new intervening write as a new conflict after explicit draft resolution', async () => {
    mocks.save.mockRejectedValue(Object.assign(new Error('changed'), { status: 409 }));
    mocks.phase.mockResolvedValueOnce(phaseDetail(V2)).mockResolvedValueOnce(phaseDetail(V3));
    mount(); pair('mine'); await act(async () => { await expect(current.flushSave()).rejects.toThrow(); });
    await act(async () => { await expect(current.resolveConflict('draft', V2)).rejects.toThrow(); });
    expect(current.conflict?.workspaceUpdatedAt).toBe(V3); expect(current.files[JSON_PATH]).toBe('mine JSON');
    expect(readVersionedWorkspaceDraft('req')?.baseVersion).toBe(V2);
  });

  it('adopts the displayed saved copy without writing or discarding another phase draft', async () => {
    mocks.save.mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409 }));
    const saved = phaseDetail(V2); saved.files[0].content = 'reviewed JSON'; saved.files[1].content = 'reviewed Markdown'; mocks.phase.mockResolvedValueOnce(saved);
    mount(); pair('mine'); await act(async () => { await expect(current.flushSave()).rejects.toThrow(); });
    localStorage.setItem('lsdlc_draft_other', JSON.stringify({ at: Date.now(), by: 'one', files: { 'other.md': 'keep' }, baseVersion: V1 }));
    await act(async () => { await current.resolveConflict('saved', V2); });
    expect(current.files[JSON_PATH]).toBe('reviewed JSON'); expect(current.files[MD_PATH]).toBe('reviewed Markdown');
    expect(current.conflict).toBeNull(); expect(current.saveError).toBe(''); expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(readVersionedWorkspaceDraft('req')).toBeNull(); expect(localStorage.getItem('lsdlc_draft_other')).toContain('keep');
    await current.flushSave(); expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('keeps the accepted saved V2 bytes when a delayed V1 phase response arrives before the next edit', async () => {
    mocks.save.mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409 })).mockResolvedValueOnce({ version: V3 });
    const saved = phaseDetail(V2); saved.files[0].content = 'reviewed JSON'; saved.files[1].content = 'reviewed Markdown'; mocks.phase.mockResolvedValueOnce(saved);
    mount(); pair('mine'); await act(async () => { await expect(current.flushSave()).rejects.toThrow(); });
    await act(async () => { await current.resolveConflict('saved', V2); });
    mount(phaseDetail(V1));
    expect(current.files[JSON_PATH]).toBe('reviewed JSON'); expect(current.files[MD_PATH]).toBe('reviewed Markdown');
    act(() => { current.setFile(MD_PATH, `${current.files[MD_PATH]} edited`); current.setFile(JSON_PATH, current.files[JSON_PATH]); });
    await act(async () => { await current.flushSave(); });
    expect(mocks.save).toHaveBeenLastCalledWith('req', { [MD_PATH]: 'reviewed Markdown edited', [JSON_PATH]: 'reviewed JSON' }, V2);
  });

  it('honors locked status metadata without replacing a newer accepted file snapshot', async () => {
    mocks.save.mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409 }));
    const saved = phaseDetail(V2); saved.files[0].content = 'reviewed JSON'; mocks.phase.mockResolvedValueOnce(saved);
    mount(); pair('mine'); await act(async () => { await expect(current.flushSave()).rejects.toThrow(); });
    await act(async () => { await current.resolveConflict('saved', V2); });
    mount({ ...phaseDetail(V1), status: 'locked' }); pair('blocked'); await current.flushSave();
    expect(current.files[JSON_PATH]).toBe('reviewed JSON'); expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('acknowledges an exit save whose reply was lost when the returned server files match the whole draft', async () => {
    localStorage.setItem('lsdlc_draft_req', JSON.stringify({ at: Date.now(), by: 'one', files: { [MD_PATH]: 'already saved', [JSON_PATH]: 'saved JSON' }, baseVersion: V1 }));
    const saved = phaseDetail(V2); saved.files[0].content = 'saved JSON'; saved.files[1].content = 'already saved'; mount(saved);
    expect(current.saveError).toBe(''); expect(current.conflict).toBeNull(); expect(readVersionedWorkspaceDraft('req')).toBeNull();
    await current.flushSave(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it('saves the last pair on pagehide with the exact base and no parallel exit request', async () => {
    const first = deferred<{ version: string }>(); mocks.save.mockReturnValueOnce(first.promise);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: V3 }) });
    mount(); pair('A'); await act(async () => { await vi.advanceTimersByTimeAsync(700); }); pair('B');
    act(() => window.dispatchEvent(new Event('pagehide'))); expect(fetchMock).not.toHaveBeenCalled();
    expect(readVersionedWorkspaceDraft('req')?.files[MD_PATH]).toBe('B Markdown');
    await act(async () => { first.resolve({ version: V2 }); await current.flushSave(); });
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({ files: { [MD_PATH]: 'B Markdown', [JSON_PATH]: 'B JSON' }, baseVersion: V2 });
    expect(request.keepalive).toBe(true); expect(readVersionedWorkspaceDraft('req')).toBeNull();
  });

  it('keeps a failed versioned exit draft through refresh without legacy unversioned replay', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409 });
    mount(); pair('retained'); act(() => window.dispatchEvent(new Event('pagehide'))); await tick();
    expect(readVersionedWorkspaceDraft('req')?.baseVersion).toBe(V1);
    mocks.request.mockResolvedValue(phaseDetail(V2)); await workspaceApi.phase('req');
    expect(mocks.request).toHaveBeenCalledTimes(1); expect(mocks.request).toHaveBeenCalledWith('GET', '/phases/req');
    await act(async () => { root.render(<Room key="reload" source={phaseDetail(V2)} />); });
    expect(current.files[MD_PATH]).toBe('retained Markdown'); expect(current.saveError).toContain('changed elsewhere');
  });

  it('does not send queued work or process an old response under another account', async () => {
    const first = deferred<{ version: string }>(); mocks.save.mockReturnValueOnce(first.promise);
    mount(); pair('A'); await act(async () => { await vi.advanceTimersByTimeAsync(700); }); pair('B'); const oldSetFile = current.setFile;
    act(() => setAuthSession('token-two', user('two')));
    act(() => oldSetFile(MD_PATH, 'stale callback'));
    await act(async () => { first.resolve({ version: V2 }); await Promise.resolve(); });
    expect(mocks.save).toHaveBeenCalledTimes(1); expect(fetchMock).not.toHaveBeenCalled();
    expect(current.files[MD_PATH]).toBe('initial Markdown'); expect(readVersionedWorkspaceDraft('req')).toBeNull();
  });

  it('retains a draft before an expired session is cleared and recovers it for that account', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    mocks.save.mockResolvedValue({ version: V2 });
    mount(); pair('session');
    act(() => { mocks.leaving.forEach(callback => callback()); clearSession(); }); await tick();
    expect(JSON.parse(localStorage.getItem('lsdlc_draft_req')!).by).toBe('one');
    act(() => setAuthSession('token-returned', user('one'))); mount();
    expect(current.files[JSON_PATH]).toBe('session JSON');
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith('req', { [MD_PATH]: 'session Markdown', [JSON_PATH]: 'session JSON' }, V1);
    expect(readVersionedWorkspaceDraft('req')).toBeNull();
  });

  it('automatically saves a restored matching-base pair after the debounce without explicit interaction', async () => {
    mocks.save.mockResolvedValue({ version: V2 });
    const files = { [MD_PATH]: 'restored Markdown', [JSON_PATH]: 'restored JSON' };
    localStorage.setItem('lsdlc_draft_req', JSON.stringify({ at: Date.now(), by: 'one', files, baseVersion: V1 }));
    mount(); expect(current.files[MD_PATH]).toBe('restored Markdown');
    await act(async () => { await vi.advanceTimersByTimeAsync(699); }); expect(mocks.save).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith('req', files, V1); expect(readVersionedWorkspaceDraft('req')).toBeNull();
  });

  it('retries an ordinary network failure on reconnect and does not duplicate the active queue', async () => {
    const retry = deferred<{ version: string }>();
    mocks.save.mockRejectedValueOnce(new TypeError('Disconnected')).mockReturnValueOnce(retry.promise);
    mount(); pair('reconnect'); await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(current.saveError).toContain('Disconnected');
    act(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('pageshow')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); }); expect(mocks.save).toHaveBeenCalledTimes(2);
    act(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('pageshow')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); }); expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[1][2]).toBe(V1);
    await act(async () => { retry.resolve({ version: V2 }); await current.flushSave(); });
    expect(current.saveError).toBe(''); expect(readVersionedWorkspaceDraft('req')).toBeNull();
  });

  it('never automatically saves a restored conflicting draft on reconnect, edits, or exit', async () => {
    localStorage.setItem('lsdlc_draft_req', JSON.stringify({ at: Date.now(), by: 'one', files: { [MD_PATH]: 'mine', [JSON_PATH]: 'mine JSON' }, baseVersion: V1 }));
    mount(phaseDetail(V2)); expect(current.conflict?.workspaceUpdatedAt).toBe(V2);
    pair('revised conflict'); act(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('pageshow')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    act(() => window.dispatchEvent(new Event('pagehide'))); await tick();
    expect(mocks.save).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
    expect(readVersionedWorkspaceDraft('req')).toEqual({ baseVersion: V1, files: { [MD_PATH]: 'revised conflict Markdown', [JSON_PATH]: 'revised conflict JSON' } });
  });

  it('does not automatically retry a known 409 even when loading its comparison failed', async () => {
    mocks.save.mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409 })); mocks.phase.mockRejectedValueOnce(new TypeError('offline'));
    mount(); pair('mine'); await act(async () => { await expect(current.flushSave()).rejects.toThrow(); });
    expect(current.conflict).toBeNull(); expect(current.saveError).toContain('could not be loaded');
    act(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('pageshow')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    act(() => window.dispatchEvent(new Event('pagehide'))); await tick();
    expect(mocks.save).toHaveBeenCalledTimes(1); expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses locked or supplied files and sends an explicit empty version for a new workspace', async () => {
    mocks.save.mockResolvedValue({ version: V1 });
    mount(phaseDetail(null)); act(() => current.setFile(REFERENCE, 'rewrite provided'));
    await current.flushSave(); expect(mocks.save).not.toHaveBeenCalled();
    pair('first'); await act(async () => { await current.flushSave(); }); expect(mocks.save.mock.calls[0][2]).toBe('');
    mount({ ...phaseDetail(V1), status: 'locked' }); pair('locked'); await current.flushSave();
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});
