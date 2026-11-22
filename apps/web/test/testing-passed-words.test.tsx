// @vitest-environment jsdom
/**
 * The Testing room's words on a passed phase.
 *
 * The Failing first tab said "A test proves something only if it was red
 * before the code made it green." over thirteen rows of "Never seen red:
 * written after the code passed". In Testing the application is finished
 * before any test is written, so every learner's test is green from its first
 * run; its red is against the planted bugs. On a passed phase the tab now says
 * so, calmly; while the phase is worked it reads as it always did.
 * The explorer's "13 tests not linked to a criterion" stayed a warning
 * beside a Met coverage criterion. A link is a claim the review does not grade:
 * on a passed phase the line is quiet (the dashed square), as the room's chip
 * already was; while the phase is worked it is the warning it was.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failingFirstWords, unlinkedLine } from '@/components/workspace/panels/testing/lib';
import { stubMatchMedia } from './support/dom';

const rig = vi.hoisted(() => ({
  phaseId: 'ledger-room',
  token: 'owner-a',
  load: vi.fn(),
  save: vi.fn(),
  exit: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
  runs: [] as unknown[],
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: rig.phaseId }),
  useRouter: () => rig.router,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string, public code?: string, public body?: unknown) {
      super(message);
    }
  }
  return {
    ApiError,
    API_URL: '/api',
    api: { saveWorkspace: rig.save, submit: vi.fn(), myEnrollment: vi.fn(async () => null) },
    getToken: () => rig.token,
    onSessionLeaving: () => () => {},
    signInHref: () => null,
  };
});
vi.mock('@/lib/session', () => ({
  getSession: () => ({ id: rig.token }),
  onSessionEnd: () => () => {},
  ownedByToken: (clear: () => void) => {
    let held = '';
    return () => {
      if (held !== rig.token) {
        clear();
        held = rig.token;
      }
    };
  },
}));
vi.mock('@/lib/api-workspace', () => ({
  workspaceApi: { phase: rig.load },
  saveVersionedWorkspaceOnExit: rig.exit,
  readVersionedWorkspaceDraft: () => null,
  rememberVersionedWorkspaceDraft: () => {},
  acknowledgeVersionedWorkspaceSave: () => {},
  discardVersionedWorkspaceDraft: () => {},
}));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({ details: {}, enrollment: null, analytics: null }),
  fullDetail: () => null,
  invalidateProject: vi.fn(),
  learnerMessage: (_err: unknown, fallback: string) => fallback,
}));
vi.mock('@/lib/project', () => ({ getActiveProject: () => 'tasktrackr', setActiveProject: vi.fn() }));
vi.mock('@/lib/records', () => ({ cachedRecords: () => ({ [rig.phaseId]: { submissions: [], runs: rig.runs } }), loadRecords: vi.fn(), refreshPhaseRecords: vi.fn() }));
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => '', clearCommitDraft: vi.fn(), useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: vi.fn(), useRecoverWhenBack: vi.fn() }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/workspace/usePreview', () => ({
  usePreview: () => ({ status: 'idle', console: [], errors: 0, stop: vi.fn() }),
  stopPreviewOnExit: vi.fn(),
}));
vi.mock('@/components/workspace/panels', () => ({ PHASE_PANELS: {} }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({
  useWorkspacePanels: () => ({ briefOpen: false, mentorOpen: false, setBriefOpen: vi.fn(), setMentorOpen: vi.fn() }),
  WorkspacePanelControls: () => null,
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/workspace/ImplementationTaskPanel', () => ({ ImplementationTaskPanel: () => null }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/Markdown', () => ({ Markdown: () => null }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/workspace/preload', () => ({
  preloadEditor: async () => {},
  loadedEditor: () => ({ value }: { value: string }) => <textarea aria-label="Code" value={value} readOnly />,
}));
vi.mock('@/components/shell', async () => ({
  ...(await import('@/components/shell/routes')),
  WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => (
    <main>
      {strip}
      {children}
    </main>
  ),
  PhaseStrip: ({ right }: { right: ReactNode }) => <header>{right}</header>,
  StatusBar: () => null,
  ActivityBar: () => null,
  // Every bottom tab's content is drawn, so the Ledger tab can be read.
  BottomPanel: ({ tabs }: { tabs: { key: string; content: ReactNode }[] }) => (
    <div>
      {tabs.map((tab) => (
        <section key={tab.key} data-testid={`bottom-${tab.key}`}>
          {tab.content}
        </section>
      ))}
    </div>
  ),
  // The explorer's source-control lines, drawn with their state, so the unlinked line can be read.
  Explorer: ({ sourceControl }: { sourceControl?: { lines?: { state: string; text: string }[] } }) => (
    <div data-testid="explorer-lines">
      {(sourceControl?.lines ?? []).map((l) => <p key={l.text} data-state={l.state}>{l.text}</p>)}
    </div>
  ),
  PersonaComposer: () => null,
  PersonaFeed: () => null,
  usePersona: () => ({ messages: [], busy: false }),
  PERSONA_NAME: {},
}));


const { default: WorkspacePage } = await import('@/app/(app)/workspace/[phaseId]/page');

const WORKING_PURPOSE = 'A test proves something only if it was red before the code made it green. The platform keeps the first run of each test.';
const WORKING_ROW = 'Never seen red: written after the code passed';
const PASSED_PURPOSE = 'In Testing the code already worked before your tests were written, so a test shows it can fail against the planted bugs, not here. The platform keeps the first run of each test.';
const PASSED_ROW = 'Green from its first run: the code already worked';

describe('the words, by whether the phase has passed', () => {
  it('while the phase is worked: the words the tab always had, the row a warning', () => {
    expect(failingFirstWords(false)).toEqual({ purpose: WORKING_PURPOSE, neverRed: WORKING_ROW, neverRedState: 'warn' });
  });
  it('on a passed phase: why every test is green from its first run, the row calm', () => {
    expect(failingFirstWords(true)).toEqual({ purpose: PASSED_PURPOSE, neverRed: PASSED_ROW, neverRedState: 'done' });
  });
  it('the unlinked line: the same words, a warning while worked and quiet once passed', () => {
    expect(unlinkedLine(13, false)).toEqual({ state: 'warn', text: '13 tests not linked to a criterion' });
    expect(unlinkedLine(13, true)).toEqual({ state: 'todo', text: '13 tests not linked to a criterion' });
    expect(unlinkedLine(1, false)).toEqual({ state: 'warn', text: 'One test not linked to a criterion' });
    expect(unlinkedLine(0, true)).toBeNull();
  });
});

describe('the Testing room, mounted', () => {
  let root: Root, host: HTMLDivElement, sequence = 0;
  beforeEach(() => {
    vi.clearAllMocks();
    rig.phaseId = `testing-room-${++sequence}`;
    stubMatchMedia();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    rig.save.mockResolvedValue({ saved: true, version: '2026-10-02T05:00:00.000Z' });
    rig.exit.mockResolvedValue({ version: '2026-10-02T05:00:00.000Z' });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const mount = async (status: 'passed' | 'in_progress') => {
    // One run, the learner's one test green in it: "never red".
    rig.runs = [{
      id: 'run-1', status: 'completed', kind: 'run', createdAt: '2026-10-02T04:00:00.000Z', inputHash: 'ab', runClock: null,
      result: { ok: true, exitKind: 'ok', stdout: '', stderr: '', durationMs: 10, tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [{ name: 'test_a_new_task_starts_open', status: 'passed' }] } },
    }];
    const detail = {
      id: rig.phaseId, key: 'testing', title: 'Testing', order: 4, place: 4, count: 6, status, projectSlug: 'tasktrackr',
      workspaceUpdatedAt: '2026-10-02T05:00:00.000Z',
      files: [{ path: 'tests/test_acceptance.py', content: 'def test_a_new_task_starts_open():\n    assert True\n', editable: true, language: 'python' }],
      attempts: status === 'passed' ? 1 : 0, rubric: { passThreshold: 70, criteria: [] }, objectives: [], taskPanel: '', links: [],
      canRun: true, canPreview: false, runLabel: 'Run tests', lastSubmission: null, solution: { available: false, files: 0, readAt: null },
    };
    rig.load.mockImplementation(async () => detail);
    window.history.replaceState(null, '', `/workspace/${rig.phaseId}`);
    await act(async () => { root.render(<WorkspacePage />); });
    await act(async () => { await Promise.resolve(); });
    const first = host.querySelector('[data-testid="bottom-first"]')!;
    const line = [...host.querySelectorAll('[data-testid="explorer-lines"] p')].find((p) => /not linked to a criterion/.test(p.textContent ?? '')) as HTMLElement;
    return { first: first.textContent ?? '', squares: [...first.querySelectorAll('[data-state]')].map((s) => s.getAttribute('data-state')), line };
  };

  it('a Testing phase being worked reads as it always did', async () => {
    const { first, squares, line } = await mount('in_progress');
    expect(first).toContain(WORKING_PURPOSE);
    expect(first).toContain(WORKING_ROW);
    expect(squares).toEqual(['warn']);
    expect(line.textContent).toBe('One test not linked to a criterion');
    expect(line.getAttribute('data-state')).toBe('warn');
  });

  it('a passed Testing phase says why its tests were never red, and the unlinked line is quiet', async () => {
    const { first, squares, line } = await mount('passed');
    expect(first).toContain(PASSED_PURPOSE);
    expect(first).toContain(PASSED_ROW);
    expect(first).not.toContain('proves something only if');
    expect(first).not.toContain('Never seen red');
    expect(squares).toEqual(['done']);
    expect(line.textContent).toBe('One test not linked to a criterion');
    expect(line.getAttribute('data-state')).toBe('todo');
  });
});
