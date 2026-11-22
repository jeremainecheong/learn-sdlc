import { expect, test, type Page } from '@playwright/test';
import { dismissPhaseTutorial, openRequirements, registerAndSignIn, skipCoachMarks } from './pw-fixtures';
import { API } from './support/env';
import { UI_READY } from './support/timeouts';


/**
 * The first hour on a real screen.
 *
 * Two things a learner meets before they have written a line: the skip link,
 * which has to actually skip something, and the trail, which has to name the
 * project the learner is in.
 */

/** Registers a fresh learner and leaves the page on the dashboard. */
async function signUp(page: Page, name = 'First Hour'): Promise<void> {
  await skipCoachMarks(page);
  await dismissPhaseTutorial(page);
  await registerAndSignIn(page, {
    name,
    email: `first-hour-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@hour.test`,
  });
}

/** Where focus is: the id of the nearest main, or the active element's tag. */
async function focusHome(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return 'nothing';
    const main = el.closest('main');
    return main ? `main#${main.id}` : `${el.tagName.toLowerCase()}.${el.className}`;
  });
}

test('the skip link reaches the page on the dashboard and in the workspace', async ({ page }) => {
  await signUp(page);
  // Setup starts the project; the dashboard's one door opens its room.
  await openRequirements(page);
  await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: UI_READY });
  const workspace = page.url();

  // A fresh load each time, so the first Tab starts where a keyboard user's
  // does: at the top of the document. The dashboard names its project in a
  // line of its own (dashboard-project); it has no titled h1 test id.
  for (const [where, url, ready] of [
    ['the dashboard', '/dashboard', 'dashboard-project'],
    ['the workspace', workspace, 'phase-title'],
  ] as const) {
    await page.goto(url);
    await expect(page.getByTestId(ready)).toBeVisible({ timeout: UI_READY });

    // One Tab is the skip link, it is the first thing in the body, and Enter
    // has to put the caret inside the page, not scroll the page into view and
    // leave the caret in eighteen tab stops of chrome.
    await page.keyboard.press('Tab');
    await expect(page.locator('a', { hasText: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await focusHome(page), `focus after skipping on ${where}`).toBe('main#main');
  }
});

test('the trail names the project the learner is actually in', async ({ page }) => {
  await signUp(page, 'Trail Learner');
  // The title comes off the catalogue rather than out of this file, so a
  // hard-coded root is still visible rather than accidentally right: rename the
  // pack and this test moves with it, hard-code a root and it fails.
  // /projects is behind the JWT guard like every other route, so the catalogue
  // is read with the learner's own token rather than anonymously, an
  // unsigned fetch answers an error envelope and `[0]?.title` is undefined.
  const token = await page.evaluate(() => window.localStorage.getItem('lsdlc_token'));
  expect(token, 'the learner has a session').toBeTruthy();
  const catalogue = await (
    await fetch(`${API}/projects`, { headers: { authorization: `Bearer ${token}` } })
  ).json();
  const title = (catalogue as { title: string }[])[0]?.title;
  expect(title, 'the catalogue answers with a project').toBeTruthy();
  // The shell shortens a title at its em dash, everywhere it draws one
  // (`shortTitle`, `Sidebar.tsx` line 76), so the crumb is the pack's name and
  // not its tagline. Derived here rather than typed, for the same reason the
  // title itself is.
  const root = title.split('—')[0].trim();

  await openRequirements(page);
  await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: UI_READY });

  // The project's trail is drawn where the project's work is: /phases became
  // the record (/progress) and /map the full project map,
  // pages that name themselves first. So the trail is read in the working
  // room, on arrival and after a fresh load.
  const firstCrumb = page.locator('nav[aria-label="Breadcrumb"] li').first();
  await expect(firstCrumb, 'the first crumb in the room').toHaveText(root);
  await page.reload();
  await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: UI_READY });
  await expect(firstCrumb, 'the first crumb after a reload').toHaveText(root);
});
