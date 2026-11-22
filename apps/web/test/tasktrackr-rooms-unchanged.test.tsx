// @vitest-environment jsdom
/**
 * A TaskTrackr phase renders exactly as its recording in
 * rooms 3–6, and so does an unedited teacher copy of TaskTrackr (roll-up
 * `reference`, the reference application named on every application phase).
 *
 * The learner rooms render a teacher's own application (an uploaded pack,
 * such as the Shelf fixture) only where the phase's provenance says the
 * application is NOT the reference's; this file is the proof that the gate
 * never closes on TaskTrackr. It draws the four rooms from
 * TaskTrackr's own pack on disk (content/tasktrackr, read only) and records:
 *
 * - what the room's brief aside says and which controls it draws, including
 *   the five-task implementation brief (complete_task … useTasks);
 * - the deployment room's pipeline and drill controls, the paths they name
 *   (.github/workflows/ci.yml, api/Dockerfile), and the Runbook tab;
 * - the maintenance change room over CR-2 (the ticket the phase spec carries,
 *   `PhaseDetail.change`) and its four tabs of forms;
 * - the App preview control the pack's `canPreview` draws;
 * - the commit field's placeholder.
 *
 * Each recording is the normalised text and control list, held as a file
 * snapshot under `__snapshots__/tasktrackr-rooms/`, so a change shows as a diff
 * of the words and controls that moved.
 */
import { REPO_ROOT } from './support/paths';
import { act, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { phaseMounts } from './support/pack-mounts';
import * as path from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseKey, PhaseProvenanceView, PhaseTaskView } from '@learnsdlc/shared';

// The rooms print clock times ("Saved 22:28", "paged at 16:58") in the
// machine's own zone, and the recordings below were taken in
// Asia/Singapore. Pinned here so a UTC CI runner renders the same words,
// rather than every room reading eight hours early.
process.env.TZ = 'Asia/Singapore';

/* ------------------------------- the packs ------------------------------- */

const TASKTRACKR = path.join(REPO_ROOT, 'content/tasktrackr');
const PHASE_DIR: Record<string, string> = {
  implementation: '03-implementation',
  testing: '04-testing',
  deployment: '05-deployment',
  maintenance: '06-maintenance',
};
const ORDER: Record<string, number> = { implementation: 3, testing: 4, deployment: 5, maintenance: 6 };
const ARTEFACT: Record<string, string> = { implementation: 'code', testing: 'tests', deployment: 'config', maintenance: 'code' };

interface PackPhase {
  key: string;
  title: string;
  intro: string;
  artifactKind: string;
  canRun?: boolean;
  canPreview?: boolean;
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

function loadPhase(packRoot: string, key: string) {
  const dir = path.join(packRoot, 'phases', PHASE_DIR[key]);
  const phase = JSON.parse(readFileSync(path.join(dir, 'phase.json'), 'utf8')) as PackPhase;
  // the folder layout (spec 7.1): the mounts are the phase folder's files/ and readonly/, every brief is inline
  return { phase, files: phaseMounts(dir), taskPanel: phase.taskPanel };
}

/* ------------------------------ the scenario ----------------------------- */

/** 'older': TaskTrackr from a build that serves no provenance on the phase. */
type Variant = 'tasktrackr' | 'copy3a' | 'older';
const scenario = { variant: 'tasktrackr' as Variant, key: 'implementation' as PhaseKey, paged: false, noChange: false };
const pagedDrill = () => ({
  fault: 'port-zero',
  pagedAt: '2026-10-01T08:58:00.000Z',
  // a phase with the runbook record keeps no runbook text at paging
  runbookBefore: null,
  pagedExit: 1,
  healthRanAt: null,
  healthExit: null,
  fixAppliedAt: null,
  resolvedAt: null,
  incident: null,
});
const PHASE_ID = 'phase-room';
const VERSION = '2026-09-28T14:28:57.000Z';
const NOW = new Date('2026-10-01T09:00:00.000Z');

const provenanceFor = (key: string, variant: Variant): PhaseProvenanceView | undefined =>
  // An older build serves no provenance at all, and must read as TaskTrackr.
  variant === 'older' ? undefined : ({
    phaseKey: key as PhaseKey,
    referenceName: 'TaskTrackr',
    rollup: 'reference',
    intro: 'reference',
    interview: null,
    files: [],
    tasks: [{ taskKey: '', provenance: 'reference', titleEdited: false }],
    roomTask: 'reference',
    application: 'TaskTrackr',
    // An unedited teacher's copy carries the same provenance as TaskTrackr's own
    // phase; the variant changes only the enrolment.
  }) as PhaseProvenanceView;

const buildDetail = () => {
  const { phase, files, taskPanel } = loadPhase(TASKTRACKR, scenario.key);
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
    attempts: 0,
    bestScore: null,
    passedAt: null,
    lastSubmissionId: null,
    resetAt: null,
    solution: { available: false, files: 0, readAt: null },
    ...(primary ? { primaryPath: primary, artefactPath: primary } : {}),
  } as unknown as PhaseTaskView;
  return {
    id: PHASE_ID,
    key: scenario.key,
    order: ORDER[scenario.key],
    // Its place in TaskTrackr's six, as the API answers it (PhaseDetail.place, .count).
    place: ORDER[scenario.key],
    count: 6,
    title: phase.title,
    intro: phase.intro,
    status: 'in_progress',
    projectSlug: scenario.variant !== 'copy3a' ? 'tasktrackr' : 'tasktrackr-section-2',
    artifactKind: phase.artifactKind,
    // the records as the API reads them off the phase spec (`PhaseDetail.runbook` and `.change`)
    ...(phase.checks.runbook ? { runbook: { floor: phase.checks.runbook.floor, drill: Boolean(phase.checks.drill) } } : {}),
    ...(phase.checks.ticket && phase.checks.change && !scenario.noChange ? { change: { ticket: phase.checks.ticket, contract: phase.checks.change.contract, floor: phase.checks.change.floor } } : {}),
    bestScore: null,
    attempts: 0,
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
    drill: scenario.paged ? pagedDrill() : null,
    runClock: null,
    canRun: Boolean(phase.canRun),
    canPreview: Boolean(phase.canPreview),
    runLabel: phase.runLabel ?? 'Run tests',
    lastSubmission: null,
    solution: { available: false, files: 0, readAt: null },
    provenance: provenanceFor(scenario.key, scenario.variant),
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
  scenario: 'reference',
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
    projectTitle: scenario.variant !== 'copy3a' ? 'TaskTrackr — a task manager you can run' : 'TaskTrackr — Section 2',
    projectSlug: scenario.variant !== 'copy3a' ? 'tasktrackr' : 'tasktrackr-section-2',
    projectIsDefault: scenario.variant !== 'copy3a',
    currentPhaseOrder: ORDER[scenario.key],
    completed: false,
    // TaskTrackr's Testing and Deployment have a phase after them, so a locked
    // Maintenance follows those rooms; Maintenance is the project's last phase.
    phases: [
      summary(),
      ...(scenario.key !== 'maintenance'
        ? [{ id: 'later-phase', key: 'maintenance', order: 6, title: 'Maintenance', status: 'locked', bestScore: null, attempts: 0, reflection: null, passedAt: null }]
        : []),
    ],
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
import DrillPage from '@/app/(app)/workspace/[phaseId]/drill/page';
import { TOKEN_KEY } from '@/lib/session';
import { resetRecords } from '@/lib/records';
import { stubMatchMedia } from './support/dom';

const serve = async (method: string, apiPath: string): Promise<unknown> => {
  if (method === 'GET' && apiPath.startsWith(`/phases/${PHASE_ID}`) && !apiPath.includes('/', `/phases/${PHASE_ID}`.length)) {
    return wire(buildDetail());
  }
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

/* ------------------------------ the recording ---------------------------- */

const norm = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** The visible words and every control of one region, in document order. */
function record(region: Element | null): string {
  if (!region) return '<absent>';
  const controls = [...region.querySelectorAll('button, a[href], select, input, textarea')].map((el) => {
    const label = el.getAttribute('aria-label') || norm(el.textContent) || el.getAttribute('placeholder') || '';
    const href = el.getAttribute('href');
    const tag = el.tagName.toLowerCase();
    return `${tag}${href ? `[${href}]` : ''}:${label}${el.getAttribute('placeholder') ? ` {${el.getAttribute('placeholder')}}` : ''}`;
  });
  return `TEXT ${norm(region.textContent)}\nCONTROLS\n${controls.join('\n')}`;
}

/** The snapshot file that holds the recording called `name`. */
const recording = (name: string) => `__snapshots__/tasktrackr-rooms/${name}.txt`;

const q = (selector: string) => host.querySelector(selector);
const pageText = () => norm(host.textContent);
const controlLabels = () =>
  [...host.querySelectorAll('button, a[href]')].map((el) => el.getAttribute('aria-label') || norm(el.textContent));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  scenario.paged = false;
  scenario.noChange = false;
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

/* -------------------------------- the guard ------------------------------ */

/*
 * The recordings of TaskTrackr's rooms. A change to one is a change to what a
 * TaskTrackr learner sees, which support for teachers' own applications must
 * never make: read the diff before re-recording with `vitest run -u`.
 */
const ROOMS: PhaseKey[] = ['implementation', 'testing', 'deployment', 'maintenance'];
const VARIANTS: Variant[] = ['tasktrackr', 'copy3a'];

describe('a TaskTrackr phase renders exactly as today (rooms 3–6)', () => {
  for (const variant of VARIANTS) {
    for (const key of ROOMS) {
      it(`${variant === 'tasktrackr' ? 'TaskTrackr' : 'an unedited 3a copy (rollup reference)'} › ${key}: the IDE's brief aside, its tabs and the App preview control`, async () => {
        scenario.variant = variant;
        scenario.key = key;
        await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
        expect(q('[data-testid="workspace-page"]')).not.toBeNull();
        const aside = q('[data-workspace-panel="brief"]');
        const name = `${variant}-${key}-aside`;
        // The case file's words, folded in the panel (no door opens the case file page).
        expect(aside?.querySelector('[data-testid="phase-mission"] summary')?.textContent).toBe('Mission and review criteria');
        const print = record(aside);
        // Explicit, readable halves of the recording.
        if (key === 'implementation') {
          for (const word of ['complete_task', 'list_tasks', 'overdue_tasks', 'isOverdue', 'useTasks', 'US-2 / PYTHON', 'Explore the five gaps']) {
            expect(norm(aside?.textContent)).toContain(word);
          }
        }
        if (key !== 'implementation') {
          expect(q('[data-testid="phase-bridge-notice"]') !== null).toBe(variant === 'copy3a');
        }
        if (key === 'maintenance') {
          expect(norm(aside?.textContent)).toContain('CR-2: Comments on a task');
          expect(norm(aside?.textContent)).toContain('Release unwritten');
        }
        // The App preview control this pack's `canPreview` draws.
        if (key === 'implementation') expect(q('.implementation-app')).not.toBeNull();
        else if (key === 'testing' || key === 'maintenance') expect(controlLabels()).toContain('App preview');
        else expect(controlLabels()).not.toContain('App preview');
        // The commit field's placeholder.
        expect(q('[data-testid="commit-input"]')?.getAttribute('placeholder') ?? 'Fix the overdue boundary so due today is not overdue').toBe(
          'Fix the overdue boundary so due today is not overdue',
        );
        await expect(print).toMatchFileSnapshot(recording(name));
        // And the whole room: every word and every control the IDE draws.
        await expect(record(host)).toMatchFileSnapshot(recording(`${variant}-${key}-page`));
      });
    }

    it(`${variant === 'tasktrackr' ? 'TaskTrackr' : 'an unedited 3a copy'} › deployment: the pipeline and the drill name the pack's own paths, and the Runbook tab holds the record's sections`, async () => {
      scenario.variant = variant;
      scenario.key = 'deployment';
      await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
      const pipeline = q('[data-testid="phase-deployment-pipeline"]');
      const tools = pipeline?.closest('.deployment-tool-evidence') ?? null;
      const name = `${variant}-deployment-tools`;
      const print = record(tools);
      expect(norm(pipeline?.textContent)).toContain('.github/workflows/ci.yml');
      expect(controlLabels()).toContain('Open the workflow');
      expect(controlLabels()).toContain('Start the drill');
      await expect(print).toMatchFileSnapshot(recording(name));
      // the runbook is the record, in the Runbook tab: no RUNBOOK.md anywhere in the room
      const tab = q('[data-testid="phase-deployment-tab-runbook"]') as HTMLElement | null;
      expect(tab).not.toBeNull();
      expect(pageText()).not.toContain('RUNBOOK.md');
      await act(async () => tab!.click());
      const view = q('#phase-deployment-view');
      const sections = norm(view?.textContent);
      for (const section of ['Environment', 'Health checks', 'Rollback', 'Data', 'Incident']) expect(sections).toContain(section);
      // the seeded runbook's named items, as the forms hold them
      const held = [...(view?.querySelectorAll('input, textarea') ?? [])].map((field) => (field as HTMLInputElement).value);
      expect(held).toEqual(expect.arrayContaining(['TASKTRACKR_DB', 'API_URL', 'API healthcheck', 'The database file']));
    });

    it(`${variant === 'tasktrackr' ? 'TaskTrackr' : 'an unedited 3a copy'} › deployment, paged: the drill's controls, its Compose notice and the drill page`, async () => {
      scenario.variant = variant;
      scenario.key = 'deployment';
      scenario.paged = true;
      await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
      const tools = q('[data-testid="phase-deployment-pipeline"]')?.closest('.deployment-tool-evidence') ?? null;
      expect(controlLabels()).toEqual(expect.arrayContaining(['Run the selfcheck', 'Open the Dockerfile', 'Open the runbook']));
      expect(norm(tools?.textContent)).toContain('checks the Compose service address');
      const name = `${variant}-deployment-paged-tools`;
      const print = record(tools);
      await act(async () => root.unmount());
      root = createRoot(host);
      await open(`/workspace/${PHASE_ID}/drill`, <DrillPage />);
      expect(pageText()).toContain('faulted Compose configuration');
      const page = `${variant}-deployment-paged-drill-page`;
      const pagePrint = record(q('[data-testid="drill-page"]') ?? host);
      await expect(print).toMatchFileSnapshot(recording(name));
      await expect(pagePrint).toMatchFileSnapshot(recording(page));
    });

    it(`${variant === 'tasktrackr' ? 'TaskTrackr' : 'an unedited 3a copy'} › maintenance: the change room draws CR-2 and its four tabs, names no CHANGELOG.md, and stays where it is`, async () => {
      scenario.variant = variant;
      scenario.key = 'maintenance';
      await open(`/workspace/${PHASE_ID}/change`, <ChangeRequestPage />);
      expect(q('[data-testid="change-page"]')).not.toBeNull();
      expect(rig.router.replace).not.toHaveBeenCalled();
      const text = pageText();
      expect(text).toContain('CR-2: Comments on a task');
      expect(text).toContain('AC-3 An empty or whitespace-only author or body answers 400 invalid_comment.');
      for (const tab of ['Request', 'Contract', 'Checks', 'Release']) expect(controlLabels()).toContain(tab);
      expect(text).not.toContain('CHANGELOG.md');
      // the starting change request names its release, 2.1.0, and nothing else yet
      expect(text).toContain('Release record 2.1.0');
      // The change room is the Maintenance door's room, so it holds the case file's words too.
      expect(q('[data-workspace-panel="brief"] [data-testid="phase-mission"] summary')?.textContent).toBe('Mission and review criteria');
      const name = `${variant}-maintenance-change`;
      await expect(record(q('[data-testid="change-page"]'))).toMatchFileSnapshot(recording(name));
    });
  }
});

/**
 * A reference application's Maintenance read without a change request (an
 * older-format phase): its doors still lead to the change room, because the
 * reference application keeps one, and the room draws no Contract tab, since
 * there is no teacher's switch to say the contract is in play.
 */
describe('a reference application\'s Maintenance with no change request', () => {
  it('the IDE keeps both doors to the change room', async () => {
    scenario.key = 'maintenance';
    scenario.noChange = true;
    await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
    expect(q('[data-testid="workspace-page"]')).not.toBeNull();
    expect(document.querySelectorAll(`a[href="/workspace/${PHASE_ID}/change"]`).length).toBeGreaterThanOrEqual(2);
  });
  it('the change room draws no Contract tab', async () => {
    scenario.key = 'maintenance';
    scenario.noChange = true;
    await open(`/workspace/${PHASE_ID}/change`, <ChangeRequestPage />);
    expect(q('[data-testid="change-page"]')).not.toBeNull();
    for (const tab of ['Request', 'Checks', 'Release']) expect(controlLabels()).toContain(tab);
    expect(controlLabels()).not.toContain('Contract');
  });
});

/**
 * A build that serves no provenance reads as the reference application, so
 * TaskTrackr renders exactly as recorded: every print matches TaskTrackr's
 * recording.
 */
describe('an older build (no provenance on the phase) renders exactly as TaskTrackr does today', () => {
  for (const key of ROOMS) {
    it(`no provenance › ${key}: the IDE's brief aside and the whole room`, async () => {
      scenario.variant = 'older';
      scenario.key = key;
      await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
      expect(q('[data-testid="workspace-page"]')).not.toBeNull();
      await expect(record(q('[data-workspace-panel="brief"]'))).toMatchFileSnapshot(recording(`tasktrackr-${key}-aside`));
      await expect(record(host)).toMatchFileSnapshot(recording(`tasktrackr-${key}-page`));
    });
  }

  it('no provenance › deployment tools, the paged drill, the drill page and the maintenance change request', async () => {
    scenario.variant = 'older';
    scenario.key = 'deployment';
    await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
    const tools = () => q('[data-testid="phase-deployment-pipeline"]')?.closest('.deployment-tool-evidence') ?? null;
    const prints: Record<string, string> = {};
    prints['deployment-tools'] = record(tools());
    await act(async () => root.unmount());
    root = createRoot(host);
    scenario.paged = true;
    await open(`/workspace/${PHASE_ID}`, <WorkspacePage />);
    prints['deployment-paged-tools'] = record(tools());
    await act(async () => root.unmount());
    root = createRoot(host);
    await open(`/workspace/${PHASE_ID}/drill`, <DrillPage />);
    prints['deployment-paged-drill-page'] = record(q('[data-testid="drill-page"]') ?? host);
    await act(async () => root.unmount());
    root = createRoot(host);
    scenario.paged = false;
    scenario.key = 'maintenance';
    await open(`/workspace/${PHASE_ID}/change`, <ChangeRequestPage />);
    expect(rig.router.replace).not.toHaveBeenCalled();
    prints['maintenance-change'] = record(q('[data-testid="change-page"]'));
    for (const [name, print] of Object.entries(prints)) await expect(print).toMatchFileSnapshot(recording(`tasktrackr-${name}`));
  });
});
