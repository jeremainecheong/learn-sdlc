import { expect, test, type Page } from '@playwright/test';
import { dismissPhaseTutorial, openRequirements, registerAndSignIn, requirementsTab, signInAs, teacherHome } from './pw-fixtures';
import { createUnlockedEditor, signInEditorFixture } from './fixtures/unlocked-editor';
import { INSTRUCTOR, registerByApi } from './passing-work';
import { API } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * Small-screen regression guard.
 *
 * The rest of the suite runs at Playwright's 1280x720 default, so without
 * this file CI never renders the app below 1280px and the responsive work
 * (the workspace pane switcher, the stepping-down page titles, the scrolling
 * cohort table) has no guard and can silently rot.
 *
 * The core assertion is that the document never scrolls sideways. Horizontal
 * overflow is the single most common phone defect and it is cheap to detect:
 * anything genuinely wide (the cohort table, the file-tab strip) must scroll
 * inside its own container, not push the page.
 */
const PHONE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 568 };
/**
 * The two laptops the suite never rendered. Everything else runs at
 * Playwright's 1280x720 default, and 1024 is where the IDE's four fixed
 * columns stop fitting beside a full sidebar: 212 + 48 + 232 + 372 leaves the
 * editor 160px at 1024 and 416px at 1280.
 */
const LAPTOP = { width: 1024, height: 768 };
const DESK = { width: 1280, height: 800 };
/** What an editor needs before code, line numbers and inline notes stop fitting. */
const EDITOR_FLOOR = 420;

async function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}


/** Registers a fresh learner and returns the page signed in on the dashboard. */
async function signUp(page: Page): Promise<void> {
  // Register, sign in, finish setup (which starts the project).
  await registerAndSignIn(page, { name: 'Phone Learner', email: `phone-${Date.now()}@small.test` });
}

test.describe('small screens', () => {
  test('public pages never scroll sideways at 390px or 320px', async ({ page }) => {
    for (const size of [PHONE, NARROW]) {
      await page.setViewportSize(size);
      for (const path of ['/', '/login', '/register', '/privacy', '/terms']) {
        await page.goto(path);
        // The landing page animates in; settle before measuring.
        await page.waitForTimeout(400);
        expect(await overflow(page), `${path} at ${size.width}px`).toBe(0);
      }
    }
  });

  test('the workspace is usable on a phone via the pane switcher', async ({ page, request }) => {
    await dismissPhaseTutorial(page);
    await page.setViewportSize(PHONE);
    await signUp(page);

    expect(await overflow(page), 'dashboard at 390px').toBe(0);

    // A new learner's Requirements room is one page, the interview and the
    // backlog under two tabs, the mentor a panel, and it must fit a phone.
    await openRequirements(page);
    await expect(page.getByTestId('phase-title')).toBeVisible();
    expect(await overflow(page), 'Requirements room at 390px').toBe(0);
    await requirementsTab(page, 'My backlog');
    await expect(page.getByTestId('requirements-backlog-panel')).toBeVisible();
    expect(await overflow(page), 'backlog at 390px').toBe(0);
    await requirementsTab(page, 'Stakeholder interview');
    await expect(page.getByTestId('interview-page')).toBeVisible();

    // The IDE is the working room with an editor. Requirements has none,
    // so the room walked is Implementation, opened for a fresh learner by an
    // administrator as explicit setup (no pass is earned or asserted).
    const fixture = await createUnlockedEditor(request, 'phone');
    await page.context().clearCookies();
    await page.evaluate(() => { try { window.localStorage.removeItem('lsdlc_token'); } catch { /* ignore */ } });
    await signInEditorFixture(page, fixture);
    // The case file page (no door opens it; the rooms' Brief link
    // and old addresses do) must fit a phone too: its sections and its way
    // into the workspace, before the room itself.
    await page.goto(`/workspace/${fixture.phaseId}/brief`);
    await expect(page.getByTestId('brief')).toBeVisible({ timeout: UI_READY });
    await expect(page.getByTestId('go-to-workspace')).toBeVisible();
    expect(await overflow(page), 'brief at 390px').toBe(0);
    await page.goto(`/workspace/${fixture.phaseId}`);
    await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: UI_READY });
    expect(await overflow(page), 'workspace at 390px').toBe(0);

    // The editor is reachable, and Monaco actually mounts at this width.
    if (await page.getByTestId('pane-code').isVisible().catch(() => false)) await page.getByTestId('pane-code').click();
    await expect(page.getByTestId('editor-host')).toBeVisible();
    await page.waitForFunction(() => Boolean((window as any).monaco), null, { timeout: NAVIGATION });
    expect(await overflow(page), 'workspace code pane at 390px').toBe(0);

    // Document overflow alone does NOT catch the regression this guards
    // against: a fixed three-column grid squeezes the editor into a track with
    // no room left while the page still does not scroll sideways. Measuring
    // the editor itself is what detects that, so assert it fills the screen.
    // The navigation rail is drawn at every width (60px on a phone), so
    // "fills the screen" is measured against the width the rail leaves.
    const editorWidth = (await page.getByTestId('editor-host').boundingBox())?.width ?? 0;
    const rail = (await page.getByTestId('rail').boundingBox())?.width ?? 0;
    expect(editorWidth, `editor width at 390px beside a ${rail}px rail`).toBeGreaterThan((PHONE.width - rail) * 0.95);

    // And so is the mentor, one switch away, and back again: a real toggle.
    const panels = page.getByRole('group', { name: 'Workspace panels' });
    const showMentor = panels.getByRole('button', { name: 'Show mentor', exact: true });
    if (await showMentor.isVisible().catch(() => false)) await showMentor.click();
    await expect(page.getByTestId('mentor-chat')).toBeVisible();
    expect(await overflow(page), 'workspace mentor pane at 390px').toBe(0);
    await page.getByTestId('pane-code').click();
    await expect(page.getByTestId('editor-host')).toBeVisible();

    // One column, one name, no label drawn twice across
    // the visible tab rows.
    const rowLabels = await page
      .locator('[role="tab"]')
      .evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e.textContent ?? '').trim()));
    const repeated = rowLabels.filter((l, i) => l && rowLabels.indexOf(l) !== i);
    expect(repeated, 'no label appears in both tab rows').toEqual([]);
  });

  test('the account is reachable on a phone, from the sidebar', async ({ page }) => {
    await dismissPhaseTutorial(page);
    await page.setViewportSize(PHONE);
    await signUp(page);

    // Account settings are in the account menu under the learner's name,
    // which the top bar draws at every width.
    await page.getByTestId('nav-user').click();
    const account = page.getByTestId('nav-account');
    await expect(account).toBeVisible();
    await account.click();

    await page.waitForURL('**/account');
    await expect(page.locator('main h1').first()).toBeVisible();
    expect(await overflow(page), 'account at 390px').toBe(0);
  });

  test('the editor keeps a working width at 1024 and 1280 with the sidebar full', async ({
    page,
    request,
  }) => {
    await dismissPhaseTutorial(page);
    // The width is remembered per context, so a learner who widened the column
    // once inside the IDE meets these numbers on every visit afterwards. Seed
    // both keys: the boot script reads them before the first paint.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('lsdlc_sidebar', 'full');
        window.localStorage.setItem('lsdlc_sidebar_ide', 'full');
      } catch {
        // a browser without storage gets the defaults; the assertion still holds
      }
    });
    await page.setViewportSize(DESK);
    // Requirements has no editor; the IDE walked is Implementation, opened
    // for a fresh learner by an administrator as explicit setup.
    const fixture = await createUnlockedEditor(request, 'desk');
    await signInEditorFixture(page, fixture);
    await page.goto(`/workspace/${fixture.phaseId}`);
    await expect(page.getByTestId('editor-host')).toBeVisible({ timeout: NAVIGATION });

    for (const size of [DESK, LAPTOP]) {
      await page.setViewportSize(size);
      await page.mouse.move(size.width - 20, size.height - 20);
      // The sidebar really is the wide one: this is the case that was broken.
      await expect(page.getByTestId('sidebar')).toBeVisible();
      const width = (await page.getByTestId('editor-host').boundingBox())?.width ?? 0;
      expect(width, `editor width at ${size.width}px`).toBeGreaterThanOrEqual(EDITOR_FLOOR);
      expect(await overflow(page), `workspace at ${size.width}px`).toBe(0);
    }
  });

  test('the cohort table scrolls inside its card rather than the page', async ({ page, request }) => {
    // A class with a learner in it, so the teacher home draws its roster
    // table (it draws none for a teacher with no class).
    const staff = await request.post(`${API}/auth/login`, { data: { email: INSTRUCTOR.email, password: INSTRUCTOR.password } });
    expect(staff.ok(), 'the instructor signs in').toBeTruthy();
    const staffHeaders = { authorization: `Bearer ${(await staff.json()).token}` };
    const made = await request.post(`${API}/instructor/cohorts`, { headers: staffHeaders, data: { name: `E2E phone class ${Date.now()}` } });
    expect(made.ok(), 'the class is created').toBeTruthy();
    const madeClass = await made.json();
    const learner = await registerByApi(request, { email: `phone-roster-${Date.now()}@small.test`, password: 'Correct-Horse-9', name: 'Roster Learner' });
    expect((await request.post(`${API}/enrollments/join`, { headers: learner.headers, data: { code: madeClass.joinCode } })).ok(), 'the learner joins').toBeTruthy();

    await page.setViewportSize(PHONE);
    await signInAs(page, INSTRUCTOR.email, INSTRUCTOR.password);
    // The console is the teacher home (/instructor redirects to /teacher).
    await teacherHome(page);
    // The home's class cards fit the phone too.
    await expect(page.locator('li', { hasText: madeClass.name })).toBeVisible({ timeout: UI_READY });
    expect(await overflow(page), 'teacher home at 390px').toBe(0);
    // The roster table is the class's own page, opened from its card.
    await page.locator('li', { hasText: madeClass.name }).locator('a.exp-row').click();
    await page.waitForURL(/\/teacher\/class\?class=/, { timeout: NAVIGATION });
    await expect(page.locator('table.exp-table').first()).toBeVisible({ timeout: UI_READY });

    expect(await overflow(page), 'instructor console at 390px').toBe(0);

    // The table itself is wider than the phone, that is fine, so long as the
    // scrolling happens in its own container.
    const scrollsInside = await page.evaluate(() => {
      const table = document.querySelector('table.exp-table');
      const box = table?.parentElement;
      if (!box) return false;
      return box.scrollWidth > box.clientWidth
        ? getComputedStyle(box).overflowX !== 'visible'
        : true;
    });
    expect(scrollsInside).toBe(true);

    // The sign-out control must stay reachable, on 360px Android phones too,
    // where it can be clipped. Below `lg` the nav column is a strip under the
    // bar and eleven entries do not fit across a phone, so it scrolls, with the
    // edge that has more behind it faded. Reachable
    // therefore means "the strip carries it and scrolling brings it into
    // view", which is what a learner does with their thumb.
    // Sign-out lives in the account menu under the name, which the top bar
    // draws at every width.
    await page.getByTestId('nav-user').click();
    const logout = page.getByTestId('logout');
    await expect(logout).toBeVisible();
    await logout.scrollIntoViewIfNeeded();
    await expect(logout).toBeInViewport();
  });
});
