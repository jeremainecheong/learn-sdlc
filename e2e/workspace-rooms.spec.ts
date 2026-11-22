import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN, INSTRUCTOR } from './passing-work';
import { dismissPhaseTutorial, LEARNER_PASSWORD, signInAs } from './pw-fixtures';
import { shelfArchive, writeDeepReceiptSeam } from './upload-helpers';
import { API, testEmail } from './support/env';
import { apiOk } from './support/api';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The workspace rooms.
 *
 * Three guarantees across these five pages:
 *
 * - the design room reads the record (`design/design.json`) and the contracts
 *   the teacher switched on (`shared/contract/api.json`,
 *   `shared/contract/screens.json`), and draws a tab only for a part that is
 *   on: the Screens tab only where the screen contract is on, the Sequence
 *   diagram tab only where the sequence diagram is on. TaskTrackr 4.0.0 has
 *   both; the uploaded shelf (`sequence: false`, screens off) has neither. A
 *   learner who wrote the contract elsewhere sees this room count it.
 * - with the API unreachable, `issue`, `pr`, `matrix`, `drill` and `change`
 *   do not render one grey sentence (the browser's own "Failed to fetch")
 *   with no heading, no retry and no route back.
 * - before a learner has written a criterion the issue room shows no warn
 *   chip reading "0 criteria are not testable": an alarm about nothing.
 */


const OVERRIDE_REASON = 'Opened for the check that the design room reads the contract files.';

/** The three operations answered, as a learner who passed the gate leaves them. */
const WRITTEN_API = JSON.stringify(
  {
    version: '2.0.0',
    base: '/api',
    entities: {
      lists: { table: 'lists', fields: [{ name: 'id', type: 'integer', required: true }] },
      tasks: {
        table: 'tasks',
        fields: [
          { name: 'id', type: 'integer', required: true },
          { name: 'title', type: 'string', required: true },
          { name: 'due_date', type: 'date', required: false },
          { name: 'status', type: 'string', required: true },
          { name: 'list_id', type: 'integer', required: true },
        ],
      },
    },
    operations: [
      {
        id: 'completeTask',
        method: 'PATCH',
        path: '/api/tasks/{id}',
        summary: 'Close a task. Completing twice changes nothing.',
        satisfies: ['US-2'],
        parameters: [{ name: 'id', type: 'integer', description: 'the task to close' }],
        success: { status: 200, body: 'Task' },
        failures: [{ status: 404, code: 'task_not_found', when: 'no task carries that id' }],
      },
      {
        id: 'listTasks',
        method: 'GET',
        path: '/api/lists/{listId}/tasks',
        summary: 'The tasks of one list, filtered, searched and ordered.',
        satisfies: ['US-3'],
        parameters: [{ name: 'status', type: 'string', description: 'all, open or done' }],
        success: { status: 200, body: 'Task[]' },
        failures: [{ status: 400, code: 'bad_status', when: 'status is outside the three names' }],
      },
      {
        id: 'getOverdue',
        method: 'GET',
        path: '/api/overdue',
        summary: 'Every task past its due date, oldest deadline first.',
        satisfies: ['US-4'],
        parameters: [{ name: 'today', type: 'date', description: 'the day to measure against' }],
        success: { status: 200, body: 'Task[]' },
        failures: [{ status: 400, code: 'bad_date', when: 'today is not a date' }],
      },
    ],
    errors: {
      task_not_found: { status: 404, meaning: 'No task carries that id.' },
      bad_status: { status: 400, meaning: 'The status asked for is not one of the three.' },
      bad_date: { status: 400, meaning: 'The date asked for is not a date.' },
    },
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
 * One learner for the file: enrolled, with the design phase reopened, and with
 * the HTTP contract written straight into the workspace, which is exactly
 * what a learner who wrote it in the IDE leaves behind, and what the design
 * room has to read.
 */
async function ensureLearner(request: APIRequestContext): Promise<Learner> {
  if (learner) return learner;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const who = { email: testEmail(`e2e-workspace-rooms-${stamp}`), password: 'Correct-Horse-9' };
  const auth = await request.post(`${API}/auth/register`, {
    data: { email: who.email, password: who.password, displayName: 'Gee Two' },
  });
  expect(auth.ok(), 'the learner registers').toBeTruthy();
  const body = await auth.json();
  const token = body.token as string;
  const userId = body.user.id as string;
  const headers = { authorization: `Bearer ${token}` };
  // Setup is a page of its own; this learner has done it.
  const setup = await request.patch(`${API}/account/profile`, {
    headers,
    data: { displayName: 'Gee Two', onboardingCompleted: true },
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
  // The later rooms are gated by the shell (a locked phase is answered by
  // the layout, not by its room), so the rooms the last case walks are opened
  // the same way, as explicit setup.
  for (const order of [3, 4, 5, 6]) {
    const later = phases.find((p) => p.order === order)!;
    const reopened = await request.post(
      `${API}/instructor/learners/${userId}/phases/${later.id}/override`,
      { headers: staff, data: { action: 'reopen', reason: OVERRIDE_REASON } },
    );
    expect(reopened.ok(), `phase ${order} opens`).toBeTruthy();
  }

  const wrote = await request.put(`${API}/phases/${design.id}/workspace`, {
    headers,
    data: { files: { 'shared/contract/api.json': WRITTEN_API } },
  });
  expect(wrote.ok(), 'the HTTP contract is written').toBeTruthy();

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

test('the design room reads the record and the contracts that are on, with a tab for each part that is on', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  await signIn(page, who);
  const design = phaseOf(who, 2);

  await page.goto(`/workspace/${design.id}/design`);
  await expect(page.getByTestId('phase-design-editor')).toBeVisible({ timeout: UI_READY });

  // TaskTrackr 4.0.0 switches both contracts and the sequence diagram on: every tab is drawn.
  for (const tab of ['model', 'api', 'screens', 'sequence', 'decisions', 'review']) {
    await expect(page.getByTestId(`design-tab-${tab}`), `${tab} is a tab`).toBeVisible();
  }

  // The parts list (in the brief column) counts the record and both contracts,
  // the API contract as the learner wrote it (three endpoints), not the starting point.
  await page.getByRole('button', { name: 'Show brief', exact: true }).click();
  await expect(page.getByTestId('phase-design-part-data-model')).toContainText('One entity, one attribute');
  await expect(page.getByTestId('phase-design-part-operations')).toContainText('Three operations');
  await expect(page.getByTestId('phase-design-part-api-contract')).toContainText('Three endpoints');
  await expect(page.getByTestId('phase-design-part-screens')).toContainText('Three screens');

  // The API contract tab opens the contract the learner wrote, by its operations.
  await page.getByTestId('design-tab-api').click();
  const operations = page.getByRole('navigation', { name: 'API operations' });
  for (const op of ['completeTask', 'listTasks', 'getOverdue']) {
    await expect(operations.getByRole('button', { name: new RegExp(`${op}$`) })).toBeVisible();
  }
  await expect(page.getByTestId('phase-design-editor')).not.toContainText('.json');
});

test('a design room draws no Screens tab and no Sequence diagram tab where those parts are off (the uploaded shelf)', async ({ page }) => {
  const login = await page.request.post(`${API}/auth/login`, { data: { email: INSTRUCTOR.email, password: INSTRUCTOR.password } });
  expect(login.ok(), 'the seeded instructor signs in').toBeTruthy();
  const staff = { authorization: `Bearer ${(await login.json()).token}` };
  const ok = (method: string, route: string, headers: Record<string, string>, data?: unknown) => apiOk(page.request, method, route, headers, data);
  const stamp = `${Date.now()}`.slice(-8);
  const made = await ok('POST', '/instructor/projects/upload', staff, { title: `Rooms Shelf ${stamp}`, archiveBase64: shelfArchive().toString('base64') });
  const at = `/instructor/projects/${made.projectId}/versions/${made.versionId}`;
  const draft = await ok('GET', at, staff);
  const checks = draft.phases.find((one: any) => one.key === 'design')?.tasks?.[0]?.design;
  expect(checks?.sequence, "the shelf's sequence diagram is off").toBe(false);
  expect(checks?.contracts, "the shelf's screen contract is off").toMatchObject({ api: true, screens: false });
  await ok('POST', `${at}/validate`, staff);
  writeDeepReceiptSeam(made.versionId);
  await ok('POST', `${at}/validate`, staff);
  const published = await ok('POST', `${at}/publish`, staff, { version: '1.0.0', notes: 'The room tabs check publishes FIX-1.' });
  const cohort = await ok('POST', '/instructor/cohorts', staff, { name: `Rooms tabs ${stamp}` });
  await ok('PUT', `/instructor/cohorts/${cohort.id}/project`, staff, { projectVersionId: published.versionId, reason: 'The room tabs class works on the uploaded shelf.' });

  const email = `workspace-rooms-shelf-${stamp}@example.test`;
  await ok('POST', '/auth/register', {}, { email, password: LEARNER_PASSWORD, displayName: `Gee Shelf ${stamp}` });
  const lh = { authorization: `Bearer ${(await ok('POST', '/auth/login', {}, { email, password: LEARNER_PASSWORD })).token}` };
  const me = await ok('GET', '/auth/me', lh);
  await ok('POST', '/enrollments/join', lh, { code: cohort.joinCode });
  await ok('POST', '/enrollments', lh, { projectSlug: draft.slug });
  await ok('PATCH', '/account/profile', lh, { displayName: `Gee Shelf ${stamp}`, onboardingCompleted: true, baseVersion: me.profileVersion || 0 });
  const mine = await ok('GET', '/enrollments/mine', lh);
  const design = (mine.phases as { key: string; id: string }[]).find((one) => one.key === 'design')!;
  await ok('POST', `/instructor/learners/${me.id}/phases/${design.id}/override`, staff, { action: 'reopen', reason: OVERRIDE_REASON });

  await dismissPhaseTutorial(page);
  await signInAs(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
  await page.goto(`/workspace/${design.id}/design`);
  await expect(page.getByTestId('phase-design-editor')).toBeVisible({ timeout: NAVIGATION });
  for (const tab of ['model', 'api', 'decisions', 'review']) {
    await expect(page.getByTestId(`design-tab-${tab}`), `${tab} is a tab`).toBeVisible();
  }
  await expect(page.getByTestId('design-tab-screens'), 'no Screens tab: the screen contract is off').toHaveCount(0);
  await expect(page.getByTestId('design-tab-sequence'), 'no Sequence diagram tab: the sequence diagram is off').toHaveCount(0);
});

test('an identifier in the design room never breaks inside the word', async ({ page, request }) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  await signIn(page, who);
  const design = phaseOf(who, 2);
  await page.goto(`/workspace/${design.id}/design`);
  await expect(page.getByTestId('phase-design-editor')).toBeVisible({ timeout: UI_READY });
  await page.getByTestId('design-tab-api').click();

  // An operation's id is one word: it takes one line in the workbench's list.
  const name = page
    .getByRole('navigation', { name: 'API operations' })
    .getByRole('button', { name: /completeTask$/ })
    .locator('span')
    .first();
  await expect(name).toHaveText('completeTask');
  const rects = await name.evaluate((el) => el.getClientRects().length);
  expect(rects).toBe(1);
});

test('the issue room does not raise an alarm about criteria nobody has written', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  await signIn(page, who);
  const requirements = phaseOf(who, 1);

  // The issue is the Requirements room's backlog tab.
  await page.goto(`/workspace/${requirements.id}/issue`);
  const backlog = page.getByTestId('requirements-backlog-panel');
  await expect(backlog).toBeVisible({ timeout: UI_READY });
  const strip = page.getByTestId('phase-strip');
  await expect(strip).toBeVisible();
  await expect(strip).not.toContainText('0 criteria are not testable');
  await expect(backlog).not.toContainText('0 of 0 runnable');
});

test('every room says what happened when the phase will not load, and offers a way on', async ({
  page,
  request,
}) => {
  const who = await ensureLearner(request);
  await signIn(page, who);

  const testing = phaseOf(who, 4);
  const deployment = phaseOf(who, 5);
  const maintenance = phaseOf(who, 6);
  const implementation = phaseOf(who, 3);

  const requirements = phaseOf(who, 1);
  const rooms: { path: string; id: string }[] = [
    { path: `/workspace/${requirements.id}/issue`, id: 'requirements-workspace' },
    { path: `/workspace/${implementation.id}/pr`, id: 'pr-page' },
    { path: `/workspace/${testing.id}/matrix`, id: 'matrix-page' },
    { path: `/workspace/${deployment.id}/drill`, id: 'drill-page' },
    { path: `/workspace/${maintenance.id}/change`, id: 'change-loading' },
  ];

  // Each phase's own endpoint alone: the session stays valid, and the shell's
  // one request for every open phase (/phases/summaries) is left alone too, so
  // what is under test is the room's own answer rather than the shell's.
  const own = new RegExp(`/api/v1/phases/(${[requirements, implementation, testing, deployment, maintenance].map((p) => p.id).join('|')})`);
  await page.route(own, (route) => route.abort('failed'));

  for (const room of rooms) {
    await page.goto(room.path);
    // A room opens from the shell's own copy of its phase (the one
    // /phases/summaries request), so a room whose own requests fail either
    // falls back whole (room-error, with a retry and a way back) or, when the
    // shell's copy is enough to draw it, says what failed inline. Either way it
    // says so in words, never in the browser's, and keeps its heading. The
    // Requirements room has two panes, each with its own; the one on screen is read.
    const said = page
      .locator('[data-testid="room-error"]:visible, [role="alert"]:visible')
      .filter({ hasText: 'reach the server' })
      .first();
    await expect(said, `${room.path} says what happened`).toBeVisible({ timeout: UI_READY });
    // Never the browser talking to itself.
    await expect(page.locator('body')).not.toContainText('Failed to fetch');
    if (await page.locator('[data-testid="room-error"]:visible').count()) {
      await expect(page.locator('[data-testid="room-retry"]:visible').first(), `${room.path} offers a retry`).toBeVisible();
      await expect(page.locator('[data-testid="room-back"]:visible').first(), `${room.path} offers a way back`).toBeVisible();
    }
    // The room keeps a heading rather than becoming a blank page.
    expect(await page.locator('h1').count(), `${room.path} keeps a heading`).toBeGreaterThan(0);
  }

  // And the retry is a retry: with the route lifted, pressing it loads the room.
  await page.goto(`/workspace/${requirements.id}/issue`);
  await expect(page.locator('[data-testid="room-retry"]:visible').first()).toBeVisible({ timeout: UI_READY });
  await page.unroute(own);
  await page.locator('[data-testid="room-retry"]:visible').first().click();
  await expect(page.getByTestId('phase-strip')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('room-error')).toHaveCount(0);
});
