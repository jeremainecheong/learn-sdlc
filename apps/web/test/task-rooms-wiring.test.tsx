// @vitest-environment jsdom
/**
 * Every task row is a door: over the pages Next serves.
 *
 * A teacher copies the default project and adds a second **written** task to
 * Requirements: an authored user story with its own artefact, beside the
 * inherited one and a required quiz. The API grades it and the gate counts it,
 * so a learner must be able to open it. The room is bound to
 * `requirements/draft.md`, so a task list drawn without a way to move
 * between tasks would leave a **required** task with no door and a phase that
 * could never pass. What is asserted here is the path a learner walks, on the
 * routes Next serves them from:
 *
 *   /workspace/:id                       -> layout -> RequirementsWorkspace   (1)
 *   the row's own href                   -> layout -> the workspace, focused  (2)
 *   typing there                         -> PUT …/workspace, version quoted   (3)
 *   Submit there                         -> POST …/tasks/reminder-story/submit (4)
 *   the verdict drawn is that task's, refused first and passed after          (5)
 *   the quiz row                         -> layout -> the quiz room           (6)
 *   and every revision read is task-scoped, never the refused phase route     (7)
 *   the gate banner follows the phase, never one task, never an optional one  (8)
 *   Continue writes the buffer before it records, and refuses on a conflict   (9)
 *   and a phase with one task makes no task-scoped request at all            (10)
 *
 * `request` is the one seam stood in for, so the paths the real clients build
 * are what the cases read: a room that knocked somewhere the API does not
 * answer is red here rather than in a classroom.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseKey, PhaseTaskView, SubmissionView } from '@learnsdlc/shared';
import { DEFAULT_STORY_FLOOR } from '@learnsdlc/shared';
import { report, taskView } from './fixtures';

/* ------------------------------- the fixtures ----------------------------- */

const PHASE_ID = 'phase-requirements';
const MY_STORY = 'requirements/draft.md';
const AUTHORED = 'requirements/my-story-reminder-story.md';
const CODE = 'src/report.py';
/** The save stamp the room opens holding, and quotes back on its first write. */
const FIRST_VERSION = '2026-09-20T09:00:00.000Z';

const task = (over: Partial<PhaseTaskView> & { key: string; order: number }): PhaseTaskView =>
  taskView({ artefactType: 'user-story', ...over });

/** The state the whole file is about: the phase as the API would answer it. */
const server = {
  /**
   * Has a teacher split this phase? Everything below turns on it, because the
   * last block is the promise that a phase with one task asks nothing extra.
   */
  split: true,
  /** Which phase this is: the backlog's, or the IDE's. */
  phaseKey: 'requirements' as PhaseKey,
  /** Whether the phase's roll-up quantifies over the quiz. */
  quizRequired: true,
  mainPassed: false,
  /** The inherited story's last revision was marked without a pass: the API leaves its row `submitted`. */
  mainSubmitted: false,
  /** How the next hand-in of the inherited story is marked, in order. */
  mainMarks: [true] as boolean[],
  /** Every revision of the inherited story handed in during this case, oldest first. */
  mainHistory: [] as SubmissionView[],
  /**
   * The task list a moment behind the verdict: the authored story still reads
   * in progress after its Pass has landed, which is the list a room can hold.
   */
  listBehind: false,
  authoredPassed: false,
  quizPassed: false,
  phasePassed: false,
  /** How the next hand-in of the authored story is marked, in order. */
  authoredMarks: [true] as boolean[],
  /** How many hand-ins of the authored story the record holds. */
  authoredAttempts: 0,
  /** The next workspace save is refused as a lost update. */
  conflictNextSave: false,
  /**
   * The shell's per-phase summaries did not load, so the provider publishes an
   * enrolment with no `details`. `api.phaseSummaries` is caught to `[]`, so
   * this is an ordinary degraded load rather than a failure the learner sees.
   */
  summariesMissing: false,
  /**
   * The phase's newest revision as `PhaseDetail.lastSubmission` carries it,
   * whose it is and whether it is still being marked. Null is the default for
   * every case that does not set it.
   */
  newest: null as Pick<SubmissionView, 'taskKey' | 'status'> | null,
  /**
   * Hand every revision back still being marked, and
   * keep answering that it is, so a room is read inside its own marking window.
   */
  marking: false,
  /** The gate's own answer on a passed phase: the tasks passed on the board by credit alone. */
  evidenceNeeded: null as { key: string; title: string }[] | null,
  /** The stamp the saved workspace carries, moved by every write. */
  version: FIRST_VERSION,
  files: {} as Record<string, string>,
  calls: [] as { method: string; path: string; body?: unknown }[],
};

const requirementsPhase = () => server.phaseKey === 'requirements';

/**
 * What each task asks for and how it is marked: the full view's four heavy
 * fields, which the API sends and which the room has to be able to state.
 */
const INHERITED_BRIEF = 'Write US-4, the overdue report story.';
const AUTHORED_BRIEF = 'Write the reminder story for the manager who has to chase people.';
const AUTHORED_STEP = 'Say when the reminder fires.';
const AUTHORED_CRITERION = 'The reminder story names a trigger';
const PHASE_STEP = 'Work through the phase in order.';
const PHASE_CRITERION = 'The phase criterion';

const tasks = (): PhaseTaskView[] => {
  const main = task({
    key: 'main',
    order: 1,
    title: requirementsPhase() ? 'The user story' : 'The overdue report',
    artefactType: requirementsPhase() ? 'user-story' : 'code',
    artefactPath: requirementsPhase() ? MY_STORY : CODE,
    files: requirementsPhase() ? [MY_STORY, 'requirements/story.json'] : [CODE],
    primaryPath: requirementsPhase() ? MY_STORY : CODE,
    status: server.mainPassed ? 'passed' : server.mainSubmitted ? 'submitted' : 'in_progress',
    brief: INHERITED_BRIEF,
    objectives: ['Name the actor, the want and the why.'],
    rubric: { passThreshold: 70, criteria: [{ key: 'c-main', title: 'The inherited story is checkable', description: '', weight: 1 }] },
  });
  if (!server.split) return [main];
  return [
    main,
    task({
      key: 'reminder-story',
      order: 2,
      title: 'The reminder story',
      artefactPath: AUTHORED,
      files: [AUTHORED],
      primaryPath: AUTHORED,
      status: server.authoredPassed && !server.listBehind ? 'passed' : 'in_progress',
      attempts: server.authoredAttempts,
      brief: AUTHORED_BRIEF,
      objectives: ['Say who the reminder is for.', AUTHORED_STEP],
      rubric: { passThreshold: 70, criteria: [{ key: 'c-authored', title: AUTHORED_CRITERION, description: '', weight: 1 }] },
    }),
    task({
      key: 'story-concepts',
      order: 3,
      title: 'Story concepts',
      artefactType: 'quiz',
      evidence: 'automated',
      required: server.quizRequired,
      status: server.quizPassed ? 'passed' : 'in_progress',
    }),
  ];
};

/** The phase's own totals, counted the way the API counts them. */
const counts = () => {
  const list = tasks();
  const passed = (key: string) =>
    key === 'main' ? server.mainPassed : key === 'reminder-story' ? server.authoredPassed : server.quizPassed;
  const required = list.filter((row) => row.required);
  return {
    total: list.length,
    required: required.length,
    passed: list.filter((row) => passed(row.key)).length,
    passedRequired: required.filter((row) => passed(row.key)).length,
  };
};

const phaseFiles = () =>
  requirementsPhase()
    ? [
        { path: MY_STORY, content: server.files[MY_STORY] ?? '', editable: true, language: 'markdown' },
        { path: AUTHORED, content: server.files[AUTHORED] ?? '', editable: true, language: 'markdown' },
        { path: 'requirements/story.json', content: '{}', editable: true, language: 'json' },
      ]
    : [{ path: CODE, content: server.files[CODE] ?? '', editable: true, language: 'python' }];

let held: ReturnType<typeof buildDetail> | null = null;
const detail = () => (held ??= buildDetail());
const buildDetail = () => ({
  id: PHASE_ID,
  key: server.phaseKey,
  order: requirementsPhase() ? 1 : 3,
  title: requirementsPhase() ? 'Requirements' : 'Implementation',
  status: server.phasePassed ? 'passed' : 'in_progress',
  projectSlug: 'overdue-report',
  bestScore: null,
  attempts: 0,
  reflection: null,
  passedAt: null,
  workspaceUpdatedAt: server.version,
  files: phaseFiles(),
  // The Requirements room draws its form only for a phase with a story spec.
  ...(requirementsPhase() ? { story: { id: 'US-4', hints: {}, floor: DEFAULT_STORY_FLOOR, providedStories: [] } } : {}),
  tasks: tasks(),
  taskCounts: counts(),
  rubric: { passThreshold: 70, criteria: [{ key: 'c-phase', title: PHASE_CRITERION, description: '', weight: 1 }] },
  objectives: [PHASE_STEP],
  taskPanel: 'The phase brief.',
  links: [],
  canRun: false,
  canPreview: false,
  runLabel: 'Run tests',
  lastSubmission: server.newest,
  solution: { available: false, files: 0, readAt: null },
  ...(server.evidenceNeeded ? { evidenceNeeded: server.evidenceNeeded } : {}),
});

const summary = () => ({
  id: PHASE_ID,
  key: server.phaseKey,
  order: requirementsPhase() ? 1 : 3,
  title: requirementsPhase() ? 'Requirements' : 'Implementation',
  status: server.phasePassed ? 'passed' : 'in_progress',
  bestScore: null,
  attempts: 0,
  reflection: null,
  passedAt: null,
  taskCounts: detail().taskCounts,
});

/** What each task's review says, so a verdict drawn can be told from a sibling's. */
const SAID: Record<string, string> = {
  main: 'The inherited story names the actor, the want and the why.',
  'reminder-story': 'The reminder story names the actor, the want and the why.',
};

/** A revision handed back while it is still being marked. */
const running = (revision: SubmissionView): SubmissionView =>
  ({ ...revision, status: 'running', passed: null, score: null, report: null }) as unknown as SubmissionView;

const verdict = (taskKey: string, passed = true, attempt = 1): SubmissionView =>
  ({
    id: `revision-${taskKey}-${attempt}`,
    taskKey,
    status: 'completed',
    passed,
    score: passed ? 84 : 41,
    attempt,
    createdAt: `2026-09-20T10:0${attempt}:00.000Z`,
    // The verdict the API answers with, built from the suite's own fixture so
    // the panel is drawing the shape the product draws.
    report: report({
      overall: passed ? 84 : 41,
      passed,
      criteria: [
        {
          key: 'c1',
          title: 'Acceptance criteria are checkable',
          weight: 1,
          score: passed ? 84 : 41,
          evidence: [passed ? 'Three criteria, each a check.' : 'Two criteria read as opinions.'],
        },
      ],
      aiReview: {
        summary: SAID[taskKey] ?? `The ${taskKey} paper was marked.`,
        strengths: passed ? ['Every criterion is a check a test could run.'] : [],
        improvements: passed ? [] : ['Say what a test would read to know the criterion is met.'],
        processNote: '',
        provider: 'openai',
      },
    }),
  }) as unknown as SubmissionView;

/** Every revision the authored story has so far, oldest first. */
const authoredHistory = (): SubmissionView[] =>
  Array.from({ length: server.authoredAttempts }, (_, index) =>
    verdict('reminder-story', server.authoredPassed && index === server.authoredAttempts - 1, index + 1),
  );

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
// Two seams, one server behind both. `request` is what every client **outside**
// `@/lib/api` goes through (`workspaceApi`, the interview, the quiz, the record
// cache) and `api`'s own calls close over the module's private copy of it, so
// those leave as real `fetch`es. Both are answered by the same routing table
// below, so a path either of them builds is a path this file reads.
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'learner-one', role: 'LEARNER', displayName: 'Ada Example' }),
  getSession: () => ({ id: 'learner-one', role: 'LEARNER', displayName: 'Ada Example' }),
}));
/**
 * One object per state, not one per render: the provider hands the same
 * enrolment back until something moves, and a fresh one on every render would
 * re-run every effect that depends on it.
 */
let project: ReturnType<typeof buildProject>;
const buildProject = () => ({
  enrollment: {
    id: 'enrolment-one',
    projectTitle: 'Overdue Report — TaskTrackr',
    projectSlug: 'overdue-report',
    currentPhaseOrder: detail().order,
    completed: false,
    // A locked Maintenance after the room's phase, so the room is never the
    // project's last phase and its words are those of a phase with one after it.
    phases: [summary(), { id: 'later-phase', key: 'maintenance', order: 6, title: 'Maintenance', status: 'locked', bestScore: null, attempts: 0, reflection: null, passedAt: null }],
  },
  currentPhase: summary(),
  details: server.summariesMissing ? {} : { [PHASE_ID]: detail() },
  analytics: null,
  loading: false,
  error: '',
  reload: vi.fn(),
});
vi.mock('@/lib/useProject', async (original) => {
  const actual = await original<typeof import('@/lib/useProject')>();
  return {
    ...actual,
    useProject: () => project,
    useProjectMaybe: () => project,
    invalidateProject: vi.fn(),
  };
});
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/components/workspace/preload', () => ({
  preloadEditor: async () => {},
  loadedEditor: () => ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Code" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
// A panel with nothing in it: the phase panels are another block's rooms, and
// what this file needs from them is only that the workspace has one, because
// that is what makes the room read its history. Both keys, because the last
// block opens the IDE on a phase with one task.
vi.mock('@/components/workspace/panels', () => ({
  PHASE_PANELS: { requirements: { Brief: () => null }, implementation: { Brief: () => null } },
}));
vi.mock('@/components/workspace/panels/testing/useTesting', () => ({
  // `first` is read by the Testing room only, which the last block opens.
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
import { settle, stubMatchMedia } from './support/dom';

/* -------------------------------- the server ------------------------------ */

const REFUSED = `/phases/${PHASE_ID}/submissions`;

/** A stamp later than the one before it, so a save can be seen to move. */
const nextVersion = () =>
  new Date(Date.parse(server.version) + 60_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');

/**
 * One fake for every route these pages knock at, routed by path.
 *
 * The phase-wide revisions route is the one the API refuses on a **split**
 * phase, so it throws here exactly as the API answers it: a room that still
 * asks for it fails this file rather than quietly drawing an empty history. On
 * a phase with one task it is the route the API resolves, and it answers.
 */
const serve = async (method: string, path: string, body?: unknown): Promise<unknown> => {
  server.calls.push({ method, path, body });
  if (path === REFUSED && server.split) throw new Error('phase-has-several-tasks');
  if (method === 'GET' && path === `/phases/${PHASE_ID}`) return detail();
  if (method === 'GET' && path === REFUSED) return server.mainPassed ? [verdict('main')] : [];
  if (method === 'GET' && /\/tasks\/[^/]+\/submissions$/.test(path)) {
    const key = path.split('/tasks/')[1].replace('/submissions', '');
    if (key === 'main' && server.mainHistory.length > 0) return [...server.mainHistory].reverse();
    if (key === 'main' && server.mainPassed) return [verdict('main')];
    if (key === 'reminder-story') return authoredHistory();
    return [];
  }
  if (method === 'POST' && path === `/phases/${PHASE_ID}/tasks/main/submit`) {
    const passed = server.mainMarks.shift() ?? true;
    server.mainPassed = passed;
    server.mainSubmitted = !passed;
    const revision = verdict('main', passed, server.mainHistory.length + 1);
    if (server.marking) return running(revision);
    server.mainHistory.push(revision);
    held = null;
    return revision;
  }
  if (method === 'POST' && path === `/phases/${PHASE_ID}/tasks/reminder-story/submit`) {
    if (server.marking) return running(verdict('reminder-story', false, server.authoredAttempts + 1));
    const passed = server.authoredMarks.shift() ?? true;
    server.authoredAttempts += 1;
    server.authoredPassed = passed;
    held = null;
    return verdict('reminder-story', passed, server.authoredAttempts);
  }
  if (method === 'GET' && path.startsWith('/submissions/')) {
    const id = path.slice('/submissions/'.length).split('?')[0];
    const attempt = Number(id.split('-').at(-1)) || 1;
    if (server.marking) return running(verdict(id.startsWith('revision-main') ? 'main' : 'reminder-story', false, attempt));
    if (id.startsWith('revision-main')) return server.mainHistory.find((one) => one.id === id) ?? verdict('main');
    return verdict('reminder-story', server.authoredPassed, attempt);
  }
  if (method === 'PUT' && path === `/phases/${PHASE_ID}/workspace`) {
    if (server.conflictNextSave) {
      server.conflictNextSave = false;
      // The refusal the API gives a write whose base version is not the one it
      // holds: nothing is written and the stored stamp is named.
      const err = new Error('This workspace changed elsewhere.') as Error & { status: number; body: unknown };
      err.status = 409;
      err.body = { version: nextVersion() };
      throw err;
    }
    const sent = (body as { files?: Record<string, string> })?.files ?? {};
    Object.assign(server.files, sent);
    server.version = nextVersion();
    held = null;
    return { saved: true, version: server.version };
  }
  if (method === 'POST' && path === `/phases/${PHASE_ID}/reflect`) return { saved: true };
  if (method === 'POST' && path === `/phases/${PHASE_ID}/advance`) {
    return { ...buildProject().enrollment, completed: false };
  }
  // The quiz room's own door: this phase's paper, never started.
  if (method === 'GET' && /\/tasks\/[^/]+\/quiz$/.test(path)) {
    const key = path.split('/tasks/')[1].replace('/quiz', '');
    return {
      taskKey: key,
      title: 'Story concepts',
      brief: 'A few questions on what makes a story checkable.',
      required: server.quizRequired,
      status: server.quizPassed ? 'passed' : 'in_progress',
      drawn: 5,
      passMark: 70,
      attemptsUsed: 0,
      attemptsLeft: 3,
      cooldownSecondsLeft: null,
      bestScore: null,
      lastSubmissionId: null,
      paper: null,
    };
  }
  // The stakeholder interview, which the backlog's room opens with: empty, but
  // the shape the room reads.
  if (method === 'GET' && path === `/phases/${PHASE_ID}/interview`) {
    return {
      persona: { name: 'Maya', role: 'Operations lead' },
      turns: [],
      facts: [],
      factsExpected: [],
      turnsLeft: 8,
      closed: false,
    };
  }
  // Everything else a room reads on the way in (the run log, the mentor
  // thread) is a list. The one path this file is strict about is the refused
  // one above.
  return [];
};

/** The product's own `fetch`, answered by the server above. */
const serveFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const path = url.replace(/^.*\/api\/v1/, '');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  try {
    const answer = await serve(method, path, body);
    return new Response(JSON.stringify(answer ?? null), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    // The refusal the API really gives, in the shape the client reads it in:
    // the status the route answers with, and whatever facts the body carries.
    const failure = err as Error & { status?: number; body?: Record<string, unknown> };
    return new Response(
      JSON.stringify({ message: failure.message, code: failure.message, ...(failure.body ?? {}) }),
      { status: failure.status ?? 400, headers: { 'content-type': 'application/json' } },
    );
  }
};

/* ------------------------------- the harness ------------------------------ */

let host: HTMLDivElement;
let root: Root;
/**
 * A token of its own per case. The workspace page keeps the phase it last saw
 * in a module cache owned by the token that filled it, so a fresh token is how
 * one case's saved stamp is kept out of the next one's first render.
 */
let tokens = 0;

// The merge sheet is drawn on the document's body, so a control not in the room is looked for there.
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) ?? document.querySelector(`[data-testid="${id}"]`);
const href = (id: string) => q(id)?.getAttribute('href');

/**
 * Is this node **drawn**, or is it in the markup behind a `hidden` ancestor?
 *
 * `querySelector` matches inside `hidden`, so every assertion in this file that
 * reads an attribute off a node is green over a panel no learner can see. The
 * IDE keeps its brief in an `<aside hidden={!briefOpen}>` and `briefOpen`
 * defaults to false below 1440 CSS px, which is every laptop the product is
 * used on, so a door drawn inside it is a door that is not there. jsdom does
 * no layout, so the honest question it can answer is the one the attribute
 * asks: walk the ancestors and see whether anything has shut.
 */
const shown = (id: string): boolean => {
  const node = q(id) as HTMLElement | null;
  if (!node) return false;
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  }
  return true;
};

/** The viewport this case is about. The panel preferences read it directly. */
const widthIs = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
};
const paths = (predicate: (call: { method: string; path: string }) => boolean) =>
  server.calls.filter(predicate).map((call) => call.path);

/** Let whatever the last act started settle: a fetch, a poll, a re-render. */

/** The room Next serves for this URL: the layout decides which one it is. */
const open = async (url: string, page: ReactNode = <WorkspacePage />) => {
  held = null;
  project = buildProject();
  window.history.replaceState(null, '', url);
  await act(async () => {
    root.render(<Layout>{page}</Layout>);
  });
  // The rooms fetch their phase on mount; let the answers land.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** Type into the room's editor, which is where the buffer this file flushes lives. */
const type = async (text: string) => {
  const editor = host.querySelector('textarea[aria-label="Code"]') as HTMLTextAreaElement;
  expect(editor).not.toBeNull();
  await act(async () => {
    fireEvent.change(editor, { target: { value: text } });
  });
};

const press = async (id: string) => {
  await act(async () => {
    (q(id) as HTMLButtonElement).click();
  });
  await settle(6);
};

beforeEach(() => {
  vi.clearAllMocks();
  server.split = true;
  server.phaseKey = 'requirements';
  server.quizRequired = true;
  server.mainPassed = false;
  server.mainSubmitted = false;
  server.mainMarks = [true];
  server.mainHistory = [];
  server.listBehind = false;
  server.authoredPassed = false;
  server.quizPassed = false;
  server.phasePassed = false;
  server.authoredMarks = [true];
  server.authoredAttempts = 0;
  server.conflictNextSave = false;
  server.summariesMissing = false;
  server.newest = null;
  server.marking = false;
  server.evidenceNeeded = null;
  server.version = FIRST_VERSION;
  server.files = {};
  server.calls = [];
  held = null;
  tokens += 1;
  window.localStorage.setItem(TOKEN_KEY, `learner-token-${tokens}`);
  rig.request.mockImplementation(serve);
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

/* ===================== 1. the room the phase opens on ===================== */

describe('the room a three-task written phase opens on', () => {
  it('draws every task, without the learner opening anything', async () => {
    await open(`/workspace/${PHASE_ID}`);

    // The backlog.
    expect(q('requirements-workspace')).not.toBeNull();
    // And the phase's three tasks, in the room rather than inside the case
    // file: a learner whose phase has three tasks can see that it has three.
    expect(q('task-switcher')).not.toBeNull();
    expect(host.textContent).toContain('The user story');
    expect(host.textContent).toContain('The reminder story');
    expect(host.textContent).toContain('Story concepts');
  });

  it('is the room of the task that owns its artefact, and a door to the others', async () => {
    await open(`/workspace/${PHASE_ID}`);

    // This room writes `requirements/draft.md`, so the task that declares
    // it is the row the learner is on.
    expect(q('task-row-main')?.getAttribute('aria-current')).toBe('true');
    // A second written task (a version from before the markdown kind was
    // retired) opens the phase's record room, never an editor of its own.
    expect(href('task-open-reminder-story')).toBe(`/workspace/${PHASE_ID}/issue`);
    // And the quiz keeps its own room.
    expect(href('task-open-story-concepts')).toBe(`/workspace/${PHASE_ID}/quiz?task=story-concepts`);
  });

  it('says how far the required set has got, above the fold', async () => {
    server.mainPassed = true;
    await open(`/workspace/${PHASE_ID}`);

    expect(q('task-counts')?.textContent).toBe('1 of 3 required done');
  });
});

/* ================== 2. the room behind the row's own door ================= */

describe('the room the authored story is written in', () => {
  it('is the workspace, not the backlog, and it opens on that task’s artefact', async () => {
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);

    // The layout stands its swap down: this task is not the backlog's.
    expect(q('requirements-workspace')).toBeNull();
    const editor = host.querySelector('textarea[aria-label="Code"]');
    expect(editor).not.toBeNull();
    // The tab strip is seeded from the task's own files, so the artefact the
    // teacher authored is what is open.
    expect(host.textContent).toContain('my-story-reminder-story.md');
  });

  it('says which task it is on, and leads back to the room the other is in', async () => {
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);

    expect(q('task-choose-reminder-story')?.getAttribute('aria-current')).toBe('true');
    // The inherited story is written in the backlog, so its row is the way
    // back into it rather than a re-key this room could not honour.
    expect(href('task-open-main')).toBe(`/workspace/${PHASE_ID}/issue`);
  });

  /**
   * The room the door opens is decided by whether the URL names the backlog's
   * own task, and a layout that cannot read the task list must not answer
   * "yes" for every URL. `api.phaseSummaries` is caught to `[]`, so the
   * enrolment still resolves and the layout still finds the phase, with no
   * tasks on it: a learner following the reminder story's door would be
   * handed the backlog, bound to the inherited story's file, with the URL
   * still naming the task they asked for.
   */
  it('is not the backlog when the shell could not read the phase’s tasks', async () => {
    server.summariesMissing = true;
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);

    expect(q('requirements-workspace')).toBeNull();
    expect(q('workspace-page')).not.toBeNull();
    // And the room, which reads its own phase, opens on the task that was asked
    // for rather than on someone else's artefact.
    expect(host.textContent).toContain('my-story-reminder-story.md');
  });
});

/* =============== 2b. and the learner can see it, at their width ============ */

/**
 * A door inside a collapsed panel is not a door.
 *
 * The IDE keeps its brief in `<aside hidden={!briefOpen}>`, and `briefOpen`
 * defaults to false below 1440 CSS px (every ordinary laptop) and stays false
 * for anyone who has ever pressed Hide brief, because that preference is stored
 * per learner rather than per phase. So the room every authored written
 * task's door opens must not keep its task list, its `aria-current` row and
 * its `role=status` leave line in there. `querySelector` matches inside
 * `hidden`, so the cases above cannot tell a drawn panel from a buried one;
 * these can.
 */
describe('the task list at the width a learner has', () => {
  for (const width of [1280, 1366, 1439, 1512]) {
    it(`is drawn in the workspace at ${width}px, with the row it is on and the line that says why a door did not open`, async () => {
      widthIs(width);
      await open(`/workspace/${PHASE_ID}?task=reminder-story`);

      expect(shown('task-switcher')).toBe(true);
      expect(shown('task-choose-reminder-story')).toBe(true);
      expect(shown('task-open-main')).toBe(true);
      expect(shown('task-counts')).toBe(true);
      // Announced where it is drawn: a refused flush has to reach the learner
      // in the room, not in markup behind a collapsed aside.
      expect(shown('task-leave-error')).toBe(true);
    });

    it(`is drawn in the backlog and in the quiz room at ${width}px`, async () => {
      widthIs(width);
      await open(`/workspace/${PHASE_ID}`);
      expect(shown('task-switcher')).toBe(true);
      expect(shown('task-row-main')).toBe(true);

      await open(`/workspace/${PHASE_ID}/quiz?task=story-concepts`, <QuizPage />);
      expect(shown('task-switcher')).toBe(true);
      expect(shown('task-open-reminder-story')).toBe(true);
    });
  }

  it('is still nothing at all on a phase with one task, at any width', async () => {
    server.split = false;
    widthIs(1512);
    await open(`/workspace/${PHASE_ID}`);

    expect(q('task-switcher')).toBeNull();
  });
});

/* ============ 2c. what the room says this task asks for =================== */

/**
 * The room says what **this task** asks for, and how **this task** is marked.
 *
 * An authored task's brief, objectives and rubric come down on the phase
 * detail, and the learner's client must read them: otherwise the room opens
 * the right artefact and posts to the right route while telling the learner
 * the inherited task's instructions and listing the phase's criteria, which a
 * narrowed task rubric is not. A hand-in whose statement of work is
 * unreachable is a hand-in a learner is guessing at.
 */
describe('the statement of work the room draws', () => {
  it('is the selected task’s own brief, steps and criteria', async () => {
    widthIs(1512);
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);

    expect(shown('task-brief')).toBe(true);
    expect(q('task-brief')?.textContent).toContain('The reminder story');
    expect(q('task-brief')?.textContent).toContain(AUTHORED_BRIEF);
    expect(q('task-brief')?.textContent).toContain(AUTHORED_STEP);
    // Marked against this task's criteria, which a teacher may narrow from the
    // phase's, so the phase's are not what this hand-in is graded against.
    expect(q('grading-guide')?.textContent).toContain(AUTHORED_CRITERION);
    expect(q('grading-guide')?.textContent).not.toContain(PHASE_CRITERION);
    // And never the sibling's words.
    expect(host.textContent).not.toContain(INHERITED_BRIEF);
    expect(host.textContent).not.toContain(PHASE_STEP);
    // The phase room's own tool card reports on the sibling's artefact, so it
    // stands down for a task it is not about.
    expect(q('phase-brief')).toBeNull();
  });

  it('is drawn once where the brief is open as well', async () => {
    widthIs(1512);
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);

    expect(host.querySelectorAll('[data-testid="task-brief"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="grading-guide"]')).toHaveLength(1);
    expect(shown('task-brief')).toBe(true);
  });

  it('leaves the phase’s own task where it was: its guide is in the brief, shut', async () => {
    widthIs(1280);
    await open(`/workspace/${PHASE_ID}?task=not-a-task`);

    expect(q('grading-guide')?.textContent).toContain('How this phase is graded');
    expect((q('grading-guide') as HTMLDetailsElement).open).toBe(false);
    expect(shown('grading-guide')).toBe(false);
  });

  it('is the phase’s where the room is on the phase’s own task', async () => {
    // A `?task=` this phase does not declare falls back to where the work is,
    // which here is the inherited story: the task the backlog is built around
    // and the one whose statement of work is the phase's.
    widthIs(1512);
    await open(`/workspace/${PHASE_ID}?task=not-a-task`);

    expect(q('task-brief')).toBeNull();
    expect(q('grading-guide')?.textContent).toContain(PHASE_CRITERION);
    expect(q('grading-guide')?.textContent).toContain('How this phase is graded');
  });

  /** The step tiles of the task's "What to do": pass, warn or todo, by their fill. */
  const stepTiles = () =>
    Array.from(q('task-brief')?.querySelectorAll('ol > li span[aria-hidden]') ?? []).map((tile) =>
      tile.className.includes('bg-pass') ? 'pass' : tile.className.includes('bg-warn') ? 'warn' : 'todo',
    );

  it('a task passed by credit alone does not tick its steps as passed', async () => {
    server.phasePassed = true;
    server.mainPassed = true;
    server.authoredPassed = true;
    server.quizPassed = true;
    server.evidenceNeeded = [{ key: 'reminder-story', title: 'The reminder story' }];
    widthIs(1512);
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);
    expect(stepTiles()).toEqual(['warn', 'warn']);
  });

  it('a reviewed pass still ticks them', async () => {
    server.phasePassed = true;
    server.mainPassed = true;
    server.authoredPassed = true;
    server.quizPassed = true;
    widthIs(1512);
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);
    expect(stepTiles()).toEqual(['pass', 'pass']);
  });

  it('the reference Implementation room on a written task draws no empty block under its task list', async () => {
    server.phaseKey = 'implementation';
    widthIs(1512);
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);

    const aside = host.querySelector('[data-workspace-panel="brief"]');
    expect(aside?.textContent).toContain(AUTHORED_BRIEF);
    // The task's own brief and criteria are the statement here, so neither the
    // phase's brief nor the case file's fold is drawn, and nothing holds their
    // place: no padded block with nothing in it.
    expect(q('phase-brief')).toBeNull();
    expect(q('phase-mission')).toBeNull();
    expect([...(aside?.querySelectorAll('.phase-task-content') ?? [])].filter((block) => block.childElementCount === 0)).toHaveLength(0);
  });

  it('draws no task brief on a phase with one task', async () => {
    server.split = false;
    server.phaseKey = 'implementation';
    widthIs(1512);
    await open(`/workspace/${PHASE_ID}`);

    expect(q('task-brief')).toBeNull();
  });
});

/* =========== 2d. a link that names a task this phase does not have ======== */

/**
 * The notice says something about the page, so the page has to hold it.
 *
 * It must not send the learner to "the task list below". On a phase with one
 * task there is no list at all (`TaskPanel` draws nothing, which is the rule
 * the whole component turns on) and a stale bookmark or a phase a teacher
 * re-cut lands exactly there.
 */
describe('the notice for a task this phase does not have', () => {
  it('names the list where there is one', async () => {
    widthIs(1366);
    await open(`/workspace/${PHASE_ID}?task=not-a-task`);

    expect(shown('workspace-unknown-task')).toBe(true);
    expect(q('workspace-unknown-task')?.textContent).toContain('the task list below');
    // Which is on the page, and drawn, at the width the sentence is read at.
    expect(shown('task-switcher')).toBe(true);
  });

  it('promises no list on a phase with one task, where there is none', async () => {
    server.split = false;
    widthIs(1366);
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);

    expect(shown('workspace-unknown-task')).toBe(true);
    expect(q('task-switcher')).toBeNull();
    expect(q('workspace-unknown-task')?.textContent).not.toContain('task list below');
    // It still says what happened and where the learner is.
    expect(q('workspace-unknown-task')?.textContent).toContain('not part of this phase');
  });
});

/* ======================= 3. handing the task in =========================== */

describe('handing in the authored story', () => {
  it('sends the revision to that task’s own route, carrying what was typed', async () => {
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);

    const editor = host.querySelector('textarea[aria-label="Code"]') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(editor, {
        target: { value: 'As a manager, I want a reminder, so that nothing is missed.' },
      });
    });
    await act(async () => {
      (q('header-submit') as HTMLButtonElement).click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const posted = server.calls.filter((call) => call.method === 'POST');
    expect(posted).toHaveLength(1);
    expect(posted[0].path).toBe(`/phases/${PHASE_ID}/tasks/reminder-story/submit`);
    // What the learner typed reached the server before the revision did.
    expect(server.files[AUTHORED]).toContain('As a manager');
    // The verdict that came back is this task's, and the room holds it: what
    // it draws is the case below.
    expect(posted[0].body).toBeUndefined();
  });

  it('writes the buffer through the versioned save, quoting the stamp it holds', async () => {
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);
    await type('As a manager, I want a reminder, so that nothing is missed.');
    await press('header-submit');

    // One write, of this task's artefact and nothing else, against the version
    // the room opened holding: the guard that makes a second tab's save a
    // refusal rather than a silent overwrite.
    const writes = server.calls.filter((call) => call.method === 'PUT');
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`/phases/${PHASE_ID}/workspace`);
    expect(writes[0].body).toEqual({
      files: { [AUTHORED]: 'As a manager, I want a reminder, so that nothing is missed.' },
      baseVersion: FIRST_VERSION,
    });
    // And it was written before the revision was asked for, not after.
    const order = server.calls.map((call) => `${call.method} ${call.path}`);
    expect(order.indexOf(`PUT /phases/${PHASE_ID}/workspace`)).toBeLessThan(
      order.indexOf(`POST /phases/${PHASE_ID}/tasks/reminder-story/submit`),
    );
  });

  it('draws that task’s verdict, and not its sibling’s', async () => {
    // The inherited story has already passed, with a review of its own.
    server.mainPassed = true;
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);
    await type('As a manager, I want a reminder, so that nothing is missed.');
    await press('header-submit');

    expect(q('feedback-verdict')?.textContent).toContain('Pass');
    expect(host.textContent).toContain(SAID['reminder-story']);
    expect(host.textContent).not.toContain(SAID.main);
  });

  it('shows a refusal, then a pass, and only then is the task done', async () => {
    server.authoredMarks = [false, true];
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);

    await type('As a manager I want reminders.');
    await press('header-submit');
    expect(q('feedback-verdict')?.textContent).toContain('Needs revision');
    expect(host.textContent).toContain('Say what a test would read');
    // A refused revision leaves the row where it was, so the phase cannot pass,
    // and the row says which of the two open states it is in, in the words
    // the phase list uses.
    expect(q('task-choose-reminder-story')?.textContent).toContain('Needs revision');
    expect(q('gate-banner')).toBeNull();

    await type('As a manager, I want a reminder, so that nothing is missed.');
    await press('header-submit');
    expect(q('feedback-verdict')?.textContent).toContain('Pass');
    // The phase is still in progress (the row cannot tell a reviewed pass
    // from a teacher's sign-off until the phase has passed), so: Passed.
    expect(q('task-choose-reminder-story')?.textContent).toContain('Passed');
    expect(q('task-choose-reminder-story')?.textContent).not.toContain('Review passed');

    const posted = server.calls.filter((call) => call.method === 'POST');
    expect(posted.map((call) => call.path)).toEqual([
      `/phases/${PHASE_ID}/tasks/reminder-story/submit`,
      `/phases/${PHASE_ID}/tasks/reminder-story/submit`,
    ]);
  });
});

/* ========================= 4. the quiz's own room ========================= */

describe('the room behind the quiz row', () => {
  it('opens the quiz this row names, with the panel still in hand', async () => {
    await open(`/workspace/${PHASE_ID}/quiz?task=story-concepts`, <QuizPage />);

    expect(q('quiz-page')).not.toBeNull();
    // The room read this task's quiz, by its key.
    expect(paths((call) => call.path.endsWith('/quiz'))).toEqual([
      `/phases/${PHASE_ID}/tasks/story-concepts/quiz`,
    ]);
    expect(q('quiz-header')?.textContent).toContain('Story concepts');
    expect(q('quiz-start')).not.toBeNull();
    // No editor and no artefact: a paper is answered, not written.
    expect(host.querySelector('textarea[aria-label="Code"]')).toBeNull();
    // And the way back to each piece of work travels with the learner.
    expect(q('task-switcher')).not.toBeNull();
    expect(href('task-open-main')).toBe(`/workspace/${PHASE_ID}/issue`);
    expect(href('task-open-reminder-story')).toBe(`/workspace/${PHASE_ID}/issue`);
    expect(q('task-open-story-concepts')?.getAttribute('aria-current')).toBe('true');
  });
});

/* ============ 5. every revision read is the task's, never the phase's ===== */

describe('the revisions these rooms read', () => {
  it('never asks the route the API refuses for a split phase', async () => {
    await open(`/workspace/${PHASE_ID}`);
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);
    await open(`/workspace/${PHASE_ID}/quiz?task=story-concepts`, <QuizPage />);

    const asked = server.calls.filter((call) => call.path.endsWith('/submissions'));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((call) => call.path.includes('/tasks/'))).toBe(true);
    expect(server.calls.some((call) => call.path === REFUSED)).toBe(false);
  });

  it('reads one list per task, and keeps reading them after a revision lands', async () => {
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);
    // Every task of the phase, each under its own route.
    expect(paths((call) => call.path.endsWith('/submissions')).sort()).toEqual([
      `/phases/${PHASE_ID}/tasks/main/submissions`,
      `/phases/${PHASE_ID}/tasks/reminder-story/submissions`,
      `/phases/${PHASE_ID}/tasks/story-concepts/submissions`,
    ]);

    server.calls = [];
    await type('As a manager, I want a reminder, so that nothing is missed.');
    await press('header-submit');
    // The refresh after a verdict remembers the scope the phase was read
    // under, so it cannot fall back to the route the API refuses.
    expect(server.calls.some((call) => call.path === REFUSED)).toBe(false);
  });
});

/* ========================= 6. the gate is the phase's ==================== */

describe('the banner that hands the learner on', () => {
  it('stays away while a required task is still open', async () => {
    server.mainPassed = true;
    await open(`/workspace/${PHASE_ID}`);

    expect(q('gate-banner')).toBeNull();
  });

  it('stays away on two of three required, however far along they are', async () => {
    server.mainPassed = true;
    server.authoredPassed = true;
    await open(`/workspace/${PHASE_ID}`);

    expect(q('task-counts')?.textContent).toBe('2 of 3 required done');
    expect(q('gate-banner')).toBeNull();
    // Including in the room the third one is answered in.
    await open(`/workspace/${PHASE_ID}/quiz?task=story-concepts`, <QuizPage />);
    expect(q('gate-banner')).toBeNull();
  });

  it('arrives when the phase itself has passed, which is the required set', async () => {
    server.mainPassed = true;
    server.authoredPassed = true;
    server.phasePassed = true;
    await open(`/workspace/${PHASE_ID}`);

    expect(q('gate-banner')).not.toBeNull();
  });

  it('is never held back by an optional task nobody has opened', async () => {
    // The teacher marked the quiz optional, so the required set is the two
    // stories, and the phase passes with the paper untouched.
    server.quizRequired = false;
    server.mainPassed = true;
    server.authoredPassed = true;
    server.phasePassed = true;
    await open(`/workspace/${PHASE_ID}`);

    expect(q('gate-banner')).not.toBeNull();
    expect(q('task-counts')?.textContent).toBe('2 of 2 required done. Optional: 0 of 1 done');
    // The optional task is still shown and still scored; it just gates nothing.
    expect(q('task-open-story-concepts')?.textContent).toContain('Optional');
    expect(href('task-open-story-concepts')).toBe(`/workspace/${PHASE_ID}/quiz?task=story-concepts`);
  });
});

/* ===================== 7. what Continue settles first ==================== */

describe('continuing out of a passed phase', () => {
  const passedPhase = () => {
    server.mainPassed = true;
    server.authoredPassed = true;
    server.quizPassed = true;
    server.phasePassed = true;
  };

  it('writes the buffer before it records anything', async () => {
    passedPhase();
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);
    await type('As a manager, I want a reminder, so that nothing is missed.');
    server.calls = [];

    await press('open-reflection');
    await press('reflection-submit');

    const order = server.calls.map((call) => `${call.method} ${call.path}`);
    const written = order.indexOf(`PUT /phases/${PHASE_ID}/workspace`);
    expect(written).toBeGreaterThanOrEqual(0);
    expect(written).toBeLessThan(order.indexOf(`POST /phases/${PHASE_ID}/advance`));
    // The reflection box was left empty, and an empty box is no reflection:
    // nothing is posted for it.
    expect(order).not.toContain(`POST /phases/${PHASE_ID}/reflect`);
    expect(server.files[AUTHORED]).toContain('As a manager');
  });

  it('keeps the learner here when the save is refused, and records nothing', async () => {
    passedPhase();
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);
    await type('As a manager, I want a reminder, so that nothing is missed.');
    server.conflictNextSave = true;
    server.calls = [];

    await press('open-reflection');
    await press('reflection-submit');

    // The sheet says why, in the room's own sentence, rather than swallowing
    // the words or carrying the refusal out of the phase.
    expect(document.querySelector('[data-testid="reflection-modal"] [role="alert"]')?.textContent).toBe(
      'Your changes could not be saved. Try again before continuing.',
    );
    const order = server.calls.map((call) => `${call.method} ${call.path}`);
    expect(order).toContain(`PUT /phases/${PHASE_ID}/workspace`);
    expect(order).not.toContain(`POST /phases/${PHASE_ID}/reflect`);
    expect(order).not.toContain(`POST /phases/${PHASE_ID}/advance`);
    // Nothing was written, so the learner's words are still theirs to save.
    expect(server.files[AUTHORED]).toBeUndefined();
    expect(rig.router.push).not.toHaveBeenCalled();
  });
});

/* ============ 8. a phase with one task asks nothing task-scoped =========== */

describe('a TaskTrackr phase with one task', () => {
  it('draws no task chrome in the room it has always opened', async () => {
    server.split = false;
    await open(`/workspace/${PHASE_ID}`);

    expect(q('requirements-workspace')).not.toBeNull();
    expect(q('task-switcher')).toBeNull();
    expect(q('task-counts')).toBeNull();
    expect(server.calls.some((call) => call.path.includes('/tasks/'))).toBe(false);
  });

  it('makes the workspace ask for exactly what it always asked for', async () => {
    server.split = false;
    server.phaseKey = 'implementation';
    await open(`/workspace/${PHASE_ID}`);

    expect(q('workspace-page')).not.toBeNull();
    expect(q('task-switcher')).toBeNull();
    // The phase route resolves the phase's only task, so these are the
    // phase-wide reads (the phase, its revisions, its runs and the mentor
    // thread) and the task-scoped twins are not asked for at all. The whole
    // set is pinned, because the promise about a one-task phase is that **no**
    // task-scoped request is added to it.
    // `/analytics/me` is the mentor's usage counter, which the provider carries
    // in the product and which this fixture leaves the room to ask for; it is
    // the same request on a split phase.
    expect(server.calls.map((call) => `${call.method} ${call.path}`).sort()).toEqual([
      'GET /analytics/me',
      `GET /assistant/history/${PHASE_ID}`,
      `GET /phases/${PHASE_ID}`,
      // The phase layout asks whether a quick concept check is open.
      `GET /phases/${PHASE_ID}/concept-quizzes`,
      `GET /phases/${PHASE_ID}/runs`,
      `GET /phases/${PHASE_ID}/submissions`,
    ]);
  });

  /**
   * The IDE's arrival layout for a teacher's written task (the task's
   * statement drawn on arrival, its guide open) is for that task only. A
   * phase with one task draws the guide in the brief, shut, and nothing
   * beside the list, at a laptop's width and at a wide one.
   */
  for (const width of [1280, 1512]) {
    it(`draws the brief and the guide as it always did at ${width}px`, async () => {
      server.split = false;
      server.phaseKey = 'implementation';
      widthIs(width);
      await open(`/workspace/${PHASE_ID}`);

      expect(q('task-brief')).toBeNull();
      expect(host.querySelector('[data-workspace-panel="brief"]')?.hasAttribute('hidden')).toBe(width < 1440);
    });
  }

  it('keeps the phase’s own grading guide shut and inside the brief', async () => {
    server.split = false;
    server.phaseKey = 'implementation';
    widthIs(1512);
    await open(`/workspace/${PHASE_ID}`);

    // Implementation's brief draws its own task panel rather than the guide, so
    // the guide the room carries is the one in the hoisted brief tab: absent
    // from the aside here, and nowhere else either.
    expect(host.querySelector('details[open][data-testid="grading-guide"]')).toBeNull();
  });

  it('submits through the phase route, with no task named', async () => {
    server.split = false;
    server.phaseKey = 'implementation';
    await open(`/workspace/${PHASE_ID}`);
    await type('print("the overdue report")');
    await press('header-submit');

    const posted = server.calls.filter((call) => call.method === 'POST');
    expect(posted.map((call) => call.path)).toEqual([`/phases/${PHASE_ID}/submit`]);
  });
});

/* ======= 9. what a Pass on one task says comes next, where it lands ====== */

/**
 * Mounted: `passedLine` is only true where the room hands it the phase's
 * tasks and the revision's own task key. Each case goes red if either the IDE
 * or the backlog stops passing the list, or the panel stops passing the key,
 * which would show "Continue to the next phase when ready" on a Pass while a
 * required task is still open and no Continue exists.
 */
describe('what a Pass on one task says comes next, in the room it lands in', () => {
  const checksLine = () =>
    [...host.querySelectorAll('h3')]
      .find((heading) => heading.textContent === 'Checks')
      ?.parentElement?.querySelector('.purpose')?.textContent;

  it('names the required task still open in the workspace, and offers no Continue', async () => {
    server.mainPassed = true;
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);
    await type('As a manager, I want a reminder, so that nothing is missed.');
    await press('header-submit');

    const said = q('feedback-verdict')?.textContent ?? '';
    expect(said).toContain('Pass');
    expect(said).toContain(
      'One required task in this phase is still open: Story concepts. The next phase opens once it passes.',
    );
    expect(said).not.toContain('Continue to the next phase');
    expect(q('gate-banner')).toBeNull();
  });

  it('counts the task that just passed as passed, from a list a moment behind the verdict', async () => {
    server.mainPassed = true;
    server.listBehind = true;
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);
    await type('As a manager, I want a reminder, so that nothing is missed.');
    await press('header-submit');

    // The list the room holds still has the reminder story in progress. The
    // verdict is about that task, so it is not named as still open.
    const said = q('feedback-verdict')?.textContent ?? '';
    expect(said).toContain('One required task in this phase is still open: Story concepts.');
    expect(said).not.toContain('The reminder story');
  });

  it('names the required tasks still open in the backlog, and offers no Continue', async () => {
    await open(`/workspace/${PHASE_ID}/issue`);
    await press('phase-requirements-submit');

    const said = q('feedback-verdict')?.textContent ?? '';
    expect(said).toContain('Pass');
    expect(said).toContain(
      '2 required tasks in this phase are still open: The reminder story and Story concepts. The next phase opens once they pass.',
    );
    expect(said).not.toContain('Continue to the next phase');
    // In the room: nothing ran in a sandbox on a written phase, and the
    // check table's heading says what did happen.
    expect(checksLine()).toBe('What was checked on this submission.');
  });
});

/* ============ 10. the backlog's own story row, once a review lands ========= */

describe('the backlog’s own story row, once its review lands', () => {
  it('reads Needs revision on a story marked without a Pass, never In review (F-o)', async () => {
    server.mainMarks = [false];
    await open(`/workspace/${PHASE_ID}/issue`);
    await press('phase-requirements-submit');
    expect(q('feedback-verdict')?.textContent).toContain('Needs revision');

    // Back to the list, where the story's own row says where it stands. The
    // API leaves the task `submitted` after a failed verdict, and that status
    // must not read "IN REVIEW" here.
    const back = [...host.querySelectorAll('.jira-view-nav button')].find(
      (button) => button.textContent === 'Backlog',
    ) as HTMLButtonElement;
    await act(async () => back.click());
    expect(host.querySelector('.jira-own-story [data-testid="phase-requirements-story-status"]')?.textContent).toBe('Needs revision');
  });
});

/* ======= 11. the phase's own grading guide, on a phase a teacher split ===== */

describe('the phase’s own grading guide on a split phase', () => {
  it('says a Pass records the task while a required sibling is still open', async () => {
    // The IDE drawn on the phase's own task of a split phase: here by a link
    // naming a task the phase does not have, which falls back to it.
    widthIs(1512);
    await open(`/workspace/${PHASE_ID}?task=not-a-task`);

    const guide = q('grading-guide')?.textContent ?? '';
    expect(guide).toContain('How this phase is graded');
    expect(guide).toContain(
      'A Pass records this task. The phase opens the next one when every required task has passed.',
    );
    expect(guide).not.toContain('A Pass opens the next phase.');
  });
});

/* ===== 12. a TaskTrackr room whose brief holds the grading guide ========== */

/**
 * The cases in 8 are on Implementation, whose brief draws its own task panel
 * and no grading guide at all, so "shut and inside the brief" asserted on an
 * element that was not there. Testing (and Deployment) draw the guide in the
 * brief, so its `open` state is pinned where it exists.
 */
describe('a TaskTrackr testing phase with one task', () => {
  for (const width of [1280, 1512]) {
    it(`keeps the grading guide in the brief, shut, as it always was, at ${width}px`, async () => {
      server.split = false;
      server.phaseKey = 'testing';
      widthIs(width);
      await open(`/workspace/${PHASE_ID}`);

      const guide = q('grading-guide') as HTMLDetailsElement | null;
      expect(guide).not.toBeNull();
      expect(host.querySelectorAll('[data-testid="grading-guide"]')).toHaveLength(1);
      expect(guide!.closest('[data-workspace-panel="brief"]')).not.toBeNull();
      expect(guide!.hasAttribute('open')).toBe(false);
      expect(guide!.textContent).toContain('How this phase is graded');
      expect(guide!.textContent).toContain(
        'A Pass opens the next phase. You may save an optional reflection before continuing.',
      );
      expect(q('task-switcher')).toBeNull();
    });
  }
});

/* ====== 13. the task list says In review only while a revision is marked === */

/**
 * Through both rooms that draw the list for this phase. A task row the API
 * leaves `submitted` after a verdict without a pass must not read "In review"
 * in the panel; whether a revision really is being marked is on the phase detail
 * the room already holds (`lastSubmission`), and each room hands it over: the
 * backlog builds its own phase object for the panel, so it is the one that
 * could drop it.
 */
describe('the task list in a room, after a verdict and during one', () => {
  const rowText = (key: string): string =>
    (q(`task-row-${key}`) ?? q(`task-open-${key}`) ?? q(`task-choose-${key}`))?.textContent ?? '';

  for (const [room, url] of [
    ['the backlog', `/workspace/${PHASE_ID}`],
    ['the workspace', `/workspace/${PHASE_ID}?task=reminder-story`],
  ] as const) {
    it(`reads Needs revision on a marked story and In review on the one being marked, in ${room}`, async () => {
      server.mainSubmitted = true;
      server.authoredAttempts = 1;
      server.newest = { taskKey: 'reminder-story', status: 'running' };
      await open(url);

      expect(rowText('main')).toContain('Needs revision');
      expect(rowText('main')).not.toContain('In review');
      expect(rowText('reminder-story')).toContain('In review');
    });
  }

  /*
   * Neither room reloads its phase detail while its own revision is marked,
   * so a panel fed only the loaded detail would read a resubmission as
   * "Needs revision" for the whole marking window. The rows are read here
   * inside that window, after a submit made in the room.
   */
  it('reads In review on the backlog story row while its own resubmission is marked', async () => {
    server.mainSubmitted = true;
    server.mainHistory.push(verdict('main', false, 1));
    await open(`/workspace/${PHASE_ID}`);
    expect(rowText('main')).toContain('Needs revision');

    server.marking = true;
    await press('phase-requirements-submit');
    expect(rowText('main')).toContain('In review');
    expect(rowText('main')).not.toContain('Needs revision');
  });

  it('reads In review on the workspace row while its own resubmission is marked', async () => {
    server.authoredAttempts = 1;
    server.authoredPassed = false;
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);
    expect(rowText('reminder-story')).toContain('Needs revision');

    server.marking = true;
    await type('As a manager, I want a reminder, so that nothing is missed.');
    await press('header-submit');
    expect(rowText('reminder-story')).toContain('In review');
    expect(rowText('reminder-story')).not.toContain('Needs revision');
  });

  /*
   * Two tasks of a split phase may be marked at once
   * (one in-flight revision per task). The workspace follows every revision it
   * started, so the older one's row stays In review while the newer is marked.
   */
  it('keeps In review on a task the workspace is still following when a sibling is handed in', async () => {
    server.mainSubmitted = true;
    server.marking = true;
    server.newest = running(verdict('main', false, 1));
    await open(`/workspace/${PHASE_ID}?task=reminder-story`);
    expect(rowText('main')).toContain('In review');

    await type('As a manager, I want a reminder, so that nothing is missed.');
    await press('header-submit');
    expect(rowText('reminder-story')).toContain('In review');
    expect(rowText('main')).toContain('In review');
  });

  it('says nothing is in review once the newest revision has been marked', async () => {
    server.mainSubmitted = true;
    server.newest = { taskKey: 'main', status: 'completed' };
    await open(`/workspace/${PHASE_ID}`);

    expect(rowText('main')).toContain('Needs revision');
    expect(q('task-switcher')?.textContent).not.toContain('In review');
  });
});
