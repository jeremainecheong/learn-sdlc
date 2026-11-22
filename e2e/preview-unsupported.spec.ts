import { expect, test } from '@playwright/test';
import { reachImplementation } from './preview-helpers';
import { API_ORIGIN } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * A deployment that cannot preview says so, once, in the tab.
 *
 * This is its own Playwright project (`preview-off` in `playwright.config.ts`)
 * because it is the only spec in the suite that needs the API started
 * differently: `PREVIEW_ENABLED=false`, or a Lambda runner. It reads
 * `E2E_API_URL`, asks that API what it thinks, and skips itself with a
 * sentence rather than failing when it is pointed at an API where the preview
 * is switched on. To run it:
 *
 *   PREVIEW_ENABLED=false npx playwright test --project=preview-off
 *
 * The reason it cannot simply be a case in `preview.spec.ts` is worth writing
 * down: `NEXT_PUBLIC_API_URL` is inlined into the client bundle at build time,
 * so one web build talks to exactly one API. Two APIs in one run would need
 * two web builds, and the honest alternative, faking the phase's answer with
 * `page.route`, would test the fake.
 */

test.describe.configure({ mode: 'serial' });

test('the tab says why, and there is nothing to press', async ({ page }) => {
  test.setTimeout(900_000);

  const health = await page.request.get(`${API_ORIGIN}/api/v1/health`);
  test.skip(
    !health.ok(),
    `the API at ${API_ORIGIN} did not answer; start the stack before this project`,
  );

  await reachImplementation(page, 'preview-off');

  // There is no preview tab: the preview is the centre column's own
  // pane, drawn beside the code in the default Split view for a phase that
  // declares an application. So this waits for the pane rather than reading
  // the DOM the instant the phase title changes; a phase that genuinely
  // declares no application still fails here.
  await expect(
    page.getByTestId('preview-pane'),
    'the phase declares an application to run',
  ).toHaveCount(1, { timeout: UI_READY });

  const pane = page.getByTestId('preview-unsupported');
  test.skip(
    (await pane.count()) === 0,
    'this API has the preview switched on; run this project against PREVIEW_ENABLED=false',
  );

  // One sentence, and it names what still works.
  await expect(pane).toContainText('Everything else in the phase works as normal.');
  // Nothing to press, anywhere: a button that can only refuse is worse than no
  // button at all.
  await expect(page.getByTestId('header-run-app')).toHaveCount(0);
  await expect(page.getByTestId('preview-run')).toHaveCount(0);
  // And the rest of the workspace is untouched.
  await expect(page.getByTestId('header-run')).toBeVisible();
  await expect(page.getByTestId('editor-host')).toBeVisible();
});
