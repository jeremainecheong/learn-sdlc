// @vitest-environment jsdom
/**
 * After the learner resolved INCIDENT-1 in Deployment's
 * Pipeline panel, the workspace drew a full-width band "The saved workspace
 * changed at <time>. Showing the latest saved copy." over the working-area row.
 * The resolve writes the incident into the runbook record on the server and the
 * page then reads the phase again; the reload saw the record differ from the
 * copy it held and, with nothing to explain it but an Apply, called it a change
 * from elsewhere. The reload is now told what the page's own resolve answered,
 * and takes the record it wrote up without the band; any other change is
 * announced.
 *
 * The real workspace page is mounted with the real Deployment panel (the
 * harness of workspace-save-feedback.test.tsx), over a fake server that writes
 * the incident as the API's resolve does.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({
  phaseId: 'save-phase', token: 'owner-a', save: vi.fn(), load: vi.fn(), exit: vi.fn(),
  start: vi.fn(), health: vi.fn(), resolve: vi.fn(),
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
  return { ApiError, API_URL: '/api', api: { saveWorkspace: rig.save, myEnrollment: vi.fn(async () => null), drillStart: rig.start, drillHealth: rig.health, drillResolve: rig.resolve },
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

import { EMPTY_RUNBOOK as EMPTY, DRILL_TIMELINE_EVENTS, RUNBOOK_JSON as RECORD, serialiseRunbook as serialise, validateRunbookRecord as validate } from '@learnsdlc/shared';
import { stubMatchMedia } from './support/dom';

const BAND = /The saved workspace changed at .*\. Showing the latest saved copy\./;
const resolveStamp = '2026-09-15T06:58:00.000Z';
const foreignStamp = '2026-09-15T06:57:00.000Z';
const paged = '2026-09-15T06:53:00.000Z';
const fixed = '2026-09-15T06:53:30.000Z';
const startingRecord = serialise({ ...EMPTY, environment: [{ id: 'E1', name: 'API_URL', purpose: 'where /api goes', kind: 'config' }] });
const writeUp = {
  rootCause: 'The web service pointed API_URL at itself, not the api service.',
  fix: 'API_URL names the api service, so the selfcheck reaches it now.',
  actionItem: 'Run the selfcheck before every deploy, in the pipeline.',
};

/** The server: its save stamp, its files and its drill, read by every GET and written as the API writes them. */
let server: { version: string; files: Record<string, string>; drill: Record<string, unknown> | null };
const detailOf = () => ({
  ...phase(rig.phaseId, server.version), key: 'deployment', title: 'Deployment', order: 5, artifactKind: 'config',
  runbook: { floor: { minEnvironment: 1, minHealth: 0, minRollback: 0, minData: 0, requireIncident: true }, drill: true },
  drill: server.drill,
  files: Object.entries(server.files).map(([path, content]) => ({ path, content, editable: true, language: path === RECORD ? 'json' : 'dockerfile' })),
});
/** The API's resolve: the incident and its three timeline lines into the record, a new stamp, the drill closed. */
function resolveOnServer(incident: typeof writeUp, stamp = resolveStamp) {
  const runbook = validate(server.files[RECORD]).runbook!;
  const timeline = [
    { at: paged, event: DRILL_TIMELINE_EVENTS.paged },
    { at: fixed, event: DRILL_TIMELINE_EVENTS.fixed },
    { at: stamp, event: DRILL_TIMELINE_EVENTS.closed },
  ];
  server.files[RECORD] = serialise({ ...runbook, incident: { rootCause: incident.rootCause.trim(), fix: incident.fix.trim(), actionItem: incident.actionItem.trim(), timeline } });
  server.version = stamp;
  server.drill = { ...server.drill, resolvedAt: stamp };
  return { ...server.drill, incident: { rootCause: incident.rootCause, fix: incident.fix, actionItem: incident.actionItem }, workspaceUpdatedAt: stamp };
}

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const band = () => host.querySelector('[data-testid="workspace-notice"]')?.textContent ?? null;
const field = (id: string) => host.querySelector<HTMLTextAreaElement>(`[data-testid="${id}"]`)!;
async function openPipeline(drill: Record<string, unknown> | null = { fault: 'api-url', pagedAt: paged, runbookBefore: null, pagedExit: 1, healthRanAt: fixed, healthExit: 0, fixAppliedAt: fixed, resolvedAt: null, incident: null }) {
  rig.panels.deployment = (await import('@/components/workspace/panels/deployment')).default;
  server = { version: initial, files: { 'api/Dockerfile': 'FROM python:3.12', [RECORD]: startingRecord }, drill };
  rig.load.mockImplementation(async () => detailOf());
  rig.resolve.mockImplementation(async (_id: string, incident: typeof writeUp) => resolveOnServer(incident));
  rig.start.mockImplementation(async () => {
    server.drill = { fault: 'api-url', pagedAt: paged, runbookBefore: null, pagedExit: 1, healthRanAt: null, healthExit: null, fixAppliedAt: null, resolvedAt: null, incident: null };
    return { ...server.drill, beforeStderr: 'selfcheck: API_URL points at the web container' };
  });
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}?panel=pipeline`);
  await render(); await settle();
}
async function resolveHere() {
  act(() => { fireEvent.change(field('phase-deployment-incident-root-cause'), { target: { value: writeUp.rootCause } }); });
  act(() => { fireEvent.change(field('phase-deployment-incident-fix'), { target: { value: writeUp.fix } }); });
  act(() => { fireEvent.change(field('phase-deployment-incident-action'), { target: { value: writeUp.actionItem } }); });
  await act(async () => { fireEvent.click(field('phase-deployment-drill-resolve')); });
  await settle();
}
const visible = async () => { await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); await settle(); };

it('the learner\'s own resolve: the record it wrote is taken up without the band, and the next save quotes its stamp', async () => {
  await openPipeline();
  expect(band()).toBeNull();
  await resolveHere();
  expect(rig.resolve).toHaveBeenCalledExactlyOnceWith(rig.phaseId, writeUp);
  expect(rig.load).toHaveBeenCalledTimes(2);
  expect(band()).toBeNull();
  expect(host.textContent).toContain('INCIDENT-1 was resolved at');
  // the page now holds the resolve's copy: its next save quotes the resolve's stamp, and nothing is in conflict
  rig.save.mockResolvedValueOnce({ saved: true, version: '2026-09-15T07:00:00.000Z' });
  act(() => { fireEvent.change(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Code"]')!, { target: { value: 'FROM python:3.13' } }); });
  await debounce();
  expect(rig.save).toHaveBeenLastCalledWith(rig.phaseId, { 'api/Dockerfile': 'FROM python:3.13' }, resolveStamp);
  expect(host.querySelector('[data-testid="workspace-conflict"]')).toBeNull();
});

it('starting the drill shows no band', async () => {
  await openPipeline(null);
  await act(async () => { fireEvent.click(field('phase-deployment-drill-start')); });
  await settle();
  expect(rig.start).toHaveBeenCalledTimes(1);
  expect(band()).toBeNull();
});

it('back in the workspace after resolving on the Incident drill page: the resolved record is the copy it opens on, no band', async () => {
  await openPipeline();
  resolveOnServer(writeUp);
  await act(async () => root.render(<WorkspacePage key="back-from-the-drill-page" />));
  await settle();
  expect(band()).toBeNull();
  expect(host.textContent).toContain('INCIDENT-1 was resolved at');
});

it('a foreign change, unchanged: another tab\'s save read when the tab comes back shows the band', async () => {
  await openPipeline();
  server.files['api/Dockerfile'] = 'FROM python:3.11'; server.version = foreignStamp;
  await visible();
  expect(band()).toMatch(BAND);
});

it('a foreign change to another file before the resolve is still announced when the resolve reads it back', async () => {
  await openPipeline();
  server.files['api/Dockerfile'] = 'FROM python:3.11'; server.version = foreignStamp;
  await resolveHere();
  expect(band()).toMatch(BAND);
});

it('a foreign change to the runbook before the resolve is still announced, though the resolve wrote the same record', async () => {
  await openPipeline();
  const runbook = validate(server.files[RECORD]).runbook!;
  server.files[RECORD] = serialise({ ...runbook, environment: [...runbook.environment, { id: 'E2', name: 'DB_URL', purpose: 'where the data lives', kind: 'config' }] });
  server.version = foreignStamp;
  await resolveHere();
  expect(band()).toMatch(BAND);
});

it('a change written after the resolve (a later stamp than the one it answered) is still announced', async () => {
  await openPipeline();
  rig.resolve.mockImplementation(async (_id: string, incident: typeof writeUp) => {
    const answered = resolveOnServer(incident);
    // an Apply elsewhere, or another tab's save, lands on the record before the page reads the phase again
    const runbook = validate(server.files[RECORD]).runbook!;
    server.files[RECORD] = serialise({ ...runbook, notes: 'Written in another tab.' }); server.version = '2026-09-15T06:59:00.000Z';
    return answered;
  });
  await resolveHere();
  expect(band()).toMatch(BAND);
});

/*
 * Unsaved edits at the moment of a resolve, as today: the panel saves what the
 * editor holds before it resolves (`flushSave`, quoting the stamp the page
 * holds), then reads the phase again. The typed text stays on screen, and the
 * file that save wrote is announced by the band, as it is after any save of the
 * page's own followed by a reload (the page does not count its own saves into
 * the copy it compares). Only the runbook record the resolve wrote is now taken
 * up without the band.
 */
it('unsaved editor text at the resolve: saved first, kept on screen, and announced', async () => {
  await openPipeline();
  rig.save.mockImplementation(async (_id: string, files: Record<string, string>) => {
    Object.assign(server.files, files); server.version = next;
    return { saved: true, version: next };
  });
  act(() => { fireEvent.change(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Code"]')!, { target: { value: 'FROM python:3.13' } }); });
  await resolveHere();
  expect(rig.save).toHaveBeenCalledExactlyOnceWith(rig.phaseId, { 'api/Dockerfile': 'FROM python:3.13' }, initial);
  expect(rig.save.mock.invocationCallOrder[0]).toBeLessThan(rig.resolve.mock.invocationCallOrder[0]);
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Code"]')!.value).toBe('FROM python:3.13');
  expect(band()).toMatch(BAND);
});

it('the rule itself: only the runbook record, only at the stamp the resolve answered, only with the write-up sent', async () => {
  const { writtenByOwnResolve } = await import('@/components/workspace/panels/deployment/drill');
  server = { version: initial, files: { [RECORD]: startingRecord }, drill: { pagedAt: paged, fixAppliedAt: fixed } };
  const answered = resolveOnServer(writeUp);
  const own = { version: answered.workspaceUpdatedAt, incident: writeUp };
  const read = server.files[RECORD];
  expect(writtenByOwnResolve(RECORD, startingRecord, read, resolveStamp, own)).toBe(true);
  expect(writtenByOwnResolve('api/Dockerfile', startingRecord, read, resolveStamp, own)).toBe(false);
  expect(writtenByOwnResolve(RECORD, startingRecord, read, foreignStamp, own)).toBe(false);
  expect(writtenByOwnResolve(RECORD, startingRecord, read, resolveStamp, { ...own, version: null })).toBe(false);
  expect(writtenByOwnResolve(RECORD, undefined, read, resolveStamp, own)).toBe(false);
  expect(writtenByOwnResolve(RECORD, startingRecord, read, resolveStamp, { ...own, incident: { ...writeUp, fix: 'Another fix, written in another tab.' } })).toBe(false);
  expect(writtenByOwnResolve(RECORD, startingRecord, '{ not a record', resolveStamp, own)).toBe(false);
});
