import { expect, test } from '@playwright/test';
import { INSTRUCTOR } from './passing-work';
import { LEARNER_PASSWORD, dismissPhaseTutorial, foldStripDetails, signInAs, stripDoor, skipCoachMarks, skipConceptChecks } from './pw-fixtures';
import { chooseImplementationView, reachImplementation } from './preview-helpers';
import { shelfArchive, writeDeepReceiptSeam } from './upload-helpers';
import { assertLoopbackApi, RUN } from './support/env';
import { apiOk, useApiContext } from './support/api';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * A student always sees a page.
 *
 *  1. An uploaded project (the `shelf` fixture) has no sandbox App preview. Its
 *     implementation room draws the page preview: the learner's visible page
 *     code (main.ts, ShelfPage.ts, lib/shelf.ts) run in a sandboxed frame,
 *     with `api/books` answered offline, and the shelf page's heading draws
 *     inside it.
 *  2. The reference project's implementation room keeps the sandbox App
 *     preview pane with Run app, and no page preview. Where the host cannot
 *     run the sandbox preview, the pane still says why, and the page preview
 *     draws the learner's page under it.
 *
 * No real AI, nothing printed that names an address, a token or an id.
 */

test.describe.configure({ mode: 'serial' });

assertLoopbackApi(__filename);
// Both pages here ask the API for their data (the shelf's books, TaskTrackr's lists) and neither project
// ships sample data, so the line says the page gets no data from it (pagePreviewLabel in preview/client/bundle.ts).
const LABEL = 'Page preview: your code running in the browser. Your API is not running here, so the page gets no data from it.';

const api = useApiContext();
const ok = (method: string, route: string, headers: Record<string, string>, data?: unknown) => apiOk(api(), method, route, headers, data);

test('1. an uploaded implementation room draws the shelf page in the page preview frame', async ({ page }) => {
  test.setTimeout(600_000);
  const login = await ok('POST', '/auth/login', {}, { email: INSTRUCTOR.email, password: INSTRUCTOR.password });
  const staff = { authorization: `Bearer ${login.token}` };

  const made = await ok('POST', '/instructor/projects/upload', staff, { title: `Preview Shelf ${RUN}`, archiveBase64: shelfArchive().toString('base64') });
  const at = `/instructor/projects/${made.projectId}/versions/${made.versionId}`;
  const draft = await ok('GET', at, staff);
  await ok('POST', `${at}/validate`, staff);
  writeDeepReceiptSeam(made.versionId);
  await ok('POST', `${at}/validate`, staff);
  const published = await ok('POST', `${at}/publish`, staff, { version: '1.0.0', notes: 'The page preview row publishes FIX-1.' });
  const cohort = await ok('POST', '/instructor/cohorts', staff, { name: `Preview class ${RUN}` });
  await ok('PUT', `/instructor/cohorts/${cohort.id}/project`, staff, { projectVersionId: published.versionId, reason: 'The page preview class works on the uploaded shelf.' });

  const email = `page-preview-${RUN}@example.test`;
  await ok('POST', '/auth/register', {}, { email, password: LEARNER_PASSWORD, displayName: `Pia Page ${RUN}` });
  const lh = { authorization: `Bearer ${(await ok('POST', '/auth/login', {}, { email, password: LEARNER_PASSWORD })).token}` };
  const me = await ok('GET', '/auth/me', lh);
  await ok('POST', '/enrollments/join', lh, { code: cohort.joinCode });
  await ok('POST', '/enrollments', lh, { projectSlug: draft.slug });
  await ok('PATCH', '/account/profile', lh, { displayName: `Pia Page ${RUN}`, onboardingCompleted: true, baseVersion: me.profileVersion || 0 });
  const mine = await ok('GET', '/enrollments/mine', lh);
  expect(mine.projectSlug, 'enrolled on the uploaded project').toBe(draft.slug);
  const implementation = (mine.phases as { key: string; id: string }[]).find((one) => one.key === 'implementation')!;
  await ok('POST', `/instructor/learners/${me.id}/phases/${implementation.id}/override`, staff, {
    action: 'reopen',
    reason: 'Browser proof: opened for the page preview only; no Pass is seeded.',
  });
  const detail = await ok('GET', `/phases/${implementation.id}`, lh);
  expect(detail.canPreview ?? false, 'the uploaded room has no sandbox App preview').toBe(false);

  await skipCoachMarks(page);
  await dismissPhaseTutorial(page);
  await signInAs(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
  await page.goto(`/workspace/${implementation.id}`);
  await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: NAVIGATION });
  // The room opens on Code below 1600 px; the page preview is one press away.
  await chooseImplementationView(page, 'Split');

  await expect(page.getByTestId('client-page-preview')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId('page-preview-label')).toContainText(LABEL);
  const frame = page.getByTestId('page-preview-frame');
  await expect(frame).toBeVisible({ timeout: NAVIGATION });
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  const shelf = page.frameLocator('[data-testid="page-preview-frame"]');
  await expect(shelf.getByRole('heading', { name: 'The shelf' })).toBeVisible({ timeout: UI_READY });
  await expect(shelf.getByText('The shelf is empty.')).toBeVisible();
  await expect(page.getByTestId('page-preview-timeout')).toHaveCount(0);
  await expect(page.getByTestId('page-preview-errors')).toHaveCount(0);
  // The sandbox App preview is not drawn for an uploaded project.
  await expect(page.getByTestId('preview-pane')).toHaveCount(0);
  await expect(page.getByTestId('header-run-app')).toHaveCount(0);
  await expect(page.locator('nav[aria-label="Implementation working area"]').getByRole('button', { name: 'Page preview' })).toBeVisible();
});

test('2. the reference implementation room keeps its App preview where it can run, and the page preview stands in where it cannot', async ({ page }) => {
  test.setTimeout(900_000);
  // The concept check offers itself on entering a phase; this proof is about the preview.
  await skipConceptChecks(page);
  await reachImplementation(page, 'page-preview-ref');
  const nav = page.locator('nav[aria-label="Implementation working area"]');
  await expect(page.getByTestId('preview-pane')).toBeVisible({ timeout: NAVIGATION });
  if (!(await page.getByTestId('preview-unsupported').count())) {
    // This host can run the sandbox preview: the App preview pane with Run app, and no page preview.
    test.info().annotations.push({ type: 'reference-preview', description: 'sandbox App preview (as before)' });
    await expect(page.getByTestId('preview-idle')).toBeVisible();
    await stripDoor(page, 'header-run-app'); // visible, under the strip's Details
    await foldStripDetails(page);
    await expect(page.getByTestId('preview-pane')).toContainText('Run app builds your front end');
    await expect(page.getByTestId('client-page-preview')).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'App preview' })).toBeVisible();
  } else {
    // This host has said it cannot run the sandbox preview (macOS: no kernel isolation). The pane says why,
    // and the page preview draws the learner's page under it.
    test.info().annotations.push({ type: 'reference-preview', description: 'App preview pane says why; page preview draws under it' });
    await expect(page.getByTestId('preview-pane')).toHaveCount(1);
    await expect(page.getByTestId('preview-unsupported')).toBeVisible();
    await expect(page.getByTestId('client-page-preview')).toBeVisible({ timeout: NAVIGATION });
    await expect(page.getByTestId('page-preview-label')).toContainText(LABEL);
    await expect(page.getByTestId('header-run-app')).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'App preview' })).toBeVisible();
    const app = page.frameLocator('[data-testid="page-preview-frame"]');
    await expect(app.getByRole('heading', { name: 'Your lists' })).toBeVisible({ timeout: UI_READY });
    await expect(page.getByTestId('page-preview-errors')).toHaveCount(0);
  }
});
