import { expect, test } from '@playwright/test';
import {
  dismissPhaseTutorial,
  joinClassInUi,
  openRequirements,
  registerAndSignIn,
  requirementsTab,
  signInAs,
  signInTo,
  signOutFromMenu,
} from './pw-fixtures';
import { INSTRUCTOR, classByApi } from './passing-work';
import { testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * An instructor regrades a phase after a content fix, and the learner's record
 * gains a revision.
 *
 * The learner submits the untouched scaffold and misses the gate. The
 * instructor then re-runs that revision against the pack as it is on disk, the
 * `everyone` scope rather than the stale-pack one, because editing a content
 * pack mid-suite would race every other spec in this directory, and the
 * verdict is written *beside* the old one as a second revision. The old row is
 * untouched, which is the whole point: an appeal reads the history, not a
 * number that was quietly replaced.
 *
 * The class-wide regrade is the "Dates and regrades" panel on
 * the class's page (/teacher/class), scoped to that class; the learner misses
 * the gate from the Requirements room's backlog, and reads both revisions on
 * the phase's review history. The class is made through the API and the
 * instructor signs in straight to its page (e2e/passing-work.ts, classByApi,
 * says why the teacher home is avoided).
 */

const LEARNER = {
  name: 'Rafi Regrade',
  email: testEmail(`e2e-regrade-${Date.now()}`),
  password: 'Correct-Horse-9',
};
const CLASS_NAME = `E2E regrade class ${Date.now()}`;
const REASON = 'The hidden boundary test was wrong; it is fixed in the pack on disk now.';

test('an instructor regrades a phase after a content fix and the learner keeps both verdicts', async ({
  page,
  request,
}) => {
  test.setTimeout(600_000);

  await dismissPhaseTutorial(page);

  /* ------------------------ a class, and a code for it --------------------- */
  const { cohortId: classId, joinCode } = await classByApi(request, CLASS_NAME);

  /* ------------------ a learner who has missed the gate once --------------- */
  await registerAndSignIn(page, LEARNER);
  await joinClassInUi(page, joinCode);
  await page.goto('/dashboard');
  const phaseId = await openRequirements(page);

  // The scaffold as it stands does not reach the gate. That failed verdict is
  // what the regrade re-runs.
  await requirementsTab(page, 'My backlog');
  await page.getByTestId('phase-requirements-submit').click();
  await expect(page.getByTestId('review-strip')).toContainText('Needs revision', { timeout: 180_000 });
  await signOutFromMenu(page);

  /* ----------------------------- the dry run ------------------------------ */
  // The regrade is under the class page's Dates and regrades tab.
  await signInTo(page, INSTRUCTOR.email, INSTRUCTOR.password, `/teacher/class?class=${classId}&tab=dates`);
  const panel = page.getByTestId('regrade-panel');
  await expect(panel).toBeVisible({ timeout: UI_READY });

  // Nothing chosen, nothing to press, and the sentence that says why.
  await expect(page.getByTestId('regrade-start')).toBeDisabled();
  await expect(panel).toContainText('Choose a phase and give a reason');

  await page.getByTestId('regrade-phase').selectOption('requirements');
  await page.getByTestId('regrade-scope').selectOption('everyone');
  await page.getByTestId('regrade-reason').fill('too short');
  await expect(page.getByTestId('regrade-start')).toBeDisabled();
  await page.getByTestId('regrade-reason').fill(REASON);
  await expect(page.getByTestId('regrade-start')).toBeEnabled();

  await page.getByTestId('regrade-preview').click();
  const list = page.getByTestId('regrade-preview-list');
  await expect(list).toBeVisible({ timeout: UI_READY });
  await expect(list).toContainText(LEARNER.name);
  await expect(list).toContainText('Revision 1');
  // A dry run writes nothing: the learner still has exactly one revision, which
  // the finish assertion below depends on.
  await expect(list).toContainText('would be regraded in Requirements');

  /* ------------------------------ and the act ----------------------------- */
  await page.getByTestId('regrade-start').click();
  const done = page.getByTestId('regrade-done');
  // The scope is the instructor's whole class list, so in a full-suite run the
  // batch can carry every learner an earlier spec left in one of their classes.
  await expect(done).toBeVisible({ timeout: 300_000 });
  await expect(done).toContainText('Regrade finished');
  // A failed verdict re-run against the same pack is still a failed verdict:
  // nobody crosses the gate, and nobody's pass is withdrawn.
  await expect(done).toContainText("Nobody's pass was withdrawn.");
  await signOutFromMenu(page);

  /* ------------------- the learner's revision list, both rows -------------- */
  await signInAs(page, LEARNER.email, LEARNER.password);
  await expect(page.getByTestId('dashboard-project')).toContainText('TaskTrackr', { timeout: UI_READY });
  // The phase's review history, on the feedback page (the pull request page
  // that listed revisions belongs to Implementation).
  await page.goto(`/feedback?phase=${phaseId}`);
  const history = page.locator('section.exp-panel', { has: page.getByRole('heading', { name: 'Review history' }) });
  await expect(history).toBeVisible({ timeout: NAVIGATION });
  await expect(history.getByRole('listitem').filter({ hasText: 'Review 1' })).toBeVisible();
  // The regrade is the second revision. The first is exactly where it was.
  await expect(history.getByRole('listitem').filter({ hasText: 'Review 2' })).toBeVisible({ timeout: NAVIGATION });
  await expect(history.getByRole('listitem')).toHaveCount(2);
});
