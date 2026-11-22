// @vitest-environment jsdom
/**
 * "Version to assign" lists the teacher's own
 * versions first, the most recently published first, so the version published
 * a minute ago is at or near the top of a list of 146. The versions that are
 * not the teacher's follow in the API's order. The placeholder stays first,
 * and each option's text and value, and what Assign this version sends, do
 * not change with the order.
 *
 * A script that picks a version reads the options' texts and takes the last
 * option that starts with the project's title: it must end "(yours)" and name
 * the six phases.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssignableVersionView, CohortProjectView, PhaseKey } from '@learnsdlc/shared';
import { ClassProjectCard, assignableOrder } from '@/components/staff/ClassProjectCard';

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
const SIX_KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const SIX = 'Requirements, Design, Implementation, Testing, Deployment and Maintenance';

const row = (over: Partial<AssignableVersionView>): AssignableVersionView => ({
  projectId: `project-${over.versionId}`,
  projectSlug: `slug-${over.versionId}`,
  projectTitle: 'Untitled',
  platformOwned: false,
  mine: true,
  versionId: 'version',
  version: '1.0.0',
  publishedAt: null,
  current: false,
  ...over,
});

// The API's order: the default project, the rest of the platform's, then
// every own project by title (cohort-project.service.ts, assignableProjects).
const platform = row({ versionId: 'v-platform', projectTitle: 'TaskTrackr', platformOwned: true, mine: false, current: true, phases: SIX_KEYS });
const platformOther = row({ versionId: 'v-platform-2', projectTitle: 'RoomDesk', platformOwned: true, mine: false });
const ownOld = row({ versionId: 'v-own-old', projectTitle: 'Alpha', publishedAt: '2026-11-01T08:00:00.000Z' });
const ownNew = row({ versionId: 'v-own-new', projectTitle: 'Beta', publishedAt: '2026-11-18T04:07:31.000Z', phases: SIX_KEYS });
const ownUndated = row({ versionId: 'v-own-undated', projectTitle: 'Gamma', publishedAt: null });
const ownTwin = row({ versionId: 'v-own-twin', projectTitle: 'Zeta', publishedAt: '2026-11-01T08:00:00.000Z' });
const shared = row({ versionId: 'v-shared', projectTitle: 'Omega', mine: false, publishedAt: '2026-11-18T09:00:00.000Z' });
const API_ORDER = [platform, platformOther, ownOld, ownNew, ownUndated, ownTwin, shared];

let host: HTMLDivElement;
let root: Root;
const q = <T extends HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`)!;
const serve = (versions: AssignableVersionView[]) => {
  const view: CohortProjectView = { cohortId: 'class-one', active: null, history: [] };
  calls.request.mockImplementation((method: string, path: string) => {
    if (method === 'GET' && path === READ) return Promise.resolve(view);
    if (method === 'GET' && path === ASSIGNABLE) return Promise.resolve(versions);
    if (method === 'PUT' && path === READ) return Promise.resolve(view);
    return Promise.reject(new Error(`no route for ${method} ${path}`));
  });
};
const render = async () => {
  await act(async () => root.render(<ClassProjectCard cohortId="class-one" />));
};
const options = () => [...q<HTMLSelectElement>('class-project-pick').options];

beforeEach(() => {
  calls.request.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('assignableOrder', () => {
  it("puts the teacher's own versions first, newest published first, then the rest in the API's order", () => {
    expect(assignableOrder(API_ORDER).map((one) => one.versionId)).toEqual([
      'v-own-new',
      // Two own versions published at the same instant keep the API's order.
      'v-own-old',
      'v-own-twin',
      // An own version with no date follows the dated ones.
      'v-own-undated',
      // Not the teacher's: as the API gave them, whatever their dates.
      'v-platform',
      'v-platform-2',
      'v-shared',
    ]);
  });

  it('leaves a list with no own version exactly as the API gave it, and never changes the rows', () => {
    const notMine = [platform, platformOther, shared];
    expect(assignableOrder(notMine)).toEqual(notMine);
    const copy = structuredClone(API_ORDER);
    assignableOrder(copy);
    expect(copy).toEqual(API_ORDER);
    expect(assignableOrder([])).toEqual([]);
  });

  it('reads a date it cannot parse as no date', () => {
    const bad = row({ versionId: 'v-bad', publishedAt: 'not a date' });
    expect(assignableOrder([bad, ownOld]).map((one) => one.versionId)).toEqual(['v-own-old', 'v-bad']);
  });
});

describe('Version to assign', () => {
  it('keeps the placeholder first and every option its own text and value, in the new order', async () => {
    serve(API_ORDER);
    await render();
    const drawn = options().map((one) => [one.value, one.textContent, one.disabled]);
    expect(drawn).toEqual([
      ['', 'Choose a published version', false],
      ['v-own-new', `Beta 1.0.0: ${SIX} (yours)`, false],
      ['v-own-old', 'Alpha 1.0.0, yours', false],
      ['v-own-twin', 'Zeta 1.0.0, yours', false],
      ['v-own-undated', 'Gamma 1.0.0, yours', false],
      ['v-platform', `TaskTrackr 1.0.0: ${SIX} (assigned now)`, true],
      ['v-platform-2', 'RoomDesk 1.0.0, the platform project', false],
      ['v-shared', 'Omega 1.0.0, shared with you', false],
    ]);
    // Nothing chosen until the teacher chooses.
    expect(q<HTMLSelectElement>('class-project-pick').value).toBe('');
    expect(q<HTMLButtonElement>('class-project-assign').disabled).toBe(true);
  });

  it('sends the version picked, by its id', async () => {
    serve(API_ORDER);
    await render();
    await act(async () => {
      fireEvent.change(q<HTMLSelectElement>('class-project-pick'), { target: { value: 'v-own-new' } });
    });
    await act(async () => {
      fireEvent.change(q<HTMLTextAreaElement>('class-project-reason'), {
        target: { value: 'This class works the version published today.' },
      });
    });
    await act(async () => fireEvent.submit(host.querySelector('form')!));
    expect(calls.request).toHaveBeenCalledWith('PUT', READ, {
      projectVersionId: 'v-own-new',
      reason: 'This class works the version published today.',
    });
    expect(q('class-project-status').textContent).toBe(
      'Assigned. Beta 1.0.0 is what a learner who joins this class from now on is given.',
    );
  });

  it("puts this run's version at the top of a 146-version list where the API put it about 115th", async () => {
    const title = 'Deadline badge demo 20261118 h';
    const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}T03:00:00.000Z`;
    const lookalikes = [1, 2, 3, 4].map((n) =>
      row({ versionId: `v-take-${n}`, projectTitle: 'Deadline badge demo 20261118', publishedAt: `2026-11-18T0${n}:00:00.000Z`, phases: SIX_KEYS }),
    );
    const others = Array.from({ length: 140 }, (_, n) =>
      row({ versionId: `v-other-${n}`, projectTitle: `Older run ${String(n).padStart(3, '0')}`, publishedAt: day(1 + (n % 17)), phases: SIX_KEYS }),
    );
    const thisRun = row({ versionId: 'v-this-run', projectTitle: title, publishedAt: '2026-11-18T04:07:31.000Z', phases: SIX_KEYS });
    // The API's order: platform first, then own by title, this run's after the four look-alikes.
    const apiOrder = [platform, ...others.slice(0, 109), ...lookalikes, thisRun, ...others.slice(109)];
    expect(apiOrder).toHaveLength(146);
    expect(apiOrder.indexOf(thisRun)).toBe(114);
    serve(apiOrder);
    await render();
    const texts = options().map((one) => one.textContent!.replace(/\s+/g, ' ').trim());
    expect(texts[0]).toBe('Choose a published version');
    expect(texts[1]).toBe(`${title} 1.0.0: ${SIX} (yours)`);
    expect(texts).toHaveLength(147);
    // A script's read: the last option starting
    // with the title ends "(yours)" and names the six phases.
    const matching = texts.filter((one) => one.startsWith(`${title} `));
    expect(matching).toHaveLength(1);
    expect(matching.at(-1)!.endsWith('(yours)')).toBe(true);
    expect(matching.at(-1)!.includes(SIX)).toBe(true);
    // Every option the API sent is offered once, with the same text it had.
    expect(new Set(options().slice(1).map((one) => one.value))).toEqual(new Set(apiOrder.map((one) => one.versionId)));
  });
});
