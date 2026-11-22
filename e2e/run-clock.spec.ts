import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { MY_TESTS } from './fixtures';
import { dismissPhaseTutorial, signInAs, stripDoor, waitForEditor } from './pw-fixtures';
import { reachTestingByApi } from './passing-work';
import { testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The same suite gives the same verdict tomorrow.
 *
 * A suite about overdue work that reads the machine's clock is a different
 * test every day: it passes on Tuesday, fails on Wednesday, and a planted bug
 * that lives on the boundary is caught or missed by the calendar rather than
 * by the tests. The run clock is the learner's answer to that, one date, into
 * every sandbox run this phase makes, the suite and all eight mutants alike, so
 * the kill matrix is reproducible and two matrices run at different clocks are
 * marked as what they are: not comparable.
 */

const LEARNER = {
  name: 'Cliff Clock',
  email: testEmail(`e2e-clock-${Date.now()}`),
  password: 'Correct-Horse-9',
};

const PINNED = '2026-03-01';
const MOVED = '2026-04-15';

/** The three phases before Testing, walked through the API rather than clicked. */
async function reachTesting(request: APIRequestContext): Promise<string> {
  // Requirements and Design passed with complete, marked work; Implementation
  // passed with the pack's solution after a run (e2e/passing-work.ts).
  return (await reachTestingByApi(request, LEARNER)).phaseId;
}

async function signIn(page: Page): Promise<void> {
  await dismissPhaseTutorial(page);
  await page.goto('/login');
  await signInAs(page, LEARNER.email, LEARNER.password);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
}

/** The room's brief column, where the run clock is: shut by default below 1440 px (WorkspacePanels.tsx). */
async function showBrief(page: Page): Promise<void> {
  const panels = page.getByRole('group', { name: 'Workspace panels' });
  await panels.waitFor({ timeout: NAVIGATION });
  const show = panels.getByRole('button', { name: 'Show brief', exact: true });
  if (await show.count()) await show.click();
  // The phase's brief, the clock with it, sits under "Phase requirements and review" in that column. The column
  // holds a second disclosure of the same class before it ("Mission and review criteria", Brief.tsx), open as
  // it lands, so the one to open is picked by what it holds, as render-cost.spec.ts picks its own.
  const contract = page.locator('details.phase-contract-detail').filter({ has: page.getByTestId('run-clock') });
  await contract.waitFor({ timeout: UI_READY });
  if ((await contract.getAttribute('open')) === null) await contract.locator('> summary').click();
}

async function setEditor(page: Page, basename: string, content: string): Promise<void> {
  await page.waitForFunction(
    (name) =>
      Boolean(
        (window as any).monaco?.editor?.getModels().some((m: any) => m.uri.toString().endsWith(name)),
      ),
    basename,
    { timeout: UI_READY },
  );
  await page.evaluate(
    ({ name, value }) => {
      const monaco = (window as any).monaco;
      const model = monaco.editor.getModels().find((m: any) => m.uri.toString().endsWith(name));
      // An edit, not setValue: the editor treats a flush as a refresh of the saved
      // copy and ignores it (CodeEditor.tsx), so typing has to arrive as an edit.
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    },
    { name: basename, value: content },
  );
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 20_000 });
}

test('the same suite gives the same verdict tomorrow', async ({ page, request }) => {
  test.setTimeout(900_000);
  const phaseId = await reachTesting(request);

  await signIn(page);
  await page.goto(`/workspace/${phaseId}`);
  await waitForEditor(page, 60_000);

  /* ------------------------------ pin the day ----------------------------- */
  const clock = page.getByTestId('run-clock');
  await showBrief(page);
  await expect(clock).toBeVisible();
  // Before anything is pinned the phase runs on whatever day the machine is on,
  // and the status bar says so rather than staying silent.
  await expect(page.getByTestId('status-clock')).toHaveText("Tests use today's date");
  await page.getByTestId('run-clock-date').fill(PINNED);
  await page.getByTestId('run-clock-pin').click();
  await expect(page.getByTestId('status-clock')).toHaveText('Tests dated 1 March 2026', { timeout: UI_READY });
  await expect(clock).toContainText('1 March 2026');

  /* ------------------- a suite that reads it, run and graded -------------- */
  await setEditor(page, 'tests/test_acceptance.py', MY_TESTS);
  await page.getByTestId('header-run').click();
  await expect(page.getByTestId('run-panel')).toContainText('Passed', { timeout: 240_000 });

  await page.getByTestId('header-submit').click();
  await expect(page.getByTestId('feedback-verdict')).toBeVisible({ timeout: 300_000 });

  /* ------------------ the matrix names the day it ran on ------------------ */
  await (await stripDoor(page, 'open-document')).click();
  await expect(page).toHaveURL(/\/matrix$/, { timeout: UI_READY });
  await expect(page.getByTestId('matrix-clock')).toContainText('Run with the date set to 1 March 2026', {
    timeout: NAVIGATION,
  });
  // Every mutant in this report saw that same day, so the rows are comparable.
  await expect(page.getByTestId('matrix-clock-changed')).toBeHidden();

  /* ---------------- move the clock: the rows stop comparing --------------- */
  await page.goto(`/workspace/${phaseId}`);
  await showBrief(page);
  await expect(page.getByTestId('run-clock')).toBeVisible({ timeout: NAVIGATION });
  await page.getByTestId('run-clock-date').fill(MOVED);
  await page.getByTestId('run-clock-pin').click();
  await expect(page.getByTestId('status-clock')).toHaveText('Tests dated 15 April 2026', { timeout: UI_READY });

  await (await stripDoor(page, 'open-document')).click();
  await expect(page).toHaveURL(/\/matrix$/, { timeout: UI_READY });
  await expect(page.getByTestId('matrix-clock-changed')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId('matrix-clock-changed')).toContainText('not comparable');

  /* --------------- back to the machine's clock, and it says so ------------ */
  await page.goto(`/workspace/${phaseId}`);
  await showBrief(page);
  await expect(page.getByTestId('run-clock')).toBeVisible({ timeout: NAVIGATION });
  await page.getByTestId('run-clock-clear').click();
  await expect(page.getByTestId('status-clock')).toHaveText("Tests use today's date", { timeout: UI_READY });
  await expect(page.getByTestId('workspace-notice')).toContainText("Back to today's date");
});
