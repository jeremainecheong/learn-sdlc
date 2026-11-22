import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { dismissPhaseTutorial, signInAs, stripDoor, waitForEditor } from './pw-fixtures';
import { openConsole } from './preview-helpers';
import { reachImplementationByApi } from './passing-work';
import { testEmail } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * A learner's revisions read as a log.
 *
 * Every submission is a revision of one pull request, and the log says more
 * than what each one scored. The commit message is the line the learner
 * writes about their own revision, one sentence, the shape of a commit
 * subject, and it is never a gate: a revision submitted with the field empty
 * is recorded as one, and reads "No message".
 */

const LEARNER = {
  name: 'Cass Commit',
  email: testEmail(`e2e-commit-${Date.now()}`),
  password: 'Correct-Horse-9',
};

const FIRST = 'Add the completed-task case so the report stops listing finished work';
const SECOND = 'Fix the overdue boundary so due today is not overdue';

/* --------------------------- getting to phase 3 --------------------------- */

/**
 * The two phases before Implementation, walked through the API.
 *
 * The click path through Requirements and Design is `journey.spec.ts`'s job and
 * takes minutes; what is under test here starts at the third pull request, so
 * the learner arrives there the cheap way and every assertion below is made in
 * the browser.
 */
async function reachImplementation(request: APIRequestContext): Promise<string> {
  // Complete, marked written work, saved, submitted and assessed by the
  // suite's AI stub, then reflected on and advanced (e2e/passing-work.ts).
  return (await reachImplementationByApi(request, LEARNER)).phaseId;
}

async function signIn(page: Page): Promise<void> {
  await dismissPhaseTutorial(page);
  await page.goto('/login');
  await signInAs(page, LEARNER.email, LEARNER.password);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
}

/** Submit from the IDE and wait for the verdict to land in the Review tab. */
async function submitAndWait(page: Page, attempt: number): Promise<void> {
  await page.getByTestId('header-submit').click();
  await expect(page.getByTestId('feedback-verdict')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('tab-commit')).toContainText(String(attempt), { timeout: UI_READY });
}

test('a learner\'s revisions read as a log', async ({ page, request }) => {
  test.setTimeout(600_000);
  const phaseId = await reachImplementation(request);

  await signIn(page);
  await page.goto(`/workspace/${phaseId}`);
  await waitForEditor(page, 60_000);

  /* ------------- a revision with nothing written about it ----------------- */
  // The IDE's bottom panel opens from the console bar under the editor.
  await openConsole(page);
  await page.getByTestId('tab-commit').click();
  const field = page.getByTestId('commit-input');
  await expect(field).toHaveValue('');
  // The field is empty and Submit is not blocked by it: that is the whole
  // promise, and it is the one an agent would "simplify" away.
  await page.getByTestId('header-submit').click();
  await expect(page.getByTestId('feedback-verdict')).toBeVisible({ timeout: 180_000 });

  /* --------------------- two revisions that say what changed -------------- */
  await page.getByTestId('tab-commit').click();
  await field.fill(FIRST);
  await expect(page.getByTestId('commit-count')).toContainText(String(140 - FIRST.length));
  await submitAndWait(page, 1);
  // Submitting shows the verdict, so the panel is on Review; the field is one
  // tab back, and it is empty because the words are on the revision now.
  await page.getByTestId('tab-commit').click();
  await expect(page.getByTestId('commit-input')).toHaveValue('');

  await page.getByTestId('commit-input').fill(SECOND);
  await submitAndWait(page, 2);
  await page.getByTestId('tab-commit').click();
  await expect(page.getByTestId('commit-input')).toHaveValue('');

  /* ------------------------------ the log --------------------------------- */
  await (await stripDoor(page, 'open-document')).click();
  await expect(page).toHaveURL(/\/pr$/, { timeout: UI_READY });
  await page.getByTestId('pr-tab-history').click();
  const history = page.getByTestId('pr-history');
  await expect(history).toBeVisible();
  await expect(history).toContainText(FIRST);
  await expect(history).toContainText(SECOND);
  // The revision nobody wrote a line about says so, rather than showing a gap.
  await expect(history).toContainText('No message');
  await expect(page.getByTestId('pr-history-row-1')).toBeVisible();
  await expect(page.getByTestId('pr-history-row-3')).toBeVisible();
  // Newest first, so the last thing said is the first thing read.
  const rows = await history.locator('[data-testid^="pr-history-row-"]').allInnerTexts();
  expect(rows.length).toBe(3);

  // The same words beside the merge, for a learner who never opens the log:
  // the Submissions card left the PR page in a1e6a1eb, and the merge card's
  // commit field says "Last time: …" under "Submission status and phase advancement".
  const reviewState = page.locator('details.phase-pr-review-state').first();
  if ((await reviewState.getAttribute('open')) === null) await reviewState.locator('> summary').click();
  await expect(page.getByTestId('commit-last')).toContainText(SECOND);

  /* -------------- one draft, wherever the learner is typing --------------- */
  const draft = 'Rename the helper so the boundary rule is readable';
  await page.getByTestId('commit-input').fill(draft);
  await page.getByTestId('pr-open-workspace').click();
  await waitForEditor(page, 60_000);
  await page.getByTestId('tab-commit').click();
  await expect(page.getByTestId('commit-input')).toHaveValue(draft);
});
