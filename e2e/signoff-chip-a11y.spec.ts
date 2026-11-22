import { expect, request as pwRequest, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { INSTRUCTOR, passPhaseByApi, type ApiPhase } from './passing-work';
import { dismissPhaseTutorial, LEARNER_PASSWORD, signInAs } from './pw-fixtures';
import { STORY_JSON } from '@learnsdlc/shared';
import {
  shelfArchive,
  PHASE_PASSED_LINE,
  shelfDesignWork,
  shelfStoryRecord,
  SIGNOFF_CHIP,
  SIGNOFF_SUBMIT_REASON,
  writeDeepReceiptSeam,
} from './upload-helpers';
import { AI_STUB_URL, API, assertLoopbackApi, RUN_ID } from './support/env';
import { okBody } from './support/api';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The sign-off chip row. The learner surfaces that say
 * a passed task waits on the teacher's countersignature ("Awaiting your
 * teacher's sign-off"), checked with axe-core at 1280 and at 390.
 *
 * The waiting state is reached the way e2e/teacher-upload.spec.ts step 9
 * reaches it, through the API: the `shelf` fixture project (shelfArchive)
 * uploaded as the seeded instructor's
 * draft, Design's one task, the design, marked "Needs your sign-off" (the
 * editor's own route), published behind the test-only deep-receipt seam,
 * assigned to a new class; a learner joins, passes Requirements on the story
 * record, writes the design as the room's forms write it (the record, with
 * the E2E-PASS marker in its notes, and the API contract), hands it in, and
 * the loopback AI stub passes the review. Design's one task is the
 * countersigned one: a Design phase holds exactly one task, so nothing
 * is added beside it, and Requirements is a story phase whose one work task
 * is the story. No learner code runs (written work only), so this is
 * macOS-safe; no real AI.
 *
 * Surfaces: the Design rooms (the forms' room and the files' room: one task,
 * so no task switcher and no row chip, and Submit off with its reason), the
 * feedback page (the hero), the dashboard (its line, and the
 * bell: one waiting step, never "Submit <Phase> for the gate"), the
 * Design pull request (its headline and the Merge card's waiting words),
 * the generic room's command palette (every Submit row off with its reason),
 * and the teacher's Projects page with "Your starter downloads". At each width:
 * WCAG 2.0 / 2.1 A + AA, serious and critical, 0 violations; at 390 no
 * sideways page scroll. Opening these pages asks the AI nothing. Last, the
 * teacher countersigns the design and it reads Passed.
 *
 * Not this file: the reflow check of the maintenance change room at
 * phone-360 (e2e/a11y-axe.spec.ts).
 */

test.describe.configure({ mode: 'serial' });

assertLoopbackApi(__filename);

const RUN = `${RUN_ID.slice(-8)}${crypto.randomBytes(2).toString('hex')}`;
const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** WCAG 2.0/2.1 A and AA, serious and critical: e2e/a11y-axe.spec.ts's own scope. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const AXE_FAILING = new Set(['serious', 'critical']);
const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const WIDTHS = [
  { label: '1280', width: 1280, height: 900 },
  { label: '390', width: 390, height: 844 },
] as const;

/** apps/web/components/workspace/signoff-status.ts latestFeedbackLine (awaiting arm). */
const dashboardWaitingLine = (phase: string) => `${phase}: your work passed review. Your teacher's countersignature opens the next phase.`;
/** signoff-status.ts latestFeedbackLine, the passed arm: the dashboard's line once the teacher has countersigned. */
const dashboardPassedLine = (phase: string) => `${phase}: your work passed review. Open it to see the evidence it accepted.`;
/** apps/web/components/home/derive.ts buildNextSteps, the waiting step. */
const bellWaitingStep = (phase: string) => `Waiting for your teacher's sign-off on ${phase}`;
/** A step the waiting state must not show (derive.ts "nothing submitted" arm). */
const SUBMIT_FOR_GATE = /Submit .+ for the gate/;
/** apps/web/components/pr/MergeCard.tsx SIGN_OFF_PURPOSE / SIGN_OFF_PLACEHOLDER. */
const MERGE_WAITING_PURPOSE = "Your work passed review. Your teacher's countersignature opens the next phase. You may leave an optional note about what changed and why.";
const MERGE_WAITING_PLACEHOLDER = 'Record what you changed and learned, or leave it blank.';
/** A purpose MergeCard must not show while waiting: it promises a Merge the learner cannot press. */
const MERGE_OLD_PURPOSE = 'A Pass lets you complete this phase';
/** apps/web/components/pr/headline.ts prHeadline on the shelf fixture's Design phase: an uploaded room is titled with its own intro's opening paragraph. */
const PR_HEADLINE = 'PR-2: Write down what the shelf API answers before anyone builds it: every operation, every refusal, one decision.';
/** apps/web/components/staff/guide/DownloadHistory.tsx. */
const DOWNLOADS_LABEL = 'Your starter downloads';
/** apps/workflow: the gate's refusal while a task waits on its countersignature. */
const ADVANCE_BEFORE_COUNTERSIGN = 'This phase must pass before advancing.';

const S: {
  projectId?: string;
  versionId?: string;
  slug?: string;
  mainKey?: string;
  cohortId?: string;
  learnerId?: string;
  design?: string;
  designTitle?: string;
  designSubmission?: string;
  learnerEmail?: string;
  learnerToken?: string;
} = {};

let api: APIRequestContext;
let staff: { authorization: string };
let ctx: BrowserContext;
let learner: Page;
let stubBeforeFixture: Record<string, number> = {};
let stubAfterFixture: Record<string, number> = {};
const fiveHundreds: string[] = [];
const evidence: Record<string, unknown> = {};

async function stubCounts(): Promise<Record<string, number>> {
  const res = await fetch(`${AI_STUB_URL}/__stub/counts`);
  if (!res.ok) throw new Error(`the AI stub did not answer its counts (${res.status})`);
  return ((await res.json()).counts ?? {}) as Record<string, number>;
}

/**
 * What the stub was asked between two of its count snapshots: every call kind whose count moved,
 * with how far (sorted by kind). The project shares one stub across every spec of an invocation,
 * so this file reads its own window, never the stub's whole-life counts.
 */
function stubDelta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const moved: Record<string, number> = {};
  for (const kind of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const by = (after[kind] ?? 0) - (before[kind] ?? 0);
    if (by !== 0) moved[kind] = by;
  }
  return moved;
}

async function call(method: string, route: string, headers: Record<string, string>, data?: unknown) {
  const res = await api.fetch(`${API}${route}`, { method, headers, data });
  if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${method} ${route.replace(IDS, ':id')}`);
  return res;
}

async function ok(method: string, route: string, headers: Record<string, string>, data?: unknown) {
  return okBody(await call(method, route, headers, data), method, route);
}

async function sideways(page: Page) {
  return page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
}

type Violation = { id: string; impact: string | null; count: number; targets: string[] };

/** axe-core, injected into the page; with `openDetails`, every <details> is opened first (as e2e/teacher-guide.spec.ts does). */
async function runAxe(page: Page, openDetails: boolean): Promise<Violation[]> {
  if (openDetails) await page.evaluate(() => document.querySelectorAll('details').forEach((one) => ((one as HTMLDetailsElement).open = true)));
  await page.evaluate(AXE_SOURCE);
  const all = await page.evaluate(
    async (tags) => {
      const axe = (window as unknown as { axe: any }).axe;
      const r = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
      return r.violations.map((v: any) => ({
        id: v.id,
        impact: v.impact ?? null,
        count: v.nodes.length,
        targets: v.nodes.map((n: any) => [].concat(n.target).join(' ')),
      }));
    },
    AXE_TAGS,
  );
  return all.filter((one: Violation) => AXE_FAILING.has(one.impact ?? ''));
}

/**
 * A known exception, outside the chip row: the feedback page's
 * submitted-file viewer (apps/web/components/experience/SubmissionEvidence.tsx)
 * draws each file as <details><pre>; once a learner opens one
 * whose lines are wider than the box (a story line), the <pre> scrolls sideways and is not
 * focusable (axe scrollable-region-focusable, serious). Only with the <details> opened, only
 * that rule, only on that viewer's <pre>; the page as it lands stays held to 0.
 */
const KNOWN_OPEN_DETAILS = (one: Violation) =>
  one.id === 'scrollable-region-focusable' &&
  one.targets.length > 0 &&
  one.targets.length === one.count &&
  one.targets.every((t) => /^#submitted-file-\S+ > pre$/.test(t));

/**
 * A surface at one width: ready, then axe clean as it lands and again with every <details>
 * opened (`known` names the classified pre-existing rows of the opened pass), and at 390 no
 * sideways page scroll.
 */
async function check(page: Page, surface: string, width: (typeof WIDTHS)[number], ready: () => Promise<void>, known?: (one: Violation) => boolean) {
  await page.setViewportSize({ width: width.width, height: width.height });
  await ready();
  // fonts and late layout settle before axe reads contrast and size
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  const landed = await runAxe(page, false);
  const box = await sideways(page);
  const opened = await runAxe(page, true);
  const knownOpen = known ? opened.filter(known) : [];
  evidence[`${surface}@${width.label}`] = { landed, opened, knownPreExisting: knownOpen, width: box };
  expect(landed, `${surface} at ${width.label}: axe serious/critical, as the page lands`).toEqual([]);
  expect(opened.filter((one) => !knownOpen.includes(one)), `${surface} at ${width.label}: axe serious/critical, every <details> open`).toEqual([]);
  if (width.width === 390) expect(box.scroll, `${surface} at 390: no sideways page scroll`).toBeLessThanOrEqual(box.client);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  // serial, one worker: nothing else asks the stub between this snapshot and the end of the file
  stubBeforeFixture = await stubCounts();
  api = await pwRequest.newContext();
  const login = await api.post(`${API}/auth/login`, { data: { email: INSTRUCTOR.email, password: INSTRUCTOR.password } });
  expect(login.ok(), 'the seeded instructor signs in through the API').toBeTruthy();
  staff = { authorization: `Bearer ${(await login.json()).token}` };

  // The shelf fixture as the teacher's draft.
  const uploaded = await call('POST', '/instructor/projects/upload', staff, { title: `Chip Shelf ${RUN}`, archiveBase64: shelfArchive().toString('base64') });
  expect(uploaded.status(), 'FIX-1 is accepted').toBe(201);
  const made = await uploaded.json();
  S.projectId = made.projectId;
  S.versionId = made.versionId;
  const at = `/instructor/projects/${S.projectId}/versions/${S.versionId}`;
  const draft = await ok('GET', at, staff);
  S.slug = draft.slug;
  const reqTasks = (draft.phases.find((one: any) => one.key === 'requirements')?.tasks ?? []) as { taskKey: string }[];
  expect(reqTasks, "FIX-1's Requirements holds one task, the learner's story").toHaveLength(1);

  const designTasks = (draft.phases.find((one: any) => one.key === 'design')?.tasks ?? []) as { taskKey: string }[];
  expect(designTasks, "FIX-1's Design holds one task, the design").toHaveLength(1);
  S.mainKey = designTasks[0].taskKey;

  // Design's one task is the countersigned one, marked by the editor's own route.
  const marked = await ok('PATCH', `${at}/phases/design/tasks/${encodeURIComponent(S.mainKey!)}`, staff, { signOff: true });
  expect(marked.phase.tasks.map((one: any) => [one.taskKey, one.signOff === true]), "Design's one task is marked").toEqual([[S.mainKey, true]]);

  // Publish behind the test-only deep-receipt seam (macOS runs no learner code).
  await ok('POST', `${at}/validate`, staff);
  writeDeepReceiptSeam(S.versionId!);
  await ok('POST', `${at}/validate`, staff);
  const published = await ok('POST', `${at}/publish`, staff, { version: '1.0.0', notes: 'The chip row publishes FIX-1 with its Design task marked.' });
  const cohort = await ok('POST', '/instructor/cohorts', staff, { name: `Chip class ${RUN}` });
  S.cohortId = cohort.id;
  await ok('PUT', `/instructor/cohorts/${cohort.id}/project`, staff, { projectVersionId: published.versionId, reason: 'The chip row class works on the uploaded shelf.' });

  // A learner joins and is on the uploaded project.
  S.learnerEmail = `signoff-chip-${RUN}@example.test`;
  await ok('POST', '/auth/register', {}, { email: S.learnerEmail, password: LEARNER_PASSWORD, displayName: `Ren Chip ${RUN}` });
  S.learnerToken = (await ok('POST', '/auth/login', {}, { email: S.learnerEmail, password: LEARNER_PASSWORD })).token;
  const lh = { authorization: `Bearer ${S.learnerToken}` };
  const me = await ok('GET', '/auth/me', lh);
  S.learnerId = me.id;
  await ok('POST', '/enrollments/join', lh, { code: cohort.joinCode });
  // as e2e/a11y-axe.spec.ts's sign-off fixture: the class's project is opened by its slug
  await ok('POST', '/enrollments', lh, { projectSlug: S.slug });
  await ok('PATCH', '/account/profile', lh, { displayName: `Ren Chip ${RUN}`, onboardingCompleted: true, baseVersion: me.profileVersion || 0 });
  const mine = await ok('GET', '/enrollments/mine', lh);
  expect(mine.projectSlug, 'enrolled on the uploaded project').toBe(S.slug);
  const designPhase = (mine.phases ?? []).find((one: any) => one.key === 'design');
  S.design = designPhase.id;
  S.designTitle = designPhase.title;

  const handIn = async (phaseId: string, key: string) => {
    const handed = await ok('POST', `/phases/${phaseId}/tasks/${encodeURIComponent(key)}/submit`, lh);
    let done: any = null;
    await expect
      .poll(async () => {
        done = await ok('GET', `/submissions/${handed.id}`, lh);
        return done.status;
      }, { timeout: 180_000, intervals: [500, 1_000] })
      .toMatch(/^(completed|failed)$/);
    expect(done.passed, `${key} passes its review through the stub`).toBe(true);
    return handed.id as string;
  };

  // Requirements first: the story record (the phase's sole task, unmarked), so Design opens.
  const phases = await passPhaseByApi(api, { headers: lh }, mine.phases as ApiPhase[], 1, { [STORY_JSON]: shelfStoryRecord(true) }, 'Requirements: the member told me what free to borrow means.');
  expect(phases.find((one) => one.key === 'design')?.status, 'Design opens').not.toBe('locked');

  // The design handed in with the marker: the stub passes the review, and it waits.
  await ok('PUT', `/phases/${S.design}/workspace`, lh, { files: shelfDesignWork(true) });
  S.designSubmission = await handIn(S.design!, S.mainKey!);
  stubAfterFixture = await stubCounts();

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
  const after = await stubCounts().catch(() => ({}));
  fs.mkdirSync(test.info().outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(test.info().outputDir, 'signoff-chip-evidence.json'),
    JSON.stringify({ aiStub: { beforeFixture: stubBeforeFixture, afterFixture: stubAfterFixture, atEnd: after }, evidence }, null, 2),
    { mode: 0o600 },
  );
  await ctx?.close();
  await api?.dispose();
});

test('1. the marked Design task passed its review and waits; the gate stays shut', async () => {
  const lh = { authorization: `Bearer ${S.learnerToken}` };
  const waiting = await ok('GET', `/phases/${S.design}`, lh);
  const tasks = waiting.tasks as { key: string; status: string; awaitingSignOff: boolean }[];
  expect(tasks.map((one) => [one.key, one.status, one.awaitingSignOff])).toEqual([[S.mainKey!, 'submitted', true]]);
  const early = await call('POST', `/phases/${S.design}/advance`, lh);
  expect(early.status(), 'the phase does not open before the countersignature').toBe(400);
  expect((await early.json()).message).toBe(ADVANCE_BEFORE_COUNTERSIGN);
});

for (const width of WIDTHS) {
  test(`2. the Design room at ${width.label}: one task, no switcher, Submit off with its reason, axe clean`, async () => {
    // The forms' room is the learner's one door into a design phase: the phase's bare path, with or without
    // ?task=, sends a phase that holds a design record to /design (the workspace layout), so no files' room is
    // drawn beside it.
    const rooms: [string, string, string][] = [['design-room-forms', `/workspace/${S.design}/design`, 'design-submit']];
    for (const [name, at, submitId] of rooms) {
      await learner.setViewportSize({ width: width.width, height: width.height });
      await learner.goto(at);
      const submit = learner.getByTestId(submitId);
      await check(learner, name, width, async () => {
        await expect(learner.locator('main#main')).toBeVisible({ timeout: NAVIGATION });
        // Design holds one task, so the room draws no task switcher and no row chip (TaskPanel).
        await expect(learner.getByTestId('task-switcher'), 'one task, no switcher').toHaveCount(0);
        await expect(submit, 'nothing to resubmit').toBeDisabled({ timeout: NAVIGATION });
        await expect(submit, 'the reason is the sign-off reason').toHaveAccessibleDescription(SIGNOFF_SUBMIT_REASON);
      });
    }
  });
}

for (const width of WIDTHS) {
  test(`3. the feedback page at ${width.label}: the hero says the work waits on the teacher, axe clean`, async () => {
    await learner.setViewportSize({ width: width.width, height: width.height });
    await learner.goto(`/feedback?phase=${S.design}`);
    await check(learner, 'feedback', width, async () => {
      const hero = learner.locator('.exp-result-hero h2');
      await expect(hero).toHaveText(`${SIGNOFF_CHIP}.`, { timeout: NAVIGATION });
      await expect(learner.locator('main#main')).not.toContainText('is ready to build on');
      await expect(learner.locator('main#main')).not.toContainText('Continue to the next phase');
    }, KNOWN_OPEN_DETAILS);
  });
}

for (const width of WIDTHS) {
  test(`4. the dashboard and its bell at ${width.label}: the waiting line, one waiting step, never "for the gate", axe clean`, async () => {
    await learner.setViewportSize({ width: width.width, height: width.height });
    await learner.goto('/dashboard');
    await check(learner, 'dashboard', width, async () => {
      await expect(learner.locator('main#main')).toContainText(dashboardWaitingLine(S.designTitle!), { timeout: NAVIGATION });
      await expect(learner.locator('main#main')).not.toContainText(SUBMIT_FOR_GATE);
    });
    await learner.getByTestId('bell').click();
    const panel = learner.getByTestId('bell-panel');
    await check(learner, 'dashboard-bell-open', width, async () => {
      await expect(panel).toBeVisible({ timeout: UI_READY });
      // the panel's opening transition ends before axe measures its colours
      await panel.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((one) => one.finished.catch(() => undefined))));
      // one row (phase mark, the step's title, its meta): the step is the wait
      await expect(panel.getByTestId('bell-item'), 'one step').toHaveCount(1, { timeout: UI_READY });
      await expect(panel.getByTestId('bell-item').locator('span.truncate'), 'the step is the wait').toHaveText(bellWaitingStep(S.designTitle!));
      await expect(panel).not.toContainText(SUBMIT_FOR_GATE);
      await expect(panel).not.toContainText('Nothing has been submitted yet');
    });
    await learner.keyboard.press('Escape');
  });
}

for (const width of WIDTHS) {
  test(`5. the Design pull request at ${width.label}: the headline and the Merge card's waiting words, axe clean`, async () => {
    await learner.setViewportSize({ width: width.width, height: width.height });
    await learner.goto(`/workspace/${S.design}/pr`);
    await check(learner, 'design-pr', width, async () => {
      const main = learner.locator('main#main');
      await expect(main).toContainText(PR_HEADLINE, { timeout: NAVIGATION });
      await expect(main).not.toContainText('US-4');
      await expect(main).toContainText(MERGE_WAITING_PURPOSE, { timeout: UI_READY });
      await expect(main).not.toContainText(MERGE_OLD_PURPOSE);
      await expect(learner.getByTestId('reflection-input')).toHaveAttribute('placeholder', MERGE_WAITING_PLACEHOLDER);
    });
  });
}

for (const width of WIDTHS) {
  test(`6. the countersigned design's command palette at ${width.label}: no Submit row is on, any one says the sign-off reason, axe clean`, async () => {
    await learner.setViewportSize({ width: width.width, height: width.height });
    // The Design room is the phase's one door (the bare path sends a design phase here), and its palette names
    // the operations and decisions, with no Submit row of its own; the check is that no row offers a Submit
    // around the room's own, which is off.
    await learner.goto(`/workspace/${S.design}/design`);
    await expect(learner.getByTestId('design-submit'), 'the room is ready, Submit off').toBeDisabled({ timeout: NAVIGATION });
    await check(learner, 'design-palette', width, async () => {
      await learner.keyboard.press('Control+k');
      const input = learner.getByTestId('palette-input');
      await expect(input).toBeVisible({ timeout: 10_000 });
      await input.fill('submit');
      const submitRows = () =>
        learner
          .locator('[data-testid^="palette-row-"]')
          .evaluateAll((els) => els.map((one) => ({ text: (one as HTMLElement).innerText.trim(), ariaDisabled: one.getAttribute('aria-disabled') })))
          .then((all) => all.filter((one) => one.text.split('\n')[0].trim().startsWith('Submit')));
      // The palette answers the query before any Submit row is read (its rows, or its "No matches" line), so an
      // empty list is the palette's answer and not a list still loading.
      const answered = learner.locator('[data-testid^="palette-row-"], [data-testid="palette"] [role="status"]').first();
      await expect(answered, 'the palette answers the query').toBeVisible({ timeout: 10_000 });
      const seen = await submitRows();
      evidence[`design-palette-rows@${width.label}`] = seen;
      for (const row of seen) {
        expect(row.ariaDisabled, `palette row "${row.text.split('\n')[0]}" is off`).toBe('true');
        expect(row.text, 'the row says why').toContain(SIGNOFF_SUBMIT_REASON);
      }
    });
    await learner.keyboard.press('Escape');
  });
}

test("7. the teacher's Projects page with Your starter downloads at 1280 and 390, axe clean", async ({ browser }) => {
  // Both archives downloaded by the seeded instructor through the guide's own route (GET /instructor/starter/:name).
  for (const name of ['starter', 'shelf']) {
    const res = await call('GET', `/instructor/starter/${name}`, staff);
    expect(res.status(), `the ${name} archive downloads`).toBe(200);
  }
  const tctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  tctx.on('response', (res) => {
    if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname.replace(IDS, ':id')}`);
  });
  try {
    const teacher = await tctx.newPage();
    await signInAs(teacher, INSTRUCTOR.email, INSTRUCTOR.password);
    await teacher.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
    for (const width of WIDTHS) {
      await teacher.setViewportSize({ width: width.width, height: width.height });
      await teacher.goto('/teacher/projects');
      await check(teacher, 'teacher-projects-downloads', width, async () => {
        await expect(teacher.getByTestId('projects-loading')).toHaveCount(0, { timeout: NAVIGATION });
        const history = teacher.getByTestId('guide-download-history');
        await expect(history).toBeVisible({ timeout: UI_READY });
        await expect(history).toHaveAccessibleName(DOWNLOADS_LABEL);
        await expect(teacher.getByTestId('guide-download-history-starter')).toContainText('You downloaded the starter archive on');
        await expect(teacher.getByTestId('guide-download-history-shelf')).toContainText('You downloaded the shelf example on');
      });
    }
  } finally {
    await tctx.close();
  }
});

test('8. opening the waiting surfaces asked the AI nothing', async () => {
  // one stub serves every spec of the invocation, so the claim is read as deltas over this file's own
  // window: the fixture's two reviews (the story, then the design), and nothing at all
  // (no call kind moved) from the fixture to here
  expect(stubDelta(stubBeforeFixture, stubAfterFixture), 'the fixture asked for the two reviews only').toEqual({ 'grading.review': 2 });
  expect(stubDelta(stubAfterFixture, await stubCounts()), 'the waiting surfaces asked the AI nothing').toEqual({});
});

test("9. after the teacher's countersignature the design reads Passed", async () => {
  // Before: the dashboard says the design waits on the teacher. No page draws a
  // phase chip, so the dashboard's latest-feedback line is the learner's
  // phase-level word for the same state.
  await learner.setViewportSize({ width: 1280, height: 900 });
  await learner.goto('/dashboard');
  await expect(learner.locator('main#main'), 'before: the dashboard waits').toContainText(dashboardWaitingLine(S.designTitle!), { timeout: NAVIGATION });
  // The bulk sign-off route the teacher's queue uses; it asks the AI nothing.
  const signed = await ok('POST', `/instructor/cohorts/${S.cohortId}/signoff`, staff, {
    phaseKey: 'design',
    taskKey: S.mainKey,
    userIds: [S.learnerId],
    reason: `Read in the Tuesday lab ${RUN}: the member's words are recorded faithfully.`,
  });
  expect(signed.signedOff, 'the design is countersigned').toEqual([S.learnerId]);
  const lh = { authorization: `Bearer ${S.learnerToken}` };
  const after = await ok('GET', `/phases/${S.design}`, lh);
  expect(after.tasks.map((one: any) => [one.key, one.status, one.awaitingSignOff]), 'the design reads Passed and no longer waits').toEqual([[S.mainKey, 'passed', false]]);
  await learner.setViewportSize({ width: 1280, height: 900 });
  await learner.goto(`/feedback?phase=${S.design}`);
  const hero = learner.locator('.exp-result-hero h2');
  await expect(hero).toBeVisible({ timeout: NAVIGATION });
  await expect(hero, 'the hero no longer waits').not.toHaveText(`${SIGNOFF_CHIP}.`, { timeout: UI_READY });
  // The design's review page reads the ordinary Pass, and the dashboard the passed line. A Design phase is its
  // design room, which draws no Review tab: the verdict is read where the room sends the learner after a
  // submit, the review page for that submission (feedback/page.tsx's hero).
  await learner.goto(`/feedback?phase=${encodeURIComponent(S.design!)}&submission=${encodeURIComponent(S.designSubmission!)}`);
  await expect(learner.locator('.exp-result-main h2'), 'the design no longer waits').toHaveText('Design is ready to build on.', { timeout: NAVIGATION });
  await expect(learner.locator('.exp-result-main > p'), 'the ordinary Pass line').toHaveText(PHASE_PASSED_LINE);
  await learner.goto('/dashboard');
  const main = learner.locator('main#main');
  await expect(main, 'after: the dashboard reads Pass').toContainText(dashboardPassedLine(S.designTitle!), { timeout: NAVIGATION });
  await expect(main, 'after: nothing waits').not.toContainText(dashboardWaitingLine(S.designTitle!));
});

test('no response anywhere had a status of 500 or more', async () => {
  expect(fiveHundreds).toEqual([]);
});
