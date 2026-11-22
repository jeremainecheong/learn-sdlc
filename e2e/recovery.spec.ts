import { expect, Page, test } from '@playwright/test';
import { waitForRecoveryLink } from './mail';
import { registerAndSignIn, signInAs, signOutFromMenu } from './pw-fixtures';
import { testEmail } from './support/env';

/**
 * Password recovery and address verification through the real pages, with
 * each emailed link read back out of the mail capture file (e2e/mail.ts) the
 * API appends to under the harness. The route contract for the same flows is
 * apps/api/test/recovery.e2e-spec.ts; this suite covers what a learner sees:
 * /forgot, /reset, /verify and the dashboard's confirmation banner.
 */

const PASSWORD = 'Correct-Horse-9';
const NEW_PASSWORD = 'Battery-Staple-42';

async function register(page: Page, name: string, email: string, password: string): Promise<void> {
  // Register, sign in, finish setup: the product's own front door.
  await registerAndSignIn(page, { name, email, password });
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await signInAs(page, email, password);
}

async function signOut(page: Page): Promise<void> {
  // Sign out lives in the account menu under the learner's name.
  await signOutFromMenu(page);
}

/** The same link with the last character of its token changed: the signature no longer matches. */
function tampered(link: string): string {
  const last = link.slice(-1);
  return link.slice(0, -1) + (last === 'a' ? 'b' : 'a');
}

test('a new learner confirms their address from the emailed link', async ({ page }) => {
  const email = testEmail(`e2e-verify-${Date.now()}`);
  await register(page, 'Vera Verified', email, PASSWORD);

  // Unconfirmed: the notice, with a resend control, sits on the account page
  // (app/(app)/account/page.tsx mounts VerifyBanner), not under the nav.
  await page.goto('/account');
  await expect(page.getByTestId('verify-banner')).toBeVisible();
  await expect(page.getByTestId('verify-banner')).toContainText(email);
  await expect(page.getByTestId('verify-resend')).toBeVisible();

  // Registration does not mail a link on its own (the API sends one only when
  // asked, recovery.controller.ts): the learner asks from the notice.
  await page.getByTestId('verify-resend').click();
  const link = await waitForRecoveryLink(email, 'verify');

  /* ---------------------- a tampered token is refused ---------------------- */
  await page.goto(tampered(link));
  await expect(page.getByTestId('verify-failed')).toBeVisible();
  await expect(page.getByTestId('verify-failed')).toContainText('invalid');
  await expect(page.getByTestId('verify-done')).toBeHidden();
  // Signed in, so the page can offer a fresh link on the spot.
  await expect(page.getByTestId('verify-resend')).toBeVisible();

  /* ------------------------ the real one confirms it ----------------------- */
  await page.goto(link);
  await expect(page.getByTestId('verify-done')).toBeVisible();
  await expect(page.getByTestId('verify-done')).toContainText(email);
  await expect(page.getByTestId('verify-failed')).toBeHidden();

  // Continue lands on the dashboard. The account page, where the notice lives,
  // then asks for the status; once that has answered "verified", there is no
  // banner and no resend control to find.
  await page.getByTestId('verify-continue').click();
  await page.waitForURL('**/dashboard');
  await expect(page.getByTestId('dashboard-project')).toBeVisible();
  const status = page.waitForResponse(
    (res) => res.request().method() === 'GET' && res.url().includes('/auth/verify/status'),
  );
  await page.goto('/account');
  expect((await (await status).json()).verified).toBe(true);
  await expect(page.getByTestId('verify-banner')).toBeHidden();
  await expect(page.getByTestId('verify-resend')).toBeHidden();
});

test('a learner who forgot their password resets it from the emailed link', async ({ page }) => {
  const email = testEmail(`e2e-reset-${Date.now()}`);
  await register(page, 'Rita Reset', email, PASSWORD);
  await signOut(page);

  /* ----------------------------- ask for a link ---------------------------- */
  await page.goto('/login');
  await page.getByTestId('to-forgot').click();
  await page.waitForURL('**/forgot');
  await page.getByTestId('forgot-email').fill(email);
  await page.getByTestId('forgot-submit').click();
  await expect(page.getByTestId('forgot-done')).toBeVisible();
  // With no mail provider the link goes to the installation's development
  // mailbox (the harness reads it from the capture file), and the page says so.
  await expect(page.getByTestId('forgot-done')).toContainText('reset link has been requested');

  /* ----------------------- choose the new password ------------------------- */
  const link = await waitForRecoveryLink(email, 'reset');
  await page.goto(link);
  await expect(page.getByTestId('reset-password')).toBeVisible();
  await expect(page.getByTestId('reset-missing')).toBeHidden();

  // A mismatched confirmation never reaches the API.
  await page.getByTestId('reset-password').fill(NEW_PASSWORD);
  await page.getByTestId('reset-confirm').fill(`${NEW_PASSWORD}-typo`);
  await page.getByTestId('reset-submit').click();
  await expect(page.getByTestId('auth-error')).toContainText('do not match');

  await page.getByTestId('reset-confirm').fill(NEW_PASSWORD);
  await page.getByTestId('reset-submit').click();
  await expect(page.getByTestId('reset-done')).toBeVisible();

  /* -------------------- the new password works, the old is out ------------- */
  await page.getByTestId('to-login').click();
  await page.waitForURL('**/login**');
  await signInAs(page, email, NEW_PASSWORD);
  await page.waitForURL('**/dashboard');
  await expect(page.getByTestId('dashboard-project')).toBeVisible();
  await signOut(page);

  await signIn(page, email, PASSWORD);
  await expect(page.getByTestId('auth-error')).toContainText('invalid');
  await expect(page).toHaveURL(/\/login/);

  /* ---------------------- the link was spent by the reset ------------------ */
  await page.goto(link);
  await page.getByTestId('reset-password').fill('Another-Fine-Password-7');
  await page.getByTestId('reset-confirm').fill('Another-Fine-Password-7');
  await page.getByTestId('reset-submit').click();
  await expect(page.getByTestId('auth-error')).toContainText('already been used');
  await expect(page.getByTestId('reset-done')).toBeHidden();
});

test('the reset page without a token points back to requesting a link', async ({ page }) => {
  await page.goto('/reset');
  await expect(page.getByTestId('reset-missing')).toBeVisible();
  await expect(page.getByTestId('reset-password')).toBeHidden();
  await page.getByTestId('to-forgot').click();
  await page.waitForURL('**/forgot');
  await expect(page.getByTestId('forgot-email')).toBeVisible();
});
