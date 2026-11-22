// @vitest-environment jsdom
/**
 * My classes on a teacher with many classes. The page reads the class list
 * and the overview, then the details of every learner of every class (a page
 * of 50 at a time, one after another); creating a class must not do that
 * whole read again before opening the new class's page.
 *
 * Creating a class reads the class list alone before it opens the new class's
 * Project tab. The first read draws its loading line alone until all of it has
 * answered: class cards drawn early under that line would drop about 680 px,
 * under the pointer, when the parts above them arrived. After a failed first read the page says only
 * that, and Refresh reads the whole page again.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeacherPortal } from '@/components/staff/console/TeacherPortal';

const mocks = vi.hoisted(() => ({
  mine: vi.fn(),
  create: vi.fn(),
  me: vi.fn(),
  overview: vi.fn(),
  learnersIn: vi.fn(),
  audit: vi.fn(),
  notes: vi.fn(),
  history: vi.fn(),
  router: { replace: vi.fn(), push: vi.fn() },
}));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => {
    window.addEventListener('popstate', notify);
    return () => window.removeEventListener('popstate', notify);
  };
  return {
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => '')),
    useRouter: () => mocks.router,
  };
});
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ enrollment: null }) }));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  setSession: vi.fn(),
  useSession: () => ({ id: 'teacher', role: 'INSTRUCTOR' }),
}));
vi.mock('@/lib/api-cohorts', () => ({
  cohortsApi: { mine: mocks.mine, create: mocks.create },
  formatJoinCode: (value: string) => value,
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: { me: mocks.me } }));
vi.mock('@/lib/api-instructor', () => ({
  instructorApi: { overview: mocks.overview, learnersIn: mocks.learnersIn, audit: mocks.audit },
}));
vi.mock('@/lib/api-experience', () => ({ experienceApi: { teacherFeedback: mocks.notes, teacherSubmissions: mocks.history } }));
vi.mock('@/components/staff/StuckList', () => ({ StuckList: () => <section data-testid="stuck-list" /> }));
vi.mock('@/components/experience/ScrollRegion', () => ({ ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: () => null }));

const CLASSES = [
  { id: 'class-one', name: 'Morning class', joinCode: 'AAAA1111', memberCount: 1 },
  { id: 'class-two', name: 'Evening class', joinCode: 'BBBB2222', memberCount: 0 },
];
const phase = {
  id: 'phase-one',
  title: 'Requirements',
  key: 'requirements',
  order: 1,
  status: 'in_progress',
  attempts: 1,
  lastSubmission: null,
  tasks: [{ key: 'main', order: 1, required: true, title: 'main', status: 'in_progress', awaitingSignOff: true, lastSubmission: null }],
};
const learner = {
  userId: 'learner-one',
  displayName: 'Example learner',
  email: 'learner@example.test',
  cohort: 'class-one',
  enrollments: [{ projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', currentPhaseOrder: 1, phases: [phase] }],
};

let host: HTMLDivElement;
let root: Root;
let releaseLearners: (rows: unknown[]) => void = () => undefined;
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (name: string) => [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === name);
const loadingShown = () => host.textContent!.includes('Loading your learning record');
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};
async function open(url: string, classView = url.startsWith('/teacher/class')) {
  window.history.replaceState(null, '', url);
  await act(async () => root.render(<TeacherPortal classView={classView} />));
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  mocks.mine.mockResolvedValue(CLASSES);
  mocks.overview.mockResolvedValue({ learners: [{ userId: learner.userId, cohort: learner.cohort }] });
  // The learners' details hold until the test lets them answer.
  mocks.learnersIn.mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseLearners = resolve;
      }),
  );
  mocks.notes.mockResolvedValue([]);
  mocks.history.mockResolvedValue([]);
  mocks.audit.mockResolvedValue([]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

// The page's parts in the order they are drawn: headings, the numbers, the
// help requests and each class card with its count.
const outline = () =>
  [...host.querySelectorAll<HTMLElement>('h1, h2, [data-testid="teacher-metrics"], [data-testid="stuck-list"], [data-testid^="class-card-"]')]
    .filter((node) => !node.dataset.testid?.startsWith('class-card-waiting-'))
    .map((node) => {
      const id = node.dataset.testid;
      if (!id) return `${node.tagName.toLowerCase()} ${node.textContent!.trim()}`;
      if (id.startsWith('class-card-')) {
        const name = node.querySelector('strong')!.textContent;
        const count = node.querySelector(`[data-testid="class-card-waiting-${id.slice('class-card-'.length)}"]`)!.textContent;
        return `card ${name}: ${count}`;
      }
      if (id === 'teacher-metrics') return `metrics ${[...node.querySelectorAll('strong')].map((one) => one.textContent).join(' ')}`;
      return id;
    });
const SETTLED_OUTLINE = [
  'h1 My classes',
  'metrics 2 1 0',
  'stuck-list',
  'h2 Where the work is happening.',
  'h2 Latest submissions',
  'h2 Your classes',
  'card Morning class: 1 awaiting your sign-off',
  'card Evening class: 0 awaiting your sign-off',
  'h2 All classes',
];
const nothingBelowTheLine = () => {
  expect(byTestId('teacher-class-cards')).toBeNull();
  expect(host.querySelector('[data-testid^="class-card-"]')).toBeNull();
  expect(byTestId('teacher-metrics')).toBeNull();
  expect(byTestId('stuck-list')).toBeNull();
  expect(byTestId('teacher-all-classes')).toBeNull();
  expect(host.textContent).not.toContain('awaiting your sign-off');
  expect(host.textContent).not.toContain('You have no classes yet');
};

describe('My classes on a cold load', () => {
  it('draws the loading line alone until the whole read answers, then the page', async () => {
    let releaseClasses: (rows: unknown[]) => void = () => undefined;
    mocks.mine.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseClasses = resolve;
        }),
    );
    await open('/teacher');
    expect(loadingShown()).toBe(true);
    nothingBelowTheLine();
    // The class list has answered; the learners have not: still the line alone.
    await act(async () => releaseClasses(CLASSES));
    await settle();
    expect(mocks.learnersIn).toHaveBeenCalledTimes(1);
    expect(loadingShown()).toBe(true);
    nothingBelowTheLine();
    // The header's Create class is there and pressable from the first frame.
    expect(button('Create class')!.disabled).toBe(false);

    await act(async () => releaseLearners([learner]));
    await settle();
    expect(loadingShown()).toBe(false);
    expect(outline()).toEqual(SETTLED_OUTLINE);
    expect(byTestId('class-card-class-one')!.querySelector('a.exp-row')!.getAttribute('href')).toBe('/teacher/class?class=class-one');
    expect(host.textContent).not.toContain('Counting sign-offs');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("a class's page draws its loading line alone", async () => {
    await open('/teacher/class?class=class-one');
    expect(loadingShown()).toBe(true);
    expect(byTestId('teacher-class-cards')).toBeNull();
    expect(byTestId('teacher-metrics')).toBeNull();
  });

  it('the home with a learner in its address draws no cards: it leaves for that class', async () => {
    await open('/teacher?learner=learner-one');
    expect(loadingShown()).toBe(true);
    expect(byTestId('teacher-class-cards')).toBeNull();
    await act(async () => releaseLearners([learner]));
    await settle();
    expect(mocks.router.replace).toHaveBeenCalledWith('/teacher/class?class=class-one&learner=learner-one');
    expect(byTestId('teacher-class-cards')).toBeNull();
  });

  it('Refresh after a read that answered stays quiet: the page stays on screen, no loading line', async () => {
    mocks.learnersIn.mockResolvedValue([learner]);
    await open('/teacher');
    expect(outline()).toEqual(SETTLED_OUTLINE);
    const card = byTestId('class-card-class-one');
    let releaseAgain: (rows: unknown[]) => void = () => undefined;
    mocks.learnersIn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseAgain = resolve;
        }),
    );
    await act(async () => byTestId('class-refresh')!.click());
    await settle();
    expect(loadingShown()).toBe(false);
    expect(byTestId('class-card-class-one')).toBe(card);
    await act(async () => releaseAgain([learner]));
    await settle();
    expect(outline()).toEqual(SETTLED_OUTLINE);
    // A failed Refresh here keeps the earlier read on screen and says so.
    mocks.learnersIn.mockRejectedValueOnce(new Error('refused'));
    await act(async () => byTestId('class-refresh')!.click());
    await settle();
    expect(byTestId('class-stale')!.textContent).toMatch(/^Could not refresh at \d{2}:\d{2}\. Showing the earlier read\.$/);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(byTestId('class-card-class-one')).toBe(card);
    expect(outline()).toEqual(SETTLED_OUTLINE);
  });
});

describe('My classes after a failed first read', () => {
  // Nothing was counted, so nothing is drawn that a read would have had to
  // count: the alert says the classes could not be loaded, and that is all.
  it.each([
    ['the learners read', () => mocks.learnersIn.mockRejectedValue(new Error('refused'))],
    ['the overview read', () => mocks.overview.mockRejectedValue(new Error('refused'))],
    ['the class list read', () => mocks.mine.mockRejectedValue(new Error('refused'))],
  ])('%s refused: the alert alone, no card, no count, no "no classes yet"', async (_, refuse) => {
    refuse();
    await open('/teacher');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Your classes could not be loaded.');
    expect(loadingShown()).toBe(false);
    nothingBelowTheLine();
    expect(byTestId('class-stale')).toBeNull();
    expect(host.textContent).not.toContain('Counting sign-offs');
    expect(host.textContent).not.toContain('Sign-offs not counted');
    // The way on is there: Refresh and Create class.
    expect((byTestId('class-refresh') as HTMLButtonElement).disabled).toBe(false);
    expect(button('Create class')!.disabled).toBe(false);
  });

  it('Refresh after the failure reads the whole page: the loading line alone, then the page', async () => {
    mocks.learnersIn.mockRejectedValueOnce(new Error('refused'));
    await open('/teacher');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => byTestId('class-refresh')!.click());
    await settle();
    expect(loadingShown()).toBe(true);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    nothingBelowTheLine();
    await act(async () => releaseLearners([learner]));
    await settle();
    expect(loadingShown()).toBe(false);
    expect(outline()).toEqual(SETTLED_OUTLINE);
    expect(byTestId('class-stale')).toBeNull();
  });

  it('Refresh failing again says so again, never "Showing the earlier read"', async () => {
    mocks.learnersIn.mockRejectedValue(new Error('refused'));
    await open('/teacher');
    await act(async () => byTestId('class-refresh')!.click());
    await settle();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Your classes could not be loaded.');
    expect(byTestId('class-stale')).toBeNull();
    nothingBelowTheLine();
  });

  it('Refresh records after the failure: the loading line alone, then the page with its counts', async () => {
    mocks.learnersIn.mockRejectedValueOnce(new Error('refused'));
    await open('/teacher');
    await act(async () => button('Refresh records')!.click());
    await settle();
    expect(loadingShown()).toBe(true);
    nothingBelowTheLine();
    await act(async () => releaseLearners([learner]));
    await settle();
    expect(outline()).toEqual(SETTLED_OUTLINE);
  });
});

describe('Create class', () => {
  it('reads the class list alone, then opens the new class on its Project tab', async () => {
    mocks.learnersIn.mockResolvedValue([learner]);
    mocks.create.mockResolvedValue({ id: 'created-class', name: 'New class', joinCode: 'NEWCLASS', memberCount: 0 });
    mocks.me.mockResolvedValue({ id: 'teacher', role: 'INSTRUCTOR' });
    await open('/teacher');
    expect(loadingShown()).toBe(false);
    const [mine, overview, learners] = [mocks.mine, mocks.overview, mocks.learnersIn].map((one) => one.mock.calls.length);
    await act(async () => button('Create class')!.click());
    const name = [...host.querySelectorAll('label')].find((node) => node.textContent?.startsWith('Class name'))!.querySelector('input')!;
    act(() => {
      fireEvent.change(name, { target: { value: 'New class' } });
    });
    await act(async () => fireEvent.submit(name.closest('form')!));
    await settle();
    expect(mocks.create).toHaveBeenCalledWith('New class');
    expect(mocks.me).toHaveBeenCalledTimes(1);
    expect(mocks.mine).toHaveBeenCalledTimes(mine + 1);
    // Neither the overview nor any learner of any class is read again on the way.
    expect(mocks.overview).toHaveBeenCalledTimes(overview);
    expect(mocks.learnersIn).toHaveBeenCalledTimes(learners);
    expect(mocks.router.push).toHaveBeenCalledWith('/teacher/class?class=created-class&tab=project');
    // The page it leaves never went back to its loading line.
    expect(loadingShown()).toBe(false);
  });

  const CREATED = { id: 'created-class', name: 'New class', joinCode: 'NEWCLASS', memberCount: 0 };
  async function createNamed(name: string) {
    await act(async () => button('Create class')!.click());
    const input = [...host.querySelectorAll('label')].find((node) => node.textContent?.startsWith('Class name'))!.querySelector('input')!;
    act(() => {
      fireEvent.change(input, { target: { value: name } });
    });
    await act(async () => fireEvent.submit(input.closest('form')!));
    await settle();
  }

  it('does not take a teacher who has left the page to the new class', async () => {
    mocks.learnersIn.mockResolvedValue([learner]);
    mocks.create.mockResolvedValue(CREATED);
    mocks.me.mockResolvedValue({ id: 'teacher', role: 'INSTRUCTOR' });
    await open('/teacher');
    let releaseClasses: (rows: unknown[]) => void = () => undefined;
    mocks.mine.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseClasses = resolve;
        }),
    );
    await createNamed('New class');
    expect(mocks.create).toHaveBeenCalledWith('New class');
    // The class list read is pending; the teacher leaves My classes.
    act(() => root.unmount());
    await act(async () => releaseClasses([...CLASSES, CREATED]));
    await settle();
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

  it('a create during the first read keeps the new class when that older read lands later', async () => {
    let releaseFirstClasses: (rows: unknown[]) => void = () => undefined;
    mocks.mine
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirstClasses = resolve;
          }),
      )
      .mockResolvedValue([...CLASSES, CREATED]);
    mocks.create.mockResolvedValue(CREATED);
    mocks.me.mockResolvedValue({ id: 'teacher', role: 'INSTRUCTOR' });
    await open('/teacher');
    expect(loadingShown()).toBe(true);
    // The header's Create class, pressed while the first read runs: the light
    // path, the class list alone, then the new class's Project tab.
    expect(button('Create class')!.disabled).toBe(false);
    await createNamed('New class');
    expect(mocks.create).toHaveBeenCalledWith('New class');
    expect(mocks.mine).toHaveBeenCalledTimes(2);
    expect(mocks.overview).toHaveBeenCalledTimes(1);
    expect(mocks.learnersIn).toHaveBeenCalledTimes(0);
    expect(mocks.router.push).toHaveBeenCalledWith('/teacher/class?class=created-class&tab=project');
    // The first read is still running: its loading line alone, no card.
    expect(loadingShown()).toBe(true);
    expect(byTestId('teacher-class-cards')).toBeNull();
    // The first read's class list, asked before the class existed, answers now.
    await act(async () => releaseFirstClasses(CLASSES));
    await settle();
    expect(byTestId('teacher-class-cards')).toBeNull();
    expect(mocks.learnersIn).toHaveBeenCalledTimes(1);
    // And its learners, which end the read and set the list.
    await act(async () => releaseLearners([learner]));
    await settle();
    expect(loadingShown()).toBe(false);
    expect(byTestId('class-card-created-class')!.textContent).toContain('New class');
    expect(byTestId('class-card-class-one')).not.toBeNull();
    expect(byTestId('class-card-class-two')).not.toBeNull();
    // Added once, not twice.
    expect(host.querySelectorAll('[data-testid="class-card-created-class"]')).toHaveLength(1);
  });

  it('a read begun after the create takes the server list as it is', async () => {
    mocks.learnersIn.mockResolvedValue([learner]);
    mocks.create.mockResolvedValue(CREATED);
    mocks.me.mockResolvedValue({ id: 'teacher', role: 'INSTRUCTOR' });
    await open('/teacher');
    mocks.mine.mockResolvedValue([...CLASSES, CREATED]);
    await createNamed('New class');
    expect(byTestId('class-card-created-class')).not.toBeNull();
    // A later read (Refresh records) whose list does not hold the class.
    mocks.mine.mockResolvedValue(CLASSES);
    await act(async () => button('Refresh records')!.click());
    await settle();
    expect(byTestId('class-card-created-class')).toBeNull();
  });
});
