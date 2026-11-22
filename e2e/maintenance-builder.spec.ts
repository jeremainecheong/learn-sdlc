// A teacher builds Maintenance in five steps on a TaskTrackr copy, publishes and assigns it; a learner passes
// phases 1 to 5 through the API (Deployment with its drill closed), then Maintenance through the change
// room's forms, with one Agentic apply in the IDE behind it.
//
// No real AI: every model request goes to e2e/ai-stub.cjs. Its change proposal fills the first empty
// section of the record (here the impact's operations, with `stubOperation`), and it passes an explanation
// or a review only when it carries E2E-PASS.
//
// Phases 3 and 4 run learner code (passPhaseByApi makes a run before each submit). On a host that cannot
// isolate learner code the walk stops at phase 3's run with the runner's own sentence; the teacher's five
// steps, the publish and the assignment come before it.
import { expect, test, type APIRequestContext } from '@playwright/test';
import { INSTRUCTOR, PASSING_DESIGN, PASSING_REQUIREMENTS, classByApi, markPassing, passPhaseByApi, registerByApi, staffByApi, type ApiLearner, type ApiPhase } from './passing-work';
import { LEARNER_PASSWORD, dismissPhaseTutorial, signInAs, signInTo } from './pw-fixtures';
import { CHANGE_REQUEST_RECORD, DEPLOYMENT_ARTEFACT, IMPLEMENTATION_ARTEFACT, MAINTENANCE_ARTEFACT, TESTING_ARTEFACT } from './fixtures';
import { closeDrillByApi, fillChangeForms } from './record-forms';
import { API, RUN as BASE_RUN, testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

// A CI retry runs the test again with the same E2E_RUN_ID; the retry index keeps its slug, class and
// email new (as e2e/design-builder.spec.ts does).
let RUN = BASE_RUN;
test.beforeEach(async ({}, testInfo) => {
  RUN = testInfo.retry ? `${BASE_RUN}-r${testInfo.retry}` : BASE_RUN;
});

/** As design-builder.spec.ts assignToNewClass, with this class's reason. */
async function assignToNewClass(request: APIRequestContext, versionId: string, name: string): Promise<string> {
  const made = await classByApi(request, name);
  const assigned = await request.put(`${API}/instructor/cohorts/${made.cohortId}/project`, {
    headers: made.staff.headers, data: { projectVersionId: versionId, reason: 'This class works the Maintenance the builder made.' },
  });
  expect(assigned.ok(), 'the copy is the class project').toBeTruthy();
  return made.joinCode;
}
/** As design-builder.spec.ts joinClass. */
async function joinClass(request: APIRequestContext, learner: ApiLearner, joinCode: string): Promise<ApiPhase[]> {
  expect((await request.post(`${API}/enrollments/join`, { headers: learner.headers, data: { code: joinCode } })).ok()).toBeTruthy();
  const board = await (await request.post(`${API}/enrollments`, { headers: learner.headers, data: {} })).json();
  expect(board.projectIsDefault).toBe(false);
  return board.phases as ApiPhase[];
}

test('a teacher builds Maintenance in five steps; a learner passes it through the change room', async ({ page, browser, request }) => {
  test.setTimeout(900_000);
  await signInAs(page, INSTRUCTOR.email, INSTRUCTOR.password);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
  await page.goto('/teacher/projects');
  await page.getByTestId('projects-copy-tasktrackr').click();
  await page.getByTestId('projects-new-title').fill(`Maintenance builder ${RUN}`);
  await page.getByTestId('projects-new-slug').fill(`maintenance-builder-${RUN}`);
  await page.getByTestId('projects-new-submit').click();
  await page.waitForURL(/\/teacher\/projects\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})$/, { timeout: NAVIGATION });
  await page.getByTestId('project-phase-tab-maintenance').click();
  await expect(page.getByTestId('maintenance-builder')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('tdm-readiness')).toContainText('of 5 steps done');

  // Step 2, the ticket: CR-2, and a new acceptance line takes the next id; removed, the ticket is the pack's.
  const ticket = page.getByTestId('tdm-ticket');
  await expect(ticket).toContainText('CR-2');
  await expect(ticket.getByTestId('tdm-ticket-line-6-text')).toBeVisible();
  await ticket.getByRole('button', { name: 'Add a line' }).click();
  await expect(ticket).toContainText('AC-8');
  await ticket.getByTestId('tdm-ticket-line-7-remove').click();
  await expect(ticket.getByTestId('tdm-ticket-line-7')).toHaveCount(0);
  await expect(ticket).not.toContainText('AC-8');

  // Step 4, the change request: the contract switch is on and the amendments' stepper with it; off, the
  // stepper is disabled and the floor in words no longer asks for amendments; on again, both come back.
  const contract = page.getByTestId('tdm-contract');
  await expect(contract).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('tdm-floor-minContract')).toBeEnabled();
  await expect(page.getByTestId('tdm-floor-sentence')).toContainText('contract amendment');
  await contract.click();
  await expect(contract).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('tdm-floor-minContract')).toBeDisabled();
  await expect(page.getByTestId('tdm-floor-sentence')).not.toContainText('contract amendment');
  await expect(page.getByTestId('tdm-floor-status')).toHaveText('Saved', { timeout: UI_READY });
  await contract.click();
  await expect(contract).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('tdm-floor-minContract')).toBeEnabled();
  await expect(page.getByTestId('tdm-floor-sentence')).toContainText('at least 2 contract amendments');
  await expect(page.getByTestId('tdm-floor-status')).toHaveText('Saved', { timeout: UI_READY });
  // The starting record is the room's own forms; Reset to the pack's asks first, then puts the pack's back.
  const forms = page.getByTestId('tdm-change-forms');
  await expect(forms.getByTestId('change-release-version')).toHaveValue('2.1.0', { timeout: UI_READY });
  await page.getByTestId('tdm-reset-source').click();
  await expect(page.getByTestId('tdm-start-confirm-line')).toContainText("puts back that version's starting change request");
  await page.getByTestId('tdm-start-confirm').click();
  await expect(page.getByTestId('tdm-start-confirm-line')).toHaveCount(0);
  await expect(forms.getByTestId('change-release-version')).toHaveValue('2.1.0', { timeout: UI_READY });

  // Step 5: the four fixed keys are locked rows; the change request's own row can be removed.
  const criteria = page.getByTestId('tdm-criteria');
  for (const n of [1, 2, 3, 4]) await expect(criteria.getByRole('button', { name: `Remove criterion ${n}` })).toBeDisabled();
  await expect(criteria.getByRole('button', { name: 'Remove criterion 5' })).toBeEnabled();
  await expect(page.getByTestId('tdm-readiness')).toHaveText('5 of 5 steps done', { timeout: UI_READY });

  // publish and assign (as design-builder.spec.ts does)
  // The checks are under the editor's Validate tab.
  await page.getByTestId('project-section-validate').click();
  await page.getByTestId('project-validate').click();
  await expect(page.getByTestId('project-validation-tier')).toBeVisible({ timeout: NAVIGATION });
  // The publish form is under the editor's Publish tab.
  await page.getByTestId('project-section-publish').click();
  await page.getByTestId('project-publish-version').fill('1.0.0');
  await page.getByTestId('project-publish-notes').fill('Maintenance built in five steps.');
  await page.getByRole('button', { name: 'Publish this version' }).click();
  await page.getByTestId('project-publish-confirm-yes').click();
  await expect(page.getByTestId('project-published')).toContainText('Version 1.0.0 is published', { timeout: NAVIGATION });
  const staff = await staffByApi(request);
  const library = await (await request.get(`${API}/instructor/projects`, { headers: staff.headers })).json();
  const versionId = library.mine.find((one: { slug: string }) => one.slug === `maintenance-builder-${RUN}`)?.publishedVersionId as string;
  expect(versionId, 'the copy has a published version').toBeTruthy();
  const joinCode = await assignToNewClass(request, versionId, `Maintenance builder class ${RUN}`);

  // the learner: phases 1 to 5 through the API, Deployment's drill closed before its submit
  const learner = await registerByApi(request, { email: testEmail(`maintenance-builder-${RUN}`), password: LEARNER_PASSWORD, name: 'Builder Learner' });
  let phases = await joinClass(request, learner, joinCode);
  phases = await passPhaseByApi(request, learner, phases, 1, PASSING_REQUIREMENTS);
  phases = await passPhaseByApi(request, learner, phases, 2, PASSING_DESIGN);
  // the suite's assessor passes only marked work (e2e/ai-stub.cjs), as reachTestingByApi marks it
  phases = await passPhaseByApi(request, learner, phases, 3, markPassing(IMPLEMENTATION_ARTEFACT));
  phases = await passPhaseByApi(request, learner, phases, 4, markPassing(TESTING_ARTEFACT));
  const deployment = phases.find((p) => p.order === 5)!;
  const deploymentWork = markPassing(DEPLOYMENT_ARTEFACT);
  expect((await request.put(`${API}/phases/${deployment.id}/workspace`, { headers: learner.headers, data: { files: deploymentWork } })).ok()).toBeTruthy();
  // The resolve writes the record's incident, which the floor asks for; passPhaseByApi saves the same files
  // again, and the workspace guard carries the incident across that save.
  await closeDrillByApi(request, learner, deployment.id);
  phases = await passPhaseByApi(request, learner, phases, 5, deploymentWork);
  const maintenance = phases.find((p) => p.order === 6)!;

  const learnerContext = await browser.newContext();
  const room = await learnerContext.newPage();
  await dismissPhaseTutorial(room);
  await signInTo(room, learner.email, LEARNER_PASSWORD, `/workspace/${maintenance.id}/change`);
  await expect(room.getByTestId('change-ticket')).toContainText('CR-2', { timeout: NAVIGATION });
  await expect(room.getByTestId('change-ticket')).toContainText('AC-7');

  // One Agentic proposal over the starting record, before the forms. The mentor's Agentic mode is in the
  // IDE behind the room (the change room's mentor is guided only), so the learner opens the workspace.
  await room.getByTestId('open-workspace').click();
  await room.waitForURL((url) => url.pathname === `/workspace/${maintenance.id}`, { timeout: NAVIGATION });
  await room.getByRole('button', { name: 'Agentic', exact: true }).click();
  await room.getByTestId('agentic-input').fill('Please name the operation this change touches.');
  await room.getByTestId('agentic-send').click();
  await expect(room.getByTestId('agentic-proposal')).toBeVisible({ timeout: NAVIGATION });
  await room.getByTestId('agentic-compare').click();
  const overlay = room.getByRole('dialog', { name: /proposal/ });
  await expect(overlay).toBeVisible({ timeout: UI_READY });
  // One document is touched, so the dialog draws no rail: its title names the record.
  await expect(overlay).toContainText('proposal for your change request');
  await expect(overlay).toContainText('BEFORE');
  await expect(overlay).toContainText('AFTER');
  const apply = overlay.getByRole('button', { name: 'Apply to the change request' });
  await expect(apply).toBeDisabled();
  await overlay.getByLabel(/Explain why the changes are right/).fill('The operation is the one CR-2 adds, and the ticket\'s first acceptance item is what it serves. E2E-PASS');
  await overlay.getByRole('button', { name: 'Explain to unlock Apply' }).click();
  await expect(apply).toBeEnabled({ timeout: NAVIGATION });
  await apply.click();
  await expect(overlay).toBeHidden({ timeout: NAVIGATION });
  await expect(room.locator('body')).not.toContainText(/change-request\.json|CHANGELOG\.md/, { useInnerText: true });
  const workingArea = room.locator('nav[aria-label="Phase working area"]');
  await workingArea.getByRole('link', { name: 'Change request', exact: true }).click();
  await room.waitForURL((url) => url.pathname === `/workspace/${maintenance.id}/change`, { timeout: NAVIGATION });
  // the stub's change arm fills the first empty section of the starting record: the impact's operations
  await expect(room.getByTestId('change-impact-operations')).toContainText('stubOperation', { timeout: NAVIGATION });
  await expect(room.locator('body')).not.toContainText(/change-request\.json|CHANGELOG\.md/, { useInnerText: true });

  // the forms: the record's own operations go beside the stub's, then the contract, the tests and the release
  await fillChangeForms(room, JSON.parse(CHANGE_REQUEST_RECORD));
  // the four code files, written through the API (the change request is the forms')
  const { 'maintenance/change-request.json': _record, ...code } = MAINTENANCE_ARTEFACT;
  expect((await request.put(`${API}/phases/${maintenance.id}/workspace`, { headers: learner.headers, data: { files: markPassing(code) } })).ok()).toBeTruthy();
  // the regression run is the IDE's
  await room.getByTestId('open-workspace').click();
  await room.waitForURL((url) => url.pathname === `/workspace/${maintenance.id}`, { timeout: NAVIGATION });
  await room.getByTestId('header-run').click();
  await expect(room.getByTestId('run-summary')).toContainText('tests passed', { timeout: 180_000 });
  await workingArea.getByRole('link', { name: 'Change request', exact: true }).click();
  await room.waitForURL((url) => url.pathname === `/workspace/${maintenance.id}/change`, { timeout: NAVIGATION });
  await room.getByTestId('phase-maintenance-submit').click();
  await expect(room.getByTestId('change-page').getByText('Pass', { exact: true }).first()).toBeVisible({ timeout: 300_000 });
  // the verdict and the report, read in the IDE's feedback tab
  await room.getByTestId('open-workspace').click();
  await room.waitForURL((url) => url.pathname === `/workspace/${maintenance.id}`, { timeout: NAVIGATION });
  await room.getByTestId('tab-feedback').click();
  await expect(room.getByTestId('feedback-verdict')).toContainText('Pass', { timeout: NAVIGATION });
  await expect(room.getByTestId('feedback-report')).toContainText('Change request');
  await learnerContext.close();
});
