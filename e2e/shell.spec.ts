import { APIRequestContext, expect, Page, test } from '@playwright/test';
import { dismissPhaseTutorial, registerOrSignIn, signInAs, waitForEditor, continueMyProject } from './pw-fixtures';
import { PASSING_DESIGN, PASSING_REQUIREMENTS } from './passing-work';
import { API_ORIGIN as API, RUN_ID, testEmail } from './support/env';
import { SANDBOX_RUN, UI_READY } from './support/timeouts';

/**
 * The shell, which is drawn once and kept.
 *
 * Every assertion here is about what a *navigation* does to the chrome, not
 * about what a page looks like when it has settled. The bar and the sidebar
 * are mounted by `app/(app)/layout.tsx`, above the router, so moving between
 * two pages must change the text inside them and nothing else: the same DOM
 * nodes, never fewer links than before the click, the learner's name never
 * gone, the bell's count the same everywhere, and no second round of requests
 * for records that are already in memory.
 *
 * The measurements are taken with a MutationObserver installed *before* the
 * click, because the failures this file exists to catch lasted 40ms, long
 * enough to see, far too short for an assertion that waits.
 */

// One run-wide account (E2E_RUN_ID), so a case that fails and restarts the
// worker leaves the rest still signing in as the learner the first one made.
const LEARNER_EMAIL = testEmail(`e2e-shell-${RUN_ID}`);
// Not 'Password1!': that is on the common-password list registration refuses.
const LEARNER_PASSWORD = 'Correct-Horse-9';
const LEARNER_NAME = 'Sam Shell';


// In order, one worker, not serial: one case needs a host that runs learner
// code, and it must not silently skip the ones after it.
test.describe.configure({ mode: 'default' });

/**
 * The shell's own pages, as the sidebar carries them (Sidebar.tsx): each
 * one's address, where the walks below wait for it to land. The sidebar has no
 * phases, map, journal or shelf entries; /journal is the progress page and
 * /map the portfolio.
 */
const PAGES: Record<string, RegExp> = {
  'nav-home': /\/dashboard$/,
  'nav-learn': /\/learn$/,
  'nav-progress': /\/progress$/,
  'nav-feedback': /\/feedback$/,
  'nav-join': /\/classroom$/,
};

/** Click a sidebar entry and wait for its page to be drawn. */
async function walkTo(page: Page, link: string): Promise<void> {
  await page.getByTestId(link).click();
  await expect(page).toHaveURL(PAGES[link], { timeout: UI_READY });
  await expect(page.locator('main h1').first()).toBeVisible({ timeout: UI_READY });
  if (link === 'nav-home') await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
}

/** The two widths, in pixels, from `lg` up (lib/sidebar.ts). */
const FULL = 232;
const RAIL = 76;

/* --------------------------------- helpers -------------------------------- */

async function register(page: Page): Promise<void> {
  // Register, sign in, finish setup (which starts the project); a retry finds
  // the run-wide account its first attempt made and signs in to it.
  await registerOrSignIn(page, { name: LEARNER_NAME, email: LEARNER_EMAIL, password: LEARNER_PASSWORD });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await signInAs(page, LEARNER_EMAIL, LEARNER_PASSWORD);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
}


/**
 * Watches the chrome from before a click until after the page has settled.
 *
 * Every DOM mutation is sampled, how many learner links the sidebar carries,
 * whether the learner's name is there, which theme icon is showing, what the
 * bell reads, how many skeletons are on the page, and the worst of each is
 * reported. A frame that existed for one paint is in here.
 */
interface Watch {
  minLinks: number;
  missingUser: number;
  sunFrames: number;
  moonFrames: number;
  bells: string[];
  /** Every distinct `data-sidebar` seen, in order. One entry means it never moved. */
  sides: string[];
  maxSkeletons: number;
  /** Fewest run-log rows seen in a sample taken on Home; -1 if Home was never drawn. */
  minRuns: number;
  /** Commits on the watched page that did not carry the text asked for. */
  missingText: number;
  /** Commits sampled on that page at all. */
  onPath: number;
  samples: number;
  sameSidebar: boolean;
  sameBar: boolean;
}

async function watchChrome(page: Page, want?: { path: string; text: string }): Promise<void> {
  await page.evaluate((expected: { path: string; text: string } | undefined) => {
    const w = window as any;
    const tag = `${Date.now()}-${Math.random()}`;
    const side = document.querySelector('[data-testid="sidebar"], [data-testid="rail"]');
    const bar = document.querySelector('[data-testid="nav"]');
    if (side) (side as any).__shellTag = tag;
    if (bar) (bar as any).__shellTag = tag;
    const state = {
      tag,
      minLinks: Number.POSITIVE_INFINITY,
      missingUser: 0,
      sunFrames: 0,
      moonFrames: 0,
      bells: [] as string[],
      sides: [] as string[],
      maxSkeletons: 0,
      minRuns: Number.POSITIVE_INFINITY,
      missingText: 0,
      onPath: 0,
      samples: 0,
      sameSidebar: true,
      sameBar: true,
    };
    // An <svg> has no offsetParent, so visibility is read off the cascade,
    // which is the point: CSS is what picks between the two icons.
    const visible = (el: Element) => getComputedStyle(el).display !== 'none';
    const sample = () => {
      const nowSide = document.querySelector('[data-testid="sidebar"], [data-testid="rail"]');
      const nowBar = document.querySelector('[data-testid="nav"]');
      if (!nowSide || !nowBar) return;
      state.samples += 1;
      if ((nowSide as any).__shellTag !== tag) state.sameSidebar = false;
      if ((nowBar as any).__shellTag !== tag) state.sameBar = false;
      state.minLinks = Math.min(
        state.minLinks,
        nowSide.querySelectorAll('a[data-testid^="nav-"]').length,
      );
      if (!document.querySelector('[data-testid="nav-user"]')) state.missingUser += 1;
      const toggle = document.querySelector('[data-testid="theme-toggle"]');
      if (toggle) {
        const icons = Array.from(toggle.querySelectorAll('svg'));
        if (icons.some((i) => visible(i) && i.classList.contains('when-graphite'))) state.sunFrames += 1;
        if (icons.some((i) => visible(i) && i.classList.contains('when-paper'))) state.moonFrames += 1;
      }
      const bell = document.querySelector('[data-testid="bell"]');
      if (bell) {
        const text = (bell.textContent ?? '').trim();
        if (state.bells[state.bells.length - 1] !== text) state.bells.push(text);
      }
      // The width is CSS off this attribute, so reading it costs no layout and
      // still catches a frame at the other shape.
      const side = document.documentElement.getAttribute('data-sidebar') ?? '';
      if (state.sides[state.sides.length - 1] !== side) state.sides.push(side);
      state.maxSkeletons = Math.max(state.maxSkeletons, document.querySelectorAll('.skeleton').length);
      // The run log is Home's, so it is only asked about on Home: everywhere
      // else the count is nought for the honest reason.
      if (location.pathname === '/dashboard') {
        state.minRuns = Math.min(
          state.minRuns,
          document.querySelectorAll('[data-testid^="stand-run-"]').length,
        );
      }
      // Was the page already whole on arrival? Counted per commit, so a page
      // that fetched what it should have had is caught by the frames it spent
      // without it.
      if (expected && location.pathname === expected.path) {
        state.onPath += 1;
        if (!(document.body.textContent ?? '').includes(expected.text)) state.missingText += 1;
      }
    };
    w.__shellWatch = state;
    w.__shellObserver?.disconnect();
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    w.__shellObserver = observer;
    sample();
  }, want);
}

async function readWatch(page: Page): Promise<Watch> {
  return page.evaluate(() => {
    const w = window as any;
    w.__shellObserver?.disconnect();
    const s = w.__shellWatch;
    return {
      minLinks: s.minLinks === Number.POSITIVE_INFINITY ? 0 : s.minLinks,
      missingUser: s.missingUser,
      sunFrames: s.sunFrames,
      moonFrames: s.moonFrames,
      bells: s.bells,
      sides: s.sides,
      maxSkeletons: s.maxSkeletons,
      minRuns: s.minRuns === Number.POSITIVE_INFINITY ? -1 : s.minRuns,
      missingText: s.missingText,
      onPath: s.onPath,
      samples: s.samples,
      sameSidebar: s.sameSidebar,
      sameBar: s.sameBar,
    } as Watch;
  });
}

/**
 * Puts this learner in Implementation, the first phase with a suite to run.
 *
 * Through the API rather than the pages: journey.spec already proves the six
 * gates can be passed by typing into the editor, and what these two tests are
 * about is what a *navigation* does once there is something to run.
 */
async function toImplementation(request: APIRequestContext): Promise<void> {
  const auth = await request.post(`${API}/api/v1/auth/login`, {
    data: { email: LEARNER_EMAIL, password: LEARNER_PASSWORD },
  });
  const { token } = (await auth.json()) as { token: string };
  const headers = { authorization: `Bearer ${token}` };
  const enrolment = async () =>
    (await (
      await request.get(`${API}/api/v1/enrollments/mine?project=tasktrackr`, { headers })
    ).json()) as { currentPhaseOrder: number; phases: { id: string; order: number }[] };

  /** The editable artefacts each of the first two gates reads. Design is
      three files: the markdown carries traceability and the data model, and
      the two contracts carry a quarter and a sixth of the mark between them. */
  const artefact: Record<number, Record<string, string>> = {
    1: PASSING_REQUIREMENTS,
    2: PASSING_DESIGN,
  };

  let mine = await enrolment();
  while (mine.currentPhaseOrder < 3) {
    const phase = mine.phases.find((p) => p.order === mine.currentPhaseOrder);
    expect(phase, `phase ${mine.currentPhaseOrder} is in the enrolment`).toBeTruthy();
    await request.put(`${API}/api/v1/phases/${phase!.id}/workspace`, {
      headers,
      data: { files: artefact[mine.currentPhaseOrder] },
    });
    const started = (await (
      await request.post(`${API}/api/v1/phases/${phase!.id}/submit`, { headers })
    ).json()) as { id: string };
    await expect
      .poll(
        async () =>
          (await (
            await request.get(`${API}/api/v1/submissions/${started.id}`, { headers })
          ).json()) as { status: string; passed: boolean | null },
        { timeout: 180_000, intervals: [500] },
      )
      .toMatchObject({ status: 'completed', passed: true });
    await request.post(`${API}/api/v1/phases/${phase!.id}/reflect`, {
      headers,
      data: {
        reflection:
          'The rubric feedback showed me exactly where my artefact was weakest, and fixing that changed how I will approach the next phase.',
      },
    });
    await request.post(`${API}/api/v1/phases/${phase!.id}/advance`, { headers });
    mine = await enrolment();
  }
}

/** How many learner links the sidebar carries right now. */
async function sidebarLinks(page: Page): Promise<number> {
  return page.evaluate(() => {
    const side = document.querySelector('[data-testid="sidebar"], [data-testid="rail"]');
    return side ? side.querySelectorAll('a[data-testid^="nav-"]').length : 0;
  });
}

/** Requests this page has made to the API, counted from the resource timeline. */
async function apiRequests(page: Page, since: number): Promise<string[]> {
  return page.evaluate(
    ({ api, from }) =>
      performance
        .getEntriesByType('resource')
        .filter((e) => e.startTime >= from && e.name.startsWith(`${api}/api/v1`))
        .map((e) => e.name.replace(`${api}/api/v1`, '')),
    { api: API, from: since },
  );
}

const now = (page: Page) => page.evaluate(() => performance.now());

/* --------------------------- 1 · one shell, kept -------------------------- */

test('the bar and the sidebar are the same nodes on every page', async ({ page }) => {
  await dismissPhaseTutorial(page);
  await register(page);
  // The tour is skipped by the init script; setup started the project, so the
  // sidebar has what it carries.
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('nav-user')).toBeVisible();

  const before = await sidebarLinks(page);
  expect(before, 'the learner sees more than one nav link').toBeGreaterThan(1);

  for (const link of ['nav-learn', 'nav-progress', 'nav-feedback', 'nav-join', 'nav-home']) {
    await watchChrome(page);
    await walkTo(page, link);
    await page.waitForTimeout(400);
    const seen = await readWatch(page);

    expect(seen.samples, `${link}: the chrome was sampled`).toBeGreaterThan(0);
    expect(seen.sameSidebar, `${link}: the sidebar is the same element`).toBe(true);
    expect(seen.sameBar, `${link}: the top bar is the same element`).toBe(true);
    expect(seen.minLinks, `${link}: the sidebar never lost a link`).toBeGreaterThanOrEqual(before);
    expect(seen.missingUser, `${link}: the learner's name never went`).toBe(0);
  }
});

/* ------------------------------ 2 · the bell ------------------------------ */

test('the bell reads the same on every page and opens what is waiting', async ({ page }) => {
  await dismissPhaseTutorial(page);
  await signIn(page);
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
  // The badge counts the plan's unfinished steps as well as the unread notes,
  // and the plan needs the shell's phases. Read it once that has landed, or the
  // baseline every assertion below compares against is whatever the count
  // happened to be mid-load.
  await expect(page.getByTestId('tile-checklist')).toBeVisible({ timeout: UI_READY });

  const bell = page.getByTestId('bell');
  await expect(bell).toBeVisible();
  const onHome = (await bell.textContent())?.trim() ?? '';
  expect(onHome, 'something is waiting on a learner who has just started').not.toBe('');

  for (const link of ['nav-learn', 'nav-progress', 'nav-feedback', 'nav-join']) {
    await watchChrome(page);
    await walkTo(page, link);
    await page.waitForTimeout(300);
    const seen = await readWatch(page);
    // Not just "the same at the end": the count must not blink at any point.
    expect(seen.bells, `${link}: the bell never changed`).toEqual([onHome]);
  }

  await page.getByTestId('nav-home').click();
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });

  /* ------------------------------- the panel ------------------------------ */
  await expect(bell).toHaveAttribute('aria-expanded', 'false');
  await bell.click();
  const panel = page.getByTestId('bell-panel');
  await expect(panel).toBeVisible();
  await expect(bell).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).toContainText('Waiting on you');

  const items = page.getByTestId('bell-item');
  await expect(items.first()).toBeVisible();
  expect(await items.count(), 'the panel lists what the badge counted').toBe(Number(onHome));

  // Escape closes it and gives the keyboard back to the button.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(bell).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('bell');

  // The foot link goes to the phase in hand; a row goes where that step is done.
  await bell.click();
  await expect(page.getByTestId('bell-open-workspace')).toBeVisible();
  await items.first().click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: UI_READY });
  await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: UI_READY });
  // A route change closes the panel, whoever opened it.
  await expect(page.getByTestId('bell-panel')).toHaveCount(0);
});

/* --------------------- 3 · warm navigation asks nothing ------------------- */

test('moving between two pages the shell has already loaded costs no requests', async ({ page }) => {
  await dismissPhaseTutorial(page);
  await signIn(page);
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
  // Let the first load finish everything it wants, including the run log.
  await page.waitForTimeout(1_500);

  const from = await now(page);
  // The phases page is the progress record (/phases redirects there).
  await walkTo(page, 'nav-progress');
  await walkTo(page, 'nav-home');
  await page.waitForTimeout(1_000);

  // The project, its analytics, every phase detail and the run log are all in
  // memory and younger than a minute, so nothing is asked for again. What is
  // left is Home's own address-verification check, which is not the shell's.
  const made = await apiRequests(page, from);
  expect(
    made.filter((r) => !r.startsWith('/auth/')),
    `Home to Progress to Home asked for ${made.join(', ') || 'nothing'}`,
  ).toHaveLength(0);
  expect(made.length, 'the whole round trip stays inside the budget').toBeLessThanOrEqual(2);
});

/* ---------------------- 4 · the journal keeps its records ----------------- */

test('coming back to the journal shows no skeletons', async ({ page }) => {
  // The journal is the progress record (/journal is the progress page).
  await dismissPhaseTutorial(page);
  await signIn(page);
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });

  await walkTo(page, 'nav-progress');
  // The first visit is allowed its requests; wait them out.
  await page.waitForTimeout(1_500);

  await walkTo(page, 'nav-home');

  await watchChrome(page);
  await walkTo(page, 'nav-progress');
  await page.waitForTimeout(600);
  const seen = await readWatch(page);

  expect(seen.maxSkeletons, 'the revisit drew the record it already had').toBe(0);
  expect(seen.sameSidebar, 'and it did not rebuild the sidebar to do it').toBe(true);
});

/* --------------- 5 · a run in the workspace does not blank Home ----------- */

test('after a run in the workspace, Home draws itself whole', async ({ page, request }) => {
  await dismissPhaseTutorial(page);
  // Implementation is the first phase with a visible suite to run.
  await toImplementation(request);
  await signIn(page);
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
  // Home's own first load, run log included: what follows must not undo it.
  await page.waitForTimeout(1_500);

  await continueMyProject(page);
  // Implementation opens its room, the IDE, in one step.
  await waitForEditor(page, 60_000);
  await page.getByTestId('header-run').click();
  await expect(page.getByTestId('run-summary')).toContainText('tests passed', { timeout: SANDBOX_RUN });
  // The button comes back when the run is over as far as the page is
  // concerned, which is the moment the run log it holds is refreshed. The
  // panel can show the result before that, off the job event.
  await expect(page.getByTestId('header-run')).toBeEnabled({ timeout: SANDBOX_RUN });
  await page.waitForTimeout(300);

  await watchChrome(page);
  await page.getByTestId('nav-home').click();
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
  await page.waitForTimeout(800);
  const seen = await readWatch(page);

  // A run changes the run log, not the project: coming back to Home must show
  // the copy it already had, with the new run in it, rather than a skeleton
  // over data that was thrown away.
  expect(seen.maxSkeletons, 'Home was never a skeleton after a run').toBe(0);
});

/* --------------------- 6 · the sidebar's width is the learner's ----------- */

/**
 * The column as it stands: which shape it is wearing, how wide it actually is,
 * and what is remembered for each of the two contexts.
 *
 * The width is read off the element rather than believed from a class, because
 * the whole arrangement is CSS off `data-sidebar` on <html>, a class that was
 * right and a column that was 212px anyway is the bug this file is about.
 */
async function sidebarNow(page: Page): Promise<{
  attr: string | null;
  testId: string | null;
  width: number;
  doc: string | null;
  ide: string | null;
}> {
  // The rail peeks open under a pointer that rests on it, and the column eases
  // between its widths; the pointer is parked in the page and the width read
  // once the column's transitions have finished, not part-way through one.
  const size = page.viewportSize();
  await page.mouse.move((size?.width ?? 1280) - 20, (size?.height ?? 720) - 20);
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="sidebar"], [data-testid="rail"]');
    const running = el ? el.getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition) : [];
    return Promise.all(running.map((a) => a.finished.catch(() => undefined)));
  });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="sidebar"], [data-testid="rail"]');
    return !el || el.getAttribute('data-peek') !== 'true';
  });
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="sidebar"], [data-testid="rail"]');
    const read = (key: string) => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    };
    return {
      attr: document.documentElement.getAttribute('data-sidebar'),
      testId: el?.getAttribute('data-testid') ?? null,
      width: el ? Math.round(el.getBoundingClientRect().width) : -1,
      doc: read('lsdlc_sidebar'),
      ide: read('lsdlc_sidebar_ide'),
    };
  });
}

test('the toggle collapses the sidebar, and the choice outlives a walk and a reload', async ({
  page,
}) => {
  await dismissPhaseTutorial(page);
  // Recorded before any of the page's own scripts run, so the assertion below
  // is about the boot script rather than about React catching up.
  await page.addInitScript(() => {
    const w = window as unknown as { __sidebarFirst?: unknown };
    w.__sidebarFirst = null;
    new MutationObserver(() => {
      if (w.__sidebarFirst === null) {
        w.__sidebarFirst = {
          value: document.documentElement.getAttribute('data-sidebar'),
          readyState: document.readyState,
          bodyYet: Boolean(document.body),
        };
      }
      // `document`, not `document.documentElement`: an init script runs on a
      // document the parser has not put <html> into yet, and observing null
      // throws before the boot script has had its say.
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-sidebar'] });
  });
  await signIn(page);
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });

  // The document pages start on the rail (lib/sidebar.ts SIDEBAR_DEFAULT),
  // so the walk widens it first and then collapses it, which is the choice
  // that has to outlive the walk and the reload.
  const toggle = page.getByTestId('sidebar-toggle');
  await expect(toggle).toBeVisible();
  expect(await sidebarNow(page)).toMatchObject({ attr: 'rail', doc: null });
  await expect(toggle).toHaveAttribute('title', /Expand the sidebar \((⌘B|Ctrl B)\)/);
  await toggle.click();
  await expect(page.getByTestId('sidebar')).toBeVisible();
  expect(await sidebarNow(page)).toMatchObject({ attr: 'full', width: FULL, doc: 'full' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAttribute('aria-label', 'Collapse the sidebar');
  await expect(toggle).toHaveAttribute('title', /Collapse the sidebar \((⌘B|Ctrl B)\)/);

  await toggle.click();
  // The pointer is still over the column, which would let it peek open; it is
  // moved away so the collapsed column is the one read.
  await page.mouse.move(900, 600);
  await expect(page.getByTestId('rail')).toBeVisible();
  await expect(page.getByTestId('sidebar')).toHaveCount(0);
  expect(await sidebarNow(page)).toMatchObject({ attr: 'rail', width: RAIL, doc: 'rail' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-label', 'Expand the sidebar');
  // Collapsed, the words are gone and the icons are still there and still named.
  await expect(page.getByTestId('nav-progress')).toBeVisible();
  await expect(page.getByTestId('nav-progress')).toHaveAttribute('aria-label', 'Progress');

  // A walk keeps it, on every page.
  for (const link of ['nav-learn', 'nav-progress', 'nav-feedback', 'nav-home']) {
    await watchChrome(page);
    await walkTo(page, link);
    await page.waitForTimeout(250);
    expect((await readWatch(page)).sides, `${link}: it stayed collapsed`).toEqual(['rail']);
  }

  // A reload lands on it, and lands on it before the body exists, the width
  // is stamped by the script in <head>, not by React afterwards.
  await page.reload();
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
  const first = await page.evaluate(
    () => (window as unknown as { __sidebarFirst: { value: string; readyState: string; bodyYet: boolean } }).__sidebarFirst,
  );
  expect(first.value, 'the first thing written was the width the learner left').toBe('rail');
  expect(first.bodyYet, 'and it was written before there was a body to paint').toBe(false);
  expect(await sidebarNow(page)).toMatchObject({ attr: 'rail', testId: 'rail', width: RAIL });

  // ⌘B is the same switch. It puts the column back, and that is remembered too.
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  expect(await sidebarNow(page)).toMatchObject({ attr: 'full', width: FULL, doc: 'full' });
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.getByTestId('rail')).toBeVisible();
  expect(await sidebarNow(page)).toMatchObject({ attr: 'rail', width: RAIL, doc: 'rail' });

  // And the palette says so as well, so a learner who never found the button
  // finds the shortcut.
  await page.getByTestId('jump-to').click();
  await page.getByTestId('palette-input').fill('sidebar');
  const row = page.getByTestId('palette-row-0');
  await expect(row).toContainText('Expand the sidebar');
  await expect(row).toContainText(/⌘B|Ctrl B/);
  await row.click();
  await expect(page.getByTestId('sidebar')).toBeVisible();
  expect(await sidebarNow(page)).toMatchObject({ attr: 'full', width: FULL, doc: 'full' });
});

test('the workspace opens on the rail, and remembers being widened there', async ({ page }) => {
  await dismissPhaseTutorial(page);
  await signIn(page);
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
  // Nothing is remembered yet. Both contexts start on the rail
  // (lib/sidebar.ts SIDEBAR_DEFAULT): the document pages as well as the IDE.
  expect(await sidebarNow(page)).toMatchObject({ attr: 'rail', width: RAIL, doc: null, ide: null });

  await continueMyProject(page);
  // The door opens the phase's room in one step, a working page: the
  // rail, the first time in. Which room depends on where this learner is (an
  // earlier case advanced them), and the claim here is the width, not the room.
  await expect(page).not.toHaveURL(/\/brief$/, { timeout: UI_READY });
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]+(\/(issue|design|interview))?$/);
  await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: UI_READY });
  expect(await sidebarNow(page)).toMatchObject({ attr: 'rail', testId: 'rail', width: RAIL, doc: null });

  // Leaving gives the document pages back what they had.
  await page.getByTestId('nav-home').click();
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
  expect(await sidebarNow(page)).toMatchObject({ attr: 'rail', testId: 'rail', width: RAIL });

  // Widen it inside the IDE: that is the IDE's own answer from now on. The
  // door is the room, and the editor is one press further on unless the room
  // is the editor itself.
  await continueMyProject(page);
  await expect(page).not.toHaveURL(/\/brief$/, { timeout: UI_READY });
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]+(\/(issue|design|interview))?$/);
  if (!/\/workspace\/[0-9a-f-]+$/.test(page.url())) await page.getByTestId('open-workspace').click();
  await waitForEditor(page, 60_000);
  expect(await sidebarNow(page)).toMatchObject({ attr: 'rail', width: RAIL });
  await page.getByTestId('sidebar-toggle').click();
  await page.mouse.move(900, 600);
  await expect(page.getByTestId('sidebar')).toBeVisible();
  expect(await sidebarNow(page)).toMatchObject({ attr: 'full', width: FULL, ide: 'full', doc: null });

  // The editor does not swallow the shortcut: ⌘B with the caret in the code
  // still switches the column, which is the binding VS Code gives the same job.
  await page.getByTestId('editor-host').locator('.monaco-editor').click();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.getByTestId('rail')).toBeVisible();
  expect(await sidebarNow(page)).toMatchObject({ attr: 'rail', width: RAIL, ide: 'rail' });
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  expect(await sidebarNow(page)).toMatchObject({ attr: 'full', width: FULL, ide: 'full' });

  // Reloading the IDE lands on the width it was left at, not on the default.
  await page.reload();
  await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: UI_READY });
  expect(await sidebarNow(page)).toMatchObject({ attr: 'full', testId: 'sidebar', width: FULL });
});

test('widening the sidebar in the workspace leaves the document pages alone', async ({ page }) => {
  await dismissPhaseTutorial(page);
  // This learner keeps the document pages collapsed. The guard matters: the
  // init script runs again on every navigation, and it must not overwrite what
  // the toggle writes during the test.
  await page.addInitScript(() => {
    try {
      if (!window.localStorage.getItem('lsdlc_sidebar')) {
        window.localStorage.setItem('lsdlc_sidebar', 'rail');
      }
    } catch {
      // a browser without storage gets the default; the assertions say so
    }
  });
  await signIn(page);
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
  expect(await sidebarNow(page)).toMatchObject({ attr: 'rail', width: RAIL, doc: 'rail' });

  await continueMyProject(page);
  await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: UI_READY });
  // The door opens the room (whichever phase this shared learner is in), the
  // working page this case is about, in one step.
  await expect(page).not.toHaveURL(/\/brief$/, { timeout: UI_READY });
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]+(\/(issue|design|interview))?$/);
  await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: UI_READY });
  expect(await sidebarNow(page)).toMatchObject({ attr: 'rail', width: RAIL });
  await page.getByTestId('sidebar-toggle').click();
  await page.mouse.move(900, 600);
  await expect(page.getByTestId('sidebar')).toBeVisible();
  expect(await sidebarNow(page)).toMatchObject({ attr: 'full', width: FULL, ide: 'full', doc: 'rail' });

  // Out of the workspace, the learner's own answer is waiting, unchanged. The
  // step out is the one change, the whole change, in one attribute, and the
  // page after it is not a change at all.
  for (const [link, sides] of [
    ['nav-home', ['full', 'rail']],
    ['nav-progress', ['rail']],
  ] as const) {
    await watchChrome(page);
    await walkTo(page, link);
    await page.waitForTimeout(250);
    const seen = await readWatch(page);
    expect(seen.sides, `${link}: the document pages are still the learner's`).toEqual([...sides]);
    expect(await sidebarNow(page)).toMatchObject({ attr: 'rail', width: RAIL, doc: 'rail' });
  }

  // And the workspace is still wide, because that was said about the workspace.
  await page.getByTestId('nav-work').click();
  await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: UI_READY });
  expect(await sidebarNow(page)).toMatchObject({ attr: 'full', width: FULL });
});
