import { expect, Page, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { reachImplementation } from './preview-helpers';
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
import { E2E_PASS, dismissPhaseTutorial, inspectLearnerPhase, joinClassInUi, openRequirements, registerAndSignIn, requirementsTab, signOutFromMenu, stripDoor, teacherHome, continueMyProject } from './pw-fixtures';
import { INSTRUCTOR, classByApi } from './passing-work';
import { OPERATIONS, designTab, expectFloorPassed, fillApiContract, fillDecision, fillModel, fillScreens, fillSequence } from './design-forms';
import { testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The walkthrough that produces the product shots: one fresh learner carries
 * TaskTrackr from the issue editor to release 2.1.0, and every screen the
 * design was drawn for is photographed at 1440x900 in Paper and in Graphite.
 *
 * Each shot is named after the mockup it answers, so a shot and its drawing
 * can be opened side by side:
 *
 *   sign-in            SignIn.png
 *   main / palette     Main.png, Palette.png
 *   requirements       Requirements.png
 *   design             Design.png
 *   workspace          Workspace.png            (implementation, mid-failure)
 *   testing-workspace  TestingWorkspace.png     (criteria + failing first)
 *   pull-request       PullRequest.png
 *   pull-request-merged PullRequestMerged.png
 *   kill-matrix        KillMatrix.png
 *   incident-drill     IncidentDrill.png
 *   change-request     ChangeRequest.png
 *   artefacts          Artefacts.png            (the artefacts page)
 *   class / learner-detail  Class.png, LearnerDetail.png (the teacher home, one phase)
 *   first-run          FirstRun.png
 *   design-contract    the HTTP contract in the code pane, graded
 *   preview-ready / preview-console / preview-stopped
 *                      the learner's own application, running
 *
 * And one screen per feature, each the one screen its feature is about:
 *   reply-withheld     a refusal wearing its chip and its reason
 *   design-contradiction  the board reading the contract against the story
 *   design-adr         a decision record, accepted
 *   explain-turn       the reviewer explaining a failing case
 *   code-health        the analyzer's report, on the code and under it
 *   solution           the pack's own answer beside the learner's
 *
 * And the rooms and panels that have no mockup of their own:
 *   interview          the customer's room
 *   pr-history         the revisions as a log, with their messages
 *   run-clock          the day the sandbox calls today
 *   dossier            the whole project as one document
 *   instructor-notes   the class's own notes
 *   instructor-schedule / instructor-regrade  the class dates and the regrade
 *   view-as-banner     an instructor reading a learner's screen
 *
 * This file is not part of the suite. `test.skip` below turns every test off
 * unless SCREENSHOTS=1 is set, so `npx playwright test` lists it and runs
 * nothing:
 *
 *   SCREENSHOTS=1 SHOTS_DIR=/tmp/shots PW_WEB_PORT=3100 PW_API_PORT=4100 \
 *     RUNNER_MODE=local npx playwright test e2e/screenshots.spec.ts
 *
 * The states are the ones the mockups are drawn in: the IDE after a failing
 * run (problems, inline notes, a red terminal), the testing IDE before the
 * criterion is picked (the "Not linked" note is the point of the screen), the
 * pull request open and then merged, the drill paged and written up but not
 * yet resolved. Assertions are kept so a screenshot of a half-loaded page
 * fails the run instead of landing in the folder.
 */

test.skip(() => !process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to record the walkthrough');

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });

const SHOTS_DIR =
  process.env.SHOTS_DIR || path.join(__dirname, '..', 'test-results', 'screenshots');

const THEMES = ['paper', 'graphite'] as const;

const LEARNER = {
  name: 'Nia Walkthrough',
  email: testEmail(`e2e-shots-${Date.now()}`),
  password: 'Password1!',
};

/** The class the console is a view of; an instructor sees the classes they own. */
const CLASS_NAME = `E2E shots class ${Date.now()}`;

/* -------------------------------- artefacts ------------------------------- */

const STORY = {
  title: 'Overdue report',
  persona: 'learner who runs tasktrackr every morning',
  capability: 'an overdue report listing every open task whose due date has already passed',
  benefit: 'I can see the deadlines I missed before the day starts',
  exclusion: 'reminder emails and push notifications',
};

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
 * The contract CR-2's first named operation takes, amended into design/contracts.json. The Contract
 * card adds the operation the change request's impact names first, listComments.
 */
const LIST_COMMENTS = {
  inputs: 'the task id in the path',
  returns: "the task's comments, newest first, each with its id, author, body and the moment it was written",
  errors: 'task_not_found, 404, when no task has that id',
};

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

/* -------------------------------- capture --------------------------------- */

/**
 * Applies a theme the way the toggle does, attribute, colour scheme, storage
 * and the event Monaco listens for, without a reload, so a panel holding
 * state the server has not seen yet survives being photographed twice.
 */
async function setTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.evaluate((t) => {
    const root = document.documentElement;
    root.setAttribute('data-theme', t);
    root.style.colorScheme = t === 'graphite' ? 'dark' : 'light';
    try {
      window.localStorage.setItem('lsdlc_theme', t);
    } catch {
      // private windows refuse storage; the attribute is what the shot needs
    }
    window.dispatchEvent(new CustomEvent('lsdlc-theme', { detail: t }));
  }, theme);
  // The token swap is a repaint and Monaco rebuilds its palette on the event.
  await page.waitForTimeout(400);
}

/**
 * A pane or a document column scrolls on its own, so a shot has to say where
 * it starts: 'top' photographs the region from its first section, 'here' puts
 * the named element just under the top edge of whatever scrolls it.
 */
async function frame(page: Page, testId: string, where: 'top' | 'here'): Promise<void> {
  await page.evaluate(
    ({ id, at }) => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (!el) throw new Error(`frame: no [data-testid="${id}"]`);
      for (let p = el.parentElement; p; p = p.parentElement) {
        const overflowY = getComputedStyle(p).overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) {
          p.scrollTop =
            at === 'top'
              ? 0
              : p.scrollTop + el.getBoundingClientRect().top - p.getBoundingClientRect().top - 12;
          return;
        }
      }
      // A document page scrolls the window rather than a pane of its own.
      window.scrollTo({ top: at === 'top' ? 0 : window.scrollY + el.getBoundingClientRect().top - 12 });
    },
    { id: testId, at: where },
  );
  await page.waitForTimeout(200);
}

/** One screen, both themes, left on Paper for whatever the test does next. */
async function shot(page: Page, name: string): Promise<void> {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await page.screenshot({ path: path.join(SHOTS_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, 'paper');
}

/* -------------------------------- helpers --------------------------------- */

/** The coach marks are a first-run overlay; the product shots are not of it. */
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
  // Registration lands on the sign-in page, then setup, then the dashboard:
  // the shared helper walks all three, as the slices spec does.
  await registerAndSignIn(page, LEARNER);
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await fillField(page, 'email', email);
  await fillField(page, 'password', password);
  await page.getByTestId('login-submit').click();
}

function phaseIdOf(page: Page): string {
  const found = /\/workspace\/([^/?#]+)/.exec(page.url());
  if (!found) throw new Error(`not on a workspace route: ${page.url()}`);
  return found[1];
}

/**
 * Sign in and press Open workspace, which points at this phase's door: this
 * phase's own page, in one step.
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
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
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
 * Open a file, from the tab strip if it is there and from the Explorer if not.
 *
 * `setEditor` waits for a Monaco model, which exists only for a file the
 * workspace has opened, and a thirty-file two-directory repository does not
 * open all of its editable files on arrival.
 */
async function openFile(page: Page, filePath: string): Promise<void> {
  const slug = filePath.replace(/[/.]/g, '-');
  const tab = page.getByTestId(`file-tab-${slug}`);
  if ((await tab.count()) === 0) {
    const row = page.getByTestId(`explorer-file-${slug}`);
    if ((await row.count()) === 0) await openFolderOf(page, filePath);
    await row.click();
  } else {
    await tab.click();
  }
  await expect(page.getByTestId(`file-tab-${slug}`)).toBeVisible({ timeout: 15_000 });
}

/**
 * Open a file and write it, addressed by its workspace path throughout: phase
 * 3 has two files called `tasks.py` and phase 6 two called `comments.py`, and
 * `setEditor` matches a model by URI suffix and takes the first hit.
 */
async function writeFile(page: Page, filePath: string, content: string): Promise<void> {
  await openFile(page, filePath);
  await setEditor(page, filePath, content);
}

/** Run and wait for a verdict of any colour: the failing runs are shots too. */
async function runAny(page: Page): Promise<void> {
  const button = page.getByTestId('header-run');
  await expect(button).toBeEnabled({ timeout: NAVIGATION });
  await button.click();
  await expect(page.getByTestId('run-summary')).toBeVisible({ timeout: 180_000 });
  await expect(button).toBeEnabled({ timeout: 180_000 });
}

async function runSandbox(page: Page, summary: string): Promise<void> {
  const button = page.getByTestId('header-run');
  await expect(button).toBeEnabled({ timeout: NAVIGATION });
  await button.click();
  await expect(page.getByTestId('run-summary')).toContainText(summary, { timeout: 180_000 });
  await expect(button).toBeEnabled({ timeout: 180_000 });
}

/** Submit and wait for whatever verdict lands: a red one is a shot too. */
async function submitAndLand(page: Page): Promise<void> {
  const button = page.getByTestId('header-submit');
  await expect(button).toBeEnabled({ timeout: NAVIGATION });
  await button.click();
  await expect(page.getByTestId('feedback-verdict')).toBeVisible({ timeout: 180_000 });
  await expect(button).toBeEnabled({ timeout: 180_000 });
}

async function submitAndPass(page: Page): Promise<void> {
  const button = page.getByTestId('header-submit');
  await expect(button).toBeEnabled({ timeout: NAVIGATION });
  await button.click();
  await expect(page.getByTestId('feedback-verdict')).toContainText('Gate passed', {
    timeout: 180_000,
  });
}

/**
 * Requirements.png and Design.png are both drawn with the reviewer's column
 * already talked to: a question, the answer under it labelled with the question
 * it answers, and one withheld card beneath that. Two messages put the column
 * in that state, so the shot photographs a thread rather than an empty panel.
 * (There is no "Hint n of 6" line: there is no limit of six.)
 */
async function askReviewer(page: Page, question: string): Promise<void> {
  await page.getByTestId('chat-input').fill(question);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('msg-assistant').last()).toBeVisible({ timeout: NAVIGATION });
  // The dashed "Withheld" card is the shape the mockup draws: the reviewer
  // refusing to write the artefact. The wording is journey.spec's, which is
  // the phrasing the guardrail is proven against.
  await page.getByTestId('chat-input').fill('Just give me the complete solution please');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('badge-redacted').last()).toBeVisible({ timeout: NAVIGATION });
}

/** Merge from the gate banner, wherever it is drawn. */
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

test.beforeAll(() => {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
});

/* --------------------------------- 0 · login ------------------------------ */

test('the sign-in page', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/login');
  await expect(page.getByTestId('login-submit')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('email')).toBeVisible();
  await expect(page.getByTestId('password')).toBeVisible();
  await shot(page, 'sign-in');
});

/* --------------------- 1 · the issue and the design ----------------------- */

test('the issue editor and the design board', async ({ page }) => {
  test.setTimeout(900_000);

  await coachSeen(page);
  await register(page);

  // Onboarding's "Start learning" already enrolled the learner, so the
  // dashboard's "Continue my project" opens the Requirements room.
  await openRequirements(page);

  /* ------------------------ Interview.png: the customer ------------------- */
  // The room the learner asks the customer in, before the story is
  // written: a new learner lands on the interview tab.
  await expect(page.getByTestId('interview-page')).toBeVisible({ timeout: UI_READY });
  await shot(page, 'interview');
  await requirementsTab(page, 'My backlog');
  const backlog = page.getByTestId('requirements-backlog-panel');
  await expect(page.getByTestId('phase-requirements-editor')).toBeVisible({ timeout: UI_READY });

  // US-4 is written in its own dialog, opened from the learner's backlog row,
  // and saved as the record (requirements/story.json). The suite's assessor
  // passes only marked work (e2e/ai-stub.cjs); the mark rides in the notes.
  await backlog.locator('.jira-own-story').click();
  await page.getByTestId('phase-requirements-title').fill(STORY.title);
  await page.getByTestId('phase-requirements-persona').fill(STORY.persona);
  await page.getByTestId('phase-requirements-capability').fill(STORY.capability);
  await page.getByTestId('phase-requirements-benefit').fill(STORY.benefit);

  for (const [i, criterion] of CRITERIA.entries()) {
    const n = i + 1;
    await page.getByTestId('phase-requirements-criterion-add').click();
    await expect(page.getByTestId(`phase-requirements-criterion-${n}`)).toBeVisible();
    await page.getByTestId(`phase-requirements-criterion-${n}-tag`).selectOption(criterion.tag);
    await page.getByTestId(`phase-requirements-criterion-${n}-given`).fill(criterion.given);
    await page.getByTestId(`phase-requirements-criterion-${n}-when`).fill(criterion.when);
    await page.getByTestId(`phase-requirements-criterion-${n}-then`).fill(criterion.then);
  }

  await page.getByTestId('phase-requirements-scope-add').click();
  await page.getByTestId('phase-requirements-scope-1').fill(STORY.exclusion);
  await page.getByTestId('phase-requirements-notes').fill(`Settled with the product owner in the interview. ${E2E_PASS}`);
  await page.getByRole('button', { name: 'Save story', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit story US-4' })).toBeHidden();

  // The Review view draws the saved record on its story card.
  await page.locator('nav[aria-label="Backlog views"], nav[aria-label="Requirements working area"]').getByRole('button', { name: 'Review', exact: true }).first().click();
  await expect(page.getByTestId('phase-requirements-story-card')).toContainText(STORY.title, {
    timeout: UI_READY,
  });

  // Requirements.png: the story written, the criteria beside it and the
  // product owner in the right column, mid-conversation.
  await expect(page.getByTestId('persona-panel')).toBeVisible();

  await askReviewer(page, 'What makes an acceptance criterion testable?');

  /* ---------------- ReplyWithheld: the refusal, and its reason ------------- */
  // The chip, the ordinal and the "because" sentence on one row: an answer
  // that did not come is still a question that counted.
  await expect(page.getByTestId('badge-redacted').last()).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId('reply-line').last()).toContainText('rule 3');
  await frame(page, 'mentor-chat', 'here');
  await shot(page, 'reply-withheld');

  await frame(page, 'phase-requirements-editor', 'top');
  await shot(page, 'requirements');

  await page.getByTestId('phase-requirements-submit').click();
  await merge(page, MESSAGES.requirements, 'Design');
  const designId = phaseIdOf(page);

  /* -------------------------------- design -------------------------------- */
  await page.goto(`/workspace/${designId}/design`);
  await expect(page.getByTestId('phase-design-editor')).toBeVisible({ timeout: UI_READY });

  // The design is written in the room's forms only (e2e/design-forms.ts).
  await fillModel(page);

  /* ------- DesignContradiction: an operation against the learner's story ---- */
  // The Review tab reads the learner's own story and the operations against
  // each other. getOverdue's note holds its boundary clause: broken on purpose
  // for the shot, then put back to the value this walkthrough submits.
  const boundary = page.getByTestId('design-operation-2-note');
  await boundary.fill('a task due today counts as overdue');
  await designTab(page, 'review');
  await expect(page.getByTestId('phase-design-warning-boundary:getOverdue')).toBeVisible({ timeout: UI_READY });
  await frame(page, 'phase-design-contradictions', 'here');
  await shot(page, 'design-contradiction');
  await designTab(page, 'model');
  await boundary.fill(OPERATIONS[2].note!);

  // DesignContract.png: the HTTP contract in its workbench, the form the
  // next three phases are held to.
  await fillApiContract(page);
  await frame(page, 'phase-design-editor', 'top');
  await shot(page, 'design-contract');

  await fillScreens(page);
  await fillSequence(page);
  await fillDecision(page);

  /* ------------------ DesignAdr: a decision record, accepted -------------- */
  // The record behind the decision: what was going on, what the class lives
  // with because of it, and the status that makes it a decision.
  await page.getByTestId('design-decision-0-context').fill('the class machine has no database server and the report has to survive a restart');
  await page.getByTestId('design-decision-0-consequences').fill('the data file is one file to back up');
  await page.getByTestId('design-decision-0-status').selectOption('accepted');
  await expect(page.getByTestId('design-decision-0')).toContainText('Accepted');
  await frame(page, 'design-decision-0', 'here');
  await shot(page, 'design-adr');

  await expectFloorPassed(page);

  // Design.png: the floor in words, and the architect asked about a refusal.
  await expect(page.getByTestId('persona-panel')).toBeVisible();
  await askReviewer(page, 'What breaks if listTasks says it raises no errors?');
  await frame(page, 'phase-design-editor', 'top');
  await shot(page, 'design');

  // The review is read in the room, on its Review tab.
  await page.getByTestId('design-submit').click();
  await expect(page.getByTestId('design-review').getByTestId('feedback-verdict')).toContainText('Pass', { timeout: 180_000 });
  await merge(page, MESSAGES.design, 'Implementation');
});

/* ------- 2 · the IDE, the pull request twice, and home under submission 1 -- */

test('the workspace mid-failure, the pull request, then home and the palette', async ({
  page,
}) => {
  test.setTimeout(1_200_000);

  await coachSeen(page);
  await openPhase(page, /\/workspace\/[^/?#]+$/);
  await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: UI_READY });

  /* ------------------ Workspace.png: the scaffold, run and red ------------- */
  // The mockup is drawn on a failing run: problems in the explorer, notes in
  // the gutter and a red terminal. The scaffold gives exactly that.
  await runAny(page);
  await page.getByTestId('tab-tests').click();
  await expect(page.getByTestId('explorer')).toBeVisible();
  await expect(page.getByTestId('status-bar')).toBeVisible();
  // Workspace.png is framed on the notes the failing run leaves in the gutter,
  // so the editor is scrolled to the first one when there is one to scroll to.
  const gutterNote = page.locator('[data-testid^="inline-note"]').first();
  if (await gutterNote.count()) await gutterNote.scrollIntoViewIfNeeded();
  await shot(page, 'workspace');

  /* ------------- ExplainTurn: the reviewer explaining a red case ----------- */
  // The button is beside the case that failed; the answer lands in
  // the thread the learner already has, so it is counted and on the record like
  // every other hint.
  const explain = page.getByRole('button', { name: /^Explain why .+ fails$/ }).first();
  await expect(explain).toBeVisible({ timeout: NAVIGATION });
  await explain.click();
  await expect(
    page.getByTestId('msg-user').filter({ hasText: 'Why does' }),
  ).toHaveCount(1, { timeout: NAVIGATION });
  await expect(page.getByTestId('msg-assistant').last()).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('msg-assistant').last()).toContainText('What this test checks');
  await frame(page, 'mentor-chat', 'here');
  await shot(page, 'explain-turn');
  await page.getByTestId('tab-tests').click();

  /* ------------------ PullRequest.png: opened, and short of the gate ------- */
  // The mockup is a pull request in review: one submission, under the gate,
  // with the reviewer's threads open against the diff. Submitting the scaffold
  // is exactly that submission.
  await submitAndLand(page);

  /* ------------ CodeHealth: the analyzer's report, under the code ---------- */
  // The API stores this report per submission. The tab needs a graded
  // revision, so it is photographed here and not before the first submit.
  await page.getByTestId('tab-health').click();
  await expect(page.getByTestId('health-panel')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('health-source')).toContainText('From submission');
  await shot(page, 'code-health');
  await page.getByTestId('tab-feedback').click();

  // A door of the header's More menu; it navigates, so the menu needs no folding.
  await (await stripDoor(page, 'open-document')).click();
  await page.waitForURL(/\/workspace\/[^/?#]+\/pr/, { timeout: UI_READY });
  await expect(page.getByTestId('pr-title')).toContainText('PR-3', { timeout: UI_READY });
  await expect(page.getByTestId('phase-implementation-revision-1')).toBeVisible();
  // Drawn on Files changed, where the diff and the threads on it are.
  await page.getByTestId('pr-tab-files').click();
  await expect(page.locator('[data-testid^="pr-file-"]').first()).toBeVisible({ timeout: UI_READY });
  await frame(page, 'pr-title', 'top');
  await shot(page, 'pull-request');

  /* ------------------- PrHistory.png: the same revisions as a log --------- */
  // One row per revision, with the words the learner submitted it
  // with; a revision with no message reads "No message".
  await page.getByTestId('pr-tab-history').click();
  await expect(page.getByTestId('pr-history')).toBeVisible({ timeout: UI_READY });
  await shot(page, 'pr-history');
  await page.getByTestId('pr-tab-files').click();

  /* ------------------- Main.png, Palette.png: under PR-3 ------------------- */
  // Both are drawn on this state and no other: Implementation in progress,
  // one submission landed under the gate. So they are photographed here,
  // between the failing submission and the fix, rather than the moment the
  // phase opened. There is no phases page (/phases opens the progress page),
  // and /map is the full project map page Home's "Open the full map" links
  // to, so neither has a shot of its own.
  const prHref = page.url();
  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard-project')).toContainText('TaskTrackr', { timeout: UI_READY });
  await expect(page.getByRole('link', { name: 'Continue my project', exact: true })).toBeVisible();
  await shot(page, 'main');

  // Palette.png: the search over home, a word from the backlog typed, the
  // groups it searches. "late" is US-5's word and the pack gives that story to
  // the learner, so the shot has rows in it: the drawing is of a search that
  // found something, and a shot of an empty list would be of nothing.
  await page.getByTestId('jump-to').click();
  await expect(page.getByTestId('palette')).toBeVisible();
  await page.getByTestId('palette-input').fill('late');
  await expect(page.getByTestId('palette-row-0')).toBeVisible({ timeout: 20_000 });
  await shot(page, 'palette');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('palette')).toBeHidden();

  /* ----------------------- back to the pull request ----------------------- */
  await page.goto(prHref);
  await expect(page.getByTestId('pr-title')).toBeVisible({ timeout: UI_READY });

  /* ----------------------------- then make it green ----------------------- */
  await page.getByTestId('pr-open-workspace').click();
  await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: UI_READY });
  await writeFile(page, 'api/repository/tasks.py', SOLUTION_REPOSITORY);
  await writeFile(page, 'api/routes/tasks.py', SOLUTION_ROUTES);
  await writeFile(page, 'web/src/lib/overdue.ts', SOLUTION_OVERDUE);
  await writeFile(page, 'web/src/hooks/useTasks.ts', SOLUTION_USE_TASKS);
  // Two runs, so the merged total is six: four pytest cases and two DOM cases.
  await runSandbox(page, '6/6 tests passed');
  await submitAndPass(page);
  // A door of the header's More menu; it navigates, so the menu needs no folding.
  await (await stripDoor(page, 'open-document')).click();
  await page.waitForURL(/\/workspace\/[^/?#]+\/pr/, { timeout: UI_READY });
  await expect(page.getByTestId('pr-title')).toBeVisible({ timeout: UI_READY });

  /* --------------------- PullRequestMerged.png: merged -------------------- */
  // The merged drawing is still on Files changed, with both threads resolved
  // beside the diff, so the tab is picked again after the second submission.
  await page.getByTestId('pr-tab-files').click();
  await expect(page.locator('[data-testid^="pr-file-"]').first()).toBeVisible({ timeout: UI_READY });
  const mergeCard = page.getByTestId('pr-merge');
  await mergeCard.getByTestId('reflection-input').fill(MESSAGES.implementation);
  await mergeCard.getByTestId('reflection-submit').click();
  await expect(page.getByTestId('phase-implementation-merged')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId('pr-open-next')).toBeVisible();
  await frame(page, 'pr-title', 'top');
  await shot(page, 'pull-request-merged');

  /* ------------- Solution.png: the pack's own answer, beside yours -------- */
  // The door exists only once the gate is in, which is why the shot
  // is taken here and not on the pull request above it. The pull request's header keeps the door inside its
  // Details, as the workspace keeps it in More, so Details is opened first.
  await (await stripDoor(page, 'solution-open')).click();
  await expect(page.getByTestId('solution-title')).toHaveText('Reference solution', {
    timeout: UI_READY,
  });
  await expect(page.getByTestId('solution-summary')).toBeVisible();
  await frame(page, 'solution-summary', 'top');
  await shot(page, 'solution');
  await page.getByTestId('solution-back').first().click();
  await expect(page.getByTestId('pr-title')).toBeVisible({ timeout: UI_READY });

  await page.getByTestId('pr-open-next').click();
  await expect(page.getByTestId('phase-title')).toHaveText('Testing', { timeout: NAVIGATION });
});

/* ------------------ 3 · the testing IDE and the kill matrix ---------------- */

test('the testing workspace before the link, and the kill matrix after', async ({ page }) => {
  test.setTimeout(1_200_000);

  await coachSeen(page);
  await openPhase(page, /\/workspace\/[^/?#]+$/);
  const phaseId = phaseIdOf(page);
  await writeFile(page, 'tests/test_acceptance.py', MY_TESTS);
  await writeFile(page, 'web/src/acceptance.test.tsx', MY_WEB_TESTS);
  await runAny(page);

  /* ---------- TestingWorkspace.png: criteria, failing first, the note ------ */
  await page.getByTestId('tab-failing-first').click();
  const note = page.locator('[data-testid^="inline-note-link-"]').first();
  await expect(note).toBeVisible({ timeout: UI_READY });
  await note.scrollIntoViewIfNeeded();
  await shot(page, 'testing-workspace');

  /* --------------------- RunClock.png: the day the sandbox calls today ---- */
  // It lives in the testing phase's brief column, which is the tab
  // the workspace opens on.
  await page.getByTestId('run-clock').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('run-clock')).toBeVisible();
  await shot(page, 'run-clock');

  /* --------------------- then pick the criterion and submit --------------- */
  // The editor draws the note only under a test with no saved link, so the
  // saved link is that note (`inline-note-link-<test>`) leaving the editor.
  const noteId = await note.getAttribute('data-testid');
  await note.locator('button').first().click();
  await expect(page.getByTestId(noteId!)).toHaveCount(0, { timeout: UI_READY });
  await runSandbox(page, 'tests passed');
  await submitAndPass(page);

  /* ------------------------------ KillMatrix.png -------------------------- */
  // A door of the header's More menu; it navigates, so the menu needs no folding.
  await (await stripDoor(page, 'open-document')).click();
  await page.waitForURL(/\/workspace\/[^/?#]+\/matrix/, { timeout: UI_READY });
  await expect(page.getByTestId('matrix-title')).toBeVisible({ timeout: UI_READY });
  // Eight planted bugs over two layers: six on the API run, two on the front
  // end. Both reference suites are written above, so all eight die.
  await expect(page.getByTestId('phase-testing-matrix-stats')).toContainText('8 of 8');
  await expect(page.getByTestId('phase-testing-planted-bugs')).toBeVisible();
  await frame(page, 'phase-testing-matrix', 'top');
  await shot(page, 'kill-matrix');

  await openIde(page, phaseId);
  await merge(page, MESSAGES.testing, 'Deployment');
});

/* --------------- 4 · the incident drill and the change request ------------ */

test('the incident drill mid-flight, and CR-2', async ({ page }) => {
  test.setTimeout(1_200_000);

  await coachSeen(page);
  await openPhase(page, /\/workspace\/[^/?#]+$/);
  const deployId = phaseIdOf(page);

  // The three files and the runbook: the build check starts the api service through the
  // learner's own ENTRYPOINT and its selfcheck reads their compose, so one
  // without the other leaves the health check red. The runbook is the Runbook tab's forms.
  await writeFile(page, 'api/Dockerfile', MY_DOCKERFILE);
  await writeFile(page, 'docker-compose.yml', MY_COMPOSE);
  await writeFile(page, '.github/workflows/ci.yml', MY_CI);
  await fillRunbookForms(page, JSON.parse(RUNBOOK_RECORD));

  // A door of the header's More menu; it navigates, so the menu needs no folding.
  await (await stripDoor(page, 'open-document')).click();
  await page.waitForURL(/\/workspace\/[^/?#]+\/drill/, { timeout: UI_READY });
  await expect(page.getByTestId('drill-title')).toBeVisible({ timeout: UI_READY });

  await page.getByTestId('phase-deployment-drill-start').click();
  await expect(page.getByTestId('phase-deployment-drill-before')).toBeVisible({ timeout: 180_000 });
  await page.getByTestId('phase-deployment-drill-health').click();
  const health = page.getByTestId('phase-deployment-drill-health-result');
  await expect(health).toBeVisible({ timeout: 180_000 });
  await expect(health).toContainText('exit 0');

  // The write-up is the drill page's Incident record view.
  const drillNav = page.locator('nav[aria-label$=" working area"]');
  await drillNav.getByRole('button', { name: 'Incident record', exact: true }).click();
  await page.getByTestId('phase-deployment-incident-root-cause').fill(PASSING_INCIDENT.rootCause);
  await page.getByTestId('phase-deployment-incident-fix').fill(PASSING_INCIDENT.fix);
  await page.getByTestId('phase-deployment-incident-action').fill(PASSING_INCIDENT.actionItem);

  // IncidentDrill.png: paged, health checked and written up, with Resolve
  // still to press, the drill at the moment it is actually being worked. The
  // drawing is of the page from its title, so the shot starts there too.
  await expect(page.getByTestId('phase-deployment-incident-record')).toBeVisible();
  await frame(page, 'phase-deployment-incident-record', 'top');
  await shot(page, 'incident-drill');

  await page.getByTestId('phase-deployment-drill-resolve').click();
  await expect(page.getByTestId('phase-deployment-drill-resolve')).toHaveText(/Resolved/, { timeout: 180_000 });

  // The resolve wrote the incident into the runbook: the Runbook tab shows it read-only.
  await openIde(page, deployId);
  await page.getByTestId('phase-deployment-tab-runbook').click();
  await expect(page.getByTestId('runbook-tab')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('runbook-incident-rootCause')).toHaveValue(PASSING_INCIDENT.rootCause);
  await runSandbox(page, 'Run completed successfully');
  await submitAndPass(page);
  await merge(page, MESSAGES.deployment, 'Maintenance');

  /* ---------------------------- ChangeRequest.png ------------------------- */
  const changeId = phaseIdOf(page);
  await page.goto(`/workspace/${changeId}/change`);
  const ticket = page.getByTestId('change-ticket');
  await expect(ticket).toBeVisible({ timeout: UI_READY });
  await expect(ticket).toContainText('CR-2');

  // The change request's four tabs; the Contract card's Add waits for the operation the Request tab names.
  await fillChangeForms(page, JSON.parse(CHANGE_REQUEST_RECORD));
  const roomNav = page.locator('nav[aria-label="Change request sections"]');
  await roomNav.getByRole('button', { name: 'Contract', exact: true }).click();
  const contracts = page.getByTestId('phase-maintenance-contracts-v2');
  await expect(contracts).toBeVisible();
  await page.getByTestId('phase-maintenance-contract-v2-add').click();
  await page.getByTestId('phase-maintenance-contract-inputs').fill(LIST_COMMENTS.inputs);
  await page.getByTestId('phase-maintenance-contract-returns').fill(LIST_COMMENTS.returns);
  await page.getByTestId('phase-maintenance-contract-errors').fill(LIST_COMMENTS.errors);
  await expect(contracts).toContainText('Written');
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });

  await roomNav.getByRole('button', { name: 'Request', exact: true }).click();
  await frame(page, 'change-ticket', 'top');
  await shot(page, 'change-request');

  /* --------------------------- finish the project ------------------------- */
  await openIde(page, changeId);
  await writeFile(page, 'api/repository/tasks.py', CR2_REPOSITORY_TASKS);
  await writeFile(page, 'api/repository/comments.py', CR2_REPOSITORY_COMMENTS);
  await writeFile(page, 'api/routes/comments.py', CR2_ROUTES_COMMENTS);
  await writeFile(page, 'web/src/components/TaskRow.tsx', CR2_TASK_ROW);
  await runSandbox(page, 'tests passed');
  await submitAndPass(page);
  await merge(page, MESSAGES.maintenance, null);
  // The completion record (app/(app)/completion/page.tsx) names the learner.
  await expect(page.locator('.exp-certificate-name')).toHaveText(LEARNER.name, { timeout: UI_READY });
});

/* ------------------ 5 · the record the finished project left -------------- */

// The journal timeline, the artefact shelves and the repository card are no
// longer drawn by any page (/journal is the progress page), so their shots
// (journal, repo-card, repo-contents) are not taken. The artefacts page and
// the dossier are.
test('the artefacts page and the dossier', async ({ page }) => {

  await coachSeen(page);
  await signIn(page, LEARNER.email, LEARNER.password);
  await expect(page.getByTestId('dashboard-project')).toContainText('TaskTrackr', { timeout: UI_READY });

  await page.goto('/artefacts');
  await expect(page.getByRole('heading', { level: 2, name: 'Requirements', exact: true }).first()).toBeVisible({ timeout: UI_READY });
  await shot(page, 'artefacts');

  /* ------------------------- Dossier.png: the whole project --------------- */
  // Both themes, because the print stylesheet and
  // the screen one are the same document.
  await page.getByRole('link', { name: 'Print project evidence', exact: true }).click();
  await page.waitForURL('**/dossier', { timeout: UI_READY });
  await expect(page.getByTestId('dossier')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId('dossier-section-12')).toBeVisible({ timeout: NAVIGATION });
  await shot(page, 'dossier');
});

/* ------------------------- 5b · the first run over home ------------------- */

// FirstRun.png: the numbered callouts of the home tour. Tours open on
// request ("Show me around" in the account menu), so the shot opens it there.
// The home underneath is this learner's finished project rather than a
// literally empty first run, which is the one way the shot and the drawing
// differ.
test('the coach marks over home', async ({ page }) => {
  test.setTimeout(180_000);

  await coachSeen(page);
  await signIn(page, LEARNER.email, LEARNER.password);
  await expect(page.getByTestId('dashboard-project')).toContainText('TaskTrackr', { timeout: UI_READY });
  await page.getByTestId('nav-user').click();
  await page.getByTestId('show-me-around').click();
  const coach = page.getByTestId('coach');
  await expect(coach).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('coach-count')).toHaveText(/^1 of \d+$/);
  await expect(page.getByTestId('coach-skip')).toBeVisible();
  await shot(page, 'first-run');
});

/* ------------------- 6 · the instructor's console and a learner ----------- */

// The console is the teacher home (/teacher) and one class's page
// (/teacher/class), as journey and instructor-tools walk them. The class is
// made through the API and the learner joins it from the classroom page. The
// lab block (the join link and its QR) is drawn by no page, so its shot is
// not taken.
test('the teacher home, one class page and one learner', async ({ page, request }) => {

  await coachSeen(page);
  const { cohortId: classId, joinCode } = await classByApi(request, CLASS_NAME);

  await signIn(page, LEARNER.email, LEARNER.password);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
  await joinClassInUi(page, joinCode);
  await signOutFromMenu(page);

  /* ------------------------ Class.png: the teacher home -------------------- */
  await signIn(page, INSTRUCTOR.email, INSTRUCTOR.password);
  await teacherHome(page);
  // The home lists the classes as cards; the roster is on each class page.
  await expect(page.locator('li', { hasText: CLASS_NAME })).toContainText('1 learner', { timeout: UI_READY });
  await shot(page, 'class');

  /* -------------------- three panels of the class page --------------------- */
  // The class's own notes, which the mentor quotes back.
  await page.goto(`/teacher/class?class=${classId}`);
  // Each panel is under its own tab of the class page.
  await page.getByTestId('class-tab-invite').click();
  await page.getByTestId('notes-card').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('notes-card')).toBeVisible({ timeout: UI_READY });
  await shot(page, 'instructor-notes');

  // The class dates, and the regrade beside them.
  await page.getByTestId('class-tab-dates').click();
  await page.getByTestId('schedule-panel').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('schedule-panel')).toBeVisible({ timeout: UI_READY });
  await shot(page, 'instructor-schedule');

  await page.getByTestId('regrade-panel').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('regrade-panel')).toBeVisible({ timeout: UI_READY });
  await shot(page, 'instructor-regrade');

  /* ------------- LearnerDetail.png: one learner's phase, inspected --------- */
  await inspectLearnerPhase(page, classId, LEARNER.name, 'Requirements');
  await shot(page, 'learner-detail');

  /* ----------------- ViewAs.png: the learner's screen, read only ---------- */
  // The banner is drawn by AppFrame, so it is on whatever route the
  // session is on; the dashboard is the one the start lands on.
  await page.getByTestId('view-as-start').click();
  await page.waitForURL('**/dashboard', { timeout: NAVIGATION });
  await expect(page.getByTestId('view-as-banner')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('dashboard-project')).toContainText('TaskTrackr', { timeout: UI_READY });
  await shot(page, 'view-as-banner');
  await page.getByTestId('view-as-stop').click();
  // /teacher?learner= goes on to the learner's class page.
  await page.waitForURL(/\/teacher\/class\?class=[^&]+&learner=/, { timeout: NAVIGATION });
});

/* -------------- 7 · the learner's own application, running ---------------- */

/**
 * Run app. A fresh learner, because the preview only exists on a
 * phase with an application to run and the gate in front of phase 3 is real,
 * `reachImplementation` walks the golden path rather than opening a back door.
 *
 * Three shots: the frame with the scaffold's own hole in it, the console the
 * app printed into, and the panel after Stop.
 */
test('Run app: the preview, the console and the stopped panel', async ({ page }) => {
  test.setTimeout(1_200_000);

  await reachImplementation(page, 'shots-preview');

  await page.getByTestId('header-run-app').click();
  await expect(page.getByTestId('preview-frame')).toBeVisible({ timeout: 180_000 });
  const app = page.frameLocator('[data-testid="preview-frame"]');
  await expect(app.getByRole('heading', { name: 'Your lists' })).toBeVisible({ timeout: NAVIGATION });
  // The scaffold's own hole, named in the learner's own file at their own line.
  // That is the shot: the application is real and what is missing from it is
  // what they have not written yet.
  await app.getByText('Home', { exact: true }).click();
  await expect(app.getByRole('heading', { name: 'useTasks is not implemented yet' })).toBeVisible({
    timeout: UI_READY,
  });
  await expect(page.getByTestId('preview-not-marked')).toBeVisible();
  await shot(page, 'preview-ready');

  await page.getByTestId('preview-console-toggle').click();
  await expect(page.getByTestId('console-pane')).toContainText('seed:', { timeout: UI_READY });
  await shot(page, 'preview-console');

  await page.getByTestId('preview-stop').click();
  await expect(page.getByTestId('preview-stopped')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId('preview-stopped')).toHaveAttribute('data-reason', 'learner');
  await shot(page, 'preview-stopped');
});
