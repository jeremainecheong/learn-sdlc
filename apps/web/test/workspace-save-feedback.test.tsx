// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({
  phaseId: 'save-phase', token: 'owner-a', save: vi.fn(), load: vi.fn(), exit: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
  setProject: vi.fn(),
  drafts: new Map<string, { ownerId: string; files: Record<string, string>; baseVersion: string }>(),
  refresh: null as null | (() => Promise<void>),
  flush: null as null | (() => Promise<void>),
  // The phase panels the page draws (none but in the Runbook case), whether the bottom panel shows the
  // Pipeline tab's tools, and the explorer's last tree.
  panels: {} as Record<string, unknown>,
  showTools: true,
  // Whether the task side is open (shut in every case but the pane one, so the room shows the code pane).
  briefOpen: false,
  tree: null as unknown,
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: rig.phaseId }), useRouter: () => rig.router, useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/api', () => {
  class ApiError extends Error { constructor(public status: number, message: string, public code?: string, public body?: unknown) { super(message); } }
  return { ApiError, API_URL: '/api', api: { saveWorkspace: rig.save, myEnrollment: vi.fn(async () => null) },
    getToken: () => rig.token, onSessionLeaving: () => () => {}, signInHref: () => null };
});
vi.mock('@/lib/session', () => ({ getSession: () => ({ id: rig.token }), onSessionEnd: () => () => {}, ownedByToken: (clear: () => void) => { let held = ''; return () => { if (held !== rig.token) { clear(); held = rig.token; } }; } }));
// The shared helpers' HTTP/storage behavior has its own api-workspace tests;
// this fake records the exact owner, base and bytes passed by the actual page.
vi.mock('@/lib/api-workspace', () => ({
  workspaceApi: { phase: rig.load }, saveVersionedWorkspaceOnExit: rig.exit,
  readVersionedWorkspaceDraft: (id: string) => { const draft = rig.drafts.get(id); return draft?.ownerId === rig.token ? draft : null; },
  rememberVersionedWorkspaceDraft: (id: string, files: Record<string, string>, baseVersion: string, ownerId: string) => { if (ownerId === rig.token) rig.drafts.set(id, { files: { ...files }, baseVersion, ownerId }); },
  acknowledgeVersionedWorkspaceSave: (id: string, files: Record<string, string>, _version: string, ownerId: string) => { const draft = rig.drafts.get(id); if (ownerId === rig.token && draft && Object.keys(draft.files).every(path => draft.files[path] === files[path])) rig.drafts.delete(id); },
  discardVersionedWorkspaceDraft: (id: string, ownerId: string) => { if (ownerId === rig.token) rig.drafts.delete(id); },
}));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ details: {}, enrollment: null, analytics: null }), fullDetail: () => null, invalidateProject: vi.fn(), learnerMessage: (_err: unknown, fallback: string) => fallback }));
vi.mock('@/lib/project', () => ({ getActiveProject: () => 'tasktrackr', setActiveProject: rig.setProject }));
vi.mock('@/lib/records', () => ({ cachedRecords: () => ({}), loadRecords: vi.fn(async () => ({ records: { submissions: [], runs: [] } })), refreshPhaseRecords: vi.fn() }));
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => '', clearCommitDraft: vi.fn(), useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: vi.fn(), useRecoverWhenBack: vi.fn() }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: (_id: string, flush: () => Promise<void>, refresh: () => Promise<void>) => { rig.flush = flush; rig.refresh = refresh; return false; } }));
vi.mock('@/components/workspace/usePreview', () => ({ usePreview: () => ({ status: 'idle', console: [], errors: 0, stop: vi.fn() }), stopPreviewOnExit: vi.fn() }));
vi.mock('@/components/workspace/panels', () => ({ PHASE_PANELS: rig.panels }));
vi.mock('@/components/workspace/panels/testing/useTesting', () => ({ useTesting: () => ({ tests: [], linked: {}, view: { total: 0, killed: 0 }, criteria: [], mutants: [] }) }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({ useWorkspacePanels: () => ({ briefOpen: rig.briefOpen, mentorOpen: false, setBriefOpen: vi.fn(), setMentorOpen: vi.fn() }), WorkspacePanelControls: () => null, WorkspaceMentorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/workspace/ImplementationTaskPanel', () => ({ ImplementationTaskPanel: () => null }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/Markdown', () => ({ Markdown: () => null }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/workspace/preload', () => ({ preloadEditor: async () => {}, loadedEditor: () =>
  ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="Code" value={value} onChange={event => onChange(event.target.value)} /> }));
vi.mock('@/components/shell', async () => ({
  ...await import('@/components/shell/routes'),
  WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => <main>{strip}{children}</main>,
  PhaseStrip: ({ right }: { right: ReactNode }) => <header>{right}</header>,
  StatusBar: ({ saveState, savedAt }: { saveState: string; savedAt?: string }) => <output aria-label="Save status">{saveState} {savedAt}</output>,
  ActivityBar: () => null, PersonaComposer: () => null, PersonaFeed: () => null,
  BottomPanel: ({ tabs }: { tabs: { key: string; content: ReactNode }[] }) => (rig.showTools ? <>{tabs.find(tab => tab.key === 'pipeline')?.content}</> : null),
  Explorer: ({ tree }: { tree: unknown }) => { rig.tree = tree; return null; },
  usePersona: () => ({ messages: [], busy: false }), PERSONA_NAME: { implementation: 'Ari' },
}));

import { EMPTY_RUNBOOK, RUNBOOK_JSON, serialiseRunbook, validateRunbookRecord } from '@learnsdlc/shared';
import WorkspacePage from '@/app/(app)/workspace/[phaseId]/page';
import { ApiError } from '@/lib/api';
import { stubMatchMedia } from './support/dom';
const initial = '2026-09-15T06:52:00.000Z';
const next = '2026-09-15T06:54:00.000Z';
const later = '2026-09-15T06:56:00.000Z';
const clock = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const phase = (id = rig.phaseId, version = initial) => ({
  id, key: 'implementation', title: 'Implementation', order: 3, status: 'in_progress', projectSlug: 'tasktrackr',
  workspaceUpdatedAt: version, files: [{ path: 'api/repository/tasks.py', content: 'saved code', editable: true, language: 'python' }],
  attempts: 0, rubric: { criteria: [] }, objectives: [], taskPanel: '', links: [], canRun: false, canPreview: false, runLabel: 'Run tests',
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
let root: Root, host: HTMLDivElement, sequence = 0;
const render = () => act(async () => { root.render(<WorkspacePage />); });
const status = () => host.querySelector('output')!.textContent;
const type = (value: string) => act(() => fireEvent.change(host.querySelector('textarea')!, { target: { value } }));
const debounce = () => act(async () => { await vi.advanceTimersByTimeAsync(700); });
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); rig.drafts.clear(); rig.phaseId = `save-phase-${++sequence}`; rig.token = `owner-${sequence}`;
  stubMatchMedia();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  rig.load.mockImplementation(async () => phase()); rig.save.mockResolvedValue({ saved: true, version: next }); rig.exit.mockResolvedValue({ version: next });
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}`);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); for (const key of Object.keys(rig.panels)) delete rig.panels[key]; rig.showTools = true; rig.briefOpen = false; });

it('opens the cited file ahead of the remembered editor and follows a new citation in the same mounted phase', async () => {
  const detail = phase();
  detail.files.push({ path: 'api/routes/tasks.py', content: 'cited route code', editable: true, language: 'python' });
  rig.load.mockResolvedValue(detail);
  await render();
  expect(host.querySelector('textarea')!.value).toBe('cited route code');
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}?file=api%2Frepository%2Ftasks.py`);
  await render();
  expect(host.querySelector('textarea')!.value).toBe('saved code');
  await act(async () => root.render(null));
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}?file=api%2Froutes%2Ftasks.py`);
  await render();
  expect(host.querySelector('textarea')!.value).toBe('cited route code');
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}?file=api%2Frepository%2Ftasks.py`);
  const editor = host.querySelector('textarea');
  await render();
  expect(host.querySelector('textarea')).toBe(editor);
  expect(host.querySelector('textarea')!.value).toBe('saved code');
  expect(rig.save).not.toHaveBeenCalled();
});

it('shows the actual acknowledged save time without reloading and preserves the next optimistic version', async () => {
  await render(); expect(status()).toBe(`Saved ${clock(initial)}`);
  type('typed code'); await debounce();
  expect(rig.save).toHaveBeenLastCalledWith(rig.phaseId, { 'api/repository/tasks.py': 'typed code' }, initial);
  expect(status()).toBe(`Saved ${clock(next)}`);
  rig.save.mockResolvedValueOnce({ saved: true, version: later });
  type('undo or redo content'); await debounce();
  expect(rig.save).toHaveBeenLastCalledWith(rig.phaseId, { 'api/repository/tasks.py': 'undo or redo content' }, next);
  expect(status()).toBe(`Saved ${clock(later)}`); expect(rig.load).toHaveBeenCalledTimes(1);
});

it('does not report a new save time for rejected or conflicting writes', async () => {
  await render(); rig.save.mockRejectedValueOnce(new Error('offline'));
  type('retained draft'); await debounce(); expect(status()).toBe(`Unsaved ${clock(initial)}`);
  rig.save.mockRejectedValueOnce(new ApiError(409, 'Conflict', undefined, { version: later }));
  type('still retained'); await debounce(); expect(status()).toBe(`Not saved ${clock(initial)}`);
  expect(host.querySelector('textarea')!.value).toBe('still retained');
});

it('keeps newer unsaved typing and the same editor when the preceding save is acknowledged', async () => {
  const pending = deferred<{ saved: boolean; version: string }>(); rig.save.mockReturnValueOnce(pending.promise);
  await render(); const editor = host.querySelector('textarea')!;
  type('first saved draft'); await debounce();
  type('newer unsaved draft');
  await act(async () => pending.resolve({ saved: true, version: next }));
  expect(host.querySelector('textarea')).toBe(editor);
  expect(editor.value).toBe('newer unsaved draft'); expect(status()).toBe(`Unsaved ${clock(next)}`);
  expect(rig.save).toHaveBeenCalledTimes(1);
  rig.save.mockResolvedValueOnce({ saved: true, version: later }); await debounce();
  expect(rig.save).toHaveBeenLastCalledWith(rig.phaseId, { 'api/repository/tasks.py': 'newer unsaved draft' }, next);
  expect(status()).toBe(`Saved ${clock(later)}`);
});

it('accepts an older acknowledgement only when newer saved bytes already contain that draft', async () => {
  const old = deferred<{ saved: boolean; version: string }>(); rig.save.mockReturnValueOnce(old.promise);
  await render(); type('pending old copy'); await debounce();
  const saved = phase(rig.phaseId, later); saved.files[0].content = 'pending old copy';
  rig.load.mockResolvedValueOnce(saved);
  await act(async () => { await rig.refresh!(); });
  await act(async () => { old.resolve({ saved: true, version: next }); });
  expect(status()).toBe(`Saved ${clock(later)}`);
  type('next local edit'); await debounce();
  expect(rig.save.mock.calls.at(-1)?.[2]).toBe(later);
});

it('keeps a differing draft unsaved when a newer GET arrives before its old acknowledgement', async () => {
  const old = deferred<{ saved: boolean; version: string }>(); rig.save.mockReturnValueOnce(old.promise);
  await render(); type('pending local copy'); await debounce();
  const saved = phase(rig.phaseId, later); saved.files[0].content = 'newer saved elsewhere';
  rig.load.mockResolvedValue(saved);
  await act(async () => { await rig.refresh!(); });
  expect(status()).toBe(`Not saved ${clock(later)}`);
  await act(async () => old.resolve({ saved: true, version: next }));
  expect(status()).toBe(`Not saved ${clock(later)}`);
  expect(host.querySelector('textarea')!.value).toBe('pending local copy');
  rig.save.mockRejectedValueOnce(new ApiError(409, 'Conflict', undefined, { version: later }));
  type('newer local draft'); await debounce();
  expect(rig.save.mock.calls.at(-1)?.[2]).toBe(initial);
  expect(status()).toBe(`Not saved ${clock(later)}`);
  rig.save.mockResolvedValueOnce({ saved: true, version: '2026-09-15T06:58:00.000Z' });
  await act(async () => fireEvent.click(host.querySelector('[data-testid="conflict-mine"]')!));
  expect(rig.save).toHaveBeenLastCalledWith(rig.phaseId, { 'api/repository/tasks.py': 'newer local draft' }, later);
  expect(status()).toBe(`Saved ${clock('2026-09-15T06:58:00.000Z')}`);
});

it('loads the reviewed saved copy without another write after an older acknowledgement conflicts', async () => {
  const old = deferred<{ saved: boolean; version: string }>(); rig.save.mockReturnValueOnce(old.promise);
  await render(); type('local copy'); await debounce();
  const saved = phase(rig.phaseId, later); saved.files[0].content = 'reviewed saved copy'; rig.load.mockResolvedValue(saved);
  await act(async () => { await rig.refresh!(); old.resolve({ saved: true, version: next }); });
  await act(async () => fireEvent.click(host.querySelector('[data-testid="conflict-theirs"]')!));
  expect(host.querySelector('textarea')!.value).toBe('reviewed saved copy');
  expect(status()).toBe(`Saved ${clock(later)}`); expect(rig.save).toHaveBeenCalledTimes(1);
});

it('does not adopt a save acknowledgement after the active token changes', async () => {
  const pending = deferred<{ saved: boolean; version: string }>(); rig.save.mockReturnValueOnce(pending.promise);
  await render(); type('first owner draft'); await debounce();
  rig.token = 'new-owner'; await act(async () => pending.resolve({ saved: true, version: next }));
  expect(status()).not.toContain(clock(next));
});

it('does not carry a delayed acknowledgement into a newly mounted phase', async () => {
  const pending = deferred<{ saved: boolean; version: string }>(); rig.save.mockReturnValueOnce(pending.promise);
  await render(); type('old phase draft'); await debounce();
  rig.phaseId = 'different-phase'; await render();
  await act(async () => pending.resolve({ saved: true, version: next }));
  expect(status()).toBe(`Saved ${clock(initial)}`); expect(host.querySelector('textarea')!.value).toBe('saved code');
});

it('does not display or cache a successful late GET after the token changed', async () => {
  const pending = deferred<ReturnType<typeof phase>>(); rig.load.mockReturnValueOnce(pending.promise);
  const old = phase(); old.files[0].content = 'old owner private code'; old.projectSlug = 'old-owner-project';
  await render(); rig.token = 'different-owner';
  await act(async () => pending.resolve(old));
  expect(rig.setProject).not.toHaveBeenCalled(); expect(host.querySelector('textarea')).toBeNull();
  rig.load.mockReturnValue(new Promise(() => {}));
  await act(async () => root.render(<WorkspacePage key="new-owner-tree" />));
  // A poisoned cache would draw the old owner's editor before this GET resolves.
  expect(host.querySelector('textarea')).toBeNull(); expect(host.textContent).not.toContain('old owner private code');
});

it('does not cache a successful late GET for a phase already left', async () => {
  const oldId = rig.phaseId, pending = deferred<ReturnType<typeof phase>>(); rig.load.mockReturnValueOnce(pending.promise);
  const old = phase(); old.files[0].content = 'old route response'; old.projectSlug = 'old-route-project';
  await render(); rig.phaseId = 'new-route-phase'; await render(); rig.setProject.mockClear();
  await act(async () => pending.resolve(old));
  expect(rig.setProject).not.toHaveBeenCalled(); expect(host.querySelector('textarea')!.value).toBe('saved code');
  rig.phaseId = oldId; rig.load.mockReturnValueOnce(new Promise(() => {})); await render();
  expect(host.querySelector('textarea')).toBeNull();
});

it('ignores an older GET that resolves after acknowledged typing without rolling back its bytes or version', async () => {
  await render(); const pending = deferred<ReturnType<typeof phase>>(); rig.load.mockReturnValueOnce(pending.promise);
  let refresh!: Promise<void>; act(() => { refresh = rig.refresh!(); });
  type('acknowledged latest code'); await debounce();
  expect(status()).toBe(`Saved ${clock(next)}`);
  await act(async () => { pending.resolve(phase(rig.phaseId, initial)); await refresh; });
  expect(host.querySelector('textarea')!.value).toBe('acknowledged latest code');
  expect(status()).toBe(`Saved ${clock(next)}`);
  type('subsequent native edit'); await debounce();
  expect(rig.save.mock.calls.at(-1)?.[2]).toBe(next);
});

it('leaves a known conflict locally without PUT and restores its exact draft/base before explicit resolution', async () => {
  await render(); type('local draft');
  rig.save.mockRejectedValueOnce(new ApiError(409, 'Conflict', undefined, { version: later })); await debounce();
  const saved = phase(rig.phaseId, later); saved.files[0].content = 'newer server copy'; rig.load.mockResolvedValue(saved);
  await act(async () => fireEvent.pageHide(window));
  expect(rig.exit).not.toHaveBeenCalled();
  expect(rig.drafts.get(rig.phaseId)).toEqual({ ownerId: rig.token, files: { 'api/repository/tasks.py': 'local draft' }, baseVersion: initial });
  await act(async () => root.render(<WorkspacePage key="return-from-conflict" />));
  expect(host.querySelector('textarea')!.value).toBe('local draft'); expect(status()).toBe(`Not saved ${clock(later)}`);
  await act(async () => vi.advanceTimersByTimeAsync(1400)); expect(rig.save).toHaveBeenCalledTimes(1); expect(rig.exit).not.toHaveBeenCalled();
  rig.save.mockResolvedValueOnce({ saved: true, version: '2026-09-15T06:58:00.000Z' });
  await act(async () => fireEvent.click(host.querySelector('[data-testid="conflict-mine"]')!));
  expect(rig.save).toHaveBeenLastCalledWith(rig.phaseId, { 'api/repository/tasks.py': 'local draft' }, later);
  expect(rig.drafts.has(rig.phaseId)).toBe(false);
});

it('quotes the original base on ordinary exit and retains a 409 draft for read-only recovery', async () => {
  rig.exit.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { status: 409 }));
  await render(); type('last native keystrokes');
  await act(async () => fireEvent.pageHide(window));
  expect(rig.save).not.toHaveBeenCalled();
  expect(rig.exit).toHaveBeenCalledExactlyOnceWith(rig.phaseId, { 'api/repository/tasks.py': 'last native keystrokes' }, { baseVersion: initial, ownerId: rig.token, token: rig.token });
  const saved = phase(rig.phaseId, later); saved.files[0].content = 'authoritative newer copy'; rig.load.mockResolvedValue(saved);
  await act(async () => root.render(<WorkspacePage key="return-from-failed-exit" />));
  expect(host.querySelector('textarea')!.value).toBe('last native keystrokes'); expect(status()).toBe(`Not saved ${clock(later)}`);
  await act(async () => fireEvent.click(host.querySelector('[data-testid="conflict-theirs"]')!));
  expect(host.querySelector('textarea')!.value).toBe('authoritative newer copy');
  expect(rig.drafts.has(rig.phaseId)).toBe(false); expect(rig.save).not.toHaveBeenCalled(); expect(rig.exit).toHaveBeenCalledTimes(1);
});

it('rejects the action-preparation flush on 409 and never retries a retained conflict implicitly', async () => {
  await render(); type('unsaved action input');
  rig.save.mockRejectedValueOnce(new ApiError(409, 'Conflict', undefined, { version: later }));
  await act(async () => { await expect(rig.flush!()).rejects.toThrow(/resolve|saved copy/i); });
  expect(host.querySelector('textarea')!.value).toBe('unsaved action input');
  expect(status()).toBe(`Not saved ${clock(initial)}`);
  await act(async () => { await expect(rig.flush!()).rejects.toThrow(/resolve|saved copy/i); });
  expect(rig.save).toHaveBeenCalledTimes(1);
});

it('rejects the action-preparation flush when its session ends while saving', async () => {
  const pending = deferred<{ saved: boolean; version: string }>(); rig.save.mockReturnValueOnce(pending.promise);
  await render(); type('old owner action draft');
  let done!: Promise<void>; act(() => { done = rig.flush!(); });
  rig.token = 'another-session';
  await act(async () => { pending.resolve({ saved: true, version: next }); await expect(done).rejects.toThrow(/session|changed/i); });
});

it('recognizes an exit draft already present in the authoritative saved bytes without replaying it', async () => {
  rig.drafts.set(rig.phaseId, { ownerId: rig.token, files: { 'api/repository/tasks.py': 'saved code' }, baseVersion: initial });
  rig.load.mockResolvedValue(phase(rig.phaseId, later)); await render();
  expect(status()).toBe(`Saved ${clock(later)}`); expect(rig.drafts.has(rig.phaseId)).toBe(false);
  expect(host.querySelector('[data-testid="workspace-conflict"]')).toBeNull();
  await act(async () => { await rig.flush!(); });
  expect(rig.save).not.toHaveBeenCalled(); expect(rig.exit).not.toHaveBeenCalled();
});

it('does not delete newer exit text when an earlier in-flight autosave later succeeds', async () => {
  const older = deferred<{ saved: boolean; version: string }>(); rig.save.mockReturnValueOnce(older.promise);
  rig.exit.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { status: 409 }));
  await render(); type('older in-flight draft'); await debounce(); type('newer text leaving the page');
  await act(async () => fireEvent.pageHide(window));
  await act(async () => older.resolve({ saved: true, version: next }));
  expect(rig.drafts.get(rig.phaseId)?.files).toEqual({ 'api/repository/tasks.py': 'newer text leaving the page' });
  const saved = phase(rig.phaseId, later); saved.files[0].content = 'actual newer server copy'; rig.load.mockResolvedValue(saved);
  await act(async () => root.render(<WorkspacePage key="return-after-late-save" />));
  expect(host.querySelector('textarea')!.value).toBe('newer text leaving the page');
  expect(status()).toBe(`Not saved ${clock(later)}`);
});

/** A Deployment phase with the runbook record, opened on its Runbook tab (`?panel=runbook`, or the `search` given), with the real Deployment tools. */
async function openRunbookRoom(search = '?panel=runbook') {
  rig.panels.deployment = (await import('@/components/workspace/panels/deployment')).default;
  const record = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'where /api goes', kind: 'config' }] });
  rig.load.mockImplementation(async () => ({
    ...phase(), key: 'deployment', title: 'Deployment', order: 5, artifactKind: 'config',
    runbook: { floor: { minEnvironment: 1, minHealth: 0, minRollback: 0, minData: 0, requireIncident: false }, drill: true },
    files: [
      { path: 'api/Dockerfile', content: 'FROM python:3.12', editable: true, language: 'dockerfile' },
      { path: RUNBOOK_JSON, content: record, editable: true, language: 'json' },
    ],
  }));
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}${search}`);
  await render();
}
const purpose = () => host.querySelector<HTMLTextAreaElement>('[data-testid="runbook-environment-0-purpose"]')!;

it('brings the code pane back for a later ?panel=runbook only, and leaves the learner\'s pane for any other value', async () => {
  rig.briefOpen = true;
  await openRunbookRoom('');
  const pane = () => host.querySelector('[data-active-pane]')!.getAttribute('data-active-pane');
  expect(pane()).toBe('code');
  const yourTask = [...host.querySelectorAll<HTMLButtonElement>('.phase-room-nav button')].find(button => button.textContent === 'Your task')!;
  act(() => { fireEvent.click(yourTask); });
  expect(pane()).toBe('task');
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}?panel=other`);
  await render();
  expect(pane()).toBe('task');
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}?panel=runbook`);
  await render();
  expect(pane()).toBe('code');
});

it('saves a Runbook-tab edit through the versioned save, keeps the record out of the explorer and the tabs, and keeps the newest text when the tools are drawn again', async () => {
  await openRunbookRoom();
  act(() => { fireEvent.input(purpose(), { target: { value: 'where web sends /api' } }); });
  // the tools drawn again inside the autosave window start from the newest text, not the loaded copy
  rig.showTools = false; await render();
  rig.showTools = true; await render();
  expect(purpose().value).toBe('where web sends /api');
  await debounce();
  const [phaseId, files, version] = rig.save.mock.lastCall!;
  expect([phaseId, Object.keys(files), version]).toEqual([rig.phaseId, [RUNBOOK_JSON], initial]);
  expect(validateRunbookRecord(files[RUNBOOK_JSON]).runbook!.environment[0].purpose).toBe('where web sends /api');
  // never a file: no editor tab and no explorer entry, and the editor shows the Dockerfile
  expect(host.querySelector('[data-testid="file-tab-deployment-runbook-json"]')).toBeNull();
  expect(JSON.stringify(rig.tree)).toContain('Dockerfile');
  expect(JSON.stringify(rig.tree)).not.toContain('runbook.json');
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Code"]')!.value).toBe('FROM python:3.12');
});

it('names a runbook saved somewhere else in words, never by its file name', async () => {
  await openRunbookRoom();
  rig.save.mockRejectedValueOnce(new ApiError(409, 'Conflict', undefined, { version: later, paths: [RUNBOOK_JSON] }));
  act(() => { fireEvent.input(purpose(), { target: { value: 'where web sends /api' } }); });
  await debounce();
  const notice = host.querySelector('[data-testid="workspace-conflict"]')!.textContent!;
  expect(notice).toContain('Your runbook was saved somewhere else after you opened this room.');
  expect(notice).not.toContain('runbook.json');
});
