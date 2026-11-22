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
import { PASSING_INCIDENT, fillChangeForms, fillRunbookForms } from './record-forms';
import { E2E_PASS, dismissPhaseTutorial, openRequirements, registerAndSignIn, requirementsTab, stripDoor, waitForEditor, continueMyProject } from './pw-fixtures';
import { designTab, expectFloorPassed, fillApiContract, fillDecision, fillModel, fillScreens, fillSequence } from './design-forms';
import { RUN_ID, testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The six phases and everything they leave behind, walked through the pages
 * each one has: the issue editor on `/issue`, the design room's forms
 * on `/design`, the IDE on `/workspace/[id]`, the pull request on `/pr`, the
 * kill matrix on `/matrix`, the incident drill on `/drill` and CR-2 on
 * `/change`, until the project is complete.
 *
 * journey.spec.ts already proves a learner can finish the project by typing
 * markdown into the editor. This file proves the same six gates can be passed
 * through the authoring pages, which is where the artefacts live.
 *
 * One learner carries TaskTrackr end to end, so the file runs serially: each
 * test signs in and opens whichever phase the last one merged into.
 */

const LEARNER = {
  name: 'Sam Slices',
  // One run-wide account (E2E_RUN_ID): the walk is one learner across files'
  // worth of tests, and a worker restart must not lose them. The walk is a
  // serial group, so a retry (CI) runs the whole group again from its first
  // case, with one retry number for all of them: that number is in the
  // address, so the retried walk starts from a learner of its own rather than
  // registering the first attempt's address again ("already exists").
  get email(): string {
    const retry = test.info().retry;
    return testEmail(`e2e-slices-${RUN_ID}${retry ? `-r${retry}` : ''}`);
  },
  // Not 'Password1!': that is on the common-password list registration refuses.
  password: 'Correct-Horse-9',
};

/* -------------------------------- artefacts ------------------------------- */

const STORY = {
  title: 'Overdue report',
  persona: 'learner who runs tasktrackr every morning',
  // Where it appears is a rule of its own (mentions-report-surface), and
  // the gate reads its warning as not yet passed.
  capability: 'an overdue report on its own page listing every open task whose due date has already passed',
  benefit: 'I can see the deadlines I missed before the day starts',
  exclusion: 'reminder emails and push notifications',
};

/** The second one is the boundary the review asks about: a task due today. */
const CRITERIA: { tag: 'happy' | 'boundary'; given: string; when: string; then: string }[] = [
  {
    tag: 'happy',
    given: 'an open task whose due date was yesterday',
    when: 'I run the overdue report',
    then: 'the report lists that task',
  },
  {
    tag: 'boundary',
    given: 'a task due today',
    when: 'I run the overdue report',
    then: 'the report leaves it out, because it is not late until tomorrow',
  },
];

/**
 * Every check row the Review view draws, all of which have to read Passed:
 * the record itself, then the phase's floor (packages/shared
 * requirements-story.ts evaluateStoryFloor).
 */
const STORY_RULES = ['story.record', 'story.sentence', 'story.criteria.min', 'story.criteria.tags', 'story.scope.min'];

/** The eight planted bugs the kill matrix draws down its rows, over two layers. */
const MUTANTS = [
  'badge_ignores_completion',
  'complete_does_not_persist',
  'complete_unknown_returns_200',
  'filter_keyword_case_sensitive',
  'filters_drop_the_search',
  'overdue_includes_done',
  'overdue_includes_due_today',
  'priority_order_reversed',
];

/**
 * The contract CR-2's first named operation takes, amended into design/contracts.json. The Contract
 * card adds the operation the change request's impact names first, listComments.
 */
const LIST_COMMENTS = {
  inputs: 'the task id in the path',
  returns: "the task's comments, newest first, each with its id, author, body and the moment it was written",
  errors: 'task_not_found, 404, when no task has that id',
};

/** One merge message per phase, each naming what the review changed. */
const MESSAGES = {
  requirements:
    'The review wanted the boundary decided rather than described, so AC-2 now says a task due today is not overdue.',
  design:
    'The review wanted the report specified, not described: api.json now names what getOverdue answers with and what it refuses, and screens.json says what the page shows when nothing is late.',
  implementation:
    'The five marked gaps are written to the contracts the design promised, in both languages, and both visible suites run green before the pull request.',
  testing:
    'Every planted bug is caught, and each test now names the criterion it stands for instead of implying one.',
  deployment:
    'The runbook carries INCIDENT-1: the API_URL that named localhost inside the compose network, and the selfcheck that would have caught it.',
  maintenance:
    'CR-2 is closed. A task carries comments and the row says how many, and the regression suite over lists, tasks and the report stays green.',
};

/* --------------------------------- helpers -------------------------------- */

/**
 * The coach marks are a first-run overlay over home, and every Playwright
 * context is a first run. Mark them seen before the page loads so the tests
 * that are about the phases are not about a modal. The chrome test below
 * deliberately does not call this, and asserts the overlay instead.
 */
async function coachSeen(page: Page): Promise<void> {
  await dismissPhaseTutorial(page);
}

/**
 * Fill a field and make sure the value stuck. The auth pages paint their form
 * before React owns it, so a value put into the first paint is thrown away
 * when the client takes over; filling again after that lands.
 */
async function fillField(page: Page, testId: string, value: string): Promise<void> {
  const field = page.getByTestId(testId);
  await expect(async () => {
    await field.fill(value);
    await expect(field).toHaveValue(value, { timeout: 2_000 });
  }).toPass({ timeout: UI_READY });
}

async function register(page: Page): Promise<void> {
  // Register, sign in, finish setup (which starts the project).
  await registerAndSignIn(page, LEARNER);
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await fillField(page, 'email', email);
  await fillField(page, 'password', password);
  await page.getByTestId('login-submit').click();
}

/** The phase id in the address bar, which every phase route is keyed by. */
function phaseIdOf(page: Page): string {
  const found = /\/workspace\/([^/?#]+)/.exec(page.url());
  if (!found) throw new Error(`not on a workspace route: ${page.url()}`);
  return found[1];
}

/**
 * Sign the learner in and press Open workspace, which home points at the
 * phase's door: whichever page this phase is worked on, in one step,
 * the issue editor, the Design room, the IDE or the change request. `at` is
 * the route it must land on.
 */
async function openPhase(page: Page, at: RegExp): Promise<void> {
  await signIn(page, LEARNER.email, LEARNER.password);
  await expect(page.getByTestId('dashboard-project')).toContainText('TaskTrackr', { timeout: UI_READY });
  await continueMyProject(page);
  await page.waitForURL(/\/workspace\//, { timeout: UI_READY });
  // The strip's secondary link carries you on to that phase's own document;
  // it sits under the strip's Details, so its address is followed.
  if (!at.test(page.url())) {
    const href = await page.getByTestId('open-document').getAttribute('href');
    await page.goto(href!);
    await page.waitForURL(at, { timeout: UI_READY });
  }
}

/** The IDE for the phase currently open, whichever page we came from. */
async function openIde(page: Page, phaseId: string): Promise<void> {
  await page.goto(`/workspace/${phaseId}`);
  await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: UI_READY });
}

/* Copied from journey.spec.ts so this file stands on its own. */
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
 * Scroll the editor to the first line matching `pattern`.
 *
 * Monaco paints a view zone only while its line is inside the rendered range
 * and sets `display: none` on the rest, so the note under a test further down
 * the file is in the DOM and invisible until the editor is scrolled to it,
 * which is what a learner does. The pack's own acceptance suite (the fixture
 * this journey types in, read straight out of `content/`) opens with a
 * seven-line docstring, so its first test sits below the fold on a 720px
 * window.
 */
async function revealInEditor(page: Page, pattern: string): Promise<void> {
  await page.waitForFunction(
    (source) => {
      const monaco = (window as any).monaco;
      const editor = monaco?.editor?.getEditors?.().find((e: any) => e.hasModel?.());
      if (!editor) return false;
      const model = editor.getModel();
      const hit = model.findMatches(source, false, true, false, null, false, 1)[0];
      if (!hit) return false;
      editor.revealLineInCenter(hit.range.startLineNumber);
      return true;
    },
    pattern,
    { timeout: UI_READY },
  );
}

/**
 * Run the sandbox and wait for it to finish. The button comes back enabled
 * when the run lands, which is what a second run, or a submit, waits for.
 * Running opens the Tests tab of the bottom panel, where the summary is.
 */
async function runSandbox(page: Page, summary: string): Promise<void> {
  const button = page.getByTestId('header-run');
  await expect(button).toBeEnabled({ timeout: NAVIGATION });
  await button.click();
  await expect(page.getByTestId('run-summary')).toContainText(summary, { timeout: 180_000 });
  await expect(page.getByTestId('run-panel')).toBeVisible();
  await expect(button).toBeEnabled({ timeout: 180_000 });
}

/**
 * Click whichever folder rows stand between the explorer's root and a file.
 * The tree folds single-child chains into one row and a folder holding no
 * editable file starts closed, so the deepest visible folder row is the one to
 * press, and pressing it may reveal another.
 */
async function openFolderOf(page: Page, filePath: string): Promise<void> {
  const parts = filePath.split('/').slice(0, -1);
  for (let depth = parts.length; depth > 0; depth--) {
    const folder = parts.slice(0, depth).join('/').replace(/[/.]/g, '-');
    const row = page.getByTestId(`explorer-folder-${folder}`);
    if ((await row.count()) > 0) {
      if ((await row.getAttribute('aria-expanded')) === 'false') await row.click();
      if (depth < parts.length) return openFolderOf(page, filePath);
      return;
    }
  }
}

/**
 * Open a file, from the tab strip if it is there and from the Explorer if it is
 * not, and wait for its tab. `setEditor` waits for a Monaco model, which exists
 * only for a file the workspace has opened, and a two-directory repository does
 * not open all of them.
 */
async function openFile(page: Page, filePath: string): Promise<void> {
  const slug = filePath.replace(/[/.]/g, '-');
  // The room draws its file strip once the editor is up; read it after that.
  await waitForEditor(page, 60_000);
  const tab = page.getByTestId(`file-tab-${slug}`);
  if ((await tab.count()) === 0) {
    const row = page.getByTestId(`explorer-file-${slug}`);
    // The explorer is the left column's Files tab in every code room,
    // Implementation included: open the column first if it is hidden.
    if (!(await page.getByTestId('explorer').isVisible().catch(() => false))) {
      const show = page.getByRole('button', { name: 'Show brief', exact: true });
      if (await show.isVisible().catch(() => false)) await show.click();
      await page.locator('nav[aria-label="Phase context"]').getByRole('button', { name: 'Files', exact: true }).click();
    }
    if ((await row.count()) === 0) await openFolderOf(page, filePath);
    await row.click();
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

/** Submit from the IDE. The verdict lands in the Review tab, which it opens. */
async function submitAndPass(page: Page): Promise<void> {
  const button = page.getByTestId('header-submit');
  await expect(button).toBeEnabled({ timeout: NAVIGATION });
  await button.click();
  // The verdict's words for a pass (was "Gate passed").
  await expect(page.getByTestId('feedback-verdict')).toContainText('All required evidence accepted', {
    timeout: 180_000,
  });
}

/**
 * Merge from the gate banner, the IDE and the issue editor both carry it, and
 * both open the sheet with the same three ids. `next` is the phase the merge
 * opens, read off the phase strip of wherever it lands, or null for the last.
 */
async function merge(page: Page, message: string, next: string | null): Promise<void> {
  await expect(page.getByTestId('gate-banner')).toBeVisible({ timeout: NAVIGATION });
  await page.getByTestId('open-reflection').click();
  await page.getByTestId('reflection-input').fill(message);
  await page.getByTestId('reflection-submit').click();
  if (next === null) {
    await expect(page).toHaveURL(/\/complete/, { timeout: NAVIGATION });
    return;
  }
  // The strip names the phase the merge opened; phase-title is that name on
  // its own, so it is asserted exactly rather than as a substring of the line.
  await expect(page.getByTestId('phase-title')).toHaveText(next, { timeout: NAVIGATION });
  await expect(page.getByTestId('gate-banner')).toBeHidden({ timeout: NAVIGATION });
}

// The six phases are one learner's walk, in order, so they are one serial
// group; the chrome and the instructor's view below are not part of it and
// run whether or not the walk got through.
test.describe('one learner, six phases', () => {
test.describe.configure({ mode: 'serial' });

/* --------------------------- 1 · requirements ----------------------------- */

test('the issue editor writes US-4 and passes the requirements gate', async ({ page }) => {
  test.setTimeout(600_000);

  await coachSeen(page);
  await register(page);

  // Phase 1 is one room: the stakeholder interview and the backlog on one
  // page. US-4 is written in the backlog, in its own dialog.
  await openRequirements(page);
  await expect(page.getByTestId('phase-title')).toHaveText('Requirements');
  await requirementsTab(page, 'My backlog');
  const backlog = page.getByTestId('requirements-backlog-panel');
  await expect(page.getByTestId('phase-requirements-editor')).toBeVisible({ timeout: UI_READY });
  await backlog.locator('.jira-own-story').click();

  /* ------------------------------- the story ------------------------------ */
  await page.getByTestId('phase-requirements-title').fill(STORY.title);
  await page.getByTestId('phase-requirements-persona').fill(STORY.persona);
  await page.getByTestId('phase-requirements-capability').fill(STORY.capability);
  await page.getByTestId('phase-requirements-benefit').fill(STORY.benefit);

  /* ---------------------------- the criteria ------------------------------ */
  for (const [i, criterion] of CRITERIA.entries()) {
    const n = i + 1;
    await page.getByTestId('phase-requirements-criterion-add').click();
    await expect(page.getByTestId(`phase-requirements-criterion-${n}`)).toBeVisible();
    await page.getByTestId(`phase-requirements-criterion-${n}-tag`).selectOption(criterion.tag);
    await page.getByTestId(`phase-requirements-criterion-${n}-given`).fill(criterion.given);
    await page.getByTestId(`phase-requirements-criterion-${n}-when`).fill(criterion.when);
    await page.getByTestId(`phase-requirements-criterion-${n}-then`).fill(criterion.then);
  }

  /* ------------------------------- the scope ------------------------------ */
  await page.getByTestId('phase-requirements-scope-add').click();
  await page.getByTestId('phase-requirements-scope-1').fill(STORY.exclusion);
  // The suite's assessor passes only marked work (e2e/ai-stub.cjs); the mark
  // rides in the story's notes, which nothing grades by shape.
  await page.getByTestId('phase-requirements-notes').fill(`Settled with the product owner in the interview. ${E2E_PASS}`);
  await page.getByRole('button', { name: 'Save story', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit story US-4' })).toBeHidden();

  /* -------------------- the rules the review will run --------------------- */
  // The backlog's Review view runs the structure checks and draws the story
  // as the record holds it, on its card, which is the proof that
  // requirements/story.json was written.
  await backlog.locator('nav[aria-label="Backlog views"]').getByRole('button', { name: 'Review', exact: true }).click();
  const checks = page.getByTestId('phase-requirements-checks');
  await expect(checks).toBeVisible();
  for (const rule of STORY_RULES) {
    await expect(page.getByTestId(`phase-requirements-rule-${rule}`), rule).toContainText('Passed');
  }
  const evidence = page.getByTestId('phase-requirements-story-card');
  await expect(evidence).toContainText('As a', { timeout: UI_READY });
  await expect(evidence).toContainText(STORY.title);
  await expect(evidence).toContainText(STORY.capability);

  // The product owner is the reviewer for this phase, and reviews it here.
  await expect(page.getByTestId('persona-panel')).toBeVisible();

  await page.getByTestId('phase-requirements-submit').click();
  await merge(page, MESSAGES.requirements, 'Design');
});

/* ------------------------------ 2 · design -------------------------------- */

test('the design room writes the record and the contracts in its forms and passes the design gate', async ({ page }) => {
  test.setTimeout(600_000);

  await coachSeen(page);
  await openPhase(page, /\/workspace\/[^/?#]+\/design/);
  const phaseId = phaseIdOf(page);
  await expect(page.getByTestId('design-page')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('phase-design-editor')).toBeVisible({ timeout: UI_READY });
  // TaskTrackr 4.0.0 switches both contracts and the sequence diagram on: six tabs.
  for (const tab of ['model', 'api', 'screens', 'sequence', 'decisions', 'review'] as const) {
    await expect(page.getByTestId(`design-tab-${tab}`)).toBeVisible();
  }

  // Everything through the forms (e2e/design-forms.ts): the model, the API
  // contract through its workbench, the overdue screen, the request path and
  // the decision with the pass mark in the notes. Nothing is typed in an IDE.
  await fillModel(page);
  await fillApiContract(page);
  await fillScreens(page);
  await fillSequence(page);
  await fillDecision(page);

  // The diagram is drawn from the same record (in the Review tab).
  await designTab(page, 'review');
  await expect(page.getByTestId('phase-design-diagram')).toBeVisible();
  await expect(page.getByTestId('phase-design-editor')).not.toContainText('.json');

  // "Check the design" lists the floor in words: every rule Passed.
  await expectFloorPassed(page);

  // Submit opens the review in the room, on its Review tab, which passes; the merge is the room's own gate banner.
  await page.getByTestId('design-submit').click();
  await expect(page.getByTestId('design-review').getByTestId('feedback-verdict')).toContainText('Pass', { timeout: 180_000 });
  expect(new URL(page.url()).pathname).toBe(`/workspace/${phaseId}/design`);
  await merge(page, MESSAGES.design, 'Implementation');
});

/* -------------------------- 3 · implementation ---------------------------- */

test('the pull request keeps a revision and a conformance ledger', async ({ page }) => {
  test.setTimeout(900_000);

  await coachSeen(page);
  await openPhase(page, /\/workspace\/[^/?#]+$/);
  await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: UI_READY });
  // Five gaps over two languages, so four files and two run groups.
// The suite's assessor passes only marked work (e2e/ai-stub.cjs): a comment line.
  await writeFile(page, 'api/repository/tasks.py', `${SOLUTION_REPOSITORY}\n# ${E2E_PASS}\n`);
  await writeFile(page, 'api/routes/tasks.py', SOLUTION_ROUTES);
  await writeFile(page, 'web/src/lib/overdue.ts', SOLUTION_OVERDUE);
  await writeFile(page, 'web/src/hooks/useTasks.ts', SOLUTION_USE_TASKS);
  await runSandbox(page, '6/6 tests passed');
  await submitAndPass(page);

  /* ---------------- the pull request behind the phase's IDE ---------------- */
  await (await stripDoor(page, 'open-document')).click();
  await page.waitForURL(/\/workspace\/[^/?#]+\/pr/, { timeout: UI_READY });
  await expect(page.getByTestId('pr-page')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('pr-title')).toContainText('PR-3');

  // Conversation, the diff, and the checks that scored it: the three tabs the
  // page is built on, each holding its own evidence.
  // The page opens on Files changed, as the mockup draws it; the other two
  // tabs are one press away.
  await page.getByTestId('pr-tab-conversation').click();
  await expect(page.getByTestId('pr-conversation')).toBeVisible();
  await page.getByTestId('pr-tab-files').click();
  await expect(page.locator('[data-testid^="pr-file-"]').first()).toBeVisible({ timeout: UI_READY });
  await page.getByTestId('pr-tab-checks').click();
  // The ledger holds the design contracts against what the code did.
  await expect(page.getByTestId('phase-implementation-ledger')).toBeVisible();

  // The revisions are the History tab since a1e6a1eb took the Submissions card off the page.
  await page.getByTestId('pr-tab-history').click();
  const revisions = page.getByTestId('pr-history');
  await expect(revisions).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('pr-history-row-1')).toBeVisible();
  // One submission, one revision: the list is the pull request's history, not
  // a copy of the verdict tab.
  await expect(revisions.locator('[data-testid^="pr-history-row-"]')).toHaveCount(1);

  /* ------------------------- merge, on its own page ----------------------- */
  const mergeCard = page.getByTestId('pr-merge');
  await expect(mergeCard).toBeVisible();
  await mergeCard.getByTestId('reflection-input').fill(MESSAGES.implementation);
  await mergeCard.getByTestId('reflection-submit').click();
  await expect(page.getByTestId('phase-implementation-merged')).toBeVisible({ timeout: NAVIGATION });

  await page.getByTestId('pr-open-next').click();
  await expect(page.getByTestId('phase-title')).toHaveText('Testing', { timeout: NAVIGATION });
});

/* ----------------------------- 4 · testing -------------------------------- */

test('a test is linked to a criterion and the kill matrix fills in', async ({ page }) => {
  test.setTimeout(900_000);

  await coachSeen(page);
  await openPhase(page, /\/workspace\/[^/?#]+$/);
  const phaseId = phaseIdOf(page);
// The suite's assessor passes only marked work (e2e/ai-stub.cjs): a comment line.
  await writeFile(page, 'tests/test_acceptance.py', `${MY_TESTS}\n# ${E2E_PASS}\n`);
  await writeFile(page, 'web/src/acceptance.test.tsx', MY_WEB_TESTS);

  /* ------------------- link the first test to a criterion ----------------- */
  // The picker is the note the editor draws under an unlinked test: its
  // chips are the criteria, and picking one saves the link.
  // The front-end suite was written last, so the editor is on it. The note
  // this beat picks a criterion from is under the first Python case, so the
  // Python file is the one to come back to, and its cases are module-level
  // pytest functions at column 0, not indented unittest methods.
  await openFile(page, 'tests/test_acceptance.py');
  const note = page.locator('[data-testid^="inline-note-link-"]').first();
  await revealInEditor(page, 'def test_\\w+');
  await expect(note).toBeVisible({ timeout: UI_READY });
  await note.scrollIntoViewIfNeeded();
  // The note's test id names the test (`inline-note-link-<test>`), and the
  // editor draws the note only under a test with no saved link, so the saved
  // link is that one note leaving the editor.
  const noteId = await note.getAttribute('data-testid');
  expect(noteId).toMatch(/^inline-note-link-/);
  await note.locator('button').first().click();
  const linkedNote = page.getByTestId(noteId!);
  await expect(linkedNote).toHaveCount(0, { timeout: UI_READY });

  /* ---------------------------- run, then rerun --------------------------- */
  // The suite has to be green against the reference implementation before the
  // planted bugs run at all, and the links survive a second run.
  await runSandbox(page, 'tests passed');
  await runSandbox(page, 'tests passed');
  await openFile(page, 'tests/test_acceptance.py');
  await revealInEditor(page, 'def test_\\w+');
  await expect(linkedNote).toHaveCount(0);

  await submitAndPass(page);

  /* ------------------------------ kill matrix ----------------------------- */
  await (await stripDoor(page, 'open-document')).click();
  await page.waitForURL(/\/workspace\/[^/?#]+\/matrix/, { timeout: UI_READY });
  await expect(page.getByTestId('matrix-page')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('matrix-title')).toBeVisible();

  const matrix = page.getByTestId('phase-testing-matrix');
  await expect(matrix).toBeVisible({ timeout: UI_READY });
  // Six drawn, six caught, none left alive.
  const stats = page.getByTestId('phase-testing-matrix-stats');
  // Eight planted bugs over two layers, and the reference suites kill all of them.
  await expect(stats).toContainText('8 of 8');
  await expect(stats).toContainText('Bugs caught');

  // The rows are read in the fold under the stats, "Read the mutation evidence"
  // (closed until the learner opens it).
  await page.locator('details.phase-evidence-detail > summary', { hasText: 'Read the mutation evidence' }).click();
  const bugs = page.getByTestId('phase-testing-planted-bugs');
  for (const mutant of MUTANTS) {
    await expect(bugs, mutant).toContainText(mutant);
    await expect(page.getByTestId(`phase-testing-matrix-row-${mutant}`)).toBeVisible();
  }

  /* ------------------- back to the IDE, where the gate is ----------------- */
  await openIde(page, phaseId);
  await merge(page, MESSAGES.testing, 'Deployment');
});

/* ---------------------------- 5 · deployment ------------------------------ */

test('the incident drill pages the learner and records INCIDENT-1', async ({ page }) => {
  test.setTimeout(900_000);

  await coachSeen(page);
  await openPhase(page, /\/workspace\/[^/?#]+$/);
  const phaseId = phaseIdOf(page);

  /* -------------------- the three files, then the runbook ----------------- */
  // The room opens on its Pipeline since a1e6a1eb; the files are one press away, under Configuration.
  await page.locator('nav[aria-label="Phase working area"]').getByRole('button', { name: 'Configuration', exact: true }).click();
// The suite's assessor passes only marked work (e2e/ai-stub.cjs): a comment line.
  await writeFile(page, 'api/Dockerfile', `${MY_DOCKERFILE}\n# ${E2E_PASS}\n`);
  await writeFile(page, 'docker-compose.yml', MY_COMPOSE);
  await writeFile(page, '.github/workflows/ci.yml', MY_CI);
  // The runbook is the Runbook tab's forms, never a file the explorer lists.
  await fillRunbookForms(page, JSON.parse(RUNBOOK_RECORD));

  /* ------------------------- the drill, on its page ----------------------- */
  await (await stripDoor(page, 'open-document')).click();
  await page.waitForURL(/\/workspace\/[^/?#]+\/drill/, { timeout: UI_READY });
  await expect(page.getByTestId('drill-page')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('drill-title')).toBeVisible();

  /* ------------------------------- the page ------------------------------- */
  await page.getByTestId('phase-deployment-drill-start').click();
  const before = page.getByTestId('phase-deployment-drill-before');
  await expect(before).toBeVisible({ timeout: 180_000 });
  // The alert text is what the faulted copy printed; the panel says so
  // explicitly when it has none, which is the case this must not pass on.
  await expect(before).not.toContainText('no longer holds the alert text');
  await expect(page.getByTestId('drill-clock')).toBeVisible();

  /* ------------------- the health check against their files --------------- */
  await page.getByTestId('phase-deployment-drill-health').click();
  const health = page.getByTestId('phase-deployment-drill-health-result');
  await expect(health).toBeVisible({ timeout: 180_000 });
  await expect(health).toContainText('exit 0');

  // The runbook is written in the IDE's Runbook tab: the drill page's Runbook view is the door to it.
  const drillNav = page.locator('nav[aria-label$=" working area"]');
  await drillNav.getByRole('button', { name: 'Runbook', exact: true }).click();
  await expect(page.getByTestId('drill-open-runbook')).toBeVisible({ timeout: UI_READY });

  /* ------------------------------ the write-up ---------------------------- */
  await drillNav.getByRole('button', { name: 'Incident record', exact: true }).click();
  await page.getByTestId('phase-deployment-incident-root-cause').fill(PASSING_INCIDENT.rootCause);
  await page.getByTestId('phase-deployment-incident-fix').fill(PASSING_INCIDENT.fix);
  await page.getByTestId('phase-deployment-incident-action').fill(PASSING_INCIDENT.actionItem);
  await page.getByTestId('phase-deployment-drill-resolve').click();
  await expect(page.getByTestId('phase-deployment-drill-resolve')).toHaveText(/Resolved/, { timeout: 180_000 });
  const record = page.getByTestId('phase-deployment-incident-record');
  await expect(record).toBeVisible();
  await expect(page.getByTestId('phase-deployment-incident-root-cause')).toHaveValue(PASSING_INCIDENT.rootCause);

  /* ---------------------- back to the IDE for the gate -------------------- */
  await openIde(page, phaseId);
  // The resolve wrote the incident into the runbook: the Runbook tab shows it read-only, and every floor row passes.
  await page.getByTestId('phase-deployment-tab-runbook').click();
  await expect(page.getByTestId('runbook-incident-from-drill')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('runbook-incident-rootCause')).toHaveValue(PASSING_INCIDENT.rootCause);
  await page.getByTestId('runbook-check').click();
  const floorRows = page.locator('[data-testid^="runbook-check-runbook."]');
  await expect(floorRows).toHaveCount(7);
  await expect(floorRows.filter({ hasText: 'Passed' })).toHaveCount(7);
  await expect(floorRows.filter({ hasText: 'Not yet' })).toHaveCount(0);
  await runSandbox(page, 'Run completed successfully');
  await submitAndPass(page);
  await merge(page, MESSAGES.deployment, 'Maintenance');
});

/* --------------------------- 6 · maintenance ------------------------------ */

test('CR-2 ships as release 2.1.0 and completes the project', async ({ page }) => {
  test.setTimeout(900_000);

  await coachSeen(page);
  await openPhase(page, /\/workspace\/[^/?#]+\/change/);
  const phaseId = phaseIdOf(page);
  await expect(page.getByTestId('change-page')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('change-title')).toBeVisible();

  /* ------------------------------- the ticket ----------------------------- */
  // The Request tab draws the ticket read-only beside the impact.
  const ticket = page.getByTestId('change-ticket');
  await expect(ticket).toBeVisible({ timeout: UI_READY });
  await expect(ticket).toContainText('CR-2');
  await expect(ticket).toContainText('AC-1');

  /* -------------------------- the change request -------------------------- */
  // The record's four tabs. The Request tab names the operations first: the Contract card adds the
  // contract of the operation the impact names first, and its Add waits for one.
  await fillChangeForms(page, JSON.parse(CHANGE_REQUEST_RECORD));

  /* --------------------------- the reopen contract ------------------------ */
  await page.locator('nav[aria-label="Change request sections"]').getByRole('button', { name: 'Contract', exact: true }).click();
  const contracts = page.getByTestId('phase-maintenance-contracts-v2');
  await expect(contracts).toBeVisible();
  await page.getByTestId('phase-maintenance-contract-v2-add').click();
  await page.getByTestId('phase-maintenance-contract-inputs').fill(LIST_COMMENTS.inputs);
  await page.getByTestId('phase-maintenance-contract-returns').fill(LIST_COMMENTS.returns);
  await page.getByTestId('phase-maintenance-contract-errors').fill(LIST_COMMENTS.errors);
  // The card reads Draft until all three clauses are written.
  await expect(contracts).toContainText('Written');
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });

  /* ------------------------------- the change ----------------------------- */
  await page.getByTestId('open-workspace').click();
  await page.waitForURL(/\/workspace\/[^/?#]+$/, { timeout: UI_READY });
  await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: UI_READY });
// The suite's assessor passes only marked work (e2e/ai-stub.cjs): a comment line.
  await writeFile(page, 'api/repository/tasks.py', `${CR2_REPOSITORY_TASKS}\n# ${E2E_PASS}\n`);
  await writeFile(page, 'api/repository/comments.py', CR2_REPOSITORY_COMMENTS);
  await writeFile(page, 'api/routes/comments.py', CR2_ROUTES_COMMENTS);
  await writeFile(page, 'web/src/components/TaskRow.tsx', CR2_TASK_ROW);
  await runSandbox(page, 'tests passed');
  await submitAndPass(page);

  /* -------------------- the release the merge will publish ---------------- */
  await page.goto(`/workspace/${phaseId}/change`);
  await page.locator('nav[aria-label="Change request sections"]').getByRole('button', { name: 'Release', exact: true }).click();
  const release = page.getByTestId('phase-maintenance-release');
  await expect(release).toBeVisible({ timeout: UI_READY });
  await expect(release).toContainText('2.1.0');
  await expect(release).toContainText('Comments on a task');

  await openIde(page, phaseId);
  await merge(page, MESSAGES.maintenance, null);
  // The completion record (app/(app)/completion/page.tsx) names the learner.
  await expect(page.locator('.exp-certificate-name')).toHaveText(LEARNER.name, { timeout: UI_READY });
});

});
