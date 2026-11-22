import { expect, test, type Page } from '@playwright/test';
import { INSTRUCTOR } from './passing-work';
import { LEARNER_PASSWORD, dismissPhaseTutorial, signInAs, skipCoachMarks } from './pw-fixtures';
import { shelfArchive, writeDeepReceiptSeam } from './upload-helpers';
import { assertLoopbackApi, RUN } from './support/env';
import { apiOk, useApiContext } from './support/api';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The "Your design" rail counts the record.
 *
 * On an uploaded shelf project (the `shelf` fixture, whose Design is a design
 * record with the API contract on), the rail reads what the record holds, not
 * a file: before anything is written it says so part by part; after one
 * entity with one attribute, one operation, one decision and one endpoint are
 * added through the room's forms it counts each of them, and after a reload
 * it counts them again from what was saved. The older case that dropped an
 * empty markdown template's headings is gone: Design has no page.
 *
 * No real AI, nothing printed that names an address, a token or an id.
 */

test.describe.configure({ mode: 'serial' });

assertLoopbackApi(__filename);

const api = useApiContext();
const ok = (method: string, route: string, headers: Record<string, string>, data?: unknown) => apiOk(api(), method, route, headers, data);

async function openDesignRoom(page: Page, phaseId: string) {
  await page.goto(`/workspace/${phaseId}/design`);
  await expect(page.getByTestId('phase-design-editor')).toBeVisible({ timeout: NAVIGATION });
  const skip = page.getByTestId('concept-prompt-skip');
  if (await skip.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) await skip.click();
  await expect(page.getByTestId('concept-prompt')).toHaveCount(0);
}

test('an uploaded design room: the rail counts the record\'s entities, operations and decisions', async ({ page }) => {
  test.setTimeout(600_000);
  const login = await ok('POST', '/auth/login', {}, { email: INSTRUCTOR.email, password: INSTRUCTOR.password });
  const staff = { authorization: `Bearer ${login.token}` };

  const made = await ok('POST', '/instructor/projects/upload', staff, { title: `RG Design Shelf ${RUN}`, archiveBase64: shelfArchive().toString('base64') });
  const at = `/instructor/projects/${made.projectId}/versions/${made.versionId}`;
  const draft = await ok('GET', at, staff);
  await ok('POST', `${at}/validate`, staff);
  writeDeepReceiptSeam(made.versionId);
  await ok('POST', `${at}/validate`, staff);
  const published = await ok('POST', `${at}/publish`, staff, { version: '1.0.0', notes: 'The design rail check publishes FIX-1.' });
  const cohort = await ok('POST', '/instructor/cohorts', staff, { name: `RG design class ${RUN}` });
  await ok('PUT', `/instructor/cohorts/${cohort.id}/project`, staff, { projectVersionId: published.versionId, reason: 'The design rail class works on the uploaded shelf.' });

  const email = `design-rail-${RUN}@example.test`;
  await ok('POST', '/auth/register', {}, { email, password: LEARNER_PASSWORD, displayName: `Gee Design ${RUN}` });
  const lh = { authorization: `Bearer ${(await ok('POST', '/auth/login', {}, { email, password: LEARNER_PASSWORD })).token}` };
  const me = await ok('GET', '/auth/me', lh);
  await ok('POST', '/enrollments/join', lh, { code: cohort.joinCode });
  await ok('POST', '/enrollments', lh, { projectSlug: draft.slug });
  await ok('PATCH', '/account/profile', lh, { displayName: `Gee Design ${RUN}`, onboardingCompleted: true, baseVersion: me.profileVersion || 0 });
  const mine = await ok('GET', '/enrollments/mine', lh);
  expect(mine.projectSlug, 'enrolled on the uploaded project').toBe(draft.slug);
  const design = (mine.phases as { key: string; id: string }[]).find((one) => one.key === 'design')!;
  await ok('POST', `/instructor/learners/${me.id}/phases/${design.id}/override`, staff, {
    action: 'reopen',
    reason: 'Browser proof: opened for the design board only; no Pass is seeded.',
  });

  const before = await ok('GET', `/phases/${design.id}`, lh);
  expect((before.files as { path: string }[]).some((f) => f.path === 'design/design.json'), 'the API hands the room its record').toBe(true);

  await skipCoachMarks(page);
  await dismissPhaseTutorial(page);
  await signInAs(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
  await openDesignRoom(page, design.id);

  const part = (name: string) => page.getByTestId(`phase-design-part-${name}`);
  await expect(part('data-model')).toContainText('No entities yet');
  await expect(part('operations')).toContainText('No operations yet');
  await expect(part('decisions')).toContainText('Not written');
  await expect(part('api-contract')).toContainText('No endpoints yet');
  // The shelf's screen contract is off, so the rail has no Screens part.
  await expect(part('screens')).toHaveCount(0);

  await page.getByTestId('design-tab-model').click();
  await page.getByTestId('design-board-entity-add').click();
  await page.getByTestId('design-board-entity-0-name').fill('Book');
  await page.getByTestId('design-board-entity-0-attr-add').click();
  await page.getByTestId('design-board-entity-0-attr-0-name').fill('title');
  await page.getByTestId('design-board-entity-0-attr-0-type').fill('string');
  await page.getByTestId('design-operation-add').click();
  await page.getByTestId('design-operation-0-name').fill('lendBook(id, borrower)');
  await page.getByTestId('design-tab-decisions').click();
  await page.getByTestId('design-decision-add').click();
  await page.getByTestId('design-decision-0-title').fill('Keep the shelf in memory');
  await page.getByTestId('design-tab-api').click();
  await page.getByRole('button', { name: 'Add an endpoint' }).click();

  // The rail counts the record (and the contract), as the learner types.
  await expect(part('data-model')).toContainText('One entity, one attribute');
  await expect(part('operations')).toContainText('One operation');
  await expect(part('decisions')).toContainText('One proposed');
  await expect(part('api-contract')).toContainText('One endpoint');
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });

  // The record the server holds once the room has saved: it carries what was typed.
  const recordOf = async () =>
    ((await ok('GET', `/phases/${design.id}`, lh)).files as { path: string; content: string }[]).find((f) => f.path === 'design/design.json')?.content;
  const saved = await recordOf();
  expect(JSON.parse(saved!).entities.map((e: { name: string }) => e.name), 'the saved record holds Book').toEqual(['Book']);

  // After a reload the rail counts what was saved.
  await openDesignRoom(page, design.id);
  await expect(page.getByTestId('design-board-entity-0-name')).toHaveValue('Book');
  await expect(part('data-model')).toContainText('One entity, one attribute');
  await expect(part('operations')).toContainText('One operation');
  await expect(part('decisions')).toContainText('One proposed');
  await expect(part('api-contract')).toContainText('One endpoint');
  // Opening the room again rewrote nothing: the record is the one that was saved.
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });
  expect(await recordOf(), 'design.json is the same after the reload').toBe(saved);
});
