// @vitest-environment jsdom
/**
 * Submit waits for the countersignature, in the change-request room.
 *
 * Every room turns Submit off while a task that passed its review waits on
 * the teacher's countersignature, because a refused resubmit clears the
 * task's place in the sign-off queue (the API's task roll-up). Here the
 * change room's Submit button and ⌘↵ are off with SIGN_OFF_SUBMIT_REASON,
 * nothing reaches the API, and every other state is unaffected.
 *
 * The REAL page is mounted; the shell's held project and the network are
 * stood in for, as in signoff-chip-wiring.test.tsx.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseKey, PhaseSummary, PhaseTaskView, SubmissionView } from '@learnsdlc/shared';

const PHASE_ID = 'rc-r3-maintenance';
const rig = vi.hoisted(() => ({ project: null as unknown, request: vi.fn(), fetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: 'rc-r3-maintenance' }),
  usePathname: () => '/workspace/rc-r3-maintenance/change',
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
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), request: rig.request }));
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
  useSession: () => ({ id: 'rc-learner', role: 'LEARNER', displayName: 'Learner', avatar: 0, cohort: 'default', profileVersion: 0 }),
}));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));

import ChangeRequestPage from '@/app/(app)/workspace/[phaseId]/change/page';
import { SIGN_OFF_SUBMIT_REASON } from '@/components/workspace/signoff-status';

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const CODE = 'src/app.ts';

type TaskOver = Partial<PhaseTaskView> & Record<string, unknown>;
const theTask = (over: TaskOver = {}): PhaseTaskView =>
  ({
    key: 'main', order: 1, required: true, title: 'The change', artefactType: 'code', primaryPath: CODE, files: [CODE],
    evidence: 'signed-off', sealed: true, status: 'submitted', awaitingSignOff: true, attempts: 1, bestScore: 88,
    passedAt: null, lastSubmissionId: 'rev-1', resetAt: null, solution: { available: false, files: 0, readAt: null },
    ...over,
  }) as unknown as PhaseTaskView;

const review = (id: string, passed: boolean): SubmissionView =>
  ({ id, taskKey: 'main', status: 'completed', passed, score: passed ? 88 : 40, attempt: 1, createdAt: '2026-10-02T05:00:00.000Z', report: null }) as unknown as SubmissionView;

function changeDetail(task: PhaseTaskView, lastSubmission: SubmissionView | null, status = 'submitted'): PhaseDetail {
  return {
    id: PHASE_ID, key: 'maintenance', order: 6, title: 'Maintenance', status, attempts: 1, bestScore: 88, reflection: null,
    passedAt: status === 'passed' ? '2026-10-02T05:10:00.000Z' : null, opensAt: null, dueAt: null, projectSlug: 'tasktrackr',
    intro: 'The change.', taskPanel: 'The brief.', objectives: [], artifactKind: 'code',
    // a Maintenance with its change request, as every Maintenance of the code kind now ships (an older one is refused)
    change: { ticket: { id: 'CR-2', title: 'Comments on tasks', summary: 'Tasks carry comments.', acceptance: [{ id: 'AC-1', line: 'A task lists its comments.' }] }, contract: false, floor: { minImpact: 0, minContract: 0, minTests: 0, requireRelease: false, traceEveryAcceptance: false } },
    files: [{ path: CODE, content: 'export const x = 1;\n', editable: true, language: 'typescript' }],
    rubric: { passThreshold: 70, criteria: [] },
    tasks: [task],
    taskCounts: { total: 1, required: 1, passed: task.status === 'passed' ? 1 : 0, passedRequired: task.status === 'passed' ? 1 : 0 },
    canRun: false, canPreview: false, runLabel: 'Run tests', links: [], lastSubmission,
    updatedAt: '2026-10-02T05:00:00.000Z', workspaceUpdatedAt: '2026-10-02T04:50:00.000Z', stakeholder: null, scenario: 'own',
    provenance: { phaseKey: 'maintenance', referenceName: null, rollup: 'own', intro: 'own', interview: null, files: [], tasks: [], roomTask: 'other' },
  } as unknown as PhaseDetail;
}

function shell(detail: PhaseDetail) {
  const phases = KEYS.map((key, at) =>
    key === 'maintenance'
      ? ({ ...detail, view: undefined } as unknown as PhaseSummary)
      : ({ id: `rc-${key}`, key, order: at + 1, title: key, status: 'passed', attempts: 1, bestScore: 90, reflection: null, passedAt: null, opensAt: null, dueAt: null, scenario: 'own' } as PhaseSummary),
  );
  const enrollment = {
    id: 'rc-enrolment', projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr — the reference', currentPhaseOrder: 6, completed: false,
    startedAt: '2026-10-02T00:00:00Z', completedAt: null, projectIsDefault: true, phases,
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

async function mount(detail: PhaseDetail) {
  rig.project = shell(detail);
  rig.request.mockImplementation(async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === `/phases/${PHASE_ID}`) return detail;
    if (path.includes('/submit')) throw new Error('a resubmit reached the API');
    return [];
  });
  rig.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(JSON.stringify(String(input).endsWith(`/phases/${PHASE_ID}`) ? detail : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  await act(async () => { root.render(<ChangeRequestPage />); });
  for (let round = 0; round < 5; round += 1) await act(async () => { await Promise.resolve(); });
}
const submitButton = () => host.querySelector<HTMLButtonElement>('[data-testid="phase-maintenance-submit"]');
const describedBy = (button: HTMLButtonElement) => {
  const id = button.getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent ?? null : null;
};
const pressSubmitKeys = () => act(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  for (let round = 0; round < 3; round += 1) await Promise.resolve();
});
const submits = () => calls.filter((one) => one.includes('/submit'));

describe('the change room while its task waits on the countersignature', () => {
  it('Submit PR-6 is off and says why, and ⌘↵ hands nothing in', async () => {
    await mount(changeDetail(theTask(), review('rev-1', true)));
    const button = submitButton();
    expect(button, 'the change room is drawn').not.toBeNull();
    expect(button!.disabled).toBe(true);
    expect(describedBy(button!)).toBe(SIGN_OFF_SUBMIT_REASON);
    expect(button!.getAttribute('title')).toBe(SIGN_OFF_SUBMIT_REASON);
    act(() => button!.click());
    await pressSubmitKeys();
    expect(submits()).toEqual([]);
  });

  it('the verdict that just landed holds the slot before the row knows it (a passing revision newer than the row)', async () => {
    await mount(changeDetail(theTask({ awaitingSignOff: false }), review('rev-2', true)));
    expect(submitButton()!.disabled).toBe(true);
    expect(describedBy(submitButton()!)).toBe(SIGN_OFF_SUBMIT_REASON);
    await pressSubmitKeys();
    expect(submits()).toEqual([]);
  });

  it('after the countersignature Submit is on with no reason', async () => {
    await mount(changeDetail(theTask({ status: 'passed', awaitingSignOff: false, passedAt: '2026-10-02T05:10:00.000Z' }), review('rev-1', true), 'passed'));
    expect(submitButton()!.disabled).toBe(false);
    expect(submitButton()!.getAttribute('aria-describedby')).toBeNull();
  });

  it('a refused review leaves Submit on', async () => {
    await mount(changeDetail(theTask({ awaitingSignOff: false, bestScore: 40 }), review('rev-1', false)));
    expect(submitButton()!.disabled).toBe(false);
    expect(submitButton()!.getAttribute('aria-describedby')).toBeNull();
  });
});
