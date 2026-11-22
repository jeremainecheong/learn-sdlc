import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { dismissPhaseTutorial, signInAs, waitForEditor } from './pw-fixtures';
import { reachImplementationByApi } from './passing-work';
import { openConsole } from './preview-helpers';
import { testEmail } from './support/env';
import { NAVIGATION, SANDBOX_RUN, UI_READY } from './support/timeouts';

/**
 * "Explain this failing test".
 *
 * The control sits beside a test that did not pass, in the run panel, in the
 * problems list and on the pull request's Checks tab, and it asks the reviewer
 * the learner already has, in the thread they already have. So the things worth
 * driving through a browser are the three the API cannot prove on its own: the
 * question appears in the learner's own words in the thread, an answer comes
 * back naming their file, and pressing the button a second time spends nothing.
 *
 * The learner is walked to Implementation through the API and then leaves the
 * stubs alone, which is what makes the suite red, the same state a learner is
 * in the first time they run.
 */

const PASSWORD = 'Correct-Horse-9';
/** One account per test: two of them register, and an address is claimed once. */
const learner = (tag: string) => ({
  name: 'Xena Explain',
  email: testEmail(`e2e-explain-${tag}-${Date.now()}`),
  password: PASSWORD,
});
type Learner = ReturnType<typeof learner>;

/** Requirements and Design passed through the API; Implementation left as it ships. */
async function reachImplementation(
  request: APIRequestContext,
  who: Learner,
): Promise<string> {
  // Complete, marked written work, saved, submitted and assessed by the
  // suite's AI stub, then reflected on and advanced (e2e/passing-work.ts).
  return (await reachImplementationByApi(request, who)).phaseId;
}

async function signIn(page: Page, who: Learner): Promise<void> {
  await dismissPhaseTutorial(page);
  await page.goto('/login');
  await signInAs(page, who.email, who.password);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
}

test('the reviewer explains a failing test, and says it once', async ({ page, request }) => {
  test.setTimeout(900_000);
  const who = learner('run');
  const phaseId = await reachImplementation(request, who);

  await signIn(page, who);
  await page.goto(`/workspace/${phaseId}`);
  await waitForEditor(page, 60_000);

  /* ------------------------- a run that goes red -------------------------- */

  // The IDE's bottom panel opens from the console bar under the editor.
  await openConsole(page);
  await page.getByTestId('tab-tests').click();
  await page.getByTestId('run-button').click();
  await expect(page.getByTestId('run-summary')).toBeVisible({ timeout: 300_000 });
  // The stubs are untouched, so the visible suite is red.
  await expect(page.getByTestId('run-summary')).not.toContainText(/^0\/0/);

  const explain = page.getByRole('button', { name: /^Explain why .* fails$/ }).first();
  await expect(explain).toBeVisible({ timeout: UI_READY });
  const label = (await explain.getAttribute('aria-label')) ?? '';
  const testName = /^Explain why (.+) fails$/.exec(label)![1];

  const hintsBefore = await page.getByTestId('msg-assistant').count();
  await explain.click();

  /* ----------------------- the turn, in the thread ------------------------ */

  // The reviewer's tab is what the button opens, because the answer lands there.
  const question = page.getByTestId('msg-user').filter({ hasText: `Why does ${testName} fail?` });
  await expect(question).toHaveCount(1, { timeout: NAVIGATION });

  const reply = page.getByTestId('msg-assistant').nth(hintsBefore);
  await reply.waitFor({ state: 'visible', timeout: SANDBOX_RUN });
  // The configured mentor answers; in this suite that is e2e/ai-stub.cjs's
  // guided draft.
  await expect(reply).toContainText('Which single case would you check first');
  await expect(page.getByTestId('chat-error')).toHaveCount(0);
  // Never the sealed suite's own source, whichever mentor answered.
  await expect(reply).not.toContainText('def test_');

  // The button was pressed on the Tests tab, the reviewer's tab opened
  // under it, and the thread must be at the reply, not at question 1, which
  // is where a freshly mounted scroller stands. Two things are read, because
  // the first alone can be true for the wrong reason (a feed scroller with no
  // bounded height has the whole thread as its rect, so everything is
  // "inside" it): the feed is the element that overflows and it is scrolled to
  // its end, and the reply's bottom edge is inside the part of it on screen.
  await expect
    .poll(
      () =>
        reply.evaluate((node) => {
          const scroller = node.closest('[role="log"]');
          if (!scroller) return 'no scroller';
          const left = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
          // The room draws no band stack, so a three-message thread
          // may not overflow the taller feed at all; then the reply only has to
          // be on screen. A feed that does scroll must stand at its end.
          const scrolls = scroller.scrollHeight > scroller.clientHeight;
          if (scrolls && left > 2) return `the feed stops ${Math.round(left)}px short of its end`;
          const r = node.getBoundingClientRect();
          const s = scroller.getBoundingClientRect();
          const top = Math.max(s.top, 0);
          const bottom = Math.min(s.bottom, window.innerHeight);
          const bottomIn = r.bottom <= bottom + 1 && r.bottom > top;
          const topIn = r.top >= top - 1 || r.height > bottom - top;
          return bottomIn && topIn ? 'in view' : `reply ${r.top}-${r.bottom} in ${top}-${bottom}`;
        }),
      { timeout: 10_000 },
    )
    .toBe('in view');

  /* ------------------ asking twice spends no second hint ------------------ */

  // The hint ladder counts the learner's own questions, the rows the score is
  // charged against, so pressing the button a second time must not move it.
  // The count is the mentor's About line ("N Guided hints in this phase"),
  // in the chat surface of the workspace's mentor panel.
  const mentor = page.locator('aside[data-workspace-panel="mentor"]').first();
  await mentor.getByTestId('chat-details-toggle').click();
  const hintsLine = mentor.getByTestId('chat-details').getByText(/\d+ Guided hints? in this phase/);
  await expect(hintsLine).toBeVisible();
  const spent = /\d+ Guided hints? in this phase/.exec((await hintsLine.textContent()) ?? '')![0];

  const again = page.getByRole('button', { name: `Read why ${testName} fails` }).first();
  await expect(again).toBeVisible();
  await again.click();
  // No second question, no second answer, and the meter has not moved.
  await expect(question).toHaveCount(1);
  await expect(page.getByTestId('msg-assistant')).toHaveCount(hintsBefore + 1);
  await expect(hintsLine).toContainText(spent);
});

test('the pull request explains a failing case in the same thread', async ({ page, request }) => {
  test.setTimeout(900_000);
  const who = learner('pr');
  const phaseId = await reachImplementation(request, who);

  await signIn(page, who);
  await page.goto(`/workspace/${phaseId}`);
  await waitForEditor(page, 60_000);

  // Submitting the stubs opens the pull request with a red verdict on it.
  await page.getByTestId('header-submit').click();
  await expect(page.getByTestId('feedback-verdict')).toContainText('Needs revision', {
    timeout: 300_000,
  });

  await page.goto(`/workspace/${phaseId}/pr`);
  await page.getByTestId('pr-tab-checks').click();
  const explain = page.getByRole('button', { name: /^Explain why .* fails$/ }).first();
  await expect(explain).toBeVisible({ timeout: NAVIGATION });
  const label = (await explain.getAttribute('aria-label')) ?? '';
  const testName = /^Explain why (.+) fails$/.exec(label)![1];

  await explain.click();

  // The Conversation tab holds the same thread, and that is where it lands.
  const question = page.getByTestId('msg-user').filter({ hasText: `Why does ${testName} fail?` });
  await expect(question).toHaveCount(1, { timeout: NAVIGATION });
  const reply = page.getByTestId('msg-assistant').last();
  await expect(reply).toBeVisible({ timeout: SANDBOX_RUN });
  await expect(reply).not.toContainText('def test_');
  await expect(page.getByTestId('chat-error')).toHaveCount(0);
});
