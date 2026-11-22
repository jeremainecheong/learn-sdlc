import { expect, Page, test } from '@playwright/test';
import { dismissPhaseTutorial, registerAndSignIn, signInAs } from './pw-fixtures';
import { testEmail } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * Error paths, recovery, small screens and keyboard.
 *
 * What the cases have in common is the "no dead end" bar: a screen that
 * cannot load says what happened, offers the
 * one control that fixes it, keeps its heading, and picks the connection back
 * up on its own when the server returns.
 *
 * `e2e/web-recovery.spec.ts` covers Home and the shell's own recovery; this
 * covers the four rooms it never reached.
 */

const LEARNER_EMAIL = testEmail('e2e-error-recovery');
// Not 'Password1!': that is on the common-password list registration refuses.
const LEARNER_PASSWORD = 'Correct-Horse-9';
const LEARNER_NAME = 'Robin Recovers';

// Not `serial`: the file's own workers:1 already runs these in declaration
// order, and a red run is only evidence if every case gets to run rather
// than being skipped by the first failure.


async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await signInAs(page, LEARNER_EMAIL, LEARNER_PASSWORD);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
}

/** Registers on the first run, signs in on a rerun against a live database. */
async function register(page: Page): Promise<void> {
  // Register, sign in and finish setup (which starts the project); a rerun
  // against a live database finds the account and signs in instead.
  const made = await registerAndSignIn(page, { name: LEARNER_NAME, email: LEARNER_EMAIL, password: LEARNER_PASSWORD })
    .then(() => true)
    .catch(() => false);
  if (!made) await signIn(page);
}

async function startProject(page: Page): Promise<void> {
  // Setup starts the project; the dashboard names it.
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
}

/* -------------------------------------------------------------------------- */
/*  /complete                                                                 */
/* -------------------------------------------------------------------------- */

test('a learner who has never finished a project reads why, not a spinner', async ({ page }) => {
  await dismissPhaseTutorial(page);
  await register(page);

  // A missing enrolment and a failed fetch must not be the same value, or
  // this page says "Loading your record…" for ever to a learner who has
  // nothing to load. The record page has no test ids; it says why in a
  // sentence, with one heading and a way on.
  await page.goto('/complete');
  const main = page.getByRole('main');
  await expect(main).toContainText('The completion record becomes available after every phase has a Pass.', { timeout: UI_READY });
  await expect(main).not.toContainText('Loading your record');

  // Every screen has a heading and a route back.
  await expect(page.locator('main h1')).toHaveCount(1);
  await page.getByRole('link', { name: 'Back to my next step' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/complete'), { timeout: UI_READY });
  await page.goto('/dashboard');

  await startProject(page);
});

test('the completion record says the server is unreachable, and comes back by itself', async ({
  page,
}) => {
  await dismissPhaseTutorial(page);
  await signIn(page);

  await page.route('**/api/v1/**', (route) => route.abort());
  await page.goto('/complete');

  // The failure is named, in the product's voice, with a control.
  // On a load with no server the session gate answers first
  // (components/shell/SessionGate.tsx), with its own page and its own retry.
  const notice = page.getByRole('main');
  await expect(notice).toContainText("Can't reach the server", { timeout: UI_READY });
  await expect(notice).not.toContainText('Failed to fetch');
  await expect(page.getByTestId('session-retry')).toBeVisible();
  await expect(page.locator('main h1')).toHaveCount(1);

  // Nothing is pressed. The page picks the connection back up.
  await page.unroute('**/api/v1/**');
  await expect(page.getByRole('main')).toContainText('The completion record becomes available', { timeout: 45_000 });
  await expect(page.getByTestId('session-retry')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/*  /phases                                                                   */
/* -------------------------------------------------------------------------- */

test('an unreachable API is never drawn as a learner who has no project', async ({ page }) => {
  await dismissPhaseTutorial(page);
  await signIn(page);
  await startProject(page);

  // /phases is the progress record; on a load with no server the session
  // gate answers first, with its own page and its own retry.
  await page.route('**/api/v1/**', (route) => route.abort());
  await page.goto('/phases');

  const notice = page.getByRole('main');
  await expect(notice).toContainText("Can't reach the server", { timeout: UI_READY });
  // A failed fetch must not be answered with "No project started yet —
  // Start a project from Home" to a learner who has one.
  await expect(notice).not.toContainText('Your next chapter starts here.');
  // A heading and the control that fixes it.
  await expect(page.locator('main h1')).toHaveCount(1);
  await expect(page.getByTestId('session-retry')).toBeVisible();

  // Back on its own, with nothing pressed.
  await page.unroute('**/api/v1/**');
  await expect(page.getByRole('heading', { name: 'Your progress, in view.' })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('session-retry')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/*  A session that ended says so                                              */
/* -------------------------------------------------------------------------- */

test('the sign-in page names an ended session, and says nothing to a first visit', async ({
  page,
}) => {
  await page.goto('/login?next=%2Fdashboard&reason=expired');
  const line = page.getByTestId('session-ended');
  await expect(line).toBeVisible();
  await expect(line).toContainText('Your session ended');

  // A visitor who merely opened a signed-in address had nothing end.
  await page.goto('/login?next=%2Fdashboard');
  await expect(page.getByTestId('login-submit')).toBeVisible();
  await expect(page.getByTestId('session-ended')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/*  One h1 per room                                                           */
/* -------------------------------------------------------------------------- */

test('markdown a learner wrote never becomes a second top-level heading', async ({ page }) => {
  await dismissPhaseTutorial(page);
  await signIn(page);

  for (const path of ['/warmup', '/dossier']) {
    await page.goto(path);
    await expect(page.locator('h1')).toHaveCount(1, { timeout: UI_READY });
    // The heading ramp moves by tag and not by size: the pack's own `#` is
    // still a 19px line.
    const first = page.locator('.prose-docs [data-md="1"]').first();
    if ((await first.count()) > 0) {
      await expect(first).toHaveCSS('font-size', '19px');
    }
  }
});
