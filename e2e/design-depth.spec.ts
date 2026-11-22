import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { decidedOn } from '@learnsdlc/shared';
import { ADMIN } from './passing-work';
import { dismissPhaseTutorial, signInAs } from './pw-fixtures';
import { API, testEmail } from './support/env';
import { NAVIGATION, SANDBOX_RUN, UI_READY } from './support/timeouts';

/**
 * The design phase's depth.
 *
 * Two features, one room:
 *
 * - **the contradiction warnings**: the Review tab says, while the learner
 *   types, when an operation states the opposite of a criterion they have
 *   accepted. getOverdue's boundary clause lives in its note (D10), so a
 *   due-today clause there contradicts US-4's boundary criterion. It never
 *   blocks a submission, and it never says "nothing found" when it had
 *   nothing to look at.
 * - **the decision record**: the Decisions tab keeps each decision's choice,
 *   rationale and trade-off with its context, consequences and a status
 *   somebody has to set; accepting it stamps the day, which the dossier
 *   prints. There is no markdown page to print it into.
 *
 * The learner's own US-4 is written through the API rather than typed in the
 * requirements room: what is under test here is the Design room, and the
 * story rule needs a criterion to exist before it can quote one.
 */


const OVERRIDE_REASON =
  'Opened for the design phase walk of the decision record and the contradiction warnings.';

/** The learner's own overdue story, with the boundary criterion the rules read. */
const MY_STORY_JSON = JSON.stringify(
  {
    id: 'US-4',
    title: 'Overdue report',
    persona: 'busy learner',
    capability: 'read one report of everything late',
    benefit: 'I stop finding out from somebody else',
    criteria: [
      {
        id: 'AC-1',
        given: 'tasks whose due date has passed',
        when: 'I open the overdue report',
        then: 'every one of them is listed, newest deadline first',
        tag: 'happy',
      },
      {
        id: 'AC-2',
        given: 'a task due today',
        when: 'I open the overdue report',
        then: 'it is not overdue and does not appear',
        tag: 'boundary',
      },
    ],
    scopeExclusions: ['no email, no notifications'],
    notes: '',
  },
  null,
  2,
);

interface Phase {
  id: string;
  order: number;
  key: string;
  title: string;
}

interface Learner {
  email: string;
  password: string;
  token: string;
  userId: string;
  phases: Phase[];
}

let learner: Learner | null = null;

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/auth/login`, { data: ADMIN });
  expect(res.ok(), 'the seeded admin signs in').toBeTruthy();
  return (await res.json()).token as string;
}

/**
 * One learner for the file: enrolled, with Design reopened from `locked` (the
 * early unlock `journey.spec.ts` earns the long way), and with US-4 written on
 * the requirements phase.
 */
async function ensureLearner(request: APIRequestContext): Promise<Learner> {
  if (learner) return learner;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const who = {
    email: testEmail(`e2e-design-depth-${stamp}`),
    password: 'Correct-Horse-9',
  };
  const auth = await request.post(`${API}/auth/register`, {
    data: { email: who.email, password: who.password, displayName: 'Dev Decisions' },
  });
  expect(auth.ok(), 'the learner registers').toBeTruthy();
  const body = await auth.json();
  const token = body.token as string;
  const userId = body.user.id as string;
  const headers = { authorization: `Bearer ${token}` };
  // Setup is a page of its own; this learner has done it, so signing in
  // lands on the dashboard.
  const setup = await request.patch(`${API}/account/profile`, {
    headers,
    data: { displayName: 'Dev Decisions', onboardingCompleted: true },
  });
  expect(setup.ok(), 'the learner finishes setup').toBeTruthy();

  const enrolled = await request.post(`${API}/enrollments`, {
    headers,
    data: { projectSlug: 'tasktrackr' },
  });
  expect(enrolled.ok(), 'the learner enrols').toBeTruthy();
  const phases = (await enrolled.json()).phases as Phase[];

  const staff = { authorization: `Bearer ${await adminToken(request)}` };
  const design = phases.find((p) => p.order === 2)!;
  const opened = await request.post(
    `${API}/instructor/learners/${userId}/phases/${design.id}/override`,
    { headers: staff, data: { action: 'reopen', reason: OVERRIDE_REASON } },
  );
  expect(opened.ok(), 'the design phase opens').toBeTruthy();

  const requirements = phases.find((p) => p.order === 1)!;
  const wrote = await request.put(`${API}/phases/${requirements.id}/workspace`, {
    headers,
    data: { files: { 'requirements/story.json': MY_STORY_JSON } },
  });
  expect(wrote.ok(), 'US-4 is written').toBeTruthy();

  learner = { ...who, token, userId, phases };
  return learner;
}

const phaseOf = (l: Learner, order: number): Phase => l.phases.find((p) => p.order === order)!;

async function signIn(page: Page, who: Learner): Promise<void> {
  await dismissPhaseTutorial(page);
  await page.goto('/login');
  await signInAs(page, who.email, who.password);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
}

/**
 * Types into a design cell and leaves it.
 *
 * `fill` rather than click-then-type: at 390 the design room stacks its
 * columns and the architect's panel sits over the cell a pointer would have to
 * reach, which is a property of the room's layout rather than of anything the
 * decision record or the warnings draw. `fill` focuses the cell directly and
 * dispatches the same input React listens for.
 */
async function typeInto(page: Page, testId: string, value: string): Promise<void> {
  const cell = page.getByTestId(testId);
  await cell.fill(value);
  await cell.blur();
}

/** The room shows one tab at a time, so a spec opens the tab a control lives in before it types there. */
async function openTab(page: Page, tab: 'model' | 'api' | 'screens' | 'sequence' | 'decisions' | 'review'): Promise<void> {
  const button = page.getByTestId(`design-tab-${tab}`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function showBrief(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Show brief', exact: true });
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
}

/** listTasks is the starting record's second operation; its note can carry an ordering clause. */
const LISTING_NOTE = 'design-operation-1-note';
const LOWEST_FIRST = 'ordering: lowest priority first';
const HIGHEST_FIRST = 'ordering: high priority first, ties by ascending id';
/** getOverdue is the starting record's third operation; its note holds the boundary clause (D10). */
const OVERDUE_NOTE = 'design-operation-2-note';
const DUE_TODAY_IS_LATE = 'a task due today counts as overdue';
const DUE_TODAY_IS_NOT_LATE = 'tasks due strictly before today; a task due today is not overdue';

test('the Review tab warns when an operation contradicts a story, and stops when it is settled', async ({ page, request }) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  await signIn(page, who);
  const design = phaseOf(who, 2);

  await page.goto(`/workspace/${design.id}/design`);
  await expect(page.getByTestId('phase-design-editor')).toBeVisible({ timeout: UI_READY });
  // Nothing is contradicted yet, and the room says it looked.
  await openTab(page, 'review');
  await expect(page.getByTestId('phase-design-no-contradictions')).toBeVisible({ timeout: UI_READY });

  /* A story the Design phase lists: US-3 reads high priority tasks before medium. */
  await openTab(page, 'model');
  await typeInto(page, LISTING_NOTE, LOWEST_FIRST);
  await openTab(page, 'review');
  const ordering = page.getByTestId('phase-design-warning-ordering:listTasks');
  await expect(ordering).toBeVisible();
  await expect(ordering).toContainText('US-3');
  await expect(page.getByTestId('phase-design-contradictions')).toContainText('One to settle');

  /* The learner's own story: US-4/AC-2 says a task due today is not overdue.
     It reaches this room only through the requirements phase, so this is also
     the proof that the read behind the room works. */
  await openTab(page, 'model');
  await typeInto(page, OVERDUE_NOTE, DUE_TODAY_IS_LATE);
  await openTab(page, 'review');
  const boundary = page.getByTestId('phase-design-warning-boundary:getOverdue');
  await expect(boundary).toBeVisible();
  await expect(boundary).toContainText('your US-4/AC-2');
  await expect(page.getByTestId('phase-design-contradictions')).toContainText('Two to settle');

  /* Settling them both. */
  await openTab(page, 'model');
  await typeInto(page, LISTING_NOTE, HIGHEST_FIRST);
  await typeInto(page, OVERDUE_NOTE, DUE_TODAY_IS_NOT_LATE);
  await openTab(page, 'review');
  await expect(page.getByTestId('phase-design-no-contradictions')).toContainText('Nothing in the operations contradicts a story you accepted.');
  await expect(page.getByTestId('phase-design-warning-boundary:getOverdue')).toHaveCount(0);
  await expect(page.getByTestId('phase-design-warning-ordering:listTasks')).toHaveCount(0);
  await expect(page.getByTestId('phase-design-contradictions')).not.toContainText('to settle');
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });
});

test('a decision is recorded and accepted in the Decisions tab, and the dossier prints the day it was decided', async ({ page, request }) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  await signIn(page, who);
  const design = phaseOf(who, 2);

  await page.goto(`/workspace/${design.id}/design`);
  await expect(page.getByTestId('phase-design-editor')).toBeVisible({ timeout: UI_READY });

  await openTab(page, 'decisions');
  const card = page.getByTestId('design-decision-0');
  await typeInto(page, 'design-decision-0-title', 'Store tasks in one SQLite file');
  await typeInto(page, 'design-decision-0-choice', 'store tasks in one SQLite file');
  await typeInto(page, 'design-decision-0-rationale', 'the report has to filter and order without loading every task into memory');
  await typeInto(page, 'design-decision-0-alternative', 'a JSON file per list');
  await typeInto(page, 'design-decision-0-tradeoff', 'a schema to migrate when CR-1 lands');
  await typeInto(page, 'design-decision-0-context', 'the class machine has no database server and the report has to survive a restart');
  await typeInto(page, 'design-decision-0-consequences', 'the data file is one file to back up');
  await page.getByTestId('design-decision-0-story-US-4').click();
  await expect(page.getByTestId('design-decision-0-story-US-4')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('design-decision-0-status').selectOption('accepted');
  // Accepting stamps the day (decidedAt), and the card says it.
  // The day as the room and the dossier both print it (@learnsdlc/shared decidedOn).
  const day = decidedOn(new Date().toISOString());
  await expect(card).toContainText(`Accepted, ${day}`);
  await showBrief(page);
  await expect(page.getByTestId('phase-design-part-decisions')).toContainText('One accepted');

  /* What the floor reads: the decision has its rationale and its trade-off. */
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });
  await page.getByTestId('phase-design-render').click();
  await expect(page.getByTestId('phase-design-checks')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('phase-design-check-design.decisions.shape')).toContainText('Passed');

  // The record itself, read back the way the grader reads it: from the phase, not from the room.
  const saved = await request.get(`${API}/phases/${design.id}`, { headers: { authorization: `Bearer ${who.token}` } });
  expect(saved.ok(), 'the phase answers with its files').toBeTruthy();
  const files = (await saved.json()).files as { path: string; content: string }[];
  expect(files.some((f) => f.path.endsWith('.md') && f.path.startsWith('design/')), 'Design has no markdown page').toBe(false);
  const record = JSON.parse(files.find((f) => f.path === 'design/design.json')!.content);
  expect(record.decisions[0]).toMatchObject({ status: 'accepted', satisfies: ['US-4'], consequences: ['the data file is one file to back up'] });
  expect(record.decisions[0].decidedAt, 'accepting stamped the day').toEqual(expect.any(String));

  // The dossier prints what was handed in: the design goes to review (the stub sends it back, unmarked),
  // and the dossier prints its decision with the day it was decided.
  const handed = await request.post(`${API}/phases/${design.id}/submit`, { headers: { authorization: `Bearer ${who.token}` }, data: {} });
  expect(handed.ok(), 'the design is handed in').toBeTruthy();
  const submissionId = (await handed.json()).id as string;
  await expect
    .poll(async () => (await (await request.get(`${API}/submissions/${submissionId}`, { headers: { authorization: `Bearer ${who.token}` } })).json()).status, { timeout: SANDBOX_RUN })
    .toMatch(/^(completed|failed)$/);
  await page.goto('/dossier');
  const adr = page.getByTestId('dossier-adr-D1');
  await expect(adr).toBeVisible({ timeout: NAVIGATION });
  await expect(adr).toContainText('Store tasks in one SQLite file');
  await expect(adr).toContainText(`accepted, ${day}`);
});

test('the bare workspace path opens the Design room, which reports the contradictions it settles', async ({ page, request }) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  await signIn(page, who);
  const design = phaseOf(who, 2);

  await page.goto(`/workspace/${design.id}/design`);
  await expect(page.getByTestId('phase-design-editor')).toBeVisible({ timeout: UI_READY });
  await openTab(page, 'model');
  await typeInto(page, OVERDUE_NOTE, DUE_TODAY_IS_LATE);
  await openTab(page, 'review');
  await expect(page.getByTestId('phase-design-warning-boundary:getOverdue')).toBeVisible();
  const inTheRoom = await page.getByTestId('phase-design-contradictions').locator('[data-testid^="phase-design-warning-"][data-testid$="-open"]').count();
  expect(inTheRoom).toBeGreaterThan(0);
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });

  // A design-kind Design is never shown as files: the IDE's path opens the room,
  // and the room reads the same saved record back with the same warnings.
  await page.goto(`/workspace/${design.id}`);
  await page.waitForURL((url) => url.pathname === `/workspace/${design.id}/design`, { timeout: UI_READY });
  await expect(page.getByTestId('editor-host')).toHaveCount(0);
  await openTab(page, 'review');
  await expect(page.getByTestId('phase-design-contradictions').locator('[data-testid^="phase-design-warning-"][data-testid$="-open"]')).toHaveCount(inTheRoom, { timeout: UI_READY });

  // Put the clause back, so the next case starts from a settled record.
  await page.goto(`/workspace/${design.id}/design`);
  await openTab(page, 'model');
  await typeInto(page, OVERDUE_NOTE, DUE_TODAY_IS_NOT_LATE);
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });
});

test('the record and the warnings fit a 390 wide screen', async ({ page, request }) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, who);
  const design = phaseOf(who, 2);

  await page.goto(`/workspace/${design.id}/design`);
  await expect(page.getByTestId('phase-design-editor')).toBeVisible({ timeout: UI_READY });
  await openTab(page, 'model');
  await typeInto(page, OVERDUE_NOTE, DUE_TODAY_IS_LATE);
  await openTab(page, 'review');
  await expect(page.getByTestId('phase-design-warning-boundary:getOverdue')).toBeVisible();
  await openTab(page, 'decisions');
  await expect(page.getByTestId('design-decision-0')).toBeVisible();

  // Nothing on this page may make the document itself scroll sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'the design room does not scroll sideways at 390').toBeLessThanOrEqual(1);
});
