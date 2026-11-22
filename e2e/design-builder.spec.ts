// A teacher builds Design in six steps on a TaskTrackr copy, publishes and assigns it; a learner passes
// Requirements through the API, then Design through the forms with one Agentic apply through the overlay.
//
// No real AI: every model request goes to e2e/ai-stub.cjs. Its design proposal adds one traced operation
// (for the FIRST listed story) to the record and fills the first screen row with no component, so the
// overlay shows two documents; it passes a review or an explanation only when it carries E2E-PASS.
import { expect, test, type APIRequestContext } from '@playwright/test';
import { INSTRUCTOR, PASSING_REQUIREMENTS, classByApi, passPhaseByApi, registerByApi, staffByApi, type ApiLearner, type ApiPhase } from './passing-work';
import { LEARNER_PASSWORD, dismissPhaseTutorial, signInAs, signInTo } from './pw-fixtures';
import { API, RUN as BASE_RUN, testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

// A CI retry runs the test again with the same E2E_RUN_ID; the retry index keeps its slug, class and
// email new (as e2e/requirements-builder.spec.ts does).
let RUN = BASE_RUN;
test.beforeEach(async ({}, testInfo) => {
  RUN = testInfo.retry ? `${BASE_RUN}-r${testInfo.retry}` : BASE_RUN;
});

/** As requirements-builder.spec.ts assignToNewClass, with this class's reason. */
async function assignToNewClass(request: APIRequestContext, versionId: string, name: string): Promise<string> {
  const made = await classByApi(request, name);
  const assigned = await request.put(`${API}/instructor/cohorts/${made.cohortId}/project`, {
    headers: made.staff.headers, data: { projectVersionId: versionId, reason: 'This class works the Design the builder made.' },
  });
  expect(assigned.ok(), 'the copy is the class project').toBeTruthy();
  return made.joinCode;
}
/** As requirements-builder.spec.ts joinClass. */
async function joinClass(request: APIRequestContext, learner: ApiLearner, joinCode: string): Promise<ApiPhase[]> {
  expect((await request.post(`${API}/enrollments/join`, { headers: learner.headers, data: { code: joinCode } })).ok()).toBeTruthy();
  const enrolled = await request.post(`${API}/enrollments`, { headers: learner.headers, data: {} });
  const board = await enrolled.json();
  expect(board.projectIsDefault).toBe(false);
  return board.phases as ApiPhase[];
}

test('a teacher builds Design in six steps; a learner passes it with a proposal applied through the overlay', async ({ page, browser, request }) => {
  test.setTimeout(600_000);
  await signInAs(page, INSTRUCTOR.email, INSTRUCTOR.password);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
  await page.goto('/teacher/projects');
  await page.getByTestId('projects-copy-tasktrackr').click();
  await page.getByTestId('projects-new-title').fill(`Design builder ${RUN}`);
  await page.getByTestId('projects-new-slug').fill(`design-builder-${RUN}`);
  await page.getByTestId('projects-new-submit').click();
  await page.waitForURL(/\/teacher\/projects\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})$/, { timeout: NAVIGATION });
  await page.getByTestId('project-phase-tab-design').click();
  await expect(page.getByTestId('design-builder')).toBeVisible({ timeout: UI_READY });

  // 1. the background
  await page.getByTestId('tde-background').getByRole('textbox').fill('Two services share one contract: a web server in front of a Python API over SQLite.');
  await page.getByTestId('tre-background-save').click();
  await expect(page.getByTestId('tre-background-status')).toHaveText('Saved', { timeout: UI_READY });

  // 2. the stories, copied from Requirements (US-1, US-2, US-3, US-5 provided and the learner's US-4):
  // US-1 and US-5 are not this design's, so the three it serves are US-2, US-3 and US-4.
  await page.getByTestId('tde-copy-requirements').click();
  await page.getByTestId('tde-copy-confirm').click();
  await expect(page.getByTestId('tde-story-0-id')).toHaveValue('US-1');
  await page.getByTestId('tde-story-0-remove').click();
  const stories = page.getByTestId('tde-stories').locator('[data-testid$="-id"]');
  const ids = await stories.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
  await page.getByTestId(`tde-story-${ids.indexOf('US-5')}-remove`).click();
  await expect(stories).toHaveCount(3);
  expect(await stories.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))).toEqual(['US-2', 'US-3', 'US-4']);
  await page.getByTestId('tde-stories-save').click();
  await expect(page.getByTestId('tde-stories-status')).toHaveText('Saved', { timeout: UI_READY });

  // 3. the learner's design: both contracts on, and TaskTrackr 4.0.0 switches the sequence diagram on;
  // off, its floor row greys and the sentence drops it; on again, both come back
  await expect(page.getByTestId('tde-contract-screens')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('tde-sequence-diagram')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('tde-sequence-diagram').click();
  await expect(page.getByTestId('tde-floor-sequence')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('tde-floor-sentence')).not.toContainText('sequence diagram');
  await page.getByTestId('tde-sequence-diagram').click();
  await expect(page.getByTestId('tde-floor-sentence')).toContainText('a sequence diagram that names at least one of the operations');
  await page.getByTestId('tde-learner-save').click();
  await expect(page.getByTestId('tde-learner-status')).toHaveText('Saved', { timeout: UI_READY });

  // 5. the floor: two entities, not the pack's three
  await page.getByTestId('tde-floor-minEntities').getByRole('textbox').fill('2');
  await expect(page.getByTestId('tde-floor-sentence')).toContainText('at least 2 entities');
  await page.getByTestId('tde-floor-save').click();
  await expect(page.getByTestId('tde-floor-status')).toHaveText('Saved', { timeout: UI_READY });
  await expect(page.getByTestId('tde-readiness')).toHaveText('6 of 6 steps done', { timeout: UI_READY });

  // publish and assign (as requirements-builder.spec.ts does)
  // The checks are under the editor's Validate tab.
  await page.getByTestId('project-section-validate').click();
  await page.getByTestId('project-validate').click();
  await expect(page.getByTestId('project-validation-tier')).toBeVisible({ timeout: NAVIGATION });
  // The publish form is under the editor's Publish tab.
  await page.getByTestId('project-section-publish').click();
  await page.getByTestId('project-publish-version').fill('1.0.0');
  await page.getByTestId('project-publish-notes').fill('Design built in six steps.');
  await page.getByRole('button', { name: 'Publish this version' }).click();
  await page.getByTestId('project-publish-confirm-yes').click();
  await expect(page.getByTestId('project-published')).toContainText('Version 1.0.0 is published', { timeout: NAVIGATION });
  const staff = await staffByApi(request);
  const library = await (await request.get(`${API}/instructor/projects`, { headers: staff.headers })).json();
  const versionId = library.mine.find((one: { slug: string }) => one.slug === `design-builder-${RUN}`)?.publishedVersionId as string;
  expect(versionId, 'the copy has a published version').toBeTruthy();
  const joinCode = await assignToNewClass(request, versionId, `Design builder class ${RUN}`);

  // the learner: Requirements through the API, then Design in the room
  const learner = await registerByApi(request, { email: testEmail(`design-builder-${RUN}`), password: LEARNER_PASSWORD, name: 'Builder Learner' });
  const phases = await joinClass(request, learner, joinCode);
  const after = await passPhaseByApi(request, learner, phases, 1, PASSING_REQUIREMENTS);
  const design = after.find((p) => p.order === 2)!;

  const learnerContext = await browser.newContext();
  const room = await learnerContext.newPage();
  await dismissPhaseTutorial(room);
  await signInTo(room, learner.email, LEARNER_PASSWORD, `/workspace/${design.id}/design`);
  await expect(room.getByTestId('phase-design-editor')).toBeVisible({ timeout: NAVIGATION });

  // the UML model: the starting entity and a Task beside it, two relations, the three operations traced
  await room.getByTestId('design-tab-model').click();
  await room.getByTestId('design-board-entity-add').click();
  await room.getByTestId('design-board-entity-1-name').fill('Task');
  await room.getByTestId('design-board-entity-1-story-US-4').click();
  await room.getByTestId('design-board-relation-add').click();
  await room.getByTestId('design-board-relation-add').click();
  const operations = [['0', 'id', 'Task', 'US-2'], ['1', 'listId', 'Task[]', 'US-3'], ['2', 'today', 'Task[]', 'US-4']];
  for (const [i, input, returns, story] of operations) {
    await room.getByTestId(`design-operation-${i}-inputs`).fill(input);
    await room.getByTestId(`design-operation-${i}-returns`).fill(returns);
    await room.getByTestId(`design-operation-${i}-story-${story}`).click();
  }
  // the decision and the notes, with the pass mark
  await room.getByTestId('design-tab-decisions').click();
  await room.getByTestId('design-decision-0-title').fill('Today comes from the caller');
  await room.getByTestId('design-decision-0-rationale').fill('tests replay one boundary');
  await room.getByTestId('design-decision-0-tradeoff').fill('every caller sends a date');
  await room.getByTestId('design-board-notes').fill('E2E-PASS');
  // the request path
  await room.getByTestId('design-tab-sequence').click();
  await room.getByTestId('design-sequence-source').fill('Browser -> OverduePage: open the report\nOverduePage -> Api: getOverdue(today)\nApi --> OverduePage: Task[]');
  // the error catalogue
  await room.getByTestId('design-tab-api').click();
  await room.getByRole('button', { name: 'Errors' }).click();
  const catalogue = room.getByLabel('Shared error catalogue (JSON object, code → status and meaning)');
  await catalogue.fill('{"task_not_found":{"status":404,"meaning":"No task has that id."}}');
  await catalogue.blur();
  await expect(room.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });

  // one Agentic proposal, read in the overlay, explained, and applied
  await room.getByRole('button', { name: 'Agentic', exact: true }).click();
  await room.getByTestId('agentic-input').fill('Please add an operation for the overdue report and fill the overdue screen in the screen contract.');
  await room.getByTestId('agentic-send').click();
  await expect(room.getByTestId('agentic-proposal')).toBeVisible({ timeout: NAVIGATION });
  await room.getByTestId('agentic-compare').click();
  const overlay = room.getByRole('dialog', { name: /proposal/ });
  await expect(overlay).toBeVisible({ timeout: UI_READY });
  await expect(overlay).toContainText('Touched by this proposal');
  // the saved side and the proposed side, and the rail names both documents the proposal touches
  await expect(overlay).toContainText('BEFORE');
  await expect(overlay).toContainText('AFTER');
  const rail = overlay.getByRole('navigation', { name: 'What this proposal touches' });
  await expect(rail).toContainText('Design record');
  await expect(rail).toContainText('Screen contract');
  // The card's total in the card's noun.
  const applyAll = overlay.getByRole('button', { name: 'Apply all 2 documents' });
  await expect(applyAll).toBeDisabled();
  await overlay.getByLabel(/Explain why the changes are right/).fill('The new operation serves a listed story and the screen names its empty state, which I would check on the Screens tab. E2E-PASS');
  await overlay.getByRole('button', { name: 'Explain to unlock Apply' }).click();
  await expect(applyAll).toBeEnabled({ timeout: NAVIGATION });
  await applyAll.click();
  await expect(overlay).toBeHidden({ timeout: NAVIGATION });
  // the stub's operation lands fourth, traced to the first listed story (US-2)
  await room.getByTestId('design-tab-model').click();
  await expect(room.getByTestId('design-operation-3-name')).not.toHaveValue('');
  await expect(room.getByTestId('design-operation-3-story-US-2')).toHaveAttribute('aria-pressed', 'true');
  // the stub fills the first screen row with no component: TaskTrackr's #/overdue, the third
  await room.getByTestId('design-tab-screens').click();
  await expect(room.getByTestId('design-screen-2-route')).toHaveValue('#/overdue');
  await expect(room.getByTestId('design-screen-2-component')).toHaveValue('StubScreen');
  await expect(room.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });
  // Nothing on the room page names a file: not with the applied proposal on the card, and not after a reload,
  // when the applied proposal is the one the card selects.
  const noFileNames = async () => {
    await expect(room.getByTestId('agentic-proposal')).toBeVisible({ timeout: NAVIGATION });
    await expect(room.getByTestId('agentic-structured-summary')).toBeVisible();
    await expect(room.locator('body')).not.toContainText(/\.(json|md)\b/, { useInnerText: true });
  };
  await noFileNames();
  await room.reload();
  await expect(room.getByTestId('design-tab-model')).toBeVisible({ timeout: NAVIGATION });
  if (!(await room.getByTestId('agentic-input').isVisible())) await room.getByRole('button', { name: 'Agentic', exact: true }).click();
  await noFileNames();

  // the floor in words, then the review
  await room.getByTestId('phase-design-render').click();
  await expect(room.getByTestId('phase-design-checks')).toBeVisible();
  // the floor the teacher set reads back in words
  await expect(room.getByTestId('phase-design-floor-sentence')).toContainText('at least 2 entities');
  await expect(room.getByTestId('phase-design-check-design.sequence')).toContainText('Passed');
  for (const row of await room.locator('[data-testid^="phase-design-check-design."]').all()) await expect(row).toContainText('Passed');
  await room.getByTestId('design-submit').click();
  // Submit opens the review in the room, on its Review tab: the stub passes the marked design.
  await expect(room.getByTestId('design-review').getByTestId('feedback-verdict')).toContainText('Pass', { timeout: 90_000 });
  expect(new URL(room.url()).pathname).toBe(`/workspace/${design.id}/design`);
  // Back in the room, nothing names a file: the forms are the record and the contracts.
  await room.goto(`/workspace/${design.id}/design`);
  await expect(room.getByTestId('design-board-entity-1-name')).toHaveValue('Task', { timeout: NAVIGATION });
  await expect(room.getByTestId('phase-design-editor')).not.toContainText('.json');
  await learnerContext.close();
});
