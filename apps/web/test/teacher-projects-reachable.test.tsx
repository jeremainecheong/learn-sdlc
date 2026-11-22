// @vitest-environment jsdom
/**
 * Can a teacher actually get there?
 *
 * The authoring suites render a page or a card on its own: the library, the
 * editor, the class card and the notes card would all pass while nothing in
 * the product linked to any of them. That is the one thing a page cannot
 * prove about itself, and it is what this file is for: the route exists, the
 * portal links to it, and the two class panels are mounted on the class view
 * rather than written and left unmounted.
 *
 * Each assertion here is a link that can be cut. Delete the action-menu entry in
 * `TeacherPortal`, or the `ClassProjectCard` line beside it, or either page
 * under `app/(app)/teacher/projects`, and this suite goes red rather than a
 * teacher finding out.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTHORING_ROUTES } from '@learnsdlc/shared';
import { TeacherPortal } from '@/components/staff/console/TeacherPortal';

const mocks = vi.hoisted(() => ({
  mine: vi.fn(),
  overview: vi.fn(),
  learner: vi.fn(),
  notes: vi.fn(),
  classProject: vi.fn(),
  assignableProjects: vi.fn(),
  assignClassProject: vi.fn(),
  notesList: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
  user: { id: 'teacher', role: 'INSTRUCTOR' },
}));

vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => {
    window.addEventListener('popstate', notify);
    return () => window.removeEventListener('popstate', notify);
  };
  return {
    useSearchParams: () =>
      new URLSearchParams(
        useSyncExternalStore(
          subscribe,
          () => window.location.search,
          () => '',
        ),
      ),
    useRouter: () => mocks.router,
  };
});
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => mocks.user,
}));
vi.mock('@/lib/api-cohorts', () => ({
  cohortsApi: { mine: mocks.mine },
  formatJoinCode: (code: string) => code,
}));
// The real `ClassProjectCard` is rendered, not a stand-in: what is being
// proved is that the portal mounts the class-assignment card and
// that the card's own link to the authoring surface reaches the page below.
vi.mock('@/lib/api-instructor', () => ({
  instructorApi: {
    overview: mocks.overview,
    learner: mocks.learner,
    // The portal reads the class in one call; it answers here through the
    // per-learner stand-in, so every case reads the same learner details.
    learnersIn: (ids: readonly string[]) => Promise.all(ids.map((id) => mocks.learner(id))),
    classProject: mocks.classProject,
    assignableProjects: mocks.assignableProjects,
    assignClassProject: mocks.assignClassProject,
  },
}));
vi.mock('@/lib/api-mentor', () => ({ mentorApi: { notes: mocks.notesList } }));
vi.mock('@/lib/api-experience', () => ({ experienceApi: { teacherFeedback: mocks.notes } }));
vi.mock('@/components/staff/StuckList', () => ({ StuckList: () => null }));
vi.mock('@/components/experience/ScrollRegion', () => ({
  ScrollRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

let root: Root;
let host: HTMLDivElement;

const CLASS = 'class-one';

beforeEach(() => {
  window.history.replaceState(null, '', `/teacher/class?class=${CLASS}`);
  vi.clearAllMocks();
  mocks.mine.mockResolvedValue([
    { id: CLASS, name: 'Tuesday 9am', joinCode: 'TEST12', memberCount: 0 },
  ]);
  mocks.overview.mockResolvedValue({ learners: [] });
  mocks.learner.mockResolvedValue(null);
  mocks.notes.mockResolvedValue([]);
  mocks.notesList.mockResolvedValue([]);
  mocks.classProject.mockResolvedValue({ cohortId: CLASS, active: null, history: [] });
  mocks.assignableProjects.mockResolvedValue([]);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const render = async (classView: boolean) => {
  await act(async () => root.render(<TeacherPortal classView={classView} />));
};

describe('the teacher can reach the projects surface', () => {
  it('links to /teacher/projects from the portal, in both views', async () => {
    await render(true);
    expect(host.querySelector('a[href="/teacher/projects"]')).not.toBeNull();

    await render(false);
    // The library is not a property of one class, so the entry point has to
    // survive the view that has no class selected.
    expect(host.querySelector('a[href="/teacher/projects"]')).not.toBeNull();
  });

  it("mounts the class's project panel, and its own link, on the class view", async () => {
    await render(true);

    const card = host.querySelector('[data-testid="class-project-card"]');
    expect(card).not.toBeNull();
    expect(card!.querySelector('[data-testid="class-project-library"]')?.getAttribute('href')).toBe(
      '/teacher/projects',
    );
    // It read the class it was mounted with, through the contract's own path.
    expect(mocks.classProject).toHaveBeenCalledWith(CLASS);
    expect(AUTHORING_ROUTES['assignment.read'].path).toBe('/instructor/cohorts/:cohortId/project');

    // A class with no assignment says what its learners are given instead of
    // drawing an empty box.
    expect(card!.querySelector('[data-testid="class-project-none"]')).not.toBeNull();
  });

  it('mounts the mentor-notes panel the gap left unwired, on the class view', async () => {
    await render(true);
    expect(host.querySelector('[data-testid="notes-card"]')).not.toBeNull();
    expect(mocks.notesList).toHaveBeenCalledWith({ cohortId: CLASS });
  });

  it('keeps both class panels off the view across every class', async () => {
    await render(false);
    // Neither is addressed to a class there, and a card that asked the server
    // about `undefined` would be a read nobody can answer.
    expect(host.querySelector('[data-testid="class-project-card"]')).toBeNull();
    expect(host.querySelector('[data-testid="notes-card"]')).toBeNull();
    expect(mocks.classProject).not.toHaveBeenCalled();
  });
});

describe('the pages those links open exist', () => {
  it('serves a component at /teacher/projects and at the version editor', async () => {
    const library = await import('@/app/(app)/teacher/projects/page');
    expect(typeof library.default).toBe('function');

    const editor = await import('@/app/(app)/teacher/projects/[projectId]/versions/[versionId]/page');
    expect(typeof editor.default).toBe('function');
  });
});
