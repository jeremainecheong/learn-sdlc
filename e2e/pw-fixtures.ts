import { expect, test, type Locator, type Page } from '@playwright/test';
import { MARKER } from './ai-stub.cjs';
import { API } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The Playwright suite's journey and staff helpers.
 *
 * They cannot live in e2e/fixtures.ts: that file is also loaded by the API's
 * own e2e tests (apps/api/test/*.e2e-spec.ts, through
 * e2e/golden-records.ts), whose TypeScript program has no DOM library and
 * whose Linux sandbox build installs only the api and shared workspaces, so
 * @playwright/test is not there at run time; and a sandbox test pins that
 * file's bytes. So e2e/fixtures.ts holds only the golden-path content, and
 * every helper that drives a browser is here, where only Playwright specs
 * import it. Nothing under apps/ may import this file.
 */

/* ------------------------------ journey helpers --------------------------- */
// How a learner and a teacher get into the product, in one place, so a
// change to the front door is one edit rather than thirty.

/** The one password the suite's learners use; a test account, not a secret. */
export const LEARNER_PASSWORD = 'Correct-Horse-9';

/**
 * The marker the suite's AI stub (e2e/ai-stub.cjs) looks for in a submission's
 * learner data before it passes a review. Work that should pass carries it;
 * work that should be sent back does not. A comment in the learner's own file,
 * so nothing the graders read changes meaning.
 */
export const E2E_PASS: string = MARKER;

/**
 * Every per-phase tutorial counts as seen, so the dialog that opens on a
 * learner's first visit to each phase does not sit over the controls a spec
 * drives. The tutorial is keyed per learner and phase
 * (`lsdlc_phase_tutorial_v1:<owner>:<phase>`, components/shell/tours.ts), and
 * neither is known before the account exists, so the read is answered here.
 * A spec that is about the tutorial does not call this.
 */
export async function dismissPhaseTutorial(page: Page): Promise<void> {
  await page.addInitScript((coachKey) => {
    try {
      const read = Storage.prototype.getItem;
      Storage.prototype.getItem = function (this: Storage, key: string) {
        if (typeof key === 'string' && key.startsWith('lsdlc_phase_tutorial_v1:')) return 'seen';
        return read.call(this, key);
      };
      window.localStorage.setItem(coachKey, 'done');
    } catch {
      // a browser without storage gets the tutorial
    }
  }, COACH_KEY);
}

/**
 * The storage key that records the first-run tour as finished
 * (components/shell/tours.ts). A spec about the tour reads and writes it itself.
 */
export const COACH_KEY = 'lsdlc_coach';

/**
 * The first-run tour counts as finished, and nothing else: the per-phase
 * tutorial still opens. For a spec that walks the tutorial or does not reach a
 * phase; every other spec calls dismissPhaseTutorial, which does both.
 */
export async function skipCoachMarks(page: Page): Promise<void> {
  await page.addInitScript((coachKey) => {
    try {
      window.localStorage.setItem(coachKey, 'done');
    } catch {
      // a browser without storage gets the tour; the assertions do not mind
    }
  }, COACH_KEY);
}

/** Sign in from /login. Lands wherever the product sends this account. */
export async function signInAs(page: Page, email: string, password: string = LEARNER_PASSWORD): Promise<void> {
  if (!/\/login(\?|$)/.test(page.url())) await page.goto('/login');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('login-submit').click();
}

export interface NewLearner {
  name: string;
  email: string;
  password: string;
}

/**
 * Register, which ends on the sign-in page ("Your account is ready"), then sign
 * in, and stop on the one-page setup that every new account opens on.
 */
async function registerThenSignIn(page: Page, who: { name: string; email: string; password?: string }): Promise<NewLearner> {
  const learner = { name: who.name, email: who.email, password: who.password ?? LEARNER_PASSWORD };
  await page.goto('/register');
  await page.getByTestId('displayName').fill(learner.name);
  await page.getByTestId('email').fill(learner.email);
  await page.getByTestId('password').fill(learner.password);
  await page.getByTestId('register-submit').click();
  await page.waitForURL('**/login?registered=1', { timeout: NAVIGATION });
  await signInAs(page, learner.email, learner.password);
  await page.waitForURL('**/onboarding', { timeout: NAVIGATION });
  return learner;
}

/**
 * A new learner, the way a person becomes one: register, which ends on the
 * sign-in page ("Your account is ready"), sign in, finish the one-page setup
 * with "Learn independently", and arrive on the dashboard enrolled.
 */
export async function registerAndSignIn(
  page: Page,
  who: { name: string; email: string; password?: string },
): Promise<NewLearner> {
  const learner = await registerThenSignIn(page, who);
  await page.getByRole('button', { name: 'Start learning', exact: true }).click();
  await page.waitForURL('**/dashboard', { timeout: NAVIGATION });
  return learner;
}

/**
 * The same, for a spec whose account is run-wide (E2E_RUN_ID) and whose later
 * cases sign in as it: on a retry (CI runs with retries: 1) the first attempt
 * may already have registered the address, and registering it again would be
 * refused ("already exists"). So a retry that finds the account signs in to
 * it and finishes setup if the first attempt stopped before that.
 */
export async function registerOrSignIn(
  page: Page,
  who: { name: string; email: string; password?: string },
): Promise<NewLearner> {
  const learner = { name: who.name, email: who.email, password: who.password ?? LEARNER_PASSWORD };
  const exists = test.info().retry > 0 && (await page.request.post(`${API}/auth/login`, { data: { email: learner.email, password: learner.password } })).ok();
  if (!exists) return registerAndSignIn(page, learner);
  await page.goto('/login');
  await signInAs(page, learner.email, learner.password);
  await page.waitForURL(/\/(onboarding|dashboard)$/, { timeout: NAVIGATION });
  if (/\/onboarding$/.test(page.url())) {
    await page.getByRole('button', { name: 'Start learning', exact: true }).click();
    await page.waitForURL('**/dashboard', { timeout: NAVIGATION });
  }
  return learner;
}

/** From the dashboard into the learner's current phase, the way a learner goes back to work. */
export async function continueMyProject(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Continue my project', exact: true }).click();
}

/** Waits until the workspace's editor has drawn Monaco. */
export async function waitForEditor(page: Page, timeout: number): Promise<void> {
  await expect(page.getByTestId('editor-host').locator('.monaco-editor')).toBeVisible({ timeout });
}

/**
 * Presses Skip on the concept-check card whenever it appears, for a spec that
 * is not about the card: Playwright runs the handler before any action the
 * card would block.
 */
export async function skipConceptChecks(page: Page): Promise<void> {
  await page.addLocatorHandler(page.getByTestId('concept-prompt-skip'), async (skip) => {
    await skip.click();
  });
}

/** A teacher's home, where signing in as staff lands. */
export async function teacherHome(page: Page): Promise<void> {
  // A sign-in that is still on its way lands first; only then is the home asked for.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
  if (!/\/teacher$/.test(new URL(page.url()).pathname)) await page.goto('/teacher');
  await page.waitForURL('**/teacher', { timeout: NAVIGATION });
  await expect(page.getByRole('heading', { level: 1, name: 'My classes' })).toBeVisible({ timeout: UI_READY });
}

/**
 * From the dashboard into the learner's Requirements room. A new learner's
 * room opens at the stakeholder interview. Returns the phase id.
 */
export async function openRequirements(page: Page): Promise<string> {
  await continueMyProject(page);
  await page.waitForURL(/\/workspace\/[0-9a-f-]+\/interview$/, { timeout: NAVIGATION });
  await expect(page.getByTestId('requirements-workspace')).toBeVisible({ timeout: UI_READY });
  return /\/workspace\/([0-9a-f-]+)\/interview$/.exec(page.url())![1];
}

/**
 * The Requirements room's case file (the brief column): its Brief, or the
 * Interview evidence: the settled topics and the "you have enough" notice.
 */
export async function openCaseFile(page: Page, section: 'Brief' | 'Interview evidence'): Promise<void> {
  const show = page.getByRole('button', { name: 'Show brief', exact: true });
  if (await show.isVisible().catch(() => false)) await show.click();
  const tab = page.locator('nav[aria-label="Case file sections"]').getByRole('button', { name: section, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
}

/** One of the Requirements room's two tabs: the interview, or the backlog. */
export async function requirementsTab(page: Page, tab: 'Stakeholder interview' | 'My backlog'): Promise<void> {
  const link = page.getByRole('tab', { name: tab, exact: true });
  await link.click();
  await expect(link).toHaveAttribute('aria-selected', 'true');
}

/**
 * A door on the phase strip that sits under the strip's
 * Details disclosure: Brief, the phase's document, Run app, View pipeline and
 * the planted bugs (WorkPage.tsx `secondaryIds`). Opens Details when the door
 * is not already on screen, and hands the door back, visible.
 */
export async function stripDoor(page: Page, testId: string): Promise<Locator> {
  const door = page.getByTestId(testId);
  await door.waitFor({ state: 'attached', timeout: UI_READY });
  if (!(await door.isVisible())) {
    await page.locator('details.phase-strip-details:not([open]) > summary').first().click();
  }
  await expect(door).toBeVisible();
  return door;
}

/** Fold the strip's Details away, so its panel covers nothing the next step reads or presses. */
export async function foldStripDetails(page: Page): Promise<void> {
  const open = page.locator('details.phase-strip-details[open] > summary');
  if (await open.count()) await open.first().click();
}

/** Press a strip door the way a learner does: open Details, press, fold Details again. */
export async function pressStripDoor(page: Page, testId: string): Promise<void> {
  await (await stripDoor(page, testId)).click();
  await foldStripDetails(page);
}

/** Sign out the way a person does now: from the account menu under the name. */
export async function signOutFromMenu(page: Page): Promise<void> {
  const logout = page.getByTestId('logout');
  if (!(await logout.isVisible().catch(() => false))) await page.getByTestId('nav-user').click();
  await logout.click();
  await page.waitForURL('**/login**', { timeout: NAVIGATION });
}

/* ------------------------------- staff helpers ---------------------------- */

/**
 * A teacher makes a class from the teacher home: Create class, a name, Create
 * class. The product then opens the class's own page on its Project tab; the
 * join code is under the Invite and notes tab, which this opens and leaves
 * open. Returns the class id and the code as it is shown.
 */
export async function createClassFromTeacherHome(page: Page, name: string): Promise<{ classId: string; joinCode: string }> {
  await teacherHome(page);
  await page.getByRole('button', { name: 'Create class', exact: true }).first().click();
  await page.getByLabel('Class name').fill(name);
  await page.locator('form.exp-form').getByRole('button', { name: 'Create class', exact: true }).click();
  await page.waitForURL(/\/teacher\/class\?class=/, { timeout: NAVIGATION });
  const classId = new URL(page.url()).searchParams.get('class')!;
  await page.getByTestId('class-tab-invite').click();
  const code = page.locator('code.exp-code').first();
  await expect(code).toBeVisible({ timeout: UI_READY });
  // The code is masked until Show code is pressed.
  await page.getByTestId('join-code-show').first().click();
  await expect(code).not.toContainText('•');
  const joinCode = (await code.innerText()).trim();
  expect(joinCode, 'a formatted join code').toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  return { classId, joinCode };
}

/** A signed-in learner joins a class from the classroom page, by its code. */
export async function joinClassInUi(page: Page, code: string): Promise<void> {
  await page.goto('/classroom');
  await page.getByLabel('Class code').fill(code);
  await page.getByRole('button', { name: 'Join class', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'You have joined your class.' })).toBeVisible({ timeout: UI_READY });
}

/**
 * One class's page, and one learner's phase opened on it: the evidence panel
 * with the phase's levers and the record of changes.
 */
export async function inspectLearnerPhase(page: Page, classId: string, learnerName: string, phaseTitle: string): Promise<void> {
  if (!page.url().includes(`class=${classId}`)) await page.goto(`/teacher/class?class=${classId}`);
  await page.getByRole('button', { name: `Inspect ${learnerName}, ${phaseTitle}`, exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: `${learnerName} / ${phaseTitle}` })).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('phase-levers')).toBeVisible({ timeout: UI_READY });
}

/**
 * Sign in and land on `path`, the way a session that ended mid-page does
 * (/login?next=…). For staff this skips the teacher home, whose load reads
 * every learner in the teacher's classes one request at a time, see the note
 * in e2e/passing-work.ts on the per-route rate limit that fan-out meets.
 */
export async function signInTo(page: Page, email: string, password: string, path: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await signInAs(page, email, password);
  const target = path.split('?')[0];
  await page.waitForURL((url) => url.pathname === target, { timeout: NAVIGATION });
}

/* ------------------------- learners who join a class ------------------------ */

/**
 * A new learner who starts in a class: register, sign in, and finish the
 * one-page setup with "Join a class" and the class's code, so the project the
 * dashboard opens is the class's. Ends on the dashboard.
 */
export async function registerIntoClass(
  page: Page,
  who: { name: string; email: string; password?: string },
  joinCode: string,
): Promise<NewLearner> {
  return registerIntoClassWith(page, who, joinCode, async () => {});
}

/**
 * `registerIntoClass`, with one stop on the setup page after the class code is
 * typed and before "Start learning" is pressed, for a step that looks at that
 * page (a masked screenshot of it, for example). Ends on the dashboard.
 */
export async function registerIntoClassWith(
  page: Page,
  who: { name: string; email: string; password?: string },
  joinCode: string,
  atCodeTyped: (page: Page) => Promise<void>,
): Promise<NewLearner> {
  const learner = await registerThenSignIn(page, who);
  await page.getByRole('radio', { name: /Join a class/ }).check();
  await page.getByLabel('Class code', { exact: true }).fill(joinCode);
  await atCodeTyped(page);
  await page.getByRole('button', { name: 'Start learning', exact: true }).click();
  await page.waitForURL('**/dashboard', { timeout: NAVIGATION });
  return learner;
}
