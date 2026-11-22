import { expect, test } from '@playwright/test';
import { openConsole, openFile, reachImplementation, setEditor, verdictOnScreen } from './preview-helpers';
import { myPhaseIds } from './passing-work';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * Code health in the editor.
 *
 * One learner, one walk: reach implementation, submit the scaffold as it
 * stands, and read what the analyzer found, on the code as underlines, and
 * under it as the Health tab. The scaffold is submitted unfinished on purpose:
 * `TODO(learner)` markers and `NotImplementedError` are exactly what the
 * analyzer is for, and they are the findings a learner meets first.
 */

/** What `apps/api/runner/analyzer.py` reports for the phase 3 scaffold. */
const REPOSITORY = 'api/repository/tasks.py';
/** The first `NotImplementedError` in it, and the first row in the tab. */
const FIRST_ERROR_LINE = 74;

const markersOf = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () =>
      ((window as any).monaco?.editor
        ?.getModelMarkers({ owner: 'learnsdlc-health' })
        ?.map((m: any) => ({ line: m.startLineNumber, message: m.message, code: m.code })) ??
        []) as { line: number; message: string; code: string }[],
  );

test('the analyzer’s findings are drawn on the code and read under it', async ({ page }) => {
  test.slow();
  await reachImplementation(page, 'health');

  // Before the first verdict the tab is honest about having nothing. The
  // implementation IDE keeps its bottom panel shut until it is asked for, so
  // it is opened from the console bar under the editor first.
  await openConsole(page);
  await page.getByTestId('tab-health').click();
  await expect(page.getByTestId('health-empty')).toContainText('No health yet');

  await openFile(page, REPOSITORY);
  await page.getByTestId('header-submit').click();
  await verdictOnScreen(page, 180_000);

  /* ---------------------- the findings, on the code ---------------------- */

  await expect
    .poll(async () => (await markersOf(page)).length, { timeout: UI_READY })
    .toBeGreaterThan(0);
  const drawn = await markersOf(page);
  expect(drawn.some((m) => m.line === FIRST_ERROR_LINE)).toBe(true);
  expect(drawn.find((m) => m.line === FIRST_ERROR_LINE)?.message).toContain('NotImplementedError');
  expect(drawn.find((m) => m.line === FIRST_ERROR_LINE)?.code).toBe('not-implemented');

  /* -------------------- the findings, under the code --------------------- */

  await page.getByTestId('tab-health').click();
  await expect(page.getByTestId('health-panel')).toBeVisible();
  await expect(page.getByTestId('health-source')).toContainText('From submission 1.');
  for (const id of ['health-quality', 'health-complexity', 'health-docstrings', 'health-todos']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.getByTestId('health-complexity')).toContainText('Highest complexity');
  await expect(page.getByTestId('health-docstrings')).toContainText('%');

  const finding = page.getByTestId(`health-finding-not-implemented-${FIRST_ERROR_LINE}`);
  await expect(finding).toContainText(`${REPOSITORY}, line ${FIRST_ERROR_LINE}`);

  // One revision is not a trend, and the panel says so rather than drawing a
  // line through one point.
  await expect(page.getByTestId('health-trend-sentence')).toContainText(
    'The trend needs a second revision',
  );

  /* ------------- pressing a finding puts the caret on that line ----------- */

  await finding.click();
  await expect(page.getByTestId('status-bar')).toContainText(`Ln ${FIRST_ERROR_LINE}`);

  /* ------- editing takes the underlines down and the tab says why -------- */

  const current = await page.evaluate(
    (name) =>
      (window as any).monaco.editor
        .getModels()
        .find((m: any) => m.uri.toString().endsWith(name))
        .getValue() as string,
    REPOSITORY,
  );
  await setEditor(page, REPOSITORY, `${current}\n\n# thinking about it\n`);
  await expect(page.getByTestId('health-stale')).toBeVisible();
  await expect(page.getByTestId('health-stale')).toContainText('Submit again');
  await expect.poll(async () => (await markersOf(page)).length, { timeout: 15_000 }).toBe(0);
});

test('there is no health tab on a phase the analyzer never runs for', async ({ page }) => {
  test.slow();
  await reachImplementation(page, 'nohealth');

  // The tab is here, on the phase the analyzer runs for, once the IDE's
  // bottom panel is open.
  await openConsole(page);
  await expect(page.getByTestId('tab-health')).toHaveCount(1);

  // Requirements is one room (interview, backlog and mentor on one page),
  // with no editor and no bottom panel.
  await page.goto(`/workspace/${(await myPhaseIds(page)).requirements}`);
  await expect(page.getByTestId('phase-title')).toHaveText('Requirements', { timeout: NAVIGATION });
  await expect(page.getByTestId('requirements-workspace')).toBeVisible();
  await expect(page.getByTestId('tab-health')).toHaveCount(0);
});
