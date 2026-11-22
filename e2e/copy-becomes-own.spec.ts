import { expect, test, type APIRequestContext } from '@playwright/test';
import { dismissPhaseTutorial, LEARNER_PASSWORD, signInTo } from './pw-fixtures';
import { INSTRUCTOR, registerByApi, staffByApi, type StaffParty } from './passing-work';
import { API, RUN_ID } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * A copy made the teacher's own, in a browser, against the suite's stack: the
 * editor's view of what is the teacher's, the class card, the learner's
 * surfaces, and the lesson doors on a teacher's project.
 *
 * A teacher copies the platform project and rewrites the Requirements intro.
 * The editor chips Requirements "Partly yours" and its intro "Yours". A
 * learner on that copy then reads:
 *
 * - Requirements: the teacher's intro (in its payload), and no lesson door in
 *   its room (the phase is no longer the reference's): no "Optional phase
 *   guide", no guide in the case file;
 * - Implementation (opened by the teacher's lever): still the reference's, so
 *   its guide is offered, and the bridge notice names the application the
 *   phase runs, read from the payload;
 * - the sidebar's "Learn", because some phase still offers a lesson.
 *
 * And a learner on the platform project keeps every door, with no bridge notice.
 */

// A CI retry (`retries: 1` under CI) runs the test again with the same
// E2E_RUN_ID; the retry index keeps its slug and emails new, so a retry can
// recover rather than collide with what the first try made.
let RUN = RUN_ID;
let SLUG = `own-e2e-${RUN}`;
test.beforeEach(async ({}, testInfo) => {
  RUN = testInfo.retry ? `${RUN_ID}-r${testInfo.retry}` : RUN_ID;
  SLUG = `own-e2e-${RUN}`;
});
const INTRO = 'Room Desk books the meeting rooms on two floors. Start with what the facilities team needs.';

async function copyWithOwnIntro(request: APIRequestContext, staff: StaffParty) {
  const library = await (await request.get(`${API}/instructor/projects`, { headers: staff.headers })).json();
  const platform = library.library.find((one: any) => one.isDefault);
  const created = await request.post(`${API}/instructor/projects`, {
    headers: staff.headers,
    data: { title: 'Room Desk', slug: SLUG, fromVersionId: platform.publishedVersionId },
  });
  expect(created.ok(), 'the copy is made').toBeTruthy();
  const { project, draftVersionId } = await created.json();
  const at = `${API}/instructor/projects/${project.id}/versions/${draftVersionId}`;
  expect((await request.patch(`${at}/phases/requirements`, { headers: staff.headers, data: { intro: INTRO } })).ok(), 'the intro is the teacher’s').toBeTruthy();
  return { projectId: project.id as string, versionId: draftVersionId as string, at };
}

test("a teacher's copy: the editor says whose each element is, and the learner meets the doors its provenance allows", async ({ page, request }) => {
  const staff = await staffByApi(request);
  const { projectId, versionId, at } = await copyWithOwnIntro(request, staff);

  await dismissPhaseTutorial(page);
  await signInTo(page, INSTRUCTOR.email, INSTRUCTOR.password, `/teacher/projects/${projectId}/versions/${versionId}`);
  // The editor opens on its Overview; the provenance marks are in the Requirements tab.
  await page.getByTestId('project-section-requirements').click({ timeout: UI_READY });
  await expect(page.getByTestId('phase-provenance-requirements')).toHaveText('Partly yours', { timeout: UI_READY });
  await expect(page.getByTestId('phase-intro-provenance-requirements')).toHaveText('Yours');

  const published = await request.post(`${at}/publish`, { headers: staff.headers, data: { version: '1.0.0' } });
  expect(published.ok(), 'published').toBeTruthy();
  const cohort = await (await request.post(`${API}/instructor/cohorts`, { headers: staff.headers, data: { name: `Own ${RUN}` } })).json();
  expect(
    (
      await request.put(`${API}/instructor/cohorts/${cohort.id}/project`, {
        headers: staff.headers,
        data: { projectVersionId: (await published.json()).versionId, reason: 'This class books rooms.' },
      })
    ).ok(),
  ).toBeTruthy();

  const learner = await registerByApi(request, { email: `own-${RUN}@e2e-own.test`, password: LEARNER_PASSWORD, name: 'Own Reader' });
  expect((await request.post(`${API}/enrollments/join`, { headers: learner.headers, data: { code: cohort.joinCode } })).ok()).toBeTruthy();
  const board = await (await request.post(`${API}/enrollments`, { headers: learner.headers, data: {} })).json();
  expect(board.projectIsDefault).toBe(false);
  const ids = Object.fromEntries((board.phases as any[]).map((one) => [one.key, one.id]));
  // Implementation is opened by the teacher's lever (the tours spec's way), so its brief can be read.
  const opened = await request.post(`${API}/instructor/learners/${learner.userId}/phases/${ids.implementation}/override`, {
    headers: staff.headers,
    data: { action: 'reopen', reason: 'Opened so the suite can read the application phase brief.' },
  });
  expect(opened.ok(), 'Implementation opens').toBeTruthy();
  const implementation = await (await request.get(`${API}/phases/${ids.implementation}`, { headers: learner.headers })).json();
  const application = implementation.provenance?.application as string;
  expect(typeof application, 'the payload names the application').toBe('string');

  await page.context().clearCookies();
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await signInTo(page, learner.email, learner.password, '/dashboard');

  // The sidebar's "Learn": Design onwards are still the reference's.
  await expect(page.getByTestId('nav-learn')).toHaveAttribute('href', '/learn', { timeout: UI_READY });
  // The teacher's words, drawn in the browser: the dashboard shows the
  // Requirements intro's opening. The Requirements room itself draws the
  // static phase purpose, not the teacher's intro.
  await expect(page.getByText(INTRO.slice(0, 40)).first()).toBeVisible({ timeout: UI_READY });

  // Requirements: the teacher's words (the payload), and no lesson door in its room.
  const requirements = await (await request.get(`${API}/phases/${ids.requirements}`, { headers: learner.headers })).json();
  expect(requirements.intro).toBe(INTRO);
  expect(requirements.provenance).toMatchObject({ rollup: 'mixed', intro: 'own', roomTask: 'reference' });
  await page.goto(`/workspace/${ids.requirements}`);
  await expect(page.getByTestId('requirements-workspace')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.locator('.phase-strip-guide')).toHaveCount(0);
  await expect(page.locator('a[href="/learn/requirements"]')).toHaveCount(0);
  await expect(page.getByTestId('brief-about')).toHaveCount(0);

  // Implementation: still the reference's, so its guide is offered, and the
  // bridge notice names the application, from the payload.
  await page.goto(`/workspace/${ids.implementation}`);
  await expect(page.locator('.phase-strip-guide')).toHaveAttribute('href', '/learn/implementation', { timeout: NAVIGATION });
  // The notice is on the phase's case file (the brief page), not in the IDE room.
  await page.goto(`/workspace/${ids.implementation}/brief`);
  await expect(page.getByTestId('brief-page')).toBeVisible({ timeout: NAVIGATION });
  const bridge = page.getByTestId('phase-bridge-notice').or(page.getByTestId('brief-bridge-notice')).first();
  await expect(bridge).toContainText(application, { timeout: NAVIGATION });

  // The platform project keeps every door and draws no bridge notice.
  const plain = await registerByApi(request, { email: `plain-own-${RUN}@e2e-own.test`, password: LEARNER_PASSWORD, name: 'Plain Own Reader' });
  const plainBoard = await (await request.post(`${API}/enrollments`, { headers: plain.headers, data: {} })).json();
  expect(plainBoard.projectIsDefault).toBe(true);
  const plainRequirements = plainBoard.phases.find((one: any) => one.key === 'requirements').id;
  await page.context().clearCookies();
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await signInTo(page, plain.email, plain.password, '/dashboard');
  await page.goto(`/workspace/${plainRequirements}`);
  await expect(page.getByTestId('requirements-workspace')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.locator('.phase-strip-guide')).toHaveAttribute('href', '/learn/requirements');
  await expect(page.getByTestId('phase-bridge-notice')).toHaveCount(0);
  await expect(page.getByTestId('brief-bridge-notice')).toHaveCount(0);
});
