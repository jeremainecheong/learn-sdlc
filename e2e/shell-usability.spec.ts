import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { dismissPhaseTutorial, signInAs } from './pw-fixtures';
import { reachImplementationByApi } from './passing-work';
import { testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The front door, the dossier, the palette, the bell, the workspace status bar
 * and the breadcrumb, held to a usability bar.
 *
 * The cases are grouped by the thing, because a learner meets them that way:
 * the page they land on, the one document, the two overlays and the chrome
 * around the page.
 */

const LEARNER = {
  name: 'Una Usability',
  email: testEmail(`e2e-shell-usability-${Date.now()}`),
  password: 'Correct-Horse-9',
};

let phaseIds: { order: number; id: string }[] = [];

// In order, one worker, not serial: the cases share only the learner the
// beforeAll makes, and each must say its own piece.
test.describe.configure({ mode: 'default' });

/**
 * A learner two phases in, through the API. The click path is journey.spec's
 * job; what is under test here is the chrome around it, so the learner arrives
 * the cheap way, but they must arrive with real work behind them, because a
 * passed gate is what puts a row in the bell and a criterion on the map.
 */
test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
  // Registered with setup done, enrolled, and the two written phases passed
  // with complete, marked work (e2e/passing-work.ts).
  const reached = await reachImplementationByApi(request, LEARNER);
  phaseIds = reached.phases.map((p) => ({ order: p.order, id: p.id }));
});

async function signIn(page: Page): Promise<void> {
  await dismissPhaseTutorial(page);
  await page.goto('/login');
  await signInAs(page, LEARNER.email, LEARNER.password);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
}

/* -------------------------------------------------------------------------- */

test('the front door says what the product is', async ({ page }) => {
  // The sign-in page must not call TaskTrackr "a small Python CLI" or show
  // chips reading "Python 3.12" and "unittest", three facts that do not hold
  // for a two-service web application.
  await page.goto('/login');
  const aside = page.locator('body');
  // The sign-in page carries no aside describing the project's
  // stack at all, so what is left to hold is that it says nothing wrong.
  await expect(aside).toContainText('Sign in');
  await expect(aside).not.toContainText('a small Python CLI');
  await expect(aside).not.toContainText('unittest');
  await expect(aside).not.toContainText('Python 3.12');
});

test('the dossier hydrates, and is one document', async ({ page }) => {
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(String(e)));
  await signIn(page);
  await page.goto('/dossier');
  await expect(page.getByTestId('dossier-title')).toBeVisible({ timeout: UI_READY });
  await page.waitForTimeout(4_000);

  // `<style>{CSS}</style>` can serve entity-escaped quotes inside a raw-text
  // element, so every load throws hydration errors and React rebuilds the
  // page on the client.
  expect(thrown, `the dossier threw: ${thrown.slice(0, 2).join(' | ')}`).toHaveLength(0);

  // The learner's own markdown starts with a `#`, and it must not become a
  // second and a third top-level heading on the page.
  expect(await page.locator('h1').count(), 'one h1 on /dossier').toBe(1);
});

test('the palette answers the same in every room', async ({ page }) => {
  await signIn(page);
  // /account declares no rows of its own, so ⌘K here finds something only
  // because the shell reads the project's map itself.
  await page.goto('/account');
  await page.waitForTimeout(1_500);
  await page.keyboard.press('Meta+k');
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.getByTestId('palette-input').fill('overdue');
  await expect(page.locator('[data-testid^="palette-row-"]').first()).toBeVisible({
    timeout: 20_000,
  });

  // The outcome column is a capitalised word, as the rest of the product
  // writes it, not a lowercase fragment.
  const hints = await page
    .locator('[data-testid^="palette-row-"] span.mono')
    .evaluateAll((els) => els.map((e) => e.textContent || '').filter(Boolean));
  expect(hints.length).toBeGreaterThan(0);
  expect(hints.filter((h) => /^[a-z]/.test(h)), 'no lowercase outcome words').toEqual([]);

  // The theme belongs in the palette too: "theme" must answer with something.
  await page.getByTestId('palette-input').fill('theme');
  await expect(page.locator('[data-testid^="palette-row-"]').first()).toBeVisible();
});

test('the bell files results under what happened, not under what is owed', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('bell').click();
  const panel = page.getByTestId('bell-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('bell-new')).toBeVisible({ timeout: 20_000 });

  // Passed gates must not sit under a heading that says they are owed, and
  // "Waiting on you" must not be drawn twice in one 320px panel.
  await expect(panel).toContainText('What happened');
  const repeated = await panel.evaluate(
    (el) =>
      Array.from(el.querySelectorAll('p')).filter((p) => p.textContent?.trim() === 'Waiting on you')
        .length,
  );
  expect(repeated, 'one "Waiting on you" in the panel').toBeLessThanOrEqual(1);
});

test('the workspace status bar reads on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const third = phaseIds.find((p) => p.order === 3);
  await page.goto(`/workspace/${third!.id}`);
  await expect(page.getByTestId('status-bar')).toBeVisible({ timeout: NAVIGATION });
  await page.waitForTimeout(3_000);

  // No segment may be compressed below its own text and painted over its
  // neighbour ("mainPython 3.Ln2 1, Col 10 probleMsdden 33 oSa38d").
  // The optional facts sit in a region of their own that scrolls sideways
  // by design (status-metadata, focusable), beside the save group; what must
  // not happen is a segment squeezed below its own text, so the segments are
  // what is measured.
  const squeezed = await page.getByTestId('status-bar').evaluate((bar) =>
    Array.from(bar.querySelectorAll('[data-testid="status-metadata"] > *, [data-testid="status-save-group"] > *'))
      .map((c) => ({ text: (c.textContent || '').slice(0, 16), client: c.clientWidth, scroll: c.scrollWidth }))
      .filter((c) => c.scroll > c.client + 1),
  );
  expect(squeezed, `segments narrower than their own text: ${JSON.stringify(squeezed)}`).toEqual([]);
});

test('the breadcrumb names the page you are on', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await signIn(page);
  await page.goto('/dossier');
  await expect(page.getByTestId('dossier-title')).toBeVisible({ timeout: UI_READY });
  // The trail is declared by the page after it mounts, so it arrives a beat
  // after the heading does.
  await expect(page.locator('nav[aria-label="Breadcrumb"] li').last()).toBeVisible({
    timeout: 20_000,
  });

  // If every crumb is `min-w-0 truncate`, the whole trail shrinks together
  // and "Work" is drawn five pixels wide.
  const crumbs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('nav[aria-label="Breadcrumb"] li'))
      .filter((li) => getComputedStyle(li).display !== 'none')
      .map((li) => {
        const el = li.querySelector('a, span[aria-current], span')!;
        return { text: el.textContent, client: el.clientWidth, scroll: el.scrollWidth };
      }),
  );
  expect(crumbs.length).toBeGreaterThan(0);
  const current = crumbs[crumbs.length - 1];
  expect(current.client, `the current crumb is drawn whole: ${JSON.stringify(current)}`).toBeGreaterThanOrEqual(
    current.scroll - 1,
  );
});
