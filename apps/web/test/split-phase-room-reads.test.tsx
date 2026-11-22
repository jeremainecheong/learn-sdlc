// @vitest-environment jsdom
/**
 * The IDE room of a split phase: its read loop and its layout.
 *
 * The read loop: every answer to `GET /phases/:id` reaches the room as a
 * **new object**, even a 304 with the same body, because `request()` parses
 * JSON. If anything the mount effect depends on (such as a `flightKey`
 * callback over the task list) changes identity with each answer, the mount
 * effect reloads, the reload answers a new object, and the room re-reads the
 * phase hundreds of times a second for as long as it is open. A stand-in that
 * answers one cached object per state has exactly the identity the browser
 * never has, so it cannot see the loop. This file's server answers every read
 * the way the network does: a fresh parse of the same bytes.
 *
 * The layout: on a split phase the task list sits above the IDE row, in a
 * page that does not scroll. If the row is the only flexible track, the
 * editor is squeezed to a few pixels. jsdom does no layout, so what is
 * asserted here is the structure that gives the editor its floor (a scroll
 * region around the stack, and the floor on the row), and where the room
 * places that region on arrival over a measured 1280x800 geometry.
 *
 * `request` is the one seam stood in for, as in `task-rooms-wiring.test.tsx`,
 * so the paths the real clients build are what the cases count.
 */
import { act, type ReactNode } from 'react';
import { fireEvent } from '@testing-library/dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseKey, PhaseTaskView, SubmissionView } from '@learnsdlc/shared';
import { DEFAULT_STORY_FLOOR, STORY_JSON } from '@learnsdlc/shared';
import { report, taskView } from './fixtures';

const PHASE_ID = 'phase-split';
const MY_STORY = 'requirements/draft.md';
const AUTHORED = 'requirements/my-story-booking-story.md';
const CODE = 'src/report.py';
const VERSION = '2026-09-28T14:28:57.000Z';

const task = (over: Partial<PhaseTaskView> & { key: string; order: number }): PhaseTaskView =>
  taskView({ artefactType: 'user-story', ...over });

const server = {
  split: true,
  /**
   * The split phase carries the teacher's second written task. Off, the split
   * is the one work task plus a concept quiz, the shape an editor builds now.
   */
  authored: true,
  phaseKey: 'requirements' as PhaseKey,
  /** The phase's newest revision, as `PhaseDetail.lastSubmission` carries it. */
  newest: null as SubmissionView | null,
  /** The phase row, as the board has it. */
  phaseStatus: 'in_progress' as 'in_progress' | 'passed',
  /** What the strict-evidence gate would still refuse Continue over. */
  evidenceNeeded: undefined as { key: string; title: string }[] | undefined,
  /** How the next hand-in of the authored story is marked. */
  authoredPasses: true,
  /** The authored story was marked, not passed, with the rules all met. */
  authoredNeedsRevision: false,
  calls: [] as { method: string; path: string; body?: unknown }[],
};

const requirements = () => server.phaseKey === 'requirements';

const tasks = (): PhaseTaskView[] => {
  const main = task({
    key: 'main',
    order: 1,
    title: requirements() ? 'The user story' : 'The overdue report',
    artefactType: requirements() ? 'user-story' : 'code',
    artefactPath: requirements() ? MY_STORY : CODE,
    files: requirements() ? [MY_STORY, STORY_JSON] : [CODE],
    primaryPath: requirements() ? MY_STORY : CODE,
    required: !server.split || !server.authored,
  });
  if (!server.split) return [main];
  return [
    main,
    ...(server.authored ? [authoredTask()] : []),
    task({
      key: 'booking-quiz',
      order: 3,
      title: 'Booking concepts check',
      artefactType: 'quiz',
      evidence: 'automated',
      ...(server.authoredNeedsRevision ? { status: 'submitted' as const, attempts: 1, bestScore: 40 } : {}),
    }),
  ];
};

/** The teacher's second written task, in the older split this rig mostly serves. */
const authoredTask = (): PhaseTaskView =>
  task({
    key: 'booking-story',
    order: 2,
    title: 'Write the room-booking story',
    artefactPath: AUTHORED,
    files: [AUTHORED],
    primaryPath: AUTHORED,
    ...(server.authoredNeedsRevision ? { status: 'submitted' as const, attempts: 1, bestScore: 100 } : {}),
    brief: 'Write ONE user story for booking a room.',
    objectives: ['Name the role.', 'Cover a clash.'],
    rubric: { passThreshold: 70, criteria: [{ key: 'c-booking', title: 'The clash is refused', description: '', weight: 1 }] },
  });

const buildDetail = () => ({
  id: PHASE_ID,
  key: server.phaseKey,
  order: requirements() ? 1 : 3,
  title: requirements() ? 'Requirements' : 'Implementation',
  status: server.phaseStatus,
  projectSlug: 'room-desk',
  bestScore: null,
  attempts: 0,
  reflection: null,
  passedAt: null,
  workspaceUpdatedAt: VERSION,
  updatedAt: VERSION,
  files: requirements()
    ? [
        { path: MY_STORY, content: '', editable: true, language: 'markdown' },
        { path: AUTHORED, content: '', editable: true, language: 'markdown' },
        { path: STORY_JSON, content: '', editable: true, language: 'json' },
      ]
    : [{ path: CODE, content: 'def overdue():\n    pass\n', editable: true, language: 'python' }],
  // The Requirements room draws its backlog only for a phase with a story spec.
  ...(requirements() ? { story: { id: 'RD-1', hints: {}, floor: DEFAULT_STORY_FLOOR, providedStories: [] } } : {}),
  tasks: tasks(),
  taskCounts: { total: tasks().length, required: tasks().filter((t) => t.required).length, passed: 0, passedRequired: 0 },
  rubric: { passThreshold: 70, criteria: [{ key: 'c-phase', title: 'The phase criterion', description: '', weight: 1 }] },
  objectives: ['Work through the phase in order.'],
  taskPanel: 'The phase brief.',
  links: [],
  canRun: false,
  canPreview: false,
  runLabel: 'Run tests',
  lastSubmission: server.newest,
  solution: { available: false, files: 0, readAt: null },
  ...(server.evidenceNeeded ? { evidenceNeeded: server.evidenceNeeded } : {}),
});

/**
 * The bytes the network hands back, parsed afresh on every read: the one
 * property of a real response this file exists for. Two reads of an unchanged
 * phase are equal and never the same object.
 */
const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const summary = () => ({
  id: PHASE_ID,
  key: server.phaseKey,
  order: requirements() ? 1 : 3,
  title: requirements() ? 'Requirements' : 'Implementation',
  status: server.phaseStatus,
  bestScore: null,
  attempts: 0,
  reflection: null,
  passedAt: null,
});

const verdict = (taskKey: string, passed: boolean): SubmissionView =>
  ({
    id: `revision-${taskKey}`,
    taskKey,
    status: 'completed',
    passed,
    score: passed ? 84 : 41,
    attempt: 1,
    createdAt: '2026-09-28T14:30:00.000Z',
    report: report({
      overall: passed ? 84 : 41,
      passed,
      criteria: [{ key: 'c1', title: 'The clash is refused', weight: 1, score: passed ? 84 : 41, evidence: ['Named.'] }],
      aiReview: {
        summary: passed ? 'The booking story names the clash.' : 'The booking story never says what a clash is.',
        strengths: passed ? ['The clash is refused and explained.'] : [],
        improvements: passed ? [] : ['Say what happens when two bookings overlap.'],
        processNote: '',
        provider: 'openai',
      },
    }),
  }) as unknown as SubmissionView;

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
/** One object per state: the provider hands the same enrolment back until something moves. */
let project: ReturnType<typeof buildProject>;
const buildProject = () => ({
  enrollment: {
    id: 'enrolment-one',
    projectTitle: 'RoomDesk',
    projectSlug: 'room-desk',
    currentPhaseOrder: requirements() ? 1 : 3,
    completed: false,
    phases: [summary()],
  },
  currentPhase: summary(),
  details: { [PHASE_ID]: wire(buildDetail()) },
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
import QuizPage from '@/app/(app)/workspace/[phaseId]/quiz/page';
import { TOKEN_KEY } from '@/lib/session';
import { resetRecords } from '@/lib/records';
import { stubMatchMedia } from './support/dom';

const serve = async (method: string, path: string, body?: unknown): Promise<unknown> => {
  server.calls.push({ method, path, body });
  if (method === 'GET' && path === `/phases/${PHASE_ID}`) return wire(buildDetail());
  if (method === 'GET' && path.startsWith('/submissions/')) {
    return wire(server.newest ?? verdict('booking-story', false));
  }
  if (method === 'POST' && path === `/phases/${PHASE_ID}/tasks/booking-story/submit`) {
    // The strict, AI-reviewed pass the gate was waiting for: the task row
    // moves, and the gate's answer goes with it.
    const passed = server.authoredPasses;
    server.newest = verdict('booking-story', passed);
    if (passed) server.evidenceNeeded = undefined;
    return wire(server.newest);
  }
  if (method === 'POST' && path === `/phases/${PHASE_ID}/advance`) {
    if (server.evidenceNeeded) {
      const refusal = new Error('Submit this phase for a strict evidence review before advancing') as Error & { status: number };
      refusal.status = 400;
      throw refusal;
    }
    return { ...buildProject().enrollment, currentPhaseOrder: 2, phases: [summary(), { ...summary(), id: 'phase-next', key: 'design', order: 2, title: 'Design' }] };
  }
  if (method === 'GET' && path === `/phases/${PHASE_ID}/interview`) {
    return { persona: { name: 'Sam', role: 'Facilities' }, turns: [], facts: [], factsExpected: [], turnsLeft: 8, closed: false };
  }
  if (method === 'PUT' && path === `/phases/${PHASE_ID}/workspace`) return { saved: true, version: VERSION };
  if (method === 'GET' && /\/tasks\/[^/]+\/quiz$/.test(path)) {
    return {
      taskKey: 'booking-quiz',
      title: 'Booking concepts check',
      brief: 'A few questions on booking.',
      required: true,
      status: server.phaseStatus === 'passed' ? 'passed' : 'in_progress',
      drawn: 2,
      passMark: 50,
      attemptsUsed: 0,
      attemptsLeft: 2,
      cooldownSecondsLeft: null,
      bestScore: null,
      lastSubmissionId: null,
      paper: null,
    };
  }
  return [];
};

const serveFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const path = url.replace(/^.*\/api\/v1/, '');
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  try {
    const answer = await serve((init?.method ?? 'GET').toUpperCase(), path, body);
    return new Response(JSON.stringify(answer ?? null), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    const failure = err as Error & { status?: number };
    return new Response(JSON.stringify({ message: failure.message }), {
      status: failure.status ?? 400,
      headers: { 'content-type': 'application/json' },
    });
  }
};

let host: HTMLDivElement;
let root: Root;
let tokens = 0;

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const shown = (id: string): boolean => {
  const node = q(id);
  if (!node) return false;
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  }
  return true;
};
const widthIs = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
};
/** How many times the room has read its phase. */
const phaseReads = () =>
  server.calls.filter((call) => call.method === 'GET' && call.path === `/phases/${PHASE_ID}`).length;

/** Many rounds, so a loop that needs one fetch per turn has room to show itself. */
const settle = async (rounds = 40) => {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const open = async (url: string, page: ReactNode = <WorkspacePage />, seed = true) => {
  project = buildProject();
  // A tab opened on the room with no shell detail held for the phase: the
  // room's first render does not know the phase is split.
  if (!seed) project = { ...project, details: {} as typeof project.details };
  window.history.replaceState(null, '', url);
  await act(async () => {
    root.render(<Layout>{page}</Layout>);
  });
};

/** A browser reload of the tab: the page goes and comes back on the same URL. */
const reloadTab = async (url: string) => {
  await act(async () => root.unmount());
  root = createRoot(host);
  await open(url);
};

/** The tab coming back to the front, which the room answers with one read. */
const refocus = async () => {
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  server.split = true;
  server.authored = true;
  server.phaseKey = 'requirements';
  server.newest = null;
  server.phaseStatus = 'in_progress';
  server.evidenceNeeded = undefined;
  server.authoredPasses = true;
  server.authoredNeedsRevision = false;
  server.calls = [];
  tokens += 1;
  window.localStorage.setItem(TOKEN_KEY, `learner-token-${tokens}`);
  rig.request.mockImplementation(serve);
  resetRecords();
  vi.stubGlobal('fetch', vi.fn(serveFetch));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
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

/* =============================== the read loop ============================ */

describe('the room reads its phase once per reason, never in a loop', () => {
  const rooms: { name: string; url: string; split: boolean; phaseKey: PhaseKey }[] = [
    { name: 'a teacher’s written task on a split phase', url: `/workspace/${PHASE_ID}?task=booking-story`, split: true, phaseKey: 'requirements' },
    { name: 'the root of a split phase', url: `/workspace/${PHASE_ID}`, split: true, phaseKey: 'implementation' },
    { name: 'a phase with one task', url: `/workspace/${PHASE_ID}`, split: false, phaseKey: 'implementation' },
  ];

  for (const room of rooms) {
    it(`opens ${room.name} with one read, and stays at one while it sits there`, async () => {
      server.split = room.split;
      server.phaseKey = room.phaseKey;
      widthIs(1280);
      await open(room.url);
      await settle();
      expect(q('workspace-page')).not.toBeNull();
      const opened = phaseReads();
      expect(opened).toBe(1);

      // Idle: nothing the learner did, so nothing is read.
      await settle();
      expect(phaseReads()).toBe(opened);
    });

    it(`on ${room.name}, reads once per simulated reload and once per return to the tab`, async () => {
      server.split = room.split;
      server.phaseKey = room.phaseKey;
      widthIs(1280);
      await open(room.url);
      await settle();
      expect(phaseReads()).toBe(1);

      for (let n = 0; n < 3; n += 1) {
        await reloadTab(room.url);
        await settle();
      }
      // Three reloads: three more reads, each settling at one.
      expect(phaseReads()).toBe(4);

      for (let n = 0; n < 3; n += 1) {
        await refocus();
        await settle();
      }
      expect(phaseReads()).toBe(7);
    });
  }

  it('picks a revision still being marked back up once, and reads once more when its verdict lands', async () => {
    // A reload mid-review: the phase's newest revision is running.
    server.newest = { ...verdict('booking-story', false), status: 'running', passed: null, score: null, report: null } as unknown as SubmissionView;
    widthIs(1280);
    await open(`/workspace/${PHASE_ID}?task=booking-story`);
    await settle(80);
    // The mount read, the watch's poll of the revision, and the one read the
    // landed verdict asks for, and then nothing.
    const reads = phaseReads();
    expect(reads).toBeLessThanOrEqual(2);
    await settle(80);
    expect(phaseReads()).toBe(reads);
  });
});

describe('a split phase opened with no detail held follows a running revision once', () => {
  /** How many times the room has asked for one revision. */
  const revisionReads = () =>
    server.calls.filter((call) => call.method === 'GET' && call.path === '/submissions/revision-booking-story').length;

  it('mounts one watcher, not one per render in which the phase turned out to be split', async () => {
    // `split` flips from false to true after the first read, so the mount
    // effect runs again. The first run's watcher (in-flight key '') must be
    // the one dropped: otherwise two pollers follow one revision and the
    // landed verdict is reloaded twice.
    server.newest = { ...verdict('booking-story', false), status: 'running', passed: null, score: null, report: null } as unknown as SubmissionView;
    widthIs(1280);
    await open(`/workspace/${PHASE_ID}?task=booking-story`, <WorkspacePage />, false);
    await settle(20);
    expect(phaseReads()).toBe(1);
    expect(revisionReads()).toBe(1);
  });
});

/* ========================= the editor keeps its floor ===================== */

describe('the editor on a split phase has a floor', () => {
  for (const width of [1280, 1440, 1920]) {
    it(`puts the task list and the IDE row in one scroll region at ${width}px`, async () => {
      widthIs(width);
      await open(`/workspace/${PHASE_ID}?task=booking-story`);
      await settle(8);

      const region = q('workspace-room-scroll');
      expect(region).not.toBeNull();
      // The region is what scrolls, so a stack taller than the window pushes
      // the editor down rather than squeezing it to nothing.
      expect(region!.className).toContain('overflow-y-auto');
      // The class the stylesheet's ready-band rule reads, so the band beside the region is still one line.
      expect(region!.classList.contains('workspace-room-scroll')).toBe(true);
      expect(region!.contains(q('task-switcher'))).toBe(true);
      const row = host.querySelector('[data-active-pane]') as HTMLElement;
      expect(region!.contains(row)).toBe(true);
      // And the row carries the floor the stylesheet gives it.
      expect(row.classList.contains('workspace-room-floor')).toBe(true);
      // The editor is drawn, not behind anything collapsed.
      expect(shown('editor-host')).toBe(true);
      expect(host.querySelector('textarea[aria-label="Code"]')).not.toBeNull();
    });
  }

  it('draws a phase with one task with no scroll region and no floor', async () => {
    server.split = false;
    server.phaseKey = 'implementation';
    widthIs(1280);
    await open(`/workspace/${PHASE_ID}`);
    await settle(8);

    expect(q('workspace-room-scroll')).toBeNull();
    const row = host.querySelector('[data-active-pane]') as HTMLElement;
    expect(row.classList.contains('workspace-room-floor')).toBe(false);
    expect(shown('editor-host')).toBe(true);
  });

  /**
   * jsdom does no layout, so a measured 1280x800 geometry is laid on the
   * room's boxes (region 547 px tall at 227; the IDE row 547 px and the
   * editor 664 px into the stack), shifted by the region's own scroll as a
   * browser would.
   */
  const laptopLayout = () => {
    const box = (top: number, height: number, width = 1200): DOMRect =>
      ({ top, bottom: top + height, height, left: 0, right: width, width, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const region = host.querySelector<HTMLElement>('[data-testid="workspace-room-scroll"]');
      const shift = region && region !== this && region.contains(this) ? region.scrollTop : 0;
      const id = this.dataset.testid;
      if (id === 'workspace-room-scroll') return box(227, 547);
      if (id === 'editor-host') return box(227 + 664 - shift, 276, 800);
      if (this.hasAttribute('data-active-pane')) return box(227 + 547 - shift, 560);
      return box(0, 0, 0);
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'workspace-room-scroll' ? 547 : 0;
    });
  };

  /** The split an editor builds now: the code task and a concept quiz, opened on the code task. */
  const codeAndQuiz = async () => {
    server.phaseKey = 'implementation';
    server.authored = false;
    widthIs(1280);
    laptopLayout();
    await open(`/workspace/${PHASE_ID}?task=main`);
    await settle(8);
  };

  it('opens with the editor’s first lines on screen at 1280x800', async () => {
    await codeAndQuiz();
    const region = q('workspace-room-scroll')!;
    expect(region).not.toBeNull();
    // The least scroll that shows 160 px of the editor is 664 + 160 - 547 =
    // 277, well short of the IDE row (547), so the room stops there.
    expect(region.scrollTop).toBe(277);
    const editorTop = q('editor-host')!.getBoundingClientRect().top;
    expect(227 + 547 - editorTop).toBeGreaterThanOrEqual(160);
  });

  it('leaves the room where the learner put it once they have scrolled it', async () => {
    // jsdom has no ResizeObserver: this one is fired by hand, so a resize after the learner's scroll asks for a placement again.
    const resized: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resized.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    await codeAndQuiz();
    const region = q('workspace-room-scroll')!;
    // The arrival placed it first, so a region back at 0 is the learner's doing.
    expect(region.scrollTop).toBe(277);
    await act(async () => {
      region.dispatchEvent(new Event('wheel'));
      region.scrollTop = 0;
    });
    expect(resized.length).toBeGreaterThan(0);
    await act(async () => { for (const callback of resized) callback([], {} as ResizeObserver); });
    await settle(8);
    expect(region.scrollTop).toBe(0);
  });

  it('never scrolls the room to show a file tab: the strip moves sideways only', async () => {
    widthIs(1280);
    await open(`/workspace/${PHASE_ID}?task=booking-story`);
    await settle(8);
    const into = HTMLElement.prototype.scrollIntoView as unknown as { mock: { contexts: unknown[] } };
    const tabs = into.mock.contexts.filter(
      (node) => node instanceof HTMLElement && (node.dataset.testid ?? '').startsWith('file-tab-'),
    );
    expect(tabs).toEqual([]);
  });

  it('gives the floor a rule in the stylesheet the room loads', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(__dirname, '../components/workspace/phase-experience.css'), 'utf8');
    // At least the height the editor, its tabs and the bottom panel need
    // together. The row then takes the space the list leaves
    // (grows from a zero basis) rather than the whole region: a floor of the
    // region's own height would put the row's lower part (the console, the
    // preview) below the fold on arrival.
    const rule = css.match(/\.workspace-room-floor\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/min-height:\s*\d{3}px/);
    expect(rule).not.toMatch(/100%/);
    expect(rule).toMatch(/flex:\s*1\s+0\s+0%/);
  });
});

/* ================== the room of a phase passed on the board =============== */

/**
 * A teacher signed off a required task
 * that has no revision. The phase reads passed; the gate still wants a
 * reviewed pass of that task (`evidenceNeeded`). The room offers that task's
 * submit door and no Continue; the learner submits, the strict review passes,
 * the phase is read again without the field, and Continue then advances.
 */
describe('a phase a teacher signed off, in the room', () => {
  const signedOff = () => {
    server.phaseStatus = 'passed';
    server.evidenceNeeded = [{ key: 'booking-story', title: 'Write the room-booking story' }];
  };
  const press = async (id: string) => {
    await act(async () => {
      (q(id) as HTMLButtonElement).click();
    });
    await settle(12);
  };

  it('shows the submit door and no Continue, and the room can still submit', async () => {
    signedOff();
    widthIs(1280);
    await open(`/workspace/${PHASE_ID}?task=booking-story`);
    await settle(8);

    expect(q('gate-banner')?.getAttribute('data-gate')).toBe('evidence-needed');
    expect(shown('gate-evidence-needed')).toBe(true);
    expect(q('open-reflection')).toBeNull();
    expect(q('gate-evidence-submit-booking-story')?.getAttribute('href')).toBe(`/workspace/${PHASE_ID}/issue`);
    // The room's own Submit is live: the door leads somewhere work can go.
    expect((q('header-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('turns into Continue once the strict review of that task passes, and Continue advances', async () => {
    signedOff();
    widthIs(1280);
    await open(`/workspace/${PHASE_ID}?task=booking-story`);
    await settle(8);
    expect(q('open-reflection')).toBeNull();

    await act(async () => {
      fireEvent.change(host.querySelector('textarea[aria-label="Code"]')!, {
        target: { value: 'As a staff member, I want to book a room, so that my meeting has a place.' },
      });
    });
    await press('header-submit');
    await settle(20);

    expect(server.calls.some((call) => call.method === 'POST' && call.path === `/phases/${PHASE_ID}/tasks/booking-story/submit`)).toBe(true);
    expect(q('gate-banner')?.getAttribute('data-gate')).toBeNull();
    expect(q('gate-banner')?.textContent).toContain('Phase evidence accepted');
    await press('open-reflection');
    await act(async () => {
      (document.querySelector('[data-testid="reflection-submit"]') as HTMLButtonElement).click();
    });
    await settle(12);
    const advanced = server.calls.filter((call) => call.method === 'POST' && call.path === `/phases/${PHASE_ID}/advance`);
    expect(advanced).toHaveLength(1);
    // No reflection was typed, so none was posted.
    expect(server.calls.some((call) => call.path === `/phases/${PHASE_ID}/reflect`)).toBe(false);
    // Design's room, in one step.
    expect(rig.router.push).toHaveBeenCalledWith('/workspace/phase-next/design');
  });

  it('keeps the door, not Continue, while the review asks for a revision', async () => {
    signedOff();
    server.authoredPasses = false;
    widthIs(1280);
    await open(`/workspace/${PHASE_ID}?task=booking-story`);
    await settle(8);
    await act(async () => {
      fireEvent.change(host.querySelector('textarea[aria-label="Code"]')!, { target: { value: 'A story with no clash.' } });
    });
    await press('header-submit');
    await settle(20);
    expect(q('gate-banner')?.getAttribute('data-gate')).toBe('evidence-needed');
    expect(q('open-reflection')).toBeNull();
  });
});

/* ================== no "Best 100" beside "Needs revision" ================= */

describe('a written task that was marked and not passed', () => {
  it('reads Needs revision with no Best score, while a quiz keeps its best paper', async () => {
    server.authoredNeedsRevision = true;
    widthIs(1280);
    await open(`/workspace/${PHASE_ID}?task=booking-story`);
    await settle(8);

    const rows = [...host.querySelectorAll('[data-testid="task-switcher"] li')].map((li) => li.textContent ?? '');
    const story = rows.find((text) => text.includes('Write the room-booking story'))!;
    expect(story).toContain('Needs revision');
    // The rules' score is not a verdict: a "Best 100" beside it read as a pass.
    expect(story).not.toContain('Best');
    const quiz = rows.find((text) => text.includes('Booking concepts check'))!;
    // A paper's mark is the quiz's own measure, and it stays.
    expect(quiz).toContain('Best 40');
  });
});

/* ============= the backlog of a teacher's project names no one else ======== */

describe('the Requirements backlog of a teacher’s project', () => {
  it('heads the backlog with RoomDesk and opens the interview without naming Dana', async () => {
    widthIs(1512);
    await open(`/workspace/${PHASE_ID}/issue`);
    await settle(8);

    expect(q('requirements-workspace')).not.toBeNull();
    const heading = host.querySelector('.jira-backlog-heading small');
    expect(heading?.textContent).toBe('ROOMDESK PROJECT');
    // Every door to the interview in this room says what it is.
    const doors = [...host.querySelectorAll('a')].filter((a) => a.getAttribute('href')?.endsWith('/interview'));
    for (const door of doors) expect(door.textContent).not.toContain('Dana');
    expect(host.textContent).not.toContain('TASKTRACKR');
    expect(host.textContent).not.toContain('Meet Dana');
    expect(host.textContent).not.toContain('The missing morning report');
  });
});

/* ================ the quiz room of a passed phase says so too ============= */

describe('the quiz room of a passed phase', () => {
  it('draws the pass banner and Continue, as every other room of a passed phase does', async () => {
    server.phaseStatus = 'passed';
    widthIs(1280);
    await open(`/workspace/${PHASE_ID}/quiz?task=booking-quiz`, <QuizPage />);
    await settle(8);

    expect(q('quiz-page')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="gate-banner"]')).toHaveLength(1);
    expect(q('gate-banner')?.textContent).toContain('Phase evidence accepted');
    expect(q('open-reflection')).not.toBeNull();
  });

  it('offers the submit door, not Continue, where the gate still waits', async () => {
    server.phaseStatus = 'passed';
    server.evidenceNeeded = [{ key: 'booking-story', title: 'Write the room-booking story' }];
    widthIs(1280);
    await open(`/workspace/${PHASE_ID}/quiz?task=booking-quiz`, <QuizPage />);
    await settle(8);

    expect(q('open-reflection')).toBeNull();
    expect(q('gate-evidence-submit-booking-story')?.getAttribute('href')).toBe(`/workspace/${PHASE_ID}/issue`);
  });

  it('draws nothing of the kind while the phase is open', async () => {
    widthIs(1280);
    await open(`/workspace/${PHASE_ID}/quiz?task=booking-quiz`, <QuizPage />);
    await settle(8);
    expect(q('gate-banner')).toBeNull();
  });
});
