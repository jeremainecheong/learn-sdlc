import { expect, test } from '@playwright/test';
import { UI_READY } from './support/timeouts';

/**
 * Two web-client security rules that are only honest in a browser.
 *
 * A Google callback page that kept any token arriving in its fragment would
 * let a link somebody else built sign whoever opened it into the builder's
 * account; and a reset link that left its one-hour token in the address bar
 * would leave it in the history of a shared machine.
 */

test('a sign-in link this tab never asked for is refused, and nothing is stored', async ({
  page,
}) => {
  // Built by somebody else, with their token in it, opened cold.
  await page.goto('/login/callback#token=somebody-elses-token');
  await expect(page.getByTestId('google-callback-error')).toBeVisible();
  await expect(page.getByTestId('google-callback-error')).toContainText('did not carry a session');
  expect(await page.evaluate(() => localStorage.getItem('lsdlc_token'))).toBeNull();
  expect(page.url()).not.toContain('token=');
  await expect(page).toHaveURL(/\/login\/callback$/);
});

test('a reset link leaves the address bar without its token', async ({ page }) => {
  await page.goto('/reset?token=not-a-real-token');
  await expect(page.getByTestId('reset-password')).toBeVisible({ timeout: UI_READY });
  // The page still has it, the form is drawn, and the history entry does not.
  expect(page.url()).not.toContain('token=');
  await expect(page).toHaveURL(/\/reset$/);
});

test('a confirmation link leaves the address bar without its token', async ({ page }) => {
  await page.goto('/verify?token=not-a-real-token');
  await expect(page.getByTestId('verify-failed')).toBeVisible({ timeout: UI_READY });
  expect(page.url()).not.toContain('token=');
});
