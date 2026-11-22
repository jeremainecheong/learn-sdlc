import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstructorLearnerDetail } from '@learnsdlc/shared';

/**
 * The class-scoped learner read, the client half.
 * `GET /instructor/learners?cohort&after&limit` (instructor.controller.ts)
 * answers a page of at most 50 learner details in id order; the next page
 * starts after the last id. `learnersIn(ids, cohort)` is what the teacher
 * portal asks instead of one `GET /instructor/learners/:id` per learner.
 */

const rig = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  request: rig.request,
}));

import { CLASS_LEARNERS_MAX_PAGES, CLASS_LEARNERS_PAGE, instructorApi } from '@/lib/api-instructor';

const detail = (userId: string, cohort = 'class-one') =>
  ({ userId, displayName: userId, email: `${userId}@example.test`, cohort, enrollments: [] }) as unknown as InstructorLearnerDetail;
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A server holding these learners, answering the class read by its contract. */
const serve = (all: InstructorLearnerDetail[]) =>
  rig.request.mockImplementation(async (method: string, path: string) => {
    const url = new URL(path, 'http://api.test');
    if (method !== 'GET' || url.pathname !== '/instructor/learners') throw new Error(`unexpected ${method} ${path}`);
    const cohort = url.searchParams.get('cohort');
    const after = url.searchParams.get('after');
    const limit = Number(url.searchParams.get('limit') ?? CLASS_LEARNERS_PAGE);
    return [...all]
      .filter((one) => !cohort || one.cohort === cohort)
      .sort((a, b) => a.userId.localeCompare(b.userId))
      .filter((one) => !after || one.userId > after)
      .slice(0, limit);
  });

beforeEach(() => {
  rig.request.mockReset();
});

describe('the class read', () => {
  it('is the page size the API caps at', () => {
    expect(CLASS_LEARNERS_PAGE).toBe(50);
  });

  it('reads a class of 30 in one request, and never one per learner', async () => {
    const all = Array.from({ length: 30 }, (_, n) => detail(idOf(n + 1)));
    serve(all);
    const ids = all.map((one) => one.userId).reverse();
    const got = await instructorApi.learnersIn(ids, 'class-one');
    expect(rig.request).toHaveBeenCalledTimes(1);
    expect(rig.request.mock.calls[0]).toEqual(['GET', '/instructor/learners?cohort=class-one&limit=50']);
    // In the order the portal asked for them.
    expect(got.map((one) => one.userId)).toEqual(ids);
  });

  it('walks a class larger than a page by the last id, a page a request', async () => {
    const all = Array.from({ length: 120 }, (_, n) => detail(idOf(n + 1)));
    serve(all);
    const got = await instructorApi.learnersIn(all.map((one) => one.userId), 'class-one');
    expect(got).toHaveLength(120);
    expect(rig.request.mock.calls.map((call) => call[1])).toEqual([
      '/instructor/learners?cohort=class-one&limit=50',
      `/instructor/learners?cohort=class-one&after=${idOf(50)}&limit=50`,
      `/instructor/learners?cohort=class-one&after=${idOf(100)}&limit=50`,
    ]);
  });

  it('reads the whole scope on the home, and keeps only the learners asked for', async () => {
    serve([detail(idOf(1), 'class-one'), detail(idOf(2), 'class-two'), detail(idOf(3), 'class-two')]);
    const got = await instructorApi.learnersIn([idOf(3), idOf(1)]);
    expect(rig.request.mock.calls.map((call) => call[1])).toEqual(['/instructor/learners?limit=50']);
    expect(got.map((one) => one.userId)).toEqual([idOf(3), idOf(1)]);
  });

  it('asks nothing when there is no learner to read', async () => {
    expect(await instructorApi.learnersIn([], 'class-one')).toEqual([]);
    expect(rig.request).not.toHaveBeenCalled();
  });

  it('stops once every learner asked for is read', async () => {
    const all = Array.from({ length: 120 }, (_, n) => detail(idOf(n + 1)));
    serve(all);
    await instructorApi.learnersIn([idOf(3), idOf(7)], 'class-one');
    expect(rig.request).toHaveBeenCalledTimes(1);
  });

  it('stops when a full page does not move past the last id, rather than asking the same page again', async () => {
    const same = Array.from({ length: CLASS_LEARNERS_PAGE }, (_, n) => detail(idOf(n + 1)));
    // A server that ignores `after` answers the first page every time.
    rig.request.mockImplementation(async () => same);
    const got = await instructorApi.learnersIn([idOf(1), idOf(999)], 'class-one');
    expect(rig.request.mock.calls.length).toBeLessThanOrEqual(2);
    expect(got.map((one) => one.userId)).toEqual([idOf(1)]);
  });

  it('never walks more pages than its cap, however large the scope', async () => {
    let served = 0;
    rig.request.mockImplementation(async () => {
      const page = Array.from({ length: CLASS_LEARNERS_PAGE }, (_, n) => detail(idOf(served * CLASS_LEARNERS_PAGE + n + 1)));
      served += 1;
      return page;
    });
    await instructorApi.learnersIn([idOf(10_000_000)], 'class-one');
    expect(rig.request.mock.calls.length).toBeLessThanOrEqual(CLASS_LEARNERS_MAX_PAGES);
  });

  it('stops between pages once the caller no longer wants the answer', async () => {
    const all = Array.from({ length: 120 }, (_, n) => detail(idOf(n + 1)));
    serve(all);
    let wanted = true;
    rig.request.mockImplementationOnce(async () => {
      wanted = false;
      return Array.from({ length: CLASS_LEARNERS_PAGE }, (_, n) => all[n]);
    });
    await instructorApi.learnersIn(all.map((one) => one.userId), 'class-one', () => wanted);
    expect(rig.request).toHaveBeenCalledTimes(1);
  });
});
