import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { dismissPhaseTutorial, signInAs, teacherHome } from './pw-fixtures';
import { INSTRUCTOR, registerByApi } from './passing-work';
import { API, testEmail } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * The bell as a learner and their instructor actually use it.
 *
 * The journey underneath every case here is the same one: an instructor
 * watching the console notices somebody who needs a word, writes them a note,
 * and the learner finds it in the bell on their next page rather than in an
 * inbox nobody opens. So the notifications are created over the API, which is
 * what the running product does too, from the grading pipeline and the sweep,
 * and the browser is only ever asked what the panel shows.
 */

const STAMP = Date.now();
const LEARNER = {
  name: 'Nadia Bell',
  email: testEmail(`e2e-bell-${STAMP}`),
  password: 'Correct-Horse-9',
};
const CLASS_NAME = `E2E bell class ${STAMP}`;

test.describe.configure({ mode: 'serial' });

interface Party {
  token: string;
  headers: { authorization: string };
}

async function signInApi(request: APIRequestContext, email: string, password: string): Promise<Party> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password } });
  expect(res.ok(), `${email} signs in`).toBeTruthy();
  const token = (await res.json()).token as string;
  return { token, headers: { authorization: `Bearer ${token}` } };
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await signInAs(page, email, password);
}


/** The whole cast: a class, a learner in it, and both sets of credentials. */
async function cast(request: APIRequestContext): Promise<{
  staff: Party;
  learner: Party;
  learnerId: string;
  phaseId: string;
}> {
  const staff = await signInApi(request, INSTRUCTOR.email, INSTRUCTOR.password);
  const madeClass = await request.post(`${API}/instructor/cohorts`, {
    headers: staff.headers,
    data: { name: CLASS_NAME },
  });
  expect(madeClass.ok(), 'the class is created').toBeTruthy();
  const joinCode = (await madeClass.json()).joinCode as string;

  const registered = await request.post(`${API}/auth/register`, {
    data: { email: LEARNER.email, password: LEARNER.password, displayName: LEARNER.name },
  });
  expect(registered.ok(), 'the learner registers').toBeTruthy();
  const body = await registered.json();
  const learner: Party = {
    token: body.token,
    headers: { authorization: `Bearer ${body.token}` },
  };
  const learnerId = body.user.id as string;
  // Setup is a page of its own; this learner has done it.
  const setup = await request.patch(`${API}/account/profile`, {
    headers: learner.headers,
    data: { displayName: LEARNER.name, onboardingCompleted: true },
  });
  expect(setup.ok(), 'the learner finishes setup').toBeTruthy();

  await request.post(`${API}/enrollments/join`, { headers: learner.headers, data: { code: joinCode } });
  const enrolled = await request.post(`${API}/enrollments`, {
    headers: learner.headers,
    data: { projectSlug: 'tasktrackr' },
  });
  expect(enrolled.ok(), 'the learner enrols').toBeTruthy();
  const phases = (await enrolled.json()).phases as { id: string; key: string }[];
  const phaseId = phases.find((p) => p.key === 'requirements')!.id;

  return { staff, learner, learnerId, phaseId };
}

const note = (request: APIRequestContext, staff: Party, learnerId: string, text: string, phaseStateId?: string) =>
  request.post(`${API}/instructor/learners/${learnerId}/note`, {
    headers: staff.headers,
    data: phaseStateId ? { text, phaseStateId } : { text },
  });

test('the bell counts a note and the panel opens it', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { staff, learnerId, phaseId } = await cast(request);

  await dismissPhaseTutorial(page);
  await signIn(page, LEARNER.email, LEARNER.password);
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
  // The badge counts the plan's unfinished steps as well as the unread notes,
  // and the plan needs the shell's phases. Read it once that has landed rather
  // than at the first frame of the page, or `before` is whatever the count
  // happened to be mid-load and the last assertion here compares against it.
  await expect(page.getByTestId('tile-checklist')).toBeVisible({ timeout: UI_READY });

  const bell = page.getByTestId('bell');
  const before = Number((await bell.innerText()).trim() || '0');
  expect(before, 'the plan the badge counts is on the page').toBeGreaterThan(0);

  const sent = await note(
    request,
    staff,
    learnerId,
    'Read the boundary rule again before you resubmit.',
    phaseId,
  );
  expect(sent.ok(), 'the instructor writes a note').toBeTruthy();

  // The socket carries it into an open tab; a reload is the fallback for a
  // socket that is not there, and this spec must pass either way.
  await page.reload();
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
  await expect(bell).toHaveText(String(before + 1));

  await bell.click();
  const panel = page.getByTestId('bell-panel');
  await expect(panel).toBeVisible();
  const row = panel.getByTestId('bell-note');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('A note from');

  await row.click();
  await page.waitForURL(`**/workspace/${phaseId}**`);
  // Reading it is what marks it read, so the badge is back where it started.
  await expect(bell).toHaveText(before ? String(before) : '');
});

test('marking all as read empties the new block and leaves the plan steps', async ({ page, request }) => {
  test.setTimeout(240_000);
  const staff = await signInApi(request, INSTRUCTOR.email, INSTRUCTOR.password);
  const me = await signInApi(request, LEARNER.email, LEARNER.password);
  const profile = await request.get(`${API}/auth/me`, { headers: me.headers });
  const learnerId = (await profile.json()).id as string;

  await note(request, staff, learnerId, 'One thing to look at before Thursday.');
  await note(request, staff, learnerId, 'And a second thing, on the acceptance criteria.');

  await dismissPhaseTutorial(page);
  await signIn(page, LEARNER.email, LEARNER.password);
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });

  await page.getByTestId('bell').click();
  const panel = page.getByTestId('bell-panel');
  await expect(panel.getByTestId('bell-note')).toHaveCount(2);
  const steps = await panel.getByTestId('bell-item').count();

  await panel.getByTestId('bell-mark-all').click();
  await expect(panel.getByTestId('bell-note')).toHaveCount(0);
  // The plan is not news and is not cleared by reading the news.
  await expect(panel.getByTestId('bell-item')).toHaveCount(steps);
});

test('the bell says nothing is waiting when there is nothing', async ({ page, request }) => {
  test.setTimeout(240_000);
  const quiet = {
    name: 'Quiet Quinn',
    email: testEmail(`e2e-bell-quiet-${STAMP}`),
    password: 'Correct-Horse-9',
  };
  // Registered and set up, with no project started.
  await registerByApi(request, quiet);

  await dismissPhaseTutorial(page);
  await signIn(page, quiet.email, quiet.password);
  // Not `dashboard-title`: a learner who has not enrolled is offered the two
  // projects instead, and the bell is the thing under test either way.
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
  const bell = page.getByTestId('bell');
  await expect(bell).toBeVisible({ timeout: UI_READY });
  // The control names itself first, then the state (the title keeps the state alone).
  await expect(bell).toHaveAttribute('aria-label', 'Notifications: Nothing is waiting on you');

  await bell.click();
  await expect(page.getByTestId('bell-empty')).toHaveText('Nothing is waiting on you');
});

test('an instructor s bell shows the class and opens a learner', async ({ page, request }) => {
  test.setTimeout(240_000);
  const me = await signInApi(request, LEARNER.email, LEARNER.password);
  const profile = await request.get(`${API}/auth/me`, { headers: me.headers });
  const learnerId = (await profile.json()).id as string;

  // The learner asks for help, which is the class kind an instructor is told
  // about the moment it happens rather than when they next open the console.
  const enrolment = await request.get(`${API}/enrollments/mine?project=tasktrackr`, {
    headers: me.headers,
  });
  const phases = (await enrolment.json()).phases as { id: string; key: string }[];
  const phaseId = phases.find((p) => p.key === 'requirements')!.id;
  const raised = await request.post(`${API}/phases/${phaseId}/stuck`, {
    headers: me.headers,
    data: {
      question: 'I cannot tell whether a task due today belongs in the overdue report',
      tried: 'I read the backlog and asked the mentor.',
    },
  });
  expect(raised.ok(), 'the learner raises a flag').toBeTruthy();

  await dismissPhaseTutorial(page);
  await signIn(page, INSTRUCTOR.email, INSTRUCTOR.password);
  await teacherHome(page);

  await page.getByTestId('bell').click();
  const panel = page.getByTestId('bell-panel');
  const row = panel.getByTestId('bell-note').filter({ hasText: LEARNER.name }).first();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('href', `/instructor/learners/${learnerId}`);

  // An instructor has no enrolment, so the plan block never draws for them and
  // the foot link is their class rather than a workspace they do not have.
  await expect(panel.getByTestId('bell-item')).toHaveCount(0);
  await expect(panel.getByTestId('bell-open-workspace')).toHaveText(/Open my classes/);
});

test('the panel fits a phone', async ({ page, request }) => {
  test.setTimeout(240_000);
  const staff = await signInApi(request, INSTRUCTOR.email, INSTRUCTOR.password);
  const me = await signInApi(request, LEARNER.email, LEARNER.password);
  const profile = await request.get(`${API}/auth/me`, { headers: me.headers });
  const learnerId = (await profile.json()).id as string;
  await note(
    request,
    staff,
    learnerId,
    'A note long enough that a panel which does not wrap would push the page sideways.',
  );

  await dismissPhaseTutorial(page);
  await signIn(page, LEARNER.email, LEARNER.password);
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });

  // The two the rest of the suite calls a phone: `e2e/small-screen.spec.ts`'s
  // PHONE and NARROW. The panel is 320 wide by design, so the narrow one is
  // the size that says whether it is capped at the viewport or merely lucky.
  for (const size of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(size);
    await page.getByTestId('bell').click();
    const panel = page.getByTestId('bell-panel');
    await expect(panel).toBeVisible();

    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement as HTMLElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow, `${size.width}: the page never scrolls sideways with the panel open`).toBeLessThanOrEqual(1);

    const box = (await panel.boundingBox())!;
    expect(box.x, `${size.width}: the panel starts inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${size.width}: and ends inside it`).toBeLessThanOrEqual(size.width + 1);

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  }
});
