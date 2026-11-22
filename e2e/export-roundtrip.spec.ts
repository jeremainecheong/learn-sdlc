import { expect, request as pwRequest, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import { INHERITED_TASK_KEY } from '@learnsdlc/shared';
import { ADMIN, registerByApi, staffByApi, type StaffParty } from './passing-work';
import { LEARNER_PASSWORD, signInAs } from './pw-fixtures';
import { deepReceiptRefusal, exportSavedSentence, shelfArchive, writeDeepReceiptSeam } from './upload-helpers';
import { listArchive } from '../apps/api/test/fixtures/upload-packs/archive';
import { API, assertLoopbackApi, RUN } from './support/env';
import { NAVIGATION, SANDBOX_RUN, UI_READY } from './support/timeouts';

/**
 * The export round trip in a browser: a teacher
 * exports a version they own whole and uploads the archive again, and the two
 * versions hold the same tasks.
 *
 * One fresh teacher (registered through the API and made a teacher by the
 * seeded admin, the e2e helpers' way; never a personal sign-in), in order,
 * each step its own test:
 *
 *  1. the teacher uploads the Shelf fixture (the archive `shelfArchive` builds
 *     for `e2e/teacher-upload.spec.ts`: the pack whole, its sealed files and
 *     solution with it), and the draft opens;
 *  2. a concept quiz is added beside Requirements' work task, through the
 *     editor's "Add a concept quiz" form;
 *  3. Implementation's Criteria step takes a new sentence and new weights;
 *  4. the draft is exported through the Export button, and the archive
 *     carries the quiz;
 *  5. the archive is uploaded again as a new project, whose draft opens with
 *     no warning: the export writes the folder layout, plain, so the door has
 *     nothing to convert or note;
 *  6. the new draft is published;
 *  7. the two versions' task lists read the same in the editor: phase tab by
 *     phase tab, each tab's label and count, the builder it draws, its task
 *     rows, and Implementation's criteria with the edit in them;
 *  8. no response in the journey had a status of 500 or more.
 *
 * The Shelf fixture is in the folder layout with plain texts, so
 * its upload carries no warning either and the draft opens at once. A warned
 * upload still opens from the warnings' "Open the draft" (`openUploadedDraft`
 * takes both), and then fails steps 1 or 5 on their warnings, as
 * `e2e/teacher-upload.spec.ts` fails its own.
 *
 * No real AI. Nothing here prints an address, a token or an id.
 */

test.describe.configure({ mode: 'serial' });

assertLoopbackApi(__filename);

const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EDITOR = /\/teacher\/projects\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})$/;

/** The quiz added in step 2. */
const QUIZ = {
  key: 'concepts',
  title: 'Concept check: the shelf order',
  brief: 'Answer the question before you write the story.\nIt is optional and does not gate the phase.',
  stem: 'Which order does the shelf page show the books in?',
  options: ['Shelf order, as the library keeps them', 'The order they were added'],
  explanation: 'The page shows the books in shelf order, the order the library keeps them in.',
};

/** Implementation's criterion 3 and the weights step 3 writes (they sum to 1). */
const CRITERION_SENTENCE = 'Each gap is filled in its own layer, and nothing the starter code kept is rewritten.';
const WEIGHTS: Record<number, string> = { 1: '0.35', 3: '0.35' };

/** The builders the editor draws, by their root test ids. */
const BUILDERS = ['requirements-builder', 'design-builder', 'implementation-builder', 'testing-builder', 'deployment-builder', 'maintenance-builder'];

const S: {
  run?: string;
  teacher?: StaffParty;
  title?: string;
  projectId?: string;
  versionId?: string;
  slug?: string;
  version?: string;
  archive?: Buffer;
  againProjectId?: string;
  againVersionId?: string;
} = {};

let ctx: BrowserContext;
let page: Page;
let api: APIRequestContext;
const fiveHundreds: string[] = [];

const redact = (url: string) => new URL(url).pathname.replace(IDS, ':id');

/** A call to the API as the teacher, with a 5xx recorded like the browser's. */
async function call(method: string, route: string, data?: unknown) {
  const res = await api.fetch(`${API}${route}`, { method, headers: S.teacher!.headers, data });
  if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${method} ${route.replace(IDS, ':id')}`);
  return res;
}

/** Whether this host's runner isolates learner code (/health/ready's probe; a macOS host answers 503). */
async function hostIsolates(): Promise<boolean> {
  const res = await api.fetch(`${API}/health/ready`);
  const body = (await res.json().catch(() => ({}))) as { dependencies?: { name: string; ok: boolean }[] };
  return body.dependencies?.find((one) => one.name === 'isolation')?.ok === true;
}

async function openPhaseTab(key: string) {
  await page.getByTestId(`project-phase-tab-${key}`).click();
  // The phase's label sits inside its tab in the editor's one row of section tabs.
  await expect(page.getByTestId(`project-section-${key}`)).toHaveAttribute('aria-selected', 'true');
}

/** The upload door on /teacher/projects, as `e2e/teacher-upload.spec.ts` drives it. */
async function uploadThroughDoor(title: string, name: string, buffer: Buffer) {
  await page.goto('/teacher/projects');
  await expect(page.getByTestId('projects-list')).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId('projects-loading')).toHaveCount(0, { timeout: UI_READY });
  await page.getByTestId('projects-upload-open').click();
  await expect(page.getByTestId('projects-upload')).toBeVisible();
  await page.getByTestId('projects-upload-title').fill(title);
  await page.getByTestId('projects-upload-file').setInputFiles({ name, mimeType: 'application/zip', buffer });
  await page.getByTestId('projects-upload-submit').click();
}

/**
 * The accepted upload's draft. The door opens it at once, or, when the upload
 * changed something on its way in, says what first and opens it from "Open
 * the draft". A refusal fails here with its own sentence.
 */
async function openUploadedDraft(): Promise<{ projectId: string; versionId: string; warnings: string[] }> {
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

interface PhaseRead {
  key: string;
  /** The tab's label: the phase's title and its task count. */
  tab: string;
  /** The builder the phase's panel draws. */
  builders: string[];
  /** The task rows the panel draws beside the builder: key, title, kind, Required or Optional. */
  rows: string[][];
  /** Implementation's criteria: key, title, sentence, weight. */
  criteria: string[][];
}

/** One version's task list as the editor draws it, phase tab by phase tab. */
async function readTaskList(projectId: string, versionId: string): Promise<PhaseRead[]> {
  await page.goto(`/teacher/projects/${projectId}/versions/${versionId}`);
  await expect(page.getByTestId('project-editor')).toBeVisible({ timeout: NAVIGATION });
  const tabs = page.locator('[data-testid^="project-phase-tab-"]');
  await expect(tabs.first()).toBeVisible({ timeout: NAVIGATION });
  const keys = await tabs.evaluateAll((els) => els.map((el) => (el.getAttribute('data-testid') ?? '').slice('project-phase-tab-'.length)));
  const read: PhaseRead[] = [];
  for (const key of keys) {
    await openPhaseTab(key);
    const panel = page.locator('#project-phase-panel');
    await expect.poll(() => panel.locator(BUILDERS.map((one) => `[data-testid="${one}"]`).join(', ')).count(), { message: `${key} draws its builder` }).toBeGreaterThan(0);
    const tab = (await page.getByTestId(`project-phase-tab-${key}`).innerText()).replace(/\s+/g, ' ').trim();
    const builders = await panel.evaluate((el, ids) => ids.filter((id) => el.querySelector(`[data-testid="${id}"]`)), BUILDERS);
    const rows = await panel.locator('[data-testid^="task-row-"]').evaluateAll((els) =>
      els.map((el) => {
        const taskKey = (el.getAttribute('data-testid') ?? '').slice('task-row-'.length);
        const text = (id: string) => (el.querySelector(`[data-testid="${id}-${taskKey}"]`)?.textContent ?? '').trim();
        return [taskKey, text('task-title'), text('task-type'), text('task-required')];
      }),
    );
    const criteria = await panel.locator('[data-testid="tdi-criteria"] li.tre-crit').evaluateAll((els) =>
      els.map((row) => {
        const title = (row.querySelector('input.tre-crit-title') as HTMLInputElement | null)?.value ?? row.querySelector('.tre-crit-title')?.textContent ?? '';
        const sentence = (row.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? row.querySelector('p.purpose')?.textContent ?? '';
        const weight = (row.querySelector('.tre-weight input') as HTMLInputElement | null)?.value ?? row.querySelector('.tre-weight strong')?.textContent ?? '';
        return [(row.querySelector('code.mono')?.textContent ?? '').trim(), title.trim(), sentence.trim(), String(Number(weight))];
      }),
    );
    read.push({ key, tab, builders, rows, criteria });
  }
  return read;
}

/** The same, from the API's draft view: each phase's tasks by key, title, kind, whether required, and order. */
async function apiTaskList(projectId: string, versionId: string) {
  const view = await (await call('GET', `/instructor/projects/${projectId}/versions/${versionId}`)).json();
  return (view.phases as any[]).map((phase) => ({
    key: phase.key,
    title: phase.title,
    tasks: (phase.tasks as any[]).map((task) => [task.taskKey || INHERITED_TASK_KEY, task.title, task.artefactType, task.required, task.order]),
  }));
}

test.beforeAll(async ({ browser }) => {
  const run = test.info().retry ? `${RUN}-r${test.info().retry}` : RUN;
  S.run = run;
  S.title = `Shelf round trip ${run}`;
  api = await pwRequest.newContext();
  // A fresh teacher: registered, then made a teacher by the seeded admin.
  const admin = await staffByApi(api, ADMIN);
  const who = await registerByApi(api, { name: 'Rowan Roundtrip', email: `export-roundtrip-${run}@e2e-roundtrip.test`, password: LEARNER_PASSWORD });
  const promoted = await api.patch(`${API}/admin/users/${who.userId}`, { headers: admin.headers, data: { role: 'INSTRUCTOR' } });
  expect(promoted.ok(), 'the admin makes the account a teacher').toBeTruthy();
  S.teacher = await staffByApi(api, who);
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  ctx.on('response', (res) => {
    if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${res.request().method()} ${redact(res.url())}`);
  });
  page = await ctx.newPage();
  await signInAs(page, who.email, who.password);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
});

test.afterAll(async () => {
  await ctx?.close();
  await api?.dispose();
});

test('1. a fresh teacher uploads Shelf, owned whole, and its draft opens', async () => {
  await uploadThroughDoor(S.title!, 'shelf.zip', shelfArchive());
  const draft = await openUploadedDraft();
  S.projectId = draft.projectId;
  S.versionId = draft.versionId;
  // The fixture is plain and in the folder layout, so the door converts nothing and says nothing.
  expect(draft.warnings, 'the upload of the Shelf fixture carries no warning').toEqual([]);
  await expect(page.getByTestId('project-status')).toHaveText('Draft 0.1.0', { timeout: NAVIGATION });
  await expect(page.getByRole('heading', { level: 1, name: S.title })).toBeVisible();
  const view = await (await call('GET', `/instructor/projects/${S.projectId}/versions/${S.versionId}`)).json();
  expect(view.editable, 'the teacher owns the draft').toBe(true);
  expect((view.phases as { key: string }[]).map((one) => one.key)).toEqual(['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance']);
  S.slug = view.slug;
  S.version = view.version;
});

test('2. a concept quiz is added beside Requirements\' work task', async () => {
  await openPhaseTab('requirements');
  await expect(page.getByTestId('requirements-builder')).toBeVisible({ timeout: UI_READY });
  await page.getByTestId('project-add-task').click();
  const form = page.getByTestId('task-form');
  await expect(form).toBeVisible();
  await form.getByTestId('task-form-key').fill(QUIZ.key);
  await form.getByTestId('task-form-title').fill(QUIZ.title);
  await form.getByTestId('task-form-brief').fill(QUIZ.brief);
  // Optional: an optional quiz never gates the phase, and takes no retake rule.
  await form.getByTestId('task-form-required').uncheck();
  await form.getByTestId('quiz-question-stem-0').fill(QUIZ.stem);
  await form.getByTestId('quiz-option-0-0').fill(QUIZ.options[0]);
  await form.getByTestId('quiz-option-0-1').fill(QUIZ.options[1]);
  await form.getByTestId('quiz-option-correct-0-0').check();
  await form.getByTestId('quiz-question-explanation-0').fill(QUIZ.explanation);
  await form.getByTestId('task-form-submit').click();
  await expect(page.getByTestId('task-form')).toHaveCount(0, { timeout: UI_READY });
  const row = page.getByTestId(`task-row-${QUIZ.key}`);
  await expect(row).toBeVisible({ timeout: UI_READY });
  await expect(row.getByTestId(`task-title-${QUIZ.key}`)).toHaveText(QUIZ.title);
  await expect(row.getByTestId(`task-required-${QUIZ.key}`)).toHaveText('Optional');
  await expect(page.getByTestId('project-phase-tab-requirements')).toContainText('2');
  const view = await (await call('GET', `/instructor/projects/${S.projectId}/versions/${S.versionId}`)).json();
  const tasks = view.phases.find((one: { key: string }) => one.key === 'requirements').tasks as { taskKey: string; quiz?: unknown }[];
  expect(tasks.map((one) => one.taskKey)).toContain(QUIZ.key);
  expect(tasks.find((one) => one.taskKey === QUIZ.key)?.quiz, 'the draft holds the quiz').toBeTruthy();
});

test("3. Implementation's Criteria step takes a new sentence and new weights", async () => {
  await openPhaseTab('implementation');
  await expect(page.getByTestId('implementation-builder')).toBeVisible({ timeout: UI_READY });
  const criteria = page.getByTestId('tdi-criteria');
  await expect(criteria.getByTestId('tdi-criteria-fixed')).toBeVisible();
  await criteria.getByLabel('Criterion 3 description', { exact: true }).fill(CRITERION_SENTENCE);
  for (const [n, weight] of Object.entries(WEIGHTS)) await criteria.getByLabel(`Criterion ${n} weight`, { exact: true }).fill(weight);
  await expect(criteria.getByTestId('tre-weights-sum')).toContainText('Weights sum to 1.0');
  await criteria.getByTestId('tre-criteria-save').click();
  await expect(criteria.getByTestId('tre-criteria-status')).toHaveText('Saved', { timeout: UI_READY });
  // The draft holds the edit.
  const view = await (await call('GET', `/instructor/projects/${S.projectId}/versions/${S.versionId}`)).json();
  const rubric = view.phases.find((one: { key: string }) => one.key === 'implementation').tasks[0].rubric as { criteria: { description: string; weight: number }[] };
  expect(rubric.criteria[2].description).toBe(CRITERION_SENTENCE);
  expect(rubric.criteria.map((one) => one.weight)).toEqual([0.35, 0.15, 0.35, 0.15]);
});

test('4. the draft exports through the Export button, and the archive carries the quiz', async () => {
  await page.goto(`/teacher/projects/${S.projectId}/versions/${S.versionId}`);
  await expect(page.getByTestId('project-editor')).toBeVisible({ timeout: NAVIGATION });
  const answered = page.waitForResponse((res) => /\/export$/.test(new URL(res.url()).pathname) && res.request().method() === 'GET');
  const downloading = page.waitForEvent('download', { timeout: SANDBOX_RUN }).catch((error: Error) => error);
  await page.getByTestId('project-export').click();
  const res = await answered;
  expect(res.status(), `the export answers an archive${res.status() === 200 ? '' : `, not: ${(await res.text()).slice(0, 600)}`}`).toBe(200);
  const download = await downloading;
  if (download instanceof Error) throw download;
  const name = `${S.slug}-${S.version}.zip`;
  expect(download.suggestedFilename()).toBe(name);
  await expect(page.getByTestId('project-export-done')).toHaveText(exportSavedSentence(name));
  S.archive = fs.readFileSync((await download.path())!);
  const names = listArchive(S.archive).map((one) => one.name);
  expect(names.filter((one) => one.endsWith(`/quizzes/${QUIZ.key}.json`)), 'the archive carries the quiz').toHaveLength(1);
});

test('5. the archive uploaded again opens a new draft, with no older-layout note', async () => {
  await uploadThroughDoor(`${S.title} again`, `${S.slug}-${S.version}.zip`, S.archive!);
  const again = await openUploadedDraft();
  expect(again.projectId, 'a new project').not.toBe(S.projectId);
  S.againProjectId = again.projectId;
  S.againVersionId = again.versionId;
  // The export writes the folder layout with plain texts, so the door has nothing to convert or note.
  expect(again.warnings, 'the re-upload of an export carries no warning').toEqual([]);
  await expect(page.getByTestId('project-status')).toHaveText('Draft 0.1.0', { timeout: NAVIGATION });
});

test('6. the new draft is published', async () => {
  const at = `/instructor/projects/${S.againProjectId}/versions/${S.againVersionId}`;
  const isolates = await hostIsolates();
  // The checks are under the editor's Validate tab.
  await page.getByTestId('project-section-validate').click();
  await page.getByTestId('project-validate').click();
  await expect(page.getByTestId('project-validation-tier')).toBeVisible({ timeout: NAVIGATION });
  if (isolates) {
    // A host with a kernel boundary runs deep validation for real.
    await page.getByTestId('deep-validation-open').click();
    await expect(page.getByTestId('deep-validation-start')).toBeEnabled({ timeout: UI_READY });
    await page.getByTestId('deep-validation-start').click();
    await expect(page.getByTestId('deep-validation-status')).toHaveText(/^Passed\. Finished /, { timeout: 240_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('deep-validation-dialog')).toHaveCount(0);
  }
  // The publish form is under the editor's Publish tab.
  await page.getByTestId('project-section-publish').click();
  await page.getByTestId('project-publish-version').fill('1.0.0');
  await page.getByTestId('project-publish-notes').fill('The round trip publishes the exported shelf.');
  await page.getByTestId('project-publish').click();
  await page.getByTestId('project-publish-confirm-yes').click();
  if (!isolates) {
    // macOS runs no learner code: publish is refused without a deep receipt, then the
    // declared MACOS-DEEP-RECEIPT seam (e2e/upload-helpers.ts) writes one.
    await expect(page.getByTestId('project-publish-error')).toContainText(deepReceiptRefusal('Implementation'), { timeout: NAVIGATION });
    writeDeepReceiptSeam(S.againVersionId!);
    await page.reload();
    await expect(page.getByTestId('project-editor')).toBeVisible({ timeout: NAVIGATION });
    // The checks are under the editor's Validate tab.
    await page.getByTestId('project-section-validate').click();
    await page.getByTestId('project-validate').click();
    await expect(page.getByTestId('project-validation-tier')).toBeVisible({ timeout: NAVIGATION });
    // The publish form is under the editor's Publish tab.
    await page.getByTestId('project-section-publish').click();
    await page.getByTestId('project-publish-version').fill('1.0.0');
    await page.getByTestId('project-publish').click();
    await page.getByTestId('project-publish-confirm-yes').click();
  }
  await expect(page.getByTestId('project-published')).toContainText('Version 1.0.0 is published.', { timeout: NAVIGATION });
  const view = await (await call('GET', at)).json();
  expect(view.status).toBe('published');
});

test("7. the two versions' task lists read the same, phase tab by phase tab", async () => {
  const first = await readTaskList(S.projectId!, S.versionId!);
  const second = await readTaskList(S.againProjectId!, S.againVersionId!);
  // What the first version holds, so equal lists cannot be two empty ones.
  expect(first.map((one) => one.key)).toEqual(['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance']);
  expect(first.every((one) => one.builders.length === 1), 'every phase draws its builder').toBe(true);
  expect(first.find((one) => one.key === 'requirements')!.rows).toEqual([[QUIZ.key, QUIZ.title, 'quiz', 'Optional']]);
  const criteria = first.find((one) => one.key === 'implementation')!.criteria;
  expect(criteria.map((one) => one[3])).toEqual(['0.35', '0.15', '0.35', '0.15']);
  expect(criteria[2][2]).toBe(CRITERION_SENTENCE);
  // And the second reads the same.
  expect(second).toEqual(first);
  expect(await apiTaskList(S.againProjectId!, S.againVersionId!)).toEqual(await apiTaskList(S.projectId!, S.versionId!));
});

test('8. no response anywhere in the journey had a status of 500 or more', async () => {
  expect(fiveHundreds).toEqual([]);
});
