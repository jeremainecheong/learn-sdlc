import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import {
  dismissPhaseTutorial,
  joinClassInUi,
  registerAndSignIn,
  signInTo,
  signOutFromMenu,
  teacherHome,
} from './pw-fixtures';
import { INSTRUCTOR, classByApi } from './passing-work';
import { API, testEmail } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * An instructor exports a class and imports it back as a second class.
 *
 * The round trip is driven through the browser rather than through the API,
 * because the two halves of this feature that can only fail in a browser are
 * the download (a blob handed to the page, not an href the API can serve) and
 * the file input (a document read and parsed before a large body is ever sent).
 *
 * The dry run is asserted before the import, in that order and on purpose: an
 * import cannot be undone, so "it listed the learner before it wrote anything"
 * is the property this feature is for.
 *
 * The panel is on the teacher's "Class data" page (/teacher/settings); a
 * class export never carries private mentor conversations, so there is no
 * "include messages" box and the page says so instead; and the teacher
 * home's class list is where the two copies are
 * counted. The dry run's "still one class" is read from the API, since the
 * settings page draws no class list. The class is made through the API and
 * the instructor signs in straight to the settings page (e2e/passing-work.ts,
 * classByApi, says why the teacher home is avoided until the last look).
 */

const STAMP = Date.now();
const CLASS_NAME = `Portable class ${STAMP}`;
const LEARNER_EMAIL = testEmail(`e2e-portable-${STAMP}`);
const LEARNER_NAME = 'Pat Portable';

test('an instructor exports a class and imports it back as a second class', async ({ page, request }, info) => {
  await dismissPhaseTutorial(page);

  /* ------------------------- a class with a learner ------------------------ */
  const { staff, joinCode } = await classByApi(request, CLASS_NAME);

  await registerAndSignIn(page, { name: LEARNER_NAME, email: LEARNER_EMAIL });
  await joinClassInUi(page, joinCode);
  await signOutFromMenu(page);

  /* ------------------------------ the export ------------------------------- */
  await signInTo(page, INSTRUCTOR.email, INSTRUCTOR.password, '/teacher/settings');

  const panel = page.getByTestId('portability-panel');
  await expect(panel).toBeVisible({ timeout: UI_READY });
  await panel.scrollIntoViewIfNeeded();
  await page.getByTestId('export-cohort-select').selectOption({ label: CLASS_NAME });
  // Private mentor conversations never leave in a class export.
  await expect(panel).toContainText('Private mentor conversations are excluded from class exports.');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-cohort').click(),
  ]);
  const file = info.outputPath('class-export.json');
  await download.saveAs(file);

  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(document.format).toBe('learnsdlc.cohort');
  expect(document.cohort.name).toBe(CLASS_NAME);
  expect(document.counts.learners).toBe(1);
  // Nothing in this file signs anybody in on the other machine.
  expect(fs.readFileSync(file, 'utf8')).not.toContain('passwordHash');

  /* ------------------- the dry run, before anything is written ------------- */
  await page.getByTestId('import-file').setInputFiles(file);
  await page.getByTestId('import-preview').click();

  const preview = page.getByTestId('import-preview-list');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(LEARNER_NAME);
  await expect(preview).toContainText(LEARNER_EMAIL);
  await expect(preview).toContainText('Already here');
  await expect(preview).toContainText('Nothing already on this machine is changed');
  // And it is still one class: a dry run writes nothing.
  const named = async () =>
    ((await (await request.get(`${API}/instructor/cohorts`, { headers: staff.headers })).json()) as { name: string }[]).filter(
      (c) => c.name === CLASS_NAME,
    ).length;
  expect(await named()).toBe(1);

  /* ------------------------------ the import ------------------------------- */
  await page.getByTestId('import-run').click();
  const result = page.getByTestId('import-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('was imported');
  await expect(result).toContainText('The join code is');
  // The copy's code is its own: two machines must never share one.
  const copyCode = (await result.innerText()).match(/join code is ([A-Z2-9]{4}-[A-Z2-9]{4})/)?.[1];
  expect(copyCode, 'the result names the new code').toBeTruthy();
  expect(copyCode!.replace('-', '')).not.toEqual(joinCode.replace('-', ''));

  // The teacher home reads the list afresh: the assertion is about what is in
  // the database, not about which card refreshed itself.
  await teacherHome(page);

  // Two classes of the same name, and the copy carries a code of its own:
  // two machines must never share one.
  const copies = page.locator('li', { hasText: CLASS_NAME });
  await expect(copies).toHaveCount(2, { timeout: UI_READY });
  // Codes are masked until Show code is pressed (39e205e4, JoinCode.tsx).
  for (const show of await copies.getByTestId('join-code-show').all()) await show.click();
  const codes = (await copies.allInnerTexts()).map((text) => text.match(/[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0]);
  expect(codes).toHaveLength(2);
  expect(codes[0], 'each copy shows its code').toBeTruthy();
  expect(codes[1], 'each copy shows its code').toBeTruthy();
  expect(codes[0]).not.toEqual(codes[1]);
  expect(await named()).toBe(2);
});
