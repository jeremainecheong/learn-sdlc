import { expect, test } from '@playwright/test';
import { dismissPhaseTutorial, openRequirements, registerAndSignIn } from './pw-fixtures';
import { NAVIGATION, SANDBOX_RUN } from './support/timeouts';

/**
 * A mentor question that succeeds puts the reviewer's answer in the thread.
 *
 * The suite drives the composer twice and neither drive is this one:
 * `render-cost.spec.ts` types into it without sending, and stubs the send to
 * fail so the words come back. This one asserts the ordinary case, the
 * question goes, the answer arrives, the box empties, so a slow reply can be
 * told apart from a broken composer without reading the API log. It is cheap: the
 * deterministic mentor answers in milliseconds, and only the real one is slow.
 */
test('a mentor question that succeeds shows the answer in the thread', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    try { window.localStorage.setItem('lsdlc_coach', 'done'); } catch { /* no storage */ }
  });
  await dismissPhaseTutorial(page);
  await registerAndSignIn(page, { name: 'Mentor Check', email: `mentor-${Date.now()}@check.test` });
  // Setup starts the project; the reviewer's column is in the Requirements room.
  await openRequirements(page);
  await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: NAVIGATION });

  const before = await page.getByTestId('msg-assistant').count();
  const box = page.getByTestId('chat-input');
  await expect(box).toBeVisible({ timeout: NAVIGATION });
  await box.click();
  await box.pressSequentially('What should the acceptance criteria cover?', { delay: 5 });
  await page.getByTestId('chat-send').click();
  const reply = page.getByTestId('msg-assistant').nth(before);
  await reply.waitFor({ state: 'visible', timeout: SANDBOX_RUN });
  await expect(reply).not.toBeEmpty();
  await expect(page.getByTestId('chat-error')).toHaveCount(0);
  // And the box is empty again, because the question went.
  await expect(box).toHaveValue('');
});
