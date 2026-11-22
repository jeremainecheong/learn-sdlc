import { expect, request as pwRequest, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { STORY_JSON } from '@learnsdlc/shared';
import { INSTRUCTOR, passPhaseByApi, type ApiPhase } from './passing-work';
import { dismissPhaseTutorial, registerIntoClass, registerIntoClassWith, signInAs, teacherHome, createClassFromTeacherHome } from './pw-fixtures';
import {
  APP_PREVIEW_NOT_OFFERED_SENTENCE,
  captureMasked,
  JourneyBodies,
  journeyBodiesRoot,
  NOT_A_PACK_SENTENCE,
  notAPackArchive,
  SOLUTION_MOUNT_SENTENCE,
  costWarning,
  deepReceiptRefusal,
  exportSavedSentence,
  shelfArchive,
  found,
  HIDDEN_NAME_SENTENCE,
  hostilePathClimbArchive,
  PATH_CLIMB_SENTENCE,
  PHASE_PASSED_LINE,
  QUIZ_HEADERS,
  sealMarker,
  sha256Hex,
  shelfDesignWork,
  shelfStoryRecord,
  SHELF_MARKER_VALUES,
  SIGN_OFF_HELP,
  SIGN_OFF_LABEL,
  signOffSaved,
  SIGNOFF_CHIP,
  SIGNOFF_PASS_LINE,
  SIGNOFF_QUEUE_EMPTY_BODY,
  SIGNOFF_QUEUE_EMPTY_IN_USE_BODY,
  SIGNOFF_SUBMIT_REASON,
  signOffSplitLine,
  TASKTRACKR_WORDS,
  unavailableSentence,
  writeDeepReceiptSeam,
  shelfRefusalArchives,
} from './upload-helpers';
// The archive writer, for the runtime-outside-allow-lists archive built below from the shelf fixture (hostile.ts imports the shared package).
import { entriesOf, writeZip } from '../apps/api/test/fixtures/upload-packs/archive';
import { SHELF_DIR } from '../apps/api/test/fixtures/upload-packs/markers';
import { AI_STUB_URL, API, API_ORIGIN, assertLoopbackApi, RUN } from './support/env';
import { NAVIGATION, SANDBOX_RUN, UI_READY } from './support/timeouts';

/**
 * The teacher-upload journey in a browser, on the
 * local stack (the config's webServer: the loopback AI stub, the built API on
 * a fresh sqlite file with RUNNER_MODE=local, and the built web).
 *
 * One teacher and one learner, in order, each step its own test:
 *
 *  1. the seeded instructor signs in;
 *  2. /teacher/projects: the runtime profile line; a hostile archive refused
 *     by its sentence with no draft made; the `shelf` fixture uploaded, and
 *     its draft opens;
 *  3. a task's title and brief edited, and still there after a reload;
 *  4. the executable editor: a hidden file with a helper's name refused, then
 *     a test file sealed and shown as path, digest and size only;
 *  5. deep validation: the cost warning before the start enables, and the
 *     host's sentence (macOS runs no learner code);
 *  6. Design's one task, the design, marked "Needs your sign-off" by the
 *     toggle on its builder's floor card (a Design phase holds exactly one
 *     task, so nothing is added beside it); publish: refused without a deep receipt, then
 *     (MACOS-DEEP-RECEIPT, a test-only seam) published as 1.0.0;
 *  7. a class, with the version assigned on the class page;
 *  8. a learner registers, joins with the code and is on the uploaded project;
 *  9. the countersigned design, written as the room's forms write it (the
 *     record and the API contract), failed, passed, queued (reached by the
 *     home page's link), refused without a reason, signed in bulk, and the
 *     phase passes;
 * 10. rooms 3-6, opened for rendering by the reopen lever, show the shelf files
 *     and no TaskTrackr word and no sealed marker;
 * 11. the four quiz-results files, by name and header;
 * 12. a fresh shelf draft marked by the toggle, exported, and the
 *     archive uploaded again as a new draft whose toggle reads on.
 *
 * No real AI: every model request goes to e2e/ai-stub.cjs, which beforeAll
 * proves is answering. No status of 500 or more anywhere (asserted
 * last). Nothing here prints an address, a token or an id.
 *
 * Evidence hygiene: every screenshot goes through `captureMasked` (the join
 * code is masked, and a frame that would show it is never written); every body
 * the journey greps, and every API response the learners' pages receive, is
 * saved with a manifest for `node e2e/journey-regrep.mjs`. Also walked here: an
 * archive that is not a pack, Show the files on the uploaded draft, and a
 * second learner, so the bulk sign-off writes one audit row per learner.
 */

test.describe.configure({ mode: 'serial' });

assertLoopbackApi(__filename);

const TITLE = `Shelf ${RUN}`;
const CLASS_NAME = `Upload class ${RUN}`;
/** apps/api/src/workflow/workflow.service.ts advance: the phase is not passed while a task waits for its countersignature (pinned from a run). */
const ADVANCE_BEFORE_COUNTERSIGN = 'This phase must pass before advancing.';
/** apps/api/src/authoring/sealed-roles.ts SEALED_FOLDER_REFUSAL (the seal door's own sentence). */
const SEAL_FOLDER_SENTENCE = (at: string) =>
  `"${at}" is not under a folder, so an export of this project could not put it back where it is read. Put it under a folder, such as tests/${at}, and seal it again.`;
/** packages/shared/src/upload-contract.ts UPLOAD_REFUSALS.RUNTIME_OUTSIDE_PROFILE (SUPPORTED_STACKS_SENTENCE from authoring.ts). */
const RUNTIME_OUTSIDE_SENTENCE =
  'This project asks for a library this deployment does not bake. This deployment runs Flask and React. Adding a library is a platform change, not a content change. Nothing was imported.';
/** apps/api/src/authoring/upload-limits.ts checkRuntimeProfile, as recorded in apps/api/test/fixtures/contract-exchanges/upload.json (refusedRuntime). */
const RUNTIME_OUTSIDE_DETAIL =
  'project.runtime asks for requests, which is outside the runtime this deployment bakes. Use only the packages the runtime profile lists, and upload again.';
/** The runtime-outside-allow-lists archive: the shelf fixture whose project.json pins a Python package the runner does not bake. */
function runtimeOutsideArchive(): Buffer {
  return writeZip(
    entriesOf(SHELF_DIR).map((entry) => {
      if (entry.name !== 'project.json') return entry;
      const project = JSON.parse(entry.data.toString('utf8'));
      project.runtime.python.packages.push('requests==2.32.3');
      return { ...entry, data: Buffer.from(`${JSON.stringify(project, null, 2)}\n`) };
    }),
  );
}
const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** What the steps hand each other. Ids only; never a password or a token. */
const S: {
  projectId?: string;
  draftVersionId?: string;
  slug?: string;
  soleTaskKey?: string;
  designTaskKey?: string;
  designTaskTitle?: string;
  publishedVersionId?: string;
  cohortId?: string;
  joinCode?: string;
  learnerId?: string;
  learnerToken?: string;
  phases?: Record<string, string>;
  /** Learner A's and learner B's phases as the enrolment lists them (with their order), for passPhaseByApi. */
  phaseList?: ApiPhase[];
  learnerBPhaseList?: ApiPhase[];
  sealMarker?: string;
  learnerBId?: string;
  learnerBToken?: string;
  learnerBRequirements?: string;
  learnerBDesign?: string;
  soleTaskTitle?: string;
  teacherId?: string;
} = {};

let teacherCtx: BrowserContext;
let learnerCtx: BrowserContext;
let learnerBCtx: BrowserContext;
let teacher: Page;
let learner: Page;
let learnerB: Page;
/** Every grepped body, and the learners' API responses, saved for journey-regrep. */
let bodies: JourneyBodies;
/** How the run ended, written into the epoch's manifest so journey-regrep refuses a partial epoch. */
const outcomes: { title: string; status: string }[] = [];
let reachedEnd = false;
/** A masked frame of this epoch, with the run's join code as the scan's needle. */
async function frame(page: Page, name: string) {
  const file = bodies.framePath(name);
  await captureMasked(page, file, S.joinCode ? [S.joinCode] : []);
  bodies.recordFrame(file);
}
let api: APIRequestContext;
let staffHeaders: { authorization: string };
let stubAtStart = '';
const fiveHundreds: string[] = [];

const redact = (url: string) => {
  const u = new URL(url);
  return `${u.pathname.replace(IDS, ':id')}`;
};

function watch(ctx: BrowserContext) {
  ctx.on('response', (res) => {
    if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${res.request().method()} ${redact(res.url())}`);
  });
}

async function stubCounts(): Promise<Record<string, number>> {
  const res = await fetch(`${AI_STUB_URL}/__stub/counts`);
  if (!res.ok) throw new Error(`the AI stub did not answer its counts (${res.status})`);
  return ((await res.json()).counts ?? {}) as Record<string, number>;
}

/** A call to the API with a status check that records a 5xx like the browser's. */
async function call(method: string, route: string, headers: Record<string, string>, data?: unknown) {
  const res = await api.fetch(`${API}${route}`, { method, headers, data });
  if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${method} ${route.replace(IDS, ':id')}`);
  return res;
}

/** Whether this host's runner isolates learner code (/health/ready's isolation probe). Read with
 *  api.fetch, not call: a macOS host answers the probe 503, which is not a journey failure. */
async function hostIsolates(): Promise<boolean> {
  const res = await api.fetch(`${API}/health/ready`);
  const body = (await res.json().catch(() => ({}))) as { dependencies?: { name: string; ok: boolean }[] };
  return body.dependencies?.find((one) => one.name === 'isolation')?.ok === true;
}

/** The page's own text, without the platform's help links (plan m5). */
async function learnerPageText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement;
    for (const link of Array.from(body.querySelectorAll('a[href^="/learn"], a[href*="help"], a[href^="/how-it-works"], a[href^="/what-you-learn"]'))) link.remove();
    return body.innerText;
  });
}

async function openPhaseTab(page: Page, key: string) {
  await page.getByTestId(`project-phase-tab-${key}`).click();
  // The phase's label sits inside its tab in the editor's one row of section tabs.
  await expect(page.getByTestId(`project-section-${key}`)).toHaveAttribute('aria-selected', 'true');
}

/**
 * 'projects.upload' is @RateLimit(5, 60) (apps/api/src/authoring/authoring.controller.ts),
 * so a sixth upload inside a minute is a 429, which the door says as a generic
 * refusal. The journey uploads seven archives; it waits rather than meet it.
 * Each upload is stamped right before its submit is pressed (the server's
 * window starts at the first POST), and the sixth waits 62 s from the stamp of
 * the fifth-last. The window is the instructor's, not this file's: the specs
 * run just before this one in the same invocation upload as the same
 * instructor (a11y-axe.spec.ts makes its upload fixture in its last screens,
 * signoff-chip-a11y.spec.ts and feedback-signoff.spec.ts each upload
 * FIX-1 in their beforeAll), so this file's beforeAll counts those three as
 * spent in the minute it starts.
 */
const uploadTimes: number[] = [];
async function paceUploads(page: Page) {
  const now = Date.now();
  const recent = uploadTimes.filter((at) => now - at < 62_000);
  if (recent.length >= 5) await page.waitForTimeout(62_000 - (now - recent[recent.length - 5]));
  uploadTimes.push(Date.now());
}

async function uploadThroughDoor(page: Page, title: string, name: string, buffer: Buffer) {
  if (!(await page.getByTestId('projects-upload').isVisible().catch(() => false))) {
    await page.getByTestId('projects-upload-open').click();
  }
  await expect(page.getByTestId('projects-upload')).toBeVisible();
  await page.getByTestId('projects-upload-title').fill(title);
  await page.getByTestId('projects-upload-file').setInputFiles({ name, mimeType: 'application/zip', buffer });
  await paceUploads(page);
  await page.getByTestId('projects-upload-submit').click();
}

/**
 * Mark one task "Needs your sign-off" with the editor's own
 * toggle, found by its label on the task's row, and wait for the save the page
 * announces. The draft view then reads the mark.
 */
async function markSignOffInEditor(page: Page, phaseKey: string, taskKey: string, taskTitle: string, at: { projectId: string; versionId: string }) {
  await openPhaseTab(page, phaseKey);
  await expect(page.getByTestId(`task-signoff-help-${phaseKey}`)).toHaveText(SIGN_OFF_HELP, { timeout: UI_READY });
  const box = page.getByTestId(`task-signoff-box-${taskKey}`).getByLabel(SIGN_OFF_LABEL, { exact: true });
  await expect(box).not.toBeChecked({ timeout: UI_READY });
  await box.check();
  await expect(page.getByTestId('project-live')).toHaveText(signOffSaved(taskTitle), { timeout: UI_READY });
  await expect(box).toBeChecked();
  const draft = await (await call('GET', `/instructor/projects/${at.projectId}/versions/${at.versionId}`, staffHeaders)).json();
  const marks = (draft.phases.find((one: any) => one.key === phaseKey)?.tasks ?? []).map((one: any) => [one.taskKey, one.signOff === true]);
  expect(marks.filter(([key]: [string]) => key === taskKey), 'the draft view reads the mark').toEqual([[taskKey, true]]);
  expect(marks.filter(([key]: [string]) => key !== taskKey).every(([, on]: [string, boolean]) => !on), 'only that task is marked').toBe(true);
}

const editorPattern = /\/teacher\/projects\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})$/;

/**
 * The accepted upload's draft. The door opens it at once, or, when the upload
 * changed something on its way in, says what first and opens it from "Open
 * the draft" (as `e2e/export-roundtrip.spec.ts` takes it). A refusal fails
 * here with its own sentence. The warnings come back for the caller to
 * assert: the Shelf fixture is plain and in the folder layout (TaskTrackr
 * 6.0.0's family), so its uploads, and the upload of its export, open at once.
 */
async function openUploadedDraft(page: Page): Promise<{ projectId: string; versionId: string; warnings: string[] }> {
  const onEditor = () => editorPattern.test(new URL(page.url()).pathname);
  const warned = page.getByTestId('projects-upload-warnings');
  const refused = page.getByTestId('projects-upload-refusal-sentence');
  await expect
    .poll(async () => (onEditor() ? 'editor' : (await warned.isVisible()) ? 'warnings' : (await refused.isVisible()) ? `refused: ${await refused.innerText()}` : 'waiting'), {
      message: 'the upload is accepted',
      timeout: SANDBOX_RUN,
    })
    .toMatch(/^(editor|warnings)$/);
  let warnings: string[] = [];
  if (!onEditor()) {
    warnings = (await page.locator('[data-testid^="projects-upload-warning-"]').allInnerTexts()).map((one) => one.trim());
    await page.getByTestId('projects-upload-open-draft').click();
    await page.waitForURL(editorPattern, { timeout: NAVIGATION });
  }
  const [, projectId, versionId] = editorPattern.exec(new URL(page.url()).pathname)!;
  return { projectId, versionId, warnings };
}

test.beforeAll(async ({ browser }) => {
  // Uploads made by the specs before this one count against the same minute (see paceUploads).
  uploadTimes.push(Date.now(), Date.now(), Date.now());
  // The stub answers before anything is driven, or nothing runs.
  stubAtStart = JSON.stringify(await stubCounts());
  api = await pwRequest.newContext();
  const login = await api.post(`${API}/auth/login`, { data: { email: INSTRUCTOR.email, password: INSTRUCTOR.password } });
  expect(login.ok(), 'the seeded instructor signs in through the API').toBeTruthy();
  staffHeaders = { authorization: `Bearer ${(await login.json()).token}` };
  S.teacherId = (await (await api.get(`${API}/auth/me`, { headers: staffHeaders })).json()).id;
  teacherCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  learnerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  learnerBCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  watch(teacherCtx);
  watch(learnerCtx);
  watch(learnerBCtx);
  teacher = await teacherCtx.newPage();
  learner = await learnerCtx.newPage();
  learnerB = await learnerBCtx.newPage();
  await dismissPhaseTutorial(learner);
  await dismissPhaseTutorial(learnerB);
  // The bodies of this run, and every API response the learners' pages receive.
  bodies = new JourneyBodies(journeyBodiesRoot());
  bodies.watchResponses(learner, 'learner A', API_ORIGIN);
  bodies.watchResponses(learnerB, 'learner B', API_ORIGIN);
});

test.afterEach(async ({}, info) => {
  outcomes.push({ title: info.title, status: info.status ?? 'unknown' });
});

test.afterAll(async () => {
  const after = JSON.stringify(await stubCounts().catch(() => ({})));
  test.info().annotations.push({ type: 'ai-stub-counts', description: `before ${stubAtStart} after ${after}` });
  fs.mkdirSync(test.info().outputDir, { recursive: true });
  fs.writeFileSync(path.join(test.info().outputDir, 'ai-stub-counts.json'), JSON.stringify({ before: stubAtStart, after }), { mode: 0o600 });
  if (bodies) {
    // every learner response body is read before the pages close
    const failed = outcomes.filter((one) => one.status !== 'passed');
    const completion = {
      complete: reachedEnd && failed.length === 0,
      testsPassed: outcomes.length - failed.length,
      testsNotPassed: failed.map((one) => `${one.title}: ${one.status}`),
      reachedLastTest: reachedEnd,
    };
    const manifest = await bodies.finish({ run: RUN, aiStub: { before: stubAtStart, after }, completion });
    test.info().annotations.push({ type: 'journey-bodies', description: path.basename(path.dirname(manifest)) });
  }
  await teacherCtx?.close();
  await learnerCtx?.close();
  await learnerBCtx?.close();
  await api?.dispose();
});

test('1. the seeded instructor signs in', async () => {
  await signInAs(teacher, INSTRUCTOR.email, INSTRUCTOR.password);
  await teacherHome(teacher);
});

test('2. the upload door: profile line, a hostile archive refused by its sentence, FIX-1 opens as a draft', async () => {
  const mineBefore = async () => {
    const res = await call('GET', '/instructor/projects', staffHeaders);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    return (body.mine ?? []).length + (body.library ?? []).length;
  };
  await teacher.goto('/teacher/projects');
  await expect(teacher.getByTestId('projects-list')).toBeVisible({ timeout: NAVIGATION });
  await expect(teacher.getByTestId('projects-loading')).toHaveCount(0, { timeout: UI_READY });
  const rowsBefore = await teacher.locator('[data-testid^="projects-row-"]').count();
  const apiBefore = await mineBefore();

  await teacher.getByTestId('projects-upload-open').click();
  await expect(teacher.getByTestId('projects-upload-profile')).toHaveText(/^This deployment runs: Python with .+; Node with .+; and the tools .+\. The profile is the .+\.$/, {
    timeout: UI_READY,
  });

  // The hostile archive first: refused by its sentence, verbatim, and nothing of the archive on the page.
  await uploadThroughDoor(teacher, `${TITLE} hostile`, 'shelf-hostile.zip', hostilePathClimbArchive());
  await expect(teacher.getByTestId('projects-upload-refusal-sentence')).toHaveText(PATH_CLIMB_SENTENCE, { timeout: NAVIGATION });
  expect(new URL(teacher.url()).pathname).toBe('/teacher/projects');
  const climbPage = await teacher.content();
  bodies.save('teacher /teacher/projects after PATH_CLIMB', 'page-html', climbPage, ['SHELF_MARKER_VALUES'], false);
  expect(found(climbPage, SHELF_MARKER_VALUES), 'no sealed marker of the refused archive on the page').toEqual([]);
  // Three more refusal sentences, each shown verbatim by the door.
  for (const hostile of shelfRefusalArchives()) {
    await uploadThroughDoor(teacher, `${TITLE} ${hostile.name}`, `shelf-${hostile.name}.zip`, hostile.build());
    await expect(teacher.getByTestId('projects-upload-refusal-sentence'), `${hostile.code} in its own words`).toHaveText(hostile.sentence, { timeout: NAVIGATION });
    const page = await teacher.content();
    bodies.save(`teacher /teacher/projects after ${hostile.code}`, 'page-html', page, ['SHELF_MARKER_VALUES'], false);
    expect(found(page, SHELF_MARKER_VALUES), `${hostile.code}: no sealed marker on the page`).toEqual([]);
  }
  // A runtime outside the profile keeps its fixed sentence and names the package under it.
  expect(entriesOf(SHELF_DIR).filter((entry) => entry.name === 'project.json'), 'FIX-1 has project.json at the archive root').toHaveLength(1);
  await uploadThroughDoor(teacher, `${TITLE} runtime`, 'shelf-runtime.zip', runtimeOutsideArchive());
  await expect(teacher.getByTestId('projects-upload-refusal-sentence'), 'RUNTIME_OUTSIDE_PROFILE in its own words').toHaveText(RUNTIME_OUTSIDE_SENTENCE, { timeout: NAVIGATION });
  await expect(teacher.getByTestId('projects-upload-refusal-detail'), 'the refused package, named under the fixed sentence').toHaveText(RUNTIME_OUTSIDE_DETAIL);
  await expect(teacher.getByTestId('projects-upload-refusal-sentence'), 'the package is named in the detail only').not.toContainText('requests');
  {
    const page = await teacher.content();
    bodies.save('teacher /teacher/projects after RUNTIME_OUTSIDE_PROFILE', 'page-html', page, ['SHELF_MARKER_VALUES'], false);
    expect(found(page, SHELF_MARKER_VALUES), 'RUNTIME_OUTSIDE_PROFILE: no sealed marker on the page').toEqual([]);
  }
  // An archive that is not a pack at all (no project.json) is refused by NOT_A_PACK's sentence.
  const listBefore = await mineBefore();
  await uploadThroughDoor(teacher, `${TITLE} not a pack`, 'notes.zip', notAPackArchive());
  await expect(teacher.getByTestId('projects-upload-refusal-sentence'), 'NOT_A_PACK in its own words').toHaveText(NOT_A_PACK_SENTENCE, { timeout: NAVIGATION });
  await frame(teacher, 't2r-not-a-pack-refused');
  expect(await mineBefore(), 'the list count is the same after the refusal (no row written)').toBe(listBefore);
  expect(new URL(teacher.url()).pathname).toBe('/teacher/projects');
  expect(await mineBefore(), 'no draft was made').toBe(apiBefore);
  await teacher.reload();
  // As before the upload: the list is drawn (it starts as "Loading your projects") before it is counted.
  await expect(teacher.getByTestId('projects-list')).toBeVisible({ timeout: NAVIGATION });
  await expect(teacher.getByTestId('projects-loading')).toHaveCount(0, { timeout: UI_READY });
  await expect(teacher.locator('[data-testid^="projects-row-"]'), 'the library count is unchanged').toHaveCount(rowsBefore);

  // The shelf fixture: the draft opens.
  await uploadThroughDoor(teacher, TITLE, 'shelf.zip', shelfArchive());
  const { projectId, versionId, warnings } = await openUploadedDraft(teacher);
  expect(warnings, 'the Shelf fixture opens with no warning').toEqual([]);
  S.projectId = projectId;
  S.draftVersionId = versionId;
  await expect(teacher.getByTestId('project-status')).toHaveText('Draft 0.1.0', { timeout: NAVIGATION });
  await expect(teacher.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
  const draft = await (await call('GET', `/instructor/projects/${projectId}/versions/${versionId}`, staffHeaders)).json();
  S.slug = draft.slug;
});

test('3. a task title and brief edited in the editor survive a reload', async () => {
  const editor = `/teacher/projects/${S.projectId}/versions/${S.draftVersionId}`;
  await openPhaseTab(teacher, 'requirements');
  // A Requirements phase of one story task opens in the five-step builder;
  // the task's title and brief are its fourth step, the learner's story.
  const step = teacher.getByTestId('tre-learner-story');
  await expect(step).toBeVisible({ timeout: UI_READY });
  const draft = await (await call('GET', `/instructor/projects/${S.projectId}/versions/${S.draftVersionId}`, staffHeaders)).json();
  const reqTasks = (draft.phases.find((one: any) => one.key === 'requirements')?.tasks ?? []) as { taskKey: string }[];
  expect(reqTasks, "the shelf's Requirements holds one task, the learner's story").toHaveLength(1);
  S.soleTaskKey = reqTasks[0].taskKey;
  const title = `Write the member's story (${RUN})`;
  S.soleTaskTitle = title;
  const brief = `Write SH-5 in the backlog, with criteria a tester could check. Edited in the browser proof ${RUN}.`;
  await teacher.getByTestId('tre-learner-title').fill(title);
  await teacher.getByTestId('tre-learner-brief').fill(brief);
  await teacher.getByTestId('tre-learner-save').click();
  await expect(teacher.getByTestId('tre-learner-status')).toHaveText('Saved', { timeout: UI_READY });

  await teacher.goto(editor);
  await openPhaseTab(teacher, 'requirements');
  await expect(teacher.getByTestId('tre-learner-title')).toHaveValue(title, { timeout: UI_READY });
  await expect(teacher.getByTestId('tre-learner-brief')).toHaveValue(brief);
});

test('4. the executable editor: a helper name refused, then a test file sealed and shown as path, digest and size', async () => {
  await openPhaseTab(teacher, 'implementation');
  await teacher.getByTestId('exec-edit-open').click();
  await expect(teacher.getByTestId('exec-editor')).toBeVisible({ timeout: UI_READY });
  const group = 'hidden-api';

  // A hidden suite holds test files only.
  const helper = Buffer.from('def helper():\n    return 1\n');
  await teacher.getByTestId(`sealed-${group}-file`).setInputFiles({ name: 'helper.py', mimeType: 'text/x-python', buffer: helper });
  await teacher.getByTestId(`sealed-${group}-path`).fill('helper.py');
  await teacher.getByTestId(`sealed-${group}-upload`).click();
  await expect(teacher.getByTestId(`sealed-${group}-error`)).toHaveText(HIDDEN_NAME_SENTENCE, { timeout: UI_READY });

  // Then a real one, carrying a marker no page may show.
  S.sealMarker = sealMarker();
  const name = `test_rx_${RUN}.py`;
  const bytes = Buffer.from(`# ${S.sealMarker}\nimport unittest\n\n\nclass RxSealed(unittest.TestCase):\n    def test_sealed(self):\n        self.assertTrue(True)\n`);
  await teacher.getByTestId(`sealed-${group}-file`).setInputFiles({ name, mimeType: 'text/x-python', buffer: bytes });
  // A hidden test is sealed under a folder; the door refuses a bare name the export
  // cannot carry, by its own sentence, and the same file under tests/ is then sealed.
  await teacher.getByTestId(`sealed-${group}-path`).fill(name);
  await teacher.getByTestId(`sealed-${group}-upload`).click();
  await expect(teacher.getByTestId(`sealed-${group}-error`)).toHaveText(SEAL_FOLDER_SENTENCE(name), { timeout: UI_READY });
  await teacher.getByTestId(`sealed-${group}-path`).fill(`tests/${name}`);
  await teacher.getByTestId(`sealed-${group}-upload`).click();
  await expect(teacher.getByTestId(`sealed-${group}-done`)).toBeVisible({ timeout: UI_READY });
  const row = teacher.getByTestId(`sealed-${group}`).locator('li', { hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(sha256Hex(bytes));
  await expect(row).toContainText(`${bytes.length} bytes`);
  bodies.setSealMarker(S.sealMarker);
  const sealedPage = await teacher.content();
  bodies.save('teacher executable editor after the seal', 'page-html', sealedPage, ['SEAL_MARKER', 'SHELF_MARKER_VALUES'], false);
  expect(found(sealedPage, [S.sealMarker]), 'the sealed bytes are not on the page').toEqual([]);
  expect(found(sealedPage, SHELF_MARKER_VALUES), 'no FIX-1 sealed marker on the page').toEqual([]);
  await teacher.getByTestId('exec-cancel').click();
});

test('5. deep validation: the cost warning before the start enables, then the host sentence', async () => {
  const at = `/instructor/projects/${S.projectId}/versions/${S.draftVersionId}/deep-validation`;
  const view = await (await call('GET', at, staffHeaders)).json();
  const microVMs = view.costWarning.microVMs as number;

  // Hold the dialog's read for a moment, so the state before the warning is seen.
  let held = 0;
  await teacher.route(`**/api/v1${at}`, async (route) => {
    if (route.request().method() === 'GET' && held++ === 0) await new Promise((r) => setTimeout(r, 1_500));
    await route.continue();
  });
  // Deep validation is under the editor's Validate tab.
  await teacher.getByTestId('project-section-validate').click();
  await teacher.getByTestId('deep-validation-open').click();
  await expect(teacher.getByTestId('deep-validation-dialog')).toBeVisible();
  await expect(teacher.getByTestId('deep-validation-start')).toBeDisabled();
  await expect(teacher.getByTestId('deep-validation-warning')).toHaveText(costWarning(microVMs), { timeout: UI_READY });
  await expect(teacher.getByTestId('deep-validation-start')).toBeEnabled();
  await teacher.unroute(`**/api/v1${at}`);

  await teacher.getByTestId('deep-validation-start').click();
  if (await hostIsolates()) {
    // A host with a kernel boundary runs every microVM: the Shelf pack's reference passes its own hidden suite.
    await expect(teacher.getByTestId('deep-validation-status')).toHaveText(/^Passed\. Finished /, { timeout: 240_000 });
    await expect(teacher.getByTestId('deep-validation-check-solution-passes-hidden')).not.toContainText(unavailableSentence('Implementation'));
  } else {
    // macOS: no isolation, so the sandbox runs nothing and the check says so.
    await expect(teacher.getByTestId('deep-validation-status')).toHaveText(/^Failed\. Each check below says why\./, { timeout: 240_000 });
    await expect(teacher.getByTestId('deep-validation-check-solution-passes-hidden')).toContainText(unavailableSentence('Implementation'));
  }
});

test('5b. Show the files says where the reference solution may appear, and that App preview is not offered', async () => {
  // Files -> Show the files on the uploaded draft (Files is on the editor's Overview).
  await teacher.getByTestId('project-section-overview').click();
  await teacher.getByTestId('project-files-open').click();
  await expect(teacher.getByTestId('project-files')).toBeVisible({ timeout: NAVIGATION });
  await expect(teacher.getByTestId('project-files-solution-mount')).toHaveText(SOLUTION_MOUNT_SENTENCE);
  await expect(teacher.getByTestId('project-files-preview-not-offered'), 'an uploaded application offers no App preview').toHaveText(APP_PREVIEW_NOT_OFFERED_SENTENCE);
  // both sentences in the frame: the App-preview one sits last, so it leads the scroll
  await teacher.getByTestId('project-files-preview-not-offered').evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await expect(teacher.getByTestId('project-files-solution-mount')).toBeInViewport();
  await expect(teacher.getByTestId('project-files-preview-not-offered')).toBeInViewport();
  await frame(teacher, 't4b-show-the-files');
  const filesPage = await teacher.content();
  bodies.save('teacher Files tab (Show the files)', 'page-html', filesPage, ['SEAL_MARKER', 'SHELF_MARKER_VALUES'], false);
  expect(found(filesPage, [...SHELF_MARKER_VALUES, S.sealMarker!]), 'the Files tab shows no sealed byte').toEqual([]);
});

test('6. publish: a task marked by the toggle; refused without a deep receipt, then published as 1.0.0 behind the ratified MACOS-DEEP-RECEIPT seam', async () => {
  // Design's one task, the design, is the countersigned one, marked in its builder's floor card by the
  // toggle: a Design phase holds exactly one task, so nothing is added beside it, and Requirements is
  // a story phase whose one work task is the story. Requirements keeps its story, unmarked.
  const before = await (await call('GET', `/instructor/projects/${S.projectId}/versions/${S.draftVersionId}`, staffHeaders)).json();
  const designTasks = (before.phases.find((one: any) => one.key === 'design')?.tasks ?? []) as { taskKey: string; title: string }[];
  expect(designTasks, "the shelf's Design holds one task, the design").toHaveLength(1);
  S.designTaskKey = designTasks[0].taskKey;
  S.designTaskTitle = designTasks[0].title;
  await teacher.reload();
  await expect(teacher.getByTestId('project-editor')).toBeVisible({ timeout: NAVIGATION });
  await markSignOffInEditor(teacher, 'design', S.designTaskKey, S.designTaskTitle, { projectId: S.projectId!, versionId: S.draftVersionId! });
  await expect(teacher.getByTestId('tde-floor').getByTestId(`task-signoff-box-${S.designTaskKey}`), 'the toggle sits on the builder\'s floor card').toBeVisible();
  // the mark is saved, not drawn: it is still on after a reload
  await teacher.reload();
  await openPhaseTab(teacher, 'design');
  await expect(teacher.getByTestId(`task-signoff-box-${S.designTaskKey}`).getByLabel(SIGN_OFF_LABEL, { exact: true })).toBeChecked({ timeout: UI_READY });
  const marked = await (await call('GET', `/instructor/projects/${S.projectId}/versions/${S.draftVersionId}`, staffHeaders)).json();
  const designMarks = (marked.phases.find((one: any) => one.key === 'design')?.tasks ?? []).map((one: any) => [one.taskKey, one.signOff === true]);
  expect(designMarks, "Design's one task is marked").toEqual([[S.designTaskKey, true]]);
  const reqMarks = (marked.phases.find((one: any) => one.key === 'requirements')?.tasks ?? []).map((one: any) => [one.taskKey, one.signOff === true]);
  expect(reqMarks, 'Requirements keeps its one story task, unmarked').toEqual([[S.soleTaskKey, false]]);

  await expect(teacher.getByTestId('project-editor')).toBeVisible({ timeout: NAVIGATION });
  // The checks are under the editor's Validate tab.
  await teacher.getByTestId('project-section-validate').click();
  await teacher.getByTestId('project-validate').click();
  await expect(teacher.getByTestId('project-validation-tier')).toBeVisible({ timeout: NAVIGATION });
  // The publish form is under the editor's Publish tab.
  await teacher.getByTestId('project-section-publish').click();
  await teacher.getByTestId('project-publish-version').fill('1.0.0');
  await teacher.getByTestId('project-publish-notes').fill('The browser proof publishes the uploaded shelf.');
  await teacher.getByTestId('project-publish').click();
  await teacher.getByTestId('project-publish-confirm-yes').click();
  if (!(await hostIsolates())) {
    // macOS: step 5 could not pass, so publish is refused until the declared seam writes a receipt.
    await expect(teacher.getByTestId('project-publish-error')).toContainText(deepReceiptRefusal('Implementation'), { timeout: NAVIGATION });

    // MACOS-DEEP-RECEIPT (declared seam; pending the orchestrator's ratification).
    writeDeepReceiptSeam(S.draftVersionId!);
    await teacher.reload();
    await expect(teacher.getByTestId('project-editor')).toBeVisible({ timeout: NAVIGATION });
    // The checks are under the editor's Validate tab.
    await teacher.getByTestId('project-section-validate').click();
    await teacher.getByTestId('project-validate').click();
    await expect(teacher.getByTestId('project-validation-tier')).toBeVisible({ timeout: NAVIGATION });
    // The publish form is under the editor's Publish tab.
    await teacher.getByTestId('project-section-publish').click();
    await teacher.getByTestId('project-publish-version').fill('1.0.0');
    await teacher.getByTestId('project-publish').click();
    await teacher.getByTestId('project-publish-confirm-yes').click();
  }
  // On a host that isolates, step 5's real receipt is what publish reads: no seam.
  await expect(teacher.getByTestId('project-published')).toContainText('Version 1.0.0 is published.', { timeout: NAVIGATION });
  const library = await (await call('GET', '/instructor/projects', staffHeaders)).json();
  const mine = [...(library.mine ?? []), ...(library.library ?? [])].find((one: any) => one.id === S.projectId);
  expect(mine?.publishedVersion).toBe('1.0.0');
  S.publishedVersionId = mine.publishedVersionId;
});

test('7. a class, with the uploaded version assigned on the class page', async () => {
  const made = await createClassFromTeacherHome(teacher, CLASS_NAME);
  S.cohortId = made.classId;
  S.joinCode = made.joinCode;
  bodies.setCodes([S.joinCode]);
  // The class page draws the join code; the frame masks it or is never written.
  // (createClassFromTeacherHome pressed Show code, so the code is in clear here; the frame still masks it.)
  await teacher.locator('code.exp-code').first().scrollIntoViewIfNeeded();
  await frame(teacher, 't08-class-created-code-masked');
  // By the version's id: the option's label is copy, and it names the version's phases.
  // The class's project is under its Project tab.
  await teacher.getByTestId('class-tab-project').click();
  await teacher.getByTestId('class-project-pick').selectOption(S.publishedVersionId!);
  await teacher.getByTestId('class-project-reason').fill('This class works on the teacher’s own uploaded shelf.');
  await teacher.getByTestId('class-project-assign').click();
  await expect(teacher.getByTestId('class-project-active')).toContainText(TITLE, { timeout: NAVIGATION });
});

test('8. a learner registers, joins with the code, and is on the uploaded project', async () => {
  // The setup page with the class code typed, captured through captureMasked (the input holds the code in clear).
  await registerIntoClassWith(learner, { name: `Rhea Upload ${RUN}`, email: `upload-learner-${RUN}@example.test` }, S.joinCode!, (page) =>
    frame(page, 'l01b-onboarding-join-class-code-masked'),
  );
  S.learnerToken = (await learner.evaluate(() => window.localStorage.getItem('lsdlc_token'))) ?? undefined;
  expect(S.learnerToken, 'the page has a session').toBeTruthy();
  const headers = { authorization: `Bearer ${S.learnerToken}` };
  const me = await (await call('GET', '/auth/me', headers)).json();
  S.learnerId = me.id;
  const mine = await (await call('GET', '/enrollments/mine', headers)).json();
  expect(mine.projectSlug, 'enrolled on the uploaded project').toBe(S.slug);
  const phases: ApiPhase[] = mine.phases ?? [];
  S.phaseList = phases;
  S.phases = Object.fromEntries(phases.map((one) => [one.key, one.id]));
  expect(Object.keys(S.phases).sort()).toEqual(['deployment', 'design', 'implementation', 'maintenance', 'requirements', 'testing']);
  await expect(learner.locator('main#main'), 'the dashboard names the uploaded project').toContainText(`Your project: ${TITLE}`, { timeout: NAVIGATION });
});

test('8b. a second learner joins with the same code, so the class has two learners', async () => {
  // Learner B, in their own browser, is on the same uploaded project.
  await registerIntoClass(learnerB, { name: `Bo Upload ${RUN}`, email: `upload-learner-b-${RUN}@example.test` }, S.joinCode!);
  S.learnerBToken = (await learnerB.evaluate(() => window.localStorage.getItem('lsdlc_token'))) ?? undefined;
  expect(S.learnerBToken, 'learner B has a session').toBeTruthy();
  const headers = { authorization: `Bearer ${S.learnerBToken}` };
  S.learnerBId = (await (await call('GET', '/auth/me', headers)).json()).id;
  expect(S.learnerBId).not.toBe(S.learnerId);
  const mine = await (await call('GET', '/enrollments/mine', headers)).json();
  expect(mine.projectSlug, 'learner B is enrolled on the uploaded project').toBe(S.slug);
  S.learnerBPhaseList = mine.phases ?? [];
  S.learnerBRequirements = (mine.phases ?? []).find((one: { key: string }) => one.key === 'requirements')?.id;
  expect(S.learnerBRequirements, "learner B's Requirements phase").toBeTruthy();
  S.learnerBDesign = (mine.phases ?? []).find((one: { key: string }) => one.key === 'design')?.id;
  expect(S.learnerBDesign, "learner B's Design phase").toBeTruthy();
  await expect(learnerB.locator('main#main'), "learner B's dashboard names the uploaded project").toContainText(`Your project: ${TITLE}`, { timeout: NAVIGATION });
});

test('9. the countersigned design is failed, passed, queued, refused without a reason, signed in bulk, and the phase passes', async () => {
  const headers = { authorization: `Bearer ${S.learnerToken}` };
  const req = S.phases!.requirements;
  const des = S.phases!.design;
  const submit = async (taskKey: string, as: Record<string, string> = headers, phase: string = des) => {
    const handed = await call('POST', `/phases/${phase}/tasks/${encodeURIComponent(taskKey)}/submit`, as);
    expect(handed.ok(), `${taskKey} is handed in`).toBeTruthy();
    const id = (await handed.json()).id as string;
    let done: any = null;
    await expect
      .poll(async () => {
        done = await (await call('GET', `/submissions/${id}`, as)).json();
        return done.status;
      }, { timeout: 180_000, intervals: [500, 1_000] })
      .toMatch(/^(completed|failed)$/);
    return done;
  };
  // Requirements first: the story record, its sole task (unmarked), passed and merged, so Design opens.
  const passRequirements = async (as: { authorization: string }, phases: ApiPhase[]) => {
    const after = await passPhaseByApi(api, { headers: as }, phases, 1, { [STORY_JSON]: shelfStoryRecord(true) }, 'The member told me what free to borrow means.');
    expect(after.find((one) => one.key === 'design')?.status, 'Requirements passes and Design opens').not.toBe('locked');
  };
  expect(S.phaseList?.find((one) => one.order === 1)?.id, "learner A's first phase is Requirements").toBe(req);
  await passRequirements(headers, S.phaseList!);
  // Design's one task is the design, and it is the countersigned one.
  const sole = S.designTaskKey!;

  // Failed first: the record carries no E2E-PASS marker in its notes, so the stub sends it back.
  let saved = await call('PUT', `/phases/${des}/workspace`, headers, { files: shelfDesignWork(false) });
  expect(saved.ok()).toBeTruthy();
  const failed = await submit(sole);
  expect(failed.passed, 'without the marker the countersigned design is sent back').toBe(false);
  // A Design phase is its design room, which draws no Review tab: the verdict is read where the room sends the
  // learner after a submit, the review page for that submission (feedback/page.tsx's hero).
  const review = (submission: string) =>
    learner.goto(`/feedback?phase=${encodeURIComponent(des)}&submission=${encodeURIComponent(submission)}`);
  const heroTitle = learner.locator('.exp-result-main h2');
  const heroLine = learner.locator('.exp-result-main > p');
  await review(failed.id);
  await expect(heroTitle, 'the failed design reads as one to revise').toHaveText('Use the feedback. Strengthen your work.', { timeout: NAVIGATION });

  // Then passed through the stub.
  saved = await call('PUT', `/phases/${des}/workspace`, headers, { files: shelfDesignWork(true) });
  expect(saved.ok()).toBeTruthy();
  const passed = await submit(sole);
  expect(passed.passed, 'with the marker the design passes its review').toBe(true);
  const early = await call('POST', `/phases/${des}/advance`, headers);
  expect(early.status(), 'the phase does not open before the countersignature').toBe(400);
  expect((await early.json()).message, 'refused by the gate, not for another reason').toBe(ADVANCE_BEFORE_COUNTERSIGN);
  // ...and the countersignature is the one thing missing: the Design task passed its review and waits.
  const waiting = await (await call('GET', `/phases/${des}`, headers)).json();
  const tasks = (waiting.tasks ?? []) as { key: string; status: string; awaitingSignOff: boolean }[];
  expect(tasks.map((one) => one.key), 'Design holds its one task').toEqual([sole]);
  expect(tasks.find((one) => one.key === sole)?.awaitingSignOff, 'the design waits for its teacher').toBe(true);
  expect(tasks.map((one) => one.status), 'no task counts as passed before the countersignature').toEqual(tasks.map(() => 'submitted'));

  // On the learner's page the passed design says the teacher signs next, and Submit is off with the
  // sign-off reason. Design holds one task, so the room draws no task switcher and no row chip: the
  // waiting words are the review page's (below) and the Design room's own Submit, off with that reason.
  await learner.goto(`/workspace/${des}/design`);
  await expect(learner.getByTestId('task-switcher'), 'one task, no switcher').toHaveCount(0);
  const submitRoom = learner.getByTestId('design-submit');
  await expect(submitRoom, "the Design room's Submit is off").toBeDisabled({ timeout: NAVIGATION });
  await expect(submitRoom, "with the sign-off reason, FIX-CHIP's").toHaveAccessibleDescription(SIGNOFF_SUBMIT_REASON);
  await frame(learner, 'l07a-design-submit-awaiting-teacher-sign-off');
  // The one required task passed its review and waits, so nothing is open: the hero reads AWAITING_SIGN_OFF
  // and SIGN_OFF_PASS_LINE; the split arm is only for a sibling not yet passed, and Design has none.
  await review(passed.id);
  await expect(heroTitle, 'the headline waits on the teacher').toHaveText(`${SIGNOFF_CHIP}.`, { timeout: NAVIGATION });
  await expect(heroLine, 'the Pass line names the countersignature').toHaveText(SIGNOFF_PASS_LINE);
  await expect(heroLine, 'a task that passed and waits is not called open').not.toContainText(signOffSplitLine(S.designTaskTitle!));
  await expect(heroLine, 'no required task is called still open').not.toContainText('still open');
  await expect(heroTitle, 'the waiting design is not called ready to build on').not.toHaveText('Design is ready to build on.');
  await frame(learner, 'l07b-design-awaiting-teacher-sign-off');

  // Learner B passes Requirements and the same Design task, so two learners wait on the countersignature.
  const headersB = { authorization: `Bearer ${S.learnerBToken}` };
  await passRequirements(headersB, S.learnerBPhaseList!);
  const desB = S.learnerBDesign!;
  const savedB = await call('PUT', `/phases/${desB}/workspace`, headersB, { files: shelfDesignWork(true) });
  expect(savedB.ok()).toBeTruthy();
  expect((await submit(sole, headersB, desB)).passed, "learner B's design passes its review").toBe(true);
  const waitingB = await (await call('GET', `/phases/${desB}`, headersB)).json();
  expect(waitingB.tasks?.find((one: any) => one.key === sole)?.awaitingSignOff, 'learner B waits for the teacher too').toBe(true);

  // The teacher reaches the queue from the home page's link, not by a typed address.
  await teacherHome(teacher);
  await teacher.getByRole('link', { name: `Sign-off queue for ${CLASS_NAME}`, exact: true }).click();
  await teacher.waitForURL((url) => url.pathname === '/teacher/class' && url.searchParams.get('class') === S.cohortId, { timeout: NAVIGATION });
  const queue = teacher.getByTestId('signoff-queue');
  await expect(queue).toBeVisible({ timeout: NAVIGATION });
  await expect
    .poll(() => teacher.evaluate(() => Boolean(document.activeElement?.closest('#signoff-queue'))), { timeout: UI_READY, message: 'focus lands in the sign-off queue' })
    .toBe(true);
  // One marked task, so one group, and both learners wait in it.
  const picksA = queue.locator(`[data-testid^="signoff-pick-"][data-testid$="-${S.learnerId}"]`);
  await expect(picksA, 'learner A waits in the one group, the design').toHaveCount(1, { timeout: NAVIGATION });
  const groupKeys = (await picksA.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!))).map((id) =>
    id.replace(/^signoff-pick-/, '').replace(new RegExp(`-${S.learnerId}$`), ''),
  );
  for (const groupKey of groupKeys) {
    await expect(queue.getByTestId(`signoff-pick-${groupKey}-${S.learnerBId}`), 'learner B waits in the same group').toHaveCount(1, { timeout: NAVIGATION });
  }
  // the queue itself in the frame, not the class page above it
  await queue.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(queue.getByTestId(`signoff-pick-${groupKeys[0]}-${S.learnerBId}`)).toBeInViewport();
  await frame(teacher, 't10a-signoff-queue-two-learners');

  const reason = 'Read in class: the member’s words are recorded faithfully.';
  for (const [i, groupKey] of groupKeys.entries()) {
    await queue.getByTestId(`signoff-pick-${groupKey}-${S.learnerId}`).check();
    await queue.getByTestId(`signoff-pick-${groupKey}-${S.learnerBId}`).check();
    if (i === 0) {
      // An empty reason is refused: in the page (the control stays off and says why) and by the API.
      await expect(teacher.getByTestId(`signoff-bulk-${groupKey}`)).toBeDisabled();
      await expect(teacher.getByTestId(`signoff-bulk-${groupKey}-reason`)).toContainText('Write a reason of at least');
      const refused = await call('POST', `/instructor/cohorts/${S.cohortId}/signoff`, staffHeaders, {
        phaseKey: 'design',
        taskKey: sole,
        userIds: [S.learnerId, S.learnerBId],
        reason: '',
      });
      expect(refused.status(), 'a batch with no reason is refused').toBe(400);
    }
    // One reason: both learners signed.
    await teacher.getByTestId(`signoff-reason-${groupKey}`).fill(reason);
    await teacher.getByTestId(`signoff-bulk-${groupKey}`).click();
    await teacher.getByTestId('signoff-confirm-yes').click();
    await expect(teacher.getByTestId('signoff-result')).toContainText('Signed off 2 learners', { timeout: NAVIGATION });
  }
  // The answer takes focus, outside anything inert, and the arrival hash is spent
  await expect
    .poll(
      () =>
        teacher.evaluate(() => {
          const answer = document.querySelector('[data-testid="signoff-result"]');
          const at = document.activeElement;
          return {
            onAnswer: Boolean(answer && at && at !== document.body && at.contains(answer)),
            inert: Boolean(answer?.closest('[inert]')),
            hash: window.location.hash,
          };
        }),
      { timeout: UI_READY, message: 'focus lands on the batch answer' },
    )
    .toEqual({ onAnswer: true, inert: false, hash: '' });
  await expect(teacher.getByTestId('signoff-empty')).toBeVisible({ timeout: NAVIGATION });
  // The queue has just signed two learners off, so it says nothing waits, not how to set sign-off up.
  await expect(teacher.getByTestId('signoff-empty')).toContainText(SIGNOFF_QUEUE_EMPTY_IN_USE_BODY);
  await expect(teacher.getByTestId('signoff-empty')).not.toContainText(SIGNOFF_QUEUE_EMPTY_BODY);
  await frame(teacher, 't10d-signed-off-two-learners');
  // One audit row per learner and task, each with the teacher as actor, the batch's reason and a batch of two.
  for (const who of [S.learnerId!, S.learnerBId!]) {
    const trail = (await (await call('GET', `/instructor/audit?learnerId=${encodeURIComponent(who)}&limit=50`, staffHeaders)).json()) as any[];
    const rows = trail.filter((one) => one.event === 'class.bulk-signoff');
    expect(rows.map((one) => one.detail?.taskKey), 'one class.bulk-signoff row per learner, for the design').toEqual([sole]);
    for (const row of rows) {
      expect(row.actorUserId, 'the teacher signed').toBe(S.teacherId);
      expect(row.reason).toBe(reason);
      expect(row.detail?.batchSize).toBe(2);
    }
  }

  // After the countersignature the Design task reads Passed, and the review page's hero is the ordinary Pass.
  const signed = await (await call('GET', `/phases/${des}`, headers)).json();
  expect(signed.tasks?.find((one: any) => one.key === sole), 'the countersigned design reads Passed').toMatchObject({ status: 'passed', awaitingSignOff: false });
  await review(passed.id);
  await expect(heroTitle, 'the design no longer waits').toHaveText('Design is ready to build on.', { timeout: NAVIGATION });
  await expect(heroLine, 'the ordinary Pass line').toHaveText(PHASE_PASSED_LINE);
  await frame(learner, 'l07e-design-approved-after-countersign');
  expect((await call('POST', `/phases/${des}/reflect`, headers, { reflection: 'The countersignature named what the member asked for.' })).ok()).toBeTruthy();
  const advanced = await call('POST', `/phases/${des}/advance`, headers);
  expect(advanced.ok(), 'after the countersignature the phase passes and Implementation opens').toBeTruthy();
  const implementation = ((await advanced.json()).phases as { key: string; status: string }[]).find((one) => one.key === 'implementation');
  expect(implementation?.status).not.toBe('locked');
});

test('10. rooms 3-6, opened by the reopen lever, show FIX-1 files and no TaskTrackr word or sealed marker', async () => {
  const rooms: [string, string][] = [
    ['implementation', 'shelf.py'],
    ['testing', 'test_acceptance.py'],
    // Deployment's own file is its Dockerfile: the runbook is the Runbook tab's forms.
    ['deployment', 'Dockerfile'],
    ['maintenance', 'test_shelf_order.py'],
  ];
  // Implementation is already open (step 9 merged Design, the countersigned phase), and the three
  // after it are locked; the lever opens exactly those three.
  const mine = await (await call('GET', '/enrollments/mine', { authorization: `Bearer ${S.learnerToken}` })).json();
  const statusOf = (key: string) => (mine.phases ?? []).find((one: { key: string }) => one.key === key)?.status;
  expect(statusOf('implementation'), 'Implementation opened when Design merged').not.toBe('locked');
  const locked = rooms.map(([key]) => key).filter((key) => statusOf(key) === 'locked');
  expect(locked, 'the rooms after Implementation are the locked ones').toEqual(['testing', 'deployment', 'maintenance']);
  for (const key of locked) {
    const opened = await call('POST', `/instructor/learners/${S.learnerId}/phases/${S.phases![key]}/override`, staffHeaders, {
      action: 'reopen',
      reason: 'Browser proof: opened for rendering only; no Pass is seeded.',
    });
    expect(opened.ok(), `${key} opens for rendering`).toBeTruthy();
  }
  const ready = () => expect(learner.locator('main#main:not([aria-busy="true"])').first()).toBeVisible({ timeout: NAVIGATION });
  const clean = async (where: string) => {
    // A view that reads on arrival (evidence, a pipeline) is given a moment to draw.
    await learner.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    const text = await learnerPageText(learner);
    const markup = await learner.content();
    // Both bodies saved before they are judged, so the counts can be re-derived offline.
    bodies.save(`learner A ${where} innerText`, 'page-innerText', text, ['TASKTRACKR_WORDS', 'SHELF_MARKER_VALUES'], true);
    bodies.save(`learner A ${where} content()`, 'page-html', markup, ['SHELF_MARKER_VALUES', 'SEAL_MARKER'], true);
    expect(found(text, TASKTRACKR_WORDS), `${where}: no TaskTrackr word`).toEqual([]);
    expect(found(text, SHELF_MARKER_VALUES), `${where}: no sealed marker`).toEqual([]);
    expect(found(markup, [...SHELF_MARKER_VALUES, S.sealMarker!]), `${where}: no sealed marker in the markup`).toEqual([]);
  };
  const seen: string[] = [];
  for (const [key, file] of rooms) {
    await learner.goto(`/workspace/${S.phases![key]}`);
    await ready();
    // The view the room opens on (the deployment room's Pipeline), then every
    // tab of its working area pressed in turn, then each view it links to.
    await clean(`${key} (as opened)`);
    const nav = learner.locator('nav[aria-label="Phase working area"], nav[aria-label="Implementation working area"]').first();
    await expect(nav, `${key}: the room draws its working-area tabs`).toBeVisible({ timeout: NAVIGATION });
    const tabs = nav.locator(':scope > button[aria-pressed]');
    const labels = (await tabs.allInnerTexts()).map((one) => one.trim());
    expect(labels.length, `${key}: the room has working-area tabs to open`).toBeGreaterThan(1);
    for (const [i, label] of labels.entries()) {
      if ((await tabs.nth(i).getAttribute('aria-pressed')) !== 'true') await tabs.nth(i).click();
      await expect(tabs.nth(i)).toHaveAttribute('aria-pressed', 'true');
      await clean(`${key} / ${label}`);
      seen.push(`${key} / ${label}`);
    }
    // The shelf fixture's own file, on the room's edit view (the first tab: Code, Write tests, Configuration, ...).
    if ((await tabs.first().getAttribute('aria-pressed')) !== 'true') await tabs.first().click();
    await expect(learner.getByText(file, { exact: true }).filter({ visible: true }).first(), `${key} shows FIX-1's own ${file}`).toBeVisible({ timeout: NAVIGATION });
    const linked = await nav.locator(':scope > a[href^="/workspace/"]').evaluateAll((links) => links.map((one) => one.getAttribute('href')!));
    for (const href of linked) {
      await learner.goto(href);
      await ready();
      await clean(`${key} ${href.replace(IDS, ':id')}`);
      seen.push(`${key} ${href.replace(IDS, ':id')}`);
    }
  }
  // spec 11: Shelf's Maintenance opens the IDE at its bare path, and its room link goes to the change room
  await learner.goto(`/workspace/${S.phases!.maintenance}`);
  await ready();
  const maintenanceNav = learner.locator('nav[aria-label="Phase working area"], nav[aria-label="Implementation working area"]').first();
  await expect(maintenanceNav).toBeVisible({ timeout: NAVIGATION });
  await expect(maintenanceNav.locator(`a[href="/workspace/${S.phases!.maintenance}/change"]`)).toBeVisible();
  await learner.goto(`/workspace/${S.phases!.maintenance}/change`);
  await expect(learner.getByTestId('change-ticket')).toContainText('CHG-1', { timeout: NAVIGATION });
  test.info().annotations.push({ type: 'room-views-grepped', description: seen.join('; ') });
  await frame(learner, 'l08-room-6-last-view');
  // No API response a learner's page received held a sealed marker.
  expect(await bodies.responseMarkerHits(), 'no learner response holds a sealed marker').toEqual([]);
});

test('11. the four quiz-results files download from the teacher exports, each by name and header', async () => {
  await teacher.goto(`/teacher/class?class=${S.cohortId}`);
  const block = teacher.getByTestId('teacher-exports');
  await expect(block).toBeVisible({ timeout: NAVIGATION });
  for (const kind of ['learners', 'attempts', 'questions', 'class'] as const) {
    await teacher.getByTestId('export-quiz-kind').selectOption(kind);
    const [download] = await Promise.all([teacher.waitForEvent('download'), teacher.getByTestId('export-quiz-results').click()]);
    expect(download.suggestedFilename()).toBe(`quiz-${kind}.csv`);
    const saved = await download.path();
    const text = fs.readFileSync(saved!, 'utf8');
    expect(text.split('\r\n')[0], `quiz-${kind}.csv header`).toBe(QUIZ_HEADERS[kind]);
    bodies.save(`teacher download quiz-${kind}.csv`, 'download', text, ['SHELF_MARKER_VALUES', 'SEAL_MARKER'], false);
    expect(found(text, [...SHELF_MARKER_VALUES, S.sealMarker!]), `quiz-${kind}.csv holds no marker`).toEqual([]);
  }
});

test('12. export through the Export button, then the archive uploaded again opens a new draft', async () => {
  // The journey's version holds one task per phase (Design's countersigned task is its own one),
  // so the archive layout takes it; the round trip below is still made of a fresh upload of the shelf
  // fixture, whose marks are its own.
  const own = await call('GET', `/instructor/projects/${S.projectId}/versions/${S.publishedVersionId}/export`, staffHeaders);
  expect(own.status(), "the journey's version (one task per phase) exports").toBe(200);
  await teacher.goto('/teacher/projects');
  await expect(teacher.getByTestId('projects-loading')).toHaveCount(0, { timeout: NAVIGATION });
  await uploadThroughDoor(teacher, `${TITLE} export`, 'shelf.zip', shelfArchive());
  const { projectId, versionId, warnings } = await openUploadedDraft(teacher);
  expect(warnings, 'the Shelf fixture opens with no warning').toEqual([]);
  await expect(teacher.getByTestId('project-editor')).toBeVisible({ timeout: NAVIGATION });
  // The fresh draft's Requirements task marked by the toggle, so the archive carries it
  const fresh = await (await call('GET', `/instructor/projects/${projectId}/versions/${versionId}`, staffHeaders)).json();
  const soleKey = fresh.phases.find((one: any) => one.key === 'requirements').tasks[0].taskKey as string;
  const soleTitle = fresh.phases.find((one: any) => one.key === 'requirements').tasks[0].title as string;
  await markSignOffInEditor(teacher, 'requirements', soleKey, soleTitle, { projectId, versionId });
  const draft = await (await call('GET', `/instructor/projects/${projectId}/versions/${versionId}`, staffHeaders)).json();

  const answered = teacher.waitForResponse((res) => /\/export$/.test(new URL(res.url()).pathname) && res.request().method() === 'GET');
  const [download] = await Promise.all([teacher.waitForEvent('download'), teacher.getByTestId('project-export').click()]);
  const res = await answered;
  expect(res.status()).toBe(200);
  expect(res.headers()['x-export-withheld'], 'the withheld count is exposed').toMatch(/^\d+$/);
  expect(download.suggestedFilename()).toBe(`${draft.slug}-${draft.version}.zip`);
  // The page itself read the withheld count (0) across origins, so it says the complete sentence
  await expect(teacher.getByTestId('project-export-done')).toHaveText(exportSavedSentence(`${draft.slug}-${draft.version}.zip`));
  const archive = fs.readFileSync((await download.path())!);

  await teacher.goto('/teacher/projects');
  await expect(teacher.getByTestId('projects-loading')).toHaveCount(0, { timeout: NAVIGATION });
  await uploadThroughDoor(teacher, `${TITLE} round trip`, draft.slug + '-' + draft.version + '.zip', archive);
  const { projectId: againProject, versionId: againVersion, warnings: againWarnings } = await openUploadedDraft(teacher);
  expect(againWarnings, 'the upload of its export opens with no warning').toEqual([]);
  expect(againProject).not.toBe(projectId);
  const again = await (await call('GET', `/instructor/projects/${againProject}/versions/${againVersion}`, staffHeaders)).json();
  // Semantic, not digest equality: the same six phases, titles and task counts.
  const shape = (view: any) => view.phases.map((one: any) => [one.key, one.title, one.tasks.length]);
  expect(shape(again)).toEqual(shape(draft));
  // The browser half of the round trip, the re-uploaded draft's toggle reads on, and only there
  await expect(teacher.getByTestId('project-editor')).toBeVisible({ timeout: NAVIGATION });
  await openPhaseTab(teacher, 'requirements');
  const againKey = again.phases.find((one: any) => one.key === 'requirements').tasks[0].taskKey as string;
  await expect(teacher.getByTestId(`task-signoff-box-${againKey}`).getByLabel(SIGN_OFF_LABEL, { exact: true }), 'the mark came back with the archive').toBeChecked({ timeout: UI_READY });
  const marked = (view: any) => view.phases.map((one: any) => [one.key, one.tasks.map((task: any) => task.signOff === true)]);
  expect(marked(again)).toEqual(marked(draft));
  expect(marked(again).filter(([, marks]: [string, boolean[]]) => marks.includes(true)).map(([key]: [string]) => key)).toEqual(['requirements']);
  await openPhaseTab(teacher, 'design');
  const designKey = again.phases.find((one: any) => one.key === 'design').tasks[0].taskKey as string;
  await expect(teacher.getByTestId(`task-signoff-box-${designKey}`).getByLabel(SIGN_OFF_LABEL, { exact: true }), 'an unmarked task reads off').not.toBeChecked();
});

test('no response anywhere in the journey had a status of 500 or more', async () => {
  expect(fiveHundreds).toEqual([]);
  reachedEnd = true;
});
