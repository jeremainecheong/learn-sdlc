import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { INSTRUCTOR, classByApi, registerByApi, staffByApi, type ApiLearner } from './passing-work';
import { E2E_PASS, LEARNER_PASSWORD, dismissPhaseTutorial, inspectLearnerPhase, signInAs, signInTo } from './pw-fixtures';
import { API, RUN as BASE_RUN, testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The teacher's five-step Requirements builder, end to end, and a learner who
 * passes what it built with an Agentic proposal.
 *
 * The teacher copies TaskTrackr and builds its Requirements in the five cards
 * of the editor (background, stakeholder, provided stories, the learner's
 * story with its floor, the criteria), each saved by its own button; publishes
 * the copy; and assigns it to a new class. A learner in that class writes US-4
 * in the backlog's dialog, one criterion and one out-of-scope line short of
 * the floor the teacher raised, asks the Agentic mentor for the boundary,
 * reads the proposal in the before/after overlay, explains it, applies it, and
 * submits. The teacher then reads the pass on the class page and the story
 * in the learner's printable dossier.
 *
 * No real AI: every model request goes to e2e/ai-stub.cjs. Its proposal for a
 * story record is fixed (a boundary criterion, given "a task due today", and
 * the out-of-scope line "reminders and notifications"), and it accepts an
 * explanation or a submission only when it carries the E2E-PASS mark.
 */

// A CI retry (`retries: 1` under CI) runs the test again with the same
// E2E_RUN_ID; the retry index keeps its slug, class and email new, so a retry
// can recover rather than collide with what the first try made (as
// e2e/learner-reset.spec.ts does).
let RUN = BASE_RUN;
test.beforeEach(async ({}, testInfo) => {
  RUN = testInfo.retry ? `${BASE_RUN}-r${testInfo.retry}` : BASE_RUN;
});
const LEARNER_NAME = 'Bea Builder';

/** The stub's canned prompt for a story proposal (e2e/ai-stub.cjs storyProposal), verbatim. */
const STORY_PROMPT = 'Add a boundary criterion to my story saying a task due today is not overdue.';
/** What the stub's proposal adds (e2e/ai-stub.cjs BOUNDARY_CRITERION and STUB_EXCLUSION). */
const STUB_BOUNDARY_GIVEN = 'a task due today';
const STUB_EXCLUSION = 'reminders and notifications';

/* --------------------------------- helpers -------------------------------- */

/** A class of the instructor's, with the published copy assigned to it. Returns the join code. */
async function assignToNewClass(
  request: APIRequestContext,
  versionId: string,
  name: string,
): Promise<{ cohortId: string; joinCode: string }> {
  const made = await classByApi(request, name);
  const assigned = await request.put(`${API}/instructor/cohorts/${made.cohortId}/project`, {
    headers: made.staff.headers,
    data: { projectVersionId: versionId, reason: 'This class works the Requirements the builder made.' },
  });
  expect(assigned.ok(), 'the copy is the class project').toBeTruthy();
  return { cohortId: made.cohortId, joinCode: made.joinCode };
}

/** A learner made through the API, setup done, so signing in lands on the dashboard. */
async function registerLearner(request: APIRequestContext): Promise<ApiLearner> {
  return registerByApi(request, { email: testEmail(`builder-learner-${RUN}`), password: LEARNER_PASSWORD, name: LEARNER_NAME });
}

/** Join the class by its code and enrol on its project; the phases as the enrolment answers them. */
async function joinClass(request: APIRequestContext, learner: ApiLearner, joinCode: string): Promise<{ id: string; key: string }[]> {
  const joined = await request.post(`${API}/enrollments/join`, { headers: learner.headers, data: { code: joinCode } });
  expect(joined.ok(), 'the learner joins the class').toBeTruthy();
  const enrolled = await request.post(`${API}/enrollments`, { headers: learner.headers, data: {} });
  expect(enrolled.ok(), 'the learner enrols on the class project').toBeTruthy();
  const board = await enrolled.json();
  expect(board.projectIsDefault, 'the class project is the copy, not the platform project').toBe(false);
  return board.phases;
}

/** The learner's Requirements room: the backlog, where US-4 is written. */
function requirementsRoomUrl(phases: { id: string; key: string }[]): string {
  const requirements = phases.find((one) => one.key === 'requirements');
  expect(requirements, 'the copy has a Requirements phase').toBeTruthy();
  return `/workspace/${requirements!.id}/issue`;
}

/** One builder card's save: press its button and wait for its own status line to say Saved. */
async function saveCard(page: Page, card: string, button: string): Promise<void> {
  await page.getByTestId(button).click();
  await expect(page.getByTestId(`${card}-status`)).toHaveText('Saved', { timeout: UI_READY });
}

/* ---------------------------------- test ---------------------------------- */

test('a teacher builds Requirements in five cards, publishes, assigns; a learner passes it with a proposal', async ({ page, browser, request }) => {
  test.setTimeout(600_000);
  const PROJECT_TITLE = `Builder TaskTrackr ${RUN}`;
  const PROJECT_SLUG = `builder-tasktrackr-${RUN}`;
  const CLASS_NAME = `Builder class ${RUN}`;

  /* --------------------------- the teacher's copy --------------------------- */
  await signInAs(page, INSTRUCTOR.email, INSTRUCTOR.password);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
  await page.goto('/teacher/projects');
  await page.getByTestId('projects-copy-tasktrackr').click();
  await page.getByTestId('projects-new-title').fill(PROJECT_TITLE);
  await page.getByTestId('projects-new-slug').fill(PROJECT_SLUG);
  await page.getByTestId('projects-new-submit').click();
  await page.waitForURL(/\/teacher\/projects\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}$/, { timeout: NAVIGATION });
  await page.getByTestId('project-phase-tab-requirements').click();
  await expect(page.getByTestId('requirements-builder')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('tre-steps')).toBeVisible();

  /* -------------------------- 1. the background ---------------------------- */
  const background = 'TaskTrackr helps people juggling study and work keep their lists. Nobody has specified the overdue report yet.';
  await page.getByTestId('tre-background').getByRole('textbox').fill(background);
  await saveCard(page, 'tre-background', 'tre-background-save');

  /* ------------------ 2. the stakeholder, as the copy holds it ------------- */
  // TaskTrackr's interview is written by hand in the pack; the card reads it.
  await expect(page.getByTestId('tre-stakeholder-opening')).not.toBeEmpty();
  await expect(page.getByTestId('tre-stakeholder-state')).toHaveText('Done');

  /* ------------------------- 3. a provided story --------------------------- */
  const provided = page.getByTestId('tre-provided');
  await provided.getByRole('button', { name: 'Add a provided story' }).click();
  // The next free id after US-1, US-2, US-3, US-5 and the learner's US-4.
  const editor = page.getByTestId('tre-provided-editor-US-6');
  await expect(editor).toBeVisible();
  await editor.getByLabel('US-6 title').fill('Reopen a task');
  await editor.getByLabel('US-6 As a').fill('busy learner');
  await editor.getByLabel('US-6 I want').fill('to reopen a task I completed by mistake');
  await editor.getByLabel('US-6 So that').fill('it is back on my list with its due date');
  await saveCard(page, 'tre-provided', 'tre-provided-save');

  /* --------------------- 4. the learner's story and floor ------------------ */
  const learnerStory = page.getByTestId('tre-learner-story');
  await learnerStory.getByLabel('Minimum acceptance criteria').fill('2');
  // Two out-of-scope lines, one more than the pack's floor, so the learner's
  // one line is short of it until the proposal adds the second. The pack's
  // floor already asks for 2 criteria; the out-of-scope count is what changes.
  const floorSentence = page.getByTestId('tre-floor-sentence');
  await expect(floorSentence).toContainText('at least 1 out-of-scope line');
  await learnerStory.getByLabel('Minimum out-of-scope lines').fill('2');
  await expect(floorSentence).toContainText('at least 2 out-of-scope lines');
  await saveCard(page, 'tre-learner', 'tre-learner-save');

  /* ----------------------------- 5. the criteria --------------------------- */
  const criteria = page.getByTestId('tre-criteria');
  const before = await criteria.locator('[data-testid^="tre-criterion-"]').count();
  await criteria.getByRole('button', { name: 'Add a criterion' }).click();
  const n = before + 1;
  await criteria.getByLabel(`Criterion ${n} title`).fill('Where the report appears');
  await criteria.getByLabel(`Criterion ${n} description`).fill('The story says the report is a page of its own, not a filter on one list.');
  // The pack's three weigh 0.3, 0.4 and 0.3: the new one at 0.1 takes the sum
  // to 1.1, off, until the second gives up 0.1 and it is back at 1.
  const weightsSum = page.getByTestId('tre-weights-sum');
  await criteria.getByLabel(`Criterion ${n} weight`).fill('0.1');
  await expect(weightsSum).toHaveText('Weights sum to 1.1 now. They must sum to 1.');
  await criteria.getByLabel('Criterion 2 weight').fill('0.3');
  await expect(weightsSum).toContainText('Weights sum to 1.0');
  await saveCard(page, 'tre-criteria', 'tre-criteria-save');

  /* --------------------------- publish and assign -------------------------- */
  // The checks are under the editor's Validate tab.
  await page.getByTestId('project-section-validate').click();
  await page.getByTestId('project-validate').click();
  await expect(page.getByTestId('project-validation-tier')).toBeVisible({ timeout: NAVIGATION });
  // The publish form is under the editor's Publish tab.
  await page.getByTestId('project-section-publish').click();
  await page.getByTestId('project-publish-version').fill('1.0.0');
  await page.getByTestId('project-publish-notes').fill('Requirements built in five steps.');
  await page.getByRole('button', { name: 'Publish this version' }).click();
  await page.getByTestId('project-publish-confirm-yes').click();
  await expect(page.getByTestId('project-published')).toContainText('Version 1.0.0 is published', { timeout: NAVIGATION });

  const staff = await staffByApi(request);
  const library = await (await request.get(`${API}/instructor/projects`, { headers: staff.headers })).json();
  const copy = library.mine.find((one: { slug: string }) => one.slug === PROJECT_SLUG);
  expect(copy?.publishedVersionId, 'the copy has a published version').toBeTruthy();
  const { cohortId, joinCode } = await assignToNewClass(request, copy.publishedVersionId, CLASS_NAME);

  /* ------------------------------- the learner ----------------------------- */
  const learnerContext = await browser.newContext();
  const learner = await learnerContext.newPage();
  const who = await registerLearner(request);
  const phases = await joinClass(request, who, joinCode);
  const room = requirementsRoomUrl(phases);
  await dismissPhaseTutorial(learner);
  await signInTo(learner, who.email, who.password, room);
  const backlog = learner.getByTestId('requirements-backlog-panel');
  await expect(backlog).toBeVisible({ timeout: NAVIGATION });
  // The published copy reaches the learner: the backlog lists the provided story the teacher added in step 3.
  await expect(backlog).toContainText('US-6', { timeout: UI_READY });
  await expect(backlog).toContainText('Reopen a task');

  // US-4 in its dialog: the sentence, one happy criterion, one exclusion,
  // and the mark the stub passes work on, in the notes.
  await backlog.locator('.jira-own-story').click();
  await learner.getByTestId('phase-requirements-title').fill('Overdue report');
  await learner.getByTestId('phase-requirements-persona').fill('learner who runs tasktrackr every morning');
  await learner.getByTestId('phase-requirements-capability').fill('an overdue report on its own page listing every open task whose due date has passed');
  await learner.getByTestId('phase-requirements-benefit').fill('I can see the deadlines I missed before the day starts');
  await learner.getByTestId('phase-requirements-criterion-add').click();
  await learner.getByTestId('phase-requirements-criterion-1-tag').selectOption('happy');
  await learner.getByTestId('phase-requirements-criterion-1-given').fill('an open task whose due date was yesterday');
  await learner.getByTestId('phase-requirements-criterion-1-when').fill('I open the overdue report');
  await learner.getByTestId('phase-requirements-criterion-1-then').fill('the report lists that task');
  await learner.getByTestId('phase-requirements-scope-add').click();
  await learner.getByTestId('phase-requirements-scope-1').fill('reminder emails');
  await learner.getByTestId('phase-requirements-notes').fill(`Settled with the product owner. ${E2E_PASS}`);
  // On a teacher's copy the dialog is the plain story editor ("Edit story").
  const storyDialog = learner.getByRole('dialog', { name: /^Edit story/ });
  await expect(storyDialog).toBeVisible();
  await storyDialog.getByRole('button', { name: 'Save story', exact: true }).click();
  await expect(storyDialog).toBeHidden();

  // Short of the floor the teacher set: one criterion with no boundary, one out-of-scope line of two.
  const views = backlog.locator('nav[aria-label="Backlog views"]');
  await views.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(learner.getByTestId('phase-requirements-rule-story.criteria.min')).toContainText('Story has fewer than 2 acceptance criteria');
  await expect(learner.getByTestId('phase-requirements-rule-story.criteria.tags')).toContainText('No boundary case among the criteria');
  await expect(learner.getByTestId('phase-requirements-rule-story.scope.min')).toContainText('Fewer than 2 out-of-scope lines');

  /* ------------------------- the Agentic proposal -------------------------- */
  await learner.getByRole('button', { name: 'Agentic', exact: true }).click();
  await learner.getByTestId('agentic-input').fill(STORY_PROMPT);
  await learner.getByTestId('agentic-send').click();
  const proposal = learner.getByTestId('agentic-proposal');
  await expect(proposal).toBeVisible({ timeout: NAVIGATION });
  await proposal.getByRole('button', { name: 'Compare before and after' }).click();

  const compare = learner.getByRole('dialog', { name: /proposal for US-4/ });
  await expect(compare).toBeVisible({ timeout: UI_READY });
  await expect(compare).toContainText('BEFORE');
  await expect(compare).toContainText('AFTER');
  await expect(compare).toContainText(STUB_BOUNDARY_GIVEN);
  await expect(compare).toContainText(STUB_EXCLUSION);
  await expect(compare.getByRole('button', { name: 'Apply to US-4' })).toBeDisabled();
  await compare
    .getByLabel(/Explain why/)
    .fill(`AC-2 keeps a task due today off the report because overdue means past its due date, and reminders stay out of scope. ${E2E_PASS}`);
  await compare.getByRole('button', { name: 'Explain to unlock Apply' }).click();
  const apply = compare.getByRole('button', { name: 'Apply to US-4' });
  await expect(apply).toBeEnabled({ timeout: NAVIGATION });
  await apply.click();
  await expect(compare).toBeHidden({ timeout: NAVIGATION });

  // The record now holds the boundary and both out-of-scope lines: the floor is met.
  await views.getByRole('button', { name: 'Review', exact: true }).click();
  for (const rule of ['story.record', 'story.sentence', 'story.criteria.min', 'story.criteria.tags', 'story.scope.min']) {
    await expect(learner.getByTestId(`phase-requirements-rule-${rule}`), rule).toContainText('Passed', { timeout: UI_READY });
  }
  await views.getByRole('button', { name: 'Backlog', exact: true }).click();
  await backlog.locator('.jira-own-story').click();
  await expect(learner.getByTestId('phase-requirements-criterion-2-given')).toHaveValue(STUB_BOUNDARY_GIVEN);
  await expect(learner.getByTestId('phase-requirements-criterion-2-tag')).toHaveValue('boundary');
  // The dialog's own Cancel is shown, and closes it.
  await storyDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(storyDialog).toBeHidden();

  /* --------------------------------- submit -------------------------------- */
  await learner.getByTestId('phase-requirements-submit').click();
  await expect(learner.getByTestId('gate-banner')).toBeVisible({ timeout: 180_000 });
  await learnerContext.close();

  /* -------------------------- the teacher reads it ------------------------- */
  await page.goto(`/teacher/class?class=${cohortId}`);
  await expect(page.getByText(CLASS_NAME).first()).toBeVisible({ timeout: NAVIGATION });
  // The class map marks the learner's Requirements passed: the cell's badge
  // reads "Review passed", the class map's word for a reviewed pass
  // (teacher-states.ts).
  const cell = page.getByRole('button', { name: `Inspect ${LEARNER_NAME}, Requirements`, exact: true });
  await expect(cell.getByText('Review passed', { exact: true })).toBeVisible({ timeout: UI_READY });
  await inspectLearnerPhase(page, cohortId, LEARNER_NAME, 'Requirements');
  await expect(page.getByText('Submission history')).toBeVisible({ timeout: UI_READY });

  // The learner's row opens their dossier, where the story card is US-4 as applied.
  await page.getByRole('link', { name: 'Print submitted evidence' }).click();
  await page.waitForURL((url) => url.pathname === `/instructor/learners/${who.userId}/dossier`, { timeout: NAVIGATION });
  const story = page.getByTestId('dossier-story');
  await expect(story).toContainText('Overdue report', { timeout: NAVIGATION });
  await expect(story).toContainText(STUB_EXCLUSION);
  // The dossier draws the card without its criteria and lists them in the table beside it.
  await expect(page.getByTestId('dossier-criteria')).toContainText(STUB_BOUNDARY_GIVEN);
});
