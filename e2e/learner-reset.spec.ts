import { expect, test, type APIRequestContext } from '@playwright/test';
import { dismissPhaseTutorial, E2E_PASS, LEARNER_PASSWORD, signInTo, stripDoor } from './pw-fixtures';
import { PASSING_DESIGN, PASSING_REQUIREMENTS, passPhaseByApi, registerByApi, settledSubmission, staffByApi, type ApiLearner } from './passing-work';
import { DESIGN_ARTEFACT } from './golden-records';
import { API, RUN_ID } from './support/env';
import { NAVIGATION } from './support/timeouts';

/**
 * The learner's "Start this task over", in a browser, against the suite's
 * stack.
 *
 * A teacher's copy whose Design holds its one task, the inherited design task
 * (`main`): a teacher's phase with one inherited `main` task is an authored
 * list, so its room offers the reset (TaskResetControl `resetOffered`), and a
 * Design phase holds exactly one task, so nothing is added beside it. Each
 * learner passes Requirements on the story record first, so Design opens. A
 * learner hands in a failing design, then starts it over from the room:
 *
 *   fail → the confirm names what the API's plan names → reset → the paths it
 *   restores read as a fresh learner's starter again (owned restored, seeded
 *   re-seeded) → the submission and the attempt count are kept → the phase's
 *   gate is where it was → a passing design afterwards passes the task.
 *
 * Only the reset is pressed in the browser; the setup and the hand-ins go
 * through the API, the way the other staff specs make their state.
 */

// A CI retry (`retries: 1` under CI) runs the test again with the same
// E2E_RUN_ID; the retry index keeps its slug and emails new, so a retry can
// recover rather than collide with what the first try made.
let RUN = RUN_ID;
let SLUG = `reset-e2e-${RUN}`;
test.beforeEach(async ({}, testInfo) => {
  RUN = testInfo.retry ? `${RUN_ID}-r${testInfo.retry}` : RUN_ID;
  SLUG = `reset-e2e-${RUN}`;
});
/** The design as the golden records hold it: complete, but without the stub's pass mark, so the review sends it back. */
const FAILING_DESIGN = DESIGN_ARTEFACT;

async function copyOfTaskTrackr(request: APIRequestContext) {
  const staff = await staffByApi(request);
  const library = await (await request.get(`${API}/instructor/projects`, { headers: staff.headers })).json();
  const platform = library.library.find((one: any) => one.isDefault);
  const created = await request.post(`${API}/instructor/projects`, {
    headers: staff.headers,
    data: { title: 'Reset Desk', slug: SLUG, fromVersionId: platform.publishedVersionId },
  });
  expect(created.ok(), 'the copy is made').toBeTruthy();
  const { project, draftVersionId } = await created.json();
  const at = `${API}/instructor/projects/${project.id}/versions/${draftVersionId}`;
  const draft = await (await request.get(at, { headers: staff.headers })).json();
  const designTasks = (draft.phases.find((one: any) => one.key === 'design')?.tasks ?? []) as { taskKey: string }[];
  expect(designTasks.map((one) => one.taskKey), "the copy's Design holds its one inherited task").toEqual(['main']);
  const published = await request.post(`${at}/publish`, { headers: staff.headers, data: { version: '1.0.0', notes: 'Design as one task, started over.' } });
  expect(published.ok(), 'the copy is published').toBeTruthy();
  const cohort = await (await request.post(`${API}/instructor/cohorts`, { headers: staff.headers, data: { name: `Reset ${RUN}` } })).json();
  const assigned = await request.put(`${API}/instructor/cohorts/${cohort.id}/project`, {
    headers: staff.headers,
    data: { projectVersionId: (await published.json()).versionId, reason: 'This class starts tasks over.' },
  });
  expect(assigned.ok(), 'the copy is the class project').toBeTruthy();
  return { joinCode: cohort.joinCode as string };
}

async function learnerInClass(request: APIRequestContext, joinCode: string, handle: string, name: string): Promise<{ learner: ApiLearner; designId: string }> {
  const learner = await registerByApi(request, { email: `${handle}-${RUN}@e2e-reset.test`, password: LEARNER_PASSWORD, name });
  expect((await request.post(`${API}/enrollments/join`, { headers: learner.headers, data: { code: joinCode } })).ok(), 'joins').toBeTruthy();
  const enrolled = await request.post(`${API}/enrollments`, { headers: learner.headers, data: {} });
  expect(enrolled.ok(), 'enrols on the class project').toBeTruthy();
  const board = await enrolled.json();
  expect(board.projectIsDefault, 'a teacher copy').toBe(false);
  // Requirements first, on the story record (its sole task), so Design opens.
  const phases = await passPhaseByApi(request, learner, board.phases, 1, PASSING_REQUIREMENTS);
  return { learner, designId: phases.find((one) => one.key === 'design')!.id };
}

const detailOf = async (request: APIRequestContext, learner: ApiLearner, id: string) =>
  (await request.get(`${API}/phases/${id}`, { headers: learner.headers })).json();

const submit = async (request: APIRequestContext, learner: ApiLearner, id: string, taskKey: string) => {
  const handed = await request.post(`${API}/phases/${id}/tasks/${taskKey}/submit`, { headers: learner.headers });
  expect(handed.ok(), `${taskKey} is handed in`).toBeTruthy();
  return settledSubmission(request, learner, (await handed.json()).id);
};

test('a learner starts a failed task over from the room: restored, history kept, gate unchanged, then passes', async ({ page, request }) => {
  const { joinCode } = await copyOfTaskTrackr(request);
  const fresh = await learnerInClass(request, joinCode, 'fresh', 'Fresh Reader');
  const { learner, designId } = await learnerInClass(request, joinCode, 'writer', 'Reset Writer');

  // 1. a failing design
  const saved = await request.put(`${API}/phases/${designId}/workspace`, {
    headers: learner.headers,
    data: { files: FAILING_DESIGN },
  });
  expect(saved.ok()).toBeTruthy();
  const failed = await submit(request, learner, designId, 'main');
  expect(failed.passed, 'the design is sent back').toBe(false);
  const before = await detailOf(request, learner, designId);
  const mainBefore = before.tasks.find((one: any) => one.key === 'main');
  const historyBefore = await (await request.get(`${API}/phases/${designId}/tasks/main/submissions`, { headers: learner.headers })).json();
  const plan = await (await request.get(`${API}/phases/${designId}/tasks/main/reset`, { headers: learner.headers })).json();
  expect(plan.refusal).toBeNull();
  expect(plan.restores.length + plan.reseeds.length, 'the reset changes a file').toBeGreaterThan(0);

  // 2. the reset, pressed in the room
  await dismissPhaseTutorial(page);
  await signInTo(page, learner.email, learner.password, '/dashboard');
  // The inherited design task is worked on the design board, its own room.
  await page.goto(`/workspace/${designId}/design?task=main`);
  // Retry is a door of the room's header menu where the room draws one:
  // stripDoor opens the menu when the control is behind it.
  await page.getByTestId('task-reset-open').waitFor({ state: 'attached', timeout: NAVIGATION });
  const open = await stripDoor(page, 'task-reset-open');
  await expect(open).toBeVisible();
  await open.click();
  const dialog = page.getByTestId('task-reset-dialog');
  await expect(dialog).toBeVisible();
  for (const path of plan.restores) await expect(dialog.getByTestId('task-reset-restores')).toContainText(path);
  for (const path of plan.reseeds) await expect(dialog.getByTestId('task-reset-reseeds')).toContainText(path);
  await expect(dialog.getByTestId('task-reset-keeps')).toBeVisible();
  await dialog.getByTestId('task-reset-confirm').click();
  await expect(page.getByTestId('task-reset-status')).toHaveText('This task was started over. Your submissions and attempts are as they were.', { timeout: NAVIGATION });

  // 3. owned restored, seeded re-seeded: each path reads as a fresh learner's
  const after = await detailOf(request, learner, designId);
  const starter = await detailOf(request, fresh.learner, fresh.designId);
  const bytes = (detail: any, path: string) => detail.files.find((file: any) => file.path === path)?.content ?? null;
  for (const path of [...plan.restores, ...plan.reseeds]) expect([path, bytes(after, path)]).toEqual([path, bytes(starter, path)]);

  // 4. history and attempts kept; the gate where it was
  const mainAfter = after.tasks.find((one: any) => one.key === 'main');
  expect(mainAfter.attempts).toBe(mainBefore.attempts);
  const historyAfter = await (await request.get(`${API}/phases/${designId}/tasks/main/submissions`, { headers: learner.headers })).json();
  expect(historyAfter.length).toBe(historyBefore.length);
  expect(after.status).toBe(before.status);
  expect(after.workspaceUpdatedAt).not.toBe(before.workspaceUpdatedAt);

  // 5. a passing design after the reset passes the task
  const passing = await request.put(`${API}/phases/${designId}/workspace`, { headers: learner.headers, data: { files: PASSING_DESIGN } });
  expect(passing.ok()).toBeTruthy();
  expect(PASSING_DESIGN['design/design.json']).toContain(E2E_PASS);
  const passed = await submit(request, learner, designId, 'main');
  expect(passed.passed, 'the design passes after the reset').toBe(true);
  expect((await detailOf(request, learner, designId)).tasks.find((one: any) => one.key === 'main').status).toBe('passed');
});

test('the reset is not offered on the platform project (D-B1 (a))', async ({ page, request }) => {
  const learner = await registerByApi(request, { email: `plain-${RUN}@e2e-reset.test`, password: LEARNER_PASSWORD, name: 'Plain Reader' });
  const enrolled = await (await request.post(`${API}/enrollments`, { headers: learner.headers, data: {} })).json();
  expect(enrolled.projectIsDefault).toBe(true);
  const requirementsId = enrolled.phases.find((one: any) => one.key === 'requirements').id;
  await dismissPhaseTutorial(page);
  await signInTo(page, learner.email, learner.password, '/dashboard');
  await page.goto(`/workspace/${requirementsId}?task=main`);
  await expect(page.getByTestId('requirements-workspace').or(page.getByTestId('workspace-page')).first()).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId('task-reset-open')).toHaveCount(0);
});
