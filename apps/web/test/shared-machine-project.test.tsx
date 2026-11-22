/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UserProfile } from '@learnsdlc/shared';

/**
 * One tab, two learners: the lab machine, which is the normal case here.
 *
 * A browser run found this: learner one, in a class assigned their teacher's
 * project, signed out; learner two registered in the same tab, chose to learn
 * independently, pressed Start learning, and was enrolled into the teacher's
 * project, pinned to its version, in a class they were not in. Nothing was
 * wrong with either account. What was wrong is that "the project" was a module
 * variable held for the tab, and the tab outlived the account: setup read it
 * and sent it as the slug to enrol into.
 *
 * So two things are held down here, and they are held down against the real
 * modules rather than mocks of them, because the bug lived in the wiring
 * between them:
 *
 * 1. Signing out (or signing in as somebody else over the top) empties the
 *    slug the tab holds.
 * 2. Setup does not name a project at all. The server is the only party that
 *    knows which project a learner has been given, and the request asks it.
 */
const routed = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: routed.replace }) }));

type Session = typeof import('@/lib/session');
type Project = typeof import('@/lib/project');

let session: Session;
let project: Project;
let OnboardingPage: (typeof import('@/app/(app)/onboarding/page'))['default'];
const fetchMock = vi.fn();
let host: HTMLDivElement;
let root: Root;

const answer = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: { get: () => null },
  }) as unknown as Response;

const learner = (id: string, email: string): UserProfile => ({
  id,
  email,
  displayName: 'Learner',
  role: 'LEARNER',
  cohort: 'default',
  profileVersion: 1,
  createdAt: '2026-09-20T00:00:00.000Z',
});

/** Every request the mocked `fetch` was given, as method, path and body. */
const calls = (): { method: string; path: string; body: unknown }[] =>
  fetchMock.mock.calls.map(([url, init]) => ({
    method: String((init as RequestInit)?.method ?? 'GET'),
    path: String(url),
    body: (init as RequestInit)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined,
  }));

beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  routed.replace.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  session = await import('@/lib/session');
  project = await import('@/lib/project');
  // Imported for its side effect: the per-tab caches, the slug among them, are
  // registered here to empty when the session does.
  await import('@/lib/useProject');
  OnboardingPage = (await import('@/app/(app)/onboarding/page')).default;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('empties the project the tab holds when the account leaves it', () => {
  session.setAuthSession('token-one', learner('one', 'one@lab.test'));
  // What learner one's shell resolved: their class's teacher-authored project.
  project.setActiveProject('library-desk');
  expect(project.getActiveProject()).toBe('library-desk');

  session.clearSession();
  expect(project.getActiveProject()).toBe('');

  // And without a sign-out at all: registering over the top of a live
  // session, which is what the second learner at the machine actually does.
  session.setAuthSession('token-one', learner('one', 'one@lab.test'));
  project.setActiveProject('library-desk');
  session.setAuthSession('token-two', learner('two', 'two@lab.test'));
  expect(project.getActiveProject()).toBe('');
});

it('lets the server say which project the next learner starts, and never the last one', async () => {
  session.setAuthSession('token-one', learner('one', 'one@lab.test'));
  project.setActiveProject('library-desk');
  session.clearSession();

  session.setAuthSession('token-two', learner('two', 'two@lab.test'));
  fetchMock.mockImplementation((url: string, init: RequestInit) =>
    Promise.resolve(
      // Learning independently asks whether this account is in a class first:
      // it is not.
      String(url).endsWith('/enrollments/classroom')
        ? answer(200, { classroom: null })
        : String(url).includes('/enrollments')
        ? answer(201, { id: 'enrolment-two', projectSlug: 'tasktrackr', phases: [] })
        : answer(200, {
            ...learner('two', 'two@lab.test'),
            onboardingCompleted: true,
            profileVersion: 2,
            avatar: 0,
            displayName: JSON.parse(String(init.body)).displayName,
          }),
    ),
  );

  act(() => root.render(<OnboardingPage />));
  const name = host.querySelector('input[autocomplete="name"]') as HTMLInputElement;
  act(() => {
    fireEvent.change(name, { target: { value: 'Two' } });
  });
  await act(async () => {
    fireEvent.submit(host.querySelector('form')!);
  });

  const enrolment = calls().find((call) => call.path.endsWith('/enrollments'));
  expect(enrolment).toBeDefined();
  expect(enrolment!.method).toBe('POST');
  // The whole defect in one assertion: the body carries no project at all, so
  // it cannot carry the last account's.
  expect(enrolment!.body).toEqual({});
  expect(JSON.stringify(enrolment!.body)).not.toContain('library-desk');

  // And what the tab holds afterwards is the server's answer for *this*
  // learner, so the shell opens on the project they were actually given.
  expect(project.getActiveProject()).toBe('tasktrackr');
  expect(routed.replace).toHaveBeenCalledWith('/dashboard');
});

it("shows the server's refusal and leaves the learner able to try again", async () => {
  session.setAuthSession('token-two', learner('two', 'two@lab.test'));
  const refusal = 'Nothing was started, because that project is not one this account can start; your dashboard opens the project that is yours.';
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(
      String(url).endsWith('/enrollments/classroom')
        ? answer(200, { classroom: null })
        : String(url).includes('/enrollments')
        ? answer(403, { message: refusal })
        : answer(200, learner('two', 'two@lab.test')),
    ),
  );

  act(() => root.render(<OnboardingPage />));
  await act(async () => {
    fireEvent.submit(host.querySelector('form')!);
  });

  expect(host.querySelector('[role="alert"]')?.textContent).toContain(refusal);
  // Setup is not marked complete, and the button is live for the retry.
  expect(calls().some((call) => call.path.includes('/account/profile'))).toBe(false);
  expect(routed.replace).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLButtonElement>('.onboarding-submit')!.disabled).toBe(false);
});
