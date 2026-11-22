// @vitest-environment jsdom
/**
 * The learner's first run, dashboard, map and completion record.
 *
 * - The completion record, every phase passed and the project not yet
 *   sealed, names the real control ("Complete the project") and opens the
 *   last phase by its name; sealed, it says nothing of the kind. The dashboard
 *   reads the same two states the same way.
 * - The completion page's bar reads "Progress › Completion record",
 *   not its heading again, and the rail lights Progress.
 * - Joining a class on the first-run page is said once, with the
 *   class's name, on the dashboard it lands on; the address carries nothing.
 * - The map's figures count only lines with a block of work at both
 *   ends, and say "Nothing written yet" for an empty map.
 * - The first-run form draws its own error line, never the browser's
 *   bubble.
 *
 * The pages are the real ones over the same seams `subset-views.test.tsx`
 * draws them with.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseKey, ProjectMapData, SubmissionView } from '@learnsdlc/shared';
import type { Review } from '@/components/experience/shared';
import { phase } from './fixtures';

const rig = vi.hoisted(() => ({
  project: null as unknown,
  reviews: [] as unknown[],
  shell: [] as { active?: string; crumbs?: { label: string; href?: string }[] }[],
  router: { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() },
  enroll: vi.fn(),
  request: vi.fn(),
  join: vi.fn(),
  classroom: vi.fn(),
  leave: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => rig.router,
  usePathname: () => window.location.pathname,
  useParams: () => ({}),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The frame, as what it was asked to draw: the rail's lit row and the bar's crumbs.
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children, active, crumbs }: { children: ReactNode; active?: string; crumbs?: { label: string; href?: string }[] }) => {
    rig.shell.push({ active, crumbs });
    return <>{children}</>;
  },
}));
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  useProject: () => rig.project,
  useProjectMaybe: () => rig.project,
  invalidateProject: vi.fn(),
}));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'learner', role: 'LEARNER', displayName: 'Ada Learner', avatar: 0, profileVersion: 3 }),
  setSession: vi.fn(),
}));
vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return { ...real, api: { ...real.api, enroll: rig.enroll }, request: rig.request };
});
vi.mock('@/lib/api-cohorts', () => ({ cohortsApi: { join: rig.join }, formatJoinCode: (value: string) => value }));
vi.mock('@/lib/api-experience', () => ({ experienceApi: { classroom: rig.classroom, leave: rig.leave } }));
vi.mock('@/lib/project', async (original) => ({
  ...(await original<typeof import('@/lib/project')>()),
  setActiveProject: vi.fn(),
}));
vi.mock('@/components/experience/shared', async (original) => ({
  ...(await original<typeof import('@/components/experience/shared')>()),
  ExperiencePage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  useReviews: () => ({ reviews: rig.reviews, loading: false, refreshing: false, error: '', refreshError: '', refresh: vi.fn() }),
}));

import CompletionPage from '@/app/(app)/completion/page';
import DashboardPage from '@/app/(app)/dashboard/page';
import OnboardingPage from '@/app/(app)/onboarding/page';
import { rememberJoinedClass, takeJoinedClass } from '@/app/(app)/dashboard/joined-class';
import { CLOSES_LINE_LEARNER, CLOSES_LINE_TEACHER, closesLineFor, finishedWhen } from '@/components/dossier/completion';
import { MapFiguresRow, mapFigures } from '@/components/map/MapCard';
import { layoutMap } from '@/components/map/layout';
import { navKeyFromPath } from '@/components/shell/Sidebar';

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
/** Six passed phases, sealed or not. */
const finished = (completed: boolean) =>
  ({
    id: 'e-six', projectSlug: 'six', projectTitle: 'Six phases', currentPhaseOrder: 6, completed,
    startedAt: '2026-10-01T08:00:00.000Z', completedAt: completed ? '2026-10-07T10:00:00.000Z' : null,
    phases: KEYS.map((key, index) => phase(key, index + 1, `p-${key}`, 'passed', { passedAt: `2026-10-0${index + 1}T09:00:00.000Z` })),
  }) as unknown as EnrollmentView;
const verified = (phaseStateId: string, at: string) =>
  ({ id: `s-${phaseStateId}`, phaseStateId, status: 'completed', passed: true, verifiedPass: true, attempt: 1, createdAt: at, reviewUnavailable: false }) as unknown as SubmissionView;
const reviewsOf = (enrollment: EnrollmentView): Review[] =>
  enrollment.phases.map((one) => ({ phase: one, submission: verified(one.id, one.passedAt!) }) as unknown as Review);
const shellOf = (enrollment: EnrollmentView) => ({
  loading: false, revalidating: false, error: '', enrollment, details: {}, projects: [], slug: enrollment.projectSlug,
  currentPhase: enrollment.phases.find((one) => one.order === enrollment.currentPhaseOrder), analytics: null, map: null,
});

let host: HTMLDivElement;
let root: Root;
const render = async (node: ReactNode) => {
  await act(async () => root.render(node));
  for (let round = 0; round < 4; round += 1) await act(async () => { await Promise.resolve(); });
};
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
beforeEach(() => {
  vi.clearAllMocks();
  rig.shell = [];
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the completion record names the press that completes the project', () => {
  it('every phase passed, not sealed: names "Complete the project" and opens the last phase by its name', async () => {
    const enrollment = finished(false);
    rig.project = shellOf(enrollment);
    rig.reviews = reviewsOf(enrollment);
    await render(<CompletionPage />);
    const closing = q('completion-closing');
    expect(closing?.textContent).toContain('All 6 phases passed. The project is complete once you press Complete the project in Maintenance.');
    expect(closing?.textContent).not.toContain('continue');
    const open = q('completion-closing-open');
    expect(open?.textContent).toBe('Open Maintenance');
    expect(open?.getAttribute('href')).toMatch(/^\/workspace\/p-maintenance/);
    expect(host.querySelector('.exp-certificate-footer')?.textContent).not.toContain('Recorded');
  });

  it('sealed: no closing line, the date recorded instead', async () => {
    const enrollment = finished(true);
    rig.project = shellOf(enrollment);
    rig.reviews = reviewsOf(enrollment);
    await render(<CompletionPage />);
    expect(q('completion-closing')).toBeNull();
    expect(host.querySelector('.exp-certificate-footer')?.textContent).toContain('Recorded');
  });

  it("the printable record's sentences name the same control, for the learner and the teacher", () => {
    expect(CLOSES_LINE_LEARNER).toBe('All phases passed. The project is complete once you press Complete the project on the last phase.');
    expect(CLOSES_LINE_TEACHER).toBe('All phases passed. The project is complete once the learner presses Complete the project on the last phase.');
    expect(finishedWhen('learner')).toBe('When you press Complete the project on the last phase');
    expect(finishedWhen('instructor')).toBe('When the learner presses Complete the project on the last phase');
    expect(closesLineFor(1, undefined)).toBe('The phase passed. The project is complete once you press Complete the project in the last phase.');
  });

  it('the dashboard: every phase passed and not sealed opens the last phase; sealed opens the record', async () => {
    const open = finished(false);
    rig.project = shellOf(open);
    rig.reviews = reviewsOf(open);
    await render(<DashboardPage />);
    expect(host.textContent).toContain('Every phase passed. One step left.');
    expect(host.textContent).toContain('Press Complete the project in Maintenance to complete your project.');
    expect(host.textContent).not.toContain('A complete journey');
    const door = [...host.querySelectorAll('a.exp-primary')].find((link) => link.textContent?.includes('Open Maintenance'));
    expect(door?.getAttribute('href')).toMatch(/^\/workspace\/p-maintenance/);
    expect(host.textContent).not.toContain('View completion record');
    // The hero's foot names the press left, not the phase's finished work task.
    const foot = () => host.querySelector('.exp-resume-foot')?.textContent ?? '';
    expect(foot()).toBe('Your last stepComplete the project');
    expect(foot()).not.toMatch(/without regressions|Pick up where you left off/);

    act(() => root.unmount());
    root = createRoot(host);
    const sealed = finished(true);
    rig.project = shellOf(sealed);
    rig.reviews = reviewsOf(sealed);
    await render(<DashboardPage />);
    expect(host.textContent).toContain('A complete journey. A project to show for it.');
    const record = [...host.querySelectorAll('a.exp-primary')].find((link) => link.textContent?.includes('View completion record'));
    expect(record?.getAttribute('href')).toBe('/completion');
    expect(foot()).toBe('Your recordView your completion record');
    expect(foot()).not.toMatch(/without regressions|Pick up where you left off/);
  });
});

describe('the completion page in the bar and the rail', () => {
  it('reads "Progress › Completion record" and lights Progress, not its heading and no row', async () => {
    const enrollment = finished(true);
    rig.project = shellOf(enrollment);
    rig.reviews = reviewsOf(enrollment);
    await render(<CompletionPage />);
    const frame = rig.shell.at(-1);
    expect(frame?.active).toBe('progress');
    expect(frame?.crumbs).toEqual([{ label: 'Progress', href: '/progress' }, { label: 'Completion record' }]);
    expect(host.querySelector('h1')?.textContent).toBe('Your project, from idea to improvement.');
    expect(frame?.crumbs?.map((crumb) => crumb.label)).not.toContain('Your project, from idea to improvement.');
  });

  it("the rail's own path map agrees on its first paint: /completion lights Progress, /complete stays Overview", () => {
    expect(navKeyFromPath('/completion')).toBe('progress');
    expect(navKeyFromPath('/complete')).toBe('home');
  });
});

describe('joining a class from the first run is said once on the dashboard', () => {
  it('the first-run page writes down the class it joined, and only after setup succeeded', async () => {
    rig.join.mockResolvedValue({ id: 'class-b', name: 'Year 2 Studio' });
    rig.enroll.mockRejectedValueOnce(new Error('Project setup unavailable.')).mockResolvedValueOnce({ projectSlug: 'six' });
    rig.request.mockResolvedValue({ id: 'learner', displayName: 'Ada Learner', avatar: 0, profileVersion: 4, onboardingCompleted: true });
    await render(<OnboardingPage />);
    act(() => { (host.querySelector('input[value="class"]') as HTMLInputElement).click(); });
    act(() => { fireEvent.change(host.querySelector('.onboarding-class input')!, { target: { value: 'ABCDEFGH' } }); });
    await act(async () => { fireEvent.submit(host.querySelector('form')!); });
    // The enrolment failed: nothing is said anywhere yet.
    expect(rig.router.replace).not.toHaveBeenCalled();
    expect(window.sessionStorage.length).toBe(0);
    await act(async () => { fireEvent.submit(host.querySelector('form')!); });
    expect(rig.router.replace).toHaveBeenCalledWith('/dashboard');
    expect(takeJoinedClass()).toBe('Year 2 Studio');
  });

  it('the dashboard says it once, by name, and a second visit says nothing', async () => {
    const enrollment = finished(false);
    rig.project = shellOf(enrollment);
    rig.reviews = [];
    rememberJoinedClass('Year 2 Studio');
    await render(<DashboardPage />);
    const said = q('dashboard-joined-class');
    expect(said?.textContent).toBe('You joined Year 2 Studio.');
    expect(said?.getAttribute('role')).toBe('status');
    expect(window.location.search).toBe('');

    act(() => root.unmount());
    root = createRoot(host);
    await render(<DashboardPage />);
    expect(q('dashboard-joined-class')).toBeNull();
  });

  it('learning independently writes nothing down', async () => {
    rig.classroom.mockResolvedValue(null);
    rig.enroll.mockResolvedValue({ projectSlug: 'six' });
    rig.request.mockResolvedValue({ id: 'learner', displayName: 'Ada Learner', avatar: 0, profileVersion: 4, onboardingCompleted: true });
    await render(<OnboardingPage />);
    await act(async () => { fireEvent.submit(host.querySelector('form')!); });
    expect(rig.router.replace).toHaveBeenCalledWith('/dashboard');
    expect(takeJoinedClass()).toBeNull();
  });
});

describe("the first-run form's own error line", () => {
  it('turns the browser bubble off and says what is missing in the form', async () => {
    await render(<OnboardingPage />);
    expect(host.querySelector('form')?.noValidate).toBe(true);
    // A name too short: nothing sent, the reason in the alert line.
    act(() => { fireEvent.change(host.querySelector('input[autocomplete="name"]')!, { target: { value: 'A' } }); });
    await act(async () => { fireEvent.submit(host.querySelector('form')!); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Your name needs at least 2 characters.');
    // Focus goes back to the name, marked invalid and tied to the alert line,
    // as the browser's own check did before noValidate.
    const nameField = host.querySelector('input[autocomplete="name"]');
    expect(document.activeElement).toBe(nameField);
    expect(nameField?.getAttribute('aria-invalid')).toBe('true');
    expect(nameField?.getAttribute('aria-describedby')).toBe('onboarding-error');
    expect(host.querySelector('[role="alert"]')?.id).toBe('onboarding-error');
    expect(rig.enroll).not.toHaveBeenCalled();
    expect(rig.classroom).not.toHaveBeenCalled();
    expect(host.querySelector('form')?.getAttribute('aria-busy')).toBe('false');
    // A name of two characters goes through.
    rig.classroom.mockResolvedValue(null);
    rig.enroll.mockResolvedValue({ projectSlug: 'six' });
    rig.request.mockResolvedValue({ id: 'learner', displayName: 'Ad', avatar: 0, profileVersion: 4, onboardingCompleted: true });
    act(() => { fireEvent.change(host.querySelector('input[autocomplete="name"]')!, { target: { value: 'Ad' } }); });
    await act(async () => { fireEvent.submit(host.querySelector('form')!); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('input[autocomplete="name"]')?.hasAttribute('aria-invalid')).toBe(false);
    expect(rig.enroll).toHaveBeenCalledTimes(1);
  });

  it('does not tie a refusal that is not about the name to the name field', async () => {
    await render(<OnboardingPage />);
    // The name is fine; the server refuses the rest. The alert line shows the
    // refusal, and the name field is neither invalid nor described by it.
    rig.classroom.mockResolvedValue(null);
    rig.enroll.mockRejectedValue(new Error('The server refused.'));
    act(() => { fireEvent.change(host.querySelector('input[autocomplete="name"]')!, { target: { value: 'Ada' } }); });
    await act(async () => { fireEvent.submit(host.querySelector('form')!); });
    expect(host.querySelector('[role="alert"]')?.id).toBe('onboarding-error');
    const nameField = host.querySelector('input[autocomplete="name"]');
    expect(nameField?.hasAttribute('aria-invalid')).toBe(false);
    expect(nameField?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('keeps Start learning near the fields: the privacy note does not pad the column, and a disabled button says wait only while saving', () => {
    const css = readFileSync(resolve(__dirname, '../app/(app)/onboarding/onboarding.css'), 'utf8');
    const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('.onboarding-privacy')).toContain('padding: 0;');
    expect(rule('.onboarding-privacy')).toContain('margin: 4px 0 16px;');
    expect(rule('.onboarding-submit:disabled')).toContain('cursor: not-allowed;');
    expect(rule('.onboarding-grid[aria-busy="true"] .onboarding-submit:disabled')).toContain('cursor: wait;');
  });
});

describe("the map's figures", () => {
  const node = (id: string, kind: string) => ({ id, phase: 'requirements', kind, label: id, state: 'todo' });
  const enrollment = { phases: KEYS.map((key, index) => phase(key, index + 1, `p-${key}`, index === 0 ? 'in_progress' : 'locked')) } as unknown as EnrollmentView;

  it("a fresh learner's map: one block, no line counted to the placeholders", () => {
    const data = {
      nodes: [node('story:US-1', 'story'), ...KEYS.slice(1).map((key) => node(`locked-${key}`, 'placeholder'))],
      edges: [
        { from: 'story:US-1', to: 'locked-design', kind: 'trace' },
        { from: 'locked-design', to: 'locked-implementation', kind: 'trace' },
        { from: 'locked-implementation', to: 'locked-testing', kind: 'trace' },
        { from: 'locked-testing', to: 'locked-deployment', kind: 'trace' },
        { from: 'locked-deployment', to: 'locked-maintenance', kind: 'trace' },
      ],
    } as unknown as ProjectMapData;
    const figures = mapFigures(data, enrollment);
    expect(figures).toEqual({ blocks: 1, lines: 0, open: 1, phases: 6 });
    act(() => root.render(<MapFiguresRow figures={figures} />));
    const row = q('map-figures');
    expect([...row!.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['1 block of your work', '1 of 6 phases open']);
  });

  it('counts a line between two blocks of work, and says "Nothing written yet" for an empty map', () => {
    const data = {
      nodes: [node('story:US-1', 'story'), node('crit:AC-1', 'criterion'), node('locked-design', 'placeholder')],
      edges: [
        { from: 'story:US-1', to: 'crit:AC-1', kind: 'trace' },
        { from: 'crit:AC-1', to: 'locked-design', kind: 'trace' },
      ],
    } as unknown as ProjectMapData;
    expect(mapFigures(data, enrollment).lines).toBe(1);
    act(() => root.render(<MapFiguresRow figures={{ blocks: 0, lines: 0, open: 1, phases: 6 }} />));
    expect([...q('map-figures')!.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Nothing written yet', '1 of 6 phases open']);
  });

  it("the Requirements lane's note names both kinds its count holds, the story as well as the criteria", () => {
    const data = { nodes: [node('story:US-1', 'story'), node('crit:AC-1', 'criterion')], edges: [] } as unknown as ProjectMapData;
    const lane = layoutMap(data, 1440, 300).columns.find((column) => column.key === 'requirements');
    expect(lane?.note).toBe('Stories and criteria');
    expect(lane?.count).toBe(2);
  });
});
