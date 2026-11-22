import * as fs from 'fs';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { LEARNER_PASSWORD, signInTo } from './pw-fixtures';
import { ADMIN, registerByApi, settledSubmission, staffByApi, type ApiLearner, type SettledSubmission, type StaffParty } from './passing-work';
import { AI_STUB_URL, API, RUN_ID } from './support/env';
import { NAVIGATION } from './support/timeouts';

/**
 * A teacher opens a class's quiz results from the class page and reads them
 * as charts (route, client and page together), against the suite's own stack.
 *
 * Seeded through the API the way quiz-reveal.spec.ts seeds a quiz (a copy of
 * the platform project with quiz tasks, published and given to a class):
 *   - Ada sits two papers: 50 (not passed), then 75 (passed);
 *   - Ben sits one paper: 50 (not yet passed);
 *   - Cy opens a paper the teacher's task reset voids, then sits 75 (passed);
 *   - Dee joins and starts the project but sits nothing;
 *   - a second quiz on the version is never sat ("No attempts yet.").
 *
 * The page's numbers are read from the screen and compared with the four
 * class-scoped CSV files fetched in the same test (the summary and the files
 * are counted by the same code, so they must agree). Then: a second teacher
 * gets nothing for this class, a learner is sent to the dashboard, an empty
 * class says so, axe (WCAG A/AA, serious and critical) is clean at 1280 and at
 * 390 wide with no sideways scroll at 390, every table scroll box is a named,
 * focusable region at 390 (keyboard users can scroll it), the AI stub's counts
 * do not move across the dashboard steps, and the page reads the summary once.
 */

let RUN = RUN_ID;
test.beforeEach(async ({}, testInfo) => {
  RUN = testInfo.retry ? `${RUN_ID}-r${testInfo.retry}` : RUN_ID;
});

const AI_COUNTS = `${AI_STUB_URL}/__stub/counts`;
const NOTICE = 'Synthetic practice quiz for the suite. It teaches nothing.';
const SAT = 'results-check';
const NEVER = 'results-later';
const SAT_TITLE = 'Results check';
const NEVER_TITLE = 'Results later';
/** WCAG 2.0/2.1 A and AA, serious and critical: e2e/a11y-axe.spec.ts's and teacher-guide.spec.ts's scope. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const AXE_FAILING = new Set(['serious', 'critical']);
const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const questions = (prefix: string) =>
  Array.from({ length: 6 }, (_, at) => ({
    id: `${prefix}${at + 1}`,
    stem: `Suite question ${at + 1}. Option A is the one this fixture keys.`,
    options: [
      { id: 'a', text: 'Option A — keyed right.' },
      { id: 'b', text: 'Option B — keyed wrong.' },
    ],
    correct: ['a'],
    explanation: `Suite explanation ${at + 1}: option A is right because the fixture says so.`,
  }));

const quiz = (prefix: string) => ({
  questions: questions(prefix),
  drawn: 4,
  shuffleOptions: true,
  passMark: 70,
  attempts: { max: 3, cooldownSeconds: null },
  criterion: 'concepts',
});

/* ------------------------------ CSV ------------------------------ */

/** RFC 4180, as the service writes it (quoted cells, doubled quotes, CRLF). */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const ch = text[at];
    if (quoted) {
      if (ch === '"' && text[at + 1] === '"') {
        cell += '"';
        at += 1;
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
  return body.map((cells) => Object.fromEntries(head.map((name, at) => [name, cells[at] ?? ''])));
}

/** csvCell's formula guard, undone: a leading apostrophe before = + - @ tab CR. */
const unguard = (value: string) => (/^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value);

const round1 = (n: number) => Math.round(n * 10) / 10;
const shown = (n: number | null) => (n === null ? '—' : String(round1(n)));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const band = (score: number) => (score < 20 ? '0-19' : score < 40 ? '20-39' : score < 60 ? '40-59' : score < 80 ? '60-79' : '80-100');

/* ------------------------------ seeding ------------------------------ */

async function newTeacher(request: APIRequestContext, admin: StaffParty, label: string): Promise<ApiLearner & StaffParty> {
  const who = await registerByApi(request, { name: `${label} Teacher`, email: `results-${label.toLowerCase()}-${RUN}@example.test`, password: LEARNER_PASSWORD });
  const promoted = await request.patch(`${API}/admin/users/${who.userId}`, { headers: admin.headers, data: { role: 'INSTRUCTOR' } });
  expect(promoted.ok(), `the admin makes ${label} a teacher`).toBeTruthy();
  const staff = await staffByApi(request, who);
  return { ...who, ...staff };
}

async function publishedQuizzes(request: APIRequestContext, staff: StaffParty): Promise<string> {
  const library = await (await request.get(`${API}/instructor/projects`, { headers: staff.headers })).json();
  const platform = library.library.find((one: any) => one.isDefault);
  const created = await request.post(`${API}/instructor/projects`, {
    headers: staff.headers,
    data: { title: 'Results Desk', slug: `results-quiz-${RUN}`.toLowerCase().slice(0, 40), fromVersionId: platform.publishedVersionId },
  });
  expect(created.ok(), 'the copy is made').toBeTruthy();
  const { project, draftVersionId } = await created.json();
  const at = `${API}/instructor/projects/${project.id}/versions/${draftVersionId}`;
  for (const [taskKey, title, prefix] of [
    [SAT, SAT_TITLE, 'q'],
    [NEVER, NEVER_TITLE, 'w'],
  ] as const) {
    const added = await request.post(`${at}/phases/requirements/tasks`, {
      headers: staff.headers,
      data: { taskKey, title, brief: NOTICE, artefactType: 'quiz', required: false, quiz: quiz(prefix) },
    });
    expect(added.ok(), `${taskKey} is added`).toBeTruthy();
  }
  const published = await request.post(`${at}/publish`, { headers: staff.headers, data: { version: '1.0.0', notes: 'Two practice quizzes.' } });
  expect(published.ok(), 'published').toBeTruthy();
  return (await published.json()).versionId as string;
}

type Seated = ApiLearner & { requirementsId: string };

async function learnerIn(request: APIRequestContext, joinCode: string, name: string): Promise<Seated> {
  const learner = await registerByApi(request, { email: `results-${name.split(' ')[0].toLowerCase()}-${RUN}@example.test`, password: LEARNER_PASSWORD, name });
  expect((await request.post(`${API}/enrollments/join`, { headers: learner.headers, data: { code: joinCode } })).ok(), `${name} joins`).toBeTruthy();
  const board = await (await request.post(`${API}/enrollments`, { headers: learner.headers, data: {} })).json();
  return { ...learner, requirementsId: board.phases.find((one: any) => one.key === 'requirements').id as string };
}

const paperPath = (who: Seated) => `${API}/phases/${who.requirementsId}/tasks/${SAT}/quiz/attempts`;

/** A quiz paper as the API draws it: its attempt and each question's options. */
interface QuizPaper {
  attemptId: string;
  questions: { id: string; options: { id: string; text: string }[] }[];
}

async function openPaper(request: APIRequestContext, who: Seated): Promise<QuizPaper> {
  const opened = await request.post(paperPath(who), { headers: who.headers });
  expect(opened.ok(), `${who.name} draws a paper`).toBeTruthy();
  return opened.json();
}

/** Hand a paper in with `right` of its questions answered right; returns the settled verdict. */
async function sit(request: APIRequestContext, who: Seated, right: number, paper?: QuizPaper): Promise<SettledSubmission> {
  const sheet = paper ?? (await openPaper(request, who));
  const answers = Object.fromEntries(
    sheet.questions.map((one, index) => [
      one.id,
      [one.options.find((option) => option.text.startsWith(index < right ? 'Option A' : 'Option B'))!.id],
    ]),
  );
  const handed = await request.post(`${paperPath(who)}/${sheet.attemptId}`, { headers: who.headers, data: { answers } });
  expect(handed.ok(), `${who.name}'s paper is handed in`).toBeTruthy();
  return settledSubmission(request, who, (await handed.json()).id);
}

/* ------------------------------ page reads ------------------------------ */

/** A table's body rows (header cell + data cells) by textContent, so a closed <details> still reads. */
const tableRows = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((root) =>
    Array.from(root.querySelectorAll('table tbody tr')).map((tr) => Array.from(tr.children).map((cell) => (cell.textContent ?? '').trim())),
  );

const cardStats = (page: Page, taskKey: string) =>
  page.getByTestId(`quiz-card-${taskKey}`).evaluate((card) =>
    Object.fromEntries(Array.from(card.querySelectorAll('dl > div')).map((pair) => [pair.querySelector('dt')!.textContent!.trim(), pair.querySelector('dd')!.textContent!.trim()])),
  );

type Violation = { id: string; impact: string | null; count: number; targets: string[] };

/** axe-core injected (as teacher-guide.spec.ts does), every <details> opened first. */
async function runAxe(page: Page): Promise<Violation[]> {
  await page.evaluate(() => document.querySelectorAll('details').forEach((one) => ((one as HTMLDetailsElement).open = true)));
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async (tags) => {
    const axe = (window as unknown as { axe: any }).axe;
    const r = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return r.violations.map((v: any) => ({
      id: v.id,
      impact: v.impact ?? null,
      count: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n: any) => [].concat(n.target).join(' ')),
    }));
  }, AXE_TAGS);
}
const failing = (violations: Violation[]) => violations.filter((v) => AXE_FAILING.has(v.impact ?? '')).map((v) => `${v.id} (${v.impact}, ${v.count}): ${v.targets.join(' | ')}`);

async function stubCounts(request: APIRequestContext): Promise<Record<string, number>> {
  const res = await request.get(AI_COUNTS);
  expect(res.ok(), 'the AI stub answers its counts').toBeTruthy();
  return (await res.json()).counts;
}

async function signedInPage(browser: Browser, email: string, password: string, path: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInTo(page, email, password, path);
  return page;
}

/** One line of evidence in the test log (no email, host or id). */
const evidence = (what: string, data: unknown) => console.log(`QUIZRESULTS ${what} ${JSON.stringify(data)}`);

/* ------------------------------ the journey ------------------------------ */

test('a teacher reads a class quiz results as charts, and the numbers equal the class files', async ({ page, request, browser }) => {
  test.setTimeout(600_000);
  const admin = await staffByApi(request, ADMIN);
  const teacher = await newTeacher(request, admin, 'Tara');
  const other = await newTeacher(request, admin, 'Omar');

  const className = `Quiz Results ${RUN}`;
  const made = await (await request.post(`${API}/instructor/cohorts`, { headers: teacher.headers, data: { name: className } })).json();
  const classId = made.id as string;
  const versionId = await publishedQuizzes(request, teacher);
  expect(
    (await request.put(`${API}/instructor/cohorts/${classId}/project`, { headers: teacher.headers, data: { projectVersionId: versionId, reason: 'This class sits the results quizzes.' } })).ok(),
    'the class is given the quiz version',
  ).toBeTruthy();
  const emptyClass = await (await request.post(`${API}/instructor/cohorts`, { headers: teacher.headers, data: { name: `Quiz Empty ${RUN}` } })).json();

  const ada = await learnerIn(request, made.joinCode, 'Ada Quill');
  const ben = await learnerIn(request, made.joinCode, 'Ben Marsh');
  const cy = await learnerIn(request, made.joinCode, 'Cy Rowan');
  const dee = await learnerIn(request, made.joinCode, 'Dee Lowe');

  expect((await sit(request, ada, 2)).passed, 'Ada 50: not passed').toBe(false);
  expect((await sit(request, ada, 3)).passed, 'Ada 75: passed').toBe(true);
  expect((await sit(request, ben, 2)).passed, 'Ben 50: not yet passed').toBe(false);
  await openPaper(request, cy);
  const reset = await request.post(`${API}/instructor/learners/${cy.userId}/phases/${cy.requirementsId}/override`, {
    headers: teacher.headers,
    data: { action: 'task-reset', reason: 'Start the results check again for this learner.', taskKey: SAT },
  });
  expect(reset.ok(), 'the reset voids the open paper').toBeTruthy();
  expect((await sit(request, cy, 3)).passed, 'Cy 75 after the reset: passed').toBe(true);
  void dee;

  // The four class-scoped files, fetched in this test: the reference the page must equal.
  const csv: Record<string, Record<string, string>[]> = {};
  for (const kind of ['learners', 'attempts', 'questions', 'class'] as const) {
    const res = await request.get(`${API}/instructor/quiz-results/${kind}.csv?cohort=${encodeURIComponent(classId)}`, { headers: teacher.headers });
    expect(res.status(), `${kind}.csv for the class`).toBe(200);
    csv[kind] = parseCsv(await res.text());
  }
  const learnersRows = csv.learners.filter((row) => row.taskKey === SAT);
  const attemptsRows = csv.attempts.filter((row) => row.taskKey === SAT);
  const questionRows = csv.questions.filter((row) => row.taskKey === SAT);
  const classRows = csv.class.filter((row) => row.taskKey === SAT);
  // The seed itself, as the files record it.
  expect(learnersRows.map((row) => unguard(row.displayName)).sort()).toEqual(['Ada Quill', 'Ben Marsh', 'Cy Rowan']);
  expect(attemptsRows.filter((row) => row.status === 'voided')).toHaveLength(1);
  expect(csv.learners.filter((row) => row.taskKey === NEVER)).toHaveLength(0);

  const fromFiles = (() => {
    const attempts = learnersRows.reduce((sum, row) => sum + Number(row['attempts used']), 0);
    const attempted = learnersRows.filter((row) => Number(row['attempts used']) > 0).length;
    const passed = learnersRows.filter((row) => row.passed === 'yes').length;
    const bests = learnersRows.filter((row) => row['best score'] !== '').map((row) => Number(row['best score']));
    const mean = bests.length ? bests.reduce((a, b) => a + b, 0) / bests.length : null;
    return {
      attempts,
      attempted,
      passed,
      notYet: attempted - passed,
      passRate: attempted ? Math.round((100 * passed) / attempted) : null,
      mean,
      median: bests.length ? median(bests) : null,
      bands: ['0-19', '20-39', '40-59', '60-79', '80-100'].map((key) => [key, bests.filter((one) => band(one) === key).length] as const),
    };
  })();
  // The files agree with each other first (the class file's own columns).
  expect(fromFiles.attempts).toBe(attemptsRows.filter((row) => row.status === 'submitted').length);
  for (const row of classRows) {
    expect(Number(row['learners attempted'])).toBe(fromFiles.attempted);
    expect(Number(row['learners passed'])).toBe(fromFiles.passed);
  }
  expect(classRows.reduce((sum, row) => sum + Number(row['times drawn']), 0)).toBe(questionRows.length);
  expect(classRows.reduce((sum, row) => sum + Number(row['times right']), 0)).toBe(questionRows.filter((row) => row.outcome === 'right').length);
  // And the seed is what this test meant: 4 papers, 3 sat, 2 passed.
  expect([fromFiles.attempts, fromFiles.attempted, fromFiles.passed]).toEqual([4, 3, 2]);

  // A second teacher gets no data for this class (route and files), the owner's empty class reads.
  const refused = await request.get(`${API}/instructor/quiz-results/summary?cohort=${encodeURIComponent(classId)}`, { headers: other.headers });
  expect(refused.status(), 'another teacher: 404').toBe(404);
  const refusedText = await refused.text();
  for (const leak of [className, 'Ada Quill', 'Ben Marsh', SAT]) expect(refusedText).not.toContain(leak);
  const refusedCsv = await request.get(`${API}/instructor/quiz-results/learners.csv?cohort=${encodeURIComponent(classId)}`, { headers: other.headers });
  expect(refusedCsv.status(), "another teacher: no class file").toBe(404);

  /* ---------------- the dashboard steps (AI stub must not move from here) ---------------- */
  const aiBefore = await stubCounts(request);
  const summaryReads: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/instructor/quiz-results/summary') && req.url().includes(encodeURIComponent(classId))) summaryReads.push(req.method());
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInTo(page, teacher.email, teacher.password, `/teacher/class?class=${encodeURIComponent(classId)}`);
  const link = page.getByTestId('quiz-results-link');
  await expect(link).toBeVisible({ timeout: NAVIGATION });
  await expect(link).toHaveText('Quiz results');
  await link.click();
  await page.waitForURL((url) => url.pathname === '/teacher/class/quiz-results' && url.searchParams.get('class') === classId, { timeout: NAVIGATION });

  const root = page.getByTestId('quiz-results-page');
  await expect(page.getByTestId('quiz-pass-rate-chart')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByRole('heading', { level: 1, name: className })).toBeVisible();
  await expect(root).toContainText("Scores are each learner's best stored score. Nothing is regraded.");
  await expect(page.getByRole('link', { name: 'Back to class' })).toHaveAttribute('href', `/teacher/class?class=${encodeURIComponent(classId)}`);
  const passSvg = page.getByTestId('quiz-pass-rate-chart').locator('svg[role="img"]');
  await expect(passSvg).toHaveAttribute('aria-label', new RegExp(`${SAT_TITLE}: ${fromFiles.passRate}% passed, ${fromFiles.passed} of ${fromFiles.attempted}\\.`));

  // Per-quiz card = the files.
  const card = page.getByTestId(`quiz-card-${SAT}`);
  const attemptedLine = `${fromFiles.attempted} of 4 learners in the class attempted`;
  await expect(card.locator('.quiz-card-line')).toHaveText(attemptedLine);
  const stats = await cardStats(page, SAT);
  expect(stats).toEqual({
    Attempts: String(fromFiles.attempts),
    Attempted: String(fromFiles.attempted),
    Passed: String(fromFiles.passed),
    'Not yet passed': String(fromFiles.notYet),
    'Pass rate': `${fromFiles.passRate}%`,
    'Mean best score': shown(fromFiles.mean),
    'Median best score': shown(fromFiles.median),
  });
  await expect(page.getByTestId(`quiz-card-${NEVER}`)).toContainText('No attempts yet.');

  // Text equivalents = the files.
  expect(await tableRows(page, 'quiz-pass-rate-chart')).toEqual([
    [SAT_TITLE, String(fromFiles.attempted), String(fromFiles.passed), `${fromFiles.passRate}%`],
    [NEVER_TITLE, '0', '0', 'No attempts yet.'],
  ]);
  expect(await tableRows(page, `quiz-bands-${SAT}`)).toEqual(fromFiles.bands.map(([key, n]) => [key, String(n)]));
  expect(await tableRows(page, `quiz-questions-${SAT}`)).toEqual(
    classRows.map((row) => [row.questionId, row['times drawn'], row['times right'], row['% right'] === '' ? '—' : `${row['% right']}%`]),
  );
  expect(await tableRows(page, 'quiz-learner-table')).toEqual(
    learnersRows.map((row) => [
      unguard(row.displayName),
      SAT_TITLE,
      row['attempts used'],
      row['best score'] === '' ? '—' : shown(Number(row['best score'])),
      row.passed === 'yes' ? 'Yes' : row.passed === 'no' ? 'Not yet' : '—',
    ]),
  );
  await expect(page.getByTestId('quiz-learner-table').locator('thead th')).toHaveText(['Learner', 'Quiz', 'Attempts used', 'Best score', 'Passed']);
  await expect(page.getByTestId(`quiz-bands-${NEVER}`)).toHaveCount(0);
  await expect(page.getByTestId(`quiz-questions-${NEVER}`)).toHaveCount(0);

  // Every chart has a table; nothing sealed or personal is on the page.
  const charts = await page.locator('.quiz-chart').evaluateAll((all) => all.map((one) => Boolean(one.querySelector('svg[role="img"][aria-label]') && one.querySelector('table'))));
  expect(charts.length).toBeGreaterThanOrEqual(3);
  expect(charts.every(Boolean)).toBe(true);
  const pageText = (await root.textContent()) ?? '';
  for (const sealed of ['Suite question', 'Option A', 'Option B', 'Suite explanation', 'keyed', '@']) expect(pageText, `no "${sealed}" on the page`).not.toContain(sealed);

  // The downloads: four class-only buttons, and one saved file equals the route's.
  const downloads = page.getByTestId('quiz-results-downloads');
  await expect(downloads.getByRole('heading', { name: 'Download this class as CSV' })).toBeVisible();
  await expect(downloads.getByRole('button')).toHaveText(['One row per learner and quiz', 'Every attempt', 'Every question drawn, right or wrong', 'Each question across the class']);
  const [saved] = await Promise.all([page.waitForEvent('download'), page.getByTestId('quiz-download-class').click()]);
  expect(saved.suggestedFilename()).toBe('quiz-class.csv');
  const savedPath = await saved.path();
  expect(parseCsv(fs.readFileSync(savedPath!, 'utf8'))).toEqual(csv.class);

  // axe at 1280.
  const axe1280 = await runAxe(page);
  evidence('axe1280', axe1280);
  expect(failing(axe1280), 'axe at 1280').toEqual([]);

  // 390 wide: no sideways scroll, axe clean (same view, no reload).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  evidence('width390', widths);
  expect(widths.scroll, 'no horizontal scroll at 390').toBeLessThanOrEqual(widths.client);

  // Keyboard proof at 390: every table scroll box (the <details> opened, as
  // runAxe opens them) is a focusable region with a name; record whether the
  // pass-rate chart's box actually scrolls at this width (axe is the binding check).
  await page.evaluate(() => document.querySelectorAll('details').forEach((one) => ((one as HTMLDetailsElement).open = true)));
  const regions = await page.locator('.quiz-table-scroll').evaluateAll((all) =>
    all.map((box) => {
      const el = box as HTMLElement;
      const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => (document.getElementById(id)?.textContent ?? '').trim())
        .join(' ')
        .trim();
      el.focus();
      return {
        chart: el.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        role: el.getAttribute('role'),
        tabindex: el.getAttribute('tabindex'),
        name: labelledBy || (el.getAttribute('aria-label') ?? '').trim(),
        focused: document.activeElement === el,
        scrolls: el.scrollWidth > el.clientWidth,
      };
    }),
  );
  evidence('regions390', regions);
  expect(regions.length, 'the page has table scroll boxes').toBeGreaterThanOrEqual(4);
  for (const one of regions) {
    expect(one.role, `${one.chart}: role=region`).toBe('region');
    expect(one.tabindex, `${one.chart}: tabindex 0`).toBe('0');
    expect(one.name, `${one.chart}: an accessible name`).not.toBe('');
    expect(one.focused, `${one.chart}: takes keyboard focus`).toBe(true);
  }
  evidence('passRateScrolls390', regions.find((one) => one.chart === 'quiz-pass-rate-chart')?.scrolls ?? null);

  const axe390 = await runAxe(page);
  evidence('axe390', axe390);
  expect(failing(axe390), 'axe at 390').toEqual([]);

  expect(summaryReads.length, 'the page read the summary once').toBe(1);
  evidence('summaryReads', summaryReads.length);

  // An empty class says so.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/teacher/class/quiz-results?class=${encodeURIComponent(emptyClass.id)}`);
  await expect(page.getByTestId('quiz-results-empty')).toHaveText('No learners have joined this class yet.', { timeout: NAVIGATION });
  await expect(page.getByTestId('quiz-pass-rate-chart')).toHaveCount(0);

  // A second teacher: no data on the page.
  const otherPage = await signedInPage(browser, other.email, other.password, `/teacher/class/quiz-results?class=${encodeURIComponent(classId)}`);
  await expect(otherPage.getByTestId('quiz-results-page').getByRole('alert')).toBeVisible({ timeout: NAVIGATION });
  await expect(otherPage.getByTestId('quiz-pass-rate-chart')).toHaveCount(0);
  await expect(otherPage.getByTestId('quiz-learner-table')).toHaveCount(0);
  await expect(otherPage.getByTestId('quiz-results-downloads')).toHaveCount(0);
  const otherText = (await otherPage.locator('body').textContent()) ?? '';
  for (const leak of [className, 'Ada Quill', 'Ben Marsh', SAT_TITLE]) expect(otherText).not.toContain(leak);
  await otherPage.context().close();

  // A learner is sent to the dashboard.
  const learnerPage = await signedInPage(browser, dee.email, dee.password, '/dashboard');
  await learnerPage.goto(`/teacher/class/quiz-results?class=${encodeURIComponent(classId)}`);
  await learnerPage.waitForURL((url) => url.pathname === '/dashboard', { timeout: NAVIGATION });
  await expect(learnerPage.getByTestId('quiz-pass-rate-chart')).toHaveCount(0);
  await learnerPage.context().close();

  const aiAfter = await stubCounts(request);
  evidence('aiCounts', { before: aiBefore, after: aiAfter });
  expect(aiAfter, 'the AI stub did not move across the dashboard steps').toEqual(aiBefore);
  evidence('shipped', { attemptedLine: attemptedLine.replace(/^\d+ of \d+/, 'N of M'), learnerColumns: ['Learner', 'Quiz', 'Attempts used', 'Best score', 'Passed'] });
});
