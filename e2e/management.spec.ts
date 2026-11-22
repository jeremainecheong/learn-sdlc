import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import { createClassFromTeacherHome, dismissPhaseTutorial, joinClassInUi, registerAndSignIn, signInAs, signInTo, signOutFromMenu, teacherHome } from './pw-fixtures';
import { ADMIN, INSTRUCTOR, enrolByApi, registerByApi, staffByApi, type ApiLearner } from './passing-work';
import { API, testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * Classes and the admin console: an instructor mints a join code, a learner
 * redeems it and shows up on that instructor's console, and an admin can
 * suspend, restore and re-home accounts from /admin.
 *
 * Every console spec mints its own class, an instructor's scope is the
 * classes they own, and `default` is not one of them, so file order does
 * not decide what the seeded instructor can see.
 *
 * The console is the teacher home (/teacher). A class is made
 * with Create class and its code read off the class's own page; a learner
 * joins from the classroom page; the teacher home lists the class with its
 * count and the learner in its roster; and sign-out is in the account menu.
 * The grade book's header ends with the two quiz columns (checklist % and
 * quiz mastery %).
 */

const LEARNER_EMAIL = testEmail(`e2e-class-${Date.now()}`);
const LEARNER_PASSWORD = 'Correct-Horse-9';
const CLASS_NAME = `E2E class ${Date.now()}`;

test.beforeEach(async ({ page }) => {
  await dismissPhaseTutorial(page);
});

test('a learner joins a class by code and appears on that instructor\'s console', async ({ page }) => {
  /* ------------------------ instructor mints a code ------------------------ */
  await signInAs(page, INSTRUCTOR.email, INSTRUCTOR.password);
  const { joinCode } = await createClassFromTeacherHome(page, CLASS_NAME);
  await signOutFromMenu(page);

  /* -------------------------- learner redeems it --------------------------- */
  await registerAndSignIn(page, { name: 'Cleo Classmate', email: LEARNER_EMAIL, password: LEARNER_PASSWORD });
  // Typed the way it is read off a slide, lower case, with the dash, to
  // prove the API normalises it.
  await joinClassInUi(page, joinCode.toLowerCase());
  await expect(page.locator('main')).toContainText(CLASS_NAME);
  await signOutFromMenu(page);

  /* ------------------- the instructor sees the learner --------------------- */
  await signInAs(page, INSTRUCTOR.email, INSTRUCTOR.password);
  await teacherHome(page);
  await expect(page.locator('li', { hasText: CLASS_NAME })).toContainText('1 learner', { timeout: UI_READY });
  // The roster is the class's own page, opened from its card on the home.
  await page.locator('li', { hasText: CLASS_NAME }).locator('a.exp-row').click();
  await page.waitForURL(/\/teacher\/class\?class=/, { timeout: NAVIGATION });
  await expect(page.locator('tr', { hasText: LEARNER_EMAIL })).toContainText('Cleo Classmate', { timeout: UI_READY });

  /* --------------------- the grade book leaves the console ----------------- */
  // The second shape of the same term: one row per learner and one
  // column per phase, which is what a spreadsheet and an LMS want. The long
  // export beside it is unchanged and stays the one to read for how a verdict
  // was reached.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-gradebook').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^learnsdlc-gradebook(-tasktrackr)?\.csv$/);
  const saved = await download.path();
  expect(saved, 'the grade book reached the disk').toBeTruthy();
  const csv = fs.readFileSync(saved!, 'utf-8');
  expect(csv.split(/\r?\n/)[0]).toBe(
    'email,displayName,class,project,requirements,design,implementation,testing,deployment,maintenance,average,gates passed,completed,checklist %,quiz mastery %',
  );
  await signOutFromMenu(page);
});

test('an admin suspends, restores and re-homes accounts from /admin', async ({ page }) => {
  await signInAs(page, ADMIN.email, ADMIN.password);
  await teacherHome(page);
  await page.getByTestId('nav-admin').click();
  await expect(page.getByTestId('admin-title')).toBeVisible();

  /* -------------------------------- suspend -------------------------------- */
  await page.getByTestId('admin-email').fill(LEARNER_EMAIL);
  await page.getByTestId('admin-search').click();
  await expect(page.getByTestId('admin-user')).toBeVisible();
  await expect(page.getByTestId('admin-status')).toHaveText(/Active/);
  await expect(page.getByTestId('admin-user-cohort')).toContainText(CLASS_NAME);
  await page.getByTestId('admin-suspend').click();
  await expect(page.getByTestId('admin-status')).toHaveText(/Suspended/);
  await expect(page.getByTestId('admin-note')).toContainText('signed out');
  await signOutFromMenu(page);

  // A suspended account gets the same refusal as a wrong password.
  await signInAs(page, LEARNER_EMAIL, LEARNER_PASSWORD);
  await expect(page.getByTestId('auth-error')).toBeVisible();

  /* -------------------------------- restore -------------------------------- */
  await signInAs(page, ADMIN.email, ADMIN.password);
  await teacherHome(page);
  await page.goto('/admin');
  await page.getByTestId('admin-email').fill(LEARNER_EMAIL);
  await page.getByTestId('admin-search').click();
  await expect(page.getByTestId('admin-status')).toHaveText(/Suspended/);
  await page.getByTestId('admin-restore').click();
  await expect(page.getByTestId('admin-status')).toHaveText(/Active/);

  /* ------------------- move the instructor back to no class ---------------- */
  await page.getByTestId('admin-email').fill(INSTRUCTOR.email);
  await page.getByTestId('admin-search').click();
  await expect(page.getByTestId('admin-user')).toBeVisible();
  await expect(page.getByTestId('admin-user-cohort')).toContainText(CLASS_NAME);
  await page.getByTestId('admin-cohort').selectOption('default');
  await page.getByTestId('admin-save').click();
  await expect(page.getByTestId('admin-note')).toContainText('Saved');
  await expect(page.getByTestId('admin-user-cohort')).not.toContainText(CLASS_NAME);
  await signOutFromMenu(page);

  // Restored, and signed in again with the same password.
  await signInAs(page, LEARNER_EMAIL, LEARNER_PASSWORD);
  await page.waitForURL('**/dashboard');
});

/**
 * A class of a realistic size, looked at three times in a minute.
 *
 * The teacher home and a class's own page are one component (TeacherPortal),
 * and each load of it reads every learner in view with one
 * GET /instructor/learners/:userId (four at a time). That route allows 60 a
 * minute per account (instructor.controller.ts, @ConsoleRateLimit(), 60 a
 * minute); the guard refuses the 61st (rate-limit.guard.ts, `count > max`). A teacher of one class
 * of 30 spends 30 of the 60 on each view: signing in to the home and reloading
 * it are served (60), and the next view inside that minute, the class's own
 * page, the next click a teacher makes, is refused ("rate limit exceeded —
 * slow down") and draws no learners. The claim is that every one of those
 * views draws the class. Red until the product reads a class with fewer
 * requests (for example a class-scoped read).
 *
 * The teacher is made for this test (an admin promotes a new account), so no
 * other spec's classes are in their scope, and they sign in straight to the
 * home (/login?next=/teacher) so each view is exactly one load. The accounts
 * are deleted at the end so no later spec reads them.
 */
test('a teacher of one class of 30 sees it on every view inside a minute', async ({ page, request }) => {
  const SIZE = 30;
  const stamp = Date.now();
  const className = `E2E class of ${SIZE} ${stamp}`;
  const admin = await staffByApi(request, ADMIN);
  const teacher = await registerByApi(request, {
    name: 'Tess Thirty',
    email: testEmail(`e2e-teacher-${SIZE}-${stamp}`),
    password: LEARNER_PASSWORD,
  });
  const learners: ApiLearner[] = [];
  try {
    const promoted = await request.patch(`${API}/admin/users/${teacher.userId}`, {
      headers: admin.headers,
      data: { role: 'INSTRUCTOR' },
    });
    expect(promoted.ok(), 'the admin makes the new account a teacher').toBeTruthy();
    const staff = await staffByApi(request, teacher);
    const made = await request.post(`${API}/instructor/cohorts`, { headers: staff.headers, data: { name: className } });
    expect(made.ok(), 'the class is created').toBeTruthy();
    const { id: classId, joinCode } = await made.json();

    for (let n = 1; n <= SIZE; n += 1) {
      const learner = await registerByApi(request, {
        name: `Learner ${String(n).padStart(2, '0')}`,
        email: testEmail(`e2e-class${SIZE}-${stamp}-${n}`),
        password: LEARNER_PASSWORD,
      });
      learners.push(learner);
      const joined = await request.post(`${API}/enrollments/join`, { headers: learner.headers, data: { code: joinCode } });
      expect(joined.ok(), `learner ${n} joins the class`).toBeTruthy();
      await enrolByApi(request, learner);
    }

    // What a view draws once its load has ended: the learners it read, or the
    // refusal. (Next's route announcer is an empty alert that is always there,
    // so the refusal is the alert that says it.)
    const counted = page.getByText(new RegExp(`^${SIZE} associated learners`)).first();
    const refused = page.getByRole('alert').filter({ hasText: 'rate limit' });
    const settled = async (view: string) => {
      await expect(counted.or(refused).first(), `${view} finishes loading`).toBeVisible({ timeout: NAVIGATION });
      await expect(refused, `${view} is not refused`).toHaveCount(0);
      await expect(counted, `${view} draws the ${SIZE} learners`).toBeVisible();
    };
    const row = page.locator('li', { hasText: className });

    // One: signing in to the home.
    await signInTo(page, teacher.email, teacher.password, '/teacher');
    await settled('the home, first view');
    await expect(row).toContainText(`${SIZE} learners`);

    // Two: the same page again, the way a teacher comes back to the tab.
    await page.reload();
    await settled('the home, reloaded');
    await expect(row).toContainText(`${SIZE} learners`);

    // Three: the class's own page, from its row. The row holds two links (the
    // class, and 'Sign-off queue for <class>'), so the class's is named
    // by its own address.
    await row.locator(`a[href="/teacher/class?class=${encodeURIComponent(classId)}"]`).click();
    await page.waitForURL((url) => url.pathname === '/teacher/class' && url.searchParams.get('class') === classId, { timeout: NAVIGATION });
    await settled("the class's own page, third view in the minute");
  } finally {
    // Nothing this test made is left for a later spec's scope.
    for (const account of [...learners, teacher]) {
      await request.delete(`${API}/account`, { headers: account.headers, data: { email: account.email } }).catch(() => undefined);
    }
  }
});
