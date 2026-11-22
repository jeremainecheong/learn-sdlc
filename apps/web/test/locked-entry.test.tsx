// @vitest-environment jsdom
import { act, startTransition, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseSummary } from '@learnsdlc/shared';

/**
 * A phase just opened by Continue never says "<Phase> is locked".
 *
 * Continue (`PhaseGateBanner`) records the advance, invalidates the shell's
 * held project and pushes the next phase's room at once. The provider keeps
 * the copy it holds on screen while a fresh one is fetched (four requests in
 * a row), and in that copy the next phase is still `locked`. The workspace
 * layout finds a phase that has no held detail yet in `enrollment.phases`, so
 * the room's first render was the locked page: the heading "Testing is
 * locked" and the notice "Pass your current phase before opening Testing.",
 * a live region, read out by an accessibility reader before the room
 * replaced them.
 *
 * Mounted for real: the project provider and its cache, the workspace layout,
 * the banner, its merge sheet and its door. Only the network (held answers,
 * one of them held back to stand for the slow refetch), the router, the
 * session and the room underneath are controlled. Every heading the layout
 * asks the page frame to draw is recorded, committed or not, so a locked
 * heading drawn for one frame is caught.
 */

const rig = vi.hoisted(() => ({
  token: 'learner-token',
  params: { phaseId: 'phase-3' },
  path: '/workspace/phase-3',
  navigate: null as null | ((path: string) => void),
  push: vi.fn(),
  headings: [] as string[],
  projects: vi.fn(),
  enrollment: vi.fn(),
  analytics: vi.fn(),
  summaries: vi.fn(),
  map: vi.fn(),
  reflect: vi.fn(),
  advance: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => rig.params,
  usePathname: () => rig.path,
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: rig.push, replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('@/lib/api', () => ({
  api: {
    projects: rig.projects,
    myEnrollment: rig.enrollment,
    analyticsMe: rig.analytics,
    phaseSummaries: rig.summaries,
    projectMap: rig.map,
    reflect: rig.reflect,
    advance: rig.advance,
  },
  getToken: () => rig.token,
  ApiError: class extends Error {},
  describeError: (_error: unknown, fallback: string) => fallback,
}));
vi.mock('@/lib/session', () => ({
  useSession: () => ({ id: 'learner', role: 'LEARNER' }),
  onSessionEnd: () => () => {},
  ownedByToken: (drop: () => void) => {
    let owner: string | null = null;
    return () => { if (owner !== rig.token) { drop(); owner = rig.token; } };
  },
}));
vi.mock('@/lib/project-map', () => ({ CARD_MAP: { compact: true, showLocked: true }, putMap: vi.fn(), resetMaps: vi.fn(), staleMaps: vi.fn() }));
vi.mock('@/lib/records', () => ({ resetRecords: vi.fn(), staleRecords: vi.fn(), rememberTaskScopes: vi.fn(), refreshPhaseRecords: vi.fn() }));
vi.mock('@/lib/review-history', () => ({ resetReviewHistory: vi.fn(), staleReviewHistory: vi.fn() }));
// The page frame records the heading it is asked for; the door helpers are the real ones.
vi.mock('@/components/shell', async () => {
  const routes = await vi.importActual<typeof import('@/components/shell/routes')>('@/components/shell/routes');
  return {
    WorkPage: ({ heading, testId, children }: { heading: string; testId: string; children: ReactNode }) => {
      rig.headings.push(heading);
      return <main data-testid={testId}><h1>{heading}</h1>{children}</main>;
    },
    doorWithTasks: routes.doorWithTasks,
    phaseDoorHref: routes.phaseDoorHref,
    quizHref: routes.quizHref,
  };
});
vi.mock('@/components/workspace/requirements/RequirementsWorkspace', () => ({ RequirementsWorkspace: () => null }));
vi.mock('@/components/shell/PhaseTutorial', () => ({ PhaseTutorialProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/workspace/QuickCheck', () => ({ QuickCheckProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));

import PhaseWorkspaceLayout from '@/app/(app)/workspace/[phaseId]/layout';
import { PhaseGateBanner } from '@/components/workspace/PhaseGateBanner';
import { ProjectProvider, invalidateProject, resetProject, useProject } from '@/lib/useProject';

const KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;
const TITLES = ['Requirements', 'Design', 'Implementation', 'Testing', 'Deployment', 'Maintenance'];
type Status = PhaseSummary['status'];

const summary = (order: number, status: Status): PhaseSummary => ({
  id: `phase-${order}`,
  key: KEYS[order - 1],
  order,
  title: TITLES[order - 1],
  status,
  bestScore: status === 'passed' ? 100 : null,
  attempts: status === 'passed' ? 1 : 0,
  reflection: null,
  passedAt: status === 'passed' ? '2026-11-10T05:00:00.000Z' : null,
  opensAt: null,
  dueAt: null,
});

/**
 * The enrolment standing on phase `current`: the phases before it passed, it
 * passed too where `passedHere` says so (Continue is offered) or in progress,
 * and the phases after it locked.
 */
const enrolment = (current: number, passedHere = false): EnrollmentView => ({
  id: 'enrolment-1',
  projectSlug: 'deadline-badge',
  projectTitle: 'Deadline badge',
  currentPhaseOrder: current,
  completed: false,
  startedAt: '2026-11-10T04:00:00.000Z',
  completedAt: null,
  phases: [1, 2, 3, 4, 5, 6].map((order) => summary(order, order < current || (order === current && passedHere) ? 'passed' : order === current ? 'in_progress' : 'locked')),
}) as EnrollmentView;

/** The summaries the API answers for the open phases: never a locked one. */
const summariesOf = (view: EnrollmentView): PhaseDetail[] =>
  view.phases.filter((one) => one.status !== 'locked').map((one) => ({ ...one, view: 'summary', files: [], tasks: [] }) as unknown as PhaseDetail);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** Implementation's room: the banner over the phase the shell holds, as the rooms pass it. */
function ImplementationRoom() {
  const project = useProject();
  const phase = project.details['phase-3'] ?? null;
  return <PhaseGateBanner phaseId="phase-3" phase={phase} isLast={false} />;
}

/** The App Router, as far as this layout sees it: a path, and a push that moves it in a transition. */
function Router() {
  const [, setPath] = useState(rig.path);
  rig.navigate = (path) => {
    rig.path = path;
    rig.params = { phaseId: path.split('/')[2] };
    setPath(path);
  };
  const room = rig.params.phaseId === 'phase-3' ? <ImplementationRoom /> : <p data-testid="room">{rig.params.phaseId} room</p>;
  return <PhaseWorkspaceLayout>{room}</PhaseWorkspaceLayout>;
}

let root: Root;
let host: HTMLDivElement;
const open = async (path: string) => {
  rig.path = path;
  rig.params = { phaseId: path.split('/')[2] };
  await act(async () => root.render(<ProjectProvider><Router /></ProjectProvider>));
};
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
/** Continue, with no reflection: the sheet's own button, as a learner presses it. */
const pressContinue = async () => {
  await act(async () => { fireEvent.click(byTestId('open-reflection')!); });
  await act(async () => { fireEvent.click(document.querySelector<HTMLButtonElement>('[data-testid="reflection-submit"]')!); });
};

beforeEach(() => {
  vi.clearAllMocks();
  rig.token = 'learner-token';
  rig.headings = [];
  resetProject();
  const before = enrolment(3, true);
  rig.projects.mockResolvedValue([{ slug: 'deadline-badge', title: 'Deadline badge' }]);
  rig.enrollment.mockResolvedValue(before);
  rig.analytics.mockResolvedValue(null);
  rig.summaries.mockResolvedValue(summariesOf(before));
  rig.map.mockResolvedValue(null);
  rig.reflect.mockResolvedValue({ saved: true });
  rig.advance.mockResolvedValue(enrolment(4));
  // Next's router.push moves the page in a transition.
  rig.push.mockImplementation((path: string) => startTransition(() => rig.navigate?.(path)));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('Continue into the phase it has just opened', () => {
  it('never draws "Testing is locked" while the fresh project is still on its way', async () => {
    await open('/workspace/phase-3');
    expect(byTestId('gate-banner')).not.toBeNull();
    // The refetch Continue starts is held back: the server answers slowly.
    const after = enrolment(4);
    const slow = deferred<EnrollmentView>();
    rig.enrollment.mockReturnValueOnce(slow.promise);
    rig.summaries.mockResolvedValue(summariesOf(after));
    rig.headings = [];

    await pressContinue();

    expect(rig.advance).toHaveBeenCalledWith('phase-3');
    expect(rig.push).toHaveBeenCalledWith('/workspace/phase-4');
    expect(rig.path).toBe('/workspace/phase-4');
    // Nothing ever said the phase was locked, and the room is drawn.
    expect(rig.headings.filter((heading) => /is locked/.test(heading))).toEqual([]);
    expect(byTestId('phase-locked')).toBeNull();
    expect(byTestId('room')?.textContent).toBe('phase-4 room');
    expect(host.textContent).not.toContain('Pass your current phase before opening Testing.');

    // The fresh copy lands: still the room.
    await act(async () => { slow.resolve(after); await Promise.resolve(); });
    expect(byTestId('room')?.textContent).toBe('phase-4 room');
    expect(rig.headings.filter((heading) => /is locked/.test(heading))).toEqual([]);
  });
});

describe('a phase that is locked stays locked (the gate does not weaken)', () => {
  it('opened by its own address, says it is locked, why, and the way back', async () => {
    await open('/workspace/phase-5');
    expect(byTestId('phase-locked')).not.toBeNull();
    expect(host.querySelector('h1')?.textContent).toBe('Deployment is locked');
    expect(host.textContent).toContain('Pass your current phase before opening Deployment.');
    expect(host.querySelector('a[href="/workspace/phase-3"]')?.textContent).toBe('Open current phase');
    expect(byTestId('room')).toBeNull();
  });

  it('after Continue opens Testing, the phase after it is still locked from its own address', async () => {
    await open('/workspace/phase-3');
    const slow = deferred<EnrollmentView>();
    rig.enrollment.mockReturnValueOnce(slow.promise);
    await pressContinue();
    expect(byTestId('room')?.textContent).toBe('phase-4 room');

    // A bookmark to Deployment while the refetch is still out: the advance's own answer holds it locked.
    await act(async () => { rig.navigate?.('/workspace/phase-5'); });
    expect(host.querySelector('h1')?.textContent).toBe('Deployment is locked');
    expect(byTestId('room')).toBeNull();

    // And once the fresh copy lands.
    await act(async () => { slow.resolve(enrolment(4)); await Promise.resolve(); });
    expect(host.querySelector('h1')?.textContent).toBe('Deployment is locked');
    expect(host.textContent).toContain('Pass your current phase before opening Deployment.');
  });

  it('takes no answer that is not for the enrolment it holds', async () => {
    await open('/workspace/phase-4');
    expect(host.querySelector('h1')?.textContent).toBe('Testing is locked');
    const slow = deferred<EnrollmentView>();
    rig.enrollment.mockReturnValueOnce(slow.promise);
    // Another enrolment's answer, or another project's, opens nothing here.
    await act(async () => { invalidateProject({ ...enrolment(4), id: 'enrolment-2' } as EnrollmentView); });
    await act(async () => { invalidateProject({ ...enrolment(4), projectSlug: 'tasktrackr' } as EnrollmentView); });
    expect(host.querySelector('h1')?.textContent).toBe('Testing is locked');
    expect(byTestId('room')).toBeNull();
    // The refetch answers what the server holds: still locked.
    await act(async () => { slow.resolve(enrolment(3, true)); await Promise.resolve(); });
    expect(host.querySelector('h1')?.textContent).toBe('Testing is locked');
  });
});
