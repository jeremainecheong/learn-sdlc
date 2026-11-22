import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { IMPLEMENTATION_ARTEFACT, SOLUTION_OVERDUE } from './fixtures';
import { dismissPhaseTutorial, signInAs, stripDoor } from './pw-fixtures';
import { PASSING_DESIGN, PASSING_REQUIREMENTS, enrolByApi, passPhaseByApi, registerByApi } from './passing-work';
import { testEmail } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * The post-gate reveal: the pack's own answer, beside what the
 * learner merged.
 *
 * Three things are only true in a browser and are therefore only provable here.
 * The door does not exist before the gate, not greyed, absent, and the room
 * behind it refuses on its own when the URL is typed. An identical file is a
 * first-class state rather than a broken diff, which matters because the
 * learner who got the answer right is exactly the learner this screen must not
 * insult. And the whole page has to be readable on a phone, where side by side
 * cannot fit and is not offered.
 *
 * The learner arrives through the API, the way `dossier.spec.ts`'s does: the
 * click path through three phases is `journey.spec.ts`'s job and takes minutes,
 * and what is under test here is the document those phases unlock.
 *
 * One of the four implementation files is the learner's own: the pack's answer
 * with two comment lines on top of it. The other three are the pack's answer
 * byte for byte, which is what actually happens to a learner who works the
 * phase properly, so the run covers both states without inventing either.
 */

const LEARNER = {
  name: 'Sol Reveal',
  email: testEmail(`e2e-solution-${Date.now()}`),
  password: 'Correct-Horse-9',
};

/** The learner's own note, which is the whole of the difference on this file. */
const MY_NOTE_1 = '// My own note: a task due today is not overdue yet.';
// The note also carries the mark the suite's assessor passes work on
// (e2e/ai-stub.cjs), so the three pack files stay byte for byte.
const MY_NOTE_2 = '// That boundary is the one the acceptance criteria argue about. E2E-PASS';
const MY_OVERDUE = `${MY_NOTE_1}\n${MY_NOTE_2}\n${SOLUTION_OVERDUE}`;

const MY_IMPLEMENTATION: Record<string, string> = {
  ...IMPLEMENTATION_ARTEFACT,
  'web/src/lib/overdue.ts': MY_OVERDUE,
};

let phases: { id: string; key: string; order: number }[] = [];
const phaseId = (key: string) => phases.find((p) => p.key === key)!.id;

/** A learner three phases in, through the API. */
async function seed(request: APIRequestContext): Promise<void> {
  // Registered with setup done, enrolled, and three phases passed with
  // complete, marked work, Implementation after a run (e2e/passing-work.ts).
  const learner = await registerByApi(request, LEARNER);
  phases = await enrolByApi(request, learner);
  const reflect = (order: number) => `Phase ${order}: the review changed how I would start this next time.`;
  phases = await passPhaseByApi(request, learner, phases, 1, PASSING_REQUIREMENTS, reflect(1));
  phases = await passPhaseByApi(request, learner, phases, 2, PASSING_DESIGN, reflect(2));
  phases = await passPhaseByApi(request, learner, phases, 3, MY_IMPLEMENTATION, reflect(3), 'Add the overdue report and keep due today out of it');
}

async function signIn(page: Page): Promise<void> {
  await dismissPhaseTutorial(page);
  await page.goto('/login');
  await signInAs(page, LEARNER.email, LEARNER.password);
  await page.waitForURL(/\/dashboard(\?|$)/, { timeout: UI_READY });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await seed(request);
});

test("a learner reads the pack's answer beside their own, and only after the gate", async ({
  page,
}) => {
  await signIn(page);

  /* ------- the door does not exist on a phase whose gate is not in -------- */
  // The doors are on each phase's own document page (the pull request,
  // the kill matrix, the change request); there is no phases page carrying
  // them. Steps past the seed are adapted from the code and unverified on
  // a host that cannot run learner code.
  await page.goto(`/workspace/${phaseId('testing')}/matrix`);
  await expect(page.getByTestId('matrix-page')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('solution-open')).toHaveCount(0);

  // And the room behind it refuses on its own, not just the door.
  await page.goto(`/workspace/${phaseId('testing')}/solution`);
  await expect(page.getByTestId('solution-locked')).toBeVisible();

  /* --------------------- the door on the passed phase --------------------- */
  await page.goto(`/workspace/${phaseId('implementation')}/pr`);
  await expect(page.getByTestId('pr-title')).toBeVisible({ timeout: UI_READY });
  // The pull request is drawn in the workspace's frame, whose header keeps the reference solution's door inside
  // its Details (as the workspace keeps it in More): the door is opened first.
  await (await stripDoor(page, 'solution-open')).click();

  await expect(page.getByTestId('solution-title')).toHaveText('Reference solution');
  await expect(page.getByTestId('solution-standing')).toContainText('You passed Implementation');
  await expect(page.getByTestId('solution-summary')).toBeVisible();

  /* ------------------- an identical file, and a changed one --------------- */
  await expect(page.getByTestId('solution-identical-api/repository/tasks.py')).toContainText(
    'the same way, line for line',
  );

  const diff = page.getByTestId('solution-diff-web/src/lib/overdue.ts');
  await expect(diff).toBeVisible();
  // The learner's two comment lines are the whole of the difference, and the
  // legend says a removed line is theirs, so they are on the removed side.
  await expect(diff).toContainText(MY_NOTE_1);
  await expect(page.getByTestId('solution-file-web/src/lib/overdue.ts')).toContainText(
    'Removed lines are yours.',
  );

  /* ------------------------------ side by side ---------------------------- */
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId('solution-view-split')).toBeVisible();
  await page.getByTestId('solution-view-split').click();
  await expect(diff).toContainText('Yours');
  await expect(diff).toContainText("The pack's");

  /* -------------------------------- on a phone ---------------------------- */
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('solution-view-split')).toHaveCount(0);
  await expect(page.getByTestId('solution-title')).toBeVisible();
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement!;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, 'the page itself never scrolls sideways').toBeLessThanOrEqual(1);

  // The page draws no line recording that the model answer was read.
  await page.setViewportSize({ width: 1280, height: 900 });

  /* --------------- a passed phase the pack answers nothing for ------------ */
  await page.goto(`/workspace/${phaseId('requirements')}/solution`);
  await expect(page.getByTestId('solution-empty-prose')).toContainText(
    'no model answer to hold yours against',
  );
});
