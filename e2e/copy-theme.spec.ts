import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { LEARNER_PASSWORD, registerAndSignIn, signInAs, skipCoachMarks } from './pw-fixtures';
import { registerByApi } from './passing-work';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * Copy and theme.
 *
 * Things a learner meets that must be said once, in the right place:
 *
 *   - one empty state, one wording, one way out of it, on the four pages
 *     that have nothing to show before a project is started; and the reset
 *     page complaining in a sentence, about the box that is actually wrong.
 *   - the answer to a form rendered beside the form, not a screen above it.
 *   - the theme seeded from the machine when nothing is stored, and a
 *     toggle with a third position that gives the machine back.
 *
 * A failed mentor question keeping what the learner typed is tested in
 * `e2e/render-cost.spec.ts`, "a mentor question that fails keeps the text and
 * leaves no orphan bubble".
 */

const freshEmail = () => `c3-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@copy.test`;

/** Registers a fresh learner the way a person does, and lands on the dashboard. */
async function signUp(page: Page, password = LEARNER_PASSWORD): Promise<string> {
  await skipCoachMarks(page);
  const email = freshEmail();
  await registerAndSignIn(page, { name: 'Copy Lane', email, password });
  return email;
}

/**
 * A learner who has started nothing. Setup starts the project, so this one
 * is made through the API with setup marked done and no enrolment, then signs
 * in on the page.
 */
async function signUpWithNoProject(page: Page, request: APIRequestContext): Promise<string> {
  await skipCoachMarks(page);
  const email = freshEmail();
  await registerByApi(request, { email, password: LEARNER_PASSWORD, name: 'Copy Lane' });
  await signInAs(page, email);
  await page.waitForURL('**/dashboard', { timeout: NAVIGATION });
  return email;
}

/** What the boot script stamped: the theme in force and where it came from. */
async function stamped(page: Page): Promise<{ theme: string | null; choice: string | null }> {
  return page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    choice: document.documentElement.getAttribute('data-theme-choice'),
  }));
}

async function stored(page: Page): Promise<string | null> {
  return page.evaluate(() => window.localStorage.getItem('lsdlc_theme'));
}

/* ------------------- 1 · the theme follows the machine -------------------- */

test.describe('on a machine set to dark', () => {
  test.use({ colorScheme: 'dark' });

  test('a first visit with nothing stored is stamped Graphite before React runs', async ({
    page,
  }) => {
    // The toggle lives in the signed-in top bar; the stamp is the boot
    // script's, and a first visit is a signed-out one, so it is read here.
    await page.goto('/login');
    await expect(page.getByTestId('login-submit')).toBeVisible({ timeout: UI_READY });

    // The browser chrome follows the system through the manifest, and the
    // page must too. Nothing is stored, so the machine decides, and it
    // decides before the first paint.
    expect(await stored(page)).toBeNull();
    expect(await stamped(page)).toEqual({ theme: 'graphite', choice: 'system' });
    const luminance = await page.evaluate(() => {
      const parse = (c: string) => (c.match(/[\d.]+/g) ?? ['255', '255', '255']).map(Number);
      const rgb = parse(getComputedStyle(document.body).backgroundColor);
      const lin = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    });
    expect(luminance, 'the ground is dark on a dark machine').toBeLessThan(0.3);
  });

  test('the toggle has three positions and the third gives the machine back', async ({ page, request }) => {
    // The toggle is under Appearance in the signed-in account menu, so the
    // walk starts signed in with that menu open.
    await signUpWithNoProject(page, request);
    await page.getByTestId('nav-user').click();
    const toggle = page.getByTestId('theme-toggle');
    await expect(toggle).toBeVisible({ timeout: UI_READY });

    // Press one takes you off the theme you are looking at, which is what a
    // two-position toggle would have done.
    await toggle.click();
    expect(await stamped(page)).toEqual({ theme: 'paper', choice: 'paper' });
    expect(await stored(page)).toBe('paper');

    // Press two pins the machine's own theme: same colour, chosen rather than
    // inherited, so it will not move if the machine changes its mind.
    await toggle.click();
    expect(await stamped(page)).toEqual({ theme: 'graphite', choice: 'graphite' });
    expect(await stored(page)).toBe('graphite');

    // Press three hands it back. The key is removed rather than set to a word,
    // so "follow the machine" survives a future change of default.
    await toggle.click();
    expect(await stamped(page)).toEqual({ theme: 'graphite', choice: 'system' });
    expect(await stored(page)).toBeNull();
    await expect(toggle).toHaveAttribute('aria-label', 'Switch to light theme');

    // And it survives the reload, because the boot script reads the same two
    // sources in the same order.
    await page.reload();
    await page.getByTestId('nav-user').click();
    await expect(page.getByTestId('theme-toggle')).toBeVisible({ timeout: UI_READY });
    expect(await stamped(page)).toEqual({ theme: 'graphite', choice: 'system' });
  });
});

test('a first visit on a light machine is stamped Paper, still as a follower', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByTestId('login-submit')).toBeVisible({ timeout: UI_READY });
  expect(await stored(page)).toBeNull();
  expect(await stamped(page)).toEqual({ theme: 'paper', choice: 'system' });
});

/* --------------------- 2 · one empty state, four pages -------------------- */

test('the four pages with nothing to show say the same thing the same way', async ({ page, request }) => {
  test.setTimeout(180_000);
  await signUpWithNoProject(page, request);

  // The four pages share one start panel (components/experience/shared.tsx):
  // /map draws it in place of the project map, /phases redirects to
  // /progress, and every page a learner with no project opens says the same
  // sentence with the same one way on, which starts Requirements rather than
  // sending them Home first.
  for (const path of ['/map', '/phases', '/artefacts', '/journal'] as const) {
    await page.goto(path);
    const empty = page.locator('section.exp-hero', { hasText: 'Your next chapter starts here.' });
    await expect(empty, `${path} draws the shared empty state`).toBeVisible({ timeout: UI_READY });
    await expect(empty, `${path} uses the one wording`).toContainText('Begin with Requirements and earn each next phase through review.');
    const action = empty.getByRole('button', { name: 'Start Requirements' });
    await expect(action, `${path} offers the one way out`).toBeVisible();
    // The same action, drawn the same weight, on all four pages.
    const shape = await action.evaluate((el) => ({
      height: Math.round(el.getBoundingClientRect().height),
      weight: getComputedStyle(el).fontWeight,
    }));
    expect(shape.height, `${path}: the button is full height`).toBeGreaterThan(30);
    expect(Number(shape.weight), `${path}: the button carries the primary weight`).toBeGreaterThanOrEqual(500);
  }

  // The skeleton is decoration, and it stays hidden from a reader, but hiding
  // it and saying nothing would leave a reader on an empty document. Hold the API open
  // for a moment so the loading state is a thing that can be looked at.
  await page.route('**/api/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 1_500));
    await route.continue();
  });
  await page.goto('/artefacts');
  await expect(
    page.locator('[role="status"]', { hasText: 'Opening your project' }).first(),
    'a reader is told the project is loading',
  ).toBeAttached({ timeout: 15_000 });
  // Let the held requests finish before the handler goes, or a late one is
  // continued twice.
  await page.unrouteAll({ behavior: 'wait' });
});

/* -------------- 3 · the reset page complains about the right box ---------- */

test('a password that does not match flags the second box, in a sentence', async ({ page }) => {
  await page.goto('/reset?token=not-a-real-token');
  await expect(page.getByTestId('reset-password')).toBeVisible({ timeout: UI_READY });

  await page.getByTestId('reset-password').fill('Correct-Horse-9');
  await page.getByTestId('reset-confirm').fill('Correct-Horse-8');
  await page.getByTestId('reset-submit').click();

  const notice = page.getByTestId('auth-error');
  await expect(notice).toBeVisible();
  const said = (await notice.innerText()).trim();
  expect(said, 'the complaint is a sentence, not a fragment').toMatch(/^[A-Z]/);
  expect(said).toContain('do not match');

  // Only the box that can be wrong is flagged: the new password itself is fine.
  await expect(page.getByTestId('reset-confirm')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('reset-password')).not.toHaveAttribute('aria-invalid', 'true');

  // Editing either box makes the complaint stale, so it goes.
  await page.getByTestId('reset-confirm').fill('Correct-Horse-9');
  await expect(notice).toBeHidden();
});

/* ------------- 4 · the answer lands beside the form that asked ------------ */

test('the password answer is in view at a 720px viewport', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  const password = 'Correct-Horse-9';
  await signUp(page, password);

  await page.goto('/account');
  await expect(page.getByTestId('current-password')).toBeVisible({ timeout: UI_READY });
  await page.getByTestId('current-password').fill(password);
  await page.getByTestId('new-password').fill('Another-Fine-Password-7');
  // Put the button at the top of the viewport, which is where a learner who
  // has just filled this form is looking. Everything above it, the page's
  // heading included, is off screen.
  const button = page.getByTestId('password-save');
  await button.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await button.click();

  // A changed password ends every session at once, this one included, so
  // the answer is on the sign-in page the change lands on, the page the
  // learner acts on next, rather than beside the button on the account page.
  await page.waitForURL('**/login**', { timeout: UI_READY });
  const note = page.getByTestId('password-change-success');
  await expect(note).toBeVisible({ timeout: UI_READY });
  await expect(note).toContainText('all sessions have ended');

  // In view without scrolling, not under the h1 several sections above the
  // button that caused it.
  const box = await note.boundingBox();
  expect(box, 'the note has a box').not.toBeNull();
  expect(box!.y, 'the note is not above the fold-scroll').toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, 'the note is inside a 720px viewport').toBeLessThanOrEqual(720);

  // And it is beside the form it belongs to, not floating at the top of the page.
  const gap = await page.evaluate(() => {
    const field = document.querySelector('[data-testid="email"]')!.getBoundingClientRect();
    const el = document.querySelector('[data-testid="password-change-success"]')!.getBoundingClientRect();
    return Math.abs(field.top - el.bottom);
  });
  expect(gap, 'the note sits with the sign-in form it asks for').toBeLessThan(120);
});
