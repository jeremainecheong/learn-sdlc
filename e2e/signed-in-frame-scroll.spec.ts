import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { dismissPhaseTutorial, signInTo } from './pw-fixtures';
import { INSTRUCTOR, staffByApi, type StaffParty } from './passing-work';
import { API, RUN_ID } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * In a browser against the suite's stack: the signed-in frame does
 * not slide up when a page scrolls something into view.
 *
 * Pressing the project editor's section tabs scrolls a section into view
 * (EditorNav's `scrollIntoView({ block: 'start' })`). If the frame were a
 * scroll container, that scroll would move the frame itself: the top bar
 * would leave the window and a blank band would show at its foot. The frame
 * is `overflow: clip`, which is not a scroll container
 * (apps/web/test/signed-in-frame-overflow.test.ts pins the rule).
 *
 * A teacher copies the platform project (the copy-becomes-own spec's way),
 * opens the draft, and presses Overview, Validate and Publish in turn. After
 * each: the frame's scrollTop is 0, `.shell-page`'s scrollTop is 0, the top
 * bar is inside the window, and the section the tab names is inside the
 * window (it scrolled in a scroller inside the page instead).
 *
 * The frame's scrollTop cannot be anything but 0 once the frame is a clip
 * box, so the top bar's place carries that part. `.shell-page`, one level
 * down, is still `overflow: hidden`, which is a scroll container: a
 * scrollIntoView can still scroll it, which would cut off the top of the page
 * (not the top bar). Its scrollTop is read after every press so a slide there
 * fails this spec.
 *
 * No AI call.
 */

test.use({ viewport: { width: 1200, height: 875 } });

// A CI retry runs the test again with the same E2E_RUN_ID; the retry index
// keeps the slug new (as copy-becomes-own.spec.ts does).
let RUN = RUN_ID;
test.beforeEach(async ({}, testInfo) => {
  RUN = testInfo.retry ? `${RUN_ID}-r${testInfo.retry}` : RUN_ID;
});

/** A draft copy of the platform project, as copy-becomes-own.spec.ts makes one. */
async function draftCopy(request: APIRequestContext, staff: StaffParty) {
  const library = await (await request.get(`${API}/instructor/projects`, { headers: staff.headers })).json();
  const platform = library.library.find((one: { isDefault?: boolean }) => one.isDefault);
  expect(platform?.publishedVersionId, 'the platform project is published').toBeTruthy();
  const created = await request.post(`${API}/instructor/projects`, {
    headers: staff.headers,
    data: { title: `Frame scroll ${RUN}`, slug: `frame-scroll-${RUN}`, fromVersionId: platform.publishedVersionId },
  });
  expect(created.ok(), 'the copy is made').toBeTruthy();
  const { project, draftVersionId } = await created.json();
  return { projectId: project.id as string, versionId: draftVersionId as string };
}

/** The frame's and `.shell-page`'s scrollTop and the top bar's box, read in the page. */
const frameState = (page: Page) =>
  page.evaluate(() => {
    const frame = document.querySelector('.signed-in-frame') as HTMLElement | null;
    const shellPage = document.querySelector('.signed-in-frame .shell-page') as HTMLElement | null;
    const bar = document.querySelector('.signed-in-frame .shell-topbar') as HTMLElement | null;
    const box = bar?.getBoundingClientRect();
    return {
      frameFound: Boolean(frame),
      scrollTop: frame?.scrollTop ?? -1,
      pageFound: Boolean(shellPage),
      pageScrollTop: shellPage?.scrollTop ?? -1,
      barTop: box ? Math.round(box.top) : null,
      barBottom: box ? Math.round(box.bottom) : null,
    };
  });

test('the signed-in frame stays put while the project editor\'s section tabs scroll the page', async ({ page, request }) => {
  const staff = await staffByApi(request);
  const { projectId, versionId } = await draftCopy(request, staff);

  await dismissPhaseTutorial(page);
  await signInTo(page, INSTRUCTOR.email, INSTRUCTOR.password, `/teacher/projects/${projectId}/versions/${versionId}`);
  await expect(page.getByTestId('project-status')).toHaveText(/^Draft /, { timeout: NAVIGATION });
  const nav = page.getByTestId('editor-nav');
  await expect(nav).toBeVisible({ timeout: UI_READY });
  const bar = page.locator('.signed-in-frame .shell-topbar');
  await expect(bar).toBeVisible();
  expect(await frameState(page), 'the frame is at rest before any press').toMatchObject({ frameFound: true, scrollTop: 0, pageFound: true, pageScrollTop: 0, barTop: 0 });

  // The section tabs show one section at a time rather than scroll to it; the tab's own panel
  // must be in the window, and the frame must still not move.
  const presses = [
    { tab: 'project-section-overview', section: '[data-project-section="overview"]' },
    { tab: 'project-section-validate', section: '[data-project-section="validate"]' },
    { tab: 'project-section-publish', section: '[data-project-section="publish"]' },
    // and back up, which is where a frame scrolled by the press before shows it most
    { tab: 'project-section-overview', section: '#guide-export' },
  ];
  for (const { tab, section } of presses) {
    await page.getByTestId(tab).click();
    // The jump is instant (no smooth behaviour is asked for); the section is in view once it has happened.
    await expect(page.locator(section), `${tab}: its section is brought into the window`).toBeInViewport({ timeout: 10_000 });
    const state = await frameState(page);
    expect(state.scrollTop, `${tab}: the frame did not scroll`).toBe(0);
    expect(state.pageScrollTop, `${tab}: .shell-page did not scroll`).toBe(0);
    expect(state.barTop, `${tab}: the top bar starts at the top of the window`).toBe(0);
    expect(state.barBottom ?? 0, `${tab}: the top bar is drawn whole`).toBeGreaterThan(0);
    await expect(bar, `${tab}: the top bar is in the window`).toBeInViewport({ ratio: 1 });
  }
});
