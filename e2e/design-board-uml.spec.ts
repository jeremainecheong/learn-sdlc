import { expect, test, type Page } from '@playwright/test';
import { INSTRUCTOR } from './passing-work';
import { LEARNER_PASSWORD, dismissPhaseTutorial, signInAs, skipCoachMarks } from './pw-fixtures';
import { shelfArchive, writeDeepReceiptSeam } from './upload-helpers';
import { assertLoopbackApi, RUN } from './support/env';
import { apiOk, useApiContext } from './support/api';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The learner enters the design in the room's forms, never in a file, and
 * the room draws the UML.
 *
 * On an uploaded project (the `shelf` fixture), whose Design is a design
 * record with the API contract on and no starting documents: the room opens,
 * two entities and a composition are added, the SVG redraws with two boxes
 * and one relation, and after a reload the forms and the diagram are still
 * there. The room shows no file name: the record is the forms.
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
  // The concept check offers itself on entering a phase; this proof is about
  // the board, so it puts the offer away with its own "Later".
  const skip = page.getByTestId('concept-prompt-skip');
  if (await skip.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) await skip.click();
  await expect(page.getByTestId('concept-prompt')).toHaveCount(0);
}

test('an uploaded design room: two entities and a composition draw, and survive a reload', async ({ page }) => {
  test.setTimeout(600_000);
  const login = await ok('POST', '/auth/login', {}, { email: INSTRUCTOR.email, password: INSTRUCTOR.password });
  const staff = { authorization: `Bearer ${login.token}` };

  const made = await ok('POST', '/instructor/projects/upload', staff, { title: `Design Shelf ${RUN}`, archiveBase64: shelfArchive().toString('base64') });
  const at = `/instructor/projects/${made.projectId}/versions/${made.versionId}`;
  const draft = await ok('GET', at, staff);
  await ok('POST', `${at}/validate`, staff);
  writeDeepReceiptSeam(made.versionId);
  await ok('POST', `${at}/validate`, staff);
  const published = await ok('POST', `${at}/publish`, staff, { version: '1.0.0', notes: 'The design board row publishes FIX-1.' });
  const cohort = await ok('POST', '/instructor/cohorts', staff, { name: `Design class ${RUN}` });
  await ok('PUT', `/instructor/cohorts/${cohort.id}/project`, staff, { projectVersionId: published.versionId, reason: 'The design board class works on the uploaded shelf.' });

  const email = `design-uml-${RUN}@example.test`;
  await ok('POST', '/auth/register', {}, { email, password: LEARNER_PASSWORD, displayName: `Dee Design ${RUN}` });
  const lh = { authorization: `Bearer ${(await ok('POST', '/auth/login', {}, { email, password: LEARNER_PASSWORD })).token}` };
  const me = await ok('GET', '/auth/me', lh);
  await ok('POST', '/enrollments/join', lh, { code: cohort.joinCode });
  await ok('POST', '/enrollments', lh, { projectSlug: draft.slug });
  await ok('PATCH', '/account/profile', lh, { displayName: `Dee Design ${RUN}`, onboardingCompleted: true, baseVersion: me.profileVersion || 0 });
  const mine = await ok('GET', '/enrollments/mine', lh);
  expect(mine.projectSlug, 'enrolled on the uploaded project').toBe(draft.slug);
  const design = (mine.phases as { key: string; id: string }[]).find((one) => one.key === 'design')!;
  await ok('POST', `/instructor/learners/${me.id}/phases/${design.id}/override`, staff, {
    action: 'reopen',
    reason: 'Browser proof: opened for the design board only; no Pass is seeded.',
  });
  const before = await ok('GET', `/phases/${design.id}`, lh);
  const files = before.files as { path: string; content: string }[];
  expect(files.some((f) => f.path === 'design/design.json'), 'the API hands the room its record').toBe(true);

  await skipCoachMarks(page);
  await dismissPhaseTutorial(page);
  await signInAs(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
  await openDesignRoom(page, design.id);

  // The board, never a markdown file.
  await expect(page.getByText('This project has no design/design.json')).toHaveCount(0);
  await expect(page.getByTestId('design-board-save-unavailable')).toHaveCount(0);
  await expect(page.getByTestId('design-uml-empty')).toBeVisible();

  await page.getByTestId('design-board-entity-add').click();
  await page.getByTestId('design-board-entity-0-name').fill('Shelf');
  await page.getByTestId('design-board-entity-add').click();
  await page.getByTestId('design-board-entity-1-name').fill('Book');
  await page.getByTestId('design-board-entity-1-attr-add').click();
  await page.getByTestId('design-board-entity-1-attr-0-name').fill('title');
  await page.getByTestId('design-board-entity-1-attr-0-type').fill('string');
  const svg = page.getByTestId('design-uml-svg');
  await expect(svg).toHaveAttribute('data-boxes', '2');
  await expect(svg).toHaveAttribute('data-relations', '0');
  await expect(svg).toContainText('title: string');

  await page.getByTestId('design-board-relation-add').click();
  await page.getByTestId('design-board-relation-0-kind').selectOption('composition');
  await page.getByTestId('design-board-relation-0-to-card').selectOption('*');
  await page.getByTestId('design-board-relation-0-label').fill('holds');
  await expect(svg).toHaveAttribute('data-relations', '1');
  await expect(page.getByTestId('design-uml-edge-R1')).toHaveAttribute('data-kind', 'composition');
  await expect(page.getByTestId('design-uml-edge-R1')).toContainText('holds');

  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: UI_READY });
  await openDesignRoom(page, design.id);
  await expect(page.getByTestId('design-board-entity-0-name')).toHaveValue('Shelf');
  await expect(page.getByTestId('design-board-entity-1-name')).toHaveValue('Book');
  await expect(page.getByTestId('design-uml-svg')).toHaveAttribute('data-boxes', '2');
  await expect(page.getByTestId('design-uml-svg')).toHaveAttribute('data-relations', '1');
  await expect(page.getByTestId('design-uml-edge-R1')).toHaveAttribute('data-kind', 'composition');

  // The room shows no file name: the record and the contract are the forms, never a file.
  await expect(page.getByTestId('phase-design-editor')).not.toContainText('.json');
  const after = await ok('GET', `/phases/${design.id}`, lh);
  const record = JSON.parse((after.files as { path: string; content: string }[]).find((f) => f.path === 'design/design.json')!.content);
  expect(record.entities.map((e: { name: string }) => e.name), 'the record holds the two entities').toEqual(['Shelf', 'Book']);
  expect(record.relations.map((r: { kind: string; label?: string }) => [r.kind, r.label]), 'and the composition').toEqual([['composition', 'holds']]);
});
