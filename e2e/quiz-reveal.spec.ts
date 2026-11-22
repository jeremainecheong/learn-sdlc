import { expect, test, type APIRequestContext } from '@playwright/test';
import { dismissPhaseTutorial, LEARNER_PASSWORD, signInTo } from './pw-fixtures';
import { INSTRUCTOR, registerByApi, settledSubmission, staffByApi, type StaffParty } from './passing-work';
import { API, RUN_ID } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The practice-quiz reveal, from the editor's stored rule to the learner's
 * quiz room, in a browser, against the suite's stack.
 *
 * 1. The teacher's editor reads a stored "after every attempt" rule back on a
 *    sealed optional quiz, opens the keyed form on it (the audited key read),
 *    and a save of that form untouched keeps the rule.
 * 2. A learner who fails that capped quiz with attempts left is shown every
 *    explanation on the marked paper; the same quiz without the rule shows
 *    none.
 */

// A CI retry (`retries: 1` under CI) runs the test again with the same
// E2E_RUN_ID; the retry index keeps its slug and emails new, so a retry can
// recover rather than collide with what the first try made.
let RUN = RUN_ID;
let SLUG = `reveal-e2e-${RUN}`;
test.beforeEach(async ({}, testInfo) => {
  RUN = testInfo.retry ? `${RUN_ID}-r${testInfo.retry}` : RUN_ID;
  SLUG = `reveal-e2e-${RUN}`;
});
const NOTICE = 'Synthetic practice quiz for the suite. It teaches nothing.';

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

const quiz = (prefix: string, reveal?: 'always') => ({
  questions: questions(prefix),
  drawn: 4,
  shuffleOptions: true,
  passMark: 75,
  attempts: { max: 3, cooldownSeconds: null },
  criterion: 'concepts',
  ...(reveal ? { revealExplanation: reveal } : {}),
});

async function copyWithQuizzes(request: APIRequestContext, staff: StaffParty) {
  const library = await (await request.get(`${API}/instructor/projects`, { headers: staff.headers })).json();
  const platform = library.library.find((one: any) => one.isDefault);
  const created = await request.post(`${API}/instructor/projects`, {
    headers: staff.headers,
    data: { title: 'Reveal Desk', slug: SLUG, fromVersionId: platform.publishedVersionId },
  });
  expect(created.ok(), 'the copy is made').toBeTruthy();
  const { project, draftVersionId } = await created.json();
  const at = `${API}/instructor/projects/${project.id}/versions/${draftVersionId}`;
  for (const [taskKey, title, body] of [
    ['practice-always', 'Practice, shown every time', quiz('pa', 'always')],
    ['practice-plain', 'Practice, as built', quiz('pp')],
  ] as const) {
    const added = await request.post(`${at}/phases/requirements/tasks`, {
      headers: staff.headers,
      data: { taskKey, title, brief: NOTICE, artefactType: 'quiz', required: false, quiz: body },
    });
    expect(added.ok(), `${taskKey} is added`).toBeTruthy();
  }
  return { projectId: project.id as string, versionId: draftVersionId as string, at };
}

const ruleOf = async (request: APIRequestContext, staff: StaffParty, at: string, key: string) =>
  ((await (await request.get(`${at}/phases/requirements/tasks`, { headers: staff.headers })).json()).tasks as any[]).find((one) => one.taskKey === key)?.quiz
    ?.revealExplanation ?? null;

test('a stored reveal rule survives the editor round trip, and the marked paper shows it', async ({ page, request }) => {
  const staff = await staffByApi(request);
  const { projectId, versionId, at } = await copyWithQuizzes(request, staff);

  // 1. the editor: the sealed readout, the keyed form on the rule, an untouched save
  await dismissPhaseTutorial(page);
  await signInTo(page, INSTRUCTOR.email, INSTRUCTOR.password, `/teacher/projects/${projectId}/versions/${versionId}`);
  // The editor opens on its Overview; the quizzes are Requirements' tasks.
  await page.getByTestId('project-section-requirements').click();
  await page.getByTestId('task-edit-practice-always').click();
  await expect(page.getByTestId('quiz-reveal-readout')).toContainText('After every attempt, pass or fail', { timeout: UI_READY });
  await page.getByTestId('quiz-answers-show').click();
  await expect(page.getByTestId('quiz-reveal-always')).toBeChecked({ timeout: UI_READY });
  await page.getByTestId('task-form-submit').click();
  await expect(page.getByTestId('task-form')).toHaveCount(0, { timeout: UI_READY });
  expect(await ruleOf(request, staff, at, 'practice-always')).toBe('always');
  expect(await ruleOf(request, staff, at, 'practice-plain')).toBeNull();

  // publish, give it to a class, and a learner sits both papers wrong
  const published = await request.post(`${at}/publish`, { headers: staff.headers, data: { version: '1.0.0', notes: 'Two practice quizzes.' } });
  expect(published.ok(), 'published').toBeTruthy();
  const cohort = await (await request.post(`${API}/instructor/cohorts`, { headers: staff.headers, data: { name: `Reveal ${RUN}` } })).json();
  expect(
    (
      await request.put(`${API}/instructor/cohorts/${cohort.id}/project`, {
        headers: staff.headers,
        data: { projectVersionId: (await published.json()).versionId, reason: 'This class practises first.' },
      })
    ).ok(),
  ).toBeTruthy();
  const learner = await registerByApi(request, { email: `reveal-${RUN}@e2e-reveal.test`, password: LEARNER_PASSWORD, name: 'Reveal Reader' });
  expect((await request.post(`${API}/enrollments/join`, { headers: learner.headers, data: { code: cohort.joinCode } })).ok()).toBeTruthy();
  const board = await (await request.post(`${API}/enrollments`, { headers: learner.headers, data: {} })).json();
  const requirementsId = board.phases.find((one: any) => one.key === 'requirements').id as string;
  const sitWrong = async (taskKey: string) => {
    const paper = await (await request.post(`${API}/phases/${requirementsId}/tasks/${taskKey}/quiz/attempts`, { headers: learner.headers })).json();
    const answers = Object.fromEntries(
      (paper.questions as any[]).map((one) => [one.id, [one.options.find((option: any) => option.text.startsWith('Option B')).id]]),
    );
    const handed = await request.post(`${API}/phases/${requirementsId}/tasks/${taskKey}/quiz/attempts/${paper.attemptId}`, {
      headers: learner.headers,
      data: { answers },
    });
    expect(handed.ok(), `${taskKey} is handed in`).toBeTruthy();
    return settledSubmission(request, learner, (await handed.json()).id);
  };
  expect((await sitWrong('practice-always')).passed).toBe(false);
  expect((await sitWrong('practice-plain')).passed).toBe(false);

  // 2. the learner's marked papers, in the room
  await page.context().clearCookies();
  await page.goto('/login');
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await signInTo(page, learner.email, learner.password, '/dashboard');
  await page.goto(`/workspace/${requirementsId}?task=practice-always`);
  const always = page.getByTestId('quiz-result');
  await expect(always).toBeVisible({ timeout: NAVIGATION });
  await expect(always).toContainText('Suite explanation');
  await page.goto(`/workspace/${requirementsId}?task=practice-plain`);
  const plain = page.getByTestId('quiz-result');
  await expect(plain).toBeVisible({ timeout: NAVIGATION });
  await expect(plain).not.toContainText('Suite explanation');
});
