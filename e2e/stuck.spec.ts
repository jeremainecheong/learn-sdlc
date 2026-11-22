import { expect, test } from '@playwright/test';
import {
  dismissPhaseTutorial,
  inspectLearnerPhase,
  joinClassInUi,
  openRequirements,
  registerAndSignIn,
  signInTo,
} from './pw-fixtures';
import { INSTRUCTOR, classByApi } from './passing-work';
import { testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * A learner raises a flag and their instructor answers it.
 *
 * The mentor hints and will not solve, which is the rule the product is built
 * on and also the rule that leaves a genuinely stuck learner with nowhere to
 * go. The stuck flag is that door: raised from the mentor column in the
 * workspace, answered from the Class page, and cleared by the learner and
 * nobody else.
 *
 * Two contexts, because both halves are on screen at once in a real lab: the
 * learner's column polls for the answer while the instructor is typing it.
 *
 * The flag is raised from the mentor's composer in the
 * Requirements room ("I'm stuck" opens a dialog, "Ask your instructor" sends
 * it), and the console is the class's page on the teacher home. The door stays
 * on screen once the flag is up, it reads "View help request", then "Read
 * instructor reply", so the walk has no "the door is hidden" step. The record
 * of an answer is read in the learner's record of changes on that page. The
 * class is made through the API and the instructor signs in straight to its
 * page (e2e/passing-work.ts, classByApi, says why the teacher home is avoided).
 */

const LEARNER = {
  name: 'Sam Stuck',
  email: testEmail(`e2e-stuck-${Date.now()}`),
  password: 'Correct-Horse-9',
};
const CLASS_NAME = `E2E stuck class ${Date.now()}`;
const QUESTION = 'I cannot tell whether a task due today belongs in the overdue report';
const TRIED = 'I read the backlog and asked the mentor, which sent me back to the criteria.';
const ANSWER = 'Ask the customer directly in the interview room, then write the boundary as its own criterion.';

test('a learner raises a flag and the instructor answers it', async ({ browser, request }) => {
  // Two whole journeys, a class minted, a learner registered, enrolled and
  // waiting on a poll, and the console is the heaviest page in the product.
  test.setTimeout(600_000);

  const instructorContext = await browser.newContext();
  const learnerContext = await browser.newContext();
  const staff = await instructorContext.newPage();
  const learner = await learnerContext.newPage();

  try {
    await dismissPhaseTutorial(learner);
    /* ------------------------- a class to be stuck in ---------------------- */
    const { cohortId: classId, joinCode } = await classByApi(request, CLASS_NAME);
    await signInTo(staff, INSTRUCTOR.email, INSTRUCTOR.password, `/teacher/class?class=${classId}`);

    // The card is on the console before anybody is stuck. Whether it is empty
    // depends on what else ran in this suite, so the assertion that matters is
    // that this learner is not on it yet, made below, once they exist.
    await expect(staff.getByTestId('stuck-list')).toBeVisible({ timeout: UI_READY });

    /* ------------------------ a learner in that class ---------------------- */
    await registerAndSignIn(learner, LEARNER);
    await joinClassInUi(learner, joinCode);
    await learner.goto('/dashboard');
    // The flag is raised from the mentor's composer in the Requirements room,
    // which is where a learner writing US-4 actually gets stuck.
    await openRequirements(learner);

    const userId = await learner.evaluate(
      () => JSON.parse(localStorage.getItem('lsdlc_user') || '{}').id as string,
    );
    expect(userId, 'the learner id the console keys its rows by').toBeTruthy();

    await staff.reload();
    await expect(staff.getByTestId('stuck-list')).toBeVisible({ timeout: UI_READY });
    await expect(staff.getByTestId(`stuck-row-${userId}`)).toBeHidden();

    /* ---------------------------- raising the flag ------------------------- */
    await learner.getByTestId('stuck-open').click();
    // A question too short to act on is no question, and the reason says so.
    await learner.getByTestId('stuck-question').fill('help');
    await expect(learner.getByTestId('stuck-send')).toBeDisabled();
    await learner.getByTestId('stuck-question').fill(QUESTION);
    await learner.getByTestId('stuck-tried').fill(TRIED);
    await expect(learner.getByTestId('stuck-send')).toBeEnabled();
    await learner.getByTestId('stuck-send').click();
    await expect(learner.getByTestId('stuck-raised')).toBeVisible({ timeout: UI_READY });
    await expect(learner.getByTestId('stuck-raised')).toContainText('Your instructor can see this');
    await expect(learner.getByTestId('stuck-open')).toHaveText('View help request');

    /* ------------------- the console shows it, oldest first ---------------- */
    await staff.reload();
    const row = staff.getByTestId(`stuck-row-${userId}`);
    await expect(row).toBeVisible({ timeout: UI_READY });
    await expect(row).toContainText(LEARNER.name);
    await expect(row).toContainText('Requirements');
    await expect(row).toContainText(QUESTION);
    await expect(row).toContainText(TRIED);

    /* ---------------------------- answering it ----------------------------- */
    await row.locator('button').first().click();
    await expect(staff.getByTestId('stuck-answer-input')).toBeVisible();
    await staff.getByTestId('stuck-answer-input').fill('too short');
    await expect(staff.getByTestId('stuck-answer-send')).toBeDisabled();
    await staff.getByTestId('stuck-answer-input').fill(ANSWER);
    await expect(staff.getByTestId('stuck-answer-send')).toBeEnabled();
    await staff.getByTestId('stuck-answer-send').click();
    // An answered flag stays on the console, in its own collapsed group, until
    // the learner says it helped: the instructor is not the one who closes it.
    await expect(staff.getByTestId('stuck-answered-toggle')).toBeVisible({ timeout: UI_READY });
    await staff.getByTestId('stuck-answered-toggle').click();
    await expect(staff.getByTestId('stuck-answered')).toBeVisible();
    await expect(staff.getByTestId('stuck-answered')).toContainText(ANSWER);

    /* ------------- the learner's own column, without a reload -------------- */
    // The column polls every 20 seconds while a flag is unanswered; nothing is
    // reloaded here on purpose, because that is the thing being tested.
    await expect(learner.getByTestId('stuck-answer')).toBeVisible({ timeout: NAVIGATION });
    await expect(learner.getByTestId('stuck-answer')).toContainText('Your instructor');
    await expect(learner.getByTestId('stuck-answer')).toContainText(ANSWER);

    /* -------------- clearing is the learner's, never the staff's ----------- */
    await learner.getByTestId('stuck-clear').click();
    await expect(learner.getByTestId('stuck-open')).toHaveText("I'm stuck", { timeout: UI_READY });
    await expect(learner.getByTestId('stuck-answer')).toBeHidden();

    // Cleared means gone from the console too: the queue is who still needs help.
    await staff.reload();
    await expect(staff.getByTestId('stuck-list')).toBeVisible();
    await expect(staff.getByTestId(`stuck-row-${userId}`)).toBeHidden({ timeout: UI_READY });

    /* -------------------- the answer is in the record ---------------------- */
    await inspectLearnerPhase(staff, classId, LEARNER.name, 'Requirements');
    await expect(staff.getByTestId('learner-audit')).toContainText('Answered a stuck learner', { timeout: UI_READY });
    await expect(staff.getByTestId('learner-audit')).toContainText(ANSWER);
  } finally {
    await instructorContext.close();
    await learnerContext.close();
  }
});
