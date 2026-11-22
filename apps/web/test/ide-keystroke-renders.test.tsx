// @vitest-environment jsdom
/**
 * One keystroke in the IDE editor stays within its render budget (browser
 * proof: e2e/render-cost.spec.ts).
 *
 * The budget is fewer than 120 elements re-committed outside the editor per
 * keystroke. Held as page state, the caret would re-render about 231 (the
 * page root, the activity bar, the status bar, the file tabs, the preview and
 * mentor panels) because Monaco reports the caret on every character
 * (`onCursor`), and `setCursor({ line, col })` is a new object each time, so
 * the whole IDE page would render again per key, for the sake of two numbers
 * in the status bar. The caret lives in a small store the status bar alone
 * reads; the page keeps only the caret's line (the function map follows it),
 * which a character typed on the same line does not change.
 *
 * The harness is workspace-save-feedback.test.tsx's, with the page's chrome
 * counting its own renders.
 */
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
  onCursor: null as null | ((line: number, col: number) => void),
  renders: { strip: 0, activity: 0, status: 0 },
  caret: '',
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
vi.mock('@/lib/records', () => ({ cachedRecords: () => ({}), loadRecords: vi.fn(), refreshPhaseRecords: vi.fn() }));
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => '', clearCommitDraft: vi.fn(), useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: vi.fn(), useRecoverWhenBack: vi.fn() }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: (_id: string, flush: () => Promise<void>, refresh: () => Promise<void>) => { rig.flush = flush; rig.refresh = refresh; return false; } }));
vi.mock('@/components/workspace/usePreview', () => ({ usePreview: () => ({ status: 'idle', console: [], errors: 0, stop: vi.fn() }), stopPreviewOnExit: vi.fn() }));
vi.mock('@/components/workspace/panels', () => ({ PHASE_PANELS: {} }));
vi.mock('@/components/workspace/panels/testing/useTesting', () => ({ useTesting: () => ({ tests: [], linked: {}, view: { total: 0, killed: 0 }, criteria: [], mutants: [] }) }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({ useWorkspacePanels: () => ({ briefOpen: false, mentorOpen: false, setBriefOpen: vi.fn(), setMentorOpen: vi.fn() }), WorkspacePanelControls: () => null, WorkspaceMentorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/workspace/ImplementationTaskPanel', () => ({ ImplementationTaskPanel: () => null }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/Markdown', () => ({ Markdown: () => null }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/workspace/preload', () => ({ preloadEditor: async () => {}, loadedEditor: () =>
  ({ value, onChange, onCursor }: { value: string; onChange: (value: string) => void; onCursor: (line: number, col: number) => void }) => {
    rig.onCursor = onCursor;
    return <textarea aria-label="Code" value={value} onChange={event => onChange(event.target.value)} />;
  } }));
vi.mock('@/components/shell', async () => ({
  ...await import('@/components/shell/routes'),
  WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => <main>{strip}{children}</main>,
  PhaseStrip: ({ right }: { right: ReactNode }) => { rig.renders.strip += 1; return <header>{right}</header>; },
  StatusBar: ({ saveState, savedAt, line, col }: { saveState: string; savedAt?: string; line: number; col: number }) => {
    rig.renders.status += 1; rig.caret = `${line}:${col}`;
    return <output aria-label="Save status">{saveState} {savedAt}</output>;
  },
  ActivityBar: () => { rig.renders.activity += 1; return null; }, BottomPanel: () => null, Explorer: () => null, PersonaComposer: () => null, PersonaFeed: () => null,
  usePersona: () => ({ messages: [], busy: false }), PERSONA_NAME: { implementation: 'Ari' },
}));

import WorkspacePage from '@/app/(app)/workspace/[phaseId]/page';
import { stubMatchMedia } from './support/dom';
const initial = '2026-09-15T06:52:00.000Z';
const phase = (id = rig.phaseId, version = initial) => ({
  id, key: 'implementation', title: 'Implementation', order: 3, status: 'in_progress', projectSlug: 'tasktrackr',
  workspaceUpdatedAt: version, files: [{ path: 'api/repository/tasks.py', content: 'saved code', editable: true, language: 'python' }],
  attempts: 0, rubric: { criteria: [] }, objectives: [], taskPanel: '', links: [], canRun: false, canPreview: false, runLabel: 'Run tests',
});
let root: Root, host: HTMLDivElement, sequence = 0;
const render = () => act(async () => { root.render(<WorkspacePage />); });
/** One character, the way Monaco reports it: the text, then the caret after it. */
const key = (text: string, col: number, line = 1) => act(() => {
  fireEvent.change(host.querySelector('textarea')!, { target: { value: text } });
  rig.onCursor!(line, col);
});
const zero = () => { rig.renders.strip = 0; rig.renders.activity = 0; rig.renders.status = 0; };
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); rig.drafts.clear(); rig.phaseId = `caret-phase-${++sequence}`; rig.token = `owner-${sequence}`;
  stubMatchMedia();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  rig.load.mockImplementation(async () => phase()); rig.save.mockResolvedValue({ saved: true, version: '2026-09-15T06:54:00.000Z' }); rig.exit.mockResolvedValue({ version: initial });
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}`);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

it('a character typed in the editor redraws the caret readout and not the page around it', async () => {
  await render();
  expect(host.querySelector('textarea')).not.toBeNull();
  // The first character is the one that marks the file changed: spent before
  // the meter goes on, as the browser spec does.
  key('xsaved code', 2);
  zero();

  key('xysaved code', 3);
  expect(rig.caret, 'the status bar reads the caret').toBe('1:3');
  expect(rig.renders.status, 'the caret readout is redrawn').toBeGreaterThan(0);
  expect(rig.renders.strip, 'the phase strip is redrawn by a character').toBe(0);
  expect(rig.renders.activity, 'the activity bar is redrawn by a character').toBe(0);
});

it('five more characters on the same line redraw no chrome either', async () => {
  await render();
  key('xsaved code', 2);
  zero();
  for (let col = 3; col <= 7; col += 1) key(`${'z'.repeat(col - 1)}saved code`, col);
  expect(rig.caret).toBe('1:7');
  expect(rig.renders.strip).toBe(0);
  expect(rig.renders.activity).toBe(0);
});

it('the caret is still read on a new line, and the autosave still says Saved', async () => {
  await render();
  key('x\nsaved code', 1, 2);
  expect(rig.caret).toBe('2:1');
  await act(async () => { await vi.advanceTimersByTimeAsync(700); });
  expect(rig.save).toHaveBeenCalledTimes(1);
  expect(host.querySelector('output')!.textContent).toContain('Saved');
});
