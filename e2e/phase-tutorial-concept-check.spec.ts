import { expect, test } from '@playwright/test';
import { LEARNER_PASSWORD, signInTo, skipCoachMarks } from './pw-fixtures';
import { PASSING_REQUIREMENTS, classWithLearnerByApi, passPhaseByApi } from './passing-work';
import { API, RUN_ID as RUN } from './support/env';

/**
 * The phase tutorial and the quick concept check, against the suite's own
 * stack.
 *
 *   1. On first entry to a phase the phase tutorial opens and the quick
 *      check's card waits: the dialog is open and the card is not shown.
 *      After Skip the card shows, from the status already read.
 *   2. Once work for the phase is handed in, the before check closes: the
 *      status route says `closed`, a start is refused with 409
 *      `concept_quiz_closed`, the room offers the after check instead, and
 *      the before check's own page says why rather than offering Start.
 */


test('on first entry the phase tutorial goes first, and the quick-check card shows after Skip', async ({ page, request }) => {
  const who = { email: `concept-tour-${RUN}@example.test`, password: LEARNER_PASSWORD, name: 'Tour Learner' };
  const { phases } = await classWithLearnerByApi(request, `RG concept tour ${RUN}`, who);
  const requirements = phases.find((phase) => phase.order === 1)!;

  // The account-wide first-run tour is put away; the phase tutorial is not.
  await skipCoachMarks(page);
  let statusReads = 0;
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().includes(`/phases/${requirements.id}/concept-quizzes`)) statusReads += 1;
  });
  const status = page.waitForResponse((res) => res.url().includes(`/phases/${requirements.id}/concept-quizzes`));
  await signInTo(page, who.email, who.password, `/workspace/${requirements.id}`);
  const slots = await (await status).json();
  expect(slots.before.status).toBe('open');

  const tutorial = page.getByTestId('coach');
  await expect(tutorial).toBeVisible();
  await expect(tutorial).toHaveAttribute('aria-label', 'Requirements tutorial');
  // The status has answered with an open before check, and the card still waits.
  const prompt = page.getByTestId('concept-prompt');
  await expect(prompt).not.toBeVisible();
  await page.waitForTimeout(750);
  await expect(prompt).toHaveCount(0);
  await expect(tutorial).toBeVisible();

  const readsBeforeSkip = statusReads;
  await page.getByTestId('coach-skip').click();
  await expect(tutorial).toHaveCount(0);
  await expect(prompt).toBeVisible();
  await expect(prompt.getByTestId('concept-prompt-title')).toHaveText('Quick check before you start');
  // Shown from the status already read: Skip asks nothing new.
  expect(statusReads).toBe(readsBeforeSkip);

  // The next entry: the tutorial is seen, so the card shows at once.
  await page.goto(`/workspace/${requirements.id}`);
  await expect(prompt.getByTestId('concept-prompt-title')).toHaveText('Quick check before you start');
  await expect(tutorial).toHaveCount(0);
});

test('the before check closes once work for the phase is handed in', async ({ page, request }) => {
  const who = { email: `concept-closed-${RUN}@example.test`, password: LEARNER_PASSWORD, name: 'Closed Learner' };
  const { learner, phases } = await classWithLearnerByApi(request, `RG concept closed ${RUN}`, who);
  const requirements = phases.find((phase) => phase.order === 1)!;
  const slotsNow = async () =>
    (await request.get(`${API}/phases/${requirements.id}/concept-quizzes`, { headers: learner.headers })).json();

  expect((await slotsNow()).before.status).toBe('open');
  await passPhaseByApi(request, learner, phases, 1, PASSING_REQUIREMENTS);
  const slots = await slotsNow();
  expect(slots.before).toMatchObject({ status: 'closed', scorePct: null });
  expect(slots.after.status).toBe('open');

  const refused = await request.post(`${API}/phases/${requirements.id}/tasks/concept-before/quiz/attempts`, {
    headers: learner.headers,
  });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({
    error: 'concept_quiz_closed',
    message: 'The before check closes once you have handed in work for this phase.',
  });

  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('lsdlc_coach', 'done');
      const read = Storage.prototype.getItem;
      Storage.prototype.getItem = function (this: Storage, key: string) {
        if (typeof key === 'string' && key.startsWith('lsdlc_phase_tutorial_v1:')) return 'seen';
        return read.call(this, key);
      };
    } catch {
      // no storage
    }
  });
  await signInTo(page, who.email, who.password, `/workspace/${requirements.id}`);
  // The room offers the after check, never the closed before check.
  await expect(page.getByTestId('concept-prompt-title')).toHaveText('What did you learn?');

  await page.goto(`/workspace/${requirements.id}/concept?kind=before`);
  await expect(page.getByTestId('concept-closed')).toHaveText('The before check closes once you have handed in work for this phase.');
  await expect(page.getByTestId('concept-start')).toHaveCount(0);
  await expect(page.getByTestId('concept-back-to-phase')).toBeVisible();
});
