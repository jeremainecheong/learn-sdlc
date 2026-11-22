import { expect, Page, test } from '@playwright/test';
import { dismissPhaseTutorial, registerAndSignIn, signInAs } from './pw-fixtures';
import { PollTimeoutError, PollUnreachableError, pollUntil } from '../apps/web/lib/poll';
import { testEmail } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * What the web does when the API is not there.
 *
 * Every failure in this file is one an instructor's laptop produces on an
 * ordinary Tuesday: the API restarts mid-class, the lab wifi drops for a
 * minute, a stored profile goes missing, one route answers with a body the
 * page did not expect. None of them is the learner's fault and none of them
 * means their work is gone, and none of them may end the lesson, with
 * "Choose your project" in front of an enrolled learner, "Failed to fetch" in
 * red, a submission reported as failed while it ran, a sidebar of one entry,
 * live updates that never come back, or a blank shell.
 *
 * `e2e/recovery.spec.ts` is the password-recovery journey and is a different
 * thing entirely; this one is the web recovering.
 */

// Fixed rather than stamped with Date.now(): Playwright starts a fresh worker
// after a failing test, which re-evaluates this module, and a stamped address
// would leave every test after the first one signing in as somebody who was
// never registered. The e2e API wipes its database on every boot.
const LEARNER_EMAIL = testEmail('e2e-web-recovery');
// Not 'Password1!': that is on the common-password list registration refuses.
const LEARNER_PASSWORD = 'Correct-Horse-9';
const LEARNER_NAME = 'Robin Recover';

// In order, one worker, not serial: the learner is a fixed address that
// every case signs in as, so a red case must not skip the rest.
test.describe.configure({ mode: 'default' });

/* --------------------------------- helpers -------------------------------- */


async function register(page: Page): Promise<void> {
  // Register, sign in, finish setup. A rerun against a database that was not
  // wiped finds the account, which is the same learner and no reason to stop.
  const made = await registerAndSignIn(page, { name: LEARNER_NAME, email: LEARNER_EMAIL, password: LEARNER_PASSWORD })
    .then(() => true)
    .catch(() => false);
  if (!made) await signIn(page);
  await ensureEnrolled(page);
}

/**
 * Every test below is about a learner who has a project, the whole point of
 * "an API blip must not offer to start one", so Home is taken past the
 * first-run screen once.
 */
async function ensureEnrolled(page: Page): Promise<void> {
  // Setup starts the project; the dashboard names it.
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await signInAs(page, LEARNER_EMAIL, LEARNER_PASSWORD);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
}

/** Poll a condition in this process, the way an assertion would in the page. */
async function until(what: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (what()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/* --------------------- a project that could not be loaded ------------------ */

test('an enrolled learner is never offered the start panel when the API 503s', async ({
  page,
}) => {
  await dismissPhaseTutorial(page);
  await register(page);

  // The one route that says whether this learner has a project.
  await page.route('**/api/v1/enrollments/mine*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Service Unavailable' }),
    }),
  );

  await page.goto('/dashboard');

  // What the learner sees: a notice that says the project could not be loaded,
  // and a way to ask again.
  // (Home draws it as an alert with its own "Retry project".)
  const notice = page.getByRole('alert').filter({ hasText: 'Your project could not be loaded' });
  await expect(notice).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry project' })).toBeVisible();

  // What they must never see: the first-run screen. Pressing Start on it hits
  // `already enrolled in this project` and teaches them the app is broken.
  await expect(page.getByRole('button', { name: 'Start Requirements' })).toHaveCount(0);
  await expect(page.getByText('Your next chapter starts here.')).toHaveCount(0);
});

test('a dead connection reads as English on Home, and Try again brings the page back', async ({
  page,
}) => {
  await dismissPhaseTutorial(page);
  await signIn(page);

  await page.route('**/api/v1/**', (route) => route.abort());
  await page.goto('/dashboard');

  // On a load with no server the session gate answers first
  // (SessionGate.tsx), with the sentence and its own Try again.
  const notice = page.getByRole('alert').filter({ hasText: "Can't reach the server" });
  await expect(notice).toBeVisible();
  // The sentence a learner can act on, not the fetch's own words.
  await expect(page.getByRole('main')).not.toContainText('Failed to fetch');

  // The retry is wired to the check, not to a page reload.
  await page.unroute('**/api/v1/**');
  await page.getByTestId('session-retry').click();

  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('session-retry')).toHaveCount(0);

  // And the frame carries the one signal that names what the learner can
  // actually fix: `navigator.onLine`.
  await page.context().setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await expect(page.getByTestId('offline-banner')).toContainText('You are offline');
  await page.context().setOffline(false);
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
});

/* ------------------------- a poll outlives a restart ----------------------- */

test('a poll survives thirty seconds of a dead API and still resolves', async () => {
  // A clock the sleeps move, so a minute of polling costs no wall time.
  let clock = 0;
  const now = () => clock;
  const sleep = async (ms: number) => {
    clock += ms;
  };

  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    // The API is restarting for the first thirty seconds, then it is back and
    // the job it accepted before the restart has finished.
    if (clock < 30_000) throw new TypeError('Failed to fetch');
    return { status: 'completed' as const };
  };

  const finished = await pollUntil(fetcher, (v) => v.status === 'completed', { now, sleep });
  expect(finished.status).toBe('completed');
  // More than three consecutive failures at 1.2 s (4.8 seconds) are tolerated.
  expect(calls).toBeGreaterThan(4);

  // And when it never comes back, what is thrown still says "still running",
  // because the job on the queue is unaffected by this browser losing sight
  // of it. Every caller branches on PollTimeoutError, so the neutral notice is
  // what a learner reads rather than a red failure.
  clock = 0;
  let thrown: unknown;
  try {
    await pollUntil(
      async () => {
        throw new TypeError('Failed to fetch');
      },
      () => true,
      { now, sleep },
    );
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(PollUnreachableError);
  expect(thrown).toBeInstanceOf(PollTimeoutError);
});

/* ------------------------------ a lost profile ----------------------------- */

test('a lost profile with a live token comes back on the next load', async ({ page }) => {
  await dismissPhaseTutorial(page);
  await signIn(page);
  await expect(page.getByTestId('nav-progress')).toBeVisible();

  // What a storage clear, a browser that keeps nothing, or a value that will
  // not parse leaves behind: the token still works, the profile is gone.
  await page.evaluate(() => window.localStorage.removeItem('lsdlc_user'));
  await page.reload();

  // The sidebar is gated on the role, so without a profile it would be Home
  // and nothing else, for ever, with no explanation.
  // (The learner's entries are Progress, Learn and Feedback.)
  await expect(page.getByTestId('nav-progress')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('nav-learn')).toBeVisible();
  await expect(page.getByTestId('nav-feedback')).toBeVisible();
  await expect(page.getByTestId('nav-user')).toHaveText(LEARNER_NAME);
});

/* ------------------------ the socket comes back ---------------------------- */

test('the socket comes back after the server has been away for a minute', async () => {
  test.setTimeout(180_000);

  const { createServer } = await import('http');
  const { Server } = await import('socket.io');

  const start = async (port: number) => {
    const http = createServer();
    const io = new Server(http, { cors: { origin: '*' } });
    await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', resolve));
    return { http, io, port: (http.address() as { port: number }).port };
  };
  const stop = async (s: { io: InstanceType<typeof Server> }) => {
    await new Promise<void>((resolve) => s.io.close(() => resolve()));
  };

  // socket.ts is browser code: the least it needs is a window with storage to
  // read the token out of. `document` is deliberately left undefined, so the
  // visibility nudge is skipped and only the `online` one is under test.
  const store = new Map<string, string>([['lsdlc_token', 'test-token']]);
  const win: any = new EventTarget();
  win.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  const hadWindow = 'window' in globalThis;
  (globalThis as any).window = win;

  let first: Awaited<ReturnType<typeof start>> | null = null;
  let second: Awaited<ReturnType<typeof start>> | null = null;
  try {
    first = await start(0);
    const port = first.port;
    process.env.NEXT_PUBLIC_API_URL = `http://127.0.0.1:${port}`;
    // `require`, not `import`: the module reads NEXT_PUBLIC_API_URL once, at
    // load, and the port is only known a line above this one.
    const { getSocket, closeSocket, getSocketState } =
      require('../apps/web/lib/socket') as typeof import('../apps/web/lib/socket');

    // The instance the workspace holds: `getSocket()` is called once, from an
    // effect keyed on the phase, and nothing calls it again for the life of
    // the tab. So whatever happens next has to happen to *this* object.
    const socket = getSocket();
    expect(socket).not.toBeNull();
    const seen: unknown[] = [];
    socket!.on('job.update', (event: unknown) => seen.push(event));

    await until(() => socket!.connected, 20_000, 'the first connection');
    expect(getSocketState()).toBe('live');

    // The API restarts, and takes its time about it, sixty seconds, well past
    // what a five-attempt budget (about seventeen seconds) would survive.
    await stop(first);
    first = null;
    await until(() => !socket!.connected, 20_000, 'the socket to notice the server had gone');
    expect(getSocketState()).toBe('paused');
    await new Promise((r) => setTimeout(r, 60_000));

    second = await start(port);
    // The browser saying it is back is worth an immediate attempt rather than
    // the rest of the backoff.
    win.dispatchEvent(new Event('online'));

    await until(() => socket!.connected, 45_000, 'the socket to come back');
    expect(getSocketState()).toBe('live');

    // A completion emitted after the restart reaches the panel that was
    // listening before it.
    second.io.emit('job.update', { type: 'submission', id: 'after-restart', status: 'completed' });
    await until(() => seen.length > 0, 15_000, 'the event after the restart');
    expect(seen[0]).toMatchObject({ id: 'after-restart', status: 'completed' });

    closeSocket();
  } finally {
    if (first) await stop(first);
    if (second) await stop(second);
    if (!hadWindow) delete (globalThis as any).window;
    delete process.env.NEXT_PUBLIC_API_URL;
  }
});

/* ---------------------- a pane that cannot draw its body ------------------- */

test('a pane fed a body it cannot draw costs the pane, not the shell', async ({ page }) => {
  await dismissPhaseTutorial(page);
  await signIn(page);

  // A body that satisfies the loader and the page's own reads, and that the
  // chart cannot draw: `phases` is where every chart starts.
  await page.route('**/api/v1/analytics/me*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        projectSlug: 'tasktrackr',
        progressPercent: 33,
        phasesPassed: 2,
        totalPhases: 6,
        averageScore: 81,
        totalHints: 1,
        tokensToday: 120,
        difficultyTier: 'standard',
        relianceIndex: 0,
        phases: null,
      }),
    }),
  );

  await page.goto('/dashboard');

  // The chart that could not draw this body is gone from Home; its numbers
  // pane reads only what it can, so the pane draws rather than failing.
  await expect(page.getByRole('heading', { name: 'Your numbers' })).toBeVisible({ timeout: UI_READY });

  // And the shell is untouched: the nav is what disappears if the nearest
  // error boundary above the page is a full-height page of its own that
  // replaces the whole frame.
  await expect(page.getByTestId('nav')).toBeVisible();
  await expect(page.getByTestId('nav-progress')).toBeVisible();
  await expect(page.getByTestId('dashboard-project')).toBeVisible();
});
