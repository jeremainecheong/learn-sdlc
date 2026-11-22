// @vitest-environment jsdom
/**
 * The regression card's reason, in the change-request room.
 *
 * The checks tab's regression card draws its own control while there is no
 * verdict yet. In the room it states the reason the header's Submit states: the
 * countersignature (SIGN_OFF_SUBMIT_REASON) or a revision in flight
 * (REVISION_IN_FLIGHT_REASON). The card alone is regression-card-reason.test.tsx's.
 *
 * The rig is change-room-signoff-submit.test.tsx's: the REAL page and the REAL
 * Button, with the shell's held project and the network stood in for.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANGE_REQUEST_JSON, type EnrollmentView, type PhaseDetail, type PhaseKey, type PhaseSummary, type PhaseTaskView, type SubmissionView } from '@learnsdlc/shared';

const PHASE_ID = 're-rooms-maintenance';
const rig = vi.hoisted(() => ({ project: null as unknown, request: vi.fn(), fetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: 're-rooms-maintenance' }),
  usePathname: () => '/workspace/re-rooms-maintenance/change',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  useProject: () => rig.project,
  useProjectMaybe: () => rig.project,
  invalidateProject: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return {
    ...real,
    request: rig.request,
    getToken: () => 're-token',
    // The room's three calls go through the stand-in, as `request` would carry them.
    api: {
      ...real.api,
      phase: (id: string) => rig.request('GET', `/phases/${id}`),
      submit: (id: string) => rig.request('POST', `/phases/${id}/submit`),
      getSubmission: (id: string) => rig.request('GET', `/submissions/${id}`),
    },
  };
});
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/shell/PersonaPanel', async (original) => ({
  ...(await original<typeof import('@/components/shell/PersonaPanel')>()),
  PersonaPanel: () => null,
  MentorSession: () => null,
}));
vi.mock('@/components/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 're-learner', role: 'LEARNER', displayName: 'Learner', avatar: 0, cohort: 'default', profileVersion: 0 }),
  getSession: () => ({ id: 're-learner', role: 'LEARNER', displayName: 'Learner', avatar: 0, cohort: 'default', profileVersion: 0 }),
}));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));

import ChangeRequestPage from '@/app/(app)/workspace/[phaseId]/change/page';
import * as signoff from '@/components/workspace/signoff-status';

const { SIGN_OFF_SUBMIT_REASON } = signoff;
/** Read through the namespace so a missing constant fails an assertion, not the import. */
const IN_FLIGHT = () => (signoff as Record<string, unknown>).REVISION_IN_FLIGHT_REASON as string | undefined;

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const CODE = 'src/app.ts';

type TaskOver = Partial<PhaseTaskView> & Record<string, unknown>;
const theTask = (over: TaskOver = {}): PhaseTaskView =>
  ({
    key: 'main', order: 1, required: true, title: 'The change', artefactType: 'code', primaryPath: CODE, files: [CODE],
    evidence: 'signed-off', sealed: true, status: 'submitted', awaitingSignOff: false, attempts: 1, bestScore: 40,
    passedAt: null, lastSubmissionId: 'rev-1', resetAt: null, solution: { available: false, files: 0, readAt: null },
    ...over,
  }) as unknown as PhaseTaskView;

/** Revisions are made a minute or two ago: one in flight older than the API's
 * age-out window (IN_FLIGHT_MAX_AGE_MS) does not hold Submit off. */
const FRESH = new Date(Date.now() - 120_000).toISOString();
const revision = (id: string, status: SubmissionView['status'], passed: boolean | null = null, createdAt = FRESH): SubmissionView =>
  ({ id, taskKey: 'main', status, passed, score: passed ? 88 : passed === false ? 40 : null, attempt: 2, createdAt, report: null }) as unknown as SubmissionView;

function changeDetail(task: PhaseTaskView, lastSubmission: SubmissionView | null, status = 'submitted'): PhaseDetail {
  return {
    id: PHASE_ID, key: 'maintenance', order: 6, title: 'Maintenance', status, attempts: 1, bestScore: 40, reflection: null,
    passedAt: null, opensAt: null, dueAt: null, projectSlug: 'tasktrackr',
    intro: 'The change.', taskPanel: 'The brief.', objectives: [], artifactKind: 'code',
    // a Maintenance with its change request, as every Maintenance of the code kind now ships (an older one is refused)
    change: { ticket: { id: 'CR-2', title: 'Comments on tasks', summary: 'Tasks carry comments.', acceptance: [{ id: 'AC-1', line: 'A task lists its comments.' }] }, contract: false, floor: { minImpact: 0, minContract: 0, minTests: 0, requireRelease: false, traceEveryAcceptance: false } },
    files: [{ path: CODE, content: 'export const x = 1;\n', editable: true, language: 'typescript' }],
    rubric: { passThreshold: 70, criteria: [] },
    tasks: [task],
    taskCounts: { total: 1, required: 1, passed: 0, passedRequired: 0 },
    canRun: false, canPreview: false, runLabel: 'Run tests', links: [], lastSubmission,
    updatedAt: '2026-10-04T01:00:00.000Z', workspaceUpdatedAt: '2026-10-04T00:50:00.000Z', stakeholder: null, scenario: 'own',
    provenance: { phaseKey: 'maintenance', referenceName: null, rollup: 'own', intro: 'own', interview: null, files: [], tasks: [], roomTask: 'other' },
  } as unknown as PhaseDetail;
}

function shell(detail: PhaseDetail) {
  const phases = KEYS.map((key, at) =>
    key === 'maintenance'
      ? ({ ...detail, view: undefined } as unknown as PhaseSummary)
      : ({ id: `re-${key}`, key, order: at + 1, title: key, status: 'passed', attempts: 1, bestScore: 90, reflection: null, passedAt: null, opensAt: null, dueAt: null, scenario: 'own' } as PhaseSummary),
  );
  const enrollment = {
    id: 're-enrolment', projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr — the reference', currentPhaseOrder: 6, completed: false,
    startedAt: '2026-10-04T00:00:00Z', completedAt: null, projectIsDefault: true, phases,
  } as unknown as EnrollmentView;
  return { enrollment, currentPhase: phases[5], details: { [PHASE_ID]: detail }, analytics: null, loading: false, revalidating: false, error: '', reload: () => Promise.resolve() };
}

const calls: string[] = [];
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  calls.length = 0;
  rig.request.mockReset();
  rig.fetch.mockReset();
  vi.stubGlobal('fetch', rig.fetch);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/**
 * Mount the room. `seed` is what the shell already holds; `fresh` is what the
 * room's own read of the phase answers (the same unless a test says not).
 */
async function mount(seed: PhaseDetail, fresh: PhaseDetail = seed, network: { submit?: () => SubmissionView; verdict?: () => SubmissionView; after?: () => PhaseDetail } = {}) {
  rig.project = shell(seed);
  let reads = 0;
  rig.request.mockImplementation(async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === `/phases/${PHASE_ID}`) {
      reads += 1;
      return reads > 1 && network.after ? network.after() : fresh;
    }
    if (path.includes('/submit')) {
      if (network.submit) return network.submit();
      throw new Error('a resubmit reached the API');
    }
    if (method === 'GET' && path.startsWith('/submissions/') && network.verdict) return network.verdict();
    return [];
  });
  rig.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(JSON.stringify(String(input).endsWith(`/phases/${PHASE_ID}`) ? fresh : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await act(async () => { root.render(<ChangeRequestPage />); });
  for (let round = 0; round < 5; round += 1) await act(async () => { await Promise.resolve(); });
  expect(reads, 'the room read the phase itself').toBeGreaterThan(0);
}
const checksButton = () => host.querySelector<HTMLButtonElement>('[data-testid="phase-maintenance-regression"] button');
const describedBy = (button: HTMLButtonElement) => {
  const id = button.getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent ?? null : null;
};

describe('the change room\'s checks tab', () => {
  // While the review runs the learner has just submitted, so the card says the review is
  // running and draws no Submit of its own; the header's Submit is held with the in-flight reason.
  it('in flight the checks tab says the review is running and offers no Submit; the header\'s is held and says why', async () => {
    await mount(changeDetail(theTask(), revision('rev-2', 'queued')));
    expect(checksButton(), 'the regression card draws no control while the review runs').toBeNull();
    expect(host.querySelector('[data-testid="phase-maintenance-regression-empty"]')!.textContent).toContain('The review is running these tests now, with the hidden change tests.');
    const header = host.querySelector<HTMLButtonElement>('[data-testid="phase-maintenance-submit"]')!;
    expect(header.disabled).toBe(true);
    expect(describedBy(header)).toBe(IN_FLIGHT());
  });

  /*
   * The card says the review is running exactly while the page holds a revision in
   * flight (`pendingRevision`), as the header's Submit does, not whenever the held submission's raw status is queued.
   */
  const notRunning = () => {
    const header = host.querySelector<HTMLButtonElement>('[data-testid="phase-maintenance-submit"]')!;
    expect(header.disabled, 'the header\'s Submit is on').toBe(false);
    const empty = host.querySelector('[data-testid="phase-maintenance-regression-empty"]')!.textContent ?? '';
    expect(empty).toContain('when you submit PR-6.');
    expect(empty).not.toContain('The review is running these tests now');
    const button = checksButton();
    expect(button, 'the card offers its Submit, as the header does').not.toBeNull();
    expect(button!.disabled).toBe(false);
    expect(button!.textContent).toMatch(/^Submit PR-6/);
  };
  it('a queued revision older than the in-flight window: the card says when the review runs and offers Submit, as the header does', async () => {
    const stale = new Date(Date.now() - signoff.IN_FLIGHT_MAX_AGE_MS - 60_000).toISOString();
    await mount({ ...changeDetail(theTask(), revision('rev-2', 'queued', null, stale)), place: 6 } as PhaseDetail);
    notRunning();
  });

  it('a queued revision of another task of the phase: the card says when the review runs and offers Submit, as the header does', async () => {
    const change = theTask({ key: 'change', files: [CODE, CHANGE_REQUEST_JSON], lastSubmissionId: null });
    const other = theTask({ key: 'other', order: 2, title: 'Another task', files: ['src/other.ts'], lastSubmissionId: 'rev-9' });
    const detail = { ...changeDetail(change, { ...revision('rev-9', 'queued'), taskKey: 'other' } as SubmissionView), tasks: [change, other], place: 6 } as PhaseDetail;
    await mount(detail);
    notRunning();
  });

  it('the checks tab\'s own control is off and says why (waiting on the countersignature)', async () => {
    await mount(changeDetail(theTask({ awaitingSignOff: true, bestScore: 88 }), revision('rev-1', 'completed', true)));
    const button = checksButton();
    expect(button!.disabled).toBe(true);
    expect(describedBy(button!)).toBe(SIGN_OFF_SUBMIT_REASON);
  });

  /*
   * After a submission that came back without a report ("Review
   * unavailable"), the card's Submit and the header's carry one name, by the header's test (a last submission or any
   * attempt), not by whether a verdict is held.
   */
  it('after a review that came back without a report, the card and the header both read "Submit PR-6 again"', async () => {
    await mount({ ...changeDetail(theTask(), revision('rev-1', 'completed')), place: 6 } as PhaseDetail);
    const header = host.querySelector<HTMLButtonElement>('[data-testid="phase-maintenance-submit"]')!;
    expect(header.textContent).toMatch(/^Submit PR-6 again/);
    const button = checksButton();
    expect(button, 'the card offers its Submit').not.toBeNull();
    expect(button!.textContent!.trim()).toBe('Submit PR-6 again');
  });

});
