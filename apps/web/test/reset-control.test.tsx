// @vitest-environment jsdom
/**
 * "Start this task over", over the pages Next serves.
 *
 * A learner on a teacher's project resets one task of theirs. What is asserted
 * is the path a learner walks, on the real rooms with `request` and `fetch` the
 * only seams, so the paths the real clients build are what the cases read:
 *
 *   the control is drawn only on an authored, non-quiz task that has not
 *   passed and is not awaiting a teacher's sign-off, never on TaskTrackr (1)
 *   the confirm is the API's own plan: what is restored, re-seeded, kept and
 *   by which sibling, the phase-wide proposal sentence and the plan's note   (2)
 *   the room saves what is typed first, then quotes the version it holds     (3)
 *   on success the buffer is replaced, the version adopted and the local
 *   draft dropped, so another tab's (or the next) save is judged against it (4)
 *   a stale version is the save's 409: nothing written, the newer copy shown (5)
 *   a refusal is its one sentence, and nothing is written                   (6)
 *   the dialog is labelled, holds the keyboard, closes with Escape and gives
 *   focus back to the control                                                (7)
 *   the saver the document rooms share adopts a reset                        (8)
 *   the teacher's regrade trail says a revision was of an earlier run        (9)
 *   a passed task (or a passed TaskTrackr phase) offers "Retry this task"
 *   ("Retry this phase"), whose confirm is the API's retry plan             (10)
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventView, PhaseDetail, PhaseKey, PhaseTaskView, TaskResetPlanView } from '@learnsdlc/shared';

/* ------------------------------- the fixtures ----------------------------- */

const PHASE_ID = 'phase-reset';
const MY_STORY = 'requirements/draft.md';
const CODE = 'src/report.py';
/** The starter the code task is seeded with, which a reset restores. */
const STARTER = 'def report():\n    pass\n';
/** The learner's work on the code task before any reset. */
const DRAFT_ONE = 'def report():\n    return "draft one"\n';
const FIRST_VERSION = '2026-09-20T09:00:00.000Z';

const task = (over: Partial<PhaseTaskView> & { key: string; order: number }): PhaseTaskView =>
  taskView({ artefactType: 'user-story', attempts: 1, ...over });

const server = {
  /** 'split': the phase's own task + a quiz; 'main': a teacher phase with one inherited task; 'sole': TaskTrackr; 'pair': two code tasks in one room. */
  shape: 'split' as 'split' | 'main' | 'sole' | 'pair',
  phaseKey: 'implementation' as PhaseKey,
  main: {} as Partial<PhaseTaskView>,
  /** The phase row's status, as the detail carries it. */
  phaseStatus: 'in_progress' as string,
  plan: null as TaskResetPlanView | null,
  /** The next POST is refused with this sentence (a 409 the learner can wait out). */
  refuseNext: '' as string,
  /** Another tab saved after this one loaded: the next POST meets a newer version. */
  staleNext: false,
  resets: 0,
  /** Holds the plan GET (and the reset POST) until the test lets it answer. */
  planGate: null as Promise<void> | null,
  postGate: null as Promise<void> | null,
  /** The phase cannot be read again once a reset has landed (the reload fails). */
  failPhaseAfterReset: false,
  version: FIRST_VERSION,
  files: {} as Record<string, string>,
  calls: [] as { method: string; path: string; body?: unknown }[],
};

const requirementsPhase = () => server.phaseKey === 'requirements';
/** The artefact a document room is built around, where the phase has one. */
const ROOM_FILE: Partial<Record<PhaseKey, string>> = { maintenance: 'maintenance/change-request.json', design: 'design/design.json' };

const tasks = (): PhaseTaskView[] => {
  if (server.shape === 'sole') {
    return [task({ key: '', order: 1, title: 'The overdue report', artefactType: 'code', files: [CODE], primaryPath: CODE, ...server.main })];
  }
  const room = ROOM_FILE[server.phaseKey];
  const main = room
    ? task({ key: 'main', order: 1, title: 'The room task', artefactType: 'document', artefactPath: room, files: [room], primaryPath: room, ...server.main })
    : task({
        key: 'main',
        order: 1,
        title: requirementsPhase() ? 'The user story' : 'The overdue report',
        artefactType: requirementsPhase() ? 'user-story' : 'code',
        artefactPath: requirementsPhase() ? MY_STORY : CODE,
        files: requirementsPhase() ? [MY_STORY, 'requirements/story.json'] : [CODE],
        primaryPath: requirementsPhase() ? MY_STORY : CODE,
        ...server.main,
      });
  if (server.shape === 'main') return [main];
  // Two code tasks worked in the same room, switched with ?task=.
  if (server.shape === 'pair') {
    return [main, task({ key: 'second', order: 2, title: 'The second report', artefactType: 'code', artefactPath: CODE, files: [CODE], primaryPath: CODE })];
  }
  // A phase holds one task of its own work, and a teacher may add a concept quiz beside it.
  return [main, task({ key: 'concepts', order: 2, title: 'Concepts', artefactType: 'quiz', evidence: 'automated' })];
};

const phaseFiles = () =>
  ROOM_FILE[server.phaseKey]
    ? [{ path: ROOM_FILE[server.phaseKey]!, content: server.files[ROOM_FILE[server.phaseKey]!] ?? '', editable: true, language: 'markdown' }]
    : requirementsPhase()
    ? [
        { path: MY_STORY, content: server.files[MY_STORY] ?? '', editable: true, language: 'markdown' },
        { path: 'requirements/story.json', content: '{}', editable: true, language: 'json' },
      ]
    : [{ path: CODE, content: server.files[CODE] ?? STARTER, editable: true, language: 'python' }];

const counts = () => {
  const list = tasks();
  return { total: list.length, required: list.filter((row) => row.required).length, passed: 0, passedRequired: 0 };
};

let held: ReturnType<typeof buildDetail> | null = null;
const detail = () => (held ??= buildDetail());
const buildDetail = () => ({
  id: PHASE_ID,
  key: server.phaseKey,
  order: requirementsPhase() ? 1 : 3,
  // The place and count the API sends with a detail (TaskTrackr's six).
  place: requirementsPhase() ? 1 : 3,
  count: 6,
  title: requirementsPhase() ? 'Requirements' : 'Implementation',
  status: server.phaseStatus,
  projectSlug: 'room-desk',
  // The change room opens for a Maintenance of the code kind.
  ...(server.phaseKey === 'maintenance' ? { artifactKind: 'code' } : {}),
  bestScore: null,
  attempts: 1,
  reflection: null,
  passedAt: null,
  workspaceUpdatedAt: server.version,
  files: phaseFiles(),
  tasks: tasks(),
  taskCounts: counts(),
  rubric: { passThreshold: 70, criteria: [{ key: 'c-phase', title: 'The phase criterion', description: '', weight: 1 }] },
  objectives: ['Work through the phase in order.'],
  taskPanel: 'The phase brief.',
  links: [],
  canRun: false,
  canPreview: false,
  runLabel: 'Run tests',
  lastSubmission: null,
  solution: { available: false, files: 0, readAt: null },
});

const summary = () => ({
  id: PHASE_ID,
  key: server.phaseKey,
  order: requirementsPhase() ? 1 : 3,
  title: requirementsPhase() ? 'Requirements' : 'Implementation',
  status: 'in_progress',
  bestScore: null,
  attempts: 1,
  reflection: null,
  passedAt: null,
  taskCounts: detail().taskCounts,
});

/* ------------------------------- the stand-ins ---------------------------- */

const rig = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
  request: vi.fn(),
}));

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, request: rig.request };
});
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => {
    window.addEventListener('popstate', notify);
    return () => window.removeEventListener('popstate', notify);
  };
  const read = () => `${window.location.pathname}?${window.location.search}`;
  return {
    useRouter: () => rig.router,
    useParams: () => ({ phaseId: PHASE_ID }),
    usePathname: () => {
      useSyncExternalStore(subscribe, read, read);
      return window.location.pathname;
    },
    useSearchParams: () => {
      useSyncExternalStore(subscribe, read, read);
      return new URLSearchParams(window.location.search);
    },
  };
});
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'learner-one', role: 'LEARNER', displayName: 'Ada Example' }),
  getSession: () => ({ id: 'learner-one', role: 'LEARNER', displayName: 'Ada Example' }),
}));
let project: ReturnType<typeof buildProject>;
const buildProject = () => ({
  enrollment: {
    id: 'enrolment-one',
    projectTitle: 'RoomDesk',
    projectSlug: 'room-desk',
    currentPhaseOrder: detail().order,
    completed: false,
    phases: [summary()],
  },
  currentPhase: summary(),
  details: { [PHASE_ID]: detail() },
  analytics: null,
  loading: false,
  error: '',
  reload: vi.fn(),
});
vi.mock('@/lib/useProject', async (original) => {
  const actual = await original<typeof import('@/lib/useProject')>();
  return { ...actual, useProject: () => project, useProjectMaybe: () => project, invalidateProject: vi.fn() };
});
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/components/workspace/preload', () => ({
  preloadEditor: async () => {},
  loadedEditor: () => ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Code" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock('@/components/workspace/panels', () => ({
  PHASE_PANELS: { requirements: { Brief: () => null }, implementation: { Brief: () => null } },
}));
vi.mock('@/components/workspace/panels/testing/useTesting', () => ({
  useTesting: () => ({ tests: [], linked: {}, view: { total: 0, killed: 0 }, criteria: [], mutants: [], first: [] }),
}));
vi.mock('@/components/workspace/usePreview', () => ({
  usePreview: () => ({ status: 'idle', console: [], errors: 0, stop: vi.fn() }),
  stopPreviewOnExit: vi.fn(),
}));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/shell/PersonaPanel', async (original) => ({
  ...(await original<typeof import('@/components/shell/PersonaPanel')>()),
  PersonaPanel: () => null,
  MentorSession: () => null,
}));
vi.mock('@/components/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));

import Layout from '@/app/(app)/workspace/[phaseId]/layout';
import WorkspacePage from '@/app/(app)/workspace/[phaseId]/page';
import ChangePage from '@/app/(app)/workspace/[phaseId]/change/page';
import { readChangeTouched, recordChangeTouched } from '@/components/workspace/panels/maintenance/change-edit';
import DesignPage from '@/app/(app)/workspace/[phaseId]/design/page';
import { TOKEN_KEY } from '@/lib/session';
import { ApiError } from '@/lib/api';
import { resetRecords } from '@/lib/records';
import { LATE_STATUS_MS, resetNote, resetOffered, RESET_DONE, RESET_DROPS_PROPOSAL, RESET_KEEPS, RESET_NOTE, RESET_STALE, RESET_STALE_NOTE, RETRY_NOTE, TaskResetControl } from '@/components/workspace/TaskResetControl';
import { retryDone, retryHistory, retryLabel, retryOffered, RETRY_REPLACES } from '@/components/workspace/TaskRetry';
import { startViewAs, stopViewAs } from '@/lib/view-as';
import { WORKSPACE_SAVE_DELAY_MS, useVersionedWorkspaceSave } from '@/components/workspace/useVersionedWorkspaceSave';
import { rememberVersionedWorkspaceDraft } from '@/lib/api-workspace';
import { describeAudit } from '@/components/staff/AuditList';
import { taskView } from './fixtures';
import { settle, stubMatchMedia } from './support/dom';

/* -------------------------------- the server ------------------------------ */

const nextVersion = () =>
  new Date(Date.parse(server.version) + 60_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');

const RESET_PATH = (key: string) => `/phases/${PHASE_ID}/tasks/${key}/reset`;
/** A sole task's key is the empty key, so its retry is the phase-level pair. */
const PHASE_RESET_PATH = `/phases/${PHASE_ID}/reset`;
const isResetPath = (path: string) => /\/tasks\/[^/]+\/reset$/.test(path) || path === PHASE_RESET_PATH;

class Refusal extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const serve = async (method: string, path: string, body?: unknown): Promise<unknown> => {
  server.calls.push({ method, path, body });
  if (method === 'GET' && path === `/phases/${PHASE_ID}`) {
    if (server.failPhaseAfterReset && server.resets > 0) throw new Refusal('The connection dropped.', 503);
    return detail();
  }
  if (method === 'GET' && isResetPath(path)) {
    if (server.planGate) await server.planGate;
    return server.plan ?? { restores: [], reseeds: [], protectedBy: [], dropsPendingProposal: false, refusal: null, retry: null };
  }
  if (method === 'POST' && isResetPath(path)) {
    if (server.postGate) await server.postGate;
    if (server.refuseNext) {
      const sentence = server.refuseNext;
      server.refuseNext = '';
      throw new Refusal(sentence, 409);
    }
    if (server.staleNext) {
      server.staleNext = false;
      server.version = nextVersion();
      server.files[CODE] = 'Saved in another tab.';
      held = null;
    }
    const base = (body as { baseVersion?: string | null })?.baseVersion ?? '';
    if (base !== server.version) {
      throw new Refusal('This workspace was saved somewhere else after you opened it. Nothing here was written over it.', 409, {
        error: 'workspace_changed',
        version: server.version,
        files: { [CODE]: server.files[CODE] ?? '' },
      });
    }
    for (const restored of server.plan?.restores ?? []) delete server.files[restored];
    server.version = nextVersion();
    server.resets += 1;
    // A retry puts the passed task back in progress, as the API answers it.
    if (server.plan?.retry) {
      server.main = { ...server.main, status: 'in_progress' };
      server.phaseStatus = 'in_progress';
    }
    held = null;
    const key = path === PHASE_RESET_PATH ? '' : path.split('/tasks/')[1].replace('/reset', '');
    return { version: server.version, workspace: { ...server.files }, task: tasks().find((one) => one.key === key) };
  }
  if (method === 'GET' && /\/tasks\/[^/]+\/submissions$/.test(path)) return [];
  if (method === 'PUT' && path === `/phases/${PHASE_ID}/workspace`) {
    const sent = body as { files?: Record<string, string>; baseVersion?: string };
    if (sent.baseVersion !== undefined && sent.baseVersion !== server.version) {
      throw new Refusal('This workspace changed elsewhere.', 409, { version: server.version });
    }
    Object.assign(server.files, sent.files ?? {});
    server.version = nextVersion();
    held = null;
    return { saved: true, version: server.version };
  }
  if (method === 'GET' && path === `/phases/${PHASE_ID}/interview`) {
    return { persona: { name: 'Priya Nair', role: 'Facilities manager' }, turns: [], facts: [], factsExpected: [], turnsLeft: 8, closed: false };
  }
  return [];
};

const serveFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const path = url.replace(/^.*\/api\/v1/, '');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  try {
    const answer = await serve(method, path, body);
    return new Response(JSON.stringify(answer ?? null), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    const failure = err as Refusal;
    return new Response(JSON.stringify({ message: failure.message, ...(failure.body ?? {}) }), {
      status: failure.status ?? 400,
      headers: { 'content-type': 'application/json' },
    });
  }
};

/** `request` as the real client answers it: the sentence, the status and the body. */
const serveRequest = async (method: string, path: string, body?: unknown) => {
  const response = await serveFetch(`/api/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    throw new ApiError(response.status, (data as { message?: string }).message ?? 'failed', undefined, data);
  }
  return data;
};

/* ------------------------------- the harness ------------------------------ */

let host: HTMLDivElement;
let root: Root;
let tokens = 0;

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const open = async (url: string) => {
  held = null;
  project = buildProject();
  window.history.replaceState(null, '', url);
  await act(async () => {
    root.render(
      <Layout>
        <WorkspacePage />
      </Layout>,
    );
  });
  await settle();
};
const press = async (id: string) => {
  const node = q(id) as HTMLButtonElement | null;
  expect(node, `no [data-testid="${id}"] to press`).not.toBeNull();
  await act(async () => {
    node!.click();
  });
  await settle();
};
const editor = () => host.querySelector('textarea[aria-label="Code"]') as HTMLTextAreaElement | null;
const type = async (text: string) => {
  expect(editor()).not.toBeNull();
  await act(async () => {
    fireEvent.change(editor()!, { target: { value: text } });
  });
};
const calls = (method: string, pattern: RegExp) => server.calls.filter((call) => call.method === method && pattern.test(call.path));
const DRAFT_KEY = `lsdlc_draft_${PHASE_ID}`;

beforeEach(() => {
  vi.clearAllMocks();
  server.shape = 'split';
  server.phaseKey = 'implementation';
  server.main = {};
  server.phaseStatus = 'in_progress';
  server.plan = { restores: [CODE], reseeds: [], protectedBy: [], dropsPendingProposal: false, refusal: null, retry: null };
  server.refuseNext = '';
  server.staleNext = false;
  server.resets = 0;
  server.planGate = null;
  server.postGate = null;
  server.failPhaseAfterReset = false;
  server.version = FIRST_VERSION;
  server.files = { [CODE]: DRAFT_ONE };
  server.calls = [];
  held = null;
  tokens += 1;
  window.localStorage.setItem(TOKEN_KEY, `learner-token-${tokens}`);
  rig.request.mockImplementation(serveRequest);
  resetRecords();
  vi.stubGlobal('fetch', vi.fn(serveFetch));
  project = buildProject();
  stubMatchMedia();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ========================= 1. where it is drawn ========================== */

describe('which tasks offer "Start this task over"', () => {
  const list = (over: Partial<PhaseTaskView> = {}) => [
    task({ key: 'main', order: 1, artefactType: 'code', ...over }),
    task({ key: 'concepts', order: 2, artefactType: 'quiz' }),
  ];

  it('an authored task, still open, does', () => {
    expect(resetOffered(list(), list()[0])).toBe(true);
    // A teacher's phase with one inherited task is an authored list too.
    const one = [task({ key: 'main', order: 1 })];
    expect(resetOffered(one, one[0])).toBe(true);
  });

  it('a TaskTrackr phase (one task, the empty key) never does', () => {
    const sole = [task({ key: '', order: 1 })];
    expect(resetOffered(sole, sole[0])).toBe(false);
  });

  it('a quiz, a passed task, a task awaiting sign-off and a locked phase do not', () => {
    expect(resetOffered(list(), list()[1])).toBe(false);
    const passed = list({ status: 'passed' });
    expect(resetOffered(passed, passed[0])).toBe(false);
    const reviewing = list({ awaitingSignOff: true });
    expect(resetOffered(reviewing, reviewing[0])).toBe(false);
    expect(resetOffered(list(), list()[0], 'locked')).toBe(false);
  });

  it('is drawn in the room an authored task is worked in', async () => {
    await open(`/workspace/${PHASE_ID}?task=main`);
    expect(q('task-reset-open')?.textContent).toContain('Start this task over');
  });

  it('is drawn in the phase room for a teacher phase whose one task is the inherited one', async () => {
    server.shape = 'main';
    server.phaseKey = 'implementation';
    await open(`/workspace/${PHASE_ID}`);
    expect(q('workspace-page')).not.toBeNull();
    expect(q('task-reset-open')).not.toBeNull();
  });

  it('is drawn in the backlog room for a teacher phase whose one task is the inherited story', async () => {
    server.shape = 'main';
    server.phaseKey = 'requirements';
    await open(`/workspace/${PHASE_ID}`);
    expect(q('requirements-workspace')).not.toBeNull();
    expect(q('task-reset-open')).not.toBeNull();
  });

  for (const [phaseKey, Page] of [
    ['maintenance', () => <ChangePage />],
    ['design', () => <DesignPage />],
  ] as const) {
    it(`is drawn in the ${phaseKey} room for its one inherited task, and a reset there adopts the version`, async () => {
      server.shape = 'main';
      server.phaseKey = phaseKey;
      server.plan = { restores: [ROOM_FILE[phaseKey]!], reseeds: [], protectedBy: [], dropsPendingProposal: false, refusal: null, retry: null };
      server.files = { [ROOM_FILE[phaseKey]!]: 'Written before the reset.' };
      held = null;
      project = buildProject();
      window.history.replaceState(null, '', `/workspace/${PHASE_ID}/${phaseKey === 'design' ? 'design' : 'change'}`);
      // The change room's "changed by the assistant" marks end with the reset.
      if (phaseKey === 'maintenance') recordChangeTouched(PHASE_ID, { notes: 'Written by the assistant.' });
      const Room = Page;
      await act(async () => root.render(<Room />));
      await settle();
      expect(q('task-reset-open')).not.toBeNull();
      await press('task-reset-open');
      await press('task-reset-confirm');
      if (phaseKey === 'maintenance') expect(readChangeTouched(PHASE_ID)).toEqual({});
      const post = calls('POST', /\/reset$/);
      expect(post).toHaveLength(1);
      expect(post[0].body).toEqual({ baseVersion: FIRST_VERSION });
      expect(server.resets).toBe(1);
      expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
      expect(q('task-reset-status')?.textContent).toContain('started over');
    });
  }

  it('is not drawn on TaskTrackr, and the room asks the reset routes nothing', async () => {
    server.shape = 'sole';
    server.phaseKey = 'implementation';
    await open(`/workspace/${PHASE_ID}`);
    expect(q('workspace-page')).not.toBeNull();
    expect(q('task-reset-open')).toBeNull();
    expect(server.calls.some((call) => call.path.includes('/reset'))).toBe(false);
  });

  it('is not drawn while an instructor views the learner, and comes back when the viewing stops', async () => {
    const list = [task({ key: 'main', order: 1, artefactType: 'code' }), task({ key: 'concepts', order: 2, artefactType: 'quiz' })];
    const Control = () => (
      <TaskResetControl phaseId={PHASE_ID} tasks={list} task={list[0]} prepare={async () => {}} baseVersion={() => FIRST_VERSION} onReset={() => {}} onConflict={() => {}} />
    );
    act(() => startViewAs({ learnerId: 'learner-one', learnerName: 'Ada Example' } as unknown as Parameters<typeof startViewAs>[0]));
    try {
      await act(async () => root.render(<Control />));
      expect(q('task-reset-open')).toBeNull();
      await act(async () => stopViewAs());
      expect(q('task-reset-open')).not.toBeNull();
    } finally {
      stopViewAs();
    }
  });

  it('is drawn as "Retry this task" on a passed task, and not on one a teacher is reviewing', async () => {
    server.main = { status: 'passed' };
    await open(`/workspace/${PHASE_ID}?task=main`);
    expect(q('task-reset-open')?.textContent).toBe('Retry this task');
    await act(async () => root.unmount());
    root = createRoot(host);
    server.main = { awaitingSignOff: true };
    await open(`/workspace/${PHASE_ID}?task=main`);
    expect(q('task-reset-open')).toBeNull();
  });
});

/* ======================== 2. the confirm is the plan ====================== */

describe('the confirm', () => {
  it('names what is restored, re-seeded and kept, and what is never touched', async () => {
    server.plan = {
      restores: [CODE],
      reseeds: ['tests/test_report.py'],
      // The plan is the API's answer, so the dialog draws whatever it names as
      // kept by another task, with that task's title.
      protectedBy: [{ path: 'src/models.py', siblingTitle: 'The data model' }],
      dropsPendingProposal: true,
      refusal: null,
      retry: null,
    };
    await open(`/workspace/${PHASE_ID}?task=main`);
    await press('task-reset-open');

    expect(calls('GET', /\/reset$/).map((call) => call.path)).toEqual([RESET_PATH('main')]);
    const dialog = q('task-reset-dialog') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(q('task-reset-restores')?.textContent).toContain(CODE);
    expect(q('task-reset-reseeds')?.textContent).toContain('tests/test_report.py');
    expect(q('task-reset-protected')?.textContent).toContain('src/models.py');
    expect(q('task-reset-protected')?.textContent).toContain('The data model');
    expect(q('task-reset-proposal')?.textContent).toBe(RESET_DROPS_PROPOSAL);
    expect(q('task-reset-keeps')?.textContent).toBe(RESET_KEEPS);
    // Nothing is written by asking.
    expect(calls('POST', /\/reset$/)).toHaveLength(0);
  });

  it('shows the one sentence a refused plan carries, and nothing to press', async () => {
    server.plan = {
      restores: [],
      reseeds: [],
      protectedBy: [],
      dropsPendingProposal: false,
      refusal: 'Your last submission is still being checked. Reset once its result is back.',
      retry: null,
    };
    await open(`/workspace/${PHASE_ID}?task=main`);
    await press('task-reset-open');

    expect(q('task-reset-refusal')?.textContent).toBe('Your last submission is still being checked. Reset once its result is back.');
    expect(q('task-reset-confirm')).toBeNull();
    expect(q('task-reset-keeps')).toBeNull();
  });
});

/* ============================ 3 + 4. the reset ============================ */

describe('starting the task over in the workspace', () => {
  it('saves what is typed first, then quotes the version that save left', async () => {
    await open(`/workspace/${PHASE_ID}?task=main`);
    await type('def report():\n    return "draft two"\n');
    await press('task-reset-open');
    await press('task-reset-confirm');

    const put = calls('PUT', /\/workspace$/);
    const post = calls('POST', /\/reset$/);
    expect(put).toHaveLength(1);
    expect(post).toHaveLength(1);
    // The flush went out before the reset, and the reset quoted its version.
    expect(server.calls.indexOf(put[0])).toBeLessThan(server.calls.indexOf(post[0]));
    expect(post[0].body).toEqual({ baseVersion: '2026-09-20T09:01:00.000Z' });
    expect(post[0].path).toBe(RESET_PATH('main'));
  });

  it('replaces the buffer, drops the local draft and says so', async () => {
    await open(`/workspace/${PHASE_ID}?task=main`);
    expect(editor()?.value).toBe(DRAFT_ONE);
    // A copy this browser kept of pre-reset bytes (an exit save that never
    // landed). Left behind, the next load would offer it back over the reset.
    rememberVersionedWorkspaceDraft(PHASE_ID, { [CODE]: 'Pre-reset words.' }, FIRST_VERSION, 'learner-one');
    expect(window.localStorage.getItem(DRAFT_KEY)).not.toBeNull();
    await press('task-reset-open');
    await press('task-reset-confirm');

    expect(server.resets).toBe(1);
    expect(q('task-reset-dialog')).toBeNull();
    // The server's copy is the starter again, and the room shows it.
    expect(editor()?.value).toBe(STARTER);
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(q('workspace-conflict')).toBeNull();
    expect(q('task-reset-status')?.textContent).toContain('started over');
    // The header row keeps its short form while More is closed.
    expect(q('phase-retry-note')?.textContent).toBe(RESET_NOTE);
    expect(q('phase-retry-note')?.closest('[data-testid="phase-more"]')).toBeNull();
    // Cut to one line on a crowded row, its words stay readable as its title.
    expect(q('phase-retry-note')?.getAttribute('title')).toBe(RESET_NOTE);
  });

  it('"Task started over" belongs to its task, and clears on a switch to another', async () => {
    server.shape = 'pair';
    await open(`/workspace/${PHASE_ID}?task=main`);
    await press('task-reset-open');
    await press('task-reset-confirm');
    expect(server.resets).toBe(1);
    expect(q('phase-retry-note')?.textContent).toBe(RESET_NOTE);
    expect(q('task-reset-status')?.textContent).toBe(RESET_DONE);

    // The learner moves to the other task of the same room.
    await act(async () => {
      window.history.pushState(null, '', `/workspace/${PHASE_ID}?task=second`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(q('task-reset-open')?.textContent).toBe('Start this task over');
    expect(q('phase-retry-note')).toBeNull();
    expect(q('task-reset-status')?.textContent).toBe('');
  });

  it('adopts the version the reset returned, so the next save is judged against it', async () => {
    await open(`/workspace/${PHASE_ID}?task=main`);
    await press('task-reset-open');
    await press('task-reset-confirm');
    const afterReset = server.version;

    await type('A fresh start.');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    await settle();

    const put = calls('PUT', /\/workspace$/);
    expect(put).toHaveLength(1);
    expect((put[0].body as { baseVersion?: string }).baseVersion).toBe(afterReset);
    expect(q('workspace-conflict')).toBeNull();
  });

  it('meets a newer save with the conflict handling: nothing reset, the newer copy shown', async () => {
    server.staleNext = true;
    await open(`/workspace/${PHASE_ID}?task=main`);
    await press('task-reset-open');
    await press('task-reset-confirm');

    expect(server.resets).toBe(0);
    expect(q('task-reset-dialog')).toBeNull();
    expect(q('task-reset-status')?.textContent).toContain('Nothing was reset');
    expect(q('phase-retry-note')?.textContent).toBe(RESET_STALE_NOTE);
    // The room read the phase again and shows the copy the other tab saved.
    expect(editor()?.value).toBe('Saved in another tab.');
  });

  it('shows a refusal as its one sentence, and writes nothing', async () => {
    server.refuseNext = 'This task has passed. Your teacher can reopen it.';
    await open(`/workspace/${PHASE_ID}?task=main`);
    await press('task-reset-open');
    await press('task-reset-confirm');

    expect(server.resets).toBe(0);
    expect(q('task-reset-error')?.textContent).toBe('This task has passed. Your teacher can reopen it.');
    expect(q('task-reset-error')?.getAttribute('role')).toBe('alert');
    expect(editor()?.value).toBe(DRAFT_ONE);
  });
});

/* ============ 3b. the document rooms quote their own flush's version ======== */

describe('unsaved work in a document room, then "Start over"', () => {
  for (const [phaseKey, draft] of [
    ['maintenance', '{"notes":"Typed, not yet saved."}\n'],
    ['design', '{"typed":"not yet saved"}'],
    ['requirements', 'As a facilities manager, typed and not yet saved.'],
  ] as const) {
    it(`${phaseKey}: the flush goes first and the reset quotes the version that flush left`, async () => {
      server.shape = 'main';
      server.phaseKey = phaseKey;
      const file = ROOM_FILE[phaseKey] ?? MY_STORY;
      server.plan = { restores: [file], reseeds: [], protectedBy: [], dropsPendingProposal: false, refusal: null, retry: null };
      server.files = { [file]: phaseKey === 'design' ? '{"saved":"before the reset"}' : 'Written before the reset.' };
      // Work typed against the copy the server holds, not yet saved: the
      // room restores it on load and would save it on its next debounce.
      rememberVersionedWorkspaceDraft(PHASE_ID, { [file]: draft }, FIRST_VERSION, 'learner-one');
      if (phaseKey === 'requirements') await open(`/workspace/${PHASE_ID}`);
      else {
        held = null;
        project = buildProject();
        window.history.replaceState(null, '', `/workspace/${PHASE_ID}/${phaseKey === 'design' ? 'design' : 'change'}`);
        const Room = phaseKey === 'design' ? DesignPage : ChangePage;
        await act(async () => root.render(<Room />));
        await settle();
      }
      await press('task-reset-open');
      await press('task-reset-confirm');

      const put = calls('PUT', /\/workspace$/);
      const post = calls('POST', /\/reset$/);
      expect(put).toHaveLength(1);
      expect(post).toHaveLength(1);
      expect(server.calls.indexOf(put[0])).toBeLessThan(server.calls.indexOf(post[0]));
      expect(post[0].body).toEqual({ baseVersion: '2026-09-20T09:01:00.000Z' });
      expect(server.resets).toBe(1);
      expect(q('task-reset-status')?.textContent).toContain('started over');
      // The draft that was restored is gone with the reset.
      expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    });
  }
});

describe('a reset whose reload fails', () => {
  it('the IDE: an edit of the copy still on screen is not saved over the starter', async () => {
    server.failPhaseAfterReset = true;
    await open(`/workspace/${PHASE_ID}?task=main`);
    await press('task-reset-open');
    await press('task-reset-confirm');
    expect(server.resets).toBe(1);
    expect(server.files[CODE]).toBeUndefined();

    // The reload failed, so the editor still shows the words from before the reset.
    await type(`${DRAFT_ONE}# And one more line.\n`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    await settle();
    expect(server.files[CODE]).toBeUndefined();
  });
});

/* ============================ 7. the dialog ============================== */

describe('the dialog, from the keyboard', () => {
  it('is a labelled modal that holds Tab, closes with Escape and gives focus back', async () => {
    await open(`/workspace/${PHASE_ID}?task=main`);
    const trigger = q('task-reset-open') as HTMLButtonElement;
    trigger.focus();
    await press('task-reset-open');

    const dialog = q('task-reset-dialog') as HTMLElement;
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const label = dialog.getAttribute('aria-labelledby');
    expect(label && document.getElementById(label)?.textContent).toContain('The overdue report');

    const cancel = q('task-reset-cancel') as HTMLButtonElement;
    const confirm = q('task-reset-confirm') as HTMLButtonElement;
    confirm.focus();
    await act(async () => {
      fireEvent.keyDown(confirm, { key: 'Tab' });
    });
    expect(document.activeElement).toBe(cancel);
    await act(async () => {
      fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    });
    expect(document.activeElement).toBe(confirm);

    await act(async () => {
      fireEvent.keyDown(confirm, { key: 'Escape' });
    });
    await settle();
    expect(q('task-reset-dialog')).toBeNull();
    expect(document.activeElement).toBe(q('task-reset-open'));
    expect(calls('POST', /\/reset$/)).toHaveLength(0);
  });

  it('a plan that answers after the dialog was closed does not open it again', async () => {
    let answer!: () => void;
    server.planGate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await open(`/workspace/${PHASE_ID}?task=main`);
    await press('task-reset-open');
    expect(q('task-reset-dialog')?.textContent).toContain('Checking what a reset would change');
    await press('task-reset-cancel');
    expect(q('task-reset-dialog')).toBeNull();

    answer();
    await settle();
    expect(q('task-reset-dialog')).toBeNull();
    expect(calls('POST', /\/reset$/)).toHaveLength(0);
  });

  it('Escape and the dialog\'s cancel do nothing while the reset is working', async () => {
    let answer!: () => void;
    server.postGate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await open(`/workspace/${PHASE_ID}?task=main`);
    await press('task-reset-open');
    await press('task-reset-confirm');
    const dialog = q('task-reset-dialog') as HTMLElement;
    expect(dialog).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
      fireEvent(dialog, new Event('cancel', { cancelable: true }));
    });
    await settle();
    expect(q('task-reset-dialog')).not.toBeNull();

    answer();
    await settle();
    expect(server.resets).toBe(1);
    expect(q('task-reset-dialog')).toBeNull();
    expect(q('task-reset-status')?.textContent).toContain('started over');
  });
});

/* ===================== 8. the document rooms' saver ====================== */

describe('the saver the document rooms share', () => {
  const savedDetail = (version: string, content: string): PhaseDetail =>
    ({ ...buildDetail(), workspaceUpdatedAt: version, files: [{ path: CODE, content, editable: true, language: 'markdown' }] }) as unknown as PhaseDetail;

  it('adopts a reset: the draft is dropped, the version moves, and the reloaded copy is no conflict', async () => {
    let hook: ReturnType<typeof useVersionedWorkspaceSave> | null = null;
    const Probe = ({ detail }: { detail: PhaseDetail }) => {
      hook = useVersionedWorkspaceSave(PHASE_ID, detail);
      return <p data-testid="probe">{hook.files[CODE]}</p>;
    };
    await act(async () => root.render(<Probe detail={savedDetail(FIRST_VERSION, 'Before.')} />));
    await settle();
    await act(async () => hook!.setFile(CODE, 'Typed, never saved.'));
    expect(window.localStorage.getItem(DRAFT_KEY)).not.toBeNull();

    // The room flushed and reset; the API answered a new version.
    const afterReset = '2026-09-20T09:05:00.000Z';
    await act(async () => (hook as unknown as { adoptReset: (version: string, paths: string[]) => void }).adoptReset(afterReset, [CODE]));
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(hook!.savedVersion).toBe(afterReset);
    expect(hook!.dirty).toBe(false);

    await act(async () => root.render(<Probe detail={savedDetail(afterReset, STARTER)} />));
    await settle();
    expect(q('probe')?.textContent).toBe(STARTER);
    expect(hook!.conflict).toBeNull();
    expect(hook!.saveError).toBe('');
  });

  it('reads the version at call time: after its own save, currentVersion() is the save\'s', async () => {
    let hook: ReturnType<typeof useVersionedWorkspaceSave> | null = null;
    const Probe = ({ detail }: { detail: PhaseDetail }) => {
      hook = useVersionedWorkspaceSave(PHASE_ID, detail);
      return null;
    };
    await act(async () => root.render(<Probe detail={savedDetail(FIRST_VERSION, 'Before.')} />));
    await settle();
    const read = (hook as unknown as { currentVersion: () => string | null }).currentVersion;
    await act(async () => hook!.setFile(CODE, 'Typed.'));
    await act(async () => hook!.flushSave());
    expect(server.version).toBe('2026-09-20T09:01:00.000Z');
    // The function taken before the save answers what the save left.
    expect(read()).toBe('2026-09-20T09:01:00.000Z');
  });

  it('holds an edit of the pre-reset copy until the reset copy has loaded, then asks for a comparison', async () => {
    let hook: ReturnType<typeof useVersionedWorkspaceSave> | null = null;
    const Probe = ({ detail }: { detail: PhaseDetail }) => {
      hook = useVersionedWorkspaceSave(PHASE_ID, detail);
      return <p data-testid="probe">{hook.files[CODE]}</p>;
    };
    await act(async () => root.render(<Probe detail={savedDetail(FIRST_VERSION, 'Before.')} />));
    await settle();
    const afterReset = '2026-09-20T09:05:00.000Z';
    server.version = afterReset;
    delete server.files[CODE];
    await act(async () => hook!.adoptReset(afterReset, [CODE]));
    // The reload failed: the room still shows 'Before.' and the learner edits it.
    await act(async () => hook!.setFile(CODE, 'Before. Edited after the reset.'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, WORKSPACE_SAVE_DELAY_MS + 100));
    });
    await settle();
    expect(calls('PUT', /\/workspace$/)).toHaveLength(0);
    expect(server.files[CODE]).toBeUndefined();
    expect(hook!.saveError).not.toBe('');

    // The reset copy arrives: the edit is not saved over it, it is compared.
    await act(async () => root.render(<Probe detail={savedDetail(afterReset, STARTER)} />));
    await settle();
    expect(hook!.conflict?.workspaceUpdatedAt).toBe(afterReset);
    expect(calls('PUT', /\/workspace$/)).toHaveLength(0);
  });
});

/* ======================= 9. the teacher's regrade trail =================== */

describe('a regrade of an earlier run, in the teacher’s trail', () => {
  const regrade = (detail: Record<string, unknown>): AuditEventView =>
    ({ id: 'a1', event: 'phase.regrade', actorName: 'Teacher', reason: 'new rubric', createdAt: '2026-09-20T10:00:00.000Z', detail: { phaseKey: 'design', from: 40, to: 80, ...detail } }) as unknown as AuditEventView;

  it('says the revision was of an earlier run and moved no gate', () => {
    const said = describeAudit(regrade({ run: 'of an earlier run, moved no gate' }));
    expect(said.title).toContain('of an earlier run, moved no gate');
    expect(said.state).not.toBe('pass');
  });

  it('reads as it always did for a revision of the current run', () => {
    const said = describeAudit(regrade({}));
    expect(said.title).not.toContain('earlier run');
    expect(said.state).toBe('pass');
  });
});

/* ==================== 10. retrying a passed task or phase ================== */

describe('"Retry this task" and "Retry this phase"', () => {
  const KEEPS = 'Your earlier pass, its date, your best score and every attempt stay in your history. This task counts as passed again once a new submission passes the same review.';
  const PHASE_KEEPS = 'Your earlier pass, its date, your best score and every attempt stay in your history. This phase counts as passed again once a new submission passes the same review.';
  const list = (over: Partial<PhaseTaskView> = {}) => [
    task({ key: 'main', order: 1, artefactType: 'code', status: 'passed', ...over }),
    task({ key: 'concepts', order: 2, artefactType: 'quiz', status: 'passed' }),
  ];

  it('is offered on a passed task and a passed TaskTrackr phase, never on a quiz, a task under review or a locked phase', () => {
    expect(retryOffered(list(), list()[0])).toBe(true);
    const sole = [task({ key: '', order: 1, status: 'passed' })];
    expect(retryOffered(sole, sole[0])).toBe(true);
    expect(retryOffered(list(), list()[1])).toBe(false);
    const reviewing = list({ awaitingSignOff: true });
    expect(retryOffered(reviewing, reviewing[0])).toBe(false);
    expect(retryOffered(list(), list()[0], 'locked')).toBe(false);
    const open = list({ status: 'in_progress' });
    expect(retryOffered(open, open[0])).toBe(false);
    // and a start-over is never offered where a retry is
    expect(resetOffered(list(), list()[0])).toBe(false);
  });

  it('names the task or the phase', () => {
    expect(retryLabel(list())).toBe('Retry this task');
    expect(retryLabel([task({ key: '', order: 1 })])).toBe('Retry this phase');
    expect(retryDone(false)).toBe('This task is open for a new attempt. Your earlier pass stays in your history.');
    expect(retryDone(true)).toBe('This phase is open for a new attempt. Your earlier pass stays in your history.');
  });

  it('on a passed task: the confirm is the API\'s retry plan, and the retry adopts the version', async () => {
    server.main = { status: 'passed' };
    server.plan = { restores: [CODE], reseeds: [], protectedBy: [], dropsPendingProposal: false, refusal: null, retry: { wholePhase: false, keeps: KEEPS } };
    await open(`/workspace/${PHASE_ID}?task=main`);
    expect(q('task-reset-open')?.textContent).toBe('Retry this task');
    await press('task-reset-open');

    expect(calls('GET', /\/reset$/).map((call) => call.path)).toEqual([RESET_PATH('main')]);
    expect(q('task-reset-dialog')?.querySelector('h2')?.textContent).toBe('Retry this task: The overdue report');
    expect(q('task-reset-restores')?.textContent).toContain(CODE);
    expect(q('task-reset-keeps')?.textContent).toBe(`${RETRY_REPLACES} ${KEEPS}`);
    expect(q('task-reset-confirm')?.textContent).toBe('Retry');

    await press('task-reset-confirm');
    const post = calls('POST', /\/reset$/);
    expect(post.map((call) => [call.path, call.body])).toEqual([[RESET_PATH('main'), { baseVersion: FIRST_VERSION }]]);
    expect(q('task-reset-status')?.textContent).toBe(retryDone(false));
    // the task is in progress again, so the control now offers the plain start-over
    expect(q('task-reset-open')?.textContent).toBe('Start this task over');
  });

  it('on a passed TaskTrackr phase: the phase-level routes, and the sentence stays once the control is gone', async () => {
    server.shape = 'sole';
    server.main = { status: 'passed' };
    server.phaseStatus = 'passed';
    server.plan = { restores: [CODE], reseeds: [], protectedBy: [], dropsPendingProposal: false, refusal: null, retry: { wholePhase: true, keeps: PHASE_KEEPS } };
    await open(`/workspace/${PHASE_ID}`);
    expect(q('task-reset-open')?.textContent).toBe('Retry this phase');
    await press('task-reset-open');
    expect(calls('GET', /\/reset$/).map((call) => call.path)).toEqual([PHASE_RESET_PATH]);
    expect(q('task-reset-keeps')?.textContent).toBe(`${RETRY_REPLACES} ${PHASE_KEEPS}`);

    await press('task-reset-confirm');
    expect(calls('POST', /\/reset$/).map((call) => call.path)).toEqual([PHASE_RESET_PATH]);
    expect(server.resets).toBe(1);
    // a TaskTrackr phase in progress offers no start-over, but the room still says what happened
    expect(q('task-reset-open')).toBeNull();
    // The region that stays is there empty first, then takes its words,
    // so a screen reader announces them.
    expect(q('task-reset-status')?.getAttribute('role')).toBe('status');
    expect(q('task-reset-status')?.textContent).toBe('');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, LATE_STATUS_MS + 20));
    });
    expect(q('task-reset-status')?.textContent).toBe(retryDone(true));
    expect(q('phase-retry-note')?.textContent).toBe(RETRY_NOTE);
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    // The button the confirm handed focus back to has gone, so focus comes to the sentence that stays,
    // not to the page's body.
    expect(document.activeElement).toBe(q('task-reset-status'));
  });

  const EARLIER_PASS = '2026-09-14T04:00:00.000Z';
  const HISTORY = 'Passed on 14 September. This is a new attempt; it counts again once a new submission passes the same review.';

  it('says when the task passed before, only while it is being retried', () => {
    expect(retryHistory(task({ key: 'main', order: 1, status: 'in_progress', passedAt: EARLIER_PASS }))).toBe(HISTORY);
    expect(retryHistory(task({ key: 'main', order: 1, status: 'submitted', passedAt: EARLIER_PASS }))).toBe(HISTORY);
    expect(retryHistory(task({ key: 'main', order: 1, status: 'passed', passedAt: EARLIER_PASS }))).toBeNull();
    expect(retryHistory(task({ key: 'main', order: 1, status: 'in_progress', passedAt: null }))).toBeNull();
    expect(retryHistory(undefined)).toBeNull();
  });

  it('after a reload, a task being retried still reads as passed before, beside its start-over', async () => {
    server.main = { status: 'in_progress', passedAt: EARLIER_PASS };
    await open(`/workspace/${PHASE_ID}?task=main`);
    expect(q('task-reset-open')?.textContent).toBe('Start this task over');
    expect(q('task-retry-history')?.textContent).toBe(HISTORY);
    expect(q('task-reset-status')?.textContent).toBe('');
    // On the header row, outside the closed More.
    expect(q('phase-retry-note')?.textContent).toBe('Passed before, new attempt');
    expect(q('phase-retry-note')?.closest('[data-testid="phase-more"]')).toBeNull();
  });

  it('after a reload, a TaskTrackr phase being retried still reads as passed before, with no control', async () => {
    server.shape = 'sole';
    server.main = { status: 'in_progress', passedAt: EARLIER_PASS };
    server.phaseStatus = 'in_progress';
    await open(`/workspace/${PHASE_ID}`);
    expect(q('task-reset-open')).toBeNull();
    expect(q('task-retry-history')?.textContent).toBe(HISTORY);
    expect(q('phase-retry-note')?.textContent).toBe(RETRY_NOTE);
  });

  it('a task never retried says nothing of an earlier pass', async () => {
    server.main = { status: 'in_progress', passedAt: null };
    await open(`/workspace/${PHASE_ID}?task=main`);
    expect(q('task-reset-open')?.textContent).toBe('Start this task over');
    expect(q('task-retry-history')).toBeNull();
    expect(q('phase-retry-note')).toBeNull();
  });

  it('the short form, by what the control said and the history line', () => {
    expect(resetNote('', null)).toBeNull();
    expect(resetNote(RESET_DONE, null)).toBe('Task started over');
    expect(resetNote(RESET_STALE, HISTORY)).toBe('Nothing was reset');
    expect(resetNote(retryDone(false), null)).toBe(RETRY_NOTE);
    expect(resetNote('', HISTORY)).toBe(RETRY_NOTE);
  });

  it('once the plan is in, the dialog is titled by it: a stale passed view whose plan is a start-over reads as a start-over', async () => {
    server.main = { status: 'passed' };
    server.plan = { restores: [CODE], reseeds: [], protectedBy: [], dropsPendingProposal: false, refusal: null, retry: null };
    await open(`/workspace/${PHASE_ID}?task=main`);
    expect(q('task-reset-open')?.textContent).toBe('Retry this task');
    await press('task-reset-open');
    expect(q('task-reset-dialog')?.querySelector('h2')?.textContent).toBe('Start this task over: The overdue report');
    expect(q('task-reset-confirm')?.textContent).toBe('Start over');
  });

  it('a retry the plan refuses shows its one sentence and nothing to press', async () => {
    server.main = { status: 'passed' };
    server.plan = {
      restores: [],
      reseeds: [],
      protectedBy: [],
      dropsPendingProposal: false,
      refusal: 'A run is still going. Retry once it finishes.',
      retry: { wholePhase: false, keeps: KEEPS },
    };
    await open(`/workspace/${PHASE_ID}?task=main`);
    await press('task-reset-open');
    expect(q('task-reset-refusal')?.textContent).toBe('A run is still going. Retry once it finishes.');
    expect(q('task-reset-confirm')).toBeNull();
    expect(q('task-reset-keeps')).toBeNull();
  });
});
