// @vitest-environment jsdom
/**
 * The learner rooms 3–6 render a teacher's own application. The Shelf fixture
 * (apps/api/test/fixtures/upload-packs/shelf, read only) is an uploaded pack:
 * its phases are the teacher's, and its provenance
 * says so: `application: null` on every application phase (the resolver's
 * "not the reference's application"), roll-up `own`.
 *
 * Every room is drawn from the pack's own phase.json and files, as the API
 * would serve them, and asked what a learner on Shelf reads:
 *
 * - Implementation seeds Shelf's own files and shows none of TaskTrackr's five
 *   tasks (TaskTrackr's brief is gated on the reference application);
 * - Testing's matrix lists Shelf's four planted bugs, and the criteria a test
 *   can be linked to are Shelf's own story ids;
 * - Deployment opens no file the pack does not ship and never names ci.yml,
 *   and its runbook is the record, in the Runbook tab;
 * - Maintenance demands no 2.1.0 release and names no design/contracts.json:
 *   the change room opens on the pack's own CHG-1;
 * - the bridge notice never says "TaskTrackr's application" for an own project;
 * - no rendered word or control in rooms 3–6 names TaskTrackr, complete_task,
 *   overdue, US-4, 2.1.0 or tasks.py;
 * - the App preview control is hidden for a non-reference application.
 */
import { REPO_ROOT } from './support/paths';
import { act, type ReactNode } from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { phaseMounts } from './support/pack-mounts';
import * as path from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNBOOK_OLDER_FORMAT_ROOM } from '@learnsdlc/shared';
import type { MutantRow, PhaseKey, PhaseProvenanceView, PhaseTaskView, SubmissionView } from '@learnsdlc/shared';
import { report } from './fixtures';

/* ------------------------------- the pack -------------------------------- */

const SHELF = path.join(REPO_ROOT, 'apps/api/test/fixtures/upload-packs/shelf');
const PHASE_DIR: Record<string, string> = {
  design: '02-design',
  implementation: '03-implementation',
  testing: '04-testing',
  deployment: '05-deployment',
  maintenance: '06-maintenance',
};
const ORDER: Record<string, number> = { design: 2, implementation: 3, testing: 4, deployment: 5, maintenance: 6 };
const ARTEFACT: Record<string, string> = { design: 'design', implementation: 'code', testing: 'tests', deployment: 'config', maintenance: 'code' };

interface PackPhase {
  key: string;
  title: string;
  intro: string;
  artifactKind: string;
  canRun?: boolean;
  runLabel?: string;
  taskPanel: string;
  objectives: string[];
  rubric: { passThreshold: number; criteria: { key: string; title: string; weight: number; description: string }[] };
  checks: {
    runbook?: { floor: { minEnvironment: number; minHealth: number; minRollback: number; minData: number; requireIncident: boolean } };
    drill?: unknown;
    ticket?: { id: string; title: string; summary: string; acceptance: { id: string; line: string }[] };
    change?: { contract: boolean; floor: { minImpact: number; minContract: number; minTests: number; requireRelease: boolean; traceEveryAcceptance: boolean } };
  };
}

function loadPhase(key: string) {
  const dir = path.join(SHELF, 'phases', PHASE_DIR[key]);
  const phase = JSON.parse(readFileSync(path.join(dir, 'phase.json'), 'utf8')) as PackPhase;
  // the folder layout (spec 7.1): the mounts are the phase folder's files/ and readonly/, every brief is inline
  return { phase, files: phaseMounts(dir), taskPanel: phase.taskPanel };
}

/** The Shelf fixture's planted bugs, read from the pack's own mutants directory. */
const SHELF_MUTANTS: MutantRow[] = readdirSync(path.join(SHELF, 'phases/04-testing/mutants'))
  .sort()
  .map((name) => JSON.parse(readFileSync(path.join(SHELF, 'phases/04-testing/mutants', name, 'meta.json'), 'utf8')) as {
    name: string;
    description: string;
    covers?: string;
  })
  .map((meta) => ({
    mutant: meta.name,
    description: meta.description,
    killed: false,
    ...(meta.covers ? { covers: meta.covers } : {}),
    cases: [{ name: 'test_lend_refuses_a_book_on_loan', status: 'passed' as const }],
  }));

/** The words no learner on Shelf may read anywhere in rooms 3–6. */
const FORBIDDEN = [/tasktrackr/i, /complete_task/i, /overdue/i, /US-4/, /2\.1\.0/, /tasks\.py/i];
/* ------------------------------ the scenario ----------------------------- */

const scenario = {
  key: 'implementation' as PhaseKey,
  /** As if the pack declared a preview block; the Shelf fixture has none. */
  canPreview: false,
  lastSubmission: null as SubmissionView | null,
  /** The learner has been paged: the drill's own red is in. */
  paged: false,
  /** The drill is resolved and written up. */
  resolved: false,
  /** The Shelf fixture's deployment without its runbook record, as an older pinned version serves it (built in this spec; the fixture is untouched). */
  noRunbook: false,
  /** The maintenance detail carries CHG-1, as the pack's phase spec does; off, it is an older pinned version with no change request. */
  change: true,
};
const PHASE_ID = 'phase-room';
const VERSION = '2026-09-28T14:28:57.000Z';
const NOW = new Date('2026-10-01T09:00:00.000Z');

/** What the API's provenance resolver says of an uploaded pack's application phase. */
const provenance = (key: string): PhaseProvenanceView =>
  ({
    phaseKey: key as PhaseKey,
    referenceName: 'TaskTrackr',
    rollup: 'own',
    intro: 'own',
    interview: null,
    files: [],
    tasks: [{ taskKey: '', provenance: 'edited', titleEdited: false }],
    roomTask: 'other',
    application: null,
  }) as PhaseProvenanceView;

const buildDetail = () => {
  const { phase, files: shipped, taskPanel } = loadPhase(scenario.key);
  const older = (scenario.key === 'deployment' && scenario.noRunbook) || (scenario.key === 'maintenance' && !scenario.change);
  const files = older ? shipped.filter((file) => file.path !== 'deployment/runbook.json' && file.path !== 'maintenance/change-request.json') : shipped;
  const { runbook, drill, ticket, change } = phase.checks;
  const primary = files.find((file) => file.editable)?.path;
  const task = {
    key: '',
    order: 1,
    required: true,
    title: phase.title,
    artefactType: ARTEFACT[scenario.key],
    evidence: 'automated',
    sealed: true,
    status: 'in_progress',
    awaitingSignOff: false,
    attempts: scenario.lastSubmission ? 1 : 0,
    bestScore: null,
    passedAt: null,
    lastSubmissionId: scenario.lastSubmission?.id ?? null,
    resetAt: null,
    solution: { available: false, files: 0, readAt: null },
    ...(primary ? { primaryPath: primary, artefactPath: primary } : {}),
  } as unknown as PhaseTaskView;
  return {
    id: PHASE_ID,
    key: scenario.key,
    order: ORDER[scenario.key],
    title: phase.title,
    intro: phase.intro,
    status: 'in_progress',
    projectSlug: 'shelf',
    artifactKind: phase.artifactKind,
    // the records as the API reads them off the phase spec (`PhaseDetail.runbook` and `.change`)
    ...(runbook && !older ? { runbook: { floor: runbook.floor, drill: Boolean(drill) } } : {}),
    ...(ticket && change && !older ? { change: { ticket, contract: change.contract, floor: change.floor } } : {}),
    bestScore: null,
    attempts: scenario.lastSubmission ? 1 : 0,
    reflection: null,
    passedAt: null,
    workspaceUpdatedAt: VERSION,
    updatedAt: VERSION,
    files,
    tasks: [task],
    taskCounts: { total: 1, required: 1, passed: 0, passedRequired: 0 },
    rubric: phase.rubric,
    objectives: phase.objectives,
    taskPanel,
    links: [],
    drill: scenario.paged
      ? {
          fault: 'port-zero',
          pagedAt: '2026-10-01T08:58:00.000Z',
          // a phase with the runbook record keeps no runbook text at paging
          runbookBefore: null,
          pagedExit: 1,
          healthRanAt: scenario.resolved ? '2026-10-01T08:59:00.000Z' : null,
          healthExit: scenario.resolved ? 0 : null,
          fixAppliedAt: scenario.resolved ? '2026-10-01T08:59:00.000Z' : null,
          resolvedAt: scenario.resolved ? '2026-10-01T08:59:30.000Z' : null,
          incident: null,
        }
      : null,
    runClock: null,
    canRun: Boolean(phase.canRun),
    canPreview: scenario.canPreview,
    runLabel: phase.runLabel ?? 'Run tests',
    lastSubmission: scenario.lastSubmission,
    solution: { available: false, files: 0, readAt: null },
    provenance: provenance(scenario.key),
    stakeholder: null,
    opensAt: null,
    dueAt: null,
  };
};

const summary = () => ({
  id: PHASE_ID,
  key: scenario.key,
  order: ORDER[scenario.key],
  title: scenario.key[0].toUpperCase() + scenario.key.slice(1),
  status: 'in_progress',
  bestScore: null,
  attempts: 0,
  reflection: null,
  passedAt: null,
  opensAt: null,
  dueAt: null,
  scenario: 'own',
  intro: loadPhase(scenario.key).phase.intro,
});

const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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
    projectTitle: 'Shelf — a small library you can run',
    projectSlug: 'shelf',
    projectIsDefault: false,
    currentPhaseOrder: ORDER[scenario.key],
    completed: false,
    phases: [summary()],
    releases: [],
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
vi.mock('@/components/workspace/usePreview', () => ({
  usePreview: () => ({ status: 'idle', console: [], errors: 0, stop: vi.fn(), start: vi.fn() }),
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
import ChangeRequestPage from '@/app/(app)/workspace/[phaseId]/change/page';
import DesignPage from '@/app/(app)/workspace/[phaseId]/design/page';
import MatrixPage from '@/app/(app)/workspace/[phaseId]/matrix/page';
import DrillPage from '@/app/(app)/workspace/[phaseId]/drill/page';
import PullRequestPage from '@/app/(app)/workspace/[phaseId]/pr/page';
import BriefPage from '@/app/(app)/workspace/[phaseId]/brief/page';
import { collectCriteria } from '@/components/workspace/panels/testing/lib';
import { TOKEN_KEY } from '@/lib/session';
import { resetRecords } from '@/lib/records';
import { stubMatchMedia } from './support/dom';

const serve = async (method: string, apiPath: string): Promise<unknown> => {
  if (method === 'GET' && apiPath === `/phases/${PHASE_ID}`) return wire(buildDetail());
  if (method === 'GET' && apiPath.startsWith('/submissions/') && scenario.lastSubmission) return wire(scenario.lastSubmission);
  if (method === 'GET' && apiPath === `/phases/${PHASE_ID}/submissions`) return scenario.lastSubmission ? [wire(scenario.lastSubmission)] : [];
  if (method === 'PUT' && apiPath === `/phases/${PHASE_ID}/workspace`) return { saved: true, version: VERSION };
  return [];
};
const serveFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const apiPath = url.replace(/^.*\/api\/v1/, '').replace(/\?.*$/, '');
  const answer = await serve((init?.method ?? 'GET').toUpperCase(), apiPath);
  return new Response(JSON.stringify(answer ?? null), { status: 200, headers: { 'content-type': 'application/json' } });
};

let host: HTMLDivElement;
let root: Root;
let tokens = 0;

const settle = async (rounds = 30) => {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const open = async (url: string, page: ReactNode) => {
  project = buildProject();
  window.history.replaceState(null, '', url);
  await act(async () => {
    root.render(<Layout>{page}</Layout>);
  });
  await settle();
};

const norm = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
const q = (selector: string) => host.querySelector(selector);
const pageText = () => norm(host.textContent);
const controlLabels = () =>
  [...host.querySelectorAll('button, a[href]')].map((el) => el.getAttribute('aria-label') || norm(el.textContent));

/** Every word a learner reads: text, and each control's label, title and placeholder. */
function everythingRead(): string {
  const attrs = [...host.querySelectorAll('[aria-label], [title], [placeholder], option')].map((el) =>
    [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('placeholder'), el.tagName === 'OPTION' ? el.textContent : '']
      .filter(Boolean)
      .join(' '),
  );
  return `${pageText()}\n${attrs.join('\n')}`;
}

function expectNoReferenceWords(where: string) {
  const read = everythingRead();
  for (const word of FORBIDDEN) {
    const hit = word.exec(read);
    expect(hit ? `${where}: "${read.slice(Math.max(0, hit.index - 80), hit.index + 40)}"` : null).toBeNull();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  scenario.key = 'implementation';
  scenario.canPreview = false;
  scenario.lastSubmission = null;
  scenario.paged = false;
  scenario.resolved = false;
  scenario.noRunbook = false;
  scenario.change = true;
  tokens += 1;
  window.localStorage.setItem(TOKEN_KEY, `learner-token-${tokens}`);
  rig.request.mockImplementation((method: string, apiPath: string) => serve(method, apiPath));
  resetRecords();
  vi.stubGlobal('fetch', vi.fn(serveFetch));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true, writable: true });
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* --------------------------------- rooms ---------------------------------- */

describe("FIX-1 (a teacher's own application) in the learner rooms 3–6", () => {
  it("FIX-1's implementation room seeds its own files and shows no TaskTrackr task", async () => {
    scenario.key = 'implementation';
    await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
    expect(q('[data-testid="workspace-page"]')).not.toBeNull();
    // Its own two gaps open first, each beside the suite it is checked by.
    const tabs = [...host.querySelectorAll('[data-testid^="file-tab-"]')].map((el) => el.getAttribute('data-testid'));
    expect(tabs).toEqual(expect.arrayContaining(['file-tab-api-shelf-py', 'file-tab-web-src-lib-shelf-ts']));
    expect(tabs.every((tab) => /shelf/.test(tab ?? ''))).toBe(true);
    const aside = norm(q('[data-workspace-panel="brief"]')?.textContent);
    expect(aside).not.toContain('complete_task');
    expect(aside).not.toContain('Explore the five gaps');
    // The teacher's own words are the brief, and nothing is invented beside them.
    expect(aside).toContain('The shelf runs except for four marked gaps');
    expect(controlLabels()).not.toContain('Next implementation task');
    // The case file's words are in the panel for an uploaded project too, with no
    // door to the reference project's phase guide.
    expect(q('[data-workspace-panel="brief"] [data-testid="phase-mission"] summary')?.textContent).toBe('Mission and review criteria');
    expect(q('[data-testid="phase-mission"] a[href^="/learn/"]')).toBeNull();
    expect(q('[data-testid="phase-mission-mission"]')?.textContent).not.toContain('The shelf runs except for four marked gaps');
  });

  it("the teacher's intro is read once in the brief panel of the Design room, a code room and the change room", async () => {
    const rooms: { key: PhaseKey; url: string; page: () => ReactNode }[] = [
      { key: 'design', url: `/workspace/${PHASE_ID}/design`, page: () => <DesignPage /> },
      { key: 'implementation', url: `/workspace/${PHASE_ID}`, page: () => <WorkspacePage /> },
      { key: 'maintenance', url: `/workspace/${PHASE_ID}/change`, page: () => <ChangeRequestPage /> },
    ];
    const times: Record<string, number> = {};
    for (const room of rooms) {
      scenario.key = room.key;
      await open(room.url, room.page());
      const intro = norm(loadPhase(room.key).phase.intro);
      const panel = q('[data-workspace-panel="brief"]');
      // The fold is there, and the intro card above it is where the teacher's words are read.
      expect(panel?.querySelector('[data-testid="phase-mission"]'), room.key).not.toBeNull();
      expect(norm(panel?.querySelector('[data-testid="phase-brief-own-intro"]')?.textContent), room.key).toBe(intro);
      times[room.key] = norm(panel?.textContent).split(intro).length - 1;
      await act(async () => root.unmount());
      root = createRoot(host);
    }
    expect(times).toEqual({ design: 1, implementation: 1, maintenance: 1 });
  });

  it("the testing room offers FIX-1's own SH-n story ids from its brief, the prefix its Requirements stories use, and no stray id-shaped line", () => {
    const { phase, taskPanel } = loadPhase('testing');
    const brief = [phase.intro, taskPanel, ...phase.objectives].join('\n');
    // The prefix the API serves on the Testing phase (`storyPrefixes`): the Requirements phase's provided stories' ids.
    const requirements = JSON.parse(readFileSync(path.join(SHELF, 'phases/01-requirements/phase.json'), 'utf8')) as { checks: { providedStories: { id: string }[] } };
    const provided = requirements.checks.providedStories.map((one) => one.id);
    const prefixes = [...new Set(provided.map((id) => id.slice(0, id.indexOf('-'))))];
    expect(prefixes).toEqual(['SH']);
    const offered = collectCriteria([], [], [], brief, { reference: false, prefixes }).map((c) => c.id);
    expect(offered).toEqual(expect.arrayContaining(['SH-1', 'SH-2', 'SH-3', 'SH-4']));
    // A line of the brief that names another id-shaped token is not a story.
    expect(collectCriteria([], [], [], `${brief}\nID-7 is the ticket this came from.`, { reference: false, prefixes }).map((c) => c.id)).not.toContain('ID-7');
    // The planted bugs a graded matrix names are offered whatever their family.
    const named = collectCriteria([], SHELF_MUTANTS, [], brief, { reference: false, prefixes }).map((c) => c.id);
    expect(named).toEqual(expect.arrayContaining(SHELF_MUTANTS.flatMap((row) => (row.covers ? [row.covers] : []))));
    // A hash, a protocol or an advisory number in a teacher's brief is not a story.
    expect(collectCriteria([], [], [], 'Sign with SHA-256 over HTTP-2 on IPV-6 (CVE-123, TLS-1); then SH-1 and US-1.', { reference: false, prefixes }).map((c) => c.id)).toEqual(['SH-1']);
    // TaskTrackr's brief offers US ids only, the prefix a version with US-n stories (or none) is served.
    expect(collectCriteria([], [], [], 'US-3 and US-4, then CR-2 and SH-1.', { reference: true }).map((c) => c.id)).toEqual(['US-3', 'US-4']);
    expect(collectCriteria([], [], [], 'US-3 and US-4, then CR-2 and SH-1.').map((c) => c.id)).toEqual(['US-3', 'US-4']);
  });

  it('an own brief\'s story headings decide which ids are stories: "target ES-6 syntax" offers no ES-6', () => {
    const own = { reference: false };
    const ids = (...args: Parameters<typeof collectCriteria>) => collectCriteria(...args).map((c) => c.id);
    const asides = 'Target ES-6 syntax. The API-1 note and the COVID-19 opening hours do not change.';
    // Story headings in the task panel name the stories; the brief's other upper-case tokens are not offered.
    const headed = `## US-1 Find a book by author\n- **AC-1** — Given a shelf, when I filter by author, then only that author's books show.\n\n## US-2 Lend a book\n\n${asides}`;
    expect(ids([], [], [], headed, own)).toEqual(['US-1/AC-1', 'US-2']);
    // The same from a story file the phase ships.
    expect(ids([{ path: 'docs/stories.md', text: '## SH-1 Find a book by author\n## SH-2 Lend a book\n' }], [], [], `Write tests for SH-1 and SH-2. ${asides}`, own)).toEqual(['SH-1', 'SH-2']);
    // And from the planted bugs a graded matrix names.
    expect(ids([], SHELF_MUTANTS, [], `Prove SH-1 to SH-4. ${asides}`, own).filter((id) => /^(ES|API|COVID)-/.test(id))).toEqual([]);
    // TaskTrackr's criteria are unaffected.
    const reference = '## US-3 Complete a task\n- **AC-1** — Given a task, when I complete it, then it is done.\n\nUS-4 and ES-6.';
    expect(ids([], [], [], reference)).toEqual(['US-3', 'US-4']);
    expect(ids([], [], [], reference, { reference: true })).toEqual(['US-3', 'US-4']);
    expect(ids([{ path: 'docs/stories.md', text: reference }], [], [], 'US-4', { reference: true })).toEqual(['US-3/AC-1', 'US-4']);
  });

  it("the testing room's matrix lists FIX-1's mutants", async () => {
    scenario.key = 'testing';
    scenario.lastSubmission = {
      id: 'revision-1',
      status: 'completed',
      score: 40,
      passed: false,
      attempt: 1,
      createdAt: '2026-10-01T08:00:00.000Z',
      report: report({ mutation: { total: 4, killed: 0, survivors: [], matrix: SHELF_MUTANTS } }),
    } as unknown as SubmissionView;
    await open(`/workspace/${PHASE_ID}/matrix`, <MatrixPage />);
    const text = pageText();
    for (const mutant of ['author_filter_case_sensitive', 'label_ignores_loan', 'lend_twice_allowed', 'return_unknown_is_200']) {
      expect(text).toContain(mutant);
    }
    expectNoReferenceWords('matrix');
  });

  it('the deployment room opens no missing file and names no ci.yml', async () => {
    scenario.key = 'deployment';
    await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
    expect(q('[data-testid="workspace-page"]')).not.toBeNull();
    const read = everythingRead();
    expect(read).not.toContain('ci.yml');
    expect(read).not.toMatch(/GitHub Actions|Compose/);
    expect(controlLabels()).not.toContain('Open the workflow');
    // What the pack ships stays reachable.
    expect(controlLabels()).toContain('Start the drill');
    // The runbook is the record, in the Runbook tab: no file is named for it.
    expect(q('[data-testid="phase-deployment-tab-runbook"]')).not.toBeNull();
    expect(everythingRead()).not.toContain('RUNBOOK.md');
    expectNoReferenceWords('deployment IDE');

    await act(async () => root.unmount());
    root = createRoot(host);
    await open(`/workspace/${PHASE_ID}/drill`, <DrillPage />);
    expect(everythingRead()).not.toContain('ci.yml');
    expect(everythingRead()).not.toMatch(/Compose/);
    expectNoReferenceWords('drill page');

    // Paged: every control names a file the pack ships, and the selfcheck is
    // described as the pack's own, not TaskTrackr's Compose check.
    scenario.paged = true;
    await act(async () => root.unmount());
    root = createRoot(host);
    await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
    expect(controlLabels()).toEqual(expect.arrayContaining(['Run the selfcheck', 'Open the Dockerfile', 'Open the runbook']));
    expect(everythingRead()).not.toMatch(/ci\.yml|Compose|GitHub Actions/);
    expect(pageText()).not.toContain('RUNBOOK.md');
    expectNoReferenceWords('deployment IDE paged');
    // "Open the runbook" switches to the Runbook view, and no file opens.
    const fileTabs = () => [...host.querySelectorAll('[data-testid^="file-tab-"]')].map((tab) => `${tab.getAttribute('data-testid')}:${tab.getAttribute('aria-selected')}`);
    const before = fileTabs();
    expect(before.length).toBeGreaterThan(0);
    await act(async () => (q('[data-testid="phase-deployment-open-runbook"]') as HTMLElement).click());
    expect(q('[data-testid="phase-deployment-tab-runbook"]')?.getAttribute('aria-selected')).toBe('true');
    expect(norm(q('#phase-deployment-view')?.textContent)).toContain('Health checks');
    expect(fileTabs()).toEqual(before);
    expect(q('[data-testid="file-tab-deployment-runbook-json"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await open(`/workspace/${PHASE_ID}/drill`, <DrillPage />);
    expect(everythingRead()).not.toMatch(/ci\.yml|Compose|GitHub Actions/);
    expect(pageText()).toContain('Launcher read from api/Dockerfile');
    expectNoReferenceWords('drill page paged');
  });

  it('a pack with a drill and no runbook draws no runbook forms, control or evidence, and says it is in the older format', async () => {
    // An older pinned version's Deployment carries no runbook record: nothing
    // may offer, name or write a runbook the version does not ship. The IDE's
    // Runbook view is its older-format notice in place of the forms (spec 5.3).
    scenario.key = 'deployment';
    scenario.noRunbook = true;
    const noRunbook = (where: string) => {
      const read = everythingRead();
      expect(read, where).not.toContain('RUNBOOK.md');
      expect(read, where).not.toMatch(/Runbook follow-up|runbook changed|before and after|does not name one yet|No health check in|your runbook|runbook was not recorded|runbook is assessed/i);
      for (const id of ['runbook-tab', 'phase-deployment-open-runbook', 'drill-runbook-tab', 'phase-deployment-brief-runbook']) {
        expect(q(`[data-testid="${id}"]`), `${where}: ${id}`).toBeNull();
      }
      const labels = controlLabels();
      for (const label of ['Open the runbook', 'Open RUNBOOK.md']) expect(labels, `${where}: ${label}`).not.toContain(label);
      if (where.startsWith('IDE')) expect(q('[data-testid="workspace-older-format"]')?.textContent, where).toBe(RUNBOOK_OLDER_FORMAT_ROOM);
      expectNoReferenceWords(where);
    };
    const again = async (url: string, page: ReactNode) => {
      await act(async () => root.unmount());
      root = createRoot(host);
      await open(url, page);
    };
    await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
    noRunbook('IDE');
    await again(`/workspace/${PHASE_ID}/drill`, <DrillPage />);
    noRunbook('drill page');
    scenario.paged = true;
    await again(`/workspace/${PHASE_ID}`, <WorkspacePage />);
    expect(controlLabels()).toEqual(expect.arrayContaining(['Run the selfcheck', 'Open the Dockerfile']));
    noRunbook('IDE paged');
    await again(`/workspace/${PHASE_ID}/drill`, <DrillPage />);
    expect(pageText()).toContain('Launcher read from api/Dockerfile');
    noRunbook('drill page paged');
    scenario.resolved = true;
    await again(`/workspace/${PHASE_ID}`, <WorkspacePage />);
    expect(q('[data-testid="phase-deployment-incident-record"]')).not.toBeNull();
    noRunbook('IDE resolved');
    // No save is ever sent for a file the pack does not ship.
    const writes = rig.request.mock.calls.filter(([method]) => method === 'PUT');
    expect(JSON.stringify(writes)).not.toMatch(/RUNBOOK\.md|runbook\.json|"Runbook"/);
  });

  it('an older Shelf version\'s maintenance room demands no 2.1.0 heading and names no design/contracts.json for an own project', async () => {
    // An older pinned version: no change request on the detail, no design/contracts.json mounted.
    scenario.key = 'maintenance';
    scenario.change = false;
    await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
    expect(q('[data-testid="workspace-page"]')).not.toBeNull();
    let read = everythingRead();
    expect(read).not.toContain('2.1.0');
    expect(read).not.toContain('design/contracts.json');
    expect(read).not.toContain('CHANGELOG.md');
    expect(read).not.toMatch(/CR-\d/);
    // The pack's own change request is what the room says.
    expect(read).toContain('CHG-1');
    expectNoReferenceWords('maintenance IDE');

    // In the older format an own application's change room is not its door:
    // the room sends it to its workspace, and draws no Contract tab meanwhile.
    await act(async () => root.unmount());
    root = createRoot(host);
    await open(`/workspace/${PHASE_ID}/change`, <ChangeRequestPage />);
    expect(rig.router.replace).toHaveBeenCalledWith(`/workspace/${PHASE_ID}`);
    read = everythingRead();
    expect(read).not.toContain('2.1.0');
    expect(read).not.toContain('design/contracts.json');
    expect(controlLabels()).not.toContain('Contract');
    expectNoReferenceWords('change route');
  });

  it('with CHG-1 on the detail, the change room opens on it for an own project, names no design/contracts.json and draws no Contract tab', async () => {
    scenario.key = 'maintenance';
    scenario.change = true;
    await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
    expect(q('[data-testid="workspace-page"]')).not.toBeNull();
    let read = everythingRead();
    expect(read).not.toContain('2.1.0');
    expect(read).not.toContain('design/contracts.json');
    expect(read).not.toContain('CHANGELOG.md');
    expect(read).not.toMatch(/CR-\d/);
    // The pack's own change request is what the room says.
    expect(read).toContain('CHG-1');
    // The brief card draws the change request, and no contract chip while the teacher's contract switch is off.
    expect(q('[data-testid="phase-maintenance-brief"]')).not.toBeNull();
    expect(read).toContain('Release unwritten');
    expect(read).not.toContain('Contract v2');
    expectNoReferenceWords('maintenance IDE');

    // The change room is every code Maintenance's (spec 5.3): an own
    // application stays in it, on its own ticket, with no Contract tab while
    // the teacher's switch is off.
    await act(async () => root.unmount());
    root = createRoot(host);
    await open(`/workspace/${PHASE_ID}/change`, <ChangeRequestPage />);
    expect(rig.router.replace).not.toHaveBeenCalled();
    expect(q('[data-testid="change-page"]')).not.toBeNull();
    read = everythingRead();
    expect(read).toContain('CHG-1: Shelve by surname');
    expect(read).not.toContain('2.1.0');
    expect(read).not.toContain('design/contracts.json');
    expect(read).not.toContain('CHANGELOG.md');
    expect(controlLabels()).not.toContain('Contract');
    // Its trace rule names the acceptance ids no test or change line covers yet.
    await act(async () => (q('[data-testid="change-check"]') as HTMLElement).click());
    expect(q('[data-testid="change-check-change.trace"]')?.textContent).toContain('AC-1');
    expectNoReferenceWords('change route');
  });

  it('the bridge notice does not name TaskTrackr for an own project', async () => {
    for (const key of ['testing', 'deployment', 'maintenance'] as PhaseKey[]) {
      scenario.key = key;
      await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
      expect(q('[data-testid="phase-bridge-notice"]')).toBeNull();
      expect(pageText()).not.toContain("TaskTrackr's application");
      expect(pageText()).not.toContain('reference application');
      await act(async () => root.unmount());
      root = createRoot(host);
    }
  });

  it('no rendered text in rooms 3–6 for FIX-1 contains TaskTrackr, complete_task, overdue, US-4, 2.1.0 or tasks.py', async () => {
    const pages: { key: PhaseKey; url: string; page: ReactNode }[] = [];
    for (const key of ['implementation', 'testing', 'deployment', 'maintenance'] as PhaseKey[]) {
      pages.push({ key, url: `/workspace/${PHASE_ID}`, page: <WorkspacePage /> });
      pages.push({ key, url: `/workspace/${PHASE_ID}/brief`, page: <BriefPage /> });
      pages.push({ key, url: `/workspace/${PHASE_ID}/pr`, page: <PullRequestPage /> });
    }
    pages.push({ key: 'testing', url: `/workspace/${PHASE_ID}/matrix`, page: <MatrixPage /> });
    pages.push({ key: 'deployment', url: `/workspace/${PHASE_ID}/drill`, page: <DrillPage /> });
    pages.push({ key: 'maintenance', url: `/workspace/${PHASE_ID}/change`, page: <ChangeRequestPage /> });
    for (const one of pages) {
      scenario.key = one.key;
      await open(one.url, one.page);
      expect(pageText().length).toBeGreaterThan(0);
      expectNoReferenceWords(`${one.key} ${one.url}`);
      // Every tab of the IDE's bottom panel, each drawn once.
      if (one.url === `/workspace/${PHASE_ID}`) {
        for (const tab of [...host.querySelectorAll('[data-testid^="tab-"]')]) {
          await act(async () => (tab as HTMLElement).click());
          expectNoReferenceWords(`${one.key} IDE tab ${tab.getAttribute('data-testid')}`);
        }
      }
      await act(async () => root.unmount());
      root = createRoot(host);
    }
  });

  it('the App preview control is hidden for a non-reference application', async () => {
    for (const key of ['implementation', 'testing', 'maintenance'] as PhaseKey[]) {
      scenario.key = key;
      scenario.canPreview = true;
      await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
      expect(q('[data-testid="workspace-page"]')).not.toBeNull();
      expect(controlLabels()).not.toContain('App preview');
      // The sandbox App preview stays hidden; the page preview may be drawn instead.
      expect(q('[data-testid="preview-pane"]')).toBeNull();
      expect(controlLabels().some((label) => /^Run app/.test(label))).toBe(false);
      await act(async () => root.unmount());
      root = createRoot(host);
    }
  });
});
