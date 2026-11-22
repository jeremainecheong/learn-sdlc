import { expect, Page, test } from '@playwright/test';
import { LEARNER_PASSWORD, dismissPhaseTutorial, openRequirements, requirementsTab, signInAs } from './pw-fixtures';
import { PASSING_REQUIREMENTS, enrolByApi, registerByApi, type ApiLearner, type ApiPhase } from './passing-work';
import { API, testEmail } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * The Paper/Graphite look: the theme toggle, the merge sheet, and the
 * no-sideways-scroll guarantee at phone width in both themes.
 *
 * One learner, made through the API with setup done and the project started,
 * is shared by the cases; each says its own piece, so they run in order
 * without the serial chain.
 */

const LEARNER_EMAIL = testEmail(`e2e-theme-shell-${Date.now()}`);
const LEARNER_NAME = 'Rae Theme';

let learner: ApiLearner;
let phases: ApiPhase[] = [];

const PHONE = { width: 390, height: 844 };

/* --------------------------------- helpers -------------------------------- */

async function signIn(page: Page): Promise<void> {
  await dismissPhaseTutorial(page);
  await signInAs(page, LEARNER_EMAIL, LEARNER_PASSWORD);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
}

/** The theme toggle lives under Appearance in the account menu. */
async function openAccountMenu(page: Page): Promise<void> {
  const toggle = page.getByTestId('theme-toggle');
  if (!(await toggle.isVisible().catch(() => false))) await page.getByTestId('nav-user').click();
  await expect(toggle).toBeVisible({ timeout: UI_READY });
}

/** data-theme on <html>, or null when the attribute is absent. */
async function htmlTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.dataset.theme ?? null);
}

async function storedTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('lsdlc_theme'));
}

/**
 * Relative luminance (0 = black, 1 = white) of the page background. The body
 * carries bg-ground; if it were ever transparent the root is used instead, so
 * the assertion measures what the viewer actually sees rather than an rgba(0,0,0,0).
 */
async function backgroundLuminance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const parse = (c: string): number[] | null => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      if (parts.length >= 4 && parts[3] === 0) return null; // fully transparent
      return parts.slice(0, 3);
    };
    const rgb =
      parse(getComputedStyle(document.body).backgroundColor) ??
      parse(getComputedStyle(document.documentElement).backgroundColor) ??
      [255, 255, 255];
    const lin = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  });
}

/** Clicks the toggle and gives the token swap a beat to repaint. */
async function toggleTheme(page: Page): Promise<void> {
  await page.getByTestId('theme-toggle').click();
  await page.waitForTimeout(300);
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe.configure({ mode: 'default' });

test.beforeAll(async ({ request }) => {
  learner = await registerByApi(request, { name: LEARNER_NAME, email: LEARNER_EMAIL, password: LEARNER_PASSWORD });
  phases = await enrolByApi(request, learner);
});

/* ------------------------------ 1 · the theme ----------------------------- */

test('the theme toggle switches to Graphite and survives a reload', async ({ page }) => {
  await signIn(page);
  await openAccountMenu(page);

  // A fresh browser starts on Paper: the boot script either stamps it or
  // leaves the attribute off entirely. Either way, nothing dark yet.
  expect(['paper', null]).toContain(await htmlTheme(page));
  expect(await backgroundLuminance(page), 'Paper ground is light').toBeGreaterThan(0.7);

  await toggleTheme(page);
  expect(await htmlTheme(page)).toBe('graphite');
  expect(await storedTheme(page)).toBe('graphite');
  await expect(page.getByTestId('theme-toggle')).toHaveAttribute(
    'aria-label',
    'Switch to light theme',
  );

  // The choice is applied before hydration on the next load, so there is no
  // flash of Paper and no reset.
  await page.reload();
  await openAccountMenu(page);
  expect(await htmlTheme(page)).toBe('graphite');
  expect(await storedTheme(page)).toBe('graphite');
  expect(await backgroundLuminance(page), 'Graphite ground is dark').toBeLessThan(0.3);

  await toggleTheme(page);
  expect(await htmlTheme(page)).toBe('paper');
  expect(await storedTheme(page)).toBe('paper');
  expect(await backgroundLuminance(page), 'back on Paper').toBeGreaterThan(0.7);
});

/* ----------------------------- 2 · merge sheet ---------------------------- */

test('the merge sheet opens on a passed gate and gives the keyboard back', async ({ page, request }) => {
  // The workspace has no map tab or brief tab (the Requirements phase is one
  // room, not an IDE), so what this case holds is the merge sheet. The story
  // arrives through the API, complete and marked
  // for the suite's assessor (e2e/passing-work.ts); the room submits it.
  test.setTimeout(420_000);
  const requirements = phases.find((p) => p.order === 1)!;
  const saved = await request.put(`${API}/phases/${requirements.id}/workspace`, {
    headers: learner.headers,
    data: { files: PASSING_REQUIREMENTS },
  });
  expect(saved.ok(), 'the story saves').toBeTruthy();

  await signIn(page);
  await openRequirements(page);
  await expect(page.getByTestId('phase-title')).toHaveText('Requirements', { timeout: UI_READY });

  /* ------------------------------ pass the gate --------------------------- */
  await requirementsTab(page, 'My backlog');
  await page.getByTestId('phase-requirements-submit').click();
  await expect(page.getByTestId('gate-banner')).toBeVisible({ timeout: 180_000 });

  /* ------------------------------ merge sheet ----------------------------- */
  await page.getByTestId('open-reflection').click();
  // The sheet's heading (was "Merge message").
  await expect(page.getByTestId('reflection-modal').getByRole('heading', { name: 'Continue from this phase' })).toBeVisible();

  // Closing the sheet puts the keyboard back on the control that opened it.
  // The textarea's `autoFocus` moves focus before an effect can capture
  // "where focus came from", so without care focus is left on BODY and a
  // keyboard user lands at the top of the document, thirty Tab presses from
  // where they were.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('reflection-modal')).toHaveCount(0);
  await expect(page.getByTestId('open-reflection')).toBeFocused();
  await page.getByTestId('open-reflection').click();
  await expect(page.getByTestId('reflection-modal').getByRole('heading', { name: 'Continue from this phase' })).toBeVisible();
  await page
    .getByTestId('reflection-input')
    .fill(
      'The rubric feedback showed me exactly where my story was weakest, and fixing that changed how I will write the next one.',
    );
  await page.getByTestId('reflection-submit').click();
  await expect(page.getByTestId('gate-banner')).toBeHidden({ timeout: UI_READY });
  await expect(page.getByTestId('phase-title')).toHaveText('Design', { timeout: UI_READY });
});

/* ---------------------- 3 · phone width, both themes ---------------------- */

// The learner's pages: /phases and /map
// redirect to /progress and /artefacts, /join is the classroom page, and each
// page is measured once its own heading is drawn rather than its skeleton.
const PHONE_PAGES: { path: string; ready: string[] }[] = [
  { path: '/dashboard', ready: ['dashboard-project'] },
  { path: '/progress', ready: [] },
  { path: '/artefacts', ready: [] },
  { path: '/account', ready: ['current-password'] },
  { path: '/classroom', ready: [] },
];

async function expectNoSidewaysScroll(page: Page, path: string, ready: string[], label: string) {
  await page.goto(path);
  // Measure the real page, not its loading skeleton.
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: UI_READY });
  for (const id of ready) {
    await expect(page.getByTestId(id)).toBeVisible({ timeout: UI_READY });
  }
  expect(await overflow(page), `${path} ${label}`).toBe(0);
}

test('no page scrolls sideways at 390px in either theme', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signIn(page);

  for (const { path, ready } of PHONE_PAGES) {
    await expectNoSidewaysScroll(page, path, ready, 'at 390px on Paper');
  }

  // Graphite swaps colours only, never geometry; prove it on the busiest page.
  await page.goto('/dashboard');
  await openAccountMenu(page);
  await toggleTheme(page);
  expect(await htmlTheme(page)).toBe('graphite');
  await expectNoSidewaysScroll(page, '/dashboard', ['dashboard-project'], 'at 390px on Graphite');
});
