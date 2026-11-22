import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createUnlockedEditor, fixtureAdminHeaders, fixtureApi as API, type EditorFixture } from './fixtures/unlocked-editor';
import { dismissPhaseTutorial, signInAs, continueMyProject } from './pw-fixtures';
import { UI_READY } from './support/timeouts';

/**
 * Requirements opens its persistent interview/backlog workspace. Other
 * phases keep their case file page at its address, with Go to the workspace;
 * no door opens it, and its words are in each room's brief panel under
 * "Mission and review criteria" (in the Design room, inside its one fold, "Full
 * project brief and deliverables"). Later phases below
 * are explicitly unlocked only for isolated UI fixtures; no Pass is seeded.
 */
let learner: EditorFixture | null = null;
async function ensureLearner(request: APIRequestContext): Promise<EditorFixture> {
  if (learner) return learner;
  const fixture = await createUnlockedEditor(request, 'phase-briefs');
  const staff = await fixtureAdminHeaders(request);
  for (const phase of fixture.phases.filter(phase => [2, 4, 5, 6].includes(phase.order))) {
    const opened = await request.post(`${API}/instructor/learners/${fixture.userId}/phases/${phase.id}/override`, { headers: staff, data: { action: 'reopen', reason: 'Isolated case-file and route rendering fixture; no learned Pass or progression is being asserted.' } });
    expect(opened.ok(), `phase${phase.order} opens for this isolated UI fixture`).toBe(true);
  }
  learner = fixture;
  return fixture;
}
async function signIn(page: Page, who: { email: string; password: string }, destination = 'dashboard') {
  // The per-phase tutorial opens over a phase's first visit; it is not what
  // these walks are about.
  await dismissPhaseTutorial(page);
  await page.goto('/login');
  await signInAs(page, who.email, who.password);
  await page.waitForURL(`**/${destination}`, { timeout: UI_READY });
}
const phaseOf = (who: EditorFixture, order: number) => who.phases.find(phase => phase.order === order)!;
const roomOf = (phase: EditorFixture['phases'][number]) => `/workspace/${phase.id}${phase.order === 1 ? '/interview' : phase.order === 2 ? '/design' : phase.order === 6 ? '/change' : ''}`;
async function expectBrief(page: Page, phase: EditorFixture['phases'][number]) {
  await expect(page).toHaveURL(new RegExp(`/workspace/${phase.id}/brief$`));
  await expect(page.getByTestId('phase-title')).toHaveText(phase.title);
  const sections = page.getByRole('navigation', { name: 'Case file sections', exact: true });
  await sections.getByRole('button', { name: 'Your mission', exact: true }).click();
  expect(await page.getByTestId('brief-steps').locator(':scope > li').count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('brief-about')).toContainText('optional');
  await expect(page.getByTestId('brief-about').getByRole('link')).toHaveAttribute('href', `/learn/${phase.key}`);
  await sections.getByRole('button', { name: 'What you will produce', exact: true }).click();
  expect(await page.getByTestId('brief-deliverables').locator('.phase-case-files li').count()).toBeGreaterThan(0);
  await sections.getByRole('button', { name: 'Review criteria', exact: true }).click();
  await expect(page.getByTestId('brief-judged')).toContainText('Pass or Needs revision');
  await expect(page.getByTestId('brief-judged')).toContainText('Every required criterion');
  expect(await page.getByTestId('brief-judged').locator('.phase-case-criteria li').count()).toBeGreaterThan(0);
  await expect(page.getByTestId('brief-judged')).not.toContainText('70 of 100');
  await expect(page.getByTestId('go-to-workspace')).toBeVisible();
}

test('a new learner starts with the stakeholder interview, can open the backlog, and cannot enter a locked phase', async ({ page }) => {
  const who = { email: `e2e-brief-start-${Date.now()}@example.test`, password: 'Correct-Horse-9' };
  await page.goto('/register');
  await page.getByTestId('displayName').fill('Bea Begins');
  await page.getByTestId('email').fill(who.email);
  await page.getByTestId('password').fill(who.password);
  await page.getByTestId('register-submit').click();
  await page.waitForURL('**/login?registered=1');
  await signIn(page, who, 'onboarding');
  await page.getByRole('button', { name: 'Start learning', exact: true }).click();
  await page.waitForURL('**/dashboard');
  await continueMyProject(page);
  // The door a new learner's Requirements opens at is the interview itself.
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]+\/interview$/);
  await expect(page.getByRole('tab', { name: 'Stakeholder interview', exact: true })).toHaveAttribute('aria-selected', 'true');
  const phaseId = /\/workspace\/([^/]+)/.exec(new URL(page.url()).pathname)![1];
  await expect(page.getByTestId('interview-page')).toBeVisible();
  await expect(page.getByTestId('editor-host')).toHaveCount(0);
  await page.getByRole('tab', { name: 'My backlog', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${phaseId}/issue$`));
  await expect(page.getByRole('heading', { name: 'Requirements backlog', exact: true })).toBeVisible();
  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: 'Continue my project', exact: true })).toHaveAttribute('href', `/workspace/${phaseId}/interview`);
  const locked = await page.evaluate(async api => {
    const response = await fetch(`${api}/enrollments/mine?project=tasktrackr`, { headers: { authorization: `Bearer ${localStorage.getItem('lsdlc_token')}` } });
    const enrollment = await response.json(); return enrollment.phases.find((phase: { order: number }) => phase.order === 2).id as string;
  }, API);
  // A locked phase is answered by the shell before its brief is drawn now
  // (workspace/[phaseId]/layout.tsx).
  await page.goto(`/workspace/${locked}/brief`);
  await expect(page.getByTestId('phase-locked')).toContainText('Pass your current phase before opening Design.');
});

test('Requirements aliases retain the interview and case reference while the other five case files expose objectives, evidence and strict criteria', async ({ page, request }) => {
  const who = await ensureLearner(request); await signIn(page, who);
  const requirements = phaseOf(who, 1);
  for (const suffix of ['', '/interview', '/brief']) {
    await page.goto(`/workspace/${requirements.id}${suffix}`);
    await expect(page.getByRole('tab', { name: 'Stakeholder interview', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('interview-page')).toBeVisible();
    await expect(page.getByTestId('editor-host')).toHaveCount(0);
    const reveal = page.getByRole('button', { name: 'Show brief', exact: true }); if (await reveal.count()) await reveal.click();
    const brief = page.getByRole('complementary', { name: 'Requirements case file', exact: true });
    await brief.getByRole('button', { name: 'Brief', exact: true }).click();
    await brief.locator('summary').filter({ hasText: 'Full project brief and deliverables' }).click();
    await expect(brief).toContainText('US-4');
  }
  for (const phase of who.phases.filter(phase => phase.order > 1)) {
    await page.goto(`/workspace/${phase.id}/brief`); await expectBrief(page, phase);
    await page.getByTestId('go-to-workspace').click(); await expect(page).toHaveURL(roomOf(phase));
    await expect(page.getByTestId('phase-title')).toHaveText(phase.title);
    // The case file's words are in the room's brief panel too.
    await expect(page.getByTestId('phase-mission')).toHaveCount(1);
  }
});

test('Requirements keeps reference access beside both working areas and the project palette retains the case-file destination', async ({ page, request }) => {
  const who = await ensureLearner(request); await signIn(page, who); const first = phaseOf(who, 1);
  await page.goto(`/workspace/${first.id}/interview`);
  for (const name of ['My backlog', 'Stakeholder interview']) {
    await page.getByRole('tab', { name, exact: true }).click();
    const reveal = page.getByRole('button', { name: 'Show brief', exact: true }); if (await reveal.count()) await reveal.click();
    await expect(page.getByRole('complementary', { name: 'Requirements case file', exact: true })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Requirements workspace' })).toBeVisible();
  }
  await page.goto('/dashboard');
  await page.getByTestId('jump-to').click(); await page.getByTestId('palette-input').fill('brief');
  const destination = page.getByTestId('palette-row-0'); await expect(destination).toContainText('Brief'); await destination.click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${first.id}/brief$`));
  await expect(page.getByTestId('interview-page')).toBeVisible();
});

test('a submitted Design phase opens its working room in a fresh session while Requirements always starts at interview', async ({ page, request }) => {
  const who = await ensureLearner(request); const first = phaseOf(who, 1); const design = phaseOf(who, 2);
  const openPhaseDoor = async (name: string) => {
    await page.getByTestId('jump-to').click();
    await page.getByTestId('palette-input').fill(name);
    await page.getByRole('group', { name: 'Phases', exact: true }).getByRole('option', { name: new RegExp(name) }).click();
  };
  await signIn(page, who);
  await openPhaseDoor('Design');
  // The door opens the room before any submission too; no case file in front of it.
  await expect(page).toHaveURL(new RegExp(`/workspace/${design.id}/design$`));
  // Real configured grading is queued only for this isolated unfinished Design
  // fixture. Submission history changes its door; this test awards no Pass.
  const submitted = await request.post(`${API}/phases/${design.id}/submit`, { headers: { authorization: `Bearer ${who.token}` } });
  expect(submitted.ok()).toBe(true);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await signIn(page, who);
  await openPhaseDoor('Design');
  await expect(page).toHaveURL(new RegExp(`/workspace/${design.id}/design$`));
  await openPhaseDoor('Requirements');
  await expect(page).toHaveURL(new RegExp(`/workspace/${first.id}/interview$`));
});
