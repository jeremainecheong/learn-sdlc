import { expect, test } from '@playwright/test';
import { dismissPhaseTutorial, LEARNER_PASSWORD, signInTo, signOutFromMenu } from './pw-fixtures';
import { registerByApi } from './passing-work';
import { API, RUN_ID } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * Signing out on a deployment that signs people in locally, in a browser (the
 * local half of `useSignOut`, `/auth/sso/signout` and the /login notice).
 *
 * `useSignOut` saves, revokes, clears, then reads the unsigned
 * `GET /auth/providers`; the suite's API answers `local`, so the tab goes to
 * /login by one client-side push. It never leaves for the managed provider's
 * sign-out (`/auth/sso/signout`), /login says nothing about Google, and the
 * old token no longer works anywhere. The managed half (a deployment signed
 * in through the managed provider) is not covered here.
 */

// A CI retry (`retries: 1` under CI) runs the test again with the same
// E2E_RUN_ID; the retry index keeps its slug and emails new, so a retry can
// recover rather than collide with what the first try made.
let RUN = RUN_ID;
test.beforeEach(async ({}, testInfo) => {
  RUN = testInfo.retry ? `${RUN_ID}-r${testInfo.retry}` : RUN_ID;
});

test('a local sign-out ends on /login, revokes the token, and never visits the managed sign-out', async ({ page, request }) => {
  const learner = await registerByApi(request, { email: `signout-${RUN}@e2e-signout.test`, password: LEARNER_PASSWORD, name: 'Sign Out Reader' });
  const providers = await (await request.get(`${API}/auth/providers`)).json();
  expect(providers.authProvider, 'the suite runs local sign-in').toBe('local');

  const visited: string[] = [];
  page.on('request', (sent) => visited.push(sent.url()));
  await dismissPhaseTutorial(page);
  await signInTo(page, learner.email, learner.password, '/dashboard');
  const token = await page.evaluate(() => window.localStorage.getItem('lsdlc_token') ?? window.sessionStorage.getItem('lsdlc_token'));
  expect(token, 'the browser holds a session').toBeTruthy();

  await signOutFromMenu(page);
  await expect(page).toHaveURL(/\/login(\?|$)/);
  await expect(page.getByTestId('login-submit')).toBeVisible({ timeout: UI_READY });
  // No managed-mode sentence on a local deployment.
  await expect(page.getByTestId('signed-out')).toHaveCount(0);
  // The session is gone here, and the providers answer was asked for once, unsigned.
  expect(await page.evaluate(() => window.localStorage.getItem('lsdlc_token') ?? window.sessionStorage.getItem('lsdlc_token'))).toBeNull();
  expect(visited.filter((url) => /\/api\/v1\/auth\/sso\/signout/.test(url))).toEqual([]);
  expect(visited.some((url) => /\/api\/v1\/auth\/providers$/.test(url))).toBe(true);

  // And everywhere: the old token is revoked on the server.
  const me = await request.get(`${API}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  expect(me.status()).toBe(401);

  // A reload of /login still says nothing.
  await page.reload();
  await expect(page.getByTestId('signed-out')).toHaveCount(0);
});
