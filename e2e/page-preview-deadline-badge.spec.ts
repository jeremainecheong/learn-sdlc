import { expect, test } from '@playwright/test';
import { INSTRUCTOR } from './passing-work';
import { LEARNER_PASSWORD, dismissPhaseTutorial, signInAs, skipCoachMarks, skipConceptChecks } from './pw-fixtures';
import { chooseImplementationView, writeFile } from './preview-helpers';
import { writeDeepReceiptSeam } from './upload-helpers';
import { apiOk, useApiContext } from './support/api';
import { deadlineBadgeArchive, doneBox, expectBadges, expectPagePreview, learnerOverdueHelper, OVERDUE_HELPER } from './support/deadline-badge';
import { assertLoopbackApi, RUN, testEmail } from './support/env';
import { NAVIGATION } from './support/timeouts';

/**
 * The Deadline badge pack shows its supplied page in the page preview.
 *
 * A teacher uploads the pack, validates, publishes and assigns it; a learner
 * joins. Implementation: the page draws three sample tasks and no badge on the
 * starter, and the badge on Yesterday only once the learner's rule is in the
 * editor. Maintenance: the badge stays on Yesterday when Done is ticked until
 * the learner's guard is in; then ticking Done takes it away and clearing Done
 * brings it back. Today and No due date are never badged.
 *
 * The pack and the learner's work are tracked fixtures (e2e/support/deadline-badge.ts).
 * No real AI, nothing printed that names an address, a token or an id.
 */

test.describe.configure({ mode: 'serial' });

assertLoopbackApi(__filename);

const api = useApiContext();
const ok = (method: string, route: string, headers: Record<string, string>, data?: unknown) => apiOk(api(), method, route, headers, data);

test('the Deadline badge page draws its badge from the helper in the editor, in Implementation and in Maintenance', async ({ page }) => {
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
  const published = await ok('POST', `${at}/publish`, staff, { version: '1.0.0', notes: 'The page preview proof publishes Deadline badge.' });
  const cohort = await ok('POST', '/instructor/cohorts', staff, { name: `Deadline class ${RUN}` });
  await ok('PUT', `/instructor/cohorts/${cohort.id}/project`, staff, { projectVersionId: published.versionId, reason: 'The page preview class works on Deadline badge.' });

  const email = testEmail(`deadline-preview-${RUN}`);
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
      reason: 'Browser proof: opened for the page preview only; no Pass is seeded.',
    });
  }
  const detail = await ok('GET', `/phases/${phase('implementation').id}`, lh);
  expect(detail.canPreview ?? false, 'the uploaded room has no sandbox App preview').toBe(false);
  expect((detail.files as { path: string }[]).map((f) => f.path)).toEqual(expect.arrayContaining(['web/index.html', 'web/src/main.ts']));

  await skipCoachMarks(page);
  await dismissPhaseTutorial(page);
  await signInAs(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });

  // Implementation: the starter's helper returns false, so no row is badged.
  await page.goto(`/workspace/${phase('implementation').id}`);
  await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: NAVIGATION });
  const implNav = page.locator('nav[aria-label="Implementation working area"]');
  await expect(implNav.getByRole('button', { name: 'Page preview', exact: true })).toBeVisible({ timeout: NAVIGATION });
  await chooseImplementationView(page, 'Split');
  await expectPagePreview(page);
  await expectBadges(page, []);

  // The learner's rule goes into the editor: the page is built again from it, with no press.
  await writeFile(page, OVERDUE_HELPER, learnerOverdueHelper('implementation'));
  await chooseImplementationView(page, 'Split');
  await expectBadges(page, ['Yesterday']);
  await chooseImplementationView(page, 'Page preview');
  await expectBadges(page, ['Yesterday']);

  // Maintenance: version 1's helper. Done changes nothing until CR-1 is made.
  await page.goto(`/workspace/${phase('maintenance').id}`);
  await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: NAVIGATION });
  const room = page.locator('nav[aria-label="Phase working area"]');
  await room.getByRole('button', { name: 'Page preview', exact: true }).click();
  await expectPagePreview(page);
  await expectBadges(page, ['Yesterday']);
  await doneBox(page, 'Yesterday').check();
  await expectBadges(page, ['Yesterday']);
  await doneBox(page, 'Yesterday').uncheck();

  // The learner's guard goes in: ticking Done takes the badge away, clearing it brings it back.
  await room.getByRole('button', { name: 'Edit files', exact: true }).click();
  await writeFile(page, OVERDUE_HELPER, learnerOverdueHelper('maintenance'));
  await room.getByRole('button', { name: 'Page preview', exact: true }).click();
  await expectPagePreview(page);
  await expectBadges(page, ['Yesterday']);
  await doneBox(page, 'Yesterday').check();
  await expectBadges(page, []);
  await doneBox(page, 'Yesterday').uncheck();
  await expectBadges(page, ['Yesterday']);
  await doneBox(page, 'Today').check();
  await doneBox(page, 'No due date').check();
  await expectBadges(page, ['Yesterday']);
});
