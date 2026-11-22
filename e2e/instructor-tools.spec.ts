import { expect, test } from '@playwright/test';
import { dismissPhaseTutorial, inspectLearnerPhase, joinClassInUi, registerAndSignIn, requirementsTab, signInAs, signInTo, signOutFromMenu, continueMyProject } from './pw-fixtures';
import { INSTRUCTOR, classByApi, myPhaseIds } from './passing-work';
import { testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The three instructor levers that are not the gate: reset a phase
 * and start it over, look at a learner's screens read only, and give the class
 * its dates.
 *
 * One journey, because all three are things the same person does in the same
 * ten minutes, and because each act leaves the state the next one reads.
 *
 * All three live on the teacher's class page. A learner's
 * phase is opened from the class's phase map, where its levers ("Mark as
 * passed", "Reset this phase", …) ask for a reason and leave a row in the
 * record of changes; "View as" opens the learner's own screens; and the class's
 * dates are the "Dates and regrades" panel under the roster. The walk has no
 * step for the phases page a breadcrumb would lead to (the learner's room
 * carries no such crumb) or for a phase card telling the learner "Opens on …"
 * (no page draws one). The due date on the
 * learner's own phase strip is set and read for the current phase, beside the
 * Deployment dates. The class is made through the API and the instructor signs
 * in straight to its page (e2e/passing-work.ts, classByApi, says why the
 * teacher home is avoided).
 *
 * The walk's last claim has its own assertions, and it is red: the phase the
 * class holds back tells the learner the date it opens and the date it is due
 * (phase-opens-<key>, phase-due-<key>), and stays shut. The phases page
 * redirects to /progress, so it is read where a learner meets a held phase:
 * the phase's own route, which the workspace layout answers with its lock
 * (phase-locked). No mounted page draws a phase's release date
 * (lib/schedule.ts `opensLine` has no mounted caller), so the learner reads only "Pass your current phase before opening
 * Deployment." Red until the product draws those dates.
 */

const LEARNER = {
  name: 'Nadia Newcomer',
  email: testEmail(`e2e-tools-${Date.now()}`),
  password: 'Correct-Horse-9',
};
const CLASS_NAME = `E2E tools class ${Date.now()}`;
const PASS_REASON = 'Their story was written on paper in the lab; checked it against the rubric by hand.';
const RESET_REASON = 'They started from the wrong scaffold, so the phase begins again from the top.';

/** A wall time `datetime-local` accepts, days from now, in this browser's zone. */
function localInputIn(days: number, hour: number, minute: number): string {
  const at = new Date(Date.now() + days * 86_400_000);
  at.setHours(hour, minute, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(
    at.getMinutes(),
  )}`;
}

test('an instructor resets a phase, views as the learner, and sets the class dates', async ({ page, request }) => {
  test.setTimeout(600_000);

  await dismissPhaseTutorial(page);

  /* ------------------------ a class, and a code for it --------------------- */
  const { cohortId: classId, joinCode } = await classByApi(request, CLASS_NAME);

  /* ---------------------- a learner in it, with a project ------------------ */
  await registerAndSignIn(page, LEARNER);
  await joinClassInUi(page, joinCode);
  await signOutFromMenu(page);

  /* ------------------------ act one · reset a phase ------------------------ */
  await signInTo(page, INSTRUCTOR.email, INSTRUCTOR.password, `/teacher/class?class=${classId}`);
  await inspectLearnerPhase(page, classId, LEARNER.name, 'Requirements');
  const requirements = page.getByRole('button', { name: `Inspect ${LEARNER.name}, Requirements`, exact: true });

  // Something to reset: the gate is passed by hand first, which is the state a
  // reset is for, a phase that counts as done and has to begin again.
  await page.getByTestId('phase-lever-pass').click();
  await page.getByTestId('phase-lever-reason').fill(PASS_REASON);
  await page.getByTestId('phase-lever-do').click();
  await expect(page.getByTestId('phase-levers-said')).toHaveText('Requirements now reads passed.');
  // The teacher's credit without a reviewed pass is said as such, never as a pass.
  await expect(requirements).toContainText('Credit awarded, review still needed');

  await page.getByTestId('phase-lever-reset-phase').click();
  // No reason, no reset: the same rule the other levers follow.
  await page.getByTestId('phase-lever-reason').fill('');
  await expect(page.getByTestId('phase-lever-do')).toBeDisabled();
  await page.getByTestId('phase-lever-reason').fill(RESET_REASON);
  await expect(page.getByTestId('phase-lever-do')).toBeEnabled();

  // It asks first, and taking it back leaves the phase exactly as it was.
  const confirm = page.getByTestId('phase-lever-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('This cannot be undone.');
  await page.getByTestId('phase-lever-cancel').click();
  await expect(confirm).toBeHidden();
  // The teacher's credit without a reviewed pass is said as such, never as a pass.
  await expect(requirements).toContainText('Credit awarded, review still needed');

  await page.getByTestId('phase-lever-reset-phase').click();
  await page.getByTestId('phase-lever-reason').fill(RESET_REASON);
  await page.getByTestId('phase-lever-do').click();
  await expect(page.getByTestId('phase-levers-said')).toContainText('Requirements was reset');
  await expect(requirements).toContainText('In progress');
  // The reason is the record, and it is on the page under the action.
  await expect(page.getByTestId('learner-audit')).toContainText(RESET_REASON);

  // And it survived the round trip: nothing here is component state.
  await page.reload();
  await expect(requirements).toContainText('In progress', { timeout: UI_READY });

  /* --------------------- act two · view as the learner --------------------- */
  await page.getByTestId('view-as-start').click();
  await page.waitForURL('**/dashboard', { timeout: NAVIGATION });
  const banner = page.getByTestId('view-as-banner');
  await expect(banner).toBeVisible({ timeout: UI_READY });
  await expect(banner).toContainText(`You are viewing ${LEARNER.name}'s work`);
  // Their dashboard, not the instructor's own empty one.
  await expect(page.getByTestId('dashboard-project')).toContainText('TaskTrackr', { timeout: UI_READY });

  // Every move from here is client-side, and deliberately so: the session is
  // held in memory, so a full page load is what ends it, asserted below.
  await continueMyProject(page);
  await page.waitForURL('**/workspace/**');
  await expect(page.getByTestId('phase-title')).toHaveText('Requirements', { timeout: NAVIGATION });
  await expect(banner).toBeVisible();

  // The one thing the whole design turns on: a write is refused in the
  // browser, before it can reach the API at all.
  await requirementsTab(page, 'My backlog');
  await page.getByTestId('phase-requirements-submit').click();
  await expect(page.getByText('so nothing can be saved, run or submitted').first()).toBeVisible({ timeout: UI_READY });
  await expect(banner).toBeVisible();

  await page.getByTestId('view-as-stop').click();
  // /teacher?learner= goes on to the learner's class page, its roster filtered to them.
  await page.waitForURL(/\/teacher\/class\?class=[^&]+&learner=/, { timeout: NAVIGATION });
  await expect(banner).toBeHidden();
  await expect(page.locator('tr', { hasText: LEARNER.email })).toBeVisible({ timeout: UI_READY });

  // And a reload ends one too: a view-as session that survived a refresh is a
  // session an instructor could forget they were in.
  await page.goto(`/teacher/class?class=${classId}`);
  await page.getByRole('button', { name: `View as ${LEARNER.name.split(' ')[0]}`, exact: true }).first().click();
  await page.waitForURL('**/dashboard', { timeout: NAVIGATION });
  await expect(banner).toBeVisible({ timeout: UI_READY });
  await page.reload();
  // The shell comes back as the instructor's own. Waiting for the sidebar is
  // what makes the banner assertion mean "gone after a real reload" rather
  // than "not drawn yet".
  await expect(page.getByTestId('nav-instructor')).toBeVisible({ timeout: UI_READY });
  await expect(banner).toBeHidden();

  /* ----------------------- act three · the class dates --------------------- */
  await page.goto(`/teacher/class?class=${classId}`);
  // The class's dates are under its Dates and regrades tab; the tab is
  // kept in the address, so the reload below lands on it again.
  await page.getByTestId('class-tab-dates').click();
  const dates = page.getByTestId('schedule-panel');
  await expect(dates).toBeVisible({ timeout: UI_READY });
  // The class page's panel is this class's; a picker, when there is one, is
  // read once the table is in (reading `count()` before the list answers
  // sets dates on the wrong class).
  const picker = page.getByTestId('schedule-cohort');
  const table = page.getByTestId('schedule-table');
  await expect(table).toBeVisible({ timeout: UI_READY });
  if (await picker.count()) await picker.selectOption({ label: CLASS_NAME });
  // The first visit: every cell blank, and the line that says what that means.
  await expect(page.getByTestId('schedule-cleared')).toBeVisible();
  await expect(page.getByTestId('schedule-opens-deployment')).toHaveValue('');

  const opens = localInputIn(30, 9, 0);
  const due = localInputIn(37, 23, 59);
  const requirementsDue = localInputIn(14, 23, 59);
  await page.getByTestId('schedule-opens-deployment').fill(opens);
  await page.getByTestId('schedule-due-deployment').fill(due);
  await page.getByTestId('schedule-due-requirements').fill(requirementsDue);
  await page.getByTestId('schedule-save').click();
  await expect(page.getByTestId('schedule-saved')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('schedule-cleared')).toBeHidden();

  // Stored, not held: the reload reads them back off the server.
  await page.reload();
  await expect(dates).toBeVisible({ timeout: UI_READY });
  await expect(table).toBeVisible({ timeout: UI_READY });
  if (await picker.count()) await picker.selectOption({ label: CLASS_NAME });
  await expect(page.getByTestId('schedule-opens-deployment')).toHaveValue(opens, { timeout: UI_READY });
  await expect(page.getByTestId('schedule-due-deployment')).toHaveValue(due);
  await expect(page.getByTestId('schedule-due-requirements')).toHaveValue(requirementsDue);
  await signOutFromMenu(page);

  /* ------------------- and what the learner is told about it --------------- */
  await signInAs(page, LEARNER.email, LEARNER.password);
  await expect(page.getByTestId('dashboard-project')).toContainText('TaskTrackr', { timeout: UI_READY });
  await continueMyProject(page);
  await expect(page.getByTestId('phase-title')).toHaveText('Requirements', { timeout: NAVIGATION });
  // The strip of the phase they are on says the date, as a fact and not a lock.
  await expect(page.getByTestId('phase-strip-due')).toHaveText(/^Due \d{1,2} \w+ at \d{2}:\d{2}$/, { timeout: UI_READY });

  // And the phase the class holds back: opened the way a learner who follows a
  // link does, it is still shut, and it says its dates rather than "pass the
  // gate before it first", which is what a release date is for. The two date
  // lines are red here; see the header.
  const deployment = (await myPhaseIds(page)).deployment;
  expect(deployment, 'the learner has a Deployment phase').toBeTruthy();
  await page.goto(`/workspace/${deployment}`);
  await expect(page.getByTestId('phase-locked'), 'Deployment is still shut').toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('phase-opens-deployment')).toHaveText(/^Opens on \d{1,2} \w+ at \d{2}:\d{2}$/);
  await expect(page.getByTestId('phase-due-deployment')).toHaveText(/^Due \d{1,2} \w+ at \d{2}:\d{2}$/);
});
