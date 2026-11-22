// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeacherPortal } from '@/components/staff/console/TeacherPortal';
import { LessonReader } from '@/components/learn/LessonReader';
import { lessonChapter, patchPageHref, teacherReturnHref, updatePageQuery } from '@/lib/navigation';

const mocks = vi.hoisted(() => ({ mine: vi.fn(), create: vi.fn(), me: vi.fn(), overview: vi.fn(), learner: vi.fn(), audit: vi.fn(), history: vi.fn(), notes: vi.fn(), router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => { window.addEventListener('popstate', notify); return () => window.removeEventListener('popstate', notify); };
  return { useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => '')), useRouter: () => mocks.router };
});
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/shell', () => ({ DocPage: ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => <>{children}{aside}</>, PersonaPanel: () => <textarea aria-label="Mentor draft" />, phaseDoorHref: () => '/workspace/phase' }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ enrollment: null }) }));
vi.mock('@/lib/session', async original => ({ ...await original<typeof import('@/lib/session')>(), setSession: vi.fn(), useSession: () => ({ id: 'teacher', role: 'INSTRUCTOR' }) }));
vi.mock('@/lib/api-cohorts', () => ({ cohortsApi: { mine: mocks.mine, create: mocks.create }, formatJoinCode: (value: string) => value }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { me: mocks.me } }));
// `audit` is read with the evidence the teacher opens: the record
// of changes is where the three per-task levers are read back.
vi.mock('@/lib/api-instructor', () => ({ instructorApi: { overview: mocks.overview, learner: mocks.learner, learnersIn: (ids: readonly string[]) => Promise.all(ids.map((id) => mocks.learner(id))), audit: mocks.audit } }));
vi.mock('@/lib/api-experience', () => ({ experienceApi: { teacherFeedback: mocks.notes, teacherSubmissions: mocks.history } }));
vi.mock('@/components/staff/StuckList', () => ({ StuckList: () => null }));
vi.mock('@/components/experience/ScrollRegion', () => ({ ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: ({ submissionId }: { submissionId: string }) => <section data-testid="selected-evidence">{submissionId}<textarea aria-label="Retained feedback draft" /></section> }));

let host: HTMLDivElement, root: Root;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const records = [{ id: 'old-review', status: 'completed', passed: false, reviewUnavailable: false, createdAt: '2026-09-11T00:00:00Z', attempt: 1 }, { id: 'new-review', status: 'completed', passed: false, reviewUnavailable: false, createdAt: '2026-09-12T00:00:00Z', attempt: 2 }];
const phase = { id: 'phase-one', title: 'Requirements', key: 'requirements', order: 1, status: 'in_progress', attempts: 2, lastSubmission: { ...records[1], report: {} } };
const learner = { userId: 'learner-one', displayName: 'Example learner', email: 'learner@example.test', cohort: 'class-one', enrollments: [{ projectSlug: 'tasktrackr', currentPhaseOrder: 1, phases: [phase] }] };
const button = (name: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === name)!;
const labelControl = (name: string) => [...host.querySelectorAll('label')].find(node => node.textContent?.startsWith(name))!.querySelector<HTMLInputElement | HTMLSelectElement>('input,select')!;
const change = (control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) => act(() => { fireEvent.change(control, { target: { value: value } }); });
const navigate = async (direction: 'back' | 'forward') => act(async () => { const moved = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true })); window.history[direction](); await moved; });

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/teacher/class?class=class-one');
  // jsdom has no Next router. Model Next 14's documented native-history subscription.
  const push = window.history.pushState.bind(window.history), replace = window.history.replaceState.bind(window.history);
  vi.spyOn(window.history, 'pushState').mockImplementation((...args) => { push(...args); window.dispatchEvent(new PopStateEvent('popstate')); });
  vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => { replace(...args); window.dispatchEvent(new PopStateEvent('popstate')); });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  mocks.mine.mockResolvedValue([{ id: 'class-one', name: 'Example class', joinCode: 'EXAMPLE1', memberCount: 1 }]);
  mocks.overview.mockResolvedValue({ learners: [{ userId: learner.userId, cohort: learner.cohort }] });
  mocks.learner.mockResolvedValue(learner); mocks.history.mockResolvedValue(records); mocks.notes.mockResolvedValue([]); mocks.audit.mockResolvedValue([]);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll); else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView"); });

describe('page navigation state', () => {
  it('patches only owned query keys and validates dossier return destinations', () => {
    expect(patchPageHref('/teacher/class?class=c&search=Lee&tracking=keep#evidence', { view: 'table', search: null })).toBe('/teacher/class?class=c&tracking=keep&view=table#evidence');
    const destination = '/teacher/class?class=c&search=Lee&evidence=l&phase=p&submission=s#evidence';
    expect(teacherReturnHref(destination, 'l')).toBe(destination);
    for (const bad of ['https://example.com', '//example.com', '/\\example.com', '/teacher/../account', '/teacher/settings', '/\t/example.com']) expect(teacherReturnHref(bad, 'l')).toBe('/teacher?learner=l');
    for (const value of [null, '', '0', '5', '-1', '2.5', '1e2', '99999999999999999999']) expect(lessonChapter(value, 4)).toBe(0);
    expect(lessonChapter('3', 4)).toBe(2);
  });

  it('deep-links a chapter and restores chapter selection with Back and Forward', async () => {
    window.history.replaceState(null, '', '/learn/requirements?chapter=3&from=feedback');
    await act(async () => root.render(<LessonReader phaseKey="requirements" />));
    const currentChapter = () => [...host.querySelectorAll('.lesson-chapters button')].findIndex(node => node.getAttribute('aria-current') === 'step');
    expect(currentChapter()).toBe(2);
    act(() => button('Next chapter').click());
    expect(currentChapter()).toBe(3); expect(window.location.search).toBe('?chapter=4&from=feedback');
    await navigate('back'); expect(currentChapter()).toBe(2);
    await navigate('forward'); expect(currentChapter()).toBe(3);
    expect(document.activeElement).toBe(host.querySelector('#lesson-chapter-title'));
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it('retains class filters, exact historical evidence and an unsaved form while URL controls change', async () => {
    window.history.replaceState(null, '', '/teacher/class?class=class-one&tracking=keep&evidence=learner-one&phase=phase-one&submission=old-review');
    await act(async () => root.render(<TeacherPortal classView />));
    expect(host.querySelector('[data-testid="selected-evidence"]')?.textContent).toBe('old-review');
    const draft = host.querySelector<HTMLTextAreaElement>('[aria-label="Retained feedback draft"]')!;
    change(draft, 'An unsaved teacher note');
    const length = history.length;
    change(labelControl('Find a learner'), 'Exam'); change(labelControl('Find a learner'), 'Example');
    expect(history.length).toBe(length); expect(new URLSearchParams(location.search).get('search')).toBe('Example');
    act(() => button('Table').click());
    expect(host.querySelector('[aria-label="Retained feedback draft"]')).toBe(draft); expect(draft.value).toBe('An unsaved teacher note');
    expect(mocks.overview).toHaveBeenCalledTimes(1); expect(mocks.history).toHaveBeenCalledTimes(1);
    change(labelControl('Submission history'), 'new-review');
    expect(host.querySelector('[data-testid="selected-evidence"]')?.textContent).toBe('new-review');
    await navigate('back'); expect(host.querySelector('[data-testid="selected-evidence"]')?.textContent).toBe('old-review');
    await navigate('forward'); expect(host.querySelector('[data-testid="selected-evidence"]')?.textContent).toBe('new-review');
    const print = [...host.querySelectorAll('a')].find(node => node.textContent?.includes('Print submitted evidence'))!;
    const returnTo = new URL(print.href).searchParams.get('returnTo');
    expect(returnTo).toBe(location.pathname + location.search);
    expect(new URLSearchParams(location.search).get('tracking')).toBe('keep');
    expect(new URLSearchParams(location.search).get('learner')).toBeNull();
  });

  it('retries unavailable evidence in the same deep-linked review without replacing it with another record', async () => {
    mocks.history.mockRejectedValueOnce(new Error('Connection unavailable')).mockResolvedValueOnce(records);
    window.history.replaceState(null, '', '/teacher/class?class=class-one&evidence=learner-one&phase=phase-one&submission=old-review&verdict=revision');
    await act(async () => root.render(<TeacherPortal classView />));
    expect(host.querySelector('[data-testid="selected-evidence"]')).toBeNull();
    const url = location.href;
    await act(async () => button('Retry evidence').click());
    expect(location.href).toBe(url); expect(mocks.history).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="selected-evidence"]')?.textContent).toBe('old-review');
  });

  it('does not silently substitute the latest submission for an unknown historical identifier', async () => {
    window.history.replaceState(null, '', '/teacher/class?class=class-one&evidence=learner-one&phase=phase-one&submission=missing');
    await act(async () => root.render(<TeacherPortal classView />));
    expect(host.querySelector('[data-testid="selected-evidence"]')).toBeNull();
    expect(host.textContent).toContain('This review is not in the selected phase');
    expect(labelControl('Submission history').value).toBe('');
    expect((labelControl('Submission history') as HTMLSelectElement).selectedOptions[0].textContent).toBe('Choose a recorded review');
    act(() => updatePageQuery({ submission: 'old-review' }));
    expect(host.querySelector('[data-testid="selected-evidence"]')?.textContent).toBe('old-review');
  });
  it.each(['profile', 'roster'])('keeps the created class receipt when the %s GET fails and retries no POST', async (failure) => {
    mocks.create.mockResolvedValue({ id: 'created-class', name: 'Confirmed class', joinCode: 'NEWCLASS' });
    mocks.me.mockResolvedValue({ id: 'teacher' });
    if (failure === 'profile') mocks.me.mockRejectedValueOnce(new Error('Profile unavailable'));
    await act(async () => root.render(<TeacherPortal />));
    if (failure === 'roster') mocks.mine.mockRejectedValueOnce(new Error('Roster unavailable'));
    act(() => button('Create class').click());
    change(labelControl('Class name'), 'Confirmed class');
    await act(async () => fireEvent.submit(host.querySelector('form')!));
    expect(host.querySelector('[aria-label="Created class"]')?.textContent).toContain('Confirmed class was created.');
    expect(host.textContent).toContain('Your class is saved.');
    expect(host.textContent).not.toContain('The class could not be created.');
    // A new class opens on its Project tab; it has no project yet.
    expect(host.querySelector('[aria-label="Created class"] a')?.getAttribute('href')).toBe('/teacher/class?class=created-class&tab=project');
    await act(async () => button('Retry account refresh').click());
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.me).toHaveBeenCalledTimes(2);
    expect(mocks.router.push).toHaveBeenCalledWith('/teacher/class?class=created-class&tab=project');
    expect(host.textContent).not.toContain('Profile unavailable');
  });

});
