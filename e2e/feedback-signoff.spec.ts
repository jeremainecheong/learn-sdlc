import { expect, request as pwRequest, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import * as crypto from 'crypto';
import { STORY_JSON } from '@learnsdlc/shared';
import { INSTRUCTOR, passPhaseByApi, type ApiPhase } from './passing-work';
import { dismissPhaseTutorial, LEARNER_PASSWORD, signInAs } from './pw-fixtures';
import { shelfArchive, shelfDesignWork, shelfStoryRecord, writeDeepReceiptSeam } from './upload-helpers';
import { AI_STUB_URL, API, assertLoopbackApi, RUN_ID } from './support/env';
import { E2E_SQLITE } from './support/paths';
import { okBody } from './support/api';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The learner sees the teacher's sign-off, and the bell shows the phase's
 * latest verdict.
 *
 * The shape this guards: revision 1 is a Needs revision WITH review threads,
 * so the grader writes a `review.posted` row; revision 2 is a strict Pass with
 * no threads on a countersigned task, so nothing is written. The bell must
 * not keep "Needs revision", and once the teacher signs it off with a reason
 * the learner's feedback page must not read "No teacher feedback on this
 * submission yet."
 *
 * Reached through the API as e2e/signoff-chip-a11y.spec.ts reaches it:
 * the `shelf` fixture (shelfArchive) as the seeded instructor's draft, Design's
 * one task, the design, marked by the editor's own route, published behind
 * the test-only deep-receipt seam, assigned to a new class; a learner joins
 * and passes Requirements on the story record, so Design opens. Design's one
 * task is the countersigned one: a Design phase holds exactly one task,
 * so nothing is added beside it, and Requirements is a story phase whose one
 * work task is the story. The loopback AI stub passes only work carrying
 * E2E-PASS, so the learner hands the design in, written as the room's forms
 * write it (the record and the API contract), once without the mark in its
 * notes (Needs revision) and once with it (Pass, awaiting the
 * countersignature). No real AI.
 *
 * **MACOS-THREADS-ROW (test-only).** A design task produces no
 * review threads (threads are failing test cases and static-analysis issues,
 * which need learner code, and macOS runs none), so revision 1's Needs revision
 * writes no `review.posted` row here. This file writes that one row into the
 * disposable e2e sqlite file, word for word as `NotificationsService.onVerdict`
 * writes it for a strict Needs revision with one thread, through
 * `better-sqlite3`, and prints no row. Everything after it (the Pass that
 * writes nothing, the bell's projection, the bulk sign-off, the feedback page)
 * is the product's own. The full sequence through the real `onVerdict` (threads
 * included) is proven in apps/api/src/notifications/bell-latest-verdict.spec.ts.
 */

test.describe.configure({ mode: 'serial' });

assertLoopbackApi(__filename);

const RUN = `${RUN_ID.slice(-8)}${crypto.randomBytes(2).toString('hex')}`;
const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const SIGNOFF_REASON = `Heard the member interview in the Tuesday lab ${RUN}; the words are theirs.`;
const SIGNED = 'Signed off by your teacher.';
const WAITING = "Waiting for your teacher's sign-off.";
const EMPTY = 'No teacher feedback on this submission yet.';

const S: {
  slug?: string;
  cohortId?: string;
  design?: string;
  designKey?: string;
  designTitle?: string;
  learnerId?: string;
  learnerEmail?: string;
  learnerToken?: string;
  first?: string;
  second?: string;
} = {};

let api: APIRequestContext;
let staff: { authorization: string };
let ctx: BrowserContext;
let learner: Page;
const fiveHundreds: string[] = [];

async function call(method: string, route: string, headers: Record<string, string>, data?: unknown) {
  const res = await api.fetch(`${API}${route}`, { method, headers, data });
  if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${method} ${route.replace(IDS, ':id')}`);
  return res;
}

async function ok(method: string, route: string, headers: Record<string, string>, data?: unknown) {
  return okBody(await call(method, route, headers, data), method, route);
}

const lh = () => ({ authorization: `Bearer ${S.learnerToken}` });

/** One hand-in of the countersigned design, waited out to its verdict. */
async function handIn(marked: boolean): Promise<{ id: string; passed: boolean }> {
  await ok('PUT', `/phases/${S.design}/workspace`, lh(), { files: shelfDesignWork(marked) });
  const handed = await ok('POST', `/phases/${S.design}/tasks/${encodeURIComponent(S.designKey!)}/submit`, lh());
  let done: any = null;
  await expect
    .poll(async () => {
      done = await ok('GET', `/submissions/${handed.id}`, lh());
      return done.status;
    }, { timeout: 180_000, intervals: [500, 1_000] })
    .toBe('completed');
  return { id: handed.id, passed: done.passed };
}

type Sqlite = {
  prepare(sql: string): { get(...args: unknown[]): any; all(...args: unknown[]): any[]; run(...args: unknown[]): { changes: number } };
  pragma(sql: string): unknown;
  close(): void;
};
function openE2eDb(): Sqlite {
  const Database = require('better-sqlite3') as new (file: string, options?: { fileMustExist?: boolean }) => Sqlite;
  const db = new Database(E2E_SQLITE, { fileMustExist: true });
  db.pragma('busy_timeout = 10000');
  return db;
}

/** How many `review.posted` rows the learner has: a count, never a row. */
function reviewRowCount(): number {
  const db = openE2eDb();
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM "notifications" WHERE "userId" = ? AND "kind" = 'review.posted'`).get(S.learnerId).n;
  } finally {
    db.close();
  }
}

/**
 * MACOS-THREADS-ROW (test-only; see the header): the row
 * `onVerdict` writes for a strict Needs revision with one thread, one second
 * after the revision it reports.
 */
function writeThreadsRowSeam(submissionId: string): void {
  const db = openE2eDb();
  try {
    const sub = db.prepare('SELECT "createdAt", "passed", "status" FROM "submissions" WHERE "id" = ? AND "userId" = ?').get(submissionId, S.learnerId);
    if (!sub || sub.status !== 'completed' || Number(sub.passed) !== 0) throw new Error('MACOS-THREADS-ROW: revision 1 is not a completed Needs revision');
    const at = new Date(`${String(sub.createdAt).replace(' ', 'T')}Z`);
    const later = new Date(at.getTime() + 1_000).toISOString().replace('T', ' ').replace('Z', '');
    const written = db
      .prepare(
        `INSERT INTO "notifications" ("id", "userId", "audience", "kind", "subjectKey", "title", "detail", "href", "phaseKey", "actorUserId", "readAt", "createdAt")
         VALUES (?, ?, 'learner', 'review.posted', ?, ?, ?, ?, 'design', NULL, NULL, ?)`,
      )
      .run(
        crypto.randomUUID(),
        S.learnerId,
        submissionId,
        `${S.designTitle}: Needs revision`,
        `1 review thread. ${S.designTitle}, submission 1`,
        `/feedback?phase=${encodeURIComponent(S.design!)}&submission=${encodeURIComponent(submissionId)}`,
        later,
      );
    if (written.changes !== 1) throw new Error('MACOS-THREADS-ROW: the row was not written');
  } finally {
    db.close();
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  const stub = await fetch(`${AI_STUB_URL}/__stub/counts`);
  expect(stub.ok, 'the loopback AI stub answers').toBeTruthy();
  api = await pwRequest.newContext();
  const login = await api.post(`${API}/auth/login`, { data: { email: INSTRUCTOR.email, password: INSTRUCTOR.password } });
  expect(login.ok(), 'the seeded instructor signs in through the API').toBeTruthy();
  staff = { authorization: `Bearer ${(await login.json()).token}` };

  // The shelf fixture as the teacher's draft, with Design's one task marked for sign-off.
  const uploaded = await call('POST', '/instructor/projects/upload', staff, { title: `Sign-off Shelf ${RUN}`, archiveBase64: shelfArchive().toString('base64') });
  expect(uploaded.status(), 'FIX-1 is accepted').toBe(201);
  const made = await uploaded.json();
  const at = `/instructor/projects/${made.projectId}/versions/${made.versionId}`;
  const draft = await ok('GET', at, staff);
  S.slug = draft.slug;
  expect(draft.phases.find((one: any) => one.key === 'requirements')?.tasks ?? [], "FIX-1's Requirements holds one task, the learner's story").toHaveLength(1);
  const designTasks = (draft.phases.find((one: any) => one.key === 'design')?.tasks ?? []) as { taskKey: string }[];
  expect(designTasks, "FIX-1's Design holds one task, the design").toHaveLength(1);
  S.designKey = designTasks[0].taskKey;
  const marked = await ok('PATCH', `${at}/phases/design/tasks/${encodeURIComponent(S.designKey)}`, staff, { signOff: true });
  expect(marked.phase.tasks.map((one: any) => [one.taskKey, one.signOff === true]), "Design's one task is marked").toEqual([[S.designKey, true]]);
  await ok('POST', `${at}/validate`, staff);
  writeDeepReceiptSeam(made.versionId);
  await ok('POST', `${at}/validate`, staff);
  const published = await ok('POST', `${at}/publish`, staff, { version: '1.0.0', notes: 'The sign-off proof publishes FIX-1 with its Design task marked.' });
  const cohort = await ok('POST', '/instructor/cohorts', staff, { name: `Sign-off class ${RUN}` });
  S.cohortId = cohort.id;
  await ok('PUT', `/instructor/cohorts/${cohort.id}/project`, staff, { projectVersionId: published.versionId, reason: 'The sign-off proof class works on the uploaded shelf.' });

  // A learner joins and is on the uploaded project.
  S.learnerEmail = `feedback-signoff-${RUN}@example.test`;
  await ok('POST', '/auth/register', {}, { email: S.learnerEmail, password: LEARNER_PASSWORD, displayName: `Rae Sign ${RUN}` });
  S.learnerToken = (await ok('POST', '/auth/login', {}, { email: S.learnerEmail, password: LEARNER_PASSWORD })).token;
  const me = await ok('GET', '/auth/me', lh());
  S.learnerId = me.id;
  await ok('POST', '/enrollments/join', lh(), { code: cohort.joinCode });
  await ok('POST', '/enrollments', lh(), { projectSlug: S.slug });
  await ok('PATCH', '/account/profile', lh(), { displayName: `Rae Sign ${RUN}`, onboardingCompleted: true, baseVersion: me.profileVersion || 0 });
  const mine = await ok('GET', '/enrollments/mine', lh());
  expect(mine.projectSlug, 'enrolled on the uploaded project').toBe(S.slug);
  const designPhase = (mine.phases ?? []).find((one: any) => one.key === 'design');
  S.design = designPhase.id;
  S.designTitle = designPhase.title;

  // Requirements first, on the shelf's story record (its sole task, unmarked), so Design opens.
  const phases = await passPhaseByApi(api, { headers: lh() }, mine.phases as ApiPhase[], 1, { [STORY_JSON]: shelfStoryRecord(true) }, 'Requirements: the member told me what free to borrow means.');
  expect(phases.find((one) => one.key === 'design')?.status, 'Design opens').not.toBe('locked');
  expect(reviewRowCount(), 'the story passed with no threads, so it wrote no review row').toBe(0);

  // Revision 1: no marker, so the stub returns Needs revision.
  const first = await handIn(false);
  expect(first.passed, 'revision 1 is a Needs revision').toBe(false);
  S.first = first.id;
  expect(reviewRowCount(), 'a design with no threads writes no review row').toBe(0);
  writeThreadsRowSeam(first.id);

  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  ctx.on('response', (res) => {
    if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname.replace(IDS, ':id')}`);
  });
  learner = await ctx.newPage();
  await dismissPhaseTutorial(learner);
  await signInAs(learner, S.learnerEmail!, LEARNER_PASSWORD);
  await learner.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
});

test.afterAll(async () => {
  await ctx?.close();
  await api?.dispose();
});

/** The learner's review rows in the bell (the Design task's), opened from the dashboard. */
async function bellRow() {
  await learner.goto('/dashboard');
  const bell = learner.getByTestId('bell');
  await expect(bell).toBeVisible({ timeout: UI_READY });
  await bell.click();
  const panel = learner.getByTestId('bell-panel');
  await expect(panel).toBeVisible();
  return panel.locator('[data-testid="bell-note"][data-kind="review.posted"]');
}

test('1. after a Needs revision then a thread-less Pass awaiting sign-off, the bell reads Pass and waiting', async () => {
  // Before the Pass the bell reads the Needs revision.
  let rows = await bellRow();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(`${S.designTitle}: Needs revision`);

  // Revision 2: marked, so the stub passes it, and the task waits for the teacher.
  const second = await handIn(true);
  expect(second.passed, 'revision 2 passes').toBe(true);
  S.second = second.id;
  const waiting = await ok('GET', `/phases/${S.design}`, lh());
  expect(waiting.tasks.find((one: any) => one.key === S.designKey)).toMatchObject({ status: 'submitted', awaitingSignOff: true });
  // Emission is unchanged: the thread-less Pass wrote no row.
  expect(reviewRowCount()).toBe(1);

  rows = await bellRow();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(`${S.designTitle}: Pass`);
  await expect(rows.first()).toHaveAttribute('title', new RegExp(WAITING.replace(/[.']/g, (c) => `\\${c}`)));
  await expect(rows.first()).toHaveAttribute('href', `/feedback?phase=${S.design}&submission=${S.second}`);
  const listed = await ok('GET', '/notifications', lh());
  expect(listed.unread, 'the count follows what is listed').toBe(listed.items.length);
  await learner.keyboard.press('Escape');
});

test('2. the teacher signs it off in bulk, with a reason, through the existing route', async () => {
  const result = await ok('POST', `/instructor/cohorts/${S.cohortId}/signoff`, staff, {
    phaseKey: 'design',
    taskKey: S.designKey,
    userIds: [S.learnerId],
    reason: SIGNOFF_REASON,
  });
  expect(result.signedOff).toEqual([S.learnerId]);
  expect(result.refused).toEqual([]);
  // The new read writes nothing and carries no name, email or id.
  const view = await ok('GET', `/submissions/${S.second}/sign-off`, lh());
  expect(view).toEqual({ signedOff: true, reason: SIGNOFF_REASON, signedOffAt: expect.any(String) });
  await expect(ok('GET', `/submissions/${S.first}/sign-off`, lh())).resolves.toMatchObject({ signedOff: false, reason: null });
});

test('3. the learner s feedback page shows the sign-off and the reason; the bell says signed off', async () => {
  await learner.goto(`/feedback?phase=${S.design}&submission=${S.second}`);
  const section = learner.locator('section').filter({ has: learner.getByRole('heading', { name: 'Teacher feedback' }) });
  await expect(section).toContainText(SIGNED, { timeout: UI_READY });
  await expect(section.locator('blockquote', { hasText: SIGNOFF_REASON })).toBeVisible();
  await expect(section).not.toContainText(EMPTY);

  const rows = await bellRow();
  await expect(rows.first()).toContainText(`${S.designTitle}: Pass`);
  await expect(rows.first()).toHaveAttribute('title', new RegExp(SIGNED.replace(/\./g, '\\.')));
  expect(fiveHundreds, 'no 5xx anywhere in this file').toEqual([]);
});
