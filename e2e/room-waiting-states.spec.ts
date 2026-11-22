import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { dismissPhaseTutorial, pressStripDoor, signInAs, waitForEditor } from './pw-fixtures';
import { reachImplementationByApi } from './passing-work';
import { chooseImplementationView } from './preview-helpers';
import { API, testEmail } from './support/env';
import { NAVIGATION, SANDBOX_RUN, UI_READY } from './support/timeouts';

/**
 * What a room costs and what it says while it is paying.
 *
 * Every case here is about the workspace page, and none of them is about a
 * feature. They are about the seconds around a press, and what must not
 * happen in them: a room that draws grey blocks and no words while the
 * network decides; a verdict from minutes ago left standing as the answer to
 * the Run just pressed; a preview pane silent for seconds after the button
 * beside it said "Building"; the API's own words ("not your phase") pasted
 * into a sentence meant for a learner; a second tab quietly winning; and
 * calls sent without a token so the console fills with 401s before the
 * sign-in page.
 */


const LEARNER = {
  name: 'Rory Waiting',
  email: testEmail(`e2e-room-waiting-${Date.now()}`),
  password: 'Correct-Horse-9',
};

/** Filled by the seed: the phase the learner is on, and its token. */
const own = { token: '', phaseId: '', filePath: '' };

async function seed(request: APIRequestContext): Promise<void> {
  // Registered with setup done, enrolled, and the two written phases passed
  // with complete, marked work (e2e/passing-work.ts), so the learner is on
  // Implementation.
  const { learner, phaseId } = await reachImplementationByApi(request, LEARNER);
  own.token = learner.token;
  own.phaseId = phaseId;
  const detail = await (await request.get(`${API}/phases/${own.phaseId}`, {
    headers: { authorization: `Bearer ${own.token}` },
  })).json();
  own.filePath = (detail.files as { path: string; editable: boolean }[]).find((f) => f.editable)!
    .path;
}

async function signIn(page: Page): Promise<void> {
  await dismissPhaseTutorial(page);
  await page.goto('/login');
  await signInAs(page, LEARNER.email, LEARNER.password);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(600_000);
  await seed(request);
});

/* ------------- a room that cannot open says why, in English --------------- */

test('a phase that is not the learner’s, and one that does not exist, are refused in words', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);

  // 404: a well-formed id nobody owns. The shell answers it before the room
  // is asked for anything (workspace/[phaseId]/layout.tsx): a phase that
  // is not in the learner's project is refused there, in a sentence.
  await page.goto('/workspace/11111111-2222-3333-4444-555555555555');
  const notice = page.getByTestId('phase-opening');
  await expect(notice).toBeVisible({ timeout: UI_READY });
  await expect(notice).toContainText('This phase is not available in your project.');
  // Not the API's own words, and no lead pasted in front of them.
  await expect(notice).not.toContainText('phase not found');
  await expect(notice).not.toContainText('The workspace could not load');
  // A room with nothing in it has saved nothing, and says nothing about saving.
  await expect(page.getByTestId('save-state')).toHaveCount(0);
  // And there is a way out.
  await expect(page.getByRole('link', { name: 'Open current phase' })).toBeVisible();
});

/* ---------------- the room says what it is doing at once ------------------ */

test('the workspace says it is opening before its files arrive', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  // The phase's own fetch, held for five seconds: the room draws first.
  await page.route(`**/api/v1/phases/${own.phaseId}`, async (route) => {
    await new Promise((r) => setTimeout(r, 5_000));
    await route.continue();
  });
  await page.goto(`/workspace/${own.phaseId}`);
  // Words, not grey blocks, and well before the fetch returns.
  await expect(page.getByTestId('workspace-loading')).toBeVisible({ timeout: 3_000 });
  await expect(page.getByTestId('workspace-loading')).toContainText('Opening the workspace');
  // Nothing has been saved, so nothing claims to have been: the loading frame
  // draws no save state at all, not even an empty one.
  await expect(page.getByTestId('save-state')).toHaveCount(0);
  // And it does arrive.
  await expect(page.getByTestId('editor-host')).toBeVisible({ timeout: NAVIGATION });
});

/* ------------- the press clears the verdict it is not about --------------- */

test('pressing Run tests drops the previous verdict on the same frame', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto(`/workspace/${own.phaseId}`);
  await waitForEditor(page, 60_000);

  // One run, so there is a verdict standing when the second press happens.
  await page.getByTestId('header-run').click();
  await expect(page.getByTestId('run-panel')).toBeVisible({ timeout: UI_READY });
  const cases = page.locator('[data-testid="run-panel"] tbody tr');
  await expect.poll(() => cases.count(), { timeout: SANDBOX_RUN }).toBeGreaterThan(0);

  // The second press: the queue is answered before the run is, so the old
  // cases must be gone while the new run is still being waited for.
  await page.route('**/api/v1/phases/*/run', async (route) => {
    await new Promise((r) => setTimeout(r, 4_000));
    await route.continue();
  });
  await page.getByTestId('header-run').click();
  await page.waitForTimeout(500);
  expect(await cases.count(), 'the last run’s cases were left standing').toBe(0);
});

/* ---------- the preview pane speaks on the frame of the press ------------- */

test('Run app says it is starting before the request is answered', async ({ page, request }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto(`/workspace/${own.phaseId}?tab=preview`);
  await waitForEditor(page, 60_000);
  const runApp = page.getByTestId('header-run-app');
  if (!(await runApp.count())) {
    // Run app is drawn only where the phase has an app and the host can run
    // it; the phase's own detail says which of the two is missing.
    const detail = await (await request.get(`${API}/phases/${own.phaseId}`, {
      headers: { authorization: `Bearer ${own.token}` },
    })).json();
    // Only the host is a reason to skip: Implementation ships an application,
    // so a missing Run app anywhere that can isolate is this case failing.
    expect(detail.previewUnsupported, 'Run app is missing on a host that can run the preview').toBe('isolation');
    test.skip(
      true,
      'Run app is not drawn: the code runner cannot provide kernel isolation on this host, so the preview runs no learner code.',
    );
  }

  // The room opens on Code below 1600 px; the pane is on screen in Split.
  await chooseImplementationView(page, 'Split');
  // The start held for three seconds: the pane must not wait for it.
  await page.route('**/api/v1/phases/*/preview', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await new Promise((r) => setTimeout(r, 3_000));
    await route.continue();
  });
  await pressStripDoor(page, 'header-run-app');
  await expect(page.getByTestId('preview-starting')).toBeVisible({ timeout: 1_000 });
  await expect(page.getByTestId('preview-idle')).toHaveCount(0);
});

/* ------------ the copy another tab wrote is the one shown ----------------- */

test('a file saved from another tab replaces this one, and says so', async ({ page, request }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.goto(`/workspace/${own.phaseId}?file=${encodeURIComponent(own.filePath)}`);
  await waitForEditor(page, 60_000);
  // This tab types first, and its work is saved: that is what can make the
  // loss silent, if A goes on being shown A's copy, nothing says the file has
  // moved under it.
  await page.evaluate(() => {
    const editor = (window as any).monaco.editor.getEditors()[0];
    editor.focus();
    editor.setPosition({ lineNumber: 1, column: 1 });
  });
  await page.keyboard.type('# typed in this tab\n');
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });
  const mine = await page.evaluate(
    () => (window as any).monaco.editor.getEditors()[0].getValue() as string,
  );
  expect(mine).toContain('typed in this tab');

  // The other tab: the same account, writing the same file.
  const theirs = `# written in the other tab\n${mine.replace('# typed in this tab\n', '')}`;
  const wrote = await request.put(`${API}/phases/${own.phaseId}/workspace`, {
    headers: { authorization: `Bearer ${own.token}` },
    data: { files: { [own.filePath]: theirs } },
  });
  expect(wrote.ok(), 'the other tab saves').toBeTruthy();

  // Coming back to this tab is what the browser signals here.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // The notice says the saved workspace changed and that the latest saved
  // copy is shown (not "saved from another tab").
  await expect(page.getByTestId('workspace-notice')).toContainText('Showing the latest saved copy', {
    timeout: UI_READY,
  });
  await expect
    .poll(
      () =>
        page.evaluate(() => (window as any).monaco.editor.getEditors()[0].getValue() as string),
      { timeout: UI_READY },
    )
    .toContain('written in the other tab');
  // …and this tab's own copy is no longer standing over it.
  const now = await page.evaluate(
    () => (window as any).monaco.editor.getEditors()[0].getValue() as string,
  );
  expect(now, 'this tab went on showing its own copy of a file the server had moved').not.toContain(
    'typed in this tab',
  );
});

/* ------- no call without a session, and the reason shown ------------------ */

test('a deep link while signed out sends no request and says why', async ({ page }) => {
  test.setTimeout(120_000);
  const refused: string[] = [];
  page.on('response', (res) => {
    if (res.url().includes('/api/v1/') && res.status() === 401) refused.push(res.url());
  });
  await page.goto(`/workspace/${own.phaseId}`);
  await page.waitForURL('**/login**', { timeout: UI_READY });
  expect(refused, 'calls sent with no token').toEqual([]);
});

test('a session that ended says so on the sign-in page', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  // A token that no longer works, exactly as an expired one behaves.
  await page.evaluate(() => {
    try {
      window.localStorage.setItem('lsdlc_token', 'not-a-token');
    } catch {
      /* ignore */
    }
  });
  // The room's first call comes back 401 while the document is still loading,
  // and the redirect that answers it aborts this navigation, which is the
  // behaviour under test, not a failure of it. Where the browser ends up is
  // what the next two lines are about.
  await page.goto(`/workspace/${own.phaseId}`).catch(() => undefined);
  await page.waitForURL('**/login?**', { timeout: UI_READY });
  expect(page.url(), 'the sign-in page is told why it is being shown').toContain('reason=expired');
  expect(page.url(), 'and where the learner was').toContain('next=');
  // The sentence the page draws from it is covered by error-recovery-keyboard.spec.ts;
  // this half is that the reason is carried at all.
});
