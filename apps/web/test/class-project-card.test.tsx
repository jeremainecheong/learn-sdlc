// @vitest-environment jsdom
/**
 * The class's project card.
 *
 * `@/lib/api` is mocked one layer down rather than `@/lib/api-instructor`, so
 * these tests also hold the client honest about the paths and methods in
 * `AUTHORING_ROUTES`: a card that reads the right rows from the wrong route is
 * a card that works in a test and 404s in the product.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSIGNMENT_REASON_MIN,
  type AssignableVersionView,
  type CohortProjectAssignmentView,
  type CohortProjectView,
} from '@learnsdlc/shared';
import { ASSIGNMENT_REASON_MAX } from '@learnsdlc/shared';
import { ClassProjectCard } from '@/components/staff/ClassProjectCard';

const calls = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  request: calls.request,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const READ = '/instructor/cohorts/class-one/project';
const ASSIGNABLE = '/instructor/cohorts/class-one/project/assignable';
const REASON = 'The cohort moves to the reviewed version for the new term.';

const assignment = (over: Partial<CohortProjectAssignmentView> = {}): CohortProjectAssignmentView => ({
  id: 'assign-one',
  cohortId: 'class-one',
  projectVersionId: 'version-default',
  projectSlug: 'tasktrackr',
  projectTitle: 'TaskTrackr',
  version: '1.0.0',
  assignedByUserId: 'teacher-a',
  assignedByName: 'Teacher A',
  reason: 'The class starts on the platform project.',
  active: true,
  createdAt: '2026-09-10T09:00:00Z',
  ...over,
});

const version = (over: Partial<AssignableVersionView> = {}): AssignableVersionView => ({
  projectId: 'project-default',
  projectSlug: 'tasktrackr',
  projectTitle: 'TaskTrackr',
  platformOwned: true,
  mine: false,
  versionId: 'version-default',
  version: '1.0.0',
  publishedAt: null,
  current: true,
  ...over,
});

const mine = version({
  projectId: 'project-mine',
  projectSlug: 'delivery-lab',
  projectTitle: 'Delivery Lab',
  platformOwned: false,
  mine: true,
  versionId: 'version-mine',
  version: '0.2.0',
  publishedAt: '2026-09-15T08:00:00Z',
  current: false,
});

let host: HTMLDivElement;
let root: Root;
const q = <T extends HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`)!;
const render = async () => {
  await act(async () => root.render(<ClassProjectCard cohortId="class-one" />));
};
const choose = async (value: string) =>
  act(async () => {
    fireEvent.change(q<HTMLSelectElement>('class-project-pick'), { target: { value: value } });
  });
const say = async (value: string) =>
  act(async () => {
    fireEvent.change(q<HTMLTextAreaElement>('class-project-reason'), { target: { value: value } });
  });
const submit = async () => act(async () => fireEvent.submit(host.querySelector('form')!));

/** One router for the three routes the card is allowed to touch. */
const serve = (view: CohortProjectView, versions: AssignableVersionView[]) => {
  calls.request.mockImplementation((method: string, path: string) => {
    if (method === 'GET' && path === READ) return Promise.resolve(view);
    if (method === 'GET' && path === ASSIGNABLE) return Promise.resolve(versions);
    if (method === 'PUT' && path === READ) return Promise.resolve(view);
    return Promise.reject(new Error(`no route for ${method} ${path}`));
  });
};

const held = (over: Partial<CohortProjectView> = {}): CohortProjectView => ({
  cohortId: 'class-one',
  active: assignment(),
  history: [assignment()],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  calls.request.mockReset();
  serve(held(), [version(), mine]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the project for a class', () => {
  it('reads the contract routes and names the version in force with the sentence about pinned learners', async () => {
    await render();
    expect(calls.request.mock.calls.map(([method, path]) => `${method} ${path}`).sort()).toEqual([
      `GET ${READ}`,
      `GET ${ASSIGNABLE}`,
    ]);
    expect(q('class-project-active').textContent).toContain('TaskTrackr');
    expect(q('class-project-active').textContent).toContain('1.0.0');
    expect(q('class-project-active').textContent).toContain('Teacher A');
    // Assigning a teacher's project sets aside every platform row the class's
    // learners started and shows them its Start, so the card must not say
    // "Learners already in this class keep the version they started on".
    // Every pin stays where it was; what moves is which project their
    // dashboard opens, and the card says who stays and who is shown the new
    // Start.
    const pinned = q('class-project-pinned').textContent!;
    expect(pinned).not.toContain('Learners already in this class keep the version they started on');
    expect(pinned).toContain('A learner who joins from now on is given the version you assign.');
    expect(pinned).toContain(
      "Learners working a teacher's project this class was given stay on it, at the version they started on.",
    );
    // Assigning sets aside a row on the default project or ANY platform
    // project other than the class's (`WorkflowService.standing`,
    // `yielding`), so the card must not name a single platform project.
    expect(pinned).not.toContain('Learners working the platform project');
    expect(pinned).toContain(
      'Learners working the default project or any other platform project move to the Start of the project you assign, unless they are working it already, and the work they did before stays in their record.',
    );
    expect(host.querySelector('a[href="/teacher/projects"]')).not.toBeNull();
  });

  /**
   * What the card says depends on what is being assigned. A teacher's
   * project moves the learners of the default project and of every platform
   * project to its Start; a platform project keeps its own learners where
   * they are and moves the learners of the default and of every OTHER
   * platform project to its Start (the server sets aside any `yielding` row
   * whose slug is not the class's, so a second platform project's learners
   * must be mentioned too).
   */
  it('says who stays and who moves to the new Start for the version chosen', async () => {
    await render();
    await choose('version-mine');
    const toTeachers = q('class-project-pinned').textContent!;
    expect(toTeachers).toContain(
      'Learners working the default project or any other platform project move to the Start of Delivery Lab, and the work they did before stays in their record.',
    );
    expect(toTeachers).toContain(
      "Learners working a teacher's project this class was given stay on it, at the version they started on.",
    );
    expect(toTeachers).not.toContain('unless they are working it already');
    serve(held({ active: null, history: [] }), [version({ current: false }), mine]);
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    await choose('version-default');
    const toPlatform = q('class-project-pinned').textContent!;
    expect(toPlatform).toContain('Learners working TaskTrackr stay on it too, at the version they started on.');
    // A platform version must not say only who stays, as if a learner on
    // the default or on a second platform project stayed too. They do not.
    expect(toPlatform).toContain(
      'Every other learner working the default project or a platform project moves to the Start of TaskTrackr, and the work they did before stays in their record.',
    );
    expect(toPlatform).toContain(
      "Learners working a teacher's project this class was given stay on it, at the version they started on.",
    );
  });

  it('names a second platform project’s learners as moving when the class is put on the first', async () => {
    const ledger = version({
      projectId: 'project-ledger',
      projectSlug: 'ledger',
      projectTitle: 'Ledger',
      versionId: 'version-ledger',
      version: '1.1.0',
      current: false,
    });
    serve(held(), [version(), ledger, mine]);
    await render();
    await choose('version-ledger');
    const toLedger = q('class-project-pinned').textContent!;
    expect(toLedger).toContain('Learners working Ledger stay on it too, at the version they started on.');
    expect(toLedger).toContain(
      'Every other learner working the default project or a platform project moves to the Start of Ledger, and the work they did before stays in their record.',
    );
    await say(REASON);
    await submit();
    // The receipt names the version once; who stays and who moves
    // was said under "What assigning does" before the press (checked above).
    const receipt = q('class-project-status').textContent!;
    expect(receipt).toBe('Assigned. Ledger 1.1.0 is what a learner who joins this class from now on is given.');
  });

  it('offers what the API says is assignable and will not re-assign the version already in force', async () => {
    await render();
    const options = [...q<HTMLSelectElement>('class-project-pick').options];
    // The teacher's own versions come first (assignableOrder), the
    // platform's after them; the placeholder stays first.
    expect(options.map((option) => option.value)).toEqual(['', 'version-mine', 'version-default']);
    const current = options.find((option) => option.value === 'version-default')!;
    expect(current.disabled).toBe(true);
    expect(current.textContent).toContain('assigned now');
    expect(options.find((option) => option.value === 'version-mine')!.disabled).toBe(false);
    expect(host.textContent).toContain('Delivery Lab');
  });

  it('refuses a reason shorter than the audited minimum and sends nothing', async () => {
    await render();
    await choose('version-mine');
    await say('too short');
    expect(q<HTMLButtonElement>('class-project-assign').disabled).toBe(true);
    expect(host.textContent).toContain(`${ASSIGNMENT_REASON_MIN} characters`);
    await submit();
    expect(calls.request.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(0);
  });

  it('names both bounds on the reason and counts what is typed against the one the route enforces', async () => {
    await render();
    const rule = q('class-project-reason-rule');
    expect(rule.textContent).toContain(`At least ${ASSIGNMENT_REASON_MIN} characters`);
    expect(rule.textContent).toContain(`at most ${ASSIGNMENT_REASON_MAX}`);
    // The ceiling the card stops typing at is the one `AssignProjectDto`
    // validates with: `@MaxLength(1000)` in
    // apps/api/src/classroom/cohort-project.dto.ts. A card that stopped sooner
    // would refuse a reason the route would have taken, with nothing on screen
    // saying why the keyboard went quiet.
    expect(ASSIGNMENT_REASON_MAX).toBe(1000);
    const box = q<HTMLTextAreaElement>('class-project-reason');
    expect(box.maxLength).toBe(ASSIGNMENT_REASON_MAX);
    expect(box.getAttribute('aria-describedby')).toContain('class-project-reason-count');
    expect(q('class-project-reason-count').textContent).toBe(`0 of ${ASSIGNMENT_REASON_MAX}`);
    await say(REASON);
    expect(q('class-project-reason-count').textContent).toBe(`${REASON.length} of ${ASSIGNMENT_REASON_MAX}`);
  });

  it('sends the chosen version with its reason, then re-reads the class', async () => {
    await render();
    await choose('version-mine');
    await say(REASON);
    expect(q<HTMLButtonElement>('class-project-assign').disabled).toBe(false);
    serve(
      held({
        active: assignment({ id: 'assign-two', projectVersionId: 'version-mine', projectSlug: 'delivery-lab', projectTitle: 'Delivery Lab', version: '0.2.0', reason: REASON, createdAt: '2026-09-19T09:00:00Z' }),
        history: [
          assignment({ id: 'assign-two', projectVersionId: 'version-mine', projectTitle: 'Delivery Lab', version: '0.2.0', reason: REASON, createdAt: '2026-09-19T09:00:00Z' }),
          assignment({ active: false }),
        ],
      }),
      [version({ current: false }), { ...mine, current: true }],
    );
    await submit();
    expect(calls.request).toHaveBeenCalledWith('PUT', READ, {
      projectVersionId: 'version-mine',
      reason: REASON,
    });
    expect(q('class-project-status').textContent).toContain('Delivery Lab 0.2.0');
    // The receipt names the version once and does not repeat the
    // "What assigning does" sentences drawn under the form (said before the press).
    expect(q('class-project-status').textContent).toBe('Assigned. Delivery Lab 0.2.0 is what a learner who joins this class from now on is given.');
    expect(q('class-project-status').textContent!.match(/joins (this class )?from now on is given/g)).toHaveLength(1);
    expect(q('class-project-status').textContent).not.toContain('Learners already in this class keep the version they started on.');
    expect(q('class-project-status').textContent).not.toContain("Learners working a teacher's project");
    // With a version in force, the form is for moving the class on.
    expect(host.textContent).toContain('Another version to assign');
    expect(q('class-project-status').getAttribute('role')).toBe('status');
    expect(calls.request.mock.calls.filter(([method, path]) => method === 'GET' && path === READ)).toHaveLength(2);
    expect(q('class-project-active').textContent).toContain('Delivery Lab');
    expect(q<HTMLTextAreaElement>('class-project-reason').value).toBe('');
  });

  it('keeps the chosen version and the typed reason when the assignment is refused, and never claims the class moved', async () => {
    await render();
    await choose('version-mine');
    await say(REASON);
    calls.request.mockImplementationOnce(() => Promise.reject(new Error('Disconnected')));
    await submit();
    expect(q('class-project-error')).not.toBeNull();
    expect(q('class-project-status').textContent).toBe('');
    expect(q<HTMLSelectElement>('class-project-pick').value).toBe('version-mine');
    expect(q<HTMLTextAreaElement>('class-project-reason').value).toBe(REASON);
    expect(q('class-project-active').textContent).toContain('TaskTrackr');
  });

  it("tells the page once that it saved an assignment, after the API answers, and never when the assignment is refused", async () => {
    const onAssigned = vi.fn();
    // The page's board and levers re-read the class's assignment on this call (TeacherPortal's assignmentRound).
    await act(async () => root.render(<ClassProjectCard cohortId="class-one" onAssigned={onAssigned} />));
    await choose('version-mine');
    await say(REASON);
    calls.request.mockImplementationOnce(() => Promise.reject(new Error('Disconnected')));
    await submit();
    expect(q('class-project-error')).not.toBeNull();
    expect(onAssigned).not.toHaveBeenCalled();
    const answered: string[] = [];
    const routes = calls.request.getMockImplementation()!;
    calls.request.mockImplementation((method: string, path: string, ...rest: unknown[]) => {
      if (method === 'PUT') answered.push('put');
      return routes(method, path, ...rest);
    });
    onAssigned.mockImplementation(() => answered.push('told'));
    await submit();
    expect(onAssigned).toHaveBeenCalledTimes(1);
    expect(answered).toEqual(['put', 'told']);
  });

  it('names the month in "In force since" and in the history, never the numeric date', async () => {
    // Midday UTC, so the day is 10 November in every zone from UTC-11 to UTC+11;
    // describeInstant prints in the browser's own zone, as every class date does.
    const AT = '2026-11-10T12:00:00.000Z';
    const DAY_AND_TIME = '1[01] November at \\d{2}:\\d{2}';
    serve(
      held({
        active: assignment({ id: 'assign-new', createdAt: AT }),
        history: [
          assignment({ id: 'assign-new', createdAt: AT }),
          assignment({ id: 'assign-old', active: false, assignedByName: null, createdAt: AT }),
        ],
      }),
      [version(), mine],
    );
    await render();
    const text = (id: string) => (q(id).textContent ?? '').replace(/\s+/g, ' ').trim();
    const since = [...q('class-project-active').querySelectorAll('p')].map((p) => p.textContent ?? '');
    expect(since[0]).toMatch(new RegExp(`^In force since ${DAY_AND_TIME}, set by Teacher A\\.$`));
    const rows = [...q('class-project-history').querySelectorAll('small')].map((s) =>
      (s.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    expect(rows[0]).toMatch(new RegExp(`^In force, set by Teacher A, on ${DAY_AND_TIME}$`));
    expect(rows[1]).toMatch(
      new RegExp(`^Replaced, set by an account that has since been removed, on ${DAY_AND_TIME}$`),
    );
    expect(text('class-project-active')).not.toMatch(/\d\/\d/);
    expect(text('class-project-history')).not.toMatch(/\d\/\d/);
  });

  it('lists what the class has been on, newest first, with the one in force marked', async () => {
    serve(
      held({
        active: assignment({ id: 'assign-new', projectTitle: 'Delivery Lab', version: '0.2.0', createdAt: '2026-09-18T09:00:00Z' }),
        history: [
          assignment({ id: 'assign-new', projectTitle: 'Delivery Lab', version: '0.2.0', createdAt: '2026-09-18T09:00:00Z' }),
          assignment({ id: 'assign-old', active: false }),
        ],
      }),
      [version(), mine],
    );
    await render();
    const rows = [...q('class-project-history').querySelectorAll('li')];
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'class-project-history-assign-new',
      'class-project-history-assign-old',
    ]);
    expect(rows[0].textContent).toContain('In force');
    expect(rows[1].textContent).toContain('Replaced');
  });

  it('says what a class with no assignment is actually giving its learners', async () => {
    serve(held({ active: null, history: [] }), [version({ current: false }), mine]);
    await render();
    expect(q('class-project-none').textContent).toContain('default project');
    expect(host.querySelector('[data-testid="class-project-active"]')).toBeNull();
    expect(host.querySelector('[data-testid="class-project-history"]')).toBeNull();
  });

  it('shows a read failure as a failure rather than as an empty class', async () => {
    calls.request.mockImplementation(() => Promise.reject(new Error('Offline')));
    await render();
    expect(q('class-project-error')).not.toBeNull();
    expect(host.querySelector('[data-testid="class-project-none"]')).toBeNull();
    expect(host.querySelector('[data-testid="class-project-pick"]')).toBeNull();
  });
});
