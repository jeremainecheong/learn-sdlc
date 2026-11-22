// @vitest-environment jsdom
/**
 * The masked class join code, and which quiz download each teacher page
 * offers.
 *
 * A class join code is a key to the class, and the teacher pages are shown
 * on shared screens. Every place TeacherPortal draws one (the class page's
 * invitation card, each row of teacher home's Your classes, and the
 * created-class confirmation) draws `JoinCode`: a mask of the same shape until
 * the teacher presses Show code, and a Copy code button that copies the code
 * without showing it. Before the reveal the code is in no text, no aria label,
 * no title and no data attribute.
 *
 * The class page's quiz download is that class's file
 * (`exportClassQuizResults(kind, classId)`); teacher home keeps the every-class
 * file (`exportQuizResults(kind)`). Each says which it is.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeacherPortal } from '@/components/staff/console/TeacherPortal';
import { JoinCode, maskJoinCode } from '@/components/experience/JoinCode';
import { settle } from './support/dom';

const mocks = vi.hoisted(() => ({
  mine: vi.fn(),
  create: vi.fn(),
  overview: vi.fn(),
  learner: vi.fn(),
  audit: vi.fn(),
  exportQuizResults: vi.fn(),
  exportClassQuizResults: vi.fn(),
  saveBlob: vi.fn(),
  router: { replace: vi.fn(), push: vi.fn() },
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
    useRouter: () => mocks.router,
  };
});
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/session', async original => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'teacher', role: 'INSTRUCTOR' }),
}));
// The real formatter: the copied text is the formatted code.
vi.mock('@/lib/api-cohorts', async original => ({
  formatJoinCode: (await original<typeof import('@/lib/api-cohorts')>()).formatJoinCode,
  cohortsApi: { mine: mocks.mine, create: mocks.create },
}));
vi.mock('@/lib/api-instructor', () => ({
  instructorApi: {
    overview: mocks.overview,
    learner: mocks.learner,
    learnersIn: (ids: readonly string[]) => Promise.all(ids.map((id) => mocks.learner(id))),
    audit: mocks.audit,
    exportQuizResults: mocks.exportQuizResults,
    exportClassQuizResults: mocks.exportClassQuizResults,
  },
}));
vi.mock('@/lib/download', async original => ({
  ...(await original<typeof import('@/lib/download')>()),
  saveBlob: mocks.saveBlob,
}));
vi.mock('@/lib/api-experience', () => ({
  experienceApi: { teacherFeedback: vi.fn(async () => []), teacherSubmissions: vi.fn(async () => []) },
}));
vi.mock('@/components/staff/StuckList', () => ({ StuckList: () => null }));
vi.mock('@/components/staff/ClassProjectCard', () => ({ ClassProjectCard: () => null }));
vi.mock('@/components/staff/NotesCard', () => ({ NotesCard: () => null }));
vi.mock('@/components/staff/SignoffQueue', async original => ({
  ...(await original<typeof import('@/components/staff/SignoffQueue')>()),
  SignoffQueue: () => null,
}));
vi.mock('@/components/experience/ScrollRegion', () => ({
  ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({
  SubmissionEvidence: () => null,
}));

const CODE_ONE = 'QWER7XYZ';
const CODE_TWO = 'PLMK3NBV';
const CLASSES = [
  { id: 'class-one', name: 'Morning class', joinCode: CODE_ONE, memberCount: 1 },
  { id: 'class-two', name: 'Evening class', joinCode: CODE_TWO, memberCount: 2 },
];

let host: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const all = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const must = <T extends HTMLElement>(id: string) => {
  const found = host.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`no element with test id ${id}`);
  return found;
};

/** Every string a screen reader, a tooltip or a DOM read could reach. */
const everything = () => {
  const attrs = [...host.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => `${a.name}=${a.value}`));
  return [host.textContent ?? '', host.innerHTML, ...attrs].join('\n');
};
const leaks = (code: string) => {
  const text = everything();
  return [code, `${code.slice(0, 4)}-${code.slice(4)}`].filter((form) => text.includes(form));
};

const mount = async (node: ReactNode) => {
  await act(async () => root.render(node));
  await settle(6);
};
const openHome = async () => {
  window.history.replaceState(null, '', '/teacher');
  await mount(<TeacherPortal />);
};
const openClass = async (id = 'class-one') => {
  window.history.replaceState(null, '', `/teacher/class?class=${id}`);
  await mount(<TeacherPortal classView />);
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  mocks.mine.mockResolvedValue(CLASSES);
  mocks.overview.mockResolvedValue({ learners: [] });
  mocks.learner.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue([]);
  mocks.exportQuizResults.mockImplementation(async () => new Blob(['every'], { type: 'text/csv' }));
  mocks.exportClassQuizResults.mockImplementation(async () => new Blob(['one'], { type: 'text/csv' }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

describe('JoinCode', () => {
  it('draws a mask of the same shape, and the code is nowhere in the DOM before the reveal', async () => {
    await mount(<JoinCode code={CODE_ONE} />);
    const code = must('join-code');
    expect(code.tagName).toBe('CODE');
    expect(code.className).toContain('exp-code');
    expect(code.textContent).toBe(maskJoinCode(CODE_ONE));
    expect(maskJoinCode(CODE_ONE)).toBe('••••-••••');
    expect(maskJoinCode('ABC123')).toBe('••••••');
    expect(leaks(CODE_ONE)).toEqual([]);
    const show = must<HTMLButtonElement>('join-code-show');
    expect(show.textContent).toBe('Show code');
    expect(show.getAttribute('aria-pressed')).toBe('false');
  });

  it('Show code reveals the formatted code, and Hide code masks it again', async () => {
    await mount(<JoinCode code={CODE_ONE} />);
    const show = must<HTMLButtonElement>('join-code-show');
    await act(async () => show.click());
    expect(must('join-code').textContent).toBe('QWER-7XYZ');
    expect(show.getAttribute('aria-pressed')).toBe('true');
    expect(show.textContent).toBe('Hide code');
    await act(async () => show.click());
    expect(must('join-code').textContent).toBe('••••-••••');
    expect(show.getAttribute('aria-pressed')).toBe('false');
    expect(leaks(CODE_ONE)).toEqual([]);
  });

  it('Copy code copies the formatted code, says Copied., and does not reveal it', async () => {
    await mount(<JoinCode code={CODE_ONE} />);
    await act(async () => must<HTMLButtonElement>('join-code-copy').click());
    await settle(6);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('QWER-7XYZ');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied.');
    expect(must('join-code').textContent).toBe('••••-••••');
    expect(leaks(CODE_ONE)).toEqual([]);
  });

  it('a refused clipboard says so in words, throws nothing, and reveals nothing', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    await mount(<JoinCode code={CODE_ONE} />);
    await act(async () => must<HTMLButtonElement>('join-code-copy').click());
    await settle(6);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Could not copy. Use Show code instead.');
    expect(leaks(CODE_ONE)).toEqual([]);
  });

  it('each code keeps its own reveal: showing one leaves the other masked', async () => {
    await mount(
      <>
        <JoinCode code={CODE_ONE} />
        <JoinCode code={CODE_TWO} />
      </>,
    );
    await act(async () => all('join-code-show')[0].click());
    expect(all('join-code').map((el) => el.textContent)).toEqual(['QWER-7XYZ', '••••-••••']);
    expect(leaks(CODE_TWO)).toEqual([]);
  });
});

describe('TeacherPortal draws no join code in clear', () => {
  it('teacher home: every Your classes row is masked, with its controls outside the row link', async () => {
    await openHome();
    expect(all('join-code')).toHaveLength(2);
    expect(leaks(CODE_ONE)).toEqual([]);
    expect(leaks(CODE_TWO)).toEqual([]);
    for (const button of [...all('join-code-show'), ...all('join-code-copy')]) {
      expect(button.closest('a'), 'a button nested inside a link').toBeNull();
    }
    for (const link of host.querySelectorAll('a')) {
      expect(link.querySelector('button, a, input, select, textarea')).toBeNull();
    }
    // The row link still opens the class.
    expect(host.querySelector('a.exp-row[href="/teacher/class?class=class-one"]')?.textContent).toContain('Morning class');
    await act(async () => all('join-code-show')[1].click());
    expect(all('join-code').map((el) => el.textContent)).toEqual(['••••-••••', 'PLMK-3NBV']);
  });

  it('the class page: the invitation card is masked until Show code, and Copy copies it', async () => {
    await openClass();
    expect(host.textContent).toContain('Class join code');
    expect(all('join-code')).toHaveLength(1);
    expect(leaks(CODE_ONE)).toEqual([]);
    expect(leaks(CODE_TWO)).toEqual([]);
    await act(async () => must<HTMLButtonElement>('join-code-copy').click());
    await settle(6);
    expect(writeText).toHaveBeenCalledWith('QWER-7XYZ');
    expect(leaks(CODE_ONE)).toEqual([]);
    await act(async () => must<HTMLButtonElement>('join-code-show').click());
    expect(must('join-code').textContent).toBe('QWER-7XYZ');
  });

  it('the created-class receipt is masked', async () => {
    mocks.create.mockResolvedValue({ id: 'class-new', name: 'Fresh class', joinCode: 'ZXCV9BNM' });
    await openHome();
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Create class')!.click());
    const name = [...host.querySelectorAll('label')].find((l) => l.textContent?.includes('Class name'))!.querySelector('input')!;
    await act(async () => {
      fireEvent.change(name, { target: { value: 'Fresh class' } });
    });
    await act(async () => fireEvent.submit(host.querySelector('form.exp-form')!));
    await settle(6);
    const receipt = host.querySelector('[aria-label="Created class"]');
    expect(receipt?.textContent).toContain('Fresh class was created.');
    expect(receipt?.querySelector('[data-testid="join-code"]')?.textContent).toBe('••••-••••');
    expect(leaks('ZXCV9BNM')).toEqual([]);
  });
});

describe('the quiz download covers what the page is about', () => {
  const submitQuiz = async (kind: string) => {
    const select = must<HTMLSelectElement>('export-quiz-kind');
    await act(async () => {
      fireEvent.change(select, { target: { value: kind } });
    });
    await act(async () => must<HTMLButtonElement>('export-quiz-results').click());
    await settle(6);
  };

  it('the class page downloads that class only, and says so', async () => {
    await openClass('class-two');
    expect(must('export-quiz-form').textContent).toContain('For this class only.');
    expect(must('export-quiz-form').textContent).not.toContain('For every class of yours.');
    await submitQuiz('learners');
    expect(mocks.exportClassQuizResults).toHaveBeenCalledWith('learners', 'class-two');
    expect(mocks.exportQuizResults).not.toHaveBeenCalled();
    expect(mocks.saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'quiz-learners.csv');
  });

  it('teacher home downloads every class of the teacher, and says so', async () => {
    await openHome();
    expect(must('export-quiz-form').textContent).toContain('For every class of yours.');
    expect(must('export-quiz-form').textContent).not.toContain('For this class only.');
    await submitQuiz('class');
    expect(mocks.exportQuizResults).toHaveBeenCalledWith('class');
    expect(mocks.exportClassQuizResults).not.toHaveBeenCalled();
  });
});
