// @vitest-environment jsdom
/**
 * A revision in flight holds Submit off, in the change-request room.
 *
 * The change room's Submit is off while its task waits on the teacher's
 * countersignature, and also while a newer revision is still queued or being
 * reviewed: the API refuses a second revision in flight for a task
 * (UQ_submissions_in_flight) and will not countersign while one is queued or
 * running (signOne), so a press could not land. Here Submit and ⌘↵ are off
 * with REVISION_IN_FLIGHT_REASON while the held revision is queued or running
 * (the checks tab's own control with them), and on again once its verdict is
 * in. The checks tab's stated reason is regression-card-change-room.test.tsx's.
 *
 * The rig is change-room-signoff-submit.test.tsx's: the REAL page and the REAL
 * Button, with the shell's held project and the network stood in for.
 */
import { act, type ReactNode } from 'react';
import { waitUntil } from './support/dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseKey, PhaseSummary, PhaseTaskView, SubmissionView } from '@learnsdlc/shared';
import { loadAxe } from './support/axe-bridge';

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
const LATER = new Date(Date.now() - 60_000).toISOString();
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
const submitButton = () => host.querySelector<HTMLButtonElement>('[data-testid="phase-maintenance-submit"]');
const checksButton = () => host.querySelector<HTMLButtonElement>('[data-testid="phase-maintenance-regression"] button');
const describedBy = (button: HTMLButtonElement) => {
  const id = button.getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent ?? null : null;
};
const pressSubmitKeys = () => act(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  for (let round = 0; round < 3; round += 1) await Promise.resolve();
});
const submits = () => calls.filter((one) => one.includes('/submit'));

describe('the change room while a newer revision is in flight', () => {
  for (const status of ['queued', 'running'] as const) {
    it(`${status}: Submit PR-6 is off with the in-flight reason, and ⌘↵ hands nothing in`, async () => {
      await mount(changeDetail(theTask(), revision('rev-2', status)));
      const button = submitButton();
      expect(button, 'the change room is drawn').not.toBeNull();
      expect(IN_FLIGHT(), 'REVISION_IN_FLIGHT_REASON is exported').toEqual(expect.any(String));
      expect(button!.disabled).toBe(true);
      expect(describedBy(button!)).toBe(IN_FLIGHT());
      expect(button!.getAttribute('title')).toBe(IN_FLIGHT());
      act(() => button!.click());
      await pressSubmitKeys();
      expect(submits()).toEqual([]);
    });
  }

  it('a held copy that went stale is not a revision in flight: the room\'s own read says the verdict is in', async () => {
    await mount(
      changeDetail(theTask(), revision('rev-2', 'queued')),
      changeDetail(theTask({ lastSubmissionId: 'rev-2' }), revision('rev-2', 'completed', false)),
    );
    expect(submitButton()!.disabled).toBe(false);
    expect(submitButton()!.getAttribute('aria-describedby')).toBeNull();
  });

  it('the verdict lands after a submit and Submit is on again', async () => {
    const after = changeDetail(theTask({ lastSubmissionId: 'rev-2' }), revision('rev-2', 'completed', false, LATER));
    await mount(changeDetail(theTask(), revision('rev-1', 'completed', false)), undefined, {
      submit: () => revision('rev-2', 'queued', null, LATER),
      verdict: () => revision('rev-2', 'completed', false, LATER),
      after: () => after,
    });
    expect(submitButton()!.disabled).toBe(false);
    await act(async () => { submitButton()!.click(); });
    for (let round = 0; round < 10; round += 1) await act(async () => { await Promise.resolve(); });
    expect(submits().length).toBe(1);
    expect(submitButton()!.disabled).toBe(false);
    expect(submitButton()!.getAttribute('aria-describedby')).toBeNull();
  });

  it('a refused review with nothing in flight leaves Submit on with no reason', async () => {
    await mount(changeDetail(theTask(), revision('rev-1', 'completed', false)));
    expect(submitButton()!.disabled).toBe(false);
    expect(submitButton()!.getAttribute('aria-describedby')).toBeNull();
    expect(checksButton()!.disabled).toBe(false);
    expect(checksButton()!.getAttribute('aria-describedby')).toBeNull();
  });

  it('axe › the room with the disabled controls and their reasons has no findings in the controls it draws', async () => {
    await mount(changeDetail(theTask(), revision('rev-2', 'running')));
    const axe = await loadAxe();
    const result = await axe.run(host, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});

describe('the change room watches a revision in flight to its verdict', () => {
  it('opened while a revision is queued: the room follows it and Submit is on again without a reload', async () => {
    const after = changeDetail(theTask({ lastSubmissionId: 'rev-2' }), revision('rev-2', 'completed', false));
    await mount(changeDetail(theTask(), revision('rev-2', 'queued')), undefined, {
      verdict: () => revision('rev-2', 'completed', false),
      after: () => after,
    });
    await waitUntil(() => !submitButton()!.disabled, 'Submit on again', { tries: 10, tick: 20 });
    expect(calls).toContain('GET /submissions/rev-2');
    expect(submitButton()!.disabled).toBe(false);
    expect(submitButton()!.getAttribute('aria-describedby')).toBeNull();
    expect(submits()).toEqual([]);
  });
  it('a revision older than the API\'s age-out window no longer holds Submit off: the next press is what writes it off', async () => {
    await mount(changeDetail(theTask(), revision('rev-2', 'queued', null, new Date(Date.now() - 11 * 60_000).toISOString())));
    expect(submitButton()!.disabled).toBe(false);
    expect(submitButton()!.getAttribute('aria-describedby')).toBeNull();
  });
});

/*
 * In the REAL frame: the header's Submit is `size="sm"` (HeaderSubmit), the workspace header's size, so
 * "Open the workspace" beside it on the header's row is too (and the Brief, read in Details). At the default size
 * the row would be two sizes: Submit 34 px, the door beside it about 40 px.
 */
describe('the change request\'s header row is one size', () => {
  it('Open the workspace and Submit PR-6 on the row, each sm; the Brief in Details sm too', async () => {
    await mount(changeDetail(theTask(), revision('rev-1', 'completed', false)));
    const row = host.querySelector('.phase-strip-primary')!;
    const drawn = [...row.querySelectorAll<HTMLElement>('a, button')];
    expect(drawn.map((one) => one.dataset.testid)).toEqual(['open-workspace', 'phase-maintenance-submit']);
    for (const one of drawn) expect(one.className, one.textContent ?? '').toContain('btn-sm');
    expect(host.querySelector('[data-testid="open-brief"]')!.className).toContain('btn-sm');
  });
});
