import { expect, test, type Page } from '@playwright/test';
import { dismissPhaseTutorial, openCaseFile, openRequirements, registerAndSignIn, skipCoachMarks } from './pw-fixtures';
import { testEmail } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * What the reviewer's column says, and what the customer's room looks like on
 * a phone.
 *
 * Three cases, each with the measurement it guards:
 *
 * - "Reads your story and its criteria…" is said once, not under the
 *   reviewer's avatar and again ninety pixels below it as the first line of
 *   the empty thread.
 * - a question that failed does not read "…did not get that question
 *   (request failed (502))", a status code inside a bracket inside a bracket.
 * - at 390 the interview's checklist does not take the top 500 px and leave
 *   the transcript a 76 px window that is not scrolled to the newest turn.
 */

const PHONE = { width: 390, height: 844 };

/**
 * The sentence the header carries, from `apps/web/lib/phase.ts`'s
 * `PHASE_REVIEWER.requirements.does`. Written out rather than imported: this
 * suite does not compile the web app's modules.
 */
const REQUIREMENTS_DOES =
  'Reads your story and its criteria. Asks whether each one can be run. Never writes the story.';

const LEARNER = () => ({
  name: 'Gia Mentor',
  email: testEmail(`reviewer-column-${Date.now()}`),
  password: 'Correct-Horse-9',
});


/** A fresh learner, enrolled, standing on the requirements issue. */
async function toTheIssue(page: Page): Promise<void> {
  const learner = LEARNER();
  await skipCoachMarks(page);
  await dismissPhaseTutorial(page);
  await registerAndSignIn(page, learner);
  // Setup starts the project; the Requirements room holds the interview, the
  // backlog and the reviewer's column on one page.
  await openRequirements(page);
  await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: UI_READY });
}

/** How many times one sentence appears in an element's text. */
async function occurrences(page: Page, testId: string, needle: string): Promise<number> {
  const text = await page.getByTestId(testId).innerText();
  return text.split(needle).length - 1;
}

test('the reviewer says what they do once, not twice', async ({ page }) => {
  test.setTimeout(180_000);
  await toTheIssue(page);

  const panel = page.getByTestId('persona-panel').first();
  await expect(panel).toBeVisible();
  // The thread is empty, a first visit is exactly when a duplicate would show.
  await expect(page.getByTestId('msg-user')).toHaveCount(0);

  // What the reviewer does is said in the panel's "About" details (the
  // mentor's purpose; PersonaPanel.tsx), and nowhere else in the panel.
  const about = panel.getByTestId('chat-details-toggle');
  await about.click();
  const said = panel.locator('p', { hasText: 'Guided conversations offer hints and questions.' });
  await expect(said).toHaveCount(1);
  const purpose = ((await said.innerText()).split('Guided conversations')[0] ?? '').trim();
  expect(purpose.length, 'the reviewer says what they do').toBeGreaterThan(10);
  expect(await occurrences(page, 'persona-panel', purpose)).toBe(1);
  expect(await occurrences(page, 'persona-panel', REQUIREMENTS_DOES), 'the old header line is not said as well').toBe(0);
  // And the sentence the empty thread is for is still there.
  await expect(panel).toContainText('What are you working through?');
});

test('a question that fails says so without a status code', async ({ page }) => {
  test.setTimeout(180_000);
  await toTheIssue(page);

  // A bare 502 with no body: the shape a proxy in front of the API produces,
  // and the one that must not reach the learner as "(request failed (502))".
  await page.route('**/assistant/chat', (route) =>
    route.fulfill({ status: 502, contentType: 'application/json', body: '{}' }),
  );

  await page.getByTestId('chat-input').first().fill('Why does the report need its own page?');
  await page.getByTestId('chat-send').first().click();

  const error = page.getByTestId('chat-error').first();
  await expect(error).toBeVisible({ timeout: UI_READY });
  const said = await error.innerText();
  expect(said).not.toContain('502');
  expect(said).not.toContain('request failed');
  expect(said).not.toMatch(/\(\(|\)\)/);
  expect(said).toContain('The server had a problem.');
  expect(said).toContain('Your question is kept for retry.');
  // The words are still theirs, which is what the sentence promises.
  await expect(page.getByTestId('chat-input').first()).toHaveValue(
    'Why does the report need its own page?',
  );
});

test('the interview gives the conversation the screen on a phone', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize(PHONE);
  await toTheIssue(page);

  // A new learner's room opens at the interview.
  await expect(page.getByTestId('interview-page')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('interview-opening')).toContainText('ten minutes');

  // The topics live in the case file, off the conversation's screen, so the
  // conversation is the room rather than 500 px of checklist against 76 px of
  // transcript.
  await expect(page.getByTestId('interview-checklist')).toBeHidden();
  const transcript = await page.getByTestId('interview-transcript').boundingBox();
  expect(transcript, 'the transcript has a box').not.toBeNull();
  expect(transcript!.height).toBeGreaterThan(280);

  // In the case file on a phone the topics are folded away behind their own
  // count, and the count and the way to open them are both on screen.
  await openCaseFile(page, 'Interview evidence');
  await expect(page.getByTestId('interview-settled')).toBeVisible();
  await expect(page.getByTestId('interview-fact-F1')).toBeHidden();
  await expect(page.getByTestId('interview-checklist-toggle')).toBeVisible();

  // Opening the topics is one press, and closing them gives the room back.
  await page.getByTestId('interview-checklist-toggle').click();
  await expect(page.getByTestId('interview-fact-F1')).toBeVisible();
  await page.getByTestId('interview-checklist-toggle').click();
  await expect(page.getByTestId('interview-fact-F1')).toBeHidden();
  // And the case file closes, giving the conversation back.
  await page.getByRole('button', { name: 'Hide brief', exact: true }).click();
  await expect(page.getByTestId('interview-transcript')).toBeVisible();

  /* --------- three answers, and the newest one is the one on screen -------- */
  for (const [i, question] of [
    'Who actually reads the overdue report?',
    'Is a task due today overdue?',
    'Do completed tasks show up in it?',
  ].entries()) {
    await page.getByTestId('interview-input').fill(question);
    await page.getByTestId('interview-send').click();
    await expect(page.getByTestId(`interview-answer-${i + 1}`)).toBeVisible({ timeout: UI_READY });
  }

  const atBottom = async () =>
    page.getByTestId('interview-transcript').evaluate((el) => ({
      gap: el.scrollHeight - el.scrollTop - el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
  await expect
    .poll(async () => (await atBottom()).gap, { timeout: 10_000 })
    .toBeLessThanOrEqual(8);

  // And on a fresh mount of a room that already has turns in it, the room
  // must not open part-way up its own transcript with the customer's last
  // sentence cut in half. A reload drops the held room, so this is the room
  // rebuilding itself from the API and landing on the newest turn.
  await page.reload();
  await expect(page.getByTestId('interview-answer-3')).toBeVisible({ timeout: UI_READY });
  await expect
    .poll(async () => (await atBottom()).gap, { timeout: 10_000 })
    .toBeLessThanOrEqual(8);
});
