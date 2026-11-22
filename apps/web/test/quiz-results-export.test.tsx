// @vitest-environment jsdom
/**
 * The teacher's quiz-results export.
 *
 * One button beside the two other exports, with a selector naming which of
 * the four read-only files (`QUIZ_RESULTS_EXPORT_KINDS`) to save. The button
 * hands the browser the file the API returns and draws none of it: a CSV is a
 * file to save, never a table to render on the page.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIZ_RESULTS_EXPORT_KINDS } from '@learnsdlc/shared';
import { TeacherPortal } from '@/components/staff/console/TeacherPortal';
import { settle } from './support/dom';

const CSV_SENTINEL = 'email,class,project,taskKey,epoch,attempt,position,questionId,outcome\r\nCSV-ROW-SENTINEL';

const mocks = vi.hoisted(() => ({
  mine: vi.fn(),
  overview: vi.fn(),
  learner: vi.fn(),
  audit: vi.fn(),
  exportQuizResults: vi.fn(),
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
vi.mock('@/lib/api-cohorts', () => ({
  cohortsApi: { mine: mocks.mine },
  formatJoinCode: (value: string) => value,
}));
vi.mock('@/lib/api-instructor', () => ({
  instructorApi: {
    overview: mocks.overview,
    learner: mocks.learner,
    learnersIn: (ids: readonly string[]) => Promise.all(ids.map((id) => mocks.learner(id))),
    audit: mocks.audit,
    exportQuizResults: mocks.exportQuizResults,
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
vi.mock('@/components/experience/ScrollRegion', () => ({
  ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({
  SubmissionEvidence: () => null,
}));

let host: HTMLDivElement;
let root: Root;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const must = <T extends HTMLElement>(id: string) => {
  const found = host.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`no element with test id ${id}`);
  return found;
};

const open = async () => {
  window.history.replaceState(null, '', '/teacher');
  await act(async () => root.render(<TeacherPortal />));
  await settle(5);
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  mocks.mine.mockResolvedValue([{ id: 'class-one', name: 'Example class', joinCode: 'EXAMPLE1', memberCount: 1 }]);
  mocks.overview.mockResolvedValue({ learners: [] });
  mocks.learner.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue([]);
  mocks.exportQuizResults.mockImplementation(async () => new Blob([CSV_SENTINEL], { type: 'text/csv' }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

describe('the quiz-results export', () => {
  it('the button downloads the chosen kind and renders no CSV content', async () => {
    await open();
    const exports = must('teacher-exports');
    const kind = must<HTMLSelectElement>('export-quiz-kind');
    // The selector offers exactly the four files, in the contract's order.
    expect([...kind.options].map((option) => option.value)).toEqual([...QUIZ_RESULTS_EXPORT_KINDS]);
    expect(exports.contains(kind)).toBe(true);
    const button = must<HTMLButtonElement>('export-quiz-results');
    expect(exports.contains(button)).toBe(true);

    for (const chosen of ['questions', 'class'] as const) {
      await act(async () => {
        fireEvent.change(kind, { target: { value: chosen } });
      });
      await act(async () => button.click());
      await settle(5);
      expect(mocks.exportQuizResults).toHaveBeenLastCalledWith(chosen);
      const [blob, name] = mocks.saveBlob.mock.calls.at(-1)!;
      expect(blob).toBeInstanceOf(Blob);
      expect(name).toBe(`quiz-${chosen}.csv`);
    }
    expect(mocks.exportQuizResults).toHaveBeenCalledTimes(2);
    expect(mocks.saveBlob).toHaveBeenCalledTimes(2);
    // Nothing of the file is drawn on the page.
    expect(host.textContent).not.toContain('CSV-ROW-SENTINEL');
    expect(host.textContent).not.toContain('questionId');
    expect(host.innerHTML).not.toContain('CSV-ROW-SENTINEL');
  });

  it('says so when the export is refused, and saves nothing', async () => {
    mocks.exportQuizResults.mockRejectedValueOnce(Object.assign(new Error('Too many exports. Try again in a minute.'), { status: 429 }));
    await open();
    await act(async () => must<HTMLButtonElement>('export-quiz-results').click());
    await settle(5);
    expect(mocks.exportQuizResults).toHaveBeenCalledWith('learners');
    expect(mocks.saveBlob).not.toHaveBeenCalled();
    expect(host.textContent).toMatch(/quiz results could not be exported|Too many exports/i);
  });
});
