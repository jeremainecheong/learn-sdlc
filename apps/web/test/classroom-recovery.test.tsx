// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { fireEvent } from '@testing-library/dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ClassroomPage from '@/app/(app)/classroom/page';

const calls = vi.hoisted(() => ({ classroom: vi.fn(), leave: vi.fn(), join: vi.fn(), me: vi.fn(), reload: vi.fn(), session: vi.fn(), clear: vi.fn(), owner: 'test-session' }));
vi.mock('@/lib/api-experience', () => ({ experienceApi: { classroom: calls.classroom, leave: calls.leave } }));
vi.mock('@/lib/api-cohorts', () => ({ cohortsApi: { join: calls.join }, formatJoinCode: (code: string) => code }));
vi.mock('@/lib/api', () => ({ api: { me: calls.me }, describeError: (error: Error) => error.message }));
vi.mock('@/lib/session', () => ({ setSession: calls.session, getToken: () => calls.owner }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ reload: calls.reload }) }));
vi.mock('@/lib/project', () => ({ clearActiveProject: calls.clear }));
vi.mock('@/components/experience/shared', () => ({ ExperiencePage: ({ children }: { children: ReactNode }) => <main>{children}</main>, LoadingState: () => <p role="status">Loading membership</p> }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
let root: Root, host: HTMLDivElement;
const render = async () => { await act(async () => root.render(<ClassroomPage />)); };
beforeEach(() => { vi.resetAllMocks(); calls.owner = 'test-session'; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('does not turn an unavailable membership into a solo state and retries the actual read', async () => {
  calls.classroom.mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce({ id: 'class-a', name: 'Actual saved class', joinCode: 'ABCDEFGH' });
  await render();
  expect(host.textContent).toContain('Your class membership is unavailable.');
  expect(host.textContent).not.toContain('Learn solo, or join your class.');
  expect(host.querySelector('form')).toBeNull();
  const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry membership')!;
  await act(async () => retry.click());
  expect(calls.classroom).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain('Actual saved class');
  expect(host.textContent).not.toContain('Disconnected');
  expect(calls.join).not.toHaveBeenCalled();
  expect(calls.leave).not.toHaveBeenCalled();
});

it('offers the join form only after a successful read confirms no class', async () => {
  let resolve!: (value: null) => void;
  calls.classroom.mockImplementationOnce(() => new Promise<null>(yes => { resolve = yes; }));
  await render();
  expect(host.querySelector('form')).toBeNull();
  expect(host.textContent).toContain('Loading membership');
  await act(async () => resolve(null));
  expect(host.querySelector('form')).not.toBeNull();
  expect(host.textContent).toContain('Learn solo, or join your class.');
});

it('does not adopt an old page response after navigating to a new membership page', async () => {
  let resolve!: (value: unknown) => void;
  calls.classroom.mockImplementationOnce(() => new Promise(yes => { resolve = yes; })).mockResolvedValueOnce({ id: 'class-b', name: 'New account class', joinCode: 'BCDEFGHJ' });
  await render();
  act(() => root.render(<p>Signed out</p>));
  await render();
  await act(async () => resolve({ id: 'class-a', name: 'Previous account private class', joinCode: 'ABCDEFGH' }));
  expect(host.textContent).toContain('New account class');
  expect(host.textContent).not.toContain('Previous account private class');
});

for (const action of ['join', 'leave'] as const) {
  it(`keeps a successful ${action} receipt when account refresh fails and retries only reads`, async () => {
    const savedClass = { id: 'class-a', name: 'Saved class', joinCode: 'ABCDEFGH' };
    calls.classroom.mockResolvedValue(action === 'join' ? null : savedClass);
    calls.join.mockResolvedValue(savedClass); calls.leave.mockResolvedValue(undefined);
    calls.me.mockRejectedValueOnce(new Error('Connection unavailable')).mockResolvedValueOnce({ id: 'learner' });
    calls.reload.mockResolvedValue(undefined);
    await render();
    if (action === 'join') {
      const input = host.querySelector('input')!;
      act(() => { fireEvent.change(input, { target: { value: 'ABCDEFGH' } }); });
      await act(async () => { fireEvent.submit(host.querySelector('form')!); });
    } else await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Leave class')!.click());
    expect(host.textContent).toContain(action === 'join' ? 'You have joined your class.' : 'You are now learning independently.');
    expect(host.textContent).toContain('Your membership is saved.');
    expect(host.textContent).not.toContain('Your membership could not be updated.');
    expect(action === 'join' ? host.textContent : host.querySelector('h2')?.textContent).toContain(action === 'join' ? 'Saved class' : 'Learn solo');
    expect(calls[action]).toHaveBeenCalledTimes(1);
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry account refresh')!.click());
    expect(calls[action]).toHaveBeenCalledTimes(1);
    expect(calls.me).toHaveBeenCalledTimes(2); expect(calls.reload).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain('Connection unavailable');
    expect(host.textContent).toContain(action === 'join' ? 'You have joined your class.' : 'You are now learning independently.');
  });
}

it('does not replace a new account session with a previous membership refresh response', async () => {
  calls.classroom.mockResolvedValue({ id: 'class-a', name: 'Saved class', joinCode: 'ABCDEFGH' });
  calls.leave.mockResolvedValue(undefined);
  let resolve!: (value: unknown) => void;
  calls.me.mockImplementation(() => new Promise(yes => { resolve = yes; }));
  await render();
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Leave class')!.click());
  calls.owner = 'different-session';
  await act(async () => resolve({ id: 'previous-learner' }));
  expect(calls.session).not.toHaveBeenCalled(); expect(calls.reload).not.toHaveBeenCalled();
});

/**
 * A join or a leave changes which project the server resolves. The shell
 * reloads under the project the tab holds, and a read that names a project is
 * answered with the row held there, so if the page kept the project, a
 * learner who left a class on a teacher's project would stay on it. The page
 * forgets the project first, and the reload asks the server.
 */
for (const action of ['join', 'leave'] as const) {
  it(`forgets the project the tab holds before the shell reloads after a ${action}`, async () => {
    calls.classroom.mockResolvedValue(action === 'join' ? null : { id: 'class-a', name: 'Saved class', joinCode: 'ABCDEFGH' });
    calls.join.mockResolvedValue({ id: 'class-b', name: 'Saved class', joinCode: 'ABCDEFGH' });
    calls.leave.mockResolvedValue(undefined);
    calls.me.mockResolvedValue({ id: 'learner' });
    calls.reload.mockResolvedValue(undefined);
    await render();
    if (action === 'join') {
      act(() => { fireEvent.change(host.querySelector('input')!, { target: { value: 'ABCDEFGH' } }); });
      await act(async () => { fireEvent.submit(host.querySelector('form')!); });
    } else await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Leave class')!.click());

    expect(calls.clear).toHaveBeenCalledTimes(1);
    expect(calls.reload).toHaveBeenCalledTimes(1);
    expect(calls.clear.mock.invocationCallOrder[0]).toBeLessThan(calls.reload.mock.invocationCallOrder[0]);
  });
}

it('forgets nothing when the class refuses the change', async () => {
  calls.classroom.mockResolvedValue(null);
  calls.join.mockRejectedValue(new Error('No class has that code.'));
  await render();
  act(() => { fireEvent.change(host.querySelector('input')!, { target: { value: 'ABCDEFGH' } }); });
  await act(async () => { fireEvent.submit(host.querySelector('form')!); });
  expect(calls.clear).not.toHaveBeenCalled();
  expect(calls.reload).not.toHaveBeenCalled();
});

/**
 * What happens to the project, said where the learner acts. Their work stays in
 * their record either way; what they are shown next depends on whose project
 * the class was on, and the page says both halves rather than promising the
 * project "stays with you" when the dashboard is about to open another one.
 */
it('says what leaving does to the project, and that the work stays in the record', async () => {
  calls.classroom.mockResolvedValue({ id: 'class-a', name: 'Saved class', joinCode: 'ABCDEFGH' });
  calls.leave.mockResolvedValue(undefined);
  calls.me.mockResolvedValue({ id: 'learner' });
  calls.reload.mockResolvedValue(undefined);
  await render();
  expect(host.textContent).toContain('Your progress and project work stay in your record.');
  expect(host.textContent).toContain('your dashboard then opens the project for learners without a class');
  expect(host.textContent).not.toContain('stay with you');

  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Leave class')!.click());
  const status = host.querySelector('[role="status"]')?.textContent ?? '';
  expect(status).toContain('You are now learning independently.');
  expect(status).toContain('stay in your record');
  expect(status).toContain('your dashboard now opens the project for learners without a class');
});

/**
 * The confirmation after joining must not tell a learner who started the
 * platform project alone that they stay on it ("If you have not started a
 * project yet, your dashboard opens the one your class is on."): a class on
 * another project opens next. The confirmation says the same sentence as the
 * page above the form.
 */
it('says on joining that a class on another project opens next, and that started work stays in the record', async () => {
  calls.classroom.mockResolvedValue(null);
  calls.join.mockResolvedValue({ id: 'class-b', name: 'Saved class', joinCode: 'ABCDEFGH' });
  calls.me.mockResolvedValue({ id: 'learner' });
  calls.reload.mockResolvedValue(undefined);
  await render();
  act(() => { fireEvent.change(host.querySelector('input')!, { target: { value: 'ABCDEFGH' } }); });
  await act(async () => { fireEvent.submit(host.querySelector('form')!); });
  const status = [...host.querySelectorAll('[role="status"]')].map((node) => node.textContent).join(' ');
  expect(status).toContain('You have joined your class.');
  expect(status).not.toContain('If you have not started a project yet');
  expect(status).toContain(
    'If your class works on another project, your dashboard opens that one next, and the work you have already started stays in your record.',
  );
});

/**
 * What joining does to a project a learner started on their own.
 *
 * For the platform's projects the class's assignment outranks the learner's
 * own start. When the class works on another project, the one the learner
 * started is set aside, never deleted and never re-pinned, and the class's
 * project opens next. So the invitation does not ask them to join first, or
 * promise that joining keeps them on their own project. It says what happens
 * when they join late.
 */
it('tells a learner with a code what joining a class on another project does, and that their work stays', async () => {
  calls.classroom.mockResolvedValue(null);
  await render();
  expect(host.textContent).not.toContain('Your project is ready either way.');
  expect(host.textContent).toContain('join here so your teacher can follow your work');
  expect(host.textContent).not.toContain('Join before you start a project');
  expect(host.textContent).not.toContain('joining a class keeps you on it');
  expect(host.textContent).toContain(
    'If your class works on another project, your dashboard opens that one next, and the work you have already started stays in your record.',
  );
});
