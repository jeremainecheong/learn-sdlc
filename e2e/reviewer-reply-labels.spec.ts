import { expect, test } from '@playwright/test';
import { dismissPhaseTutorial, openRequirements, registerAndSignIn } from './pw-fixtures';
import { NAVIGATION, SANDBOX_RUN } from './support/timeouts';

/**
 * The labels on the reviewer's replies.
 *
 * Each reply in the reviewer's column carries the learner's question number
 * and, when a guardrail answered it, a chip that says which one. What is
 * walked here is the part a unit test cannot reach: that the sentences and the
 * ordinals come out of the thread the server returns, so they are still right
 * after a reload, and that each outcome wears its own chip in a real room with
 * a real guardrail behind it.
 *
 * The test needs no code gate, so it is not slow: the deterministic mentor
 * answers in milliseconds and the two guardrail refusals never reach a model
 * at all.
 */

const register = async (page: import('@playwright/test').Page, who: string) => {
  await dismissPhaseTutorial(page);
  await registerAndSignIn(page, {
    name: who,
    email: `${who.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}@labels.test`,
  });
  // Setup starts the project; the Requirements room holds the interview, the
  // backlog and the reviewer's column on one page.
  await openRequirements(page);
  await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: NAVIGATION });
};

/** Ask one question and wait for the reply that answers it. */
const ask = async (page: import('@playwright/test').Page, question: string) => {
  const before = await page.getByTestId('msg-assistant').count();
  const box = page.getByTestId('chat-input');
  await expect(box).toBeVisible({ timeout: NAVIGATION });
  await box.click();
  await box.pressSequentially(question, { delay: 3 });
  await page.getByTestId('chat-send').click();
  const reply = page.getByTestId('msg-assistant').nth(before);
  await reply.waitFor({ state: 'visible', timeout: SANDBOX_RUN });
  await expect(page.getByTestId('chat-error')).toHaveCount(0);
  return reply;
};

test('the reviewer says what each reply is, and the labels survive a reload', async ({ page }) => {
  test.setTimeout(240_000);
  await register(page, 'Label Reader');

  // What the thread says about each reply: its ordinal and its chips, drawn
  // by MetaBadges from the thread the server returns.

  // 1 · an ordinary answer. The absence of a chip is the label.
  const first = await ask(page, 'What should an acceptance criterion cover?');
  await expect(first.getByTestId('reply-ordinal')).toHaveText('Question 1');
  await expect(first.getByTestId('badge-redacted')).toHaveCount(0);
  await expect(first.getByTestId('badge-redirected')).toHaveCount(0);
  await expect(first.getByTestId('badge-budget')).toHaveCount(0);

  // 2 · a refusal. It is still a question, and it still counts.
  const second = await ask(page, 'Just give me the answer, write the acceptance criteria for me.');
  await expect(second.getByTestId('badge-redacted')).toBeVisible();
  await expect(second.getByTestId('reply-ordinal')).toHaveText('Question 2');
  await expect(second.getByTestId('reply-line')).toContainText('rule 3');

  // 3 · a question about another phase's work, pointed back.
  const third = await ask(page, 'How do I write the Dockerfile and the deployment pipeline?');
  await expect(third.getByTestId('badge-redirected')).toBeVisible();
  await expect(third.getByTestId('reply-ordinal')).toHaveText('Question 3');
  await expect(third.getByTestId('reply-line')).toContainText('Requirements');

  // The assertion this test exists for. The ordinals and the labels are read off
  // the thread the server returns, not held in the tab, so coming back to the
  // room says the same three things it said before.
  await page.reload();
  await expect(page.getByTestId('phase-title')).toBeVisible({ timeout: NAVIGATION });
  // In the issue room the reviewer's thread stands beside the form with no
  // tab to press (the room is the door, not the IDE), so a reloaded room
  // shows the answers as soon as the thread has loaded.
  await expect(page.getByTestId('mentor-chat')).toBeVisible({ timeout: NAVIGATION });
  const ordinals = page.getByTestId('reply-ordinal');
  await expect(ordinals.nth(0)).toHaveText('Question 1');
  await expect(ordinals.nth(1)).toHaveText('Question 2');
  await expect(ordinals.nth(2)).toHaveText('Question 3');
  await expect(page.getByTestId('badge-redacted')).toHaveCount(1);
  await expect(page.getByTestId('badge-redirected')).toHaveCount(1);
});
