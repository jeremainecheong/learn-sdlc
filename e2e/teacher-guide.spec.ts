import { expect, request as pwRequest, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  GUIDE_STEPS,
  PREVIEW_STEP_HELP,
  STARTER_WARNING,
  UPLOAD_REFUSAL_CODES,
  UPLOAD_REFUSAL_HELP,
} from '@learnsdlc/shared';
import { INSTRUCTOR } from './passing-work';
import { signInAs, teacherHome } from './pw-fixtures';
import { captureMasked, found, sealMarker, sha256Hex } from './upload-helpers';
import { AI_STUB_URL, API, assertLoopbackApi, RUN } from './support/env';
import { NAVIGATION, SANDBOX_RUN, UI_READY } from './support/timeouts';

/**
 * The teacher's guided path, walked natively in a
 * browser on the local stack (the config's webServer: the loopback AI stub,
 * the built API on a fresh sqlite file, the built web).
 *
 *  1. the seeded instructor signs in and opens Projects from the sidebar;
 *  2. Start here: its warning and its stateless rail; the starter and the
 *     shelf example downloaded by their buttons (the staff route answers 200,
 *     each saves under the API's Content-Disposition name, and the saved
 *     bytes' sha256 is the recorded one);
 *  3. the downloaded archive uploaded through the door: the starter is
 *     already in the story kind, so the upload converts nothing, no warnings
 *     panel is drawn and the draft opens at once;
 *  4. the editor's rail: each step's state, the progress line, the seal and
 *     preview steps' help, axe clean at 1280 and 390;
 *  5. a hidden test sealed under tests/<name>;
 *  6. fast validation;
 *  7. the Preview button opens the learner preview; the Preview mark is
 *     written by the preview page
 *     once it has loaded (never by the click), and back on the editor, in the same tab,
 *     the rail's Preview step reads Done;
 *  7b. Export saves the archive and the rail's Export step reads Done in this
 *     tab and in a new tab of the same browser (localStorage),
 *     while a fresh browser context (no marker) still reads Not yet for both;
 *  8. /teacher/guide renders the document, every step's section and the
 *     refusal table (section 7's own table has no fix column), names no course
 *     code (matched by its shape, never spelled here), with axe clean on the
 *     rail and on the page at 1280 and at 390, where any code block that
 *     scrolls sideways takes a tab stop (and one drawn for the check, with
 *     none, is reported);
 *  9. back on Projects, Start here's line names the teacher's own starter and
 *     shelf downloads from test 2 (read from the real audit route);
 *     then a refusal with its explainer: a file that is not a zip, NOT_A_ZIP.
 *
 * Every key assertion carries a negative control run in the same test (the
 * opposite expectation, which must fail): see `negative()`. The controls are
 * written to the run record beside the screenshots.
 *
 * No real AI (nothing here asks a model; the stub's counts are recorded). No
 * status of 500 or more anywhere (asserted last). Screenshots go through
 * `captureMasked`; nothing here prints an address, a token, a code or an id.
 */

test.describe.configure({ mode: 'serial' });

assertLoopbackApi(__filename);

/** Per worker: a retry of this serial file (a fixed E2E_RUN_ID) uploads under a new title. */
const NONCE = crypto.randomBytes(2).toString('hex');
const TITLE = `Starter guide ${RUN}${NONCE}`;
const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/* ------------------------------- pinned words ------------------------------- */
// Literals with their source, so the page is held to the contract's words.

/** apps/api/src/authoring/starter-archive.generated.ts: the starter archive (its own slug, 'starter'). */
const STARTER_SIZE = 158787;
/* Generated content, not an AI-request golden: this pin follows the digest
   apps/api/src/authoring/starter-archive.generated.ts serves, re-pinned by hand when the starter is regenerated. */
const STARTER_SHA256 = 'af815a97dfe7bfe4e652d1a83b90853e60bbd58dcf7a69beaf9974c267e500f9';
/**
 * apps/web/components/staff/guide/StartHere.tsx STARTER_DOWNLOADS.<name>.file
 * (the API's Content-Disposition names).
 */
const STARTER_SAVED_AS = 'learnsdlc-starter.zip';
const SHELF_SAVED_AS = 'learnsdlc-shelf.zip';
/** A name the starter must not save under (a negative control only). */
const STARTER_SAVED_AS_BEFORE = 'starter-project.zip';
/** apps/web/lib/storage-keys.ts guideMarkKey: per browser (localStorage), per version. */
const guideMarkKey = (mark: 'previewed' | 'exported', versionId: string) => `lsdlc_guide_${mark}:${versionId}`;
/** docs/teacher-project-upload.md section 7: the table keeps code and sentence only. */
const SECTION7_HEADERS = ['Code', 'What the page says'];
const SECTION7_WHERE_FIX = 'How to fix each one is on the Teacher guide page in the app, under Every refusal, and how to fix it';
/** docs/teacher-project-upload.md section 7. */
const SECTION7_RESERVED = 'An upload is not refused with RESERVED_NAME today';
/**
 * A course code, by its SHAPE only (this file never spells one): two to four
 * capitals, an optional space or hyphen, three or four digits, an optional
 * capital. Phrases of the same shape that are no course are excluded by name,
 * each one listed here: an HTTP status ('HTTP 429').
 */
const COURSE_CODE_SHAPE = /\b[A-Z]{2,4}[ -]?\d{3,4}[A-Z]?\b/g;
const NOT_A_COURSE_CODE = [/^HTTPS? ?\d{3}$/];
function courseCodes(text: string): { hits: string[]; excluded: string[] } {
  const all = text.match(COURSE_CODE_SHAPE) ?? [];
  const excluded = all.filter((one) => NOT_A_COURSE_CODE.some((rule) => rule.test(one)));
  return { hits: all.filter((one) => !excluded.includes(one)), excluded };
}
/** A synthetic token of the course-code shape (no real code), injected only to prove the guard catches one. */
const SYNTHETIC_CODE = 'QZX 917';
/** packages/shared/src/upload-contract.ts UPLOAD_REFUSALS.NOT_A_ZIP. */
const NOT_A_ZIP_SENTENCE = 'This file is not a zip archive, so nothing was imported.';
/** packages/shared/src/teacher-path.ts UPLOAD_REFUSAL_HELP.NOT_A_ZIP. */
const NOT_A_ZIP_HELP = {
  title: 'The file is not a zip archive',
  fix: 'Choose the .zip of your project folder. Other kinds of archive are not read.',
  guideAnchor: '1-prepare-the-archive',
};
/** packages/shared/src/teacher-path.ts GUIDE_STEPS seal help[1]. */
const SEAL_HELP_FOLDER = 'Put a hidden test under a folder, such as tests/<name>.';
/** apps/web/components/staff/preview/copy.ts PREVIEW_BANNER. */
const PREVIEW_BANNER = 'Preview: nothing here is saved, graded or seen by learners';
/**
 * The starter's hand-written interview, the file the product reads for the
 * stakeholder: its persona and the opening the preview card shows.
 */
const STARTER_INTERVIEW = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../apps/api/test/fixtures/upload-packs/starter/phases/01-requirements/interview.json'), 'utf8'),
) as { persona: { name: string }; opening: string };
const STARTER_PERSONA = STARTER_INTERVIEW.persona.name;
const STARTER_OPENING = STARTER_INTERVIEW.opening;
/** WCAG 2.0/2.1 A and AA, serious and critical: e2e/a11y-axe.spec.ts's own scope. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const AXE_FAILING = new Set(['serious', 'critical']);
const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/** A recorded archive, read from the generated module the API serves (not imported: it is API source). */
function recordedArchive(filename: string): { size: number; sha256: string; filename: string } {
  const generated = fs.readFileSync(path.resolve(__dirname, '../apps/api/src/authoring/starter-archive.generated.ts'), 'utf8');
  const at = generated.indexOf(`filename: '${filename}'`);
  expect(at, `the generated module holds the ${filename} record`).toBeGreaterThan(-1);
  const tail = generated.slice(at, at + 400);
  return {
    filename,
    size: Number(/size: (\d+)/.exec(tail)![1]),
    sha256: /sha256: '([0-9a-f]{64})'/.exec(tail)![1],
  };
}
const recordedStarter = () => recordedArchive('learnsdlc-starter.zip');

/** The file name a Content-Disposition header gives. */
const dispositionName = (header: string | undefined) => /filename="([^"]+)"/.exec(header ?? '')?.[1] ?? null;

/* ------------------------------- run record ------------------------------- */

const SHOTS_ROOT = (() => {
  const fromEnv = process.env.E2E_JOURNEY_SHOTS;
  if (fromEnv) return path.resolve(fromEnv);
  // Default: Playwright's own output folder (cleared each run). Any other folder is chosen only by E2E_JOURNEY_SHOTS.
  return path.resolve(__dirname, '../test-results/journey-shots');
})();
const EPOCH = `guide-${RUN}-${Date.now()}`;
const record: {
  spec: string;
  epoch: string;
  negatives: { label: string; failedAsItShould: boolean; assertion: string }[];
  shots: { file: string; sha256: string; bytes: number }[];
  railStates: Record<string, Record<string, string>>;
  axe: Record<string, { violations: { id: string; impact: string | null; count: number }[] }>;
  download: Record<string, unknown>;
  upload: Record<string, unknown>;
  aiStub: { before: string; after: string };
  courseGuard?: { shape: string; excludedRules: string[]; hits: string[]; excluded: string[]; syntheticCaught: boolean };
  outcomes: { title: string; status: string }[];
} = {
  spec: 'e2e/teacher-guide.spec.ts',
  epoch: EPOCH,
  negatives: [],
  shots: [],
  railStates: {},
  axe: {},
  download: {},
  upload: {},
  aiStub: { before: '', after: '' },
  outcomes: [],
};

/**
 * A negative control: `fn` holds the OPPOSITE of a key assertion and must
 * throw. If it passes, the key assertion could not have caught the fault it
 * names, and the test fails here.
 */
/** The failing assertion's first lines, colour codes out, and no token, address or join code in it. */
function failingLine(err: unknown, codes: readonly string[]): string {
  let text = String((err as Error)?.message ?? err)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((one) => one.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' | ');
  for (const code of codes) text = text.split(code).join('<code>');
  return text
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '<token>')
    .replace(/Bearer\s+\S{12,}/g, 'Bearer <token>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}\b/g, '<code?>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .slice(0, 400);
}

async function negative(label: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  let failed = false;
  let assertion = '';
  try {
    await fn();
  } catch (err) {
    failed = true;
    assertion = failingLine(err, []);
  }
  record.negatives.push({ label, failedAsItShould: failed, assertion });
  expect(failed, `negative control "${label}" fails as it should`).toBe(true);
}

/** A masked screenshot (no code exists in this spec, but the scan still runs). */
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_ROOT) return;
  const dir = path.join(SHOTS_ROOT, EPOCH);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `${name}.png`);
  await captureMasked(page, file, []);
  const bytes = fs.readFileSync(file);
  record.shots.push({ file: path.relative(SHOTS_ROOT, file), sha256: sha256Hex(bytes), bytes: bytes.length });
}

let ctx: BrowserContext;
let teacher: Page;
let api: APIRequestContext;
let staffHeaders: { authorization: string };
const fiveHundreds: string[] = [];
const S: { archive?: Buffer; projectId?: string; versionId?: string; sealMarker?: string } = {};

async function stubCounts(): Promise<Record<string, number>> {
  const res = await fetch(`${AI_STUB_URL}/__stub/counts`);
  if (!res.ok) throw new Error(`the AI stub did not answer its counts (${res.status})`);
  return ((await res.json()).counts ?? {}) as Record<string, number>;
}

async function openPhaseTab(page: Page, key: string) {
  await page.getByTestId(`project-phase-tab-${key}`).click();
  // The phase's label sits inside its tab in the editor's one row of section tabs.
  await expect(page.getByTestId(`project-section-${key}`)).toHaveAttribute('aria-selected', 'true');
}

/**
 * Open the editor's rail where it is folded. The editor's
 * checklist folds to its progress line once anything is saved from the page,
 * behind a "Show the steps" toggle; the rail is read here with its steps in
 * view, as a teacher who opened it reads it. A rail with no toggle is left as it is.
 */
async function showRailSteps(page: Page, railTestId = 'guide-rail'): Promise<void> {
  const toggle = page.getByTestId(`${railTestId}-toggle`);
  if (!(await toggle.count())) return;
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/** Each rail step's data-state, by key (no attribute on a stateless rail). */
async function railStates(page: Page, railTestId: string): Promise<Record<string, string>> {
  return page.getByTestId(railTestId).evaluate((rail) => {
    const out: Record<string, string> = {};
    for (const step of Array.from(rail.querySelectorAll('[data-testid^="guide-step-"]'))) {
      const id = step.getAttribute('data-testid')!;
      if (!/^guide-step-[a-z-]+$/.test(id) || id.startsWith('guide-step-go-') || id.startsWith('guide-step-docs-')) continue;
      out[id.replace(/^guide-step-/, '')] = step.getAttribute('data-state') ?? '(none)';
    }
    return out;
  });
}

/** axe-core, injected, scoped to `include` (or the whole document), every <details> in scope opened first. */
async function runAxe(page: Page, include: string | null): Promise<{ id: string; impact: string | null; count: number; targets: string[] }[]> {
  await page.evaluate((sel) => {
    const root = sel ? document.querySelector(sel) : document;
    root?.querySelectorAll('details').forEach((one) => ((one as HTMLDetailsElement).open = true));
  }, include);
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(
    async ({ tags, sel }) => {
      const axe = (window as unknown as { axe: any }).axe;
      const r = await axe.run(sel ? { include: [[sel]] } : document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
      return r.violations.map((v: any) => ({
        id: v.id,
        impact: v.impact ?? null,
        count: v.nodes.length,
        targets: v.nodes.slice(0, 3).map((n: any) => [].concat(n.target).join(' ')),
      }));
    },
    { tags: AXE_TAGS, sel: include },
  );
}

const failing = (violations: { id: string; impact: string | null; count: number; targets: string[] }[]) =>
  violations.filter((v) => AXE_FAILING.has(v.impact ?? '')).map((v) => `${v.id} (${v.impact}, ${v.count}): ${v.targets.join(' | ')}`);

/** The two widths of the axe check: the walk's own 1280, and e2e/a11y-axe.spec.ts's phone-390. */
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/**
 * Resize, then read nothing until the page has settled: two frames (the
 * scroll-focus watcher syncs a tab stop on the frame after a resize), every
 * finite animation and transition finished, then one more frame. A read taken
 * mid-transition is a colour-contrast false red.
 * The pointer is parked at the far edge first: left over the sidebar from the
 * last click, it would hold the phone rail open over the page.
 */
async function atViewport(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.mouse.move(size.width - 2, Math.round(size.height / 2));
  await page.evaluate(async () => {
    const frame = () => new Promise((done) => requestAnimationFrame(() => done(null)));
    await frame();
    await frame();
    const finite = document.getAnimations().filter((one) => Number.isFinite(Number(one.effect?.getComputedTiming().endTime)));
    await Promise.all(finite.map((one) => one.finished.catch(() => null)));
    await frame();
  });
}

/** A staff API call; a read is sent once more if the kept-alive socket was closed under it, a write never. */
async function call(method: string, route: string, data?: unknown) {
  let res;
  try {
    res = await api.fetch(`${API}${route}`, { method, headers: staffHeaders, data });
  } catch (err) {
    if (method !== 'GET' || !/ECONNRESET|socket hang up/.test(String(err))) throw err;
    res = await api.fetch(`${API}${route}`, { method, headers: staffHeaders, data });
  }
  if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${method} ${route.replace(IDS, ':id')}`);
  return res;
}

const editorPattern = /\/teacher\/projects\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})$/;

test.beforeAll(async ({ browser }) => {
  record.aiStub.before = JSON.stringify(await stubCounts());
  api = await pwRequest.newContext();
  const login = await api.post(`${API}/auth/login`, { data: { email: INSTRUCTOR.email, password: INSTRUCTOR.password } });
  expect(login.ok(), 'the seeded instructor signs in through the API').toBeTruthy();
  staffHeaders = { authorization: `Bearer ${(await login.json()).token}` };
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  ctx.on('response', (res) => {
    if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname.replace(IDS, ':id')}`);
  });
  teacher = await ctx.newPage();
});

test.afterEach(async ({}, info) => {
  record.outcomes.push({ title: info.title, status: info.status ?? 'unknown' });
});

test.afterAll(async () => {
  record.aiStub.after = JSON.stringify(await stubCounts().catch(() => ({})));
  const body = `${JSON.stringify(record, null, 1)}\n`;
  fs.mkdirSync(test.info().outputDir, { recursive: true });
  fs.writeFileSync(path.join(test.info().outputDir, 'journey-record.json'), body, { mode: 0o600 });
  if (SHOTS_ROOT) {
    const dir = path.join(SHOTS_ROOT, EPOCH);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'record.json'), body, { mode: 0o600 });
  }
  await ctx?.close();
  await api?.dispose();
});

test('1. the seeded instructor signs in and opens Projects from the sidebar', async () => {
  await signInAs(teacher, INSTRUCTOR.email, INSTRUCTOR.password);
  await teacherHome(teacher);
  await teacher.getByTestId('nav-projects').first().click();
  await teacher.waitForURL('**/teacher/projects', { timeout: NAVIGATION });
  // The press leaves the pointer on the rail, and the rail stays peeked open over the page for as long as it
  // rests there (Sidebar.tsx onPointerEnter): its Teacher guide row then lies over "Download the starter" and
  // takes the press meant for it. A teacher's pointer goes on into the page; this one is parked there, as
  // atViewport parks it after a resize.
  await teacher.mouse.move(DESKTOP.width - 2, Math.round(DESKTOP.height / 2));
  await expect(teacher.getByTestId('projects-loading')).toHaveCount(0, { timeout: NAVIGATION });
});

test('2. Start here: the warning, the stateless rail, and the starter downloaded with its recorded bytes', async () => {
  const start = teacher.getByTestId('guide-start-here');
  await expect(start).toBeVisible({ timeout: UI_READY });
  await expect(start.getByRole('heading', { name: 'Start here' })).toBeVisible();
  await expect(teacher.getByTestId('guide-starter-warning')).toHaveText(STARTER_WARNING);
  // The rail on this page has no draft to read, so no step carries a state.
  const projectsRail = teacher.getByTestId('guide-rail-projects');
  await expect(projectsRail.locator('[data-testid^="guide-step-"][data-state]')).toHaveCount(0);
  await expect(projectsRail.locator('details[data-testid^="guide-step-"]')).toHaveCount(GUIDE_STEPS.length);
  record.railStates.projects = await railStates(teacher, 'guide-rail-projects');
  await negative('Start here rail carries a state', () =>
    expect(projectsRail.locator('[data-testid^="guide-step-"][data-state]')).toHaveCount(GUIDE_STEPS.length, { timeout: 1_500 }),
  );
  await shot(teacher, 'g01-projects-start-here');

  const recorded = recordedStarter();
  expect(recorded, 'the generated module and the recorded starter archive agree').toEqual({ filename: 'learnsdlc-starter.zip', size: STARTER_SIZE, sha256: STARTER_SHA256 });
  const answered = teacher.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/instructor/starter/starter' && res.request().method() === 'GET');
  const [download] = await Promise.all([teacher.waitForEvent('download'), teacher.getByTestId('guide-starter-starter').click()]);
  const res = await answered;
  expect(res.status(), 'the staff route answers the starter').toBe(200);
  expect(res.headers()['content-type']).toMatch(/^application\/zip/);
  expect(res.headers()['content-disposition']).toContain('learnsdlc-starter.zip');
  // The browser saves under the API's own name.
  expect(download.suggestedFilename()).toBe(STARTER_SAVED_AS);
  expect(download.suggestedFilename(), 'saved under the Content-Disposition name').toBe(dispositionName(res.headers()['content-disposition']));
  await negative('the starter saves under its old name', () => expect(download.suggestedFilename()).toBe(STARTER_SAVED_AS_BEFORE));
  const bytes = fs.readFileSync((await download.path())!);
  expect(bytes.length, 'the saved archive is the recorded size').toBe(STARTER_SIZE);
  expect(sha256Hex(bytes), 'the saved archive is the recorded bytes').toBe(STARTER_SHA256);
  await negative('one changed byte still has the recorded sha256', () => {
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 0xff;
    expect(sha256Hex(changed)).toBe(STARTER_SHA256);
  });
  await expect(teacher.getByTestId('guide-starter-error')).toHaveCount(0);
  S.archive = bytes;
  record.download = { route: 'GET /api/v1/instructor/starter/starter', status: res.status(), savedAs: download.suggestedFilename(), size: bytes.length, sha256: sha256Hex(bytes) };
  // The shelf example: its own button, its own name, its recorded bytes.
  const shelfRecord = recordedArchive(SHELF_SAVED_AS);
  const shelfAnswered = teacher.waitForResponse((one) => new URL(one.url()).pathname === '/api/v1/instructor/starter/shelf' && one.request().method() === 'GET');
  const [shelfDownload] = await Promise.all([teacher.waitForEvent('download'), teacher.getByTestId('guide-starter-shelf').click()]);
  const shelfRes = await shelfAnswered;
  expect(shelfRes.status(), 'the staff route answers the shelf example').toBe(200);
  expect(shelfRes.headers()['content-type']).toMatch(/^application\/zip/);
  expect(dispositionName(shelfRes.headers()['content-disposition'])).toBe(SHELF_SAVED_AS);
  expect(shelfDownload.suggestedFilename()).toBe(SHELF_SAVED_AS);
  const shelfBytes = fs.readFileSync((await shelfDownload.path())!);
  expect(shelfBytes.length, 'the saved shelf example is the recorded size').toBe(shelfRecord.size);
  expect(sha256Hex(shelfBytes), 'the saved shelf example is the recorded bytes').toBe(shelfRecord.sha256);
  await negative('the shelf example saves under the starter name', () => expect(shelfDownload.suggestedFilename()).toBe(STARTER_SAVED_AS));
  await expect(teacher.getByTestId('guide-starter-error')).toHaveCount(0);
  record.download.shelf = { route: 'GET /api/v1/instructor/starter/shelf', status: shelfRes.status(), savedAs: shelfDownload.suggestedFilename(), size: shelfBytes.length, sha256: sha256Hex(shelfBytes) };
  await shelfDownload.delete();
  // A caller with no session is refused the same door (the API's guard, before any byte).
  const anonymous = await pwRequest.newContext();
  try {
    const refused = await anonymous.get(`${API}/instructor/starter/starter`);
    expect(refused.status(), 'no session, no starter').toBe(401);
  } finally {
    await anonymous.dispose();
  }
});

test('3. the downloaded starter uploaded: no warnings panel, the draft opens at once', async () => {
  await teacher.getByTestId('projects-upload-open').click();
  await expect(teacher.getByTestId('projects-upload')).toBeVisible();
  await teacher.getByTestId('projects-upload-title').fill(TITLE);
  await teacher.getByTestId('projects-upload-file').setInputFiles({ name: STARTER_SAVED_AS, mimeType: 'application/zip', buffer: S.archive! });
  const answered = teacher.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/instructor/projects/upload' && res.request().method() === 'POST');
  await teacher.getByTestId('projects-upload-submit').click();
  const res = await answered;
  expect(res.status(), 'the starter is accepted').toBe(201);
  const made = await res.json();
  // The starter's Requirements is already the story kind, so the upload converts nothing and answers no warnings.
  expect(made.warnings, 'the upload changed nothing on the way in').toBeUndefined();
  record.upload = { status: res.status(), warnings: null };

  // With nothing to report, the door opens the draft itself: the warnings panel is never drawn.
  await teacher.waitForURL(editorPattern, { timeout: SANDBOX_RUN });
  await expect(teacher.getByTestId('projects-upload-warnings')).toHaveCount(0);
  await negative('the warnings panel is drawn for an upload that changed nothing', () =>
    expect(teacher.getByTestId('projects-upload-warnings')).toBeVisible({ timeout: 1_500 }),
  );
  const [, projectId, versionId] = editorPattern.exec(new URL(teacher.url()).pathname)!;
  expect(projectId).toBe(made.projectId);
  expect(versionId).toBe(made.versionId);
  S.projectId = projectId;
  S.versionId = versionId;
  await expect(teacher.getByTestId('project-status')).toHaveText('Draft 0.1.0', { timeout: NAVIGATION });
  await expect(teacher.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
  await shot(teacher, 'g02-upload-opened-draft');
});

test('4. the editor rail: each step in words and state, the progress line, the seal and preview help', async () => {
  const rail = teacher.getByTestId('guide-rail');
  await expect(rail).toBeVisible({ timeout: NAVIGATION });
  await showRailSteps(teacher);
  await expect(rail.locator('details[data-testid^="guide-step-"]')).toHaveCount(GUIDE_STEPS.length);
  const states = await railStates(teacher, 'guide-rail');
  record.railStates.afterUpload = states;
  expect(Object.keys(states), 'the ten steps, in order').toEqual(GUIDE_STEPS.map((one) => one.key));
  // Read from the draft: uploaded, so prepared and uploaded; nothing deep-validated, published or assigned yet.
  expect(states.prepare).toBe('done');
  expect(states.upload).toBe('done');
  // The starter passes fast validation as uploaded, and carries its hidden tests, solutions and mutants.
  expect(states.refine).toBe('done');
  expect(states.seal).toBe('done');
  expect(states['deep-validate']).toBe('todo');
  expect(states.preview).toBe('todo');
  expect(states.publish).toBe('todo');
  expect(states.assign).toBe('todo');
  expect(states['sign-off']).toBe('todo');
  expect(states.export).toBe('todo');
  await negative('deep-validate reads done before any deep validation', () => expect(states['deep-validate']).toBe('done'));
  // The words beside each state (colour is never the only signal).
  for (const step of GUIDE_STEPS) {
    const word = { done: 'Done', todo: 'Not yet', stale: 'Out of date', 'n/a': 'Does not apply' }[states[step.key]];
    await expect(teacher.getByTestId(`guide-step-${step.key}`).locator('summary')).toContainText(word!);
  }
  // The progress line counts what the rail shows.
  const counted = GUIDE_STEPS.filter((one) => !one.optional && states[one.key] !== 'n/a');
  const done = counted.filter((one) => states[one.key] === 'done').length;
  const next = counted.find((one) => states[one.key] !== 'done');
  const progress = `${done} of ${counted.length} required steps done.${next ? ` Next: ${next.title}.` : ' Every required step is done.'}`;
  await expect(rail).toContainText(progress);
  // Seal: its help carries the folder rule, and Take me there stays on the editor.
  const seal = teacher.getByTestId('guide-step-seal');
  await seal.locator('summary').click();
  await expect(seal).toContainText(SEAL_HELP_FOLDER);
  await expect(teacher.getByTestId('guide-step-go-seal')).toHaveAttribute('href', '#guide-refine');
  const preview = teacher.getByTestId('guide-step-preview');
  await preview.locator('summary').click();
  // Preview: the shipped help.
  for (const sentence of PREVIEW_STEP_HELP) await expect(preview).toContainText(sentence);
  await expect(teacher.getByTestId('guide-step-go-preview')).toHaveAttribute('href', '#guide-preview');
  await expect(teacher.getByTestId('guide-step-docs-preview')).toHaveAttribute('href', '/teacher/guide#preview-a-draft-as-a-learner');
  await rail.scrollIntoViewIfNeeded();
  await shot(teacher, 'g03-editor-rail');

  // axe on the editor's rail, every step opened.
  const violations = await runAxe(teacher, '[data-testid="guide-rail"]');
  record.axe['editor rail'] = { violations: violations.map(({ id, impact, count }) => ({ id, impact, count })) };
  expect(failing(violations), 'the editor rail is axe clean (serious and critical)').toEqual([]);
  // The same rail at 390, then back to 1280 for the rest of the walk.
  await atViewport(teacher, PHONE);
  try {
    await expect(rail).toBeVisible();
    const phone = await runAxe(teacher, '[data-testid="guide-rail"]');
    record.axe['editor rail @390'] = { violations: phone.map(({ id, impact, count }) => ({ id, impact, count })) };
    expect(failing(phone), 'the editor rail is axe clean at 390 (serious and critical)').toEqual([]);
  } finally {
    await atViewport(teacher, DESKTOP);
  }
});

test('5. a hidden test sealed under tests/<name>, shown as path, digest and size only', async () => {
  await openPhaseTab(teacher, 'implementation');
  await teacher.getByTestId('exec-edit-open').click();
  await expect(teacher.getByTestId('exec-editor')).toBeVisible({ timeout: UI_READY });
  const group = 'hidden-api';
  S.sealMarker = sealMarker();
  const name = `test_rc_guide_${RUN}.py`;
  const bytes = Buffer.from(`# ${S.sealMarker}\nimport unittest\n\n\nclass RcSealed(unittest.TestCase):\n    def test_sealed(self):\n        self.assertTrue(True)\n`);
  await teacher.getByTestId(`sealed-${group}-file`).setInputFiles({ name, mimeType: 'text/x-python', buffer: bytes });
  await teacher.getByTestId(`sealed-${group}-path`).fill(`tests/${name}`);
  await teacher.getByTestId(`sealed-${group}-upload`).click();
  await expect(teacher.getByTestId(`sealed-${group}-done`)).toBeVisible({ timeout: UI_READY });
  const row = teacher.getByTestId(`sealed-${group}`).locator('li', { hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(sha256Hex(bytes));
  await expect(row).toContainText(`${bytes.length} bytes`);
  const page = await teacher.content();
  expect(found(page, [S.sealMarker]), 'the sealed bytes are not on the page').toEqual([]);
  await negative('the sealed marker is on the page', () => expect(found(page, [S.sealMarker!])).toEqual([S.sealMarker]));
  // The draft view lists the file under tests/, by path.
  const draft = await (await call('GET', `/instructor/projects/${S.projectId}/versions/${S.versionId}`)).json();
  const hidden = JSON.stringify(draft.phases.find((one: any) => one.key === 'implementation'));
  expect(hidden).toContain(`tests/${name}`);
  expect(hidden).not.toContain(S.sealMarker);
  await shot(teacher, 'g04-sealed-under-tests');
  await teacher.getByTestId('exec-cancel').click();
});

test('6. fast validation runs and the report is drawn', async () => {
  await expect(teacher.getByTestId('project-editor')).toBeVisible({ timeout: NAVIGATION });
  const answered = teacher.waitForResponse((res) => /\/validate$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST');
  // The checks are under the editor's Validate tab.
  await teacher.getByTestId('project-section-validate').click();
  await teacher.getByTestId('project-validate').click();
  const res = await answered;
  expect(res.status(), 'fast validation answers').toBeLessThan(300);
  await expect(teacher.getByTestId('project-validation-tier')).toBeVisible({ timeout: NAVIGATION });
  // The rail is on the Overview; opening it also leaves the address without `?section=`, as test 7's Back expects.
  await teacher.getByTestId('project-section-overview').click();
  await showRailSteps(teacher);
  record.railStates.afterValidate = await railStates(teacher, 'guide-rail');
  expect(record.railStates.afterValidate.prepare).toBe('done');
  expect(record.railStates.afterValidate.publish).toBe('todo');
  expect(found(await teacher.content(), [S.sealMarker!]), 'the sealed bytes are not on the page after validation').toEqual([]);
  await shot(teacher, 'g05-fast-validation');
});

test('7. the Preview button opens the learner preview of this draft', async () => {
  const button = teacher.getByTestId('project-preview-open');
  await expect(button).toBeVisible();
  await expect(button).toHaveText(/Preview as a learner/);
  const editor = `/teacher/projects/${S.projectId}/versions/${S.versionId}`;
  await expect(button).toHaveAttribute('href', `${editor}/preview`);
  await negative('the Preview button is absent', () => expect(button).toHaveCount(0, { timeout: 1_500 }));
  const previewMark = () => teacher.evaluate((key) => window.localStorage.getItem(key), guideMarkKey('previewed', S.versionId!));
  expect(await previewMark(), 'no Preview mark before the preview').toBeNull();
  await button.click();
  await teacher.waitForURL((url) => url.pathname === `${editor}/preview`, { timeout: NAVIGATION });
  await expect(teacher.getByTestId('preview-banner')).toHaveText(PREVIEW_BANNER, { timeout: NAVIGATION });
  await expect(teacher.getByTestId('preview-stepper')).toBeVisible({ timeout: NAVIGATION });
  // The preview page wrote the mark once it had loaded.
  expect(await previewMark(), 'the loaded preview marked Preview').toBe('1');
  await expect(teacher.getByTestId('preview-interview-requirements')).toContainText(STARTER_PERSONA);
  await expect(teacher.getByTestId('preview-interview-requirements')).toContainText(STARTER_OPENING);
  expect(found(await teacher.content(), [S.sealMarker!]), 'the sealed bytes are not on the preview').toEqual([]);
  await shot(teacher, 'g06-preview-opened');
  await teacher.goBack();
  await teacher.waitForURL(editorPattern, { timeout: NAVIGATION });
  // Back on the editor in the same tab, the rail's Preview step reads Done (it read Not yet in test 4).
  await expect(teacher.getByTestId('guide-rail')).toBeVisible({ timeout: NAVIGATION });
  await showRailSteps(teacher);
  await expect(teacher.getByTestId('guide-step-preview')).toHaveAttribute('data-state', 'done', { timeout: UI_READY });
  await expect(teacher.getByTestId('guide-step-preview').locator('summary')).toContainText('Done');
  const states = await railStates(teacher, 'guide-rail');
  record.railStates.afterPreview = states;
  expect(states.preview).toBe('done');
  expect(states.export, 'nothing exported yet').toBe('todo');
  expect(await teacher.evaluate((key) => window.localStorage.getItem(key), guideMarkKey('previewed', S.versionId!))).toBe('1');
  await negative('the Preview step still reads Not yet after the preview', () => expect(states.preview).toBe('todo'));
});

test('7b. Export saves the archive and the rail reads Done in this tab; a fresh session reads Not yet', async () => {
  const editor = `/teacher/projects/${S.projectId}/versions/${S.versionId}`;
  await expect(teacher.getByTestId('project-editor')).toBeVisible({ timeout: NAVIGATION });
  expect(new URL(teacher.url()).pathname).toBe(editor);
  await showRailSteps(teacher);
  await expect(teacher.getByTestId('guide-step-export')).toHaveAttribute('data-state', 'todo');
  const answered = teacher.waitForResponse((res) => /\/export$/.test(new URL(res.url()).pathname) && res.request().method() === 'GET');
  const [download] = await Promise.all([teacher.waitForEvent('download'), teacher.getByTestId('project-export').click()]);
  const res = await answered;
  expect(res.status(), 'the export answers').toBe(200);
  expect(download.suggestedFilename()).toMatch(/-0\.1\.0\.zip$/);
  // The archive holds the sealed files: it is never read here, and it is dropped at once.
  await download.delete();
  await expect(teacher.getByTestId('project-export-done')).toContainText(`Saved ${download.suggestedFilename()}.`, { timeout: UI_READY });
  await expect(teacher.getByTestId('guide-step-export')).toHaveAttribute('data-state', 'done', { timeout: UI_READY });
  await expect(teacher.getByTestId('guide-step-export').locator('summary')).toContainText('Done');
  const states = await railStates(teacher, 'guide-rail');
  record.railStates.afterExport = states;
  expect(states.export).toBe('done');
  expect(states.preview, 'still done from test 7').toBe('done');
  await negative('the Export step still reads Not yet after the export', () => expect(states.export).toBe('todo'));
  // The same tab keeps both marks over a reload (localStorage).
  await teacher.reload();
  await expect(teacher.getByTestId('guide-rail')).toBeVisible({ timeout: NAVIGATION });
  await showRailSteps(teacher);
  await expect(teacher.getByTestId('guide-step-export')).toHaveAttribute('data-state', 'done', { timeout: NAVIGATION });
  record.railStates.afterReload = await railStates(teacher, 'guide-rail');
  expect(record.railStates.afterReload).toEqual(states);

  // A new tab of the same browser reads both marks too.
  const tab = await teacher.context().newPage();
  try {
    await tab.goto(editor);
    await expect(tab.getByTestId('guide-rail')).toBeVisible({ timeout: NAVIGATION });
    await showRailSteps(tab);
    await expect(tab.getByTestId('guide-step-export')).toHaveAttribute('data-state', 'done', { timeout: UI_READY });
    const tabStates = await railStates(tab, 'guide-rail');
    record.railStates.newTab = tabStates;
    expect(tabStates, 'a new tab of the same browser reads the same rail').toEqual(states);
    await negative('a new tab reads the Export step Not yet', () => expect(tabStates.export).toBe('todo'));
  } finally {
    await tab.close();
  }

  // Control: a fresh session (another browser context, no marker) reads Not yet for both steps on the same draft.
  const fresh = await teacher.context().browser()!.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const other = await fresh.newPage();
    other.on('response', (one) => {
      if (one.status() >= 500) fiveHundreds.push(`${one.status()} ${one.request().method()} ${new URL(one.url()).pathname.replace(IDS, ':id')}`);
    });
    await signInAs(other, INSTRUCTOR.email, INSTRUCTOR.password);
    await other.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: NAVIGATION });
    await other.goto(editor);
    await expect(other.getByTestId('guide-rail')).toBeVisible({ timeout: NAVIGATION });
    await showRailSteps(other);
    await expect(other.getByTestId('guide-step-export')).toHaveAttribute('data-state', 'todo', { timeout: UI_READY });
    const freshStates = await railStates(other, 'guide-rail');
    record.railStates.freshSession = freshStates;
    expect(freshStates.preview).toBe('todo');
    expect(freshStates.export).toBe('todo');
    await expect(other.getByTestId('guide-step-preview').locator('summary')).toContainText('Not yet');
    await expect(other.getByTestId('guide-step-export').locator('summary')).toContainText('Not yet');
    const marks = await other.evaluate(
      (keys) => keys.map((key) => window.localStorage.getItem(key)),
      [guideMarkKey('previewed', S.versionId!), guideMarkKey('exported', S.versionId!)],
    );
    expect(marks, 'a fresh browser context holds no marker').toEqual([null, null]);
    await negative('a fresh session reads the Export step done', () => expect(freshStates.export).toBe('done'));
    // The rest of the rail reads the draft, not the tab: it is the same in both sessions.
    const draftOnly = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([key]) => key !== 'preview' && key !== 'export'));
    expect(draftOnly(freshStates)).toEqual(draftOnly(states));
  } finally {
    await fresh.close();
  }
});

test('8. /teacher/guide renders the document, every step section and the refusal table, axe clean', async () => {
  await teacher.getByTestId('nav-guide').first().click();
  await teacher.waitForURL('**/teacher/guide', { timeout: NAVIGATION });
  const guide = teacher.getByTestId('teacher-guide');
  await expect(guide).toBeVisible({ timeout: NAVIGATION });
  await expect(teacher.getByRole('heading', { level: 1, name: 'Teacher guide' })).toBeVisible();
  const doc = teacher.getByTestId('teacher-guide-doc');
  await expect(doc.locator('section')).not.toHaveCount(0);
  // Every step's docs link lands on a section of this page.
  const anchors = [...new Set(GUIDE_STEPS.map((one) => one.docsAnchor))];
  const missing = await teacher.evaluate((ids) => ids.filter((id) => !document.getElementById(id)), anchors);
  expect(missing, 'every step has its section in the guide').toEqual([]);
  await negative('a section that does not exist is found', async () =>
    expect(await teacher.evaluate(() => Boolean(document.getElementById('no-such-section-rc')))).toBe(true),
  );
  // The refusal table: every wire code, and NOT_A_ZIP's row in the contract's words.
  await expect(teacher.locator('[data-testid^="refusal-row-"]')).toHaveCount(UPLOAD_REFUSAL_CODES.length);
  await expect(teacher.getByTestId('refusal-row-NOT_A_ZIP')).toContainText(NOT_A_ZIP_HELP.title);
  await expect(teacher.getByTestId('refusal-row-NOT_A_ZIP')).toContainText(NOT_A_ZIP_HELP.fix);
  expect(UPLOAD_REFUSAL_HELP.NOT_A_ZIP).toEqual(NOT_A_ZIP_HELP);
  // Section 7's own table is code and sentence only; the fix is shown once, on this page's refusal table.
  const section7 = teacher.locator('section[id="7-upload-refusals"]');
  const headers = (await section7.locator('table').first().locator('th').allInnerTexts()).map((one) => one.trim());
  expect(headers, "section 7's table has no fix column").toEqual(SECTION7_HEADERS);
  await expect(section7).toContainText(SECTION7_WHERE_FIX);
  await expect(section7).toContainText(SECTION7_RESERVED);
  await expect(teacher.getByTestId('teacher-guide-refusals')).toContainText('Every refusal, and how to fix it');
  await negative("section 7's table still has a fix column", () => expect(headers).toContain('How to fix'));
  // The guide's text names no TaskTrackr persona, and no course code: matched by its shape, never spelled here.
  const text = await guide.innerText();
  expect(found(text, ['TaskTrackr', 'Dana']), 'no reference-project word in the guide').toEqual([]);
  const codes = courseCodes(text);
  expect(codes.hits, 'no course code in the guide').toEqual([]);
  // Control: a synthetic code-shaped token drawn into the guide is caught; an HTTP status beside it is not.
  await teacher.evaluate((token) => {
    const injected = document.createElement('p');
    injected.setAttribute('data-e2e-course-armed', '');
    injected.textContent = `Taught as ${token}; a busy server answers HTTP 429.`;
    document.querySelector('[data-testid="teacher-guide-doc"]')!.appendChild(injected);
  }, SYNTHETIC_CODE);
  const armedCodes = courseCodes(await guide.innerText());
  await teacher.evaluate(() => document.querySelector('[data-e2e-course-armed]')?.remove());
  expect(armedCodes.hits, 'the guard catches a code-shaped token').toEqual([SYNTHETIC_CODE]);
  expect([...armedCodes.excluded].sort(), 'an HTTP status is not a course code').toEqual([...codes.excluded, 'HTTP 429'].sort());
  await negative('the guard misses a code-shaped token drawn into the guide', () => expect(armedCodes.hits).toEqual([]));
  expect(courseCodes(await guide.innerText()).hits, 'the injected token is gone').toEqual([]);
  record.courseGuard = {
    shape: COURSE_CODE_SHAPE.source,
    excludedRules: NOT_A_COURSE_CODE.map((rule) => rule.source),
    hits: codes.hits,
    excluded: codes.excluded,
    syntheticCaught: armedCodes.hits.includes(SYNTHETIC_CODE),
  };
  await shot(teacher, 'g07-teacher-guide');

  // axe: armed first (a nameless button is reported), then the rail, then the page.
  await teacher.evaluate(() => {
    const armed = document.createElement('button');
    armed.setAttribute('data-rc-axe-armed', '');
    document.querySelector('[data-testid="teacher-guide"]')!.appendChild(armed);
  });
  const armedRun = await runAxe(teacher, '[data-testid="teacher-guide"]');
  await teacher.evaluate(() => document.querySelector('[data-rc-axe-armed]')?.remove());
  await negative('axe misses a nameless button', () => expect(armedRun.map((v) => v.id)).not.toContain('button-name'));
  const railViolations = await runAxe(teacher, '[data-testid="guide-rail"]');
  record.axe['guide rail'] = { violations: railViolations.map(({ id, impact, count }) => ({ id, impact, count })) };
  expect(failing(railViolations), 'the guide rail is axe clean (serious and critical)').toEqual([]);
  const pageViolations = await runAxe(teacher, null);
  record.axe['guide page'] = { violations: pageViolations.map(({ id, impact, count }) => ({ id, impact, count })) };
  expect(failing(pageViolations), 'the guide page is axe clean (serious and critical)').toEqual([]);

  // The same rail and page at 390. A guide code block that scrolls sideways
  // at this width has to be in the tab order (components/Markdown.tsx `pre`,
  // lib/scroll-focus.ts). The guide holds no code example since the
  // Requirements phase stopped being authored from a stories file, so the
  // page check is that whatever block it holds takes a tab stop exactly while
  // it scrolls; the Markdown rule itself is proved on a block in
  // apps/web/test/markdown-pre-keyboard-focus.test.tsx.
  const codeBlocks = () =>
    teacher.evaluate(() =>
      [...document.querySelectorAll('[data-testid="teacher-guide-doc"] pre')].map((el) => ({
        scrolls: el.scrollWidth - el.clientWidth > 1,
        tabindex: el.getAttribute('tabindex'),
      })),
    );
  await atViewport(teacher, PHONE);
  try {
    await expect(guide).toBeVisible();
    const blocks = await codeBlocks();
    // Recorded, so a guide that gains or loses a code block shows here: its one block is the archive's folder tree under "The folders are the list" (section 1, the folder layout).
    expect(blocks.length, 'the code blocks the guide holds').toBe(1);
    expect(blocks.map((one) => one.tabindex), 'a code block takes a tab stop exactly while it scrolls').toEqual(blocks.map((one) => (one.scrolls ? '0' : null)));
    // Armed: a block in the guide's own prose that scrolls at this width with
    // no tab stop is reported (axe's own rule, at this width). It is drawn
    // here for the check and removed after it.
    const armedDrawn = await teacher.evaluate(() => {
      const prose = document.querySelector('[data-testid="teacher-guide-doc"] .prose-docs')!;
      const el = document.createElement('pre');
      el.setAttribute('data-rc-axe-armed-scroll', '');
      el.textContent = 'phases/01-requirements/phase.json '.repeat(12);
      prose.appendChild(el);
      return el.scrollWidth - el.clientWidth > 1;
    });
    let armedScroll: Awaited<ReturnType<typeof runAxe>>;
    try {
      expect(armedDrawn, 'the armed block scrolls sideways at 390').toBe(true);
      armedScroll = await runAxe(teacher, '[data-testid="teacher-guide-doc"]');
    } finally {
      await teacher.evaluate(() => document.querySelector('[data-rc-axe-armed-scroll]')?.remove());
    }
    await negative('axe misses a code block that scrolls with no tab stop', () =>
      expect(armedScroll.map((v) => v.id)).not.toContain('scrollable-region-focusable'),
    );
    const railPhone = await runAxe(teacher, '[data-testid="guide-rail"]');
    record.axe['guide rail @390'] = { violations: railPhone.map(({ id, impact, count }) => ({ id, impact, count })) };
    expect(failing(railPhone), 'the guide rail is axe clean at 390 (serious and critical)').toEqual([]);
    const pagePhone = await runAxe(teacher, null);
    record.axe['guide page @390'] = { violations: pagePhone.map(({ id, impact, count }) => ({ id, impact, count })) };
    expect(failing(pagePhone), 'the guide page is axe clean at 390 (serious and critical)').toEqual([]);
    await shot(teacher, 'g07b-teacher-guide-390');
  } finally {
    await atViewport(teacher, DESKTOP);
  }
  // Back at 1280 the block fits again, and no block keeps a tab stop it does not need.
  const wide = await codeBlocks();
  expect(wide.map((one) => one.tabindex), 'a code block takes a tab stop exactly while it scrolls, at 1280').toEqual(wide.map((one) => (one.scrolls ? '0' : null)));
});

test('9. a file that is not a zip is refused as NOT_A_ZIP, with its explainer under the sentence', async () => {
  await teacher.goto('/teacher/projects');
  await expect(teacher.getByTestId('projects-loading')).toHaveCount(0, { timeout: NAVIGATION });
  // Back on Projects after test 2's downloads, the
  // teacher's own starter and shelf downloads are read from the real audit
  // route and drawn under Start here.
  const history = teacher.getByTestId('guide-download-history');
  await expect(history).toBeVisible({ timeout: UI_READY });
  await expect(teacher.getByTestId('guide-download-history-starter')).toContainText('You downloaded the starter archive on');
  await expect(teacher.getByTestId('guide-download-history-shelf')).toContainText('You downloaded the shelf example on');
  await negative('the starter line names the shelf example', () =>
    expect(teacher.getByTestId('guide-download-history-starter')).toContainText('You downloaded the shelf example on', { timeout: 1_500 }),
  );
  record.download.history = await history.locator('li').allTextContents();
  const listBefore = await (await call('GET', '/instructor/projects')).json();
  const countBefore = (listBefore.mine ?? []).length;
  await teacher.getByTestId('projects-upload-open').click();
  await expect(teacher.getByTestId('projects-upload')).toBeVisible();
  await teacher.getByTestId('projects-upload-title').fill(`${TITLE} not a zip`);
  await teacher
    .getByTestId('projects-upload-file')
    .setInputFiles({ name: 'notes.zip', mimeType: 'application/zip', buffer: Buffer.from('These are plain notes, not an archive.\n') });
  await teacher.getByTestId('projects-upload-submit').click();
  await expect(teacher.getByTestId('projects-upload-refusal-sentence')).toHaveText(NOT_A_ZIP_SENTENCE, { timeout: NAVIGATION });
  const help = teacher.getByTestId('upload-refusal-help');
  await expect(teacher.getByTestId('upload-refusal-help-title')).toHaveText(NOT_A_ZIP_HELP.title);
  await expect(teacher.getByTestId('upload-refusal-help-fix')).toHaveText(NOT_A_ZIP_HELP.fix);
  await expect(teacher.getByTestId('upload-refusal-help-link')).toHaveAttribute('href', `/teacher/guide#${NOT_A_ZIP_HELP.guideAnchor}`);
  await negative("the explainer says another code's title", () =>
    expect(teacher.getByTestId('upload-refusal-help-title')).toHaveText(UPLOAD_REFUSAL_HELP.NOT_A_PACK.title, { timeout: 1_500 }),
  );
  // The explainer sits under the fixed sentence, never inside it.
  await expect(teacher.getByTestId('projects-upload-refusal').getByTestId('upload-refusal-help')).toHaveCount(0);
  await expect(help).toBeVisible();
  await shot(teacher, 'g08-not-a-zip-explained');
  const listAfter = await (await call('GET', '/instructor/projects')).json();
  expect((listAfter.mine ?? []).length, 'no draft was made').toBe(countBefore);
  // The link lands on the guide's section.
  await teacher.getByTestId('upload-refusal-help-link').click();
  await teacher.waitForURL((url) => url.pathname === '/teacher/guide' && url.hash === `#${NOT_A_ZIP_HELP.guideAnchor}`, { timeout: NAVIGATION });
  await expect(teacher.locator(`[id="${NOT_A_ZIP_HELP.guideAnchor}"]`)).toBeVisible({ timeout: UI_READY });
});

test('no response anywhere in the walk had a status of 500 or more, and no model was asked', async () => {
  expect(fiveHundreds).toEqual([]);
  const after = await stubCounts();
  expect(JSON.stringify(after), 'the AI stub was asked nothing').toBe(record.aiStub.before);
});
