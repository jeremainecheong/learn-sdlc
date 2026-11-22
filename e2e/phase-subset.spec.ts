import { expect, request as pwRequest, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { STORY_JSON } from '@learnsdlc/shared';
import { ADMIN, markPassing, passPhaseByApi, registerByApi, staffByApi, type ApiPhase, type StaffParty } from './passing-work';
import { createClassFromTeacherHome, dismissPhaseTutorial, LEARNER_PASSWORD, registerIntoClass, signInAs } from './pw-fixtures';
import { deepReceiptRefusal, shelfDesignWork, shelfStoryRecord, writeDeepReceiptSeam } from './upload-helpers';
import { zipDirectory } from '../apps/api/test/fixtures/upload-packs/archive';
import { withYearHelper } from './shelf-year-helper.mjs';
import { API, assertLoopbackApi, RUN } from './support/env';
import { NAVIGATION, SANDBOX_RUN, UI_READY } from './support/timeouts';

/**
 * A project of three phases in a browser:
 * a teacher uploads `shelf-three` (Shelf's Requirements, Design and
 * Implementation, in the folder layout), and a learner works it as a project
 * of three, from "Phase 1 of 3" to the completion record.
 *
 * A fresh teacher (registered through the API and made a teacher by the seeded
 * admin) and a fresh learner (registered on the page, joining with the class
 * code); never a personal sign-in. In order, each step its own test:
 *
 *  1. the teacher uploads `shelf-three` (the fixture folder zipped whole, as
 *     `shelfArchive` zips Shelf's), and its draft opens;
 *  2. the Phases card says the draft holds three of the six phases, and the
 *     editor draws three phase tabs;
 *  3. the draft is published;
 *  4. a class is made, and the version is assigned from an assignable list
 *     that reads "Requirements, Design and Implementation";
 *  5. the learner joins with the code and opens Requirements as "Phase 1 of 3";
 *  6. the learner passes Requirements and Design, and reaches Implementation
 *     as "Phase 3 of 3";
 *  7. the learner's first code run in Implementation passes its visible tests;
 *  8. Implementation passes, and the completion record counts three phases;
 *  9. no response in the journey had a status of 500 or more.
 *
 * On a host that cannot isolate learner code (macOS) the runner refuses the
 * run in step 7 with its own sentence, and the journey stops there; steps 1
 * to 6 come before it. The same journey runs end to end on the isolating
 * stack (`scripts/author-subset.mjs`).
 *
 * No real AI: every review goes to e2e/ai-stub.cjs, which passes marked work.
 * Nothing here prints an address, a token or an id.
 */

test.describe.configure({ mode: 'serial' });

assertLoopbackApi(__filename);

const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EDITOR = /\/teacher\/projects\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})$/;

/** The fixture: Shelf's first three phases. */
const SHELF_THREE_DIR = path.join(__dirname, '../apps/api/test/fixtures/upload-packs/shelf-three');
const HELD = ['requirements', 'design', 'implementation'] as const;
const NOT_HELD = ['testing', 'deployment', 'maintenance'] as const;
/** packages/shared/src/phase-subset.ts phaseListSentence over the three. */
const THREE = 'Requirements, Design and Implementation';
/** apps/web/components/staff/projects/PhasesCard.tsx phasesReadiness and STATE_LABEL. */
const READINESS = `This draft holds 3 of LearnSDLC's six phases: ${THREE}.`;
const STATE = { held: 'In this project', absent: 'Not in this project' };

/**
 * Implementation's work: the fixture's own reference answer, at the paths the
 * room mounts, with `add()`'s year check moved into `_year_is_valid` as the
 * shipped starter has it. The inline check scores over the grader's complexity
 * limit, so the strict gate refuses the solution as it stands on a host that
 * isolates learner code. This is the work scripts/author-subset.mjs hands in
 * (`scripts/author-subset.mjs`'s `implementationWork`); its node tests pin the
 * limit, and that this journey hands in the same.
 */
function implementationSolution(): Record<string, string> {
  const at = path.join(SHELF_THREE_DIR, 'phases/03-implementation/solution');
  const files: Record<string, string> = {};
  for (const one of ['api/shelf.py', 'web/src/lib/shelf.ts']) files[one] = fs.readFileSync(path.join(at, one), 'utf8');
  files['api/shelf.py'] = withYearHelper(files['api/shelf.py']);
  return files;
}

const S: {
  run?: string;
  teacher?: StaffParty;
  title?: string;
  projectId?: string;
  versionId?: string;
  publishedVersionId?: string;
  joinCode?: string;
  learnerHeaders?: { authorization: string };
  phases?: ApiPhase[];
} = {};

let teacherCtx: BrowserContext;
let learnerCtx: BrowserContext;
let teacher: Page;
let learner: Page;
let api: APIRequestContext;
const fiveHundreds: string[] = [];

const redact = (url: string) => new URL(url).pathname.replace(IDS, ':id');

function watch(ctx: BrowserContext) {
  ctx.on('response', (res) => {
    if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${res.request().method()} ${redact(res.url())}`);
  });
}

/** A call to the API, with a 5xx recorded like the browser's. */
async function call(method: string, route: string, headers: Record<string, string>, data?: unknown) {
  const res = await api.fetch(`${API}${route}`, { method, headers, data });
  if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${method} ${route.replace(IDS, ':id')}`);
  return res;
}

/** Whether this host's runner isolates learner code (/health/ready's probe; a macOS host answers 503). */
async function hostIsolates(): Promise<boolean> {
  const res = await api.fetch(`${API}/health/ready`);
  const body = (await res.json().catch(() => ({}))) as { dependencies?: { name: string; ok: boolean }[] };
  return body.dependencies?.find((one) => one.name === 'isolation')?.ok === true;
}

/**
 * The accepted upload's draft. The door opens it at once, or, when the upload
 * changed something on its way in, says what first and opens it from "Open
 * the draft" (as `e2e/export-roundtrip.spec.ts` takes it). A refusal fails
 * here with its own sentence.
 */
async function openUploadedDraft(page: Page): Promise<{ projectId: string; versionId: string; warnings: string[] }> {
  const onEditor = () => EDITOR.test(new URL(page.url()).pathname);
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
    await page.waitForURL(EDITOR, { timeout: NAVIGATION });
  }
  const [, projectId, versionId] = EDITOR.exec(new URL(page.url()).pathname)!;
  await expect(page.getByTestId('project-editor')).toBeVisible({ timeout: NAVIGATION });
  return { projectId, versionId, warnings };
}

/** "Phase n of m", read from the phase strip's Details, where every working room says it. */
async function stripPlace(page: Page): Promise<string> {
  const strip = page.getByTestId('phase-strip');
  await expect(strip).toBeVisible({ timeout: NAVIGATION });
  const details = strip.locator('details.phase-strip-details');
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.locator(':scope > summary').click();
  const place = strip.locator('.phase-strip-detail-panel > strong').first();
  await expect(place).toBeVisible();
  return (await place.innerText()).trim();
}

/** The learner's enrolment, read with the page's own session. */
async function mine() {
  const res = await call('GET', '/enrollments/mine', S.learnerHeaders!);
  expect(res.ok(), 'the enrolment reads').toBeTruthy();
  return res.json();
}

test.beforeAll(async ({ browser }) => {
  const run = test.info().retry ? `${RUN}-r${test.info().retry}` : RUN;
  S.run = run;
  S.title = `Shelf three ${run}`;
  api = await pwRequest.newContext();
  // A fresh teacher: registered, then made a teacher by the seeded admin.
  const admin = await staffByApi(api, ADMIN);
  const who = await registerByApi(api, { name: 'Tamsin Three', email: `phase-subset-${run}@e2e-subset.test`, password: LEARNER_PASSWORD });
  const promoted = await api.patch(`${API}/admin/users/${who.userId}`, { headers: admin.headers, data: { role: 'INSTRUCTOR' } });
  expect(promoted.ok(), 'the admin makes the account a teacher').toBeTruthy();
  S.teacher = await staffByApi(api, who);
  teacherCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  learnerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  watch(teacherCtx);
  watch(learnerCtx);
  teacher = await teacherCtx.newPage();
  learner = await learnerCtx.newPage();
  await dismissPhaseTutorial(learner);
  await signInAs(teacher, who.email, who.password);
  await teacher.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
});

test.afterAll(async () => {
  await teacherCtx?.close();
  await learnerCtx?.close();
  await api?.dispose();
});

test('1. a fresh teacher uploads shelf-three, and its draft opens', async () => {
  await teacher.goto('/teacher/projects');
  await expect(teacher.getByTestId('projects-list')).toBeVisible({ timeout: NAVIGATION });
  await expect(teacher.getByTestId('projects-loading')).toHaveCount(0, { timeout: UI_READY });
  await teacher.getByTestId('projects-upload-open').click();
  await expect(teacher.getByTestId('projects-upload')).toBeVisible();
  await teacher.getByTestId('projects-upload-title').fill(S.title!);
  await teacher.getByTestId('projects-upload-file').setInputFiles({ name: 'shelf-three.zip', mimeType: 'application/zip', buffer: zipDirectory(SHELF_THREE_DIR) });
  await teacher.getByTestId('projects-upload-submit').click();
  const draft = await openUploadedDraft(teacher);
  S.projectId = draft.projectId;
  S.versionId = draft.versionId;
  // The fixture is plain and in the folder layout, so the door has nothing to say about it.
  expect(draft.warnings, 'the upload opens with no warning').toEqual([]);
  await expect(teacher.getByTestId('project-status')).toHaveText('Draft 0.1.0', { timeout: NAVIGATION });
  await expect(teacher.getByRole('heading', { level: 1, name: S.title })).toBeVisible();
});

test('2. the Phases card says the draft holds three phases, and the editor draws three tabs', async () => {
  const card = teacher.getByTestId('phases-card');
  await expect(card).toBeVisible({ timeout: NAVIGATION });
  await expect(card.getByTestId('phases-card-readiness')).toHaveText(READINESS);
  for (const key of HELD) {
    await expect(card.getByTestId(`phases-state-${key}`), `${key} is held`).toHaveText(STATE.held);
    await expect(card.getByTestId(`phases-remove-${key}`), `${key} can be removed`).toBeVisible();
  }
  for (const key of NOT_HELD) {
    await expect(card.getByTestId(`phases-state-${key}`), `${key} is not held`).toHaveText(STATE.absent);
    // An application phase is added only by an upload: the card says so and offers no Add.
    await expect(card.getByTestId(`phases-upload-${key}`)).toBeVisible();
    await expect(card.getByTestId(`phases-add-${key}`)).toHaveCount(0);
  }
  const tabs = teacher.locator('[data-testid^="project-phase-tab-"]');
  await expect(tabs).toHaveCount(3);
  expect(await tabs.evaluateAll((els) => els.map((el) => (el.getAttribute('data-testid') ?? '').slice('project-phase-tab-'.length)))).toEqual([...HELD]);
  const view = await (await call('GET', `/instructor/projects/${S.projectId}/versions/${S.versionId}`, S.teacher!.headers)).json();
  expect((view.phases as { key: string }[]).map((one) => one.key), 'the draft holds the three').toEqual([...HELD]);
});

test('3. the draft is published', async () => {
  const isolates = await hostIsolates();
  // The checks are under the editor's Validate tab.
  await teacher.getByTestId('project-section-validate').click();
  await teacher.getByTestId('project-validate').click();
  await expect(teacher.getByTestId('project-validation-tier')).toBeVisible({ timeout: NAVIGATION });
  if (isolates) {
    // A host with a kernel boundary runs deep validation for real.
    await teacher.getByTestId('deep-validation-open').click();
    await expect(teacher.getByTestId('deep-validation-start')).toBeEnabled({ timeout: UI_READY });
    await teacher.getByTestId('deep-validation-start').click();
    await expect(teacher.getByTestId('deep-validation-status')).toHaveText(/^Passed\. Finished /, { timeout: 240_000 });
    await teacher.keyboard.press('Escape');
    await expect(teacher.getByTestId('deep-validation-dialog')).toHaveCount(0);
  }
  // The publish form is under the editor's Publish tab.
  await teacher.getByTestId('project-section-publish').click();
  await teacher.getByTestId('project-publish-version').fill('1.0.0');
  await teacher.getByTestId('project-publish-notes').fill('Shelf in three phases.');
  await teacher.getByTestId('project-publish').click();
  await teacher.getByTestId('project-publish-confirm-yes').click();
  if (!isolates) {
    // macOS runs no learner code: publish is refused without a deep receipt, then the
    // declared MACOS-DEEP-RECEIPT seam (e2e/upload-helpers.ts) writes one.
    await expect(teacher.getByTestId('project-publish-error')).toContainText(deepReceiptRefusal('Implementation'), { timeout: NAVIGATION });
    writeDeepReceiptSeam(S.versionId!);
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
  await expect(teacher.getByTestId('project-published')).toContainText('Version 1.0.0 is published.', { timeout: NAVIGATION });
  const library = await (await call('GET', '/instructor/projects', S.teacher!.headers)).json();
  const row = [...(library.mine ?? []), ...(library.library ?? [])].find((one: { id: string }) => one.id === S.projectId);
  expect(row?.publishedVersion).toBe('1.0.0');
  S.publishedVersionId = row.publishedVersionId;
});

test('4. a class, and the version assigned from a list that names its three phases', async () => {
  const made = await createClassFromTeacherHome(teacher, `Three-phase class ${S.run}`);
  S.joinCode = made.joinCode;
  // A new class opens on its Invite and notes tab; its project is under Project.
  await teacher.getByTestId('class-tab-project').click();
  const pick = teacher.getByTestId('class-project-pick');
  const option = pick.locator(`option[value="${S.publishedVersionId}"]`);
  await expect(option, 'the assignable list names the version by its phases').toHaveText(`${S.title} 1.0.0: ${THREE} (yours)`, { timeout: NAVIGATION });
  await pick.selectOption(S.publishedVersionId!);
  await teacher.getByTestId('class-project-reason').fill('This class works Shelf in three phases.');
  await teacher.getByTestId('class-project-assign').click();
  await expect(teacher.getByTestId('class-project-active')).toContainText(S.title!, { timeout: NAVIGATION });
});

test('5. a fresh learner joins with the code and opens Requirements as Phase 1 of 3', async () => {
  await registerIntoClass(learner, { name: `Pip Three ${S.run}`, email: `phase-subset-learner-${S.run}@e2e-subset.test` }, S.joinCode!);
  const token = await learner.evaluate(() => window.localStorage.getItem('lsdlc_token'));
  expect(token, 'the page has a session').toBeTruthy();
  S.learnerHeaders = { authorization: `Bearer ${token}` };
  const enrolment = await mine();
  const phases = (enrolment.phases ?? []) as ApiPhase[];
  expect(phases.map((one) => one.key), 'the learner holds the three phases').toEqual([...HELD]);
  S.phases = phases;
  const requirements = phases.find((one) => one.key === 'requirements')!;
  await learner.goto(`/workspace/${requirements.id}`);
  await expect(learner.getByTestId('phase-title')).toHaveText('Requirements', { timeout: NAVIGATION });
  expect(await stripPlace(learner)).toBe('Phase 1 of 3');
});

test('6. the learner passes Requirements and Design, and reaches Implementation as Phase 3 of 3', async () => {
  let phases = await passPhaseByApi(api, { headers: S.learnerHeaders! }, S.phases!, 1, { [STORY_JSON]: shelfStoryRecord(true) }, 'A member told me what free to borrow means.');
  phases = await passPhaseByApi(api, { headers: S.learnerHeaders! }, phases, 2, shelfDesignWork(true), 'The refusals came first, then the operations.');
  S.phases = phases;
  expect(phases.filter((one) => one.status === 'passed').map((one) => one.key), 'two of three passed').toEqual(['requirements', 'design']);
  const implementation = phases.find((one) => one.key === 'implementation')!;
  expect(implementation.status, 'Implementation is open').not.toBe('locked');
  await learner.goto(`/workspace/${implementation.id}`);
  // Implementation opens its room in one step.
  await learner.waitForURL(/\/workspace\//, { timeout: NAVIGATION });
  await expect(learner).toHaveURL(/\/workspace\/[0-9a-f-]+$/, { timeout: NAVIGATION });
  await expect(learner.getByTestId('phase-title')).toHaveText('Implementation', { timeout: NAVIGATION });
  expect(await stripPlace(learner)).toBe('Phase 3 of 3');
});

test("7. the learner's first code run in Implementation passes its visible tests", async () => {
  const implementation = S.phases!.find((one) => one.key === 'implementation')!;
  const saved = await call('PUT', `/phases/${implementation.id}/workspace`, S.learnerHeaders!, { files: markPassing(implementationSolution()) });
  expect(saved.ok(), 'the work saves').toBeTruthy();
  const started = await call('POST', `/phases/${implementation.id}/run`, S.learnerHeaders!);
  expect(started.ok(), 'the run starts').toBeTruthy();
  const runId = (await started.json()).id as string;
  let run: { status: string; result?: { stderr?: string } } | null = null;
  await expect
    .poll(async () => {
      run = await (await call('GET', `/runs/${runId}`, S.learnerHeaders!)).json();
      return run!.status;
    }, { timeout: 240_000, intervals: [1_000, 2_000] })
    .toMatch(/completed|failed/);
  // A host that cannot isolate learner code says so here, in the runner's own sentence.
  expect(run!.status, run!.result?.stderr).toBe('completed');
});

test('8. Implementation passes, and the completion record counts three phases', async () => {
  const phases = await passPhaseByApi(api, { headers: S.learnerHeaders! }, S.phases!, 3, markPassing(implementationSolution()), 'The hidden suites asked about case and spaces.');
  expect(phases.map((one) => [one.key, one.status]), 'every phase passed').toEqual(HELD.map((key) => [key, 'passed']));
  const enrolment = await mine();
  expect(enrolment.completedAt, 'the enrolment is complete').toBeTruthy();
  await learner.goto('/completion');
  const seal = learner.locator('.exp-certificate-seal');
  await expect(seal, 'the record counts three phases').toContainText('3 phases', { timeout: NAVIGATION });
  await expect(seal).toContainText('3 passes');
  await expect(learner.locator('.exp-certificate')).toContainText(`${THREE}.`);
});

test('9. no response anywhere in the journey had a status of 500 or more', async () => {
  expect(fiveHundreds).toEqual([]);
});
