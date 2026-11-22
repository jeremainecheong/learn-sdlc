// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeacherPortal } from '@/components/staff/console/TeacherPortal';
const mocks = vi.hoisted(() => ({ mine: vi.fn(), overview: vi.fn(), learner: vi.fn(), notes: vi.fn(), router: { push: vi.fn(), replace: vi.fn() }, user: { id: 'teacher', role: 'INSTRUCTOR' } }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => { window.addEventListener('popstate', notify); return () => window.removeEventListener('popstate', notify); };
  return { useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => '')), useRouter: () => mocks.router };
});
vi.mock('@/lib/session', async original => ({ ...await original<typeof import('@/lib/session')>(), useSession: () => mocks.user }));
vi.mock('@/lib/api-cohorts', () => ({ cohortsApi: { mine: mocks.mine }, formatJoinCode: (code: string) => code }));
vi.mock('@/lib/api-instructor', () => ({ instructorApi: { overview: mocks.overview, learner: mocks.learner, learnersIn: (ids: readonly string[]) => Promise.all(ids.map((id) => mocks.learner(id))) } }));
vi.mock('@/lib/api-experience', () => ({ experienceApi: { teacherFeedback: mocks.notes } }));
vi.mock('@/components/staff/StuckList', () => ({ StuckList: () => null }));
vi.mock('@/components/experience/ScrollRegion', () => ({ ScrollRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
let root: Root, host: HTMLDivElement;
const detail = (id: string) => ({ userId: id, displayName: id, email: `${id}@example.test`, cohort: 'class', enrollments: [{ projectSlug: 'tasktrackr', currentPhaseOrder: 1, phases: [{ id: `phase-${id}`, key: 'requirements', order: 1, status: 'in_progress', attempts: id === 'No review learner' ? 0 : 1, lastSubmission: id === 'No review learner' ? null : { id: `review-${id}`, status: id === 'Failed job learner' ? 'failed' : 'completed', passed: id === 'Pass learner', verifiedPass: id === 'Pass learner', createdAt: '2026-09-12T00:00:00Z', report: { aiReview: { ...(id === 'Unavailable learner' ? { assessmentError: 'invalid_assessment' } : {}) } } } }] }] });
const ids = ['Revision learner', 'Unavailable learner', 'Failed job learner', 'Pass learner', 'No review learner'];
beforeEach(() => {
  window.history.replaceState(null, '', '/teacher/class?class=class');
  const push = window.history.pushState.bind(window.history);
  vi.spyOn(window.history, 'pushState').mockImplementation((...args) => { push(...args); window.dispatchEvent(new PopStateEvent('popstate')); });
  vi.clearAllMocks(); mocks.mine.mockResolvedValue([{ id: 'class', name: 'Test class', joinCode: 'TEST12', memberCount: ids.length }]);
  mocks.overview.mockResolvedValue({ learners: ids.map(id => ({ userId: id, cohort: 'class' })) });
  mocks.learner.mockImplementation(async id => detail(id)); mocks.notes.mockResolvedValue([]);
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
describe('teacher review-result filter', () => {
  it('lets teachers distinguish actual revision requests, unavailable assessments, verified passes and absent submissions', async () => {
    await act(async () => root.render(<TeacherPortal classView />));
    const control = [...host.querySelectorAll('label')].find(label => label.textContent?.includes('Latest verdict'))!.querySelector('select')!;
    const rows = () => [...host.querySelectorAll('.exp-table tbody tr')].map(row => row.querySelector('strong')?.textContent);
    expect(rows()).toHaveLength(5);
    for (const [value, expected] of [
      ['revision', ['Revision learner']], ['unavailable', ['Failed job learner', 'Unavailable learner']], ['pass', ['Pass learner']], ['none', ['No review learner']],
    ] as const) {
      await act(async () => { fireEvent.change(control, { target: { value: value } }); });
      expect(rows()).toEqual(expected);
    }
    expect(mocks.learner).toHaveBeenCalledTimes(5);
    expect(mocks.notes).toHaveBeenCalledTimes(4);
  });
});
