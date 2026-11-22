// @vitest-environment jsdom
/**
 * A project of three phases in every view that draws phases (spec 4.5).
 *
 * LearnSDLC has six phases and a project holds the ones its teacher chose.
 * Every view draws the phases the project holds, in order, and says a count
 * only as the project's: no locked Testing, Deployment or Maintenance tile on a
 * project of Requirements, Design and Implementation, no "/ 6", and a phase
 * number is the phase's place in its own project.
 *
 * The pages are the real ones. The project, the session, the reviews and the
 * page frame are the seams (as completion-record-counts.test.tsx draws them),
 * and the teacher's portal is drawn over its API stand-ins (as
 * teacher-roster-set-aside.test.tsx draws it).
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllByTestId, queryAllByTestId } from '@testing-library/dom';
import type {
  EnrollmentView,
  InstructorEnrollmentView,
  InstructorLearnerDetail,
  InstructorPhaseView,
  PhaseKey,
  PhaseSummary,
  SubmissionView,
} from '@learnsdlc/shared';
import { PHASE_COMPLETION_REFUSAL } from '@learnsdlc/shared';
import type { Review } from '@/components/experience/shared';
import type { PhaseRecords } from '@/lib/records';

const rig = vi.hoisted(() => ({
  project: null as unknown,
  reviews: [] as unknown[],
  session: { id: 'learner', role: 'LEARNER', displayName: 'Ada Learner' } as Record<string, string>,
  fresh: vi.fn(),
  history: vi.fn(),
  mine: vi.fn(),
  overview: vi.fn(),
  learner: vi.fn(),
  audit: vi.fn(),
  classProject: vi.fn(),
  assignable: vi.fn(),
  notes: vi.fn(),
  teacherHistory: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() },
}));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => {
    window.addEventListener('popstate', notify);
    return () => window.removeEventListener('popstate', notify);
  };
  return {
    useSearchParams: () =>
      new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => '')),
    useRouter: () => rig.router,
    usePathname: () => window.location.pathname,
    useParams: () => ({}),
  };
});
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  useProject: () => rig.project,
  useProjectMaybe: () => rig.project,
}));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => rig.session,
}));
vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return { ...real, api: { ...real.api, myEnrollment: rig.fresh } };
});
vi.mock('@/lib/api-experience', () => ({
  experienceApi: { history: rig.history, teacherFeedback: rig.notes, teacherSubmissions: rig.teacherHistory },
}));
vi.mock('@/lib/api-cohorts', () => ({ cohortsApi: { mine: rig.mine }, formatJoinCode: (value: string) => value }));
vi.mock('@/lib/api-instructor', () => ({
  instructorApi: {
    overview: rig.overview,
    learner: rig.learner,
    learnersIn: (ids: readonly string[]) => Promise.all(ids.map((id) => rig.learner(id))),
    audit: rig.audit,
    classProject: rig.classProject,
    assignableProjects: rig.assignable,
  },
}));
vi.mock('@/components/experience/shared', async (original) => ({
  ...(await original<typeof import('@/components/experience/shared')>()),
  ExperiencePage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  useReviews: () => ({ reviews: rig.reviews, loading: false, refreshing: false, error: '', refreshError: '', refresh: vi.fn() }),
}));
// The class levers' two panels, drawn as the phases they were handed.
vi.mock('@/components/staff/SchedulePanel', () => ({
  SchedulePanel: ({ phases }: { phases: { key: string; title: string }[] }) => (
    <ul data-testid="schedule-phases">{phases.map((one) => <li key={one.key} data-testid="schedule-phase">{one.title}</li>)}</ul>
  ),
}));
vi.mock('@/components/staff/RegradePanel', () => ({ RegradePanel: () => null }));
vi.mock('@/components/staff/StuckList', () => ({ StuckList: () => null }));
// The class card, as a button that reports an assignment saved on the page.
vi.mock('@/components/staff/ClassProjectCard', () => ({
  ClassProjectCard: ({ onAssigned }: { onAssigned?: () => void }) => <button type="button" data-testid="test-class-assigned" onClick={() => onAssigned?.()} />,
}));
vi.mock('@/components/staff/NotesCard', () => ({ NotesCard: () => null }));
vi.mock('@/components/staff/LearnerTasks', () => ({ LearnerTasks: () => null }));
vi.mock('@/components/experience/ScrollRegion', () => ({ ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: () => null }));

import { allPassed, phaseCountLine, phaseCountUnit, submitLabel } from '@/lib/subset';
import { buildNextSteps } from '@/components/home/derive';
import { buildDossier } from '@/components/dossier/build';
import { Dossier } from '@/components/dossier/Dossier';
import { PhaseLine } from '@/components/ui';
import { PhaseStrip } from '@/components/shell/WorkPage';
import { phaseItems } from '@/components/shell/navigation';
import { ClassLevers } from '@/components/staff/ClassLevers';
import { TeacherPortal } from '@/components/staff/console/TeacherPortal';
import DashboardPage from '@/app/(app)/dashboard/page';
import ProgressPage from '@/app/(app)/progress/page';
import PortfolioPage from '@/app/(app)/artefacts/page';
import CompletionPage from '@/app/(app)/completion/page';
import BriefPage from '@/app/(app)/workspace/[phaseId]/brief/page';
import { CompactPhasePath, PhasePath } from '@/components/experience/shared';
import { LessonReader } from '@/components/learn/LessonReader';
import { webSource } from './support/source-text';
import { phase } from './fixtures';

const passed = (key: PhaseSummary['key'], order: number) => phase(key, order, `p-${key}`, 'passed', { passedAt: `2026-10-0${order}T09:00:00.000Z` });
/** A finished three-phase enrolment, in the shape derive.test.ts builds its enrolments (the fields the views read, cast once). */
const three = {
  id: 'e-three', projectSlug: 'three', projectTitle: 'Three phases', currentPhaseOrder: 3, completed: true,
  startedAt: '2026-10-01T08:00:00.000Z', completedAt: '2026-10-03T10:00:00.000Z',
  phases: [passed('requirements', 1), passed('design', 2), passed('implementation', 3)],
} as unknown as EnrollmentView;

/** The same project with Design open and Implementation not reached. */
const midway = {
  ...three, completed: false, completedAt: null, currentPhaseOrder: 2,
  phases: [passed('requirements', 1), phase('design', 2, 'p-design', 'in_progress'), phase('implementation', 3, 'p-implementation', 'locked')],
} as unknown as EnrollmentView;

/** A verified, passing revision of a phase. */
const verified = (phaseStateId: string, at: string) =>
  ({ id: `s-${phaseStateId}`, phaseStateId, status: 'completed', passed: true, verifiedPass: true, attempt: 1, createdAt: at, reviewUnavailable: false }) as unknown as SubmissionView;
const reviewsOf = (enrollment: EnrollmentView): Review[] =>
  enrollment.phases
    .filter((one) => one.status === 'passed')
    .map((one) => ({ phase: one, submission: verified(one.id, one.passedAt ?? '2026-10-01T09:00:00.000Z') }) as unknown as Review);
const recordsOf = (enrollment: EnrollmentView): Record<string, PhaseRecords> =>
  Object.fromEntries(
    enrollment.phases.map((one) => [one.id, { submissions: one.status === 'passed' ? [verified(one.id, one.passedAt!)] : [], runs: [], chat: [] } as unknown as PhaseRecords]),
  );

const shell = (enrollment: EnrollmentView) => ({
  loading: false, revalidating: false, error: '', enrollment, details: {}, projects: [], slug: enrollment.projectSlug,
  currentPhase: enrollment.phases.find((one) => one.order === enrollment.currentPhaseOrder), analytics: null,
});

let host: HTMLDivElement;
let root: Root;
const render = async (node: ReactNode) => {
  await act(async () => root.render(node));
  for (let round = 0; round < 4; round += 1) await act(async () => { await Promise.resolve(); });
};
beforeEach(() => {
  vi.clearAllMocks();
  rig.session = { id: 'learner', role: 'LEARNER', displayName: 'Ada Learner' };
  window.history.replaceState(null, '', '/dashboard');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a three-phase project in the learner views', () => {
  it('counts its own phases as complete', () => {
    expect(allPassed(three.phases)).toBe(true);
    expect(allPassed(midway.phases)).toBe(false);
    expect(allPassed([])).toBe(false);
    expect(allPassed(undefined)).toBe(false);
    expect(phaseCountLine(3, 3)).toBe('3 / 3 phases passed');
    expect(phaseCountLine(1, 1)).toBe('1 / 1 phase passed');
    expect(phaseCountUnit(3)).toBe('/ 3 phases passed');
    expect(phaseCountUnit(1)).toBe('/ 1 phase passed');
  });
  it("Home's finished plan names the project's count and phases, not six", () => {
    const plan = buildNextSteps(three, {}, three.phases[2]);
    expect(plan.steps[0]).toMatchObject({ title: 'Pass every gate', meta: '3 of 3', detail: 'Every phase of the project, each reviewed and passed.' });
  });
  it("the dossier is complete when the project's phases are, and prints three sections", () => {
    const dossier = buildDossier(three, {}, recordsOf(three), {} as never, null);
    expect(dossier.completedAt).toBe(three.completedAt);
    expect(dossier.totalPhases).toBe(3);
    expect(dossier.phases.map((one) => one.key)).toEqual(['requirements', 'design', 'implementation']);
  });
  it('the dossier still asks for verified evidence of every phase before it says complete', () => {
    expect(buildDossier(three, {}, {}, {} as never, null).completedAt).toBeNull();
  });
  it("the palette numbers each phase by its place in the project", () => {
    const later = { ...midway, phases: [phase('implementation', 1, 'p-i', 'in_progress'), phase('testing', 2, 'p-t', 'locked')] } as unknown as EnrollmentView;
    expect(phaseItems(later.phases).map((item) => item.label)).toEqual(['1. Implementation', '2. Testing']);
  });
});

describe('the dashboard over a three-phase project', () => {
  it('draws three tiles in its phase path and no locked Testing, Deployment or Maintenance', async () => {
    rig.project = shell(midway);
    rig.reviews = reviewsOf(midway);
    await render(<DashboardPage />);
    const tiles = [...host.querySelectorAll('.exp-dashboard-journey .exp-phase-step')];
    expect(tiles.map((tile) => tile.querySelector('strong')?.textContent)).toEqual(['Requirements', 'Design', 'Implementation']);
    expect(host.textContent).toContain('/ 3 phases passed');
    expect(host.textContent).not.toContain('/ 6');
    for (const absent of ['Testing', 'Deployment', 'Maintenance']) expect(host.textContent).not.toContain(absent);
  });
  it('reads a finished three-phase project as a complete journey', async () => {
    rig.project = shell(three);
    rig.reviews = reviewsOf(three);
    await render(<DashboardPage />);
    expect(host.textContent).toContain('A complete journey. A project to show for it.');
    expect(host.querySelector('.exp-record-total')?.textContent).toBe('3/ 3 phases passed');
  });
});

describe('the progress page over a three-phase project', () => {
  it('draws three lanes, three path tiles and the count over three', async () => {
    rig.project = shell(midway);
    rig.reviews = reviewsOf(midway);
    await render(<ProgressPage />);
    const lanes = [...host.querySelectorAll('.exp-journey-labels span')].map((lane) => lane.textContent);
    expect(lanes).toEqual(['Requirements', 'Design', 'Implementation']);
    expect(host.querySelectorAll('.exp-phase-path .exp-phase-step')).toHaveLength(3);
    expect(host.querySelector('.exp-ring strong')?.textContent).toBe('1 / 3');
    for (const absent of ['Testing', 'Deployment', 'Maintenance']) expect(host.textContent).not.toContain(absent);
  });
  it('places a review on its phase lane by the phase’s place', async () => {
    // Stored orders 3 and 4, places 1 and 2: the lane is the place, never the order.
    const later = { ...midway, phases: [passed('implementation', 3), phase('testing', 4, 'p-testing', 'in_progress')], currentPhaseOrder: 4 } as unknown as EnrollmentView;
    rig.project = shell(later);
    rig.reviews = reviewsOf(later);
    await render(<ProgressPage />);
    const dot = host.querySelector<HTMLElement>('.exp-review-dot');
    expect(dot?.style.top).toBe('35px');
  });
  it('draws no dot for a review on a phase the project does not hold', async () => {
    rig.project = shell(midway);
    const stray = { phase: phase('maintenance', 6, 'p-gone', 'passed'), submission: verified('p-gone', '2026-10-04T09:00:00.000Z') } as unknown as Review;
    rig.reviews = [...reviewsOf(midway), stray];
    await render(<ProgressPage />);
    const dots = [...host.querySelectorAll<HTMLElement>('.exp-review-dot')];
    expect(dots).toHaveLength(1);
    expect(dots.every((dot) => parseInt(dot.style.top, 10) >= 35)).toBe(true);
  });
  it("sizes the chart's lanes to the project's count", async () => {
    rig.project = shell(midway);
    rig.reviews = reviewsOf(midway);
    await render(<ProgressPage />);
    expect(host.querySelector<HTMLElement>('.exp-journey')?.style.getPropertyValue('--phase-count')).toBe('3');
  });
});

describe('the artefacts page over a three-phase project', () => {
  it('draws three columns, numbered by place, and no locked Testing, Deployment or Maintenance', async () => {
    rig.project = shell(midway);
    rig.reviews = reviewsOf(midway);
    await render(<PortfolioPage />);
    const columns = [...host.querySelectorAll('.exp-grid-even > .exp-panel')];
    expect(columns.map((column) => column.querySelector('h2')?.textContent)).toEqual(['Requirements', 'Design', 'Implementation']);
    expect(columns.map((column) => column.querySelector('.exp-eyebrow')?.textContent)).toEqual(['Phase 1', 'Phase 2', 'Phase 3']);
    expect(host.textContent).toContain('Three phases / The evidence of each phase');
    for (const absent of ['Testing', 'Deployment', 'Maintenance']) expect(host.textContent).not.toContain(absent);
  });
  it('numbers a later-phase project from 1', async () => {
    const later = { ...midway, phases: [phase('testing', 1, 'p-t', 'in_progress'), phase('maintenance', 2, 'p-m', 'locked')], currentPhaseOrder: 1 } as unknown as EnrollmentView;
    rig.project = shell(later);
    rig.reviews = [];
    await render(<PortfolioPage />);
    const columns = [...host.querySelectorAll('.exp-grid-even > .exp-panel')];
    expect(columns.map((column) => column.querySelector('.exp-eyebrow')?.textContent)).toEqual(['Phase 1', 'Phase 2']);
  });
});

describe('the completion page over a three-phase project', () => {
  it('is complete on three passes and names the three', async () => {
    rig.project = shell(three);
    rig.reviews = reviewsOf(three);
    await render(<CompletionPage />);
    expect(host.textContent).toContain('3 phases');
    expect(host.textContent).toContain('3 passes');
    expect(host.textContent).toContain('Requirements, Design and Implementation.');
    expect(host.textContent).toContain('Based on your 3 passed evidence reviews.');
    expect(host.textContent).toContain('Every phase. Evidence for each one.');
    expect(host.querySelectorAll('.exp-completion-portfolio-item')).toHaveLength(3);
  });
  it('counts what is left over the project’s own phases', async () => {
    rig.project = shell(midway);
    rig.reviews = reviewsOf(midway);
    await render(<CompletionPage />);
    expect(host.textContent).toContain('2 phases to bring it all together.');
    expect(host.querySelectorAll('.exp-completion-mini-path > div')).toHaveLength(3);
  });
  it('refuses the export in the subset rule’s words when a phase is not passed after all', async () => {
    rig.project = shell(three);
    rig.reviews = reviewsOf(three);
    rig.fresh.mockResolvedValue(midway);
    rig.history.mockResolvedValue(reviewsOf(midway).map((one) => one.submission));
    await render(<CompletionPage />);
    const button = [...host.querySelectorAll('button')].find((one) => one.textContent === 'Export project record')!;
    await act(async () => button.click());
    await render(<CompletionPage />);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(PHASE_COMPLETION_REFUSAL);
  });
});

describe('the dossier over a three-phase project', () => {
  it('prints three phase rows numbered 1 to 3, and no section or "Opens in phase" line for an absent phase', async () => {
    const dossier = buildDossier(midway, {}, recordsOf(midway), {} as never, null);
    await render(<Dossier dossier={dossier} />);
    expect(getAllByTestId(host, /^dossier-score-/).map((row) => row.getAttribute('data-testid'))).toEqual(['dossier-score-1', 'dossier-score-2', 'dossier-score-3']);
    expect(host.textContent).toContain('1. Requirements');
    expect(host.textContent).toContain('3. Implementation');
    expect(host.textContent).toContain('Opens in phase 3');
    expect(host.textContent).not.toContain('Opens in phase —');
    for (const title of ['The kill matrix', 'The drill', 'The change record']) expect(host.textContent).not.toContain(title);
    expect(host.textContent).toContain('The issue');
    expect(host.textContent).toContain('The contract');
    // Each section keeps its own id: the kill matrix (7), the drill (8) and
    // the change record (9) are absent, the rest are printed.
    const sections = getAllByTestId(host, /^dossier-section-/).map((one) => one.getAttribute('data-testid'));
    expect(sections).toEqual([1, 2, 3, 4, 5, 6, 10, 11, 12].map((n) => `dossier-section-${n}`));
  });
  it('numbers a phase by its place, so a project that starts at Testing opens it as phase 1', async () => {
    // Stored orders 4 and 6: the numbers printed are the places, 1 and 2.
    const later = { ...midway, phases: [phase('testing', 4, 'p-t', 'in_progress'), phase('maintenance', 6, 'p-m', 'locked')] } as unknown as EnrollmentView;
    await render(<Dossier dossier={buildDossier(later, {}, recordsOf(later), {} as never, null)} />);
    expect(host.textContent).toContain('1. Testing');
    expect(host.textContent).toContain('Opens in phase 2');
    expect(host.textContent).not.toContain('The issue');
    expect(host.textContent).not.toContain('The drill');
  });
});

describe("the phase's place in PhaseLine and the working page's strip", () => {
  it('PhaseLine says "phase 2 of 3"', async () => {
    await render(<PhaseLine phaseKey="design" title="Design" place={2} count={3} />);
    expect(host.textContent).toContain('phase 2 of 3');
  });
  it('the strip says "Phase 2 of 3" from the detail it is handed', async () => {
    rig.project = shell(midway);
    await render(<PhaseStrip phase={{ key: 'design', title: 'Design', place: 2, count: 3 }} />);
    expect(host.querySelector('.phase-strip-detail-panel strong')?.textContent).toBe('Phase 2 of 3');
    // The place is on the strip itself too, as PhaseHeader draws it.
    expect(host.querySelector('.phase-strip-approved > [data-testid="phase-place"]')?.textContent).toBe('Phase 2 of 3');
  });
  it('the strip reads the place from the project when it is handed a bare summary', async () => {
    rig.project = shell(midway);
    await render(<PhaseStrip phase={{ key: 'implementation', title: 'Implementation' }} />);
    expect(host.querySelector('.phase-strip-detail-panel strong')?.textContent).toBe('Phase 3 of 3');
  });
});

describe("the IDE's submit label", () => {
  it('says "Submit for review" on a written phase and names the pull request by place on the rest', () => {
    expect(submitLabel({ key: 'design', place: 2 }, false)).toBe('Submit for review');
    expect(submitLabel({ key: 'requirements', place: 1 }, false)).toBe('Submit for review');
    expect(submitLabel({ key: 'implementation', place: 3 }, false)).toBe('Submit PR-3');
    // A project of Implementation and Testing: Implementation is its first PR.
    expect(submitLabel({ key: 'implementation', place: 1 }, false)).toBe('Submit PR-1');
    expect(submitLabel({ key: 'implementation', place: 3 }, true)).toBe('Submit again');
  });
});

/** A stored version numbered 3 and 4 (spec 10.4): its places are 1 and 2. */
const late = {
  ...midway, projectSlug: 'late', projectTitle: 'Late phases', currentPhaseOrder: 4,
  phases: [passed('implementation', 3), phase('testing', 4, 'p-testing', 'in_progress')],
} as unknown as EnrollmentView;

describe("the learner's sentences say the project's phases, not six", () => {
  it("the brief's missing-phase state points to the project's own phases", async () => {
    rig.project = { ...shell(midway), reload: vi.fn(async () => undefined) };
    await render(<BriefPage />);
    const missing = host.querySelector('[data-testid="brief-missing"]');
    expect(missing?.textContent).toContain('The phases page lists the ones it holds.');
    expect(missing?.textContent).not.toMatch(/six/i);
  });
  it('the artefacts page asks for a pass in every phase of the project', async () => {
    rig.project = shell(midway);
    rig.reviews = reviewsOf(midway);
    await render(<PortfolioPage />);
    expect(host.textContent).toContain('require a recorded pass in every phase of the project.');
    expect(host.textContent).not.toContain('six recorded phase passes');
  });
  it("the lesson reader names a held phase by its place in the project", async () => {
    rig.project = shell(late);
    await render(<LessonReader phaseKey="testing" />);
    expect(host.querySelector('.lesson-page-top > span')?.textContent?.replace(/\s+/g, ' ')).toBe('Phase 2 of 2 / Testing');
  });
  it("the lesson reader numbers a guide the project does not hold as LearnSDLC's, with no project count", async () => {
    rig.project = shell(late);
    await render(<LessonReader phaseKey="design" />);
    const line = host.querySelector('.lesson-page-top > span')?.textContent?.replace(/\s+/g, ' ');
    expect(line).toBe("Guide 2 of LearnSDLC's six / Design");
    expect(line).not.toMatch(/Phase \d of 6/);
  });
});

describe("the phase layouts take the project's count, not six slots", () => {
  it('sets the count on the phase path and the profile strip', async () => {
    await render(
      <>
        <PhasePath phases={midway.phases} />
        <CompactPhasePath phases={midway.phases} reviews={[]} />
      </>,
    );
    for (const selector of ['.exp-phase-path', '.exp-profile-phase-strip']) {
      expect(host.querySelector<HTMLElement>(selector)?.style.getPropertyValue('--phase-count'), selector).toBe('3');
    }
  });
  it('reads the count in the stylesheet where six slots were fixed', () => {
    const css = webSource('components/experience/experience.css');
    const rule = (selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.]/g, '\\.')} \\{[^}]*\\}`))?.[0] ?? '';
    expect(rule('.exp-phase-path')).toContain('repeat(var(--phase-count, 6), minmax(0, 1fr))');
    expect(rule('.exp-profile-phase-strip')).toContain('repeat(var(--phase-count, 6), minmax(0, 1fr))');
    expect(rule('.exp-journey-labels')).toContain('repeat(var(--phase-count, 6), 44px)');
    expect(rule('.exp-journey')).toContain('calc(38px + var(--phase-count, 6) * 44px)');
    expect(rule('.exp-journey-plot')).toContain('calc(38px + var(--phase-count, 6) * 44px)');
  });
});

/* ------------------------------ the teacher's views ------------------------ */

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation'];
const TITLES = ['Requirements', 'Design', 'Implementation'];
/** A three-phase board `done` phases in. */
const board = (done: number): InstructorEnrollmentView => ({
  id: 'enrolment-three', projectSlug: 'three', projectTitle: 'Three phases', currentPhaseOrder: done + 1,
  completed: false, startedAt: '2026-10-01T00:00:00.000Z', completedAt: null,
  phases: KEYS.map((key, i) => ({
    id: `three-${key}`, key, order: i + 1, title: TITLES[i],
    status: i < done ? 'passed' : i === done ? 'in_progress' : 'locked',
    bestScore: null, attempts: 0, reflection: null, passedAt: null, opensAt: null, dueAt: null,
    hints: 0, relianceIndex: 0, passThreshold: 70, unlockedAt: null, lastSubmission: null,
  }) as unknown as InstructorPhaseView),
});
const ADA = {
  userId: 'ada', displayName: 'Ada Example', email: 'ada@example.test', cohort: 'class-one', cohortName: 'Example class',
  createdAt: '2026-09-01T00:00:00.000Z', tokensToday: 0, enrollments: [board(1)],
} as unknown as InstructorLearnerDetail;

describe("the teacher's portal over a class on a three-phase version", () => {
  const open = async (search: string) => {
    rig.session = { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Dana Teacher' };
    rig.mine.mockResolvedValue([{ id: 'class-one', name: 'Example class', joinCode: 'EXAMPLE1', memberCount: 1 }]);
    rig.overview.mockResolvedValue({ learners: [{ userId: 'ada', displayName: 'Ada Example', email: 'ada@example.test', cohort: 'class-one', cohortName: 'Example class', projectSlug: 'three', progressPercent: 0, phasesPassed: 1, averageScore: null, totalHints: 0, relianceIndex: 0, tokensToday: 0, completed: false, integrityFlag: false, difficultyTier: 'standard' }] });
    rig.learner.mockResolvedValue(ADA);
    rig.audit.mockResolvedValue([]);
    rig.notes.mockResolvedValue([]);
    rig.teacherHistory.mockResolvedValue([]);
    rig.classProject.mockResolvedValue({ cohortId: 'class-one', active: { projectSlug: 'three', projectTitle: 'Three phases', phases: KEYS }, history: [] });
    window.history.replaceState(null, '', `/teacher/class?class=class-one${search}`);
    await render(<TeacherPortal classView />);
  };
  it('draws three phase columns on the map and three bars', async () => {
    await open('');
    const heads = [...host.querySelectorAll('.exp-table thead th')].map((one) => one.textContent);
    expect(heads).toEqual(['Learner', 'Requirements', 'Design', 'Implementation']);
    expect([...host.querySelectorAll('.exp-bar-row > span:first-child')].map((one) => one.textContent)).toEqual(TITLES);
  });
  it('counts a learner\'s passes over the version\'s three phases', async () => {
    await open('&view=table');
    const tr = [...host.querySelectorAll('.exp-table tbody tr')].find((one) => one.querySelector('strong')?.textContent === 'Ada Example')!;
    const cells = [...tr.querySelectorAll('td')].map((cell) => cell.textContent);
    expect(cells[3]).toBe('1 / 3');
  });
});

describe('the class levers over an assigned three-phase version nobody has started', () => {
  it("offers the phases the class's assignment names, not six, for a version on no list the caller reads (another teacher's)", async () => {
    rig.classProject.mockResolvedValue({ cohortId: 'class-one', active: { projectSlug: 'three', projectTitle: 'Three phases', phases: KEYS }, history: [] });
    rig.assignable.mockResolvedValue([]);
    await render(<ClassLevers cohortId="class-one" projects={[]} />);
    expect(queryAllByTestId(host, 'schedule-phase').map((one) => one.textContent)).toEqual(TITLES);
    expect(rig.assignable).not.toHaveBeenCalled();
  });
  it('offers nothing to date, never six, for an assignment that names no phases, until a learner starts the project', async () => {
    rig.classProject.mockResolvedValue({ cohortId: 'class-one', active: { projectSlug: 'three', projectTitle: 'Three phases' }, history: [] });
    await render(<ClassLevers cohortId="class-one" projects={[]} />);
    expect(queryAllByTestId(host, 'schedule-phase')).toEqual([]);
    expect(queryAllByTestId(host, 'class-levers-empty')).toHaveLength(1);
  });
  it("reads the class's assignment again when the page says the class was given another version", async () => {
    rig.classProject.mockResolvedValue({ cohortId: 'class-one', active: { projectSlug: 'three', projectTitle: 'Three phases', phases: KEYS }, history: [] });
    await render(<ClassLevers cohortId="class-one" assignmentRound={0} projects={[]} />);
    expect(queryAllByTestId(host, 'schedule-phase').map((one) => one.textContent)).toEqual(TITLES);
    rig.classProject.mockResolvedValue({ cohortId: 'class-one', active: { projectSlug: 'three', projectTitle: 'Three phases', phases: ['requirements', 'design'] }, history: [] });
    await render(<ClassLevers cohortId="class-one" assignmentRound={1} projects={[]} />);
    expect(queryAllByTestId(host, 'schedule-phase').map((one) => one.textContent)).toEqual(['Requirements', 'Design']);
  });
  it('keeps the phases a learner reads when one has started the project', async () => {
    rig.classProject.mockResolvedValue({ cohortId: 'class-one', active: { projectSlug: 'three', projectTitle: 'Three phases', phases: KEYS }, history: [] });
    await render(<ClassLevers cohortId="class-one" projects={[{ slug: 'three', title: 'Three phases', phases: [{ key: 'design', title: 'The design' }, { key: 'implementation', title: 'The build' }] }]} />);
    expect(queryAllByTestId(host, 'schedule-phase').map((one) => one.textContent)).toEqual(['The design', 'The build']);
  });
});

/* --------------- the teacher's board reads the assigned version ------------ */

const SIX: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const SIX_TITLES = ['Requirements', 'Design', 'Implementation', 'Testing', 'Deployment', 'Maintenance'];
/** An enrolment on a version of `keys`, `done` phases in. */
const boardOf = (keys: PhaseKey[], done: number, slug: string): InstructorEnrollmentView => ({
  ...board(done), id: `enrolment-${slug}`, projectSlug: slug, projectTitle: slug,
  phases: keys.map((key, i) => ({
    ...board(done).phases[0], id: `${slug}-${key}`, key, order: i + 1, title: SIX_TITLES[SIX.indexOf(key)],
    status: i < done ? 'passed' : i === done ? 'in_progress' : 'locked',
  }) as unknown as InstructorPhaseView),
});
const learnerOf = (userId: string, displayName: string, enrollments: InstructorEnrollmentView[]) =>
  ({ ...ADA, userId, displayName, email: `${userId}@example.test`, enrollments }) as unknown as InstructorLearnerDetail;
const rowOf = (one: InstructorLearnerDetail) => ({
  userId: one.userId, displayName: one.displayName, email: one.email, cohort: 'class-one', cohortName: 'Example class',
  projectSlug: one.enrollments[0]?.projectSlug ?? null, progressPercent: 0, phasesPassed: 0, averageScore: null, totalHints: 0,
  relianceIndex: 0, tokensToday: 0, completed: false, integrityFlag: false, difficultyTier: 'standard',
});

describe("the teacher's board over the class's assigned version", () => {
  /** `assigned`: the phases the class's assignment names; an Error when the class's project cannot be read. */
  const open = async ({ learners, assigned, search = '' }: { learners: InstructorLearnerDetail[]; assigned?: PhaseKey[] | Error; search?: string }) => {
    rig.session = { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Dana Teacher' };
    rig.mine.mockResolvedValue([{ id: 'class-one', name: 'Example class', joinCode: 'EXAMPLE1', memberCount: learners.length }]);
    rig.overview.mockResolvedValue({ learners: learners.map(rowOf) });
    rig.learner.mockImplementation(async (id: string) => learners.find((one) => one.userId === id));
    rig.audit.mockResolvedValue([]);
    rig.notes.mockResolvedValue([]);
    rig.teacherHistory.mockResolvedValue([]);
    if (assigned instanceof Error) rig.classProject.mockRejectedValue(assigned);
    else rig.classProject.mockResolvedValue({ cohortId: 'class-one', active: { projectSlug: 'assigned', projectTitle: 'Assigned', ...(assigned ? { phases: assigned } : {}) }, history: [] });
    window.history.replaceState(null, '', `/teacher/class?class=class-one${search}`);
    await render(<TeacherPortal classView />);
  };
  const heads = () => [...host.querySelectorAll('.exp-table thead th')].map((one) => one.textContent);
  const bars = () => [...host.querySelectorAll('.exp-bar-row > span:first-child')].map((one) => one.textContent);
  const cellsOf = (name: string) =>
    [...[...host.querySelectorAll('.exp-table tbody tr')].find((one) => one.querySelector('strong')?.textContent === name)!.querySelectorAll('td')].map((cell) => cell.textContent);

  it('draws the assigned three phases and no "/ 6" for a class nobody has started', async () => {
    await open({ learners: [], assigned: KEYS });
    expect(bars()).toEqual(TITLES);
    expect(heads()).toEqual(['Learner', ...TITLES]);
  });
  it("draws the phases the class's assignment names, for a version on no list the caller reads", async () => {
    rig.assignable.mockResolvedValue([]);
    await open({ learners: [], assigned: KEYS });
    expect(bars()).toEqual(TITLES);
    expect(heads()).toEqual(['Learner', ...TITLES]);
    expect(rig.assignable).not.toHaveBeenCalled();
  });
  it("draws the assigned version's phases when a learner is still pinned to an older six-phase one", async () => {
    const ben = learnerOf('ben', 'Ben Example', [boardOf(SIX, 2, 'older')]);
    await open({ learners: [ADA, ben], assigned: KEYS });
    expect(heads()).toEqual(['Learner', ...TITLES]);
  });
  it('says "Not in their version" where a learner\'s version lacks a column, and "Not started" only for a learner with no enrolment', async () => {
    const ben = learnerOf('ben', 'Ben Example', [boardOf(SIX, 3, 'tasktrackr')]);
    const cy = learnerOf('cy', 'Cy Example', []);
    await open({ learners: [ADA, ben, cy], assigned: SIX });
    expect(heads()).toEqual(['Learner', ...SIX_TITLES]);
    const ada = cellsOf('Ada Example');
    expect(ada.slice(4)).toEqual(['Not in their version', 'Not in their version', 'Not in their version']);
    expect(cellsOf('Cy Example').slice(1)).toEqual(SIX.map(() => 'Not started'));
  });
  it("falls back to the learners' own versions when the assignment names no phases or cannot be read, never to a bare six", async () => {
    await open({ learners: [ADA] });
    expect(heads()).toEqual(['Learner', ...TITLES]);
    expect(bars()).toEqual(TITLES);
    await open({ learners: [ADA], assigned: new Error('the class project did not load') });
    expect(heads()).toEqual(['Learner', ...TITLES]);
    expect(bars()).toEqual(TITLES);
  });
  it('keeps a learner whose current phase lies outside the assigned set: a column for it, and the learner in its bar', async () => {
    // Ben is pinned to six phases and working in Testing; the class is assigned three.
    const ben = learnerOf('ben', 'Ben Example', [boardOf(SIX, 3, 'older')]);
    await open({ learners: [ADA, ben], assigned: KEYS });
    expect(heads()).toEqual(['Learner', ...TITLES, 'Testing']);
    expect(bars()).toEqual([...TITLES, 'Testing']);
    const testing = [...host.querySelectorAll('.exp-bar-row')].find((row) => row.querySelector('span')?.textContent === 'Testing')!;
    expect(testing.querySelector('strong')?.textContent).toBe('1');
    expect(cellsOf('Ada Example')[4]).toBe('Not in their version');
  });
  it('picks up a reassignment made on the page, without a reload', async () => {
    await open({ learners: [], assigned: KEYS });
    expect(heads()).toEqual(['Learner', ...TITLES]);
    rig.classProject.mockResolvedValue({ cohortId: 'class-one', active: { projectSlug: 'assigned', projectTitle: 'Assigned', phases: SIX }, history: [] });
    await act(async () => getAllByTestId(host, 'test-class-assigned')[0].click());
    for (let round = 0; round < 4; round += 1) await act(async () => { await Promise.resolve(); });
    expect(heads()).toEqual(['Learner', ...SIX_TITLES]);
    expect(bars()).toEqual(SIX_TITLES);
  });
  it("draws no fallback columns before the class's assignment answers", async () => {
    const ben = learnerOf('ben', 'Ben Example', [boardOf(SIX, 1, 'older')]);
    let answer: (view: unknown) => void = () => undefined;
    rig.classProject.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    rig.session = { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Dana Teacher' };
    rig.mine.mockResolvedValue([{ id: 'class-one', name: 'Example class', joinCode: 'EXAMPLE1', memberCount: 1 }]);
    rig.overview.mockResolvedValue({ learners: [rowOf(ben)] });
    rig.learner.mockResolvedValue(ben);
    rig.audit.mockResolvedValue([]);
    rig.notes.mockResolvedValue([]);
    rig.teacherHistory.mockResolvedValue([]);
    window.history.replaceState(null, '', '/teacher/class?class=class-one');
    await render(<TeacherPortal classView />);
    expect(heads()).toEqual([]);
    expect(bars()).toEqual([]);
    await act(async () => answer({ cohortId: 'class-one', active: { projectSlug: 'assigned', projectTitle: 'Assigned', phases: KEYS }, history: [] }));
    for (let round = 0; round < 4; round += 1) await act(async () => { await Promise.resolve(); });
    expect(heads()).toEqual(['Learner', ...TITLES]);
  });
  it('counts each learner over their own version on the table', async () => {
    const ben = learnerOf('ben', 'Ben Example', [boardOf(SIX, 3, 'tasktrackr')]);
    await open({ learners: [ADA, ben], assigned: SIX, search: '&view=table' });
    expect(cellsOf('Ada Example')[3]).toBe('1 / 3');
    expect(cellsOf('Ben Example')[3]).toBe('3 / 6');
  });
  it('ignores a phase filter the board does not draw, so the roster is not emptied by a phase it cannot show', async () => {
    await open({ learners: [ADA], assigned: KEYS, search: '&phaseFilter=testing' });
    expect([...host.querySelectorAll('.exp-table tbody tr strong')].map((one) => one.textContent)).toContain('Ada Example');
  });
});
