// @vitest-environment jsdom
/**
 * The work room hands the editor the first line an Apply changed in the
 * open file, once, and drops it once shown; nothing else (opening the room, an Apply that leaves the open file as it
 * was, a keystroke, another file opened first) hands the editor a line to show. The line carries the
 * moment the Apply was pressed, so the editor gives way to a scroll the person made since. The lower
 * panel's result is not touched. The editor is stood in for by a stub that shows what it is given; its own call is pinned in
 * applied-line-editor.test.tsx.
 *
 * The harness is work-room-header.test.tsx's (the REAL work room, the network stood in for).
 */
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({
  phaseId: 'applied-room', token: 'owner-a', save: vi.fn(), load: vi.fn(), exit: vi.fn(), submit: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
  preview: null as null | Record<string, unknown>,
  reset: null as unknown,
  applied: null as null | ((workspace?: Record<string, string>) => Promise<unknown>),
  /** The assistant readying an operation: what the Apply's press runs first. */
  prepare: null as null | (() => Promise<void>),
  /** What the room last handed the editor, and the editor's two answers. */
  editor: null as null | { path: string; value: string; revealOnce: { line: number; text: string; nonce: number; since?: number } | null; onRevealed?: () => void; onChange: (v: string) => void },
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: rig.phaseId }), useRouter: () => rig.router, useSearchParams: () => new URLSearchParams(window.location.search), usePathname: () => `/workspace/${rig.phaseId}` }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: ComponentProps<'a'>) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/api', () => {
  class ApiError extends Error { constructor(public status: number, message: string, public code?: string, public body?: unknown) { super(message); } }
  return { ApiError, API_URL: '/api', api: { saveWorkspace: rig.save, submit: rig.submit, myEnrollment: vi.fn(async () => null), getSubmission: vi.fn() },
    getToken: () => rig.token, onSessionLeaving: () => () => {}, signInHref: () => null };
});
vi.mock('@/lib/session', () => ({ getSession: () => ({ id: rig.token }), useSession: () => ({ id: rig.token, role: 'LEARNER' }), onSessionEnd: () => () => {}, ownedByToken: (clear: () => void) => { let held = ''; return () => { if (held !== rig.token) { clear(); held = rig.token; } }; } }));
vi.mock('@/lib/api-workspace', () => ({
  workspaceApi: { phase: rig.load }, saveVersionedWorkspaceOnExit: rig.exit,
  readVersionedWorkspaceDraft: () => null,
  rememberVersionedWorkspaceDraft: () => {},
  acknowledgeVersionedWorkspaceSave: () => {},
  discardVersionedWorkspaceDraft: () => {},
}));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ details: {}, enrollment: null, analytics: null }), useProjectMaybe: () => null, fullDetail: () => null, invalidateProject: vi.fn(), learnerMessage: (_err: unknown, fallback: string) => fallback }));
vi.mock('@/lib/project', () => ({ getActiveProject: () => 'tasktrackr', setActiveProject: vi.fn() }));
vi.mock('@/lib/records', () => ({ cachedRecords: () => ({}), loadRecords: vi.fn(), refreshPhaseRecords: vi.fn() }));
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => '', clearCommitDraft: vi.fn(), useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: vi.fn(() => new Promise(() => {})), useRecoverWhenBack: vi.fn() }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: (_phaseId: string, prepare: () => Promise<void>, refresh: (workspace?: Record<string, string>) => Promise<unknown>) => { rig.prepare = prepare; rig.applied = refresh; return false; } }));
vi.mock('@/components/workspace/preview/client/ClientPagePreview', () => ({ ClientPagePreview: () => <div data-testid="client-page-preview">Page preview: your code running in the browser<iframe data-testid="page-preview-frame" title="Page preview" /></div> }));
vi.mock('@/components/workspace/usePreview', () => ({ usePreview: () => rig.preview ?? ({ status: 'idle', console: [], errors: 0, stop: vi.fn() }), stopPreviewOnExit: vi.fn() }));
vi.mock('@/components/workspace/TaskResetControl', async (original) => ({
  ...await original<typeof import('@/components/workspace/TaskResetControl')>(),
  TaskResetControl: ({ onReset }: { onReset: typeof rig.reset }) => { rig.reset = onReset; return null; },
}));
vi.mock('@/components/workspace/panels', () => ({ PHASE_PANELS: {} }));
vi.mock('@/components/workspace/FeedbackPanel', () => ({ FeedbackPanel: () => <div data-testid="feedback-verdict">The verdict</div> }));
vi.mock('@/components/workspace/panels/testing/useTesting', async (original) => {
  const real = await original<typeof import('@/components/workspace/panels/testing/useTesting')>();
  return { ...real, useTesting: () => ({ tests: [], linked: {}, view: { total: 0, killed: 0, rows: [] }, criteria: [], mutants: [], first: [] }) };
});
vi.mock('@/components/workspace/WorkspacePanels', () => ({
  useWorkspacePanels: () => ({ briefOpen: true, mentorOpen: true, setBriefOpen: vi.fn(), setMentorOpen: vi.fn(), briefId: 'brief', mentorId: 'mentor' }),
  WorkspacePanelControls: ({ panels, placement }: any) => (
    <div data-testid="panel-controls" data-placement={placement ?? 'row'} data-brief={String(panels.briefOpen)} data-mentor={String(panels.mentorOpen)}>
      <button type="button" data-testid="toggle-brief" onClick={() => panels.setBriefOpen(!panels.briefOpen)}>brief</button>
    </div>
  ),
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/workspace/ImplementationTaskPanel', () => ({ ImplementationTaskPanel: () => null }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/Markdown', () => ({ Markdown: () => null }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/workspace/preload', () => ({ preloadEditor: async () => {}, loadedEditor: () =>
  (props: NonNullable<typeof rig.editor>) => { rig.editor = props; return <textarea aria-label="Code" data-path={props.path} data-reveal={props.revealOnce ? String(props.revealOnce.line) : ''} value={props.value} readOnly />; } }));
vi.mock('@/components/shell', async () => ({
  ...await import('@/components/shell/routes'),
  WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => <main>{strip}{children}</main>,
  StatusBar: () => null,
  ActivityBar: () => null, Explorer: () => null, PersonaComposer: () => null, PersonaFeed: () => null,
  BottomPanel: ({ tabs, value }: { tabs: { key: string; label: string }[]; value: string }) => (
    <div data-testid="bottom-panel" data-value={value}>{tabs.map((t) => <span key={t.key}>{t.label}</span>)}</div>
  ),
  usePersona: () => ({ messages: [], busy: false }), PERSONA_NAME: { implementation: 'Nova', testing: 'Quinn' },
}));

import WorkspacePage from '@/app/(app)/workspace/[phaseId]/page';
import { stubMatchMedia } from './support/dom';

const VERSION = '2026-11-18T04:50:00.000Z';
const HELPER = 'web/src/lib/overdue.ts';
const OTHER = 'web/src/lib/task.ts';
const BEFORE = ['// 1', '// 2', '// 3', '// 4', '// 5', '// 6', '// 7', '// 8', '// 9', '// 10', '// A task is overdue when its due date is before today.', '  return false; // TODO(learner): replace this line with the rule above.', '}', ''].join('\n');
const AFTER = BEFORE.replace('  return false; // TODO(learner): replace this line with the rule above.', '  return task.dueDate < today;');
type Row = Record<string, unknown>;
const phase = (helper: string, other = 'export type Task = {};', version = VERSION): Row => ({
  id: rig.phaseId, key: 'implementation', title: 'Implementation', order: 3, place: 3, count: 6, status: 'in_progress', projectSlug: 'deadline',
  workspaceUpdatedAt: version,
  files: [
    { path: HELPER, content: helper, editable: true, language: 'typescript' },
    { path: OTHER, content: other, editable: false, language: 'typescript' },
  ],
  attempts: 0, rubric: { passThreshold: 70, criteria: [] }, objectives: [], taskPanel: '', links: [], canRun: true, canPreview: false, runLabel: 'Run tests',
  tasks: undefined, taskCounts: undefined, lastSubmission: null,
  solution: { available: false, files: 0, readAt: null },
});

let root: Root, host: HTMLDivElement, sequence = 0;
const $ = (selector: string) => host.querySelector<HTMLElement>(selector);
const open = async (detail: Row) => {
  rig.load.mockImplementation(async () => detail);
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}?file=${encodeURIComponent(HELPER)}`);
  await act(async () => { root.render(<WorkspacePage />); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
};
/** The Apply: the API now holds `detail`, and the room reads it back as the assistant's signal asks. */
const apply = async (detail: Row) => {
  rig.load.mockImplementation(async () => detail);
  await act(async () => { await rig.applied!(); });
  await act(async () => { await Promise.resolve(); });
};

class FakeResizeObserver { observe() {} disconnect() {} unobserve() {} }
beforeEach(() => {
  vi.clearAllMocks(); rig.phaseId = `applied-room-${++sequence}`; rig.token = `owner-${sequence}`; rig.editor = null; rig.preview = null;
  stubMatchMedia();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  rig.save.mockResolvedValue({ saved: true, version: VERSION }); rig.exit.mockResolvedValue({ version: VERSION });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe('the work room hands the editor the line an Apply changed, once', () => {
  it('the Apply changes the open helper: the editor gets the applied text with line 12, and the line is dropped once shown', async () => {
    await open(phase(BEFORE));
    expect(rig.editor!.path).toBe(HELPER);
    expect(rig.editor!.revealOnce).toBeNull();
    const panel = $('[data-testid="bottom-panel"]')?.outerHTML ?? null;
    await apply(phase(AFTER, undefined, '2026-11-18T04:51:00.000Z'));
    expect(rig.editor!.value).toBe(AFTER);
    expect(rig.editor!.revealOnce).toMatchObject({ line: 12, last: 12, text: AFTER });
    // The lower panel is left on what it showed.
    expect($('[data-testid="bottom-panel"]')?.outerHTML ?? null).toBe(panel);
    await act(async () => { rig.editor!.onRevealed!(); });
    expect(rig.editor!.revealOnce).toBeNull();
  });

  it('an Apply that changes several lines of the open file hands the editor the first and the last of them', async () => {
    await open(phase(BEFORE));
    const several = BEFORE.replace('  return false; // TODO(learner): replace this line with the rule above.\n}',
      '  if (task.done) return false;\n  return task.dueDate < today;\n}\n// The helper ends here.');
    await apply(phase(several, undefined, '2026-11-18T04:51:00.000Z'));
    expect(rig.editor!.value).toBe(several);
    expect(rig.editor!.revealOnce).toMatchObject({ line: 12, last: 15, text: several });
  });

  it('opening the room hands no line; an Apply that leaves the open file as it was hands none (no other file is opened)', async () => {
    await open(phase(BEFORE));
    await apply(phase(BEFORE, 'export type Task = { done: boolean };', '2026-11-18T04:51:00.000Z'));
    expect(rig.editor!.path).toBe(HELPER);
    expect(rig.editor!.revealOnce).toBeNull();
  });

  it('a keystroke before the line is shown drops it', async () => {
    await open(phase(BEFORE));
    await apply(phase(AFTER, undefined, '2026-11-18T04:51:00.000Z'));
    expect(rig.editor!.revealOnce).not.toBeNull();
    await act(async () => { rig.editor!.onChange(`${AFTER}// typed`); });
    expect(rig.editor!.revealOnce).toBeNull();
  });

  it('another file opened before the editor has shown the line drops it, and coming back to the file shows nothing', async () => {
    // The helper's test file is its twin, so the strip opens it beside the helper.
    const TWIN = 'web/src/lib/overdue.test.ts';
    const withTwin = (detail: Row) => ({ ...detail, files: [...(detail.files as Row[]), { path: TWIN, content: "test('x', () => {});", editable: false, language: 'typescript' }] });
    await open(withTwin(phase(BEFORE)));
    await apply(withTwin(phase(AFTER, undefined, '2026-11-18T04:51:00.000Z')));
    expect(rig.editor!.revealOnce).not.toBeNull();
    await act(async () => { $('[data-testid="file-tab-web-src-lib-overdue-test-ts"]')!.click(); });
    expect(rig.editor!.path).toBe(TWIN);
    expect(rig.editor!.revealOnce).toBeNull();
    await act(async () => { $('[data-testid="file-tab-web-src-lib-overdue-ts"]')!.click(); });
    expect(rig.editor!.path).toBe(HELPER);
    expect(rig.editor!.value).toBe(AFTER);
    expect(rig.editor!.revealOnce).toBeNull();
  });

  it('the line is handed over with the moment the Apply was pressed, so the editor can give way to a scroll made since', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(4_000);
    await open(phase(BEFORE));
    await act(async () => { await rig.prepare!(); });
    now.mockReturnValue(6_000);
    await apply(phase(AFTER, undefined, '2026-11-18T04:51:00.000Z'));
    expect(rig.editor!.revealOnce).toMatchObject({ line: 12, since: 4_000 });
    now.mockRestore();
  });

  it('a read-back with no press of its own ("Retry loading") counts from its own start', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(4_000);
    await open(phase(BEFORE));
    await act(async () => { await rig.prepare!(); });
    await apply(phase(BEFORE, 'export type Task = { done: boolean };', '2026-11-18T04:51:00.000Z'));
    now.mockReturnValue(9_000);
    await apply(phase(AFTER, undefined, '2026-11-18T04:52:00.000Z'));
    expect(rig.editor!.revealOnce).toMatchObject({ line: 12, since: 9_000 });
    now.mockRestore();
  });
});
