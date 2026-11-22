import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEPLOYMENT_ARTEFACT, IMPLEMENTATION_ARTEFACT, TESTING_ARTEFACT } from './fixtures';
import { dismissPhaseTutorial, signInAs } from './pw-fixtures';
import { enrolByApi, markPassing, passPhaseByApi, PASSING_REQUIREMENTS, reachImplementationByApi, reachTestingByApi, registerByApi, settledSubmission, staffByApi, type ApiLearner, type ApiPhase } from './passing-work';
import { closeDrillByApi } from './record-forms';
import { API, RUN_ID, testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The work room at normal zoom.
 *
 * A learner must be able to work at 100 per cent without zooming out, so
 * little may stand above the room's panes. These cases measure
 * the room as drawn, at three desktop sizes, at device scale 1 and at 125 per
 * cent zoom (a 0.8 viewport at device scale 1.25, which is what the browser's
 * zoom does to CSS pixels), on two rooms:
 *
 * - a **passed Testing phase** (reviewed pass, Continue open): the pane tab
 *   strip starts high, Continue is on screen, and "View review" puts the
 *   verdict and its first criterion on screen in one press;
 * - an **in-progress Implementation phase**: the one primary action (Submit)
 *   is on screen, and the header row holds the phase's name, its place, the
 *   chip, Run tests, Run app, More and Submit on one 55 px line, with the
 *   sidebar collapsed and pinned open; under 1280 px (1093 and 1152 at 125
 *   per cent) the optional quick check takes a row of its own under it, and
 *   nothing on the strip overlaps, even with the longest state chip.
 *
 * The room is focused exactly when its pane area is under 520 px (at 768 px of
 * window that depends on the band and the zoom), and at 768 px the editor
 * keeps at least 240 px either way.
 *
 * Every page here is read without horizontal scroll.
 */

const SIZES = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;
const ZOOMS = [
  { label: '100 per cent', scale: 1 },
  { label: '125 per cent', scale: 1.25 },
] as const;

/** The share of the window above a one-board room's work, at most (the top third). */
const WORK_SHARE_MOST = 1 / 3;

const stamp = `${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`;
let tester: { learner: ApiLearner; phaseId: string; implementationId: string } | null = null;
let builder: { learner: ApiLearner; phaseId: string } | null = null;

/** A learner whose Testing phase passed its review and has not continued. */
async function passedTesting(request: APIRequestContext) {
  if (tester) return tester;
  const reached = await reachTestingByApi(request, {
    email: testEmail(`e2e-viewport-testing-${stamp}`),
    password: 'Correct-Horse-9',
    name: 'Vera Viewport',
  });
  const { learner, phaseId } = reached;
  const implementationId = reached.phases.find((p) => p.order === 3)!.id;
  const saved = await request.put(`${API}/phases/${phaseId}/workspace`, {
    headers: learner.headers,
    data: { files: markPassing(TESTING_ARTEFACT) },
  });
  expect(saved.ok(), 'the tests save').toBeTruthy();
  const started = await request.post(`${API}/phases/${phaseId}/submit`, { headers: learner.headers, data: {} });
  expect(started.ok(), 'the tests are submitted').toBeTruthy();
  const done = await settledSubmission(request, learner, (await started.json()).id, 240_000);
  expect(done?.passed, 'the Testing review passes').toBe(true);
  tester = { learner, phaseId, implementationId };
  return tester;
}

/** A learner standing on Implementation with nothing handed in. */
async function openImplementation(request: APIRequestContext) {
  if (builder) return builder;
  const reached = await reachImplementationByApi(request, {
    email: testEmail(`e2e-viewport-build-${stamp}`),
    password: 'Correct-Horse-9',
    name: 'Ivo Viewport',
  });
  builder = { learner: reached.learner, phaseId: reached.phaseId };
  return builder;
}

async function openRoom(page: Page, who: ApiLearner, phaseId: string): Promise<void> {
  await dismissPhaseTutorial(page);
  // The quick check offers itself on entry; it is one line and part of
  // what is measured, so it is left where it is.
  await signInAs(page, who.email, who.password);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
  await page.goto(`/workspace/${phaseId}`);
  await expect(page.getByTestId('phase-strip')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId('editor-host')).toBeVisible({ timeout: NAVIGATION });
}

/** The page's own measurements, in CSS pixels. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const top = (selector: string) => {
      const node = document.querySelector(selector);
      return node ? node.getBoundingClientRect().top : null;
    };
    const tabStrip = document.querySelector('[aria-label="Phase working area"], [aria-label="Implementation working area"]');
    const editor = document.querySelector('[data-testid="editor-host"]');
    const area = document.querySelector('.phase-lab-workspace');
    const strip = document.querySelector('[data-testid="phase-strip"]')?.getBoundingClientRect();
    const band = document.querySelector('[data-testid="gate-banner"], [data-testid="review-band"]')?.getBoundingClientRect();
    return {
      appTop: top('.signed-in-frame') ?? 0,
      tabStripTop: tabStrip ? tabStrip.getBoundingClientRect().top : null,
      editorHeight: editor ? editor.getBoundingClientRect().height : 0,
      areaHeight: area ? area.getBoundingClientRect().height : 0,
      focused: area?.getAttribute('data-focused') === 'true',
      stripHeight: strip?.height ?? 0,
      bandHeight: band?.height ?? 0,
      horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

async function inViewport(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight && box.left >= 0 && box.right <= window.innerWidth;
  });
}

for (const zoom of ZOOMS) {
  for (const size of SIZES) {
    const viewport = { width: Math.round(size.width / zoom.scale), height: Math.round(size.height / zoom.scale) };
    test.describe(`${size.width} by ${size.height} at ${zoom.label}`, () => {
      test.use({ viewport, deviceScaleFactor: zoom.scale });

      test('a passed Testing room: one row of header, one slim band, and the review in one press', async ({ page, request }) => {
        test.setTimeout(600_000);
        const { learner, phaseId } = await passedTesting(request);
        await openRoom(page, learner, phaseId);
        await expect(page.getByTestId('gate-banner')).toBeVisible();
        await expect(page.getByTestId('phase-state')).toHaveText('Review passed');
        await expect(page.getByTestId('phase-place')).toHaveText(/^Phase \d of \d$/);

        const before = await measure(page);
        test.info().annotations.push({
          type: 'band',
          description: `${viewport.width}x${viewport.height}: header ${before.stripHeight}px, band ${before.bandHeight}px, tab strip at ${before.tabStripTop}px, area ${before.areaHeight}px`,
        });
        expect(before.horizontalScroll, 'no horizontal scroll').toBe(false);
        if (size.width === 1440 && zoom.scale === 1) {
          expect(before.tabStripTop! - before.appTop, 'the pane tab strip starts within 190 px of the app top').toBeLessThanOrEqual(190);
        }
        // Continue is the band's, and it is on screen.
        expect(await inViewport(page, '[data-testid="open-reflection"]'), 'Continue is in the viewport').toBe(true);
        // The header repeats no primary action while the band carries Continue.
        await expect(page.locator('[data-testid="phase-strip"] .phase-strip-primary [data-testid="header-submit"]')).toHaveCount(0);

        // The focused mode follows the pane area's own height (under 520 px),
        // which at 768 px of window depends on the band and the zoom.
        expect(before.focused, 'focused exactly when the pane area is under 520 px').toBe(before.areaHeight < 520);
        if (size.height === 768) expect(before.editorHeight, 'the editor keeps 240 px').toBeGreaterThanOrEqual(240);

        await page.getByTestId('gate-view-review').click();
        await expect(page.getByTestId('tab-feedback')).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByTestId('feedback-verdict')).toBeVisible({ timeout: UI_READY });
        expect(await inViewport(page, '[data-testid="feedback-verdict"]'), 'the verdict is in the viewport').toBe(true);
        const firstCriterion = page.locator('[data-testid="feedback-report"] table tbody tr').first();
        await expect(firstCriterion).toBeVisible();
        expect(
          await firstCriterion.evaluate((node) => node.getBoundingClientRect().bottom <= window.innerHeight),
          'the first criterion row is in the viewport',
        ).toBe(true);
        expect((await measure(page)).horizontalScroll, 'no horizontal scroll after View review').toBe(false);

        // M7: the review's scroll position survives a look at the code. The
        // switch hides the results by display:none, where Chromium keeps no
        // offset; the room puts it back (useScrollKeeper).
        const scrolled = await page.locator('[data-testid="feedback-report"]').evaluate((report) => {
          for (let node: Element | null = report; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight - node.clientHeight > 40) {
              node.setAttribute('data-e2e-scroller', '');
              node.scrollTop = Math.min(160, node.scrollHeight - node.clientHeight);
              return node.scrollTop;
            }
          }
          return 0;
        });
        if (scrolled > 0) {
          await page.waitForTimeout(150);
          const toCode = page.getByTestId('focus-show-code');
          if (await toCode.isVisible().catch(() => false)) await toCode.click();
          else await page.locator('[aria-label="Phase working area"] > button').first().click();
          await page.waitForTimeout(150);
          await page.getByTestId('gate-view-review').click();
          await expect(page.getByTestId('feedback-verdict')).toBeVisible();
          await expect
            .poll(() => page.locator('[data-e2e-scroller]').evaluate((node) => node.scrollTop), { message: 'the review is where the learner left it' })
            .toBeGreaterThanOrEqual(scrolled - 1);
        } else {
          test.info().annotations.push({ type: 'scroll', description: `${viewport.width}x${viewport.height}: the review fits; nothing to scroll` });
        }
      });

      test('an in-progress Implementation room: its one primary action is on screen', async ({ page, request }) => {
        test.setTimeout(600_000);
        const { learner, phaseId } = await openImplementation(request);
        await openRoom(page, learner, phaseId);
        await expect(page.getByTestId('phase-state')).toHaveText('In progress');
        const primary = page.locator('[data-testid="phase-strip"] .phase-strip-primary [data-testid="header-submit"]');
        await expect(primary).toHaveCount(1);
        expect(await inViewport(page, '[data-testid="phase-strip"] .phase-strip-primary [data-testid="header-submit"]'), 'Submit is in the viewport').toBe(true);

        // Run tests and Run app sit on the row beside the primary, never in the
        // menu (the demo presses Run app as a headline beat), and the row holds
        // all of it on one 55 px line: nothing wraps under it or runs past it.
        await expect(page.locator('[data-testid="phase-strip"] .phase-header-secondary [data-testid="header-run"]')).toBeVisible();
        await expect(page.locator('[data-testid="phase-more"] [data-testid="header-run-app"]')).toHaveCount(0);
        const runApp = page.locator('[data-testid="phase-strip"] .phase-header-secondary [data-testid="header-run-app"]');
        if (!(await runApp.count())) {
          // Run app is drawn only where the host can run the preview; the
          // phase's own detail says so, and nothing else excuses its absence.
          const detail = await (await request.get(`${API}/phases/${phaseId}`, { headers: learner.headers })).json();
          expect(detail.previewUnsupported, 'Run app is missing on a host that can run the preview').toBe('isolation');
        } else {
          await expect(runApp).toBeVisible();
        }
        // The header row holds all of it on one 55 px line wherever it fits.
        // Where it does not (1366 and 1440 at 125 per cent are 1093 and 1152
        // CSS px; the sidebar pinned open), it wraps to a second line rather
        // than let anything overlap. Either way no two things
        // on the strip overlap, the quick check's buttons never sit on Run
        // tests, Run app, More or Submit, nothing runs past the strip, and the
        // strip does not scroll. The same is read again with the longest state
        // chip the row can carry ("Credit awarded, review still needed", which
        // the fixer's stylesheet harness found pushing the quick check's
        // buttons over Run tests at those widths), written into the chip in
        // place, and again with the sidebar pinned open.
        const readRow = () => page.getByTestId('phase-strip').evaluate((strip) => {
          const box = strip.getBoundingClientRect();
          const kids = [...strip.children]
            .map((child) => ({ name: String(child.getAttribute('data-testid') ?? child.className), at: child.getBoundingClientRect(), quick: child.matches('.quick-check-line-inline') }))
            .filter(({ at }) => at.width > 0 && at.height > 0);
          const quick = kids.find((kid) => kid.quick) ?? null;
          const stray = kids
            .filter(({ at }) => at.top < box.top - 0.5 || at.bottom > box.bottom + 0.5 || at.right > box.right + 0.5 || at.left < box.left - 0.5)
            .map(({ name }) => name);
          // Only real boxes count: the spacer is empty and the details panel is closed.
          const solid = kids.filter((kid) => !kid.name.includes('phase-strip-spacer'));
          const overlaps: string[] = [];
          for (let i = 0; i < solid.length; i += 1) {
            for (let j = i + 1; j < solid.length; j += 1) {
              const a = solid[i].at, b = solid[j].at;
              const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (x > 0.5 && y > 0.5) overlaps.push(`${solid[i].name} / ${solid[j].name}`);
            }
          }
          // The quick check's own buttons against the row's Run tests, Run app and primary.
          const quickButtons = [...strip.querySelectorAll('.quick-check-line-inline .quick-check-actions > *')].map((node) => node.getBoundingClientRect());
          const rowButtons = [...strip.querySelectorAll('.phase-header-secondary > *, .phase-strip-primary > *, .phase-strip-details > summary')].map((node) => node.getBoundingClientRect());
          for (const a of quickButtons) for (const b of rowButtons) {
            const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (x > 0.5 && y > 0.5) overlaps.push('a quick-check button / a row button');
          }
          return {
            height: box.height,
            quick: quick ? (quick.at.top - box.top < 30 ? 'on the first line' : 'on the second line') : 'not offered',
            stray,
            overlaps,
            scrolls: strip.scrollWidth > strip.clientWidth + 1,
          };
        });
        const checkRow = (row: Awaited<ReturnType<typeof readRow>>, label: string, oneLine: boolean) => {
          test.info().annotations.push({ type: 'row', description: `${viewport.width}x${viewport.height} ${label}: header ${row.height}px, quick check ${row.quick}` });
          if (oneLine) expect(row.height, `${label}: the header row is one 55 px line`).toBeLessThanOrEqual(56);
          else expect(row.height, `${label}: the header wraps to two lines at most`).toBeLessThanOrEqual(120);
          expect(row.stray, `${label}: nothing on the header runs past it`).toEqual([]);
          expect(row.overlaps, `${label}: nothing on the header overlaps`).toEqual([]);
          expect(row.scrolls, `${label}: the header does not overflow`).toBe(false);
        };
        // "Phase n of 6" shows under 1280 px, except from 1024 to 1151 px,
        // where it would push Submit to a second line and take 32 px from the
        // editor (1093 px is 1366 at 125 per cent): there it stays hidden. So
        // "In progress" is one line at every width this case runs at.
        checkRow(await readRow(), 'in progress', true);
        await page.getByTestId('phase-state').evaluate((chip) => { chip.textContent = 'Credit awarded, review still needed'; });
        checkRow(await readRow(), 'longest chip', viewport.width >= 1280);
        // The same with the sidebar pinned open (232 px instead of 76), the
        // learner's own setting, read after a reload as the boot script draws it.
        await page.evaluate(() => window.localStorage.setItem('lsdlc_sidebar_ide', 'full'));
        await page.reload();
        await expect(page.getByTestId('editor-host')).toBeVisible({ timeout: NAVIGATION });
        await expect(page.getByTestId('phase-state')).toHaveText('In progress');
        const pinned = await page.evaluate(() => document.documentElement.getAttribute('data-sidebar'));
        expect(pinned, 'the sidebar is pinned open').toBe('full');
        checkRow(await readRow(), 'pinned, in progress', viewport.width >= 1440);
        await page.getByTestId('phase-state').evaluate((chip) => { chip.textContent = 'Credit awarded, review still needed'; });
        checkRow(await readRow(), 'pinned, longest chip', false);
        await page.evaluate(() => window.localStorage.removeItem('lsdlc_sidebar_ide'));
        await page.reload();
        await expect(page.getByTestId('editor-host')).toBeVisible({ timeout: NAVIGATION });
        const now = await measure(page);
        expect(now.horizontalScroll, 'no horizontal scroll').toBe(false);
        expect(now.focused, 'focused exactly when the pane area is under 520 px').toBe(now.areaHeight < 520);
        if (size.height === 768) expect(now.editorHeight, 'the editor keeps 240 px').toBeGreaterThanOrEqual(240);
      });
    });
  }
}

/* ------------------------------------------------------------------------ */
/* The passed Implementation room at 200 per cent, and the one-board    */
/* rooms (Requirements, Design) at normal zoom.                              */
/* ------------------------------------------------------------------------ */

/** Every pair of the header's own boxes that overlap, and anything that runs past it. */
async function headerOverlaps(page: Page) {
  return page.getByTestId('phase-strip').evaluate((strip) => {
    const box = strip.getBoundingClientRect();
    const kids = [...strip.children]
      .map((child) => ({ name: String(child.getAttribute('data-testid') ?? child.className), at: child.getBoundingClientRect() }))
      .filter(({ at, name }) => at.width > 0 && at.height > 0 && !name.includes('phase-strip-spacer'));
    const overlaps: string[] = [];
    for (let i = 0; i < kids.length; i += 1) {
      for (let j = i + 1; j < kids.length; j += 1) {
        const a = kids[i].at, b = kids[j].at;
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > 0.5 && y > 0.5) overlaps.push(`${kids[i].name} / ${kids[j].name}`);
      }
    }
    const stray = kids
      .filter(({ at }) => at.top < box.top - 0.5 || at.bottom > box.bottom + 0.5 || at.right > box.right + 0.5 || at.left < box.left - 0.5)
      .map(({ name }) => name);
    return { height: box.height, overlaps, stray, scrolls: strip.scrollWidth > strip.clientWidth + 1 };
  });
}

/*
 * At 200 per cent zoom of a 1920 by 1054 window (960 by 527 CSS px) and at
 * 125 per cent of a 1440 by 790 window (1152 by 632), in a passed
 * Implementation room with Review selected: no two header controls
 * overlap, the place is on screen, and the review's verdict and its last
 * criterion row are each brought fully on screen, uncovered, by scrolling.
 */
for (const short of [
  { width: 960, height: 527, scale: 2, label: '200 per cent of 1920 by 1054' },
  { width: 1152, height: 632, scale: 1.25, label: '125 per cent of 1440 by 790' },
] as const) {
  test.describe(`${short.width} by ${short.height} (${short.label})`, () => {
    test.use({ viewport: { width: short.width, height: short.height }, deviceScaleFactor: short.scale });

    test('a passed Implementation room with Review selected: a header without overlap, its place, and the review by scrolling', async ({ page, request }) => {
      test.setTimeout(600_000);
      const { learner, implementationId } = await passedTesting(request);
      await dismissPhaseTutorial(page);
      await signInAs(page, learner.email, learner.password);
      await page.waitForURL('**/dashboard', { timeout: UI_READY });
      await page.goto(`/workspace/${implementationId}`);
      await expect(page.getByTestId('phase-strip')).toBeVisible({ timeout: NAVIGATION });
      await page.getByTestId('gate-view-review').click();
      await expect(page.getByTestId('feedback-verdict')).toBeAttached({ timeout: UI_READY });

      const row = await headerOverlaps(page);
      test.info().annotations.push({ type: 'cx-30', description: `${short.width}x${short.height}: header ${row.height}px, overlaps ${JSON.stringify(row.overlaps)}` });
      expect(row.overlaps, 'nothing on the header overlaps').toEqual([]);
      expect(row.stray, 'nothing on the header runs past it').toEqual([]);
      expect(row.scrolls, 'the header does not overflow').toBe(false);
      await expect(page.getByTestId('phase-place')).toBeVisible();
      await expect(page.getByTestId('phase-place')).toHaveText(/^Phase \d of \d$/);
      expect(await inViewport(page, '[data-testid="phase-place"]'), 'the place is in the viewport').toBe(true);

      // Scrolled the way a learner scrolls: the mouse wheel over the review,
      // which scrolls the review and then whatever holds it. A box the page
      // clips without a scrollbar is never moved, so content only a script
      // could scroll to does not count as reachable.
      const onScreen = (target: ReturnType<Page['locator']>) => target.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(box.height / 2, 10));
        // What of it every box that clips it, and the window, leave showing.
        let top = Math.max(box.top, 0);
        let bottom = Math.min(box.bottom, window.innerHeight);
        for (let up = node.parentElement; up; up = up.parentElement) {
          if (getComputedStyle(up).overflowY === 'visible') continue;
          const clip = up.getBoundingClientRect();
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
        return {
          top: box.top,
          shown: box.height > 0 ? Math.max(0, bottom - top) / box.height : 0,
          // A pixel of slack for sub-pixel layout at device scale 1.25 and 2.
          inside: box.height > 0 && box.top >= -1 && box.bottom <= window.innerHeight + 1 && box.left >= -1 && box.right <= window.innerWidth + 1,
          uncovered: Boolean(hit && (hit === node || node.contains(hit))),
        };
      });
      const overReview = () => page.getByTestId('feedback-report').evaluate((node) => {
        const box = node.getBoundingClientRect();
        const top = Math.max(box.top, 0), bottom = Math.min(box.bottom, window.innerHeight);
        const left = Math.max(box.left, 0), right = Math.min(box.right, window.innerWidth);
        return bottom - top > 4 && right - left > 4 ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
      });
      for (const [selector, what] of [
        ['[data-testid="feedback-verdict"]', 'the verdict'],
        ['[data-testid="feedback-report"] table tbody tr >> nth=-1', 'the last criterion row'],
      ] as const) {
        const target = page.locator(selector).first();
        await expect(target).toBeAttached();
        let placed = await onScreen(target);
        for (let turn = 0; turn < 40 && !(placed.inside && placed.uncovered && placed.shown >= 0.98); turn += 1) {
          const at = await overReview();
          expect(at, `some of the review is on screen to scroll from (${what})`).not.toBeNull();
          await page.mouse.move(at!.x, at!.y);
          await page.mouse.wheel(0, placed.top < 0 ? -45 : 45);
          await page.waitForTimeout(60);
          placed = await onScreen(target);
        }
        expect(placed.inside, `${what} is brought fully on screen by scrolling`).toBe(true);
        expect(placed.uncovered, `${what} is not covered once scrolled to`).toBe(true);
        // ...and no scrolling box between it and the window cuts it off.
        await expect(target, `${what} is not clipped by a scrolling box once scrolled to`).toBeInViewport({ ratio: 0.95 });
      }
      expect((await measure(page)).horizontalScroll, 'no horizontal scroll').toBe(false);
    });
  });
}

/** The quiz each split room carries beside its board, by room. */
const SPLIT_QUIZ = { requirements: 'viewport-story-concepts', design: 'viewport-design-concepts' } as const;
let splitter: { learner: ApiLearner; requirementsId: string; designId: string } | null = null;

/**
 * A learner in a class whose project a teacher split: a copy of the platform
 * project with an optional quiz beside the Requirements story and beside the
 * Design board (as the demo's "Story concepts"), so each room draws its task
 * row and its "Start this task over". Design is opened by the teacher's
 * reopen lever; no Pass is seeded.
 */
async function splitRooms(request: APIRequestContext) {
  if (splitter) return splitter;
  const staff = await staffByApi(request);
  const ok = async (res: Awaited<ReturnType<APIRequestContext['get']>>, what: string) => {
    expect(res.ok(), `${what}: ${res.status()}`).toBeTruthy();
    return res.json();
  };
  const library = await ok(await request.get(`${API}/instructor/projects`, { headers: staff.headers }), 'the library reads');
  const platform = library.library.find((one: { isDefault: boolean }) => one.isDefault);
  const cohort = await ok(await request.post(`${API}/instructor/cohorts`, { headers: staff.headers, data: { name: `Viewport split ${stamp}` } }), 'the class is made');
  const made = await ok(
    await request.post(`${API}/instructor/projects`, {
      headers: staff.headers,
      data: { title: 'Viewport Split', slug: `viewport-split-${stamp}`.toLowerCase().slice(0, 40), fromVersionId: platform.publishedVersionId },
    }),
    'the copy is made',
  );
  const at = `${API}/instructor/projects/${made.project.id}/versions/${made.draftVersionId}`;
  for (const [phase, taskKey, title] of [
    ['requirements', SPLIT_QUIZ.requirements, 'Story concepts'],
    ['design', SPLIT_QUIZ.design, 'Design concepts'],
  ] as const) {
    await ok(
      await request.post(`${at}/phases/${phase}/tasks`, {
        headers: staff.headers,
        data: {
          taskKey,
          title,
          brief: 'Optional practice quiz.',
          artefactType: 'quiz',
          required: false,
          quiz: {
            questions: Array.from({ length: 6 }, (_, i) => ({
              id: `${phase[0]}${i + 1}`,
              stem: `Viewport question ${i + 1}. Option A is keyed.`,
              options: [{ id: 'a', text: 'Option A, keyed.' }, { id: 'b', text: 'Option B, the other.' }],
              correct: ['a'],
              explanation: `Viewport explanation ${i + 1}.`,
            })),
            shuffleOptions: true,
            passMark: 80,
            attempts: { max: null, cooldownSeconds: null },
            criterion: 'concepts',
          },
        },
      }),
      `the ${phase} quiz is added`,
    );
  }
  const published = await ok(await request.post(`${at}/publish`, { headers: staff.headers, data: { version: '1.0.0', notes: 'Viewport split.' } }), 'published');
  await ok(
    await request.put(`${API}/instructor/cohorts/${cohort.id}/project`, { headers: staff.headers, data: { projectVersionId: published.versionId, reason: 'Viewport split class.' } }),
    'the class takes the copy',
  );
  const learner = await registerByApi(request, { email: testEmail(`e2e-viewport-split-${stamp}`), password: 'Correct-Horse-9', name: 'Sol Split' });
  await ok(await request.post(`${API}/enrollments/join`, { headers: learner.headers, data: { code: cohort.joinCode } }), 'the learner joins');
  const board = await ok(await request.post(`${API}/enrollments`, { headers: learner.headers, data: {} }), 'the learner starts');
  const id = (key: string) => board.phases.find((one: { key: string }) => one.key === key).id as string;
  await ok(
    await request.post(`${API}/instructor/learners/${learner.userId}/phases/${id('design')}/override`, {
      headers: staff.headers,
      data: { action: 'reopen', reason: 'Viewport fixture: Design opened for rendering only.' },
    }),
    'Design opens',
  );
  splitter = { learner, requirementsId: id('requirements'), designId: id('design') };
  return splitter;
}

/** Tab forward until `testId` holds the focus; how many presses it took, or null. */
async function tabTo(page: Page, testId: string, most = 25): Promise<number | null> {
  for (let presses = 1; presses <= most; presses += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((id) => document.activeElement?.getAttribute('data-testid') === id, testId)) return presses;
  }
  return null;
}

/*
 * A split phase folds its task list into one row and keeps the reset and
 * Replay tutorial in the header's More, so a one-board room's work is not
 * pushed down the window. Measured here in a split Requirements room and a
 * split Design room: the work starts in the top third of the window, and the
 * sibling task's door, Start this task over and Replay tutorial are each one
 * press away, by keyboard as well: Enter on the folded row or on More, then
 * Tab to it.
 */
for (const size of [
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
] as const) {
  test.describe(`${size.width} by ${size.height}, a split one-board room`, () => {
    test.use({ viewport: size, deviceScaleFactor: 1 });

    for (const room of [
      { name: 'Requirements', key: 'requirements', path: '/issue', ready: 'requirements-backlog-panel', work: '.requirements-workspace-room' },
      { name: 'Design', key: 'design', path: '/design', ready: 'phase-design-editor', work: '[data-testid="phase-design-editor"]' },
    ] as const) {
      test(`the ${room.name} room gives the height to the work, and what it folded is one press away`, async ({ page, request }) => {
        test.setTimeout(600_000);
        const split = await splitRooms(request);
        await dismissPhaseTutorial(page);
        await signInAs(page, split.learner.email, split.learner.password);
        await page.waitForURL('**/dashboard', { timeout: UI_READY });
        await page.goto(`/workspace/${room.key === 'requirements' ? split.requirementsId : split.designId}${room.path}`);
        await expect(page.getByTestId(room.ready)).toBeVisible({ timeout: NAVIGATION });
        await expect(page.getByTestId('task-switcher-toggle')).toBeVisible();
        await expect(page.getByTestId('phase-place')).toHaveText(/^Phase \d of \d$/);
        await expect(page.getByTestId('phase-state')).toBeVisible();

        const above = await page.locator(room.work).first().evaluate((node) => ({ top: node.getBoundingClientRect().top, height: window.innerHeight }));
        const share = above.top / above.height;
        test.info().annotations.push({
          type: 'cx-27',
          description: `${room.name} ${size.width}x${size.height}: the work starts at ${Math.round(above.top)} px of ${above.height} (${(share * 100).toFixed(1)} per cent)`,
        });
        expect(share, 'the work starts in the top third of the window').toBeLessThanOrEqual(WORK_SHARE_MOST);
        expect((await measure(page)).horizontalScroll, 'no horizontal scroll').toBe(false);

        // Folded: the sibling's door, the reset and the replay are not on screen.
        const door = page.getByTestId(`task-open-${SPLIT_QUIZ[room.key]}`);
        await expect(door).toBeHidden();
        await expect(page.getByTestId('task-reset-open')).toBeHidden();
        await expect(page.locator('[data-testid="phase-strip"] [data-testid="phase-tutorial-replay"]')).toBeHidden();

        // The task list: Enter on its row, then Tab to the sibling's door.
        await page.getByTestId('task-switcher-toggle').focus();
        await page.keyboard.press('Enter');
        await expect(door).toBeVisible();
        expect(await tabTo(page, `task-open-${SPLIT_QUIZ[room.key]}`), 'the sibling task\'s door is reached by Tab').not.toBeNull();
        await page.getByTestId('task-switcher-toggle').focus();
        await page.keyboard.press('Enter');
        await expect(door).toBeHidden();

        // More: Enter on it, then Tab to Replay tutorial and to Start this task over.
        for (const inside of ['phase-tutorial-replay', 'task-reset-open']) {
          await page.getByTestId('phase-more-toggle').focus();
          await page.keyboard.press('Enter');
          await expect(page.locator(`[data-testid="phase-strip"] [data-testid="${inside}"]`)).toBeVisible();
          expect(await tabTo(page, inside), `${inside} is reached by Tab inside More`).not.toBeNull();
          await page.keyboard.press('Escape');
          await expect(page.locator(`[data-testid="phase-strip"] [data-testid="${inside}"]`)).toBeHidden();
          await expect(page.getByTestId('phase-more-toggle')).toBeFocused();
        }
      });
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Short and narrow windows keep the work's height.                        */
/* ------------------------------------------------------------------------ */

/*
 * At 200 per cent zoom on a 1920 by 1080 window (960 by 470 to 540 CSS px)
 * everything a room stacks above its editor (the top bar, the header, the
 * ready band, the pane switcher, the view and file tabs) must still leave
 * room to work.
 *
 * In Implementation and Deployment, in progress and with the review
 * passed (Continue not yet pressed), with the panels closed (a new learner's
 * default under 1024 px) and open (a preference kept from a wider window):
 * at 960 by 540 and 960 by 470 at least eight editor lines are on screen
 * without scrolling and the primary action (Submit, or the band's Continue)
 * is on screen; at 1152 by 648 (1440 by 810 at 125 per cent) at least twelve.
 * The phase's place and state stay on the header, and the optional quick
 * check, where offered, is in More rather than on the row.
 */
const EDITOR_LINE = 21; // CodeEditor's lineHeight at the default editor font
const SHORT_SIZES = [
  { width: 960, height: 540, lines: 8 },
  { width: 960, height: 470, lines: 8 },
  { width: 1152, height: 648, lines: 12 },
] as const;

/** The editor's height on screen with the page unscrolled, clipped by every box that clips it. */
async function editorOnScreen(page: Page): Promise<number> {
  return page.getByTestId('editor-host').evaluate((node) => {
    const box = node.getBoundingClientRect();
    let top = Math.max(box.top, 0);
    let bottom = Math.min(box.bottom, window.innerHeight);
    for (let up = node.parentElement; up; up = up.parentElement) {
      if (getComputedStyle(up).overflowY === 'visible') continue;
      const clip = up.getBoundingClientRect();
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
    return Math.max(0, bottom - top);
  });
}

/** Opens the room unscrolled with the panels closed or open, on its code view. */
async function openShort(page: Page, phaseId: string, panels: 'closed' | 'open') {
  await page.evaluate((open) => {
    const token = window.localStorage.getItem('lsdlc_token')!;
    const id = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub;
    const key = `lsdlc_workspace_panels:${id}`;
    if (open) window.localStorage.setItem(key, JSON.stringify({ version: 1, briefOpen: true, mentorOpen: true }));
    else window.localStorage.removeItem(key);
  }, panels === 'open');
  await page.goto(`/workspace/${phaseId}`);
  await expect(page.getByTestId('phase-strip')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId('editor-host')).toBeAttached({ timeout: NAVIGATION });
  // Deployment opens on its Pipeline view; the editor is what is measured.
  const configuration = page.locator('[aria-label="Phase working area"] > button').first();
  if (!(await page.getByTestId('editor-host').isVisible()) && (await configuration.count())) await configuration.click();
  await expect(page.getByTestId('editor-host')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.locator('.monaco-editor .view-line').first()).toBeVisible({ timeout: NAVIGATION });
  // The quick check's offer arrives after the room; give it its moment.
  await page.waitForTimeout(1500);
}

async function checkShortRoom(page: Page, label: string, phaseId: string, passed: boolean) {
  for (const size of SHORT_SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const panels of ['closed', 'open'] as const) {
      await openShort(page, phaseId, panels);
      const at = `${label}, ${size.width} by ${size.height}, panels ${panels}`;
      await expect(page.getByTestId('phase-state'), at).toHaveText(passed ? 'Review passed' : 'In progress');
      const shown = await editorOnScreen(page);
      test.info().annotations.push({ type: 'short-window', description: `${at}: ${Math.round(shown)} px of editor (${Math.floor(shown / EDITOR_LINE)} lines)` });
      expect(shown, `${at}: at least ${size.lines} editor lines on screen`).toBeGreaterThanOrEqual(size.lines * EDITOR_LINE);
      const primary = passed
        ? '[data-testid="open-reflection"]'
        : '[data-testid="phase-strip"] .phase-strip-primary [data-testid="header-submit"]';
      expect(await inViewport(page, primary), `${at}: the primary action is on screen`).toBe(true);
      expect(await inViewport(page, '[data-testid="phase-place"]'), `${at}: the place is on screen`).toBe(true);
      // The optional quick check, where offered, is an item in More, never on the row.
      await expect(page.locator('[data-testid="phase-strip"] > [data-testid="concept-prompt"]'), at).toHaveCount(0);
      // ...and it is still reachable there.
      if (await page.locator('[data-testid="concept-prompt"]').count()) {
        await page.getByTestId('phase-more-toggle').click();
        await expect(page.locator('[data-testid="phase-more"] [data-testid="concept-prompt-start"]'), at).toBeVisible();
        await page.keyboard.press('Escape');
      }
      expect((await measure(page)).horizontalScroll, `${at}: no horizontal scroll`).toBe(false);
      // Under 1024 px a learner who opened the brief and the mentor can close
      // them again: on the Brief and Mentor panes the switches' row is back.
      if (panels === 'open' && size.width < 1024) {
        await page.getByTestId('pane-task').click();
        await page.getByRole('group', { name: 'Workspace panels' }).getByRole('button', { name: 'Hide brief', exact: true }).click();
        await expect(page.getByTestId('pane-code'), `${at}: focus on Code after Hide brief`).toBeFocused();
        await page.getByTestId('pane-panel').click();
        await page.getByRole('group', { name: 'Workspace panels' }).getByRole('button', { name: 'Hide mentor', exact: true }).click();
        await expect(page.locator('.workspace-panel-controls-strip').getByRole('button', { name: 'Show mentor', exact: true }), `${at}: focus on Show mentor after Hide mentor`).toBeFocused();
        await expect(page.getByRole('tablist', { name: 'Workspace pane' }), `${at}: both closed, the pane switcher goes`).toBeHidden();
      }
      // Panel preferences only change the layout under 1024 px.
      if (size.width >= 1024) break;
    }
  }
}

test.describe('short and narrow windows', () => {
  test.use({ deviceScaleFactor: 1, viewport: { width: 1440, height: 900 } });

  test('Implementation and Deployment, in progress and passed: eight editor lines at 960 by 540 and 470, twelve at 1152 by 648', async ({ page, request }) => {
    test.setTimeout(1_800_000);
    const reached = await reachImplementationByApi(request, {
      email: testEmail(`e2e-viewport-short-${stamp}`),
      password: 'Correct-Horse-9',
      name: 'Sid Short',
    });
    const { learner } = reached;
    let phases: ApiPhase[] = reached.phases;
    const byOrder = (order: number) => phases.find((p) => p.order === order)!;
    await dismissPhaseTutorial(page);
    await signInAs(page, learner.email, learner.password);
    await page.waitForURL('**/dashboard', { timeout: UI_READY });

    /** Saves, runs and submits until the review passes, without Continue. */
    const passWithoutContinue = async (phase: ApiPhase, files: Record<string, string>, drill = false) => {
      expect((await request.put(`${API}/phases/${phase.id}/workspace`, { headers: learner.headers, data: { files } })).ok(), 'the work saves').toBeTruthy();
      if (drill) await closeDrillByApi(request, learner, phase.id);
      const run = await request.post(`${API}/phases/${phase.id}/run`, { headers: learner.headers });
      expect(run.ok(), 'a run starts').toBeTruthy();
      const runId = (await run.json()).id as string;
      await expect
        .poll(async () => (await (await request.get(`${API}/runs/${runId}`, { headers: learner.headers })).json()).status, { timeout: 240_000 })
        .toBe('completed');
      const started = await request.post(`${API}/phases/${phase.id}/submit`, { headers: learner.headers, data: {} });
      expect(started.ok(), 'the work is submitted').toBeTruthy();
      expect((await settledSubmission(request, learner, (await started.json()).id, 240_000))?.passed, 'the review passes').toBe(true);
    };
    const continueOn = async (phase: ApiPhase) => {
      const advanced = await request.post(`${API}/phases/${phase.id}/advance`, { headers: learner.headers });
      expect(advanced.ok(), 'the phase advances').toBeTruthy();
      phases = (await advanced.json()).phases;
    };

    await checkShortRoom(page, 'Implementation in progress', byOrder(3).id, false);
    // The height boundary: at 660 px tall the short rules apply (the file's
    // path row goes), at 661 they do not, at 1152 px wide and at 1440.
    for (const width of [1152, 1440]) {
      await page.setViewportSize({ width, height: 661 });
      await openShort(page, byOrder(3).id, 'closed');
      await expect(page.locator('.phase-code-surface > .mono').first(), `${width} by 661: the path row is drawn`).toBeVisible();
      await page.setViewportSize({ width, height: 660 });
      await expect(page.locator('.phase-code-surface > .mono').first(), `${width} by 660: the path row goes`).toBeHidden();
      // From 1280 px the one header line holds the quick check at any height,
      // so it stays on the row there; under 1280 it moves into More.
      if (await page.locator('[data-testid="concept-prompt"]').count()) {
        await expect(page.locator('[data-testid="phase-strip"] > [data-testid="concept-prompt"]'), `${width} by 660: the quick check's place`).toHaveCount(width >= 1280 ? 1 : 0);
      }
    }
    await passWithoutContinue(byOrder(3), markPassing(IMPLEMENTATION_ARTEFACT));
    await checkShortRoom(page, 'Implementation passed', byOrder(3).id, true);
    await continueOn(byOrder(3));
    phases = await passPhaseByApi(request, learner, phases, 4, markPassing(TESTING_ARTEFACT));
    await checkShortRoom(page, 'Deployment in progress', byOrder(5).id, false);
    await passWithoutContinue(byOrder(5), markPassing(DEPLOYMENT_ARTEFACT), true);
    await checkShortRoom(page, 'Deployment passed', byOrder(5).id, true);
  });

  /*
   * Requirements and Design at 960 by 540: their work starts no lower than
   * 197 and 196 px from the top and the page scrolls by the wheel to the end
   * of the work.
   */
  test('Requirements and Design at 960 by 540: the work starts near the top and the page scrolls to its end', async ({ page, request }) => {
    test.setTimeout(600_000);
    const learner = await registerByApi(request, { email: testEmail(`e2e-viewport-board-${stamp}`), password: 'Correct-Horse-9', name: 'Bo Board' });
    let phases: ApiPhase[] = await enrolByApi(request, learner);
    await dismissPhaseTutorial(page);
    await page.setViewportSize({ width: 960, height: 540 });
    await signInAs(page, learner.email, learner.password);
    await page.waitForURL('**/dashboard', { timeout: UI_READY });
    for (const room of [
      { name: 'Requirements', order: 1, path: '/issue', ready: 'requirements-backlog-panel', work: '.requirements-workspace-room', most: 197 },
      { name: 'Design', order: 2, path: '/design', ready: 'phase-design-editor', work: '[data-testid="phase-design-editor"]', most: 196 },
    ] as const) {
      await page.goto(`/workspace/${phases.find((p) => p.order === room.order)!.id}${room.path}`);
      await expect(page.getByTestId(room.ready)).toBeVisible({ timeout: NAVIGATION });
      await page.waitForTimeout(1500);
      const top = await page.locator(room.work).first().evaluate((node) => node.getBoundingClientRect().top);
      test.info().annotations.push({ type: 'short-window', description: `${room.name} 960x540: the work starts at ${Math.round(top)} px` });
      expect(top, `${room.name}: the work starts no lower than ${room.most} px`).toBeLessThanOrEqual(room.most);
      // Wheel over the work until nothing moves; then its end is on screen.
      for (let turn = 0, last = -1; turn < 80; turn += 1) {
        const bottom = await page.locator(room.work).first().evaluate((node) => node.getBoundingClientRect().bottom);
        if (bottom <= 540 + 1 || bottom === last) break;
        last = bottom;
        await page.mouse.move(480, 400);
        await page.mouse.wheel(0, 200);
        await page.waitForTimeout(60);
      }
      const end = await page.locator(room.work).first().evaluate((node) => node.getBoundingClientRect().bottom <= window.innerHeight + 1);
      expect(end, `${room.name}: the wheel brings the end of the work on screen`).toBe(true);
      expect((await measure(page)).horizontalScroll, `${room.name}: no horizontal scroll`).toBe(false);
      if (room.order === 1) phases = await passPhaseByApi(request, learner, phases, 1, PASSING_REQUIREMENTS);
    }
  });
});
