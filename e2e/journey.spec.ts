import { expect, Page, test } from '@playwright/test';
import {
  CR2_REPOSITORY_COMMENTS,
  CR2_REPOSITORY_TASKS,
  CR2_ROUTES_COMMENTS,
  CR2_TASK_ROW,
  MY_CI,
  MY_COMPOSE,
  MY_DOCKERFILE,
  MY_TESTS,
  MY_WEB_TESTS,
  SOLUTION_OVERDUE,
  SOLUTION_REPOSITORY,
  SOLUTION_ROUTES,
  SOLUTION_USE_TASKS,
  CHANGE_REQUEST_RECORD,
  RUNBOOK_RECORD,
} from './fixtures';
import { closeDrillByApi, fillChangeForms, fillRunbookForms } from './record-forms';
import { dismissPhaseTutorial, E2E_PASS, joinClassInUi, openRequirements, registerAndSignIn, requirementsTab, signInAs, signOutFromMenu, teacherHome, continueMyProject } from './pw-fixtures';
import { ADMIN, INSTRUCTOR, PASSING_DESIGN, classByApi, enrolByApi, registerByApi } from './passing-work';
import { API, API_ORIGIN, RUN_ID, testEmail } from './support/env';
import { NAVIGATION, SANDBOX_RUN, UI_READY } from './support/timeouts';

/**
 * The end-to-end acceptance test: one learner carries the reference project end-to-end through all five
 * SDLC phases, with the AI mentor, code execution, automated feedback and
 * gating all exercised through the real UI.
 */

// One run-wide account (E2E_RUN_ID), so the cases after the walk still sign
// in as its learner when a failure restarts the worker.
const LEARNER_EMAIL = testEmail(`e2e-${RUN_ID}`);
// Not 'Password1!': that is on the common-password list registration refuses.
const LEARNER_PASSWORD = 'Correct-Horse-9';
const LEARNER_NAME = 'Eve Endtoend';
const JOURNEY_CLASS = `E2E journey class ${Date.now()}`;
/**
 * The address the walk passed all six phases as, once it has (a retry walks as
 * a learner of its own). Module state lives as long as the worker, and a worker
 * is replaced only after a failure, so the console case below sees it exactly
 * when the walk before it got through.
 */
let finishedWalk: string | null = null;

async function setEditor(page: Page, basename: string, content: string): Promise<void> {
  await page.waitForFunction(
    (name) =>
      Boolean(
        (window as any).monaco?.editor
          ?.getModels()
          .some((m: any) => m.uri.toString().endsWith(name)),
      ),
    basename,
    { timeout: UI_READY },
  );
  await page.evaluate(
    ({ name, value }) => {
      const monaco = (window as any).monaco;
      const model = monaco.editor.getModels().find((m: any) => m.uri.toString().endsWith(name));
      // An edit, not setValue: the editor treats a flush as a refresh of the saved
      // copy and ignores it (CodeEditor.tsx), so typing has to arrive as an edit.
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    },
    { name: basename, value: content },
  );
  // Exact match: the indicator also renders "Unsaved", which a loose /saved/i
  // would happily match while the workspace is still dirty.
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
}

/**
 * Open a file, from the tab strip if it is already there and from the Explorer
 * if it is not, and wait for its tab. A 26-file two-directory repository does
 * not fit its editable files in the strip on arrival, and `setEditor` waits for
 * a Monaco model, which exists only for a file the workspace has opened.
 */
async function openFile(page: Page, filePath: string): Promise<void> {
  const slug = filePath.replace(/[/.]/g, '-');
  const tab = page.getByTestId(`file-tab-${slug}`);
  if ((await tab.count()) === 0) {
    await page.getByTestId(`explorer-file-${slug}`).click();
  } else {
    await tab.click();
  }
  await expect(page.getByTestId(`file-tab-${slug}`)).toBeVisible({ timeout: 15_000 });
}

/** Open a file and write it, addressed by its workspace path throughout. */
async function writeFile(page: Page, filePath: string, content: string): Promise<void> {
  await openFile(page, filePath);
  await setEditor(page, filePath, content);
}

async function submitAndExpectPass(page: Page): Promise<void> {
  await page.getByTestId('header-submit').click();
  // The verdict's words for a pass (was "Gate passed").
  await expect(page.getByTestId('feedback-verdict')).toContainText('All required evidence accepted', {
    timeout: 180_000,
  });
}

async function reflectAndAdvance(page: Page, isLast = false): Promise<void> {
  await page.getByTestId('open-reflection').click();
  await page
    .getByTestId('reflection-input')
    .fill(
      'The rubric feedback showed me exactly where my artefact was weakest, and fixing that changed how I will approach the next phase.',
    );
  await page.getByTestId('reflection-submit').click();
  if (isLast) {
    await expect(page).toHaveURL(/\/complete/, { timeout: UI_READY });
  } else {
    await expect(page.getByTestId('gate-banner')).toBeHidden({ timeout: UI_READY });
  }
}


/** PUT the phase's workspace as the signed-in learner, the way the API helpers write work. */
async function saveWorkspace(page: Page, phaseId: string, files: Record<string, string>): Promise<void> {
  const status = await page.evaluate(
    async ({ apiUrl, id, body }) => {
      const token = localStorage.getItem('lsdlc_token');
      const res = await fetch(`${apiUrl}/api/v1/phases/${id}/workspace`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ files: body }),
      });
      return res.status;
    },
    { apiUrl: API_ORIGIN, id: phaseId, body: files },
  );
  expect(status, 'the design is saved').toBeLessThan(300);
}

/**
 * The door opens the phase's room in one step: the issue, the design
 * board, the IDE or the change request, with no case file in front of it and
 * nothing to press.
 */
async function enterPhase(page: Page): Promise<void> {
  await page.waitForURL((url) => /^\/workspace\//.test(url.pathname) && !/\/brief(\?|$)/.test(url.pathname), { timeout: UI_READY });
}

// In order, one worker, not serial: the walk needs a host that runs learner
// code from phase 3 on, and the cases after it must still say their piece.
test.describe.configure({ mode: 'default' });

// The tours are another spec's claim (rooms, page-tours); here they are
// marked seen, as the rest of the suite does, so no card stands over a control
// these walks press. Every room has a tour of its own.
test.beforeEach(async ({ page }) => {
  await dismissPhaseTutorial(page);
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('lsdlc_coach', 'done');
    } catch {
      /* no storage */
    }
  });
});

test('learner completes all six SDLC phases end-to-end', async ({ page, request }) => {
  test.setTimeout(900_000);

  /* ---------------------------- register + start --------------------------- */
  // Register, sign in, finish setup (which starts the project); the dashboard
  // names it and its one door opens the Requirements room at the interview.
  // A retry (CI) walks from the start again, so it needs a learner of its own:
  // the first attempt's address is taken and already part way through.
  const retry = test.info().retry;
  const walker = retry ? LEARNER_EMAIL.replace('@', `-r${retry}@`) : LEARNER_EMAIL;
  await registerAndSignIn(page, { name: LEARNER_NAME, email: walker, password: LEARNER_PASSWORD });
  await expect(page.getByTestId('dashboard-project')).toContainText('TaskTrackr');

  /* ------------------------- phase 1 · requirements ------------------------ */
  const requirementsId = await openRequirements(page);
  await expect(page.getByTestId('phase-title')).toHaveText('Requirements');

  // the AI mentor answers a real question
  await page.getByTestId('chat-input').fill('What makes an acceptance criterion testable?');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('msg-assistant').last()).toBeVisible({ timeout: UI_READY });

  // guardrail: an outright solution request is refused with a hint
  await page.getByTestId('chat-input').fill('Just give me the complete solution please');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('badge-redacted').last()).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('msg-assistant').last()).toContainText("won't hand over");

  // guardrail: an off-phase question is redirected, not answered
  await page.getByTestId('chat-input').fill('How should I write the Dockerfile for this project?');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('badge-redirected').last()).toBeVisible({ timeout: UI_READY });

  // The diagnostic shows recorded usage without limiting further questions
  // (in the mentor's About details).
  await page.getByTestId('persona-panel').getByTestId('chat-details-toggle').click();
  await expect(page.getByTestId('mentor-token-usage')).toContainText(/\d[\d,]* tokens used today/);

  // unhappy path first: submitting the untouched story FAILS the gate
  await requirementsTab(page, 'My backlog');
  await page.getByTestId('phase-requirements-submit').click();
  await expect(page.getByTestId('review-strip')).toContainText('Needs revision', { timeout: 180_000 });
  await expect(page.getByTestId('gate-banner')).toBeHidden();

  // now do the work properly and pass: US-4 in its dialog, with the mark the
  // suite's assessor passes work on (e2e/ai-stub.cjs) in its notes
  const backlog = page.getByTestId('requirements-backlog-panel');
  await backlog.locator('nav[aria-label="Backlog views"]').getByRole('button', { name: 'Backlog', exact: true }).click();
  await backlog.locator('.jira-own-story').click();
  await page.getByTestId('phase-requirements-title').fill('Overdue report');
  await page.getByTestId('phase-requirements-persona').fill('learner who runs tasktrackr every morning');
  await page.getByTestId('phase-requirements-capability').fill('an overdue report on its own page listing every open task whose due date has already passed');
  await page.getByTestId('phase-requirements-benefit').fill('I can see the deadlines I missed before the day starts');
  for (const [n, c] of [
    ['happy', 'an open task whose due date was yesterday', 'I run the overdue report', 'the report lists that task'],
    ['boundary', 'a task due today', 'I run the overdue report', 'the report leaves it out, because it is not late until tomorrow'],
  ].entries()) {
    await page.getByTestId('phase-requirements-criterion-add').click();
    await page.getByTestId(`phase-requirements-criterion-${n + 1}-tag`).selectOption(c[0]);
    await page.getByTestId(`phase-requirements-criterion-${n + 1}-given`).fill(c[1]);
    await page.getByTestId(`phase-requirements-criterion-${n + 1}-when`).fill(c[2]);
    await page.getByTestId(`phase-requirements-criterion-${n + 1}-then`).fill(c[3]);
  }
  await page.getByTestId('phase-requirements-scope-add').click();
  await page.getByTestId('phase-requirements-scope-1').fill('reminder emails and push notifications');
  await page.getByTestId('phase-requirements-notes').fill(`Settled with the product owner. ${E2E_PASS}`);
  await page.getByRole('button', { name: 'Save story', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit story US-4' })).toBeHidden();
  await page.getByTestId('phase-requirements-submit').click();
  await expect(page.getByTestId('gate-banner')).toBeVisible({ timeout: 180_000 });
  await reflectAndAdvance(page);

  /* ------------------- session round-trip mid-journey ---------------------- */
  await expect(page.getByTestId('phase-title')).toHaveText('Design', { timeout: NAVIGATION });
  await signOutFromMenu(page);

  await signInAs(page, walker, LEARNER_PASSWORD);
  await expect(page.getByTestId('dashboard-project')).toContainText('TaskTrackr', { timeout: UI_READY });
  await continueMyProject(page);

  /* ---------------------------- phase 2 · design --------------------------- */
  await expect(page.getByTestId('phase-title')).toHaveText('Design');
  // A fresh sign-in, nothing submitted in Design: the room, in one step.
  await enterPhase(page);
  const designId = /\/workspace\/([0-9a-f-]+)/.exec(page.url())![1];
  // The room's forms are walked in slices.spec.ts and design-builder.spec.ts;
  // here the whole design (the record, marked in its notes, and both
  // contracts, e2e/passing-work.ts) is one workspace write through the API.
  await saveWorkspace(page, designId, PASSING_DESIGN);

  // workspace persistence: a full page reload of the room shows the forms holding it
  await page.goto(`/workspace/${designId}/design`);
  await expect(page.getByTestId('phase-design-editor')).toBeVisible({ timeout: NAVIGATION });
  await page.getByTestId('design-tab-model').click();
  await expect(page.getByTestId('design-board-entity-0-name')).toHaveValue('Task', { timeout: UI_READY });
  await expect(page.getByTestId('phase-design-editor')).not.toContainText('.json');

  // Submit opens the review in the room, on its Review tab, which passes; the merge is the room's own gate banner.
  await page.getByTestId('design-submit').click();
  await expect(page.getByTestId('design-review').getByTestId('feedback-verdict')).toContainText('Pass', { timeout: 180_000 });
  expect(new URL(page.url()).pathname).toBe(`/workspace/${designId}/design`);
  await expect(page.getByTestId('gate-banner')).toBeVisible({ timeout: NAVIGATION });
  await reflectAndAdvance(page);

  /* ------------------------ phase 3 · implementation ----------------------- */
  await expect(page.getByTestId('phase-title')).toHaveText('Implementation');
  // The merge opened the next phase's room, the IDE.
  await enterPhase(page);
  await expect(page.getByTestId('phase-title')).toHaveText('Implementation');

  // fast feedback loop first: the TODO stubs fail both visible suites
  await page.getByTestId('header-run').click();
  await expect(page.getByTestId('run-summary')).toContainText('0/6 tests passed', {
    timeout: 180_000,
  });
  // Two runs, and the Tests pane groups the cases under their own labels.
  await expect(page.getByTestId('run-panel')).toContainText('API tests');
  await expect(page.getByTestId('run-panel')).toContainText('Front end');

  // The API half first, so the run in the middle says which language is red.
// The suite's assessor passes only marked work (e2e/ai-stub.cjs): a comment line.
  await writeFile(page, 'api/repository/tasks.py', `${SOLUTION_REPOSITORY}\n# ${E2E_PASS}\n`);
  await writeFile(page, 'api/routes/tasks.py', SOLUTION_ROUTES);
  await page.getByTestId('header-run').click();
  await expect(page.getByTestId('run-summary')).toContainText('4/6 tests passed', {
    timeout: 180_000,
  });

  // Then the same boundary rule again, in TypeScript, and the hook under it.
  await writeFile(page, 'web/src/lib/overdue.ts', SOLUTION_OVERDUE);
  await writeFile(page, 'web/src/hooks/useTasks.ts', SOLUTION_USE_TASKS);
  await page.getByTestId('header-run').click();
  await expect(page.getByTestId('run-summary')).toContainText('6/6 tests passed', {
    timeout: 180_000,
  });

  await submitAndExpectPass(page);
  // The card counts every case the review ran, visible and hidden apart,
  // and titles the combined total "Test cases".
  await expect(page.getByTestId('feedback-report')).toContainText('Test cases');
  await expect(page.getByTestId('feedback-report').getByTestId('suite-count-total')).toBeVisible();
  await expect(page.getByTestId('feedback-report')).toContainText('Correctness (hidden tests)');
  await expect(page.getByTestId('ai-review')).toContainText('Strengths');
  await reflectAndAdvance(page);

  /* ---------------- revisit a passed phase: everything persists ------------- */
  await expect(page.getByTestId('phase-title')).toHaveText('Testing');
  // There is no stepper and no IDE behind Requirements: a passed room is
  // revisited at its own door, and its record is the room itself.
  await page.goto(`/workspace/${requirementsId}/interview`);
  await expect(page.getByTestId('phase-title')).toHaveText('Requirements');
  await expect(page.getByTestId('gate-banner')).toContainText('Phase evidence accepted');
  await expect(page.getByTestId('msg-user').first()).toBeVisible({ timeout: 20_000 }); // chat history
  await requirementsTab(page, 'My backlog');
  await expect(page.getByTestId('requirements-backlog-panel')).toContainText('Overdue report'); // US-4 persisted
  await expect(page.getByTestId('review-strip')).toHaveCount(0); // no "Needs revision" on a passed phase

  /* -------------- a still-locked phase refuses direct access ---------------- */
  const phase5Id = await page.evaluate(async (apiUrl) => {
    const token = localStorage.getItem('lsdlc_token');
    const res = await fetch(`${apiUrl}/api/v1/enrollments/mine?project=tasktrackr`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const enrollment = await res.json();
    return enrollment.phases.find((p: any) => p.order === 5).id;
  }, API_ORIGIN);
  await page.goto(`/workspace/${phase5Id}`);
  await expect(page.getByText(/locked/)).toBeVisible({ timeout: 20_000 });

  /* ---------------------------- phase 4 · testing -------------------------- */
  await page.goto('/dashboard');
  await continueMyProject(page);
  await expect(page.getByTestId('phase-title')).toHaveText('Testing');
  await enterPhase(page);
  await expect(page.getByTestId('phase-title')).toHaveText('Testing');
// The suite's assessor passes only marked work (e2e/ai-stub.cjs): a comment line.
  await writeFile(page, 'tests/test_acceptance.py', `${MY_TESTS}\n# ${E2E_PASS}\n`);
  await writeFile(page, 'web/src/acceptance.test.tsx', MY_WEB_TESTS);
  await page.getByTestId('header-run').click();
  await expect(page.getByTestId('run-summary')).toContainText('tests passed', { timeout: 180_000 });

  await submitAndExpectPass(page);
  // Eight planted bugs over two layers, and a suite that catches all of them.
  await expect(page.getByTestId('mutation-report')).toContainText('8/8');
  await reflectAndAdvance(page);

  /* -------------------------- phase 5 · deployment ------------------------- */
  await expect(page.getByTestId('phase-title')).toHaveText('Deployment');
  await enterPhase(page);
  await expect(page.getByTestId('phase-title')).toHaveText('Deployment');
  // The room opens on its Pipeline since a1e6a1eb; the files are one press away, under Configuration.
  await page.locator('nav[aria-label="Phase working area"]').getByRole('button', { name: 'Configuration', exact: true }).click();
  // Both the image and the compose file: the build check starts the api
  // service through the learner's own ENTRYPOINT and its selfcheck reads their
  // compose, so one without the other leaves the check red.
// The suite's assessor passes only marked work (e2e/ai-stub.cjs): a comment line.
  await writeFile(page, 'api/Dockerfile', `${MY_DOCKERFILE}\n# ${E2E_PASS}\n`);
  await writeFile(page, 'docker-compose.yml', MY_COMPOSE);
  await writeFile(page, '.github/workflows/ci.yml', MY_CI);
  // The runbook is the Runbook tab's forms (under Pipeline), never a file the explorer lists.
  await fillRunbookForms(page, JSON.parse(RUNBOOK_RECORD));
  // The incident the floor asks for is written by closing the drill. This walk is about the room, and the
  // drill has its own slice (slices.spec.ts), so it is closed through the API with the learner's own session.
  const deploymentId = /\/workspace\/([0-9a-f-]+)/.exec(page.url())![1];
  const token = await page.evaluate(() => localStorage.getItem('lsdlc_token'));
  await closeDrillByApi(request, { headers: { authorization: `Bearer ${token}` } }, deploymentId);
  // The resolve moved the stored workspace on: the room reads it again before the run and the submit.
  await page.reload();
  await expect(page.getByTestId('phase-title')).toHaveText('Deployment', { timeout: UI_READY });

  await page.getByTestId('header-run').click();
  await expect(page.getByTestId('run-summary')).toContainText('Run completed successfully', {
    timeout: SANDBOX_RUN,
  });

  await submitAndExpectPass(page);
  await reflectAndAdvance(page);

  /* ------------------------- phase 6 · maintenance ------------------------- */
  await expect(page.getByTestId('phase-title')).toHaveText('Maintenance');
  // The door opens the change request itself, and the editor is one
  // press behind it. The case file's steps name the change request; they are
  // in the room's brief panel, folded under "Mission and review criteria".
  await enterPhase(page);
  await expect(page.getByTestId('phase-mission-mission')).toContainText('CR-2', { timeout: UI_READY });
  // The room is the change request: its Request tab draws the ticket, CR-2 (the IDE behind it draws no ticket).
  await expect(page.getByTestId('change-ticket')).toContainText('CR-2', { timeout: UI_READY });
  // The change request is the room's four tabs, filled before the code.
  await fillChangeForms(page, JSON.parse(CHANGE_REQUEST_RECORD));
  await page.getByTestId('open-workspace').click();
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]+$/, { timeout: UI_READY });
  await expect(page.getByTestId('phase-title')).toHaveText('Maintenance');
// The suite's assessor passes only marked work (e2e/ai-stub.cjs): a comment line.
  await writeFile(page, 'api/repository/tasks.py', `${CR2_REPOSITORY_TASKS}\n# ${E2E_PASS}\n`);
  await writeFile(page, 'api/repository/comments.py', CR2_REPOSITORY_COMMENTS);
  await writeFile(page, 'api/routes/comments.py', CR2_ROUTES_COMMENTS);
  await writeFile(page, 'web/src/components/TaskRow.tsx', CR2_TASK_ROW);
  await page.getByTestId('header-run').click();
  await expect(page.getByTestId('run-summary')).toContainText('tests passed', { timeout: 180_000 });

  await submitAndExpectPass(page);
  await expect(page.getByTestId('feedback-report')).toContainText('Change and regression');
  await expect(page.getByTestId('feedback-report')).toContainText('Change request');
  await reflectAndAdvance(page, true);
  // All six phases have passed: the console case below holds this learner to 6 / 6.
  finishedWalk = walker;

  /* ------------------------------- completion ------------------------------ */
  // The completion record (app/(app)/completion/page.tsx) names the learner;
  // Home then counts 6/6 and its door leads back to the record.
  await expect(page.locator('.exp-certificate-name')).toHaveText(LEARNER_NAME);
  await page.goto('/dashboard');
  await expect(page.getByTestId('tile-progress')).toContainText('6/6');
  await expect(page.getByRole('link', { name: 'View completion record', exact: true })).toBeVisible();
});

/**
 * An instructor's console shows the classes they own. `default` is not a class:
 * it is where an account sits before it joins one, and it is an admin's view,
 * not an instructor's, so this test makes a class and has the learner
 * redeem the code before reading the console.
 *
 * The console is the teacher home (/teacher). The class is made
 * through the API (making one in the page is management.spec.ts's case), the
 * learner joins from the classroom page, and sign-out is in the account menu.
 * The provider tile and the rubric list are drawn by no page, and the
 * learner's share of the project is the roster's count of passed phases, whose
 * value depends on how far the walk above got on this host, so the row is
 * held to the learner's own count of passed phases, read from their enrolment,
 * not to "100%". After a walk that finished (finishedWalk), the learner read is
 * the one who walked and the row must say 6 / 6, the console's side of a
 * finished walk. The learner is made here when the walk above did not run.
 */
test('instructor console shows its cohort without daily token controls', async ({ page, request }) => {
  test.setTimeout(180_000);
  const email = finishedWalk ?? LEARNER_EMAIL;
  const signedIn = await request.post(`${API}/auth/login`, { data: { email, password: LEARNER_PASSWORD } });
  let learnerToken: string;
  if (!signedIn.ok()) {
    const learner = await registerByApi(request, { name: LEARNER_NAME, email, password: LEARNER_PASSWORD });
    await enrolByApi(request, learner);
    learnerToken = learner.token;
  } else {
    learnerToken = (await signedIn.json()).token as string;
  }
  // How many phases the learner has passed, read off their own enrolment, so
  // the console's count is checked exactly; after a finished walk that is six.
  const mine = await request.get(`${API}/enrollments/mine`, { headers: { authorization: `Bearer ${learnerToken}` } });
  expect(mine.ok(), "the learner's enrolment reads").toBeTruthy();
  const enrolment = await mine.json();
  const learnerPhases: { status?: string }[] = Array.isArray(enrolment) ? enrolment : enrolment.phases ?? [];
  expect(learnerPhases.length, 'the learner has six phases').toBe(6);
  const passedPhases = learnerPhases.filter((phase) => phase.status === 'passed').length;
  if (finishedWalk) expect(passedPhases, 'the walk above finished, so every phase is passed').toBe(6);
  const { joinCode } = await classByApi(request, JOURNEY_CLASS);

  /* --------------------- the learner redeems the code ---------------------- */
  await signInAs(page, email, LEARNER_PASSWORD);
  await page.waitForURL('**/dashboard', { timeout: NAVIGATION });
  await joinClassInUi(page, joinCode);
  await signOutFromMenu(page);

  /* --------------------------- back to the console ------------------------- */
  await signInAs(page, INSTRUCTOR.email, INSTRUCTOR.password);
  await teacherHome(page);
  // The roster is the class's own page, opened from its card on the home.
  await page.locator('li', { hasText: JOURNEY_CLASS }).locator('a.exp-row').first().click();
  await page.waitForURL(/\/teacher\/class\?class=/, { timeout: NAVIGATION });
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  const learnerRow = page.locator('tr', { hasText: email });
  await expect(learnerRow).toContainText(LEARNER_NAME, { timeout: UI_READY });
  await expect(learnerRow).toContainText(JOURNEY_CLASS);
  await expect(learnerRow).toContainText(finishedWalk ? '6 / 6' : `${passedPhases} / 6`);

  // Daily token limits are not configurable by either staff role.
  await expect(page.getByTestId('budget-note')).toHaveCount(0);
  await expect(page.getByTestId('budget-save')).toHaveCount(0);

  await signOutFromMenu(page);
  await signInAs(page, ADMIN.email, ADMIN.password);
  await teacherHome(page);
  await expect(page.getByTestId('budget-input')).toHaveCount(0);
  await expect(page.getByTestId('budget-save')).toHaveCount(0);
});

test('authentication rejects bad credentials and duplicate accounts', async ({ page, request }) => {
  // The address must exist for the duplicate to be one: the walk above made
  // it, unless the walk never got that far (or ran again under a retry's own
  // address), and then it is made here.
  const exists = await request.post(`${API}/auth/login`, { data: { email: LEARNER_EMAIL, password: LEARNER_PASSWORD } });
  if (!exists.ok()) await registerByApi(request, { name: LEARNER_NAME, email: LEARNER_EMAIL, password: LEARNER_PASSWORD });

  await page.goto('/login');
  await signInAs(page, LEARNER_EMAIL, 'WrongPassword1!');
  await expect(page.getByTestId('auth-error')).toContainText('invalid');

  await page.goto('/register');
  await page.getByTestId('displayName').fill('Duplicate');
  await page.getByTestId('email').fill(LEARNER_EMAIL);
  // A strong password, so the refusal is about the address and nothing else.
  await page.getByTestId('password').fill('Another-Fine-Password-7');
  await page.getByTestId('register-submit').click();
  await expect(page.getByTestId('auth-error')).toContainText('already exists');
});

/* ---------------------------- gate enforcement ---------------------------- */

const GATED_EMAIL = testEmail(`e2e-gated-${Date.now()}`);
const GATED_NAME = 'Gail Gated';

/** POST to a phase action as the signed-in learner, returning status and body. */
async function postPhaseAction(
  page: Page,
  phaseId: string,
  action: 'run' | 'submit',
): Promise<{ status: number; message: string }> {
  return page.evaluate(
    async ({ apiUrl, id, act }) => {
      const token = localStorage.getItem('lsdlc_token');
      const res = await fetch(`${apiUrl}/api/v1/phases/${id}/${act}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, message: String(body.message ?? '') };
    },
    { apiUrl: API_ORIGIN, id: phaseId, act: action },
  );
}

test('run and submit refuse a phase whose gate has not been passed', async ({ page }) => {
  // Register, sign in, finish setup (which starts the project); the room it
  // opens is enough to know the enrolment exists.
  await registerAndSignIn(page, { name: GATED_NAME, email: GATED_EMAIL, password: LEARNER_PASSWORD });
  await openRequirements(page);
  await expect(page.getByTestId('phase-title')).toHaveText('Requirements');

  // The UI never offers a locked phase's Submit, so this goes straight at the
  // API the way a curious learner with the network tab open would.
  const lockedId = await page.evaluate(async (apiUrl) => {
    const token = localStorage.getItem('lsdlc_token');
    const res = await fetch(`${apiUrl}/api/v1/enrollments/mine?project=tasktrackr`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const enrollment = await res.json();
    return enrollment.phases.find((p: any) => p.order === 2).id as string;
  }, API_ORIGIN);

  const submit = await postPhaseAction(page, lockedId, 'submit');
  expect(submit.status).toBe(403);
  expect(submit.message).toContain('phase is locked');

  const run = await postPhaseAction(page, lockedId, 'run');
  expect(run.status).toBe(403);
  expect(run.message).toContain('phase is locked');
});
