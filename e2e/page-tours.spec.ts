import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN } from './passing-work';
import { dismissPhaseTutorial, signInAs } from './pw-fixtures';
import { API, testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The tours, one per page.
 *
 * Each page with a tour is taught separately: one page's tour finishing must
 * not end another's, and a brand-new learner must be taught more than Home.
 * The page tours share one key, `lsdlc_coach`: the word `done` means all of
 * them, and anything else is the set of pages seen. "Show me around" replays
 * the tour of the page that is open. (Each phase's own tutorial is
 * remembered under a key of its own; see the note below.)
 *
 * Claims:
 * - Home opens no tour of its own; each phase room's tutorial opens on the
 *   first visit, once, and Skip or Escape marks that room and no other.
 * - "Show me around" replays from the sidebar foot (both shapes) and the
 *   palette.
 * - The brief, the design room and the IDE draw the number of cards the
 *   brief promised: three, three, five.
 *
 * Design and Implementation are opened with the admin's `reopen` override,
 * the same way rooms.spec.ts opens its rooms: what is under test is the chrome.
 */


const OVERRIDE_REASON = 'Opened for the walk of the tours each room draws on its first visit.';

interface Phase {
  id: string;
  order: number;
  key: string;
  title: string;
}

interface Learner {
  email: string;
  password: string;
  phases: Phase[];
}

let learner: Learner | null = null;

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/auth/login`, { data: ADMIN });
  expect(res.ok(), 'the seeded admin signs in').toBeTruthy();
  return (await res.json()).token as string;
}

/** Registers, enrols, and has an admin open Design and Implementation. */
async function ensureLearner(request: APIRequestContext): Promise<Learner> {
  if (learner) return learner;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const who = {
    email: testEmail(`e2e-tours-${stamp}`),
    password: 'Correct-Horse-9',
  };
  const auth = await request.post(`${API}/auth/register`, {
    data: { email: who.email, password: who.password, displayName: 'Tara Tours' },
  });
  expect(auth.ok(), 'the learner registers').toBeTruthy();
  const body = await auth.json();
  const token = body.token as string;
  const userId = body.user.id as string;
  // Setup is a page of its own; this learner has done it.
  const setup = await request.patch(`${API}/account/profile`, {
    headers: { authorization: `Bearer ${token}` },
    data: { displayName: 'Tara Tours', onboardingCompleted: true },
  });
  expect(setup.ok(), 'the learner finishes setup').toBeTruthy();

  const enrolled = await request.post(`${API}/enrollments`, {
    headers: { authorization: `Bearer ${token}` },
    data: { projectSlug: 'tasktrackr' },
  });
  expect(enrolled.ok(), 'the learner enrols').toBeTruthy();
  const phases = (await enrolled.json()).phases as Phase[];

  const staff = { authorization: `Bearer ${await adminToken(request)}` };
  for (const order of [2, 3]) {
    const phase = phases.find((p) => p.order === order)!;
    const opened = await request.post(
      `${API}/instructor/learners/${userId}/phases/${phase.id}/override`,
      { headers: staff, data: { action: 'reopen', reason: OVERRIDE_REASON } },
    );
    expect(opened.ok(), `phase ${order} opens`).toBeTruthy();
  }

  learner = { ...who, phases };
  return learner;
}

const phaseOf = (l: Learner, order: number): Phase => l.phases.find((p) => p.order === order)!;

/**
 * Signs in through the page. `flag` is what `lsdlc_coach` holds before the
 * first page draws: nothing (every tour unseen), the word `done`, or a set.
 */
async function signIn(page: Page, who: Learner, flag: string | null = null): Promise<void> {
  await page.addInitScript((value) => {
    try {
      if (value) window.localStorage.setItem('lsdlc_coach', value);
    } catch {
      // a browser without storage gets the defaults; no assertion minds
    }
  }, flag);
  await page.goto('/login');
  await signInAs(page, who.email, who.password);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
}

const flagOf = (page: Page) => page.evaluate(() => window.localStorage.getItem('lsdlc_coach'));

/* -------------------------------------------------------------------------- */
/* the flag is per page                                                        */
/* -------------------------------------------------------------------------- */

/*
 * In components/shell/tours.ts and CoachMarks.tsx a page's own tour opens
 * only on request ("Show me around"), and what opens on a learner's first
 * visit is each phase's tutorial, remembered per learner and per phase
 * (`lsdlc_phase_tutorial_v1:<learner>:<phase>`), not in the `lsdlc_coach`
 * page flags. The walks below hold the promises against that: taught once,
 * per room, closing one leaves the others; the replay; and each room's own
 * parts, in order.
 */
const card = (page: Page) => page.locator('[data-testid="coach"] [aria-current="step"]');
const tutorialSeen = (page: Page, phaseId: string) =>
  page.evaluate((id) => Object.keys(window.localStorage).some((key) => key.startsWith('lsdlc_phase_tutorial_v1:') && key.endsWith(`:${encodeURIComponent(id)}`) && window.localStorage.getItem(key) === 'seen'), phaseId);

/** Walk a tour with Next to its end, and return every card's title. */
async function walk(page: Page): Promise<string[]> {
  const titles: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    titles.push(((await card(page).locator('h2').textContent()) ?? '').trim());
    const next = page.getByTestId('coach-next');
    const done = ((await next.textContent()) ?? '').trim() === 'Done';
    await next.click();
    if (done) break;
  }
  await expect(page.getByTestId('coach')).toHaveCount(0);
  return titles;
}

test('each phase room is taught once, and closing one leaves the other', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  await signIn(page, who);

  // Home opens no tour of its own.
  await page.waitForTimeout(800);
  await expect(page.getByTestId('coach')).toHaveCount(0);

  // The Requirements room: its tutorial on the first visit, with the focus
  // inside it rather than eighteen stops of chrome away.
  const requirements = phaseOf(who, 1);
  await page.goto(`/workspace/${requirements.id}/interview`);
  await expect(page.getByTestId('coach')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('coach-count')).toHaveText(/^1 of \d+$/);
  await expect(card(page)).toContainText('First, interview the stakeholder');
  await expect(page.getByTestId('coach-next')).toBeFocused();
  await page.getByTestId('coach-skip').click();
  await expect(page.getByTestId('coach')).toHaveCount(0);
  expect(await tutorialSeen(page, requirements.id), 'Requirements is marked taught').toBe(true);

  // The Design room: its own tutorial, over a room the first Skip did not touch.
  const design = phaseOf(who, 2);
  await page.goto(`/workspace/${design.id}/design`);
  await expect(page.getByTestId('coach')).toBeVisible({ timeout: UI_READY });
  await expect(card(page)).toContainText('Start with the UML model');
  // Escape ends it and marks this room.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('coach')).toHaveCount(0);
  expect(await tutorialSeen(page, design.id), 'Design is marked taught').toBe(true);

  // Back in either room: taught once. The room is up and no card is over it.
  for (const path of [`/workspace/${design.id}/design`, `/workspace/${requirements.id}/interview`]) {
    await page.goto(path);
    await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: UI_READY });
    await page.waitForTimeout(800);
    await expect(page.getByTestId('coach')).toHaveCount(0);
  }
});

/* -------------------------------------------------------------------------- */
/* Show me around                                                              */
/* -------------------------------------------------------------------------- */

test('Show me around replays the tour from the sidebar foot, in both shapes, and from the palette', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  // Everything seen: the replay is the only way a tour opens in this test.
  await dismissPhaseTutorial(page);
  await signIn(page, who, 'done');

  await page.goto(`/workspace/${phaseOf(who, 1).id}/interview`);
  await expect(page.getByTestId('requirements-workspace')).toBeVisible({ timeout: UI_READY });
  await page.waitForTimeout(800);
  await expect(page.getByTestId('coach')).toHaveCount(0);

  // Show me around lives in the account menu (the sidebar foot has no
  // copy); in a phase room it replays that phase's tutorial.
  await page.getByTestId('nav-user').click();
  const around = page.getByTestId('show-me-around');
  await expect(around).toBeEnabled();
  await around.click();
  await expect(page.getByTestId('coach')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('coach-count')).toHaveText(/^1 of \d+$/);
  await page.getByTestId('coach-skip').click();
  await expect(page.getByTestId('coach')).toHaveCount(0);
  // A replay over `done` leaves `done` alone.
  expect(await flagOf(page)).toBe('done');

  // The palette: type it, press Enter.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.getByTestId('palette-input').fill('show me around');
  await expect(page.getByTestId('palette-row-0')).toContainText('Show me around');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  await expect(page.getByTestId('coach')).toBeVisible({ timeout: 10_000 });
  // Escape ends a replay too.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('coach')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* the other three pages                                                       */
/* -------------------------------------------------------------------------- */

test('the design room teaches its three parts', async ({ page, request }) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  await signIn(page, who);
  const design = phaseOf(who, 2);
  // "Taught once" is remembered in the browser, and every case here has a
  // browser of its own, so the room's first visit opens its tutorial.
  await page.goto(`/workspace/${design.id}/design`);
  await expect(page.getByTestId('phase-design-editor')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('coach')).toBeVisible({ timeout: UI_READY });
  // The Design tutorial's parts, in order (tours.ts phaseTutorialMarks).
  expect(await walk(page)).toEqual([
    'Start with the UML model',
    'Define the API contracts',
    'Trace a sequence',
    'Explain your design decisions',
    'Review the design as a whole',
    'Return whenever you need help',
  ]);
  expect(await tutorialSeen(page, design.id)).toBe(true);
});

test('the brief page teaches its three parts', async ({ page, request }) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  // The brief's own tour opens on request; the phase tutorials are kept shut.
  await dismissPhaseTutorial(page);
  await signIn(page, who, JSON.stringify({ home: true }));
  await page.goto(`/workspace/${phaseOf(who, 2).id}/brief`);
  await expect(page.getByTestId('go-to-workspace')).toBeVisible({ timeout: UI_READY });
  await page.getByTestId('nav-user').click();
  await page.getByTestId('show-me-around').click();
  await expect(page.getByTestId('coach')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('coach-count')).toHaveText(/^1 of 3$/);
  expect(await walk(page)).toEqual(['Read the phase brief', 'Open the phase space', 'Your account and appearance']);
});

test('the IDE teaches its five parts', async ({ page, request }) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  await signIn(page, who);
  // Implementation: a phase with a suite to run, so every target exists.
  const implementation = phaseOf(who, 3);
  await page.goto(`/workspace/${implementation.id}`);
  await expect(page.getByTestId('editor-host')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId('header-run')).toBeVisible();
  await expect(page.getByTestId('coach')).toBeVisible({ timeout: UI_READY });
  // The Implementation tutorial's parts, in order (tours.ts phaseTutorialMarks).
  expect(await walk(page)).toEqual([
    'Implement the agreed contracts',
    'Run the tests',
    'Inspect the app preview',
    'Keep the brief close',
    'Submit the saved implementation',
    'Return whenever you need help',
  ]);
  expect(await tutorialSeen(page, implementation.id)).toBe(true);
});
