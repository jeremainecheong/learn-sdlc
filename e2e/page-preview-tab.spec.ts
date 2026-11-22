import { mkdirSync } from 'fs';
import * as path from 'path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { INSTRUCTOR } from './passing-work';
import { LEARNER_PASSWORD, dismissPhaseTutorial, signInAs, skipCoachMarks, skipConceptChecks } from './pw-fixtures';
import { chooseImplementationView, openFile, writeFile } from './preview-helpers';
import { writeDeepReceiptSeam } from './upload-helpers';
import { apiOk, useApiContext } from './support/api';
import {
  deadlineBadgeArchive,
  doneBox,
  expectBadges,
  expectPagePreview,
  learnerOverdueHelper,
  OVERDUE_HELPER,
  PAGE_FRAME,
  PAGE_PREVIEW_LABEL,
} from './support/deadline-badge';
import { assertLoopbackApi, RUN, testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The uploaded project's Page preview opens in a new tab.
 *
 * A teacher uploads the Deadline badge pack (as page-preview-deadline-badge.spec.ts
 * does), publishes and assigns it; a learner joins. Before the learner's fix a
 * new tab shows Yesterday without a badge; the workspace is untouched by
 * opening it; the first tab does not follow the editor, even after a reload; a
 * second tab opened right after the edit (before the 0.7 s autosave and the
 * inline page's rebuild) shows the badge; in Maintenance after the guard, Done
 * takes the badge away and clearing it brings it back. The tab's frame runs
 * scripts only and cannot reach the app's storage or cookies.
 *
 * The pack and the learner's work are tracked fixtures (e2e/support/deadline-badge.ts).
 * E2E_PAGE_PREVIEW_SHOTS names a folder for the stills (page
 * only: no address bar, no account name).
 */

test.describe.configure({ mode: 'serial' });

assertLoopbackApi(__filename);

const api = useApiContext();
const ok = (method: string, route: string, headers: Record<string, string>, data?: unknown) => apiOk(api(), method, route, headers, data);

const TAB_EMPTY = 'Nothing to show here. Open the page preview in your workspace and press Open in a new tab.';
const SNAPSHOT = /^Snapshot of the code in your editor at \d{2}:\d{2}:\d{2}\. This tab does not update: to see later changes, go back to your workspace and press Open in a new tab again\.$/;
const SHOTS = process.env.E2E_PAGE_PREVIEW_SHOTS || '';

async function still(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Presses Open in a new tab in the workspace and returns the new tab once it has drawn. */
async function openTab(context: BrowserContext, page: Page): Promise<Page> {
  const [tab] = await Promise.all([context.waitForEvent('page'), page.getByTestId('page-preview-open').click()]);
  await tab.waitForLoadState('domcontentloaded');
  await expect(tab.getByTestId('page-preview-tab')).toBeVisible({ timeout: NAVIGATION });
  await expect(tab.getByTestId('page-preview-tab-label')).toHaveText(PAGE_PREVIEW_LABEL);
  await expect(tab.getByTestId('page-preview-tab-snapshot')).toHaveText(SNAPSHOT);
  await expect(tab.getByTestId('page-preview-frame')).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(tab.getByTestId('page-preview-frame')).toHaveAttribute('title', 'Your page, running in the browser');
  await expect(tab.frameLocator(PAGE_FRAME).getByTestId('preview-demo-date')).toBeVisible({ timeout: UI_READY });
  await expect(tab.getByTestId('page-preview-errors')).toHaveCount(0);
  await expect(tab.getByTestId('page-preview-timeout')).toHaveCount(0);
  await expect(tab).toHaveTitle(/^Page preview — /);
  return tab;
}

const takenAt = async (tab: Page) => Date.parse((await tab.getByTestId('page-preview-tab-snapshot').getAttribute('data-taken-at')) || '');

test('an empty tab says it has nothing to show', async ({ page }) => {
  await page.goto('/page-preview#nothinghere');
  await expect(page.getByTestId('page-preview-tab-empty')).toHaveText(TAB_EMPTY);
  await expect(page.getByTestId('page-preview-frame')).toHaveCount(0);
});

test('the Deadline badge page opens in a new tab: a snapshot of the editor, isolated, before and after the fix', async ({ page, context }) => {
  test.setTimeout(600_000);
  await skipConceptChecks(page);

  const login = await ok('POST', '/auth/login', {}, { email: INSTRUCTOR.email, password: INSTRUCTOR.password });
  const staff = { authorization: `Bearer ${login.token}` };
  const made = await ok('POST', '/instructor/projects/upload', staff, { title: `Deadline badge ${RUN}`, archiveBase64: deadlineBadgeArchive().toString('base64') });
  const at = `/instructor/projects/${made.projectId}/versions/${made.versionId}`;
  const draft = await ok('GET', at, staff);
  await ok('POST', `${at}/validate`, staff);
  writeDeepReceiptSeam(made.versionId);
  await ok('POST', `${at}/validate`, staff);
  const published = await ok('POST', `${at}/publish`, staff, { version: '1.0.0', notes: 'The new-tab proof publishes Deadline badge.' });
  const cohort = await ok('POST', '/instructor/cohorts', staff, { name: `Deadline tab class ${RUN}` });
  await ok('PUT', `/instructor/cohorts/${cohort.id}/project`, staff, { projectVersionId: published.versionId, reason: 'The new-tab class works on Deadline badge.' });

  const email = testEmail(`deadline-tab-${RUN}`);
  await ok('POST', '/auth/register', {}, { email, password: LEARNER_PASSWORD, displayName: `Dana Deadline ${RUN}` });
  const lh = { authorization: `Bearer ${(await ok('POST', '/auth/login', {}, { email, password: LEARNER_PASSWORD })).token}` };
  const me = await ok('GET', '/auth/me', lh);
  await ok('POST', '/enrollments/join', lh, { code: cohort.joinCode });
  await ok('POST', '/enrollments', lh, { projectSlug: draft.slug });
  await ok('PATCH', '/account/profile', lh, { displayName: `Dana Deadline ${RUN}`, onboardingCompleted: true, baseVersion: me.profileVersion || 0 });
  const mine = await ok('GET', '/enrollments/mine', lh);
  expect(mine.projectSlug, 'enrolled on the uploaded project').toBe(draft.slug);
  const phase = (key: string) => (mine.phases as { key: string; id: string }[]).find((one) => one.key === key)!;
  for (const key of ['implementation', 'maintenance']) {
    await ok('POST', `/instructor/learners/${me.id}/phases/${phase(key).id}/override`, staff, {
      action: 'reopen',
      reason: 'Browser proof: opened for the page preview tab only; no Pass is seeded.',
    });
  }

  await skipCoachMarks(page);
  await dismissPhaseTutorial(page);
  await signInAs(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });

  // 1. Before the learner's fix: the new tab draws three rows and no badge.
  await page.goto(`/workspace/${phase('implementation').id}`);
  await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: NAVIGATION });
  await openFile(page, OVERDUE_HELPER);
  await chooseImplementationView(page, 'Split');
  await expectPagePreview(page);
  await expectBadges(page, []);
  const open = page.getByTestId('page-preview-open');
  await expect(open).toHaveText('Open in a new tab');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  const workspaceUrl = page.url();
  const editorBefore = await editorText(page);
  const first = await openTab(context, page);
  await expectBadges(first, []);
  await still(first, '1-before-fix-new-tab');

  // 2. The workspace is untouched by opening: same address, same editor text, no pending proposal.
  expect(page.url()).toBe(workspaceUrl);
  expect(await editorText(page)).toBe(editorBefore);
  await expect(page.getByTestId('agent-proposal')).toHaveCount(0);

  // 5. Isolation: scripts only, an opaque origin, the app's storage and cookies out of reach.
  const handle = await first.getByTestId('page-preview-frame').elementHandle();
  const inside = await handle!.contentFrame();
  const probe = await inside!.evaluate(() => {
    const out: Record<string, string> = { origin: String(window.origin) };
    try { out.parentStorage = String(window.parent.localStorage.length); } catch (e) { out.parentStorage = `threw ${(e as Error).name}`; }
    try { out.cookie = JSON.stringify(document.cookie); } catch (e) { out.cookie = `threw ${(e as Error).name}`; }
    try { out.ownStorage = String(window.localStorage.length); } catch (e) { out.ownStorage = `threw ${(e as Error).name}`; }
    return out;
  });
  expect(probe.origin).toBe('null');
  expect(probe.parentStorage).toMatch(/^threw /);
  expect(probe.cookie).toMatch(/^threw |^""$/);
  expect(probe.ownStorage).toMatch(/^threw /);
  test.info().annotations.push({ type: 'frame probe', description: JSON.stringify(probe) });

  // 3. The fix goes into the editor and the link is pressed at once: before the
  // 0.7 s autosave (the save word still not "Saved") and before the inline page
  // rebuilds. The second tab shows the badge: the link hands over what the
  // editor shows, not the saved copy.
  const firstAt = await takenAt(first);
  const nonceBefore = await page.getByTestId('page-preview-frame').getAttribute('data-nonce');
  const fix = learnerOverdueHelper('implementation');
  const t0 = Date.now();
  const editAt = await page.evaluate((value) => {
    const model = (window as any).monaco.editor.getModels().find((m: any) => m.uri.toString().endsWith('overdue.ts'));
    // An edit, not setValue (as preview-helpers' setEditor), without waiting for the save.
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    return Date.now();
  }, fix);
  await expect(page.getByTestId('save-state'), 'not yet saved when the link is pressed').not.toHaveText('Saved', { timeout: 600 });
  const saveAtClick = (await page.getByTestId('save-state').textContent())?.trim();
  const nonceAtClick = await page.getByTestId('page-preview-frame').getAttribute('data-nonce');
  const [second, clickedAt] = await Promise.all([
    context.waitForEvent('page'),
    page.getByTestId('page-preview-open').click().then(() => Date.now()),
  ]);
  await expect(second.getByTestId('page-preview-tab')).toBeVisible({ timeout: NAVIGATION });
  const elapsed = (await takenAt(second)) - editAt;
  test.info().annotations.push({
    type: 'edit to open',
    description: `edit to stash ${elapsed} ms (browser clock); edit to click done ${clickedAt - t0} ms (runner); save word at the press "${saveAtClick}"; inline page rebuilt before the press: ${nonceAtClick !== nonceBefore}`,
  });
  expect(elapsed, 'the link was pressed within the 0.7 s autosave window').toBeLessThan(700);
  expect(saveAtClick, 'the edit was not yet saved at the press').not.toBe('Saved');
  expect(nonceAtClick, 'the inline page had not rebuilt yet when the link was pressed').toBe(nonceBefore);
  await expect(second.getByTestId('page-preview-tab-snapshot')).toHaveText(SNAPSHOT);
  await expectBadges(second, ['Yesterday']);
  expect(await takenAt(second)).toBeGreaterThan(firstAt);
  await still(second, '3-after-fix-second-tab');
  // the first tab did not follow the editor, and a reload keeps its snapshot and time
  await expectBadges(first, []);
  await first.reload();
  await expect(first.getByTestId('page-preview-tab-snapshot')).toHaveText(SNAPSHOT);
  expect(await takenAt(first)).toBe(firstAt);
  await expectBadges(first, []);
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
  await expectBadges(page, ['Yesterday']);

  // 4. Maintenance after the guard: the tab's Done takes the badge away, clearing it brings it back.
  await page.goto(`/workspace/${phase('maintenance').id}`);
  await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: NAVIGATION });
  const room = page.locator('nav[aria-label="Phase working area"]');
  await room.getByRole('button', { name: 'Edit files', exact: true }).click();
  await writeFile(page, OVERDUE_HELPER, learnerOverdueHelper('maintenance'));
  await room.getByRole('button', { name: 'Page preview', exact: true }).click();
  await expectPagePreview(page);
  const third = await openTab(context, page);
  await expectBadges(third, ['Yesterday']);
  await doneBox(third, 'Yesterday').check();
  await expectBadges(third, []);
  await still(third, '4a-maintenance-tab-done-ticked');
  await doneBox(third, 'Yesterday').uncheck();
  await expectBadges(third, ['Yesterday']);
  await still(third, '4b-maintenance-tab-done-cleared');
  // Reload re-runs the same snapshot: the page's own state (the tick) starts again
  await doneBox(third, 'Yesterday').check();
  await expectBadges(third, []);
  await third.getByTestId('page-preview-reload').click();
  await expectBadges(third, ['Yesterday']);
});

async function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const models = (window as any).monaco?.editor?.getModels() ?? [];
    return models.map((m: any) => `${m.uri.toString()}\n${m.getValue()}`).join('\n---\n');
  });
}
