// A teacher builds Deployment in four steps on a TaskTrackr copy, publishes and assigns it; a learner passes
// phases 1 to 4 through the API, then Deployment through the Runbook tab with the drill closed on its page.
//
// No real AI: every model request goes to e2e/ai-stub.cjs. Its runbook proposal adds one filled item to the
// first list that holds none, and it passes an explanation or a review only when it carries E2E-PASS.
//
// Phases 3 and 4 run learner code (passPhaseByApi makes a run before each submit). On a host that cannot
// isolate learner code the walk stops at phase 3's run with the runner's own sentence; the teacher's four
// steps, the publish and the assignment come before it.
import { expect, test, type APIRequestContext } from '@playwright/test';
import { INSTRUCTOR, PASSING_DESIGN, PASSING_REQUIREMENTS, classByApi, markPassing, passPhaseByApi, registerByApi, staffByApi, type ApiLearner, type ApiPhase } from './passing-work';
import { LEARNER_PASSWORD, dismissPhaseTutorial, signInAs, signInTo } from './pw-fixtures';
import { DEPLOYMENT_ARTEFACT, IMPLEMENTATION_ARTEFACT, RUNBOOK_RECORD, TESTING_ARTEFACT } from './fixtures';
import { PASSING_INCIDENT, fillRunbookForms } from './record-forms';
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
    headers: made.staff.headers, data: { projectVersionId: versionId, reason: 'This class works the Deployment the builder made.' },
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

test('a teacher builds Deployment in four steps; a learner passes it through the Runbook tab and the drill', async ({ page, browser, request }) => {
  test.setTimeout(900_000);
  await signInAs(page, INSTRUCTOR.email, INSTRUCTOR.password);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
  await page.goto('/teacher/projects');
  await page.getByTestId('projects-copy-tasktrackr').click();
  await page.getByTestId('projects-new-title').fill(`Deployment builder ${RUN}`);
  await page.getByTestId('projects-new-slug').fill(`deployment-builder-${RUN}`);
  await page.getByTestId('projects-new-submit').click();
  await page.waitForURL(/\/teacher\/projects\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})$/, { timeout: NAVIGATION });
  await page.getByTestId('project-phase-tab-deployment').click();
  await expect(page.getByTestId('deployment-builder')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('tdp-readiness')).toContainText('of 4 steps done');

  // Step 2 is read-only: the files, the file rules, the smoke run and the drill as the pack declares them.
  const files = page.getByTestId('tdp-files');
  await expect(files).toContainText('docker-compose.yml', { timeout: UI_READY });
  // The file rules can name docker-compose.yml before the files' own read has
  // answered ("Reading the files."), so the list is waited for, then counted.
  await expect(page.getByTestId('tdp-files-list').locator('li').first(), 'step 2 lists the phase files').toBeVisible({ timeout: UI_READY });
  expect(await page.getByTestId('tdp-files-list').locator('li').count(), 'step 2 lists the phase files').toBeGreaterThan(0);
  await expect(files.getByRole('textbox')).toHaveCount(0);

  // Step 3: the floor in words follows the steppers; the incident switch is on because the phase has a drill.
  await page.getByTestId('tdp-floor-minHealth').fill('2');
  await expect(page.getByTestId('tdp-floor-sentence')).toContainText('at least 2 health checks');
  await expect(page.getByTestId('tdp-floor-requireIncident')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('tdp-floor-minHealth').fill('1');
  await expect(page.getByTestId('tdp-floor-sentence')).toContainText('at least 1 health check with');
  await expect(page.getByTestId('tdp-floor-status')).toHaveText('Saved', { timeout: UI_READY });
  // The starting record is the room's own forms; Reset to the pack's asks first, then puts the pack's back.
  const builderRunbook = page.getByTestId('tdp-runbook');
  await expect(builderRunbook.getByTestId('runbook-environment-0-name')).toHaveValue('TASKTRACKR_DB', { timeout: UI_READY });
  await page.getByTestId('tdp-reset-source').click();
  await expect(page.getByTestId('tdp-start-confirm-line')).toContainText("puts back that version's starting runbook");
  await page.getByTestId('tdp-start-confirm').click();
  await expect(page.getByTestId('tdp-start-confirm-line')).toHaveCount(0);
  await expect(builderRunbook.getByTestId('runbook-environment-0-name')).toHaveValue('TASKTRACKR_DB', { timeout: UI_READY });
  await expect(builderRunbook.getByTestId('runbook-environment-4-name')).toHaveCount(0);

  // Step 4: the two rows the phase's own checks grade (config_completeness, build_smoke) cannot be removed;
  // the runbook's own row can. Saving the step sends every row as loaded, TaskTrackr's long runbook_quality
  // description among them, so the save is the guard that the API takes the pack's own criteria back.
  const criteria = page.getByTestId('tdp-criteria');
  await expect(criteria.getByRole('button', { name: 'Remove criterion 1' })).toBeDisabled();
  await expect(criteria.getByRole('button', { name: 'Remove criterion 2' })).toBeDisabled();
  await expect(criteria.getByRole('button', { name: 'Remove criterion 3' })).toBeEnabled();
  await criteria.getByLabel('Criterion 3 title').fill('The runbook an operator can follow');
  await criteria.getByTestId('tre-criteria-save').click();
  await expect(criteria.getByTestId('tre-criteria-status')).toHaveText('Saved', { timeout: UI_READY });
  await expect(page.getByTestId('tdp-readiness')).toHaveText('4 of 4 steps done', { timeout: UI_READY });

  // publish and assign (as design-builder.spec.ts does)
  // The checks are under the editor's Validate tab.
  await page.getByTestId('project-section-validate').click();
  await page.getByTestId('project-validate').click();
  await expect(page.getByTestId('project-validation-tier')).toBeVisible({ timeout: NAVIGATION });
  // The publish form is under the editor's Publish tab.
  await page.getByTestId('project-section-publish').click();
  await page.getByTestId('project-publish-version').fill('1.0.0');
  await page.getByTestId('project-publish-notes').fill('Deployment built in four steps.');
  await page.getByRole('button', { name: 'Publish this version' }).click();
  await page.getByTestId('project-publish-confirm-yes').click();
  await expect(page.getByTestId('project-published')).toContainText('Version 1.0.0 is published', { timeout: NAVIGATION });
  const staff = await staffByApi(request);
  const library = await (await request.get(`${API}/instructor/projects`, { headers: staff.headers })).json();
  const versionId = library.mine.find((one: { slug: string }) => one.slug === `deployment-builder-${RUN}`)?.publishedVersionId as string;
  expect(versionId, 'the copy has a published version').toBeTruthy();
  const joinCode = await assignToNewClass(request, versionId, `Deployment builder class ${RUN}`);

  // the learner: phases 1 to 4 through the API, the three config files saved, then Deployment in the room
  const learner = await registerByApi(request, { email: testEmail(`deployment-builder-${RUN}`), password: LEARNER_PASSWORD, name: 'Builder Learner' });
  let phases = await joinClass(request, learner, joinCode);
  phases = await passPhaseByApi(request, learner, phases, 1, PASSING_REQUIREMENTS);
  phases = await passPhaseByApi(request, learner, phases, 2, PASSING_DESIGN);
  // the suite's assessor passes only marked work (e2e/ai-stub.cjs), as reachTestingByApi marks it
  phases = await passPhaseByApi(request, learner, phases, 3, markPassing(IMPLEMENTATION_ARTEFACT));
  phases = await passPhaseByApi(request, learner, phases, 4, markPassing(TESTING_ARTEFACT));
  const deployment = phases.find((p) => p.order === 5)!;
  const { 'deployment/runbook.json': _record, ...config } = DEPLOYMENT_ARTEFACT;
  expect((await request.put(`${API}/phases/${deployment.id}/workspace`, { headers: learner.headers, data: { files: markPassing(config) } })).ok()).toBeTruthy();

  const learnerContext = await browser.newContext();
  const room = await learnerContext.newPage();
  await dismissPhaseTutorial(room);
  await signInTo(room, learner.email, LEARNER_PASSWORD, `/workspace/${deployment.id}`);
  // one Agentic proposal over the starting runbook, read in the overlay, explained, and applied
  await room.getByTestId('phase-deployment-tab-runbook').click();
  await expect(room.getByTestId('runbook-tab')).toBeVisible({ timeout: NAVIGATION });
  await room.getByRole('button', { name: 'Agentic', exact: true }).click();
  await room.getByTestId('agentic-input').fill('Please add the first environment setting an operator changes.');
  await room.getByTestId('agentic-send').click();
  await expect(room.getByTestId('agentic-proposal')).toBeVisible({ timeout: NAVIGATION });
  await room.getByTestId('agentic-compare').click();
  const overlay = room.getByRole('dialog', { name: /proposal/ });
  await expect(overlay).toBeVisible({ timeout: UI_READY });
  // One document is touched, so the dialog draws no rail: its title names the record.
  await expect(overlay).toContainText('proposal for your runbook');
  await expect(overlay).toContainText('BEFORE');
  await expect(overlay).toContainText('AFTER');
  const apply = overlay.getByRole('button', { name: 'Apply to the runbook' });
  await expect(apply).toBeDisabled();
  await overlay.getByLabel(/Explain why the changes are right/).fill('The setting is one an operator changes, and its purpose says what it controls. E2E-PASS');
  await overlay.getByRole('button', { name: 'Explain to unlock Apply' }).click();
  await expect(apply).toBeEnabled({ timeout: NAVIGATION });
  await apply.click();
  await expect(overlay).toBeHidden({ timeout: NAVIGATION });
  // the stub's runbook arm adds one filled entry to the first list with none filled: the starting runbook's
  // four environment entries carry names but no purpose, so it adds E5 (the fifth row)
  await expect(room.getByTestId('runbook-environment-4-name')).toHaveValue('STUB_SETTING', { timeout: UI_READY });
  await expect(room.locator('body')).not.toContainText(/runbook\.json|RUNBOOK\.md/, { useInnerText: true });
  // the forms then hold the learner's own runbook; the first four environment rows are written over
  await fillRunbookForms(room, JSON.parse(RUNBOOK_RECORD));
  await room.getByTestId('runbook-check').click();
  // Before the drill, the incident row is the one not yet met, and the tab says where the incident is written.
  await expect(room.getByTestId('runbook-check-runbook.incident')).toContainText('Not yet');
  await expect(room.getByTestId('runbook-incident-from-drill')).toBeVisible();
  await room.getByTestId('runbook-open-drill').click();
  await room.waitForURL(/\/drill$/, { timeout: UI_READY });
  await room.getByTestId('phase-deployment-drill-start').click();
  await expect(room.getByTestId('phase-deployment-drill-before')).toBeVisible({ timeout: 180_000 });
  await room.getByTestId('phase-deployment-drill-health').click();
  await expect(room.getByTestId('phase-deployment-drill-health-result')).toContainText('exit 0', { timeout: 180_000 });
  // The write-up is the drill page's Incident record view.
  const drillNav = room.locator('nav[aria-label$=" working area"]');
  await drillNav.getByRole('button', { name: 'Incident record', exact: true }).click();
  await room.getByTestId('phase-deployment-incident-root-cause').fill(PASSING_INCIDENT.rootCause);
  await room.getByTestId('phase-deployment-incident-fix').fill(PASSING_INCIDENT.fix);
  await room.getByTestId('phase-deployment-incident-action').fill(PASSING_INCIDENT.actionItem);
  await room.getByTestId('phase-deployment-drill-resolve').click();
  await expect(room.getByTestId('phase-deployment-drill-resolve')).toHaveText(/Resolved/, { timeout: 180_000 });
  await expect(room.getByTestId('phase-deployment-incident-record')).toBeVisible();
  // The drill page's Runbook view is the door back to the Runbook tab.
  await drillNav.getByRole('button', { name: 'Runbook', exact: true }).click();
  await room.getByTestId('drill-open-runbook').click();
  await expect(room.getByTestId('runbook-incident-from-drill')).toBeVisible({ timeout: NAVIGATION });
  await expect(room.getByTestId('runbook-incident-rootCause')).toHaveValue(PASSING_INCIDENT.rootCause);
  await room.getByTestId('runbook-check').click();
  const rows = room.locator('[data-testid^="runbook-check-runbook."]');
  await expect(rows).toHaveCount(7);
  await expect(rows.filter({ hasText: 'Passed' })).toHaveCount(7);
  await expect(rows.filter({ hasText: 'Not yet' })).toHaveCount(0);
  await room.getByTestId('header-run').click();
  await expect(room.getByTestId('run-summary')).toContainText('Run completed successfully', { timeout: 180_000 });
  // submitted as journey.spec.ts's submitAndExpectPass submits (`header-submit`, then `feedback-verdict`)
  await room.getByTestId('header-submit').click();
  await expect(room.getByTestId('feedback-verdict')).toContainText('Pass', { timeout: 300_000 });
  // The report names the runbook in its own sentence ("The runbook an operator can follow"), not as a heading.
  await expect(room.getByTestId('feedback-report')).toContainText(/runbook/i);
  await learnerContext.close();
});
