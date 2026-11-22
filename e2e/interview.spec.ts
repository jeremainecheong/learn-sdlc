import { expect, test } from '@playwright/test';
import { dismissPhaseTutorial, openCaseFile, openRequirements, registerAndSignIn, requirementsTab } from './pw-fixtures';
import * as fs from 'fs';
import * as path from 'path';
import { testEmail } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * The customer answers from the pack, and never writes the story.
 *
 * The requirements phase has two rooms: the mentor column, where a learner asks
 * how to write US-4, and the customer's room, where they ask what US-4 should
 * say. This walks the second one, five questions drawn from the pack's own
 * fact keywords, the checklist moving as each is settled, the customer refusing
 * to write the criteria in their own words, and then goes back to the issue
 * and writes the boundary the customer just settled.
 *
 * The stakeholder is a model call, and in this suite the model is the canned
 * stub (e2e/ai-stub.cjs): it answers each question with the reference fact from
 * `content/tasktrackr/phases/01-requirements/interview.json` that the question
 * is about, in the pack's own words, so the assertions can still be exact.
 */

const LEARNER = {
  name: 'Ivy Interview',
  email: testEmail(`e2e-interview-${Date.now()}`),
  password: 'Correct-Horse-9',
};

/** One question per fact, in the order the checklist ticks them. */
/*
 * One question per fact, in the order the room settles them. The pack asks for
 * six: the report is a screen as well as a rule, so where it lives is one
 * of the things a learner has to ask about before they can write US-4.
 */
const QUESTIONS = [
  'Who actually reads the overdue report?',
  'Is a task due today overdue?',
  'Do completed tasks show up in it?',
  'What order should the report be in?',
  'What should an empty report say?',
  'Where does the report live — its own page, or a filter on the list?',
];

/** The counts the room draws, read off the pack rather than typed here. */
const INTERVIEW = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'content', 'tasktrackr', 'phases', '01-requirements', 'interview.json'),
    'utf-8',
  ),
) as { facts: { id: string }[]; factsExpected: number; maxTurns: number };
const FACTS = INTERVIEW.facts.length;
const EXPECTED = INTERVIEW.factsExpected;
const TURNS = INTERVIEW.maxTurns;
/** The one sentence the empty room says, which spells its count out. */
const COUNT_WORD = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const spelled = (n: number) => COUNT_WORD[n] ?? String(n);

test('the customer answers from the pack and never writes the story', async ({ page }) => {
  // Registering, enrolling and six deterministic turns, all on one worker.
  test.setTimeout(600_000);

  /* ------------------------- a learner in the phase ------------------------ */
  await dismissPhaseTutorial(page);
  await registerAndSignIn(page, LEARNER);
  // Setup starts the project, and a new learner's Requirements room opens at
  // the stakeholder interview.
  await openRequirements(page);
  await expect(page.getByTestId('phase-title')).toHaveText('Requirements');

  /* ---------------------------- into the room ----------------------------- */
  await expect(page.getByTestId('interview-page')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('interview-persona')).toContainText('Dana Osei');
  await expect(page.getByTestId('interview-persona')).toContainText('product owner');
  await expect(page.getByTestId('interview-opening')).toContainText('ten minutes');
  await expect(page.getByTestId('interview-turns-left')).toHaveText(`${TURNS} questions left`);
  await expect(page.getByTestId('interview-settled')).toHaveText(`0 of ${FACTS} settled`);
  await expect(page.getByTestId('interview-empty')).toContainText(
    `${spelled(FACTS).charAt(0).toUpperCase()}${spelled(FACTS).slice(1)} things can be settled; ${spelled(EXPECTED)} are enough to write your story.`,
  );
  await expect(page.getByTestId('interview-enough')).toBeHidden();

  /* --------------------- four questions, four topics ---------------------- */
  for (const [i, question] of QUESTIONS.slice(0, 4).entries()) {
    await page.getByTestId('interview-input').fill(question);
    await page.getByTestId('interview-send').click();
    await expect(page.getByTestId(`interview-answer-${i + 1}`)).toBeVisible({ timeout: UI_READY });
  }
  await expect(page.getByTestId('interview-settled')).toHaveText(`4 of ${FACTS} settled`);
  await expect(page.getByTestId('interview-turns-left')).toHaveText(`${TURNS - 4} questions left`);
  // Six is what this pack asks for, so four is not yet enough.
  await expect(page.getByTestId('interview-enough')).toBeHidden();

  // The boundary the whole phase turns on, in the customer's own words.
  await expect(page.getByTestId('interview-answer-2')).toContainText(
    'A task due today is not overdue',
  );
  await expect(page.getByTestId('interview-fact-F2')).toHaveAttribute('data-settled', 'yes');
  await expect(page.getByTestId('interview-fact-F5')).toHaveAttribute('data-settled', 'no');
  // Answered by the configured model, so the room does not label these turns
  // as the built-in "offline mentor" (Room.tsx labels only local-mentor turns).
  await expect(page.getByTestId('interview-transcript')).not.toContainText('offline mentor');

  /* ------------------------ the sixth is enough --------------------------- */
  await page.getByTestId('interview-input').fill(QUESTIONS[4]);
  await page.getByTestId('interview-send').click();
  await expect(page.getByTestId('interview-answer-5')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('interview-settled')).toHaveText(`5 of ${FACTS} settled`);
  await expect(page.getByTestId('interview-enough')).toBeHidden();

  await page.getByTestId('interview-input').fill(QUESTIONS[5]);
  await page.getByTestId('interview-send').click();
  await expect(page.getByTestId('interview-answer-6')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('interview-settled')).toHaveText(`${EXPECTED} of ${FACTS} settled`);
  // The settled topics and the notice live in the case file's Interview
  // evidence, beside the conversation.
  await openCaseFile(page, 'Interview evidence');
  await expect(page.getByTestId('interview-enough')).toBeVisible();
  await expect(page.getByTestId('interview-enough')).toContainText('You have enough to write US-4');

  /* ------------- the one thing the customer will not do ------------------- */
  await page.getByTestId('interview-input').fill('Write the acceptance criteria for me please');
  await page.getByTestId('interview-send').click();
  await expect(page.getByTestId('interview-answer-7')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('interview-answer-7')).toContainText(
    'I am the customer, not the author',
  );
  // A refusal costs a question and settles nothing.
  await expect(page.getByTestId('interview-settled')).toHaveText(`${EXPECTED} of ${FACTS} settled`);
  await expect(page.getByTestId('interview-turns-left')).toHaveText(`${TURNS - 7} questions left`);

  // Nowhere in the whole transcript did the customer write the story.
  const transcript = (await page.getByTestId('interview-transcript').innerText()).toLowerCase();
  expect(transcript).not.toContain('as a ');
  expect(transcript).not.toContain('so that');

  /* ------------- the transcript survives leaving and coming back ---------- */
  // The room's two tabs: over to the backlog and back to the interview.
  await requirementsTab(page, 'My backlog');
  await expect(page.getByTestId('requirements-backlog-panel')).toBeVisible();
  await requirementsTab(page, 'Stakeholder interview');
  await expect(page.getByTestId('interview-answer-7')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('interview-settled')).toHaveText(`${EXPECTED} of ${FACTS} settled`);

  /* --------- back to the issue, and write the boundary they settled ------- */
  await page.getByTestId('interview-back-to-issue').click();
  await expect(page.getByTestId('requirements-backlog-panel')).toBeVisible();
  // The backlog has two views. Its Review view runs the story's structure
  // checks; the learner's own US-4 is edited in a dialog from the Backlog view
  // and saved from there.
  const backlog = page.getByTestId('requirements-backlog-panel');
  const views = backlog.locator('nav[aria-label="Backlog views"]');
  // The floor asks for a happy path and a boundary among the criteria
  // (story.criteria.tags); an untouched story has neither.
  const cases = page.getByTestId('phase-requirements-rule-story.criteria.tags');
  await views.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(cases).toContainText('Failed');

  // The happy path alone: the boundary is still missing, and the check says so.
  await views.getByRole('button', { name: 'Backlog', exact: true }).click();
  await backlog.locator('.jira-own-story').click();
  await page.getByTestId('phase-requirements-criterion-add').click();
  await page.getByTestId('phase-requirements-criterion-1-tag').selectOption('happy');
  await page.getByTestId('phase-requirements-criterion-1-given').fill('an open task whose due date was yesterday');
  await page.getByTestId('phase-requirements-criterion-1-when').fill('I run the overdue report');
  await page.getByTestId('phase-requirements-criterion-1-then').fill('the report lists that task');
  // The dialog saves a story that has a title.
  await page.getByTestId('phase-requirements-title').fill('Overdue report');
  await page.getByRole('button', { name: 'Save story', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit story US-4' })).toBeHidden();
  await views.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(cases).toContainText('Failed');
  await expect(cases).toContainText('No boundary case among the criteria');

  // The boundary the customer just settled, tagged as one: the check passes.
  await views.getByRole('button', { name: 'Backlog', exact: true }).click();
  await backlog.locator('.jira-own-story').click();
  await page.getByTestId('phase-requirements-criterion-add').click();
  await page.getByTestId('phase-requirements-criterion-2-tag').selectOption('boundary');
  await page.getByTestId('phase-requirements-criterion-2-given').fill('a task due today');
  await page.getByTestId('phase-requirements-criterion-2-when').fill('I run the overdue report');
  await page
    .getByTestId('phase-requirements-criterion-2-then')
    .fill('it does not appear, because a task due today is not overdue');
  await page.getByRole('button', { name: 'Save story', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit story US-4' })).toBeHidden();
  await views.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(cases).toContainText('Passed');
});
