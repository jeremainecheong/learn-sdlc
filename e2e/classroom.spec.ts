import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { dismissPhaseTutorial, signInAs } from './pw-fixtures';
import { INSTRUCTOR, reachImplementationByApi, registerByApi } from './passing-work';
import { API, testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * Classroom mode: a room full of people on one laptop.
 *
 * The class presses Run together, and every one of them can see they are in
 * a line rather than broken.
 *
 * The queue case stubs `/queue/position` and `/runs/:id`. That is
 * deliberate: what is under test here is the line the learner reads and the
 * moment it goes away, and forcing a real queue would mean either serialising
 * the whole suite behind `JOB_CONCURRENCY=1` or firing a dozen sandbox jobs to
 * make a wait long enough to catch, a slow test whose timing decides whether
 * it passes. The route itself is covered against the real queue in
 * `apps/api/test/queue-position.e2e-spec.ts`, six cases including the 404 that
 * keeps one learner out of another learner's run.
 */


const LEARNER = {
  name: 'Lena Lab',
  email: testEmail(`e2e-lab-${Date.now()}`),
  password: 'Correct-Horse-9',
};

const CLASS_NAME = `E2E lab class ${Date.now()}`;

/**
 * Register, enrol, and walk the two written phases through the API so the
 * browser opens on Implementation, the first phase with a Run button, which is
 * the only place a learner ever meets the queue.
 */
async function reachImplementation(request: APIRequestContext): Promise<string> {
  // Complete, marked written work, saved, submitted and assessed by the
  // suite's AI stub, then reflected on and advanced (e2e/passing-work.ts).
  return (await reachImplementationByApi(request, LEARNER)).phaseId;
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await dismissPhaseTutorial(page);
  await page.goto('/login');
  await signInAs(page, email, password);
}

/**
 * Hold a run at `status`, and answer the queue with `position`. Both routes are
 * fulfilled from a box the test can change between assertions, so one page can
 * walk a run from queued to running without a reload.
 */
function holdTheQueue(page: Page) {
  const box = {
    status: 'queued' as 'queued' | 'running' | 'completed',
    ahead: 2 as number | null,
    estimateSeconds: 40 as number | null,
    asked: 0,
  };
  const run = () => ({
    id: 'run-under-test',
    status: box.status,
    kind: 'run',
    result: null,
    createdAt: new Date().toISOString(),
  });

  // The page is on one origin and the API on another, so a stubbed answer
  // needs the same CORS headers the real API sends or the browser throws it
  // away before the client ever sees it, including the preflight.
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  };
  const answer = (route: Route, body: unknown, status = 200) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: CORS })
      : route.fulfill({
          status,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

  return {
    box,
    install: async () => {
      await page.route('**/api/v1/phases/*/run', (route) => answer(route, run(), 201));
      await page.route('**/api/v1/runs/*', (route) => answer(route, run()));
      await page.route('**/api/v1/queue/position*', (route) => {
        if (route.request().method() !== 'OPTIONS') box.asked += 1;
        return answer(
          route,
          box.status === 'queued'
            ? { state: 'queued', ahead: box.ahead, estimateSeconds: box.estimateSeconds }
            : {
                state: box.status === 'running' ? 'running' : 'done',
                ahead: null,
                estimateSeconds: null,
              },
        );
      });
    },
  };
}

test.describe('a place in the line', () => {
  test('a queued run says where it is in the line, and the line goes when it starts', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const phaseId = await reachImplementation(request);
    const queue = holdTheQueue(page);
    await queue.install();

    await signIn(page, LEARNER.email, LEARNER.password);
    await page.waitForURL('**/dashboard', { timeout: NAVIGATION });
    await page.goto(`/workspace/${phaseId}`);
    await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: NAVIGATION });

    await page.getByTestId('header-run').click();

    // A queue is a fact, not a failure: the position and the range in words,
    // never a spinner and never a countdown.
    const line = page.getByTestId('queue-line');
    await expect(line).toBeVisible({ timeout: NAVIGATION });
    await expect(line).toContainText(/Queued, (next in line|\d+ ahead of you)/);
    await expect(line).toContainText('about 40 seconds');

    // It moves as the line moves, without a reload.
    queue.box.ahead = 0;
    queue.box.estimateSeconds = null;
    await expect(line).toHaveText('Queued, next in line', { timeout: UI_READY });

    // And the moment the job is running there is no line to draw, while the
    // sentence above it is the one it has always been.
    queue.box.status = 'running';
    await expect(line).toBeHidden({ timeout: UI_READY });
    await expect(page.getByTestId('run-pending')).toHaveText('Running in the sandbox…');

    // The poll stops with the queue: nothing keeps asking about a job that has
    // left it.
    const asked = queue.box.asked;
    await page.waitForTimeout(5_000);
    expect(queue.box.asked, 'the line stops asking once the job is running').toBe(asked);
  });
});

test.describe('the lab', () => {

  test('a join link fills the code in and never joins on its own', async ({ page, request }) => {
    test.setTimeout(180_000);

    // A class to be joined, made through the API so this test is about the
    // link rather than about the console.
    const auth = await request.post(`${API}/auth/login`, {
      data: { email: INSTRUCTOR.email, password: INSTRUCTOR.password },
    });
    expect(auth.ok(), 'the instructor signs in').toBeTruthy();
    const staffToken = (await auth.json()).token as string;
    const made = await request.post(`${API}/instructor/cohorts`, {
      headers: { authorization: `Bearer ${staffToken}` },
      data: { name: `${CLASS_NAME} link` },
    });
    expect(made.ok(), 'the class is created').toBeTruthy();
    const raw = (await made.json()).joinCode as string;
    const dashed = `${raw.slice(0, 4)}-${raw.slice(4)}`;

    // Its own learner, so the link is walked whether or not the queue case
    // above ran first in this worker.
    const joiner = { ...LEARNER, email: testEmail(`e2e-lab-join-${Date.now()}`) };
    await registerByApi(request, joiner);
    await signIn(page, joiner.email, joiner.password);
    await page.waitForURL('**/dashboard', { timeout: NAVIGATION });

    // Count the join requests: arriving on the link must make none of them.
    let joins = 0;
    await page.route('**/api/v1/enrollments/join', (route) => {
      joins += 1;
      return route.continue();
    });

    // The join page (the classroom page) names its field and button in words.
    await page.goto(`/join?code=${dashed}`);
    await expect(page.getByLabel('Class code')).toHaveValue(dashed, { timeout: UI_READY });
    expect(joins, 'a link that was sent to you does not move you between classes').toBe(0);

    await page.getByRole('button', { name: 'Join class', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'You have joined your class.' })).toBeVisible({ timeout: UI_READY });
    expect(joins, 'the learner joined by pressing the button').toBe(1);
  });
});
