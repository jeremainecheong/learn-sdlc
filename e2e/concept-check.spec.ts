import { expect, test } from '@playwright/test';
import { LEARNER_PASSWORD, dismissPhaseTutorial, signInTo } from './pw-fixtures';
import { INSTRUCTOR, PASSING_REQUIREMENTS, classWithLearnerByApi, passPhaseByApi } from './passing-work';
import { API, RUN_ID as RUN } from './support/env';

/**
 * The quick concept check before and after a phase, against the suite's own
 * stack and the API's concept-check routes.
 *
 *   1. A learner in a class opens the requirements room and is offered
 *      "Quick check before you start" as a card above the room: the room's
 *      controls still take clicks, and "Later" only puts it away until the
 *      next entry. "Take the quick check" opens the check; they answer
 *      every question, hand in and read their score (the answers and
 *      explanations wait for the after check).
 *   2. Back in the room, the offer is gone: the before check is taken.
 *   3. The phase is passed through the API; back in the room the learner is
 *      offered "What did you learn?", takes it and reads the explanations,
 *      so the class has one learner with both checks.
 *   4. The teacher opens the class's quiz results, switches to Learning gain
 *      and reads the requirements card: n = 1, with before and after.
 */


test('a learner takes the quick check before a phase, and the teacher sees learning gain', async ({ page, request, browser }) => {
  const who = { email: `concept-check-${RUN}@example.test`, password: LEARNER_PASSWORD, name: 'Concept Learner' };
  const { cohortId, learner, phases } = await classWithLearnerByApi(request, `Concept check ${RUN}`, who);
  const requirements = phases.find((phase) => phase.order === 1)!;

  /* 1. The offer, at the door of the requirements room. */
  await dismissPhaseTutorial(page);
  await signInTo(page, who.email, who.password, `/workspace/${requirements.id}`);
  const prompt = page.getByTestId('concept-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt.getByTestId('concept-prompt-title')).toHaveText('Quick check before you start');
  // One line, labelled "Optional" at every width; the sentence gives way first
  // where the header row is short, so it is read by its own test id (QuickCheck.tsx).
  await expect(prompt.getByTestId('concept-prompt-optional')).toHaveText('Optional');
  await expect(prompt.getByTestId('concept-prompt-optional')).toBeVisible();
  await expect(prompt.getByTestId('concept-prompt-body')).toHaveText('6 questions, not graded.');
  await expect(prompt.getByTestId('concept-prompt-start')).toHaveText('Take the quick check');
  await expect(prompt.getByTestId('concept-prompt-skip')).toHaveText('Later');
  // The offer is a card, not a modal: nothing lies over the room, and the
  // room's own controls take a real click (Playwright's hit test) while it shows.
  await expect(page.getByTestId('concept-prompt-backdrop')).toHaveCount(0);
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
  const roomControl = page.locator('main button:visible').first();
  await expect(roomControl).toBeVisible();
  await roomControl.click({ trial: true, timeout: 5_000 });
  await expect(prompt).toBeVisible();
  // Later puts it away for this visit; the next entry to the phase offers it again.
  await prompt.getByTestId('concept-prompt-skip').click();
  await expect(prompt).toHaveCount(0);
  await page.goto(`/workspace/${requirements.id}`);
  await expect(prompt.getByTestId('concept-prompt-title')).toHaveText('Quick check before you start');
  await prompt.getByTestId('concept-prompt-start').click();

  await page.waitForURL((url) => url.pathname === `/workspace/${requirements.id}/concept` && url.searchParams.get('kind') === 'before');
  await expect(page.getByTestId('concept-title')).toHaveText('Quick check before you start');
  // The room's card does not follow the learner onto the check's own page.
  await expect(page.getByTestId('concept-prompt')).toHaveCount(0);
  await page.getByTestId('concept-start').click();
  const paper = page.getByTestId('quiz-paper');
  await expect(paper).toBeVisible();
  const questions = paper.locator('fieldset');
  await expect(questions).toHaveCount(6);
  for (let at = 0; at < 6; at += 1) {
    await questions.nth(at).locator('input').first().check();
  }
  await page.getByTestId('quiz-hand-in').click();
  await expect(page.getByTestId('concept-score')).toHaveText(/^You got [0-6] of 6 right \(\d+%\)\.$/);
  // The before check answers with the score only: the after check asks the same ideas.
  await expect(page.getByTestId('concept-result').locator('li[data-testid^="concept-marked-"]')).toHaveCount(0);
  await expect(page.getByTestId('concept-answers-later')).toHaveText('The answers and explanations come with the check after this phase.');

  /* 2. Back to the phase: the before check is taken, so nothing is offered. */
  const status = page.waitForResponse((res) => res.url().includes(`/phases/${requirements.id}/concept-quizzes`));
  await page.getByTestId('concept-back-to-phase').click();
  await page.waitForURL((url) => url.pathname === `/workspace/${requirements.id}`);
  const slots = await (await status).json();
  expect(slots.before.status).toBe('taken');
  expect(slots.after.status).toBe('locked');
  await expect(page.getByTestId('concept-prompt')).toHaveCount(0);

  /* 3. Pass the phase through the API; the room then offers the after check, taken through the UI. */
  await passPhaseByApi(request, learner, phases, 1, PASSING_REQUIREMENTS);
  const after = await (await request.get(`${API}/phases/${requirements.id}/concept-quizzes`, { headers: learner.headers })).json();
  expect(after.after.status).toBe('open');
  await page.goto(`/workspace/${requirements.id}`);
  const afterPrompt = page.getByTestId('concept-prompt');
  await expect(afterPrompt.getByTestId('concept-prompt-title')).toHaveText('What did you learn?');
  await afterPrompt.getByTestId('concept-prompt-start').click();
  await page.waitForURL((url) => url.pathname === `/workspace/${requirements.id}/concept` && url.searchParams.get('kind') === 'after');
  await expect(page.getByTestId('concept-title')).toHaveText('What did you learn?');
  await page.getByTestId('concept-start').click();
  const afterPaper = page.getByTestId('quiz-paper');
  await expect(afterPaper).toBeVisible();
  const afterQuestions = afterPaper.locator('fieldset');
  await expect(afterQuestions).toHaveCount(6);
  for (let at = 0; at < 6; at += 1) {
    await afterQuestions.nth(at).locator('input').first().check();
  }
  await page.getByTestId('quiz-hand-in').click();
  await expect(page.getByTestId('concept-score')).toHaveText(/^You got [0-6] of 6 right \(\d+%\)\.$/);
  await expect(page.getByTestId('concept-result').locator('li[data-testid^="concept-marked-"]')).toHaveCount(6);
  await expect(page.getByTestId('concept-answers-later')).toHaveCount(0);

  /* 4. The teacher's quiz results page, Learning gain. */
  const staff = await browser.newContext();
  const teacher = await staff.newPage();
  await signInTo(teacher, INSTRUCTOR.email, INSTRUCTOR.password, '/teacher/class/quiz-results');
  await teacher.goto(`/teacher/class/quiz-results?class=${encodeURIComponent(cohortId)}`);
  await teacher.getByTestId('quiz-view-gain').click();
  await teacher.waitForURL((url) => url.searchParams.get('view') === 'gain');
  await expect(teacher.getByRole('heading', { name: 'Learning gain', level: 2 })).toBeVisible();
  const card = teacher.getByTestId('learning-gain-requirements');
  await expect(card).toBeVisible();
  await expect(teacher.getByTestId('learning-gain-n-requirements')).toHaveText(/Learners with both checks\s*1/);
  await expect(teacher.getByTestId('learning-gain-before-requirements')).toHaveText(/Before\s*\d+%/);
  await expect(teacher.getByTestId('learning-gain-after-requirements')).toHaveText(/After\s*\d+%/);
  await expect(card.locator('tbody tr')).toHaveCount(1);
  await expect(card.locator('tbody tr')).toContainText(who.name);
  await expect(teacher.getByTestId('learning-gain-download')).toHaveText('Download learning-gain CSV');
  await staff.close();
});
