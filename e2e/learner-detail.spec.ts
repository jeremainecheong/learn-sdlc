import { expect, test } from '@playwright/test';
import {
  dismissPhaseTutorial,
  inspectLearnerPhase,
  joinClassInUi,
  registerAndSignIn,
  signInTo,
  signOutFromMenu,
} from './pw-fixtures';
import { INSTRUCTOR, classByApi } from './passing-work';
import { testEmail } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * The per-learner page behind a cohort-table row: an instructor opens a
 * learner, checks that daily token controls stay absent after a reload, passes a gate with
 * a recorded reason, and returns to the console.
 *
 * An instructor's console shows the classes they own; `default` is where an
 * account sits before it joins one, and is an admin's view rather than an
 * instructor's. So this test mints a class first and has the learner
 * redeem the code, which is the only way a learner reaches a console.
 *
 * The per-learner page is the teacher home's evidence panel
 * (/instructor/learners/<id> redirects to /teacher?learner=<id>). A learner's
 * phase is opened from the class's phase map, its levers are "Mark as passed",
 * "Reopen" and the rest, each asks for a reason of at least 10 characters, and
 * every one leaves a row in the record of changes beside it. The score column
 * ("— / gate 70") is not drawn there, so it is not asserted. The class is
 * made through the API and the instructor signs in straight to the class's
 * page (e2e/passing-work.ts, classByApi, says why the teacher home is avoided);
 * the console's count of passed phases is read in the class page's table.
 */

const LEARNER = {
  name: 'Lena Learner',
  email: testEmail(`e2e-detail-${Date.now()}`),
  password: 'Correct-Horse-9',
};
const CLASS_NAME = `E2E detail class ${Date.now()}`;
const REASON = 'Sandbox outage on 2 Sep swallowed their submissions; checked the story by hand.';

test('an instructor opens a learner without daily token controls and passes a gate', async ({ page, request }) => {
  await dismissPhaseTutorial(page);

  /* ----------------------- a class to put them in -------------------------- */
  const { cohortId: classId, joinCode } = await classByApi(request, CLASS_NAME);

  /* ------------------ a learner who has started the project ---------------- */
  // Registering and finishing setup starts the project (e2e/fixtures.ts).
  await registerAndSignIn(page, LEARNER);
  await joinClassInUi(page, joinCode);
  await signOutFromMenu(page);

  /* ----------------- the class's roster opens the learner ------------------ */
  await signInTo(page, INSTRUCTOR.email, INSTRUCTOR.password, `/teacher/class?class=${classId}`);
  const requirements = page.getByRole('button', { name: `Inspect ${LEARNER.name}, Requirements`, exact: true });
  await expect(requirements).toContainText('In progress', { timeout: UI_READY });
  await expect(page.getByRole('button', { name: `Inspect ${LEARNER.name}, Design`, exact: true })).toContainText('Locked');
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  const row = page.locator('tr', { hasText: LEARNER.email });
  await expect(row).toContainText(LEARNER.name);
  await expect(row).toContainText('0 / 6');
  await page.getByRole('button', { name: 'Phase map', exact: true }).click();
  await inspectLearnerPhase(page, classId, LEARNER.name, 'Requirements');

  // Historical usage does not expose a daily allowance or staff limit controls.
  await expect(page.getByTestId('learner-budget')).toHaveCount(0);
  await expect(page.getByTestId('learner-budget-input')).toHaveCount(0);
  await expect(page.getByTestId('learner-budget-save')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: `${LEARNER.name} / Requirements` })).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('learner-budget')).toHaveCount(0);

  /* ------------------------ pass a gate with a reason ---------------------- */
  await page.getByTestId('phase-lever-pass').click();
  await expect(page.getByTestId('phase-lever-confirm')).toBeVisible();
  // No reason, no override, and a reason too short to act on is no reason.
  await expect(page.getByTestId('phase-lever-do')).toBeDisabled();
  await page.getByTestId('phase-lever-reason').fill('too short');
  await expect(page.getByTestId('phase-lever-do')).toBeDisabled();
  await page.getByTestId('phase-lever-reason').fill(REASON);
  await expect(page.getByTestId('phase-lever-do')).toBeEnabled();
  await page.getByTestId('phase-lever-do').click();

  await expect(page.getByTestId('phase-levers-said')).toHaveText('Requirements now reads passed.');
  // The teacher's credit without a reviewed pass is said as such, never as a pass.
  await expect(requirements).toContainText('Credit awarded, review still needed');
  // The question closes with the override applied, and the reason is the record.
  await expect(page.getByTestId('phase-lever-confirm')).toBeHidden();
  await expect(page.getByTestId('learner-audit')).toContainText('Marked Requirements as passed');
  await expect(page.getByTestId('learner-audit')).toContainText(REASON);

  // Recorded on the server: the reload shows the same state, and the pass
  // control is off for that phase while reopening it is on offer.
  await page.reload();
  await expect(requirements).toContainText('Credit awarded, review still needed', { timeout: UI_READY });
  await expect(page.getByTestId('phase-lever-pass')).toBeDisabled();
  await expect(page.getByTestId('phase-lever-reopen')).toBeEnabled();
  await expect(page.getByTestId('phase-lever-reopen')).toHaveText('Reopen');

  /* ---------------------------- back to the console ------------------------ */
  await page.goto(`/teacher/class?class=${classId}`);
  await expect(page.getByRole('heading', { level: 1, name: CLASS_NAME })).toBeVisible({ timeout: UI_READY });
  // One of six gates: the row's count of passed phases moved from 0 to 1.
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page.locator('tr', { hasText: LEARNER.email })).toContainText('1 / 6', { timeout: UI_READY });
  await signOutFromMenu(page);
});
