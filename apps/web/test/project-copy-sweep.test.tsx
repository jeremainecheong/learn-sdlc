// @vitest-environment jsdom
/**
 * No learner sentence names the reference project unless the learner is on
 * it, decided per phase through the phase's provenance, and every door to a
 * lesson asks the one predicate.
 *
 * The lessons (`components/learn/**`) are written about the reference project
 * and are not renamed; what varies is who is led to them. The sites: the
 * phase strip's "Optional phase guide", the case file's
 * aside, the sidebar's and the search's "Learn", the catalogue itself, Home's
 * "Explore lessons" and "Read the optional guide", the feedback page's nudge,
 * the warm-up offer and the phase tutorial's last step. `/learn/:phase` direct
 * entry is pinned in `teacher-project-story-desk-copy`.
 *
 * Four enrolments:
 * - OWN: a teacher's project whose six phases are all the teacher's own;
 * - FORK: a teacher's copy whose Requirements and Design are the teacher's and
 *   whose last four phases are still the reference project's application;
 * - OLDER: a teacher's project from an API that sends no provenance and no
 *   `projectIsDefault` (fail closed: no lesson doors);
 * - DEFAULT: the platform default, every phase the reference; every door open.
 *
 * The shell's project state is the seam (`useProjectMaybe`/`useProject`), as in
 * `teacher-project-story-desk-copy`.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseKey, PhaseSummary } from '@learnsdlc/shared';

const shell = vi.hoisted(() => ({ state: null as unknown, role: 'LEARNER' as string | null }));
const routed = vi.hoisted(() => ({ phaseId: '', path: '/dashboard', search: '' }));
vi.mock('@/lib/useProject', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProjectMaybe: () => shell.state,
  useProject: () => {
    if (!shell.state) throw new Error('no provider');
    return shell.state;
  },
}));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => (shell.role ? { id: 'learner-one', role: shell.role, displayName: 'Lee Learner' } : null),
  useRole: () => shell.role,
}));
vi.mock('@/lib/view-as', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useViewAs: () => null,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => routed.path,
  useSearchParams: () => new URLSearchParams(routed.search),
  useParams: () => ({ phaseId: routed.phaseId }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/experience/shared', async (original) => ({
  ...(await original<typeof import('@/components/experience/shared')>()),
  useReviews: () => ({ reviews: [], loading: false, refreshing: false, error: null, refreshError: null, refresh: () => undefined }),
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: () => null }));
vi.mock('@/components/workspace/requirements/RequirementsWorkspace', () => ({ RequirementsWorkspace: () => null }));
// The search's rows as the bar hands them over.
vi.mock('@/components/shell/Palette', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Palette: ({ groups }: { groups: { label: string; items: { label: string }[] }[] }) => (
    <ul data-testid="palette-rows">
      {groups.flatMap((group) => group.items.map((item) => <li key={`${group.label}:${item.label}`}>{item.label}</li>))}
    </ul>
  ),
}));

import { Brief } from '@/components/phases/Brief';
import { PhaseStrip } from '@/components/shell/WorkPage';
import { Sidebar } from '@/components/shell/Sidebar';
import { ShellProvider } from '@/components/shell/ShellProvider';
import { navigationItems } from '@/components/shell/navigation';
import { phaseTutorialMarks } from '@/components/shell/tours';
import { CoachMarks } from '@/components/shell/CoachMarks';
import { usePhaseTutorialReady } from '@/components/shell/PhaseTutorial';
import { marksFor, replayTour } from '@/components/shell/tours';
import { TopBar } from '@/components/shell/TopBar';
import PhaseWorkspaceLayout from '@/app/(app)/workspace/[phaseId]/layout';
import LearnPage from '@/app/(app)/learn/page';
import FeedbackPage from '@/app/(app)/feedback/page';
import DashboardPage from '@/app/(app)/dashboard/page';
import { QuickStartGuide } from '@/components/landing/QuickStartGuide';
import TermsPage from '@/app/terms/page';
import { anyLessonsOffered, lessonsOfferedOn } from '@/lib/scenario';
import { stubMatchMedia } from './support/dom';

const REFERENCE = /tasktrackr/i;
const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const TITLES = ['Requirements', 'Design', 'Implementation', 'Testing', 'Deployment', 'Maintenance'];

type Scenario = PhaseSummary['scenario'];

function summary(key: PhaseKey, scenario: Scenario | undefined, over: Partial<PhaseSummary> = {}): PhaseSummary {
  const i = KEYS.indexOf(key);
  return {
    id: `phase-${key}`,
    key,
    order: i + 1,
    title: TITLES[i],
    status: i === 0 ? 'in_progress' : 'locked',
    bestScore: null,
    attempts: 0,
    reflection: null,
    passedAt: null,
    opensAt: null,
    dueAt: null,
    ...(scenario ? { scenario } : {}),
    ...over,
  } as PhaseSummary;
}

function enrollment(title: string, scenarios: (key: PhaseKey) => Scenario | undefined, projectIsDefault: boolean | undefined, current = 1): EnrollmentView {
  return {
    id: 'enrol-1',
    projectSlug: title === 'TaskTrackr' ? 'reference-slug' : 'room-desk',
    projectTitle: title === 'TaskTrackr' ? 'TaskTrackr — a task manager you can run' : `${title} — book a meeting room`,
    currentPhaseOrder: current,
    completed: false,
    startedAt: '2026-09-30T00:00:00Z',
    completedAt: null,
    phases: KEYS.map((key, i) => summary(key, scenarios(key), { status: i + 1 < current ? 'passed' : i + 1 === current ? 'in_progress' : 'locked' })),
    ...(projectIsDefault === undefined ? {} : { projectIsDefault }),
  } as EnrollmentView;
}

const OWN = (current = 1) => enrollment('RoomDesk', () => 'own', false, current);
const FORK = (current = 1) => enrollment('RoomDesk', (key) => (key === 'requirements' || key === 'design' ? 'own' : 'reference'), false, current);
const OLDER = (current = 1) => enrollment('RoomDesk', () => undefined, undefined, current);
const DEFAULT = (current = 1) => enrollment('TaskTrackr', () => 'reference', true, current);

function detail(key: PhaseKey): PhaseDetail {
  return {
    id: `phase-${key}`,
    key,
    title: TITLES[KEYS.indexOf(key)],
    intro: 'This phase is about the room booking desk.',
    objectives: ['Build the desk.'],
    files: [],
    rubric: { passThreshold: 70, criteria: [] },
  } as unknown as PhaseDetail;
}

/** The shell's project state: an enrolment, its current phase and the details it holds. */
function useShell(enrol: EnrollmentView | null, over: Record<string, unknown> = {}) {
  shell.state = {
    enrollment: enrol,
    currentPhase: enrol?.phases.find((one) => one.order === enrol.currentPhaseOrder),
    details: {},
    projects: [{ slug: enrol?.projectSlug ?? '', hasWarmup: true }],
    slug: enrol?.projectSlug ?? '',
    loading: false,
    error: null,
    refresh: () => undefined,
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? '';
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const lessonLinks = () => Array.from(host.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '').filter((href) => href === '/learn' || href.startsWith('/learn/'));
const render = (node: ReactNode) => act(() => root.render(<>{node}</>));

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  stubMatchMedia();
  window.localStorage.clear();
  shell.state = null;
  shell.role = 'LEARNER';
  routed.phaseId = '';
  routed.path = '/dashboard';
  routed.search = '';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/* ------------------------------ the predicate ------------------------------ */

describe('the readers of an enrolment', () => {
  it('offers a phase lesson per phase, fail closed, and keeps every door with no enrolment', () => {
    expect(lessonsOfferedOn(DEFAULT(), 'requirements')).toBe(true);
    expect(lessonsOfferedOn(OWN(), 'implementation')).toBe(false);
    expect(lessonsOfferedOn(FORK(), 'requirements')).toBe(false);
    expect(lessonsOfferedOn(FORK(), 'implementation')).toBe(true);
    expect(lessonsOfferedOn(OLDER(), 'implementation')).toBe(false);
    expect(lessonsOfferedOn({ ...OLDER(), projectIsDefault: true }, 'design')).toBe(true);
    expect(lessonsOfferedOn(null, 'design')).toBe(true);
    expect(anyLessonsOffered(OWN())).toBe(false);
    expect(anyLessonsOffered(OLDER())).toBe(false);
    expect(anyLessonsOffered(FORK())).toBe(true);
    expect(anyLessonsOffered(DEFAULT())).toBe(true);
    expect(anyLessonsOffered(null)).toBe(true);
    expect(anyLessonsOffered({ phases: [], projectIsDefault: false })).toBe(false);
    expect(anyLessonsOffered({ phases: [], projectIsDefault: true })).toBe(true);
  });
});

/* ------------------------- the phase strip and brief ------------------------ */

describe('the phase strip’s "Optional phase guide"', () => {
  it('is not drawn on a phase that is the teacher’s own, nor on an older payload of a teacher’s project', () => {
    for (const enrol of [OWN(), FORK(), OLDER()]) {
      useShell(enrol);
      render(<PhaseStrip phase={{ key: 'requirements', title: 'Requirements' }} />);
      expect(host.querySelector('.phase-strip-guide')).toBeNull();
      expect(lessonLinks()).toEqual([]);
    }
  });

  it('is drawn on a phase still the reference project’s, on a copy and on the default', () => {
    useShell(FORK());
    render(<PhaseStrip phase={{ key: 'implementation', title: 'Implementation' }} />);
    expect(host.querySelector('.phase-strip-guide')?.getAttribute('href')).toBe('/learn/implementation');
    useShell(DEFAULT());
    render(<PhaseStrip phase={{ key: 'requirements', title: 'Requirements' }} />);
    expect(host.querySelector('.phase-strip-guide')?.getAttribute('href')).toBe('/learn/requirements');
    expect(host.querySelector('.phase-strip-guide')?.textContent).toBe('Optional phase guide');
  });
});

describe('the case file', () => {
  it('draws no guide aside and offers no guide on a teacher’s own phase', () => {
    useShell(OWN());
    render(<Brief phase={OWN().phases[0]} detail={detail('requirements')} onBegin={() => undefined} />);
    expect(byId('brief-about')).toBeNull();
    expect(lessonLinks()).toEqual([]);
    expect(text()).not.toMatch(/phase guide|optional guide/i);
    expect(text()).not.toMatch(REFERENCE);
    expect(host.querySelector('footer span')?.textContent).toBe('Begin with the work.');
  });

  it('keeps today’s aside and footer on the default project', () => {
    useShell(DEFAULT());
    render(<Brief phase={DEFAULT().phases[0]} detail={detail('requirements')} onBegin={() => undefined} />);
    expect(byId('brief-about')?.querySelector('a')?.getAttribute('href')).toBe('/learn/requirements');
    expect(byId('brief-about')?.textContent).toContain('Open the phase guide');
    expect(host.querySelector('footer span')?.textContent).toBe('Begin with the work, or study the optional guide first.');
  });

  // Per phase, not per project. On a copy the
  // teacher's Requirements offers no guide while the reference's
  // Implementation does, so a whole-project gate fails one of the two.
  it('asks per phase on a copy: none on the teacher’s Requirements, the guide on the reference’s Implementation', () => {
    useShell(FORK());
    render(<Brief phase={FORK().phases[0]} detail={detail('requirements')} onBegin={() => undefined} />);
    expect(byId('brief-about')).toBeNull();
    expect(lessonLinks()).toEqual([]);
    expect(text()).not.toMatch(REFERENCE);
    expect(host.querySelector('footer span')?.textContent).toBe('Begin with the work.');
    useShell(FORK(3));
    render(<Brief phase={FORK(3).phases[2]} detail={detail('implementation')} onBegin={() => undefined} />);
    expect(byId('brief-about')?.querySelector('a')?.getAttribute('href')).toBe('/learn/implementation');
    expect(host.querySelector('footer span')?.textContent).toBe('Begin with the work, or study the optional guide first.');
  });
});

/* ------------------------------ Learn, by name ------------------------------ */

describe('the sidebar’s "Learn"', () => {
  const draw = () => render(<ShellProvider><Sidebar /></ShellProvider>);

  it('is not drawn when no phase of the project offers a lesson', () => {
    for (const enrol of [OWN(), OLDER()]) {
      useShell(enrol);
      draw();
      expect(byId('nav-learn')).toBeNull();
      expect(byId('nav-progress')).not.toBeNull();
    }
  });

  it('is drawn on a copy whose last four phases are the reference, and on the default', () => {
    for (const enrol of [FORK(), DEFAULT()]) {
      useShell(enrol);
      draw();
      expect(byId('nav-learn')?.getAttribute('href')).toBe('/learn');
    }
  });

  // On a cold load the column draws what it settled on last time, so a
  // project with no lesson does not draw "Learn" and then take it away from
  // under the rows below it.
  it('holds the row set it settled on last time while the enrolment is loading', () => {
    window.localStorage.setItem('lsdlc_nav_rows', JSON.stringify(['home', 'work', 'progress', 'feedback', 'join']));
    useShell(null, { loading: true });
    draw();
    expect(byId('nav-learn')).toBeNull();
    expect(byId('nav-progress')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    window.localStorage.setItem('lsdlc_nav_rows', JSON.stringify(['home', 'work', 'learn', 'progress', 'feedback', 'join']));
    useShell(null, { loading: true });
    draw();
    expect(byId('nav-learn')?.getAttribute('href')).toBe('/learn');
  });
});

describe('the search’s "Learn"', () => {
  it('is listed only when a lesson is offered', () => {
    const labels = (lessons: boolean) => navigationItems('LEARNER', undefined, false, undefined, lessons).map((item) => item.label);
    expect(labels(false)).not.toContain('Learn');
    expect(labels(false)).toContain('Progress');
    expect(labels(true)).toContain('Learn');
    // A caller that says nothing keeps the full list.
    expect(navigationItems('LEARNER').map((item) => item.label)).toContain('Learn');
  });

  // The mounted bar, not only the pure list.
  it('is what the mounted search lists: not on a teacher’s own project, listed on a copy and on the default', () => {
    const rows = () => Array.from(host.querySelectorAll('[data-testid="palette-rows"] li')).map((li) => li.textContent);
    useShell(OWN());
    render(<ShellProvider><TopBar /></ShellProvider>);
    expect(rows()).toContain('Progress');
    expect(rows()).not.toContain('Learn');
    for (const enrol of [FORK(), DEFAULT()]) {
      useShell(enrol);
      render(<ShellProvider><TopBar /></ShellProvider>);
      expect(rows()).toContain('Learn');
    }
  });

  it('does not promise a lesson for every phase', () => {
    const learn = navigationItems('LEARNER').find((item) => item.label === 'Learn');
    expect(learn?.detail).not.toMatch(/every phase/i);
  });
});

describe('the catalogue', () => {
  it('lists only the guides of phases still the reference project’s', () => {
    useShell(FORK());
    render(<LearnPage />);
    const guides = lessonLinks().filter((href) => href.startsWith('/learn/'));
    expect(guides.sort()).toEqual(['/learn/deployment', '/learn/implementation', '/learn/maintenance', '/learn/testing']);
    expect(text()).not.toMatch(REFERENCE);
  });

  it('offers no guide, and says why, when every phase is the teacher’s own', () => {
    useShell(OWN());
    render(<LearnPage />);
    expect(lessonLinks()).toEqual([]);
    expect(byId('learn-none')).not.toBeNull();
    expect(text()).not.toMatch(REFERENCE);
  });

  // With no guide, nothing on the page invites
  // the learner back for one, and the reason is true of every such project
  // (an older payload, or a phase that is mixed only because of a quiz).
  it('invites no return and claims no authorship when no guide is offered', () => {
    for (const enrol of [OWN(), OLDER()]) {
      useShell(enrol);
      render(<LearnPage />);
      expect(byId('learn-none')?.textContent).not.toMatch(/wrote every phase/i);
      expect(text()).not.toMatch(/Pick a lesson|Come back here whenever/);
    }
  });

  it('says how many guides there are only by listing them', () => {
    const hero = marksFor('learn').find((mark) => mark.target === 'learn-catalogue');
    expect(hero?.body).not.toMatch(/\bsix\b/i);
  });

  // A cold load draws no guide it may take back.
  it('draws no guide and no "none" note while the enrolment is loading', () => {
    useShell(null, { loading: true });
    render(<LearnPage />);
    expect(lessonLinks()).toEqual([]);
    expect(byId('learn-none')).toBeNull();
    expect(byId('learn-catalogue')?.getAttribute('aria-busy')).toBe('true');
  });

  it('keeps all six guides on the default project', () => {
    useShell(DEFAULT());
    render(<LearnPage />);
    expect(lessonLinks().filter((href) => href.startsWith('/learn/')).sort()).toEqual(KEYS.map((key) => `/learn/${key}`).sort());
    expect(byId('learn-none')).toBeNull();
  });
});

/* ------------------------------ Home and feedback ---------------------------- */

describe('Home', () => {
  it('offers no lesson and names no reference project on a teacher’s own project', () => {
    useShell(OWN());
    render(<DashboardPage />);
    expect(text()).toContain('RoomDesk');
    expect(lessonLinks()).toEqual([]);
    expect(text()).not.toMatch(/Explore lessons|optional guide/);
    expect(text()).not.toMatch(REFERENCE);
  });

  it('reads the phase’s own opening, not the reference story, on a phase that is not the reference’s', () => {
    const enrol = OWN(3);
    enrol.phases[2] = { ...enrol.phases[2], intro: 'Build the booking desk’s availability search.' };
    useShell(enrol);
    render(<DashboardPage />);
    expect(text()).toContain('Build the booking desk’s availability search.');
    expect(text()).not.toMatch(/five (feature )?gaps|overdue/i);
    // No intro in the payload: a sentence true of any project.
    useShell(OWN(4));
    render(<DashboardPage />);
    expect(text()).not.toMatch(/overdue|late marker/i);
  });

  it('offers only the guide of a phase that has one, on a copy', () => {
    useShell(FORK(3));
    render(<DashboardPage />);
    expect(lessonLinks().sort()).toEqual(['/learn', '/learn/implementation']);
  });

  it('offers the catalogue but not the phase guide while the learner is on the teacher’s own phase of a copy', () => {
    useShell(FORK(1));
    render(<DashboardPage />);
    expect(lessonLinks()).toEqual(['/learn']);
    expect(text()).not.toContain('Read the optional guide');
    expect(text()).not.toMatch(REFERENCE);
  });

  it('keeps today’s doors and sentences on the default project', () => {
    useShell(DEFAULT(3));
    render(<DashboardPage />);
    expect(lessonLinks().sort()).toEqual(['/learn', '/learn/implementation']);
    expect(text()).toContain('Complete five gaps across the Python API and TypeScript front end so the contracts become working behaviour.');
  });
});

describe('the feedback page’s nudge', () => {
  it('is not drawn on a teacher’s own phase', () => {
    useShell(OWN());
    render(<FeedbackPage />);
    expect(text()).toContain('Requirements feedback');
    expect(lessonLinks()).toEqual([]);
    expect(text()).not.toContain('A guide when you need it.');
  });

  it('is drawn on the default project', () => {
    useShell(DEFAULT());
    render(<FeedbackPage />);
    expect(lessonLinks()).toEqual(['/learn/requirements']);
  });

  it('follows the phase on a copy: none on the teacher’s Requirements, the Implementation lesson on the reference’s', () => {
    useShell(FORK(1));
    render(<FeedbackPage />);
    expect(text()).toContain('Requirements feedback');
    expect(lessonLinks()).toEqual([]);
    expect(text()).not.toContain('A guide when you need it.');
    expect(text()).not.toMatch(REFERENCE);
    routed.search = 'phase=phase-implementation';
    useShell(FORK(3));
    render(<FeedbackPage />);
    expect(text()).toContain('Implementation feedback');
    expect(lessonLinks()).toEqual(['/learn/implementation']);
  });
});

/* ---------------------------------- the tour -------------------------------- */

describe('the phase tutorial’s last step', () => {
  it('does not send a learner to a guide the strip does not draw', () => {
    const last = (lessons: boolean) => phaseTutorialMarks('requirements', lessons).at(-1)!;
    expect(last(false).body).not.toMatch(/phase guide|lesson/i);
    expect(JSON.stringify(last(false).fallbackSelector ?? '')).not.toContain('phase-strip-guide');
    expect(last(true).body).toContain('Optional phase guide opens the lessons.');
    expect(phaseTutorialMarks('requirements').at(-1)!.body).toBe(last(true).body);
  });

  /** Every step's text of the tour that opens, walked to its last step. */
  function walkTour(): string {
    const seen: string[] = [];
    const next = () => document.querySelector<HTMLButtonElement>('[data-testid="coach-next"]');
    for (let step = 0; step < 12 && next(); step += 1) {
      seen.push(document.querySelector('[data-testid="coach-card"]')?.textContent ?? '');
      if (next()!.textContent === 'Done') break;
      act(() => next()!.click());
    }
    return seen.join(' ');
  }

  it('is drawn from the scope the tour is given', () => {
    const scope = { ownerId: 'learner-one', phaseId: 'phase-requirements', phaseKey: 'requirements' as PhaseKey, ready: true };
    render(<CoachMarks phaseTutorial={{ ...scope, lessons: false }} force />);
    const without = walkTour();
    expect(without).toContain('Replay tutorial brings these steps back.');
    expect(without).not.toMatch(/phase guide/i);
    act(() => root.unmount());
    root = createRoot(host);
    render(<CoachMarks phaseTutorial={scope} force />);
    expect(walkTour()).toContain('Optional phase guide opens the lessons.');
  });

  it('is told by the phase layout, from the shell’s enrolment', () => {
    const enrol = OWN(3);
    const held = { ...detail('implementation'), status: 'in_progress' } as PhaseDetail;
    useShell(enrol, { details: { 'phase-implementation': held } });
    routed.phaseId = 'phase-implementation';
    routed.path = '/workspace/phase-implementation';
    function Tool() {
      usePhaseTutorialReady(held);
      return <nav aria-label="Implementation working area"><button>Code</button></nav>;
    }
    render(
      <PhaseWorkspaceLayout>
        <Tool />
      </PhaseWorkspaceLayout>,
    );
    act(() => replayTour());
    const steps = walkTour();
    expect(steps).toContain('Replay tutorial brings these steps back.');
    expect(steps).not.toMatch(/phase guide/i);
  });

  /** The phase layout's tour, walked, for one phase of one enrolment. */
  function layoutTour(enrol: EnrollmentView, key: PhaseKey): string {
    const held = { ...detail(key), status: 'in_progress' } as PhaseDetail;
    useShell(enrol, { details: { [`phase-${key}`]: held } });
    routed.phaseId = `phase-${key}`;
    routed.path = `/workspace/phase-${key}`;
    const title = TITLES[KEYS.indexOf(key)];
    function Tool() {
      usePhaseTutorialReady(held);
      return (
        <nav aria-label={`${title} working area`}>
          <button>Code</button>
        </nav>
      );
    }
    render(
      <PhaseWorkspaceLayout>
        <Tool />
      </PhaseWorkspaceLayout>,
    );
    act(() => replayTour());
    const steps = walkTour();
    act(() => root.unmount());
    root = createRoot(host);
    return steps;
  }

  it('is told per phase on a copy: no guide on the teacher’s Design, the guide on the reference’s Implementation', () => {
    // Design, not Requirements: the layout swaps Requirements' own room in
    // for its children, and that room is mocked away here.
    const own = layoutTour(FORK(2), 'design');
    expect(own).toContain('Replay tutorial brings these steps back.');
    expect(own).not.toContain('Optional phase guide opens the lessons.');
    const reference = layoutTour(FORK(3), 'implementation');
    expect(reference).toContain('Optional phase guide opens the lessons.');
  });
});

/* -------------------------------- public pages ------------------------------ */

describe('the public pages', () => {
  it('name no project in the quick start and the terms', () => {
    render(<QuickStartGuide />);
    expect(text().length).toBeGreaterThan(0);
    expect(text()).not.toMatch(REFERENCE);
    render(<TermsPage />);
    expect(text()).toContain('reference project');
    expect(text()).not.toMatch(REFERENCE);
  });
});
