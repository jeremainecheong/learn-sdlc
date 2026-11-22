import * as fs from 'fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN, INSTRUCTOR, registerByApi, settledSubmission, staffByApi, type ApiLearner, type StaffParty } from './passing-work';
import { LEARNER_PASSWORD, dismissPhaseTutorial, signInAs, signInTo, skipCoachMarks, skipConceptChecks } from './pw-fixtures';
import { shelfArchive, writeDeepReceiptSeam } from './upload-helpers';
import { API, assertLoopbackApi, RUN } from './support/env';
import { apiOk, useApiContext } from './support/api';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The web polish, in a browser against the suite's own
 * stack (AI stub, loopback API, no real AI call).
 *
 *  1. The Implementation room opens on Code at 1440x900: the Page preview
 *     button is on screen and one press draws the page in its frame. At
 *     1680x1050 it opens on Split, with the frame already drawn.
 *  2. Teacher home's Your classes rows and a class page's invitation card
 *     draw a masked join code. Show code reveals it; Copy code copies it
 *     without revealing it; one code shown leaves the other masked.
 *  3. The class page's quiz download is that class's file;
 *     teacher home's covers every class of the teacher.
 *
 * Nothing printed names an address, a token, an id, an email or a join code.
 */

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });

assertLoopbackApi(__filename);
const MASK = '••••-••••';
const SHAPE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const format = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);
/** One line of evidence in the test log (no email, host, id or code). */
const evidence = (what: string, data: unknown) => console.log(`WEBPOLISH ${what} ${JSON.stringify(data)}`);

const api = useApiContext();
const ok = (method: string, route: string, headers: Record<string, string>, data?: unknown) => apiOk(api(), method, route, headers, data);

/* ------------------------------ 1. the room's first view ------------------------------ */

const implementationNav = (page: Page) => page.locator('nav[aria-label="Implementation working area"]');

async function openRoom(page: Page, email: string, phaseId: string) {
  await skipConceptChecks(page);
  await skipCoachMarks(page);
  await dismissPhaseTutorial(page);
  await signInAs(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
  await page.goto(`/workspace/${phaseId}`);
  await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: NAVIGATION });
  await expect(implementationNav(page).getByRole('button', { name: 'Code', exact: true })).toBeVisible({ timeout: NAVIGATION });
}

test('1. the Implementation room opens on Code at 1440x900, the page preview one press away, and on Split at 1680x1050', async ({ page, browser }) => {
  test.setTimeout(600_000);
  const login = await ok('POST', '/auth/login', {}, { email: INSTRUCTOR.email, password: INSTRUCTOR.password });
  const staff = { authorization: `Bearer ${login.token}` };
  const made = await ok('POST', '/instructor/projects/upload', staff, { title: `Polish Shelf ${RUN}`, archiveBase64: shelfArchive().toString('base64') });
  const at = `/instructor/projects/${made.projectId}/versions/${made.versionId}`;
  const draft = await ok('GET', at, staff);
  await ok('POST', `${at}/validate`, staff);
  writeDeepReceiptSeam(made.versionId);
  await ok('POST', `${at}/validate`, staff);
  const published = await ok('POST', `${at}/publish`, staff, { version: '1.0.0', notes: 'The web polish check publishes FIX-1.' });
  const cohort = await ok('POST', '/instructor/cohorts', staff, { name: `Polish class ${RUN}` });
  await ok('PUT', `/instructor/cohorts/${cohort.id}/project`, staff, { projectVersionId: published.versionId, reason: 'The polish class works on the uploaded shelf.' });

  const email = `web-polish-${RUN}@example.test`;
  await ok('POST', '/auth/register', {}, { email, password: LEARNER_PASSWORD, displayName: `Ivo View ${RUN}` });
  const lh = { authorization: `Bearer ${(await ok('POST', '/auth/login', {}, { email, password: LEARNER_PASSWORD })).token}` };
  const me = await ok('GET', '/auth/me', lh);
  await ok('POST', '/enrollments/join', lh, { code: cohort.joinCode });
  await ok('POST', '/enrollments', lh, { projectSlug: draft.slug });
  await ok('PATCH', '/account/profile', lh, { displayName: `Ivo View ${RUN}`, onboardingCompleted: true, baseVersion: me.profileVersion || 0 });
  const mine = await ok('GET', '/enrollments/mine', lh);
  const implementation = (mine.phases as { key: string; id: string }[]).find((one) => one.key === 'implementation')!;
  await ok('POST', `/instructor/learners/${me.id}/phases/${implementation.id}/override`, staff, {
    action: 'reopen',
    reason: 'Browser proof: opened for the first-view check only; no Pass is seeded.',
  });

  // 1440x900: Code is the pressed view, the editor has the room, the frame is not drawn yet.
  await openRoom(page, email, implementation.id);
  const nav = implementationNav(page);
  await expect(nav.getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(nav.getByRole('button', { name: 'Split', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const previewButton = nav.getByRole('button', { name: 'Page preview', exact: true });
  await expect(previewButton).toBeVisible();
  await expect(page.getByTestId('page-preview-frame')).toBeHidden();
  const editorAt1440 = (await page.getByTestId('editor-host').boundingBox())?.height ?? 0;
  // One press: the page draws in its frame.
  await previewButton.click();
  await expect(previewButton).toHaveAttribute('aria-pressed', 'true');
  const frame = page.getByTestId('page-preview-frame');
  await expect(frame).toBeVisible({ timeout: NAVIGATION });
  await expect(page.frameLocator('[data-testid="page-preview-frame"]').getByRole('heading', { name: 'The shelf' })).toBeVisible({ timeout: UI_READY });
  evidence('1440x900', { opened: 'code', pagePreviewButton: true, oneClickFrame: true, editorHeightPx: Math.round(editorAt1440) });

  // 1680x1050: Split, with the frame already drawn beside the code.
  const wide = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
  try {
    const widePage = await wide.newPage();
    await openRoom(widePage, email, implementation.id);
    const wideNav = implementationNav(widePage);
    await expect(wideNav.getByRole('button', { name: 'Split', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: UI_READY });
    await expect(wideNav.getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(widePage.getByTestId('page-preview-frame')).toBeVisible({ timeout: NAVIGATION });
    await expect(widePage.getByTestId('editor-host')).toBeVisible();
    evidence('1680x1050', { opened: 'split', frameVisible: true });
  } finally {
    await wide.close();
  }
});

/* ------------------------------ 2 and 3. a teacher's two classes ------------------------------ */

const NOTICE = 'Synthetic practice quiz for the suite. It teaches nothing.';
const SAT = 'polish-check';

const quiz = () => ({
  questions: Array.from({ length: 6 }, (_, n) => ({
    id: `g${n + 1}`,
    stem: `Suite question ${n + 1}. Option A is the one this fixture keys.`,
    options: [
      { id: 'a', text: 'Option A — keyed right.' },
      { id: 'b', text: 'Option B — keyed wrong.' },
    ],
    correct: ['a'],
    explanation: `Suite explanation ${n + 1}: option A is right because the fixture says so.`,
  })),
  drawn: 4,
  shuffleOptions: true,
  passMark: 70,
  attempts: { max: 3, cooldownSeconds: null },
  criterion: 'concepts',
});

type Seated = ApiLearner & { requirementsId: string };

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let n = 0; n < text.length; n += 1) {
    const ch = text[n];
    if (quoted) {
      if (ch === '"' && text[n + 1] === '"') {
        cell += '"';
        n += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') continue;
    else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows;
  return body.map((cells) => Object.fromEntries(head.map((name, n) => [name, cells[n] ?? ''])));
}

const S: {
  teacher?: ApiLearner & StaffParty;
  classes: { id: string; name: string; joinCode: string; learner: string }[];
} = { classes: [] };

async function seedTeacher(request: APIRequestContext) {
  const admin = await staffByApi(request, ADMIN);
  const who = await registerByApi(request, { name: 'Gail Teacher', email: `web-polish-gail-${RUN}@example.test`, password: LEARNER_PASSWORD });
  const promoted = await request.patch(`${API}/admin/users/${who.userId}`, { headers: admin.headers, data: { role: 'INSTRUCTOR' } });
  expect(promoted.ok(), 'the admin makes Gail a teacher').toBeTruthy();
  const teacher = { ...who, ...(await staffByApi(request, who)) };

  const library = await (await request.get(`${API}/instructor/projects`, { headers: teacher.headers })).json();
  const platform = library.library.find((one: any) => one.isDefault);
  const created = await request.post(`${API}/instructor/projects`, {
    headers: teacher.headers,
    data: { title: 'Polish Desk', slug: `web-polish-${RUN}`.toLowerCase().slice(0, 40), fromVersionId: platform.publishedVersionId },
  });
  expect(created.ok(), 'the copy is made').toBeTruthy();
  const { project, draftVersionId } = await created.json();
  const at = `${API}/instructor/projects/${project.id}/versions/${draftVersionId}`;
  const added = await request.post(`${at}/phases/requirements/tasks`, {
    headers: teacher.headers,
    data: { taskKey: SAT, title: 'Polish check', brief: NOTICE, artefactType: 'quiz', required: false, quiz: quiz() },
  });
  expect(added.ok(), 'the quiz task is added').toBeTruthy();
  const published = await request.post(`${at}/publish`, { headers: teacher.headers, data: { version: '1.0.0', notes: 'One practice quiz.' } });
  expect(published.ok(), 'published').toBeTruthy();
  const versionId = (await published.json()).versionId as string;

  for (const [label, learnerName] of [
    ['Dawn', 'Ada Dawnfield'],
    ['Dusk', 'Ben Duskwood'],
  ] as const) {
    const name = `Polish ${label} ${RUN}`;
    const made = await (await request.post(`${API}/instructor/cohorts`, { headers: teacher.headers, data: { name } })).json();
    const assigned = await request.put(`${API}/instructor/cohorts/${made.id}/project`, {
      headers: teacher.headers,
      data: { projectVersionId: versionId, reason: 'This class sits the polish quiz.' },
    });
    expect(assigned.ok(), `${label} is given the quiz version`).toBeTruthy();
    const learner = await registerByApi(request, { email: `web-polish-${label.toLowerCase()}-${RUN}@example.test`, password: LEARNER_PASSWORD, name: learnerName });
    expect((await request.post(`${API}/enrollments/join`, { headers: learner.headers, data: { code: made.joinCode } })).ok(), `${learnerName} joins`).toBeTruthy();
    const board = await (await request.post(`${API}/enrollments`, { headers: learner.headers, data: {} })).json();
    const seated: Seated = { ...learner, requirementsId: board.phases.find((one: any) => one.key === 'requirements').id };
    const path = `${API}/phases/${seated.requirementsId}/tasks/${SAT}/quiz/attempts`;
    const opened = await request.post(path, { headers: seated.headers });
    expect(opened.ok(), `${learnerName} draws a paper`).toBeTruthy();
    const sheet = await opened.json();
    const answers = Object.fromEntries(
      (sheet.questions as any[]).map((one) => [one.id, [one.options.find((option: any) => option.text.startsWith('Option A')).id]]),
    );
    const handed = await request.post(`${path}/${sheet.attemptId}`, { headers: seated.headers, data: { answers } });
    expect(handed.ok(), `${learnerName}'s paper is handed in`).toBeTruthy();
    await settledSubmission(request, seated, (await handed.json()).id);
    S.classes.push({ id: made.id, name, joinCode: made.joinCode, learner: learnerName });
  }
  S.teacher = teacher;
}

async function downloadQuizCsv(page: Page): Promise<Record<string, string>[]> {
  await page.getByTestId('export-quiz-kind').selectOption('learners');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-quiz-results').click()]);
  expect(download.suggestedFilename()).toBe('quiz-learners.csv');
  return parseCsv(fs.readFileSync((await download.path())!, 'utf8'));
}

test('2. teacher home and a class page draw masked join codes; Show code reveals one, Copy code copies it unseen', async ({ page, request, context }) => {
  test.setTimeout(600_000);
  await seedTeacher(request);
  const [dawn, dusk] = S.classes;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signInTo(page, S.teacher!.email, S.teacher!.password, '/teacher');

  /* teacher home */
  const rowOf = (name: string) => page.locator('ul.exp-list > li', { hasText: name });
  for (const one of [dawn, dusk]) {
    await expect(rowOf(one.name).getByTestId('join-code')).toHaveText(MASK, { timeout: NAVIGATION });
  }
  const html = await page.content();
  expect(html.includes(format(dawn.joinCode)) || html.includes(dawn.joinCode), 'a code in the page before the reveal').toBe(false);
  expect(html.includes(format(dusk.joinCode)) || html.includes(dusk.joinCode), 'a code in the page before the reveal').toBe(false);
  // Controls beside the row link, never inside it.
  expect(await page.locator('a button, a [data-testid="join-code"]').count()).toBe(0);

  const dawnShow = rowOf(dawn.name).getByTestId('join-code-show');
  await expect(dawnShow).toHaveText('Show code');
  await dawnShow.click();
  await expect(dawnShow).toHaveAttribute('aria-pressed', 'true');
  await expect(rowOf(dawn.name).getByTestId('join-code')).toHaveText(SHAPE);
  expect(await rowOf(dawn.name).getByTestId('join-code').innerText()).toBe(format(dawn.joinCode));
  await expect(rowOf(dusk.name).getByTestId('join-code')).toHaveText(MASK);

  await rowOf(dusk.name).getByTestId('join-code-copy').click();
  await expect(rowOf(dusk.name).getByRole('status')).toHaveText('Copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(format(dusk.joinCode));
  await expect(rowOf(dusk.name).getByTestId('join-code')).toHaveText(MASK);
  await dawnShow.click();
  await expect(rowOf(dawn.name).getByTestId('join-code')).toHaveText(MASK);
  await expect(page.getByTestId('export-quiz-scope')).toHaveText('For every class of yours.');

  /* the class page */
  await page.goto(`/teacher/class?class=${encodeURIComponent(dawn.id)}`);
  // The join code is under the class page's Invite and notes tab.
  await page.getByTestId('class-tab-invite').click();
  const card = page.getByTestId('join-code');
  await expect(card).toHaveText(MASK, { timeout: NAVIGATION });
  await expect(page.getByTestId('join-code')).toHaveCount(1);
  expect((await page.content()).includes(format(dawn.joinCode)), 'the class code in the page before the reveal').toBe(false);
  await page.getByTestId('join-code-show').click();
  expect(await card.innerText()).toBe(format(dawn.joinCode));
  await page.getByTestId('join-code-show').click();
  await expect(card).toHaveText(MASK);
  await page.getByTestId('join-code-copy').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(format(dawn.joinCode));
  await expect(card).toHaveText(MASK);
  evidence('join-codes', { homeRowsMasked: 2, revealOne: true, copyUnseen: true, classCardMasked: true });
});

test('3. the class page saves that class quiz file; teacher home saves every class', async ({ page }) => {
  expect(S.teacher, 'test 2 seeded the teacher').toBeTruthy();
  const [dawn, dusk] = S.classes;
  await signInTo(page, S.teacher!.email, S.teacher!.password, '/teacher');
  await page.goto(`/teacher/class?class=${encodeURIComponent(dawn.id)}`);
  await expect(page.getByTestId('export-quiz-scope')).toHaveText('For this class only.', { timeout: NAVIGATION });
  const own = await downloadQuizCsv(page);
  expect(own.length, 'the class file has its learner').toBeGreaterThan(0);
  expect([...new Set(own.map((row) => row.class))]).toEqual([dawn.name]);
  expect([...new Set(own.map((row) => row.displayName))]).toEqual([dawn.learner]);

  await page.goto('/teacher');
  await expect(page.getByTestId('export-quiz-scope')).toHaveText('For every class of yours.', { timeout: NAVIGATION });
  const every = await downloadQuizCsv(page);
  expect([...new Set(every.map((row) => row.class))].sort()).toEqual([dawn.name, dusk.name].sort());
  evidence('quiz-csv', { classPageRows: own.length, classPageClasses: 1, homeRows: every.length, homeClasses: 2 });
});
