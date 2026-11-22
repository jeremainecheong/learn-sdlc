// @vitest-environment jsdom
/**
 * The class-scoped teacher read (`GET /instructor/learners`): the portal's
 * class read, through the real
 * `instructorApi.learnersIn` and the real `request`, answered by what the API
 * answered in `apps/api/test/enrollment-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-bodies/enrollment.json`).
 *
 * The portal takes the class's learners from the overview (one row per
 * enrolment, `cohort` the class id) and reads their details a class page at a
 * time. On the recorded class of three: one request, `cohort=` the class and
 * `limit=50`, every learner found, in the order asked; the whole scope (the
 * home) is one request without `cohort`.
 */
import { repoFile } from './support/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstructorLearnerDetail, InstructorOverview } from '@learnsdlc/shared';

vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  getToken: () => 'wiring-token',
}));

import { CLASS_LEARNERS_PAGE, instructorApi } from '@/lib/api-instructor';

const bodies = JSON.parse(
  repoFile('apps/api/test/fixtures/contract-bodies/enrollment.json'),
).bodies as {
  overview: InstructorOverview;
  classLearners: InstructorLearnerDetail[];
  scopeLearners: InstructorLearnerDetail[];
  classId: string;
};

const asked: URL[] = [];
beforeEach(() => {
  asked.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://wiring.test');
      asked.push(url);
      const cohort = url.searchParams.get('cohort');
      const body = cohort === null ? bodies.scopeLearners : cohort === bodies.classId ? bodies.classLearners : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('the class read, from the API recording (WIRE)', () => {
  it("reads the recorded class in one page and finds every learner the overview puts in it", async () => {
    const ids = [...new Set(bodies.overview.learners.filter((one) => one.cohort === bodies.classId).map((one) => one.userId))];
    expect(ids).toHaveLength(3);
    const found = await instructorApi.learnersIn(ids, bodies.classId);
    expect(found.map((one) => one.userId)).toEqual(ids);
    expect(asked).toHaveLength(1);
    expect(decodeURIComponent(asked[0].pathname)).toMatch(/\/api\/v1\/instructor\/learners$/);
    expect(asked[0].searchParams.get('cohort')).toBe(bodies.classId);
    expect(asked[0].searchParams.get('limit')).toBe(String(CLASS_LEARNERS_PAGE));
    for (const one of found) expect(one.cohort).toBe(bodies.classId);
  });

  it('reads the whole scope without a cohort, and leaves out a learner it does not hold', async () => {
    const everyone = [...new Set(bodies.overview.learners.map((one) => one.userId))];
    const found = await instructorApi.learnersIn([...everyone, 'not-in-scope'], undefined);
    expect(found.map((one) => one.userId)).toEqual(everyone);
    expect(asked).toHaveLength(1);
    expect(asked[0].searchParams.has('cohort')).toBe(false);
  });
});
