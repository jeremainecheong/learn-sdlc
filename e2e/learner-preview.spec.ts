import { expect, request as pwRequest, test, type APIRequestContext, type BrowserContext, type Page, type Request } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { LEARNER_PREVIEW_FORBIDDEN_KEYS } from '@learnsdlc/shared';
import { INSTRUCTOR } from './passing-work';
import { createClassFromTeacherHome, dismissPhaseTutorial, openRequirements, registerIntoClass, signInAs, teacherHome } from './pw-fixtures';
import { captureMasked, deepReceiptRefusal, found, sha256Hex, writeDeepReceiptSeam } from './upload-helpers';
import { AI_STUB_URL, API, API_ORIGIN, assertLoopbackApi, RUN } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The learner preview of a draft, then the same
 * draft published, assigned and opened by a learner, on the local stack (the
 * config's webServer: the loopback AI stub, the built API on a fresh sqlite
 * file, the built web).
 *
 *  1. the seeded instructor signs in; the starter is fetched from the staff
 *     route (its recorded bytes) and uploaded as a draft; a quiz is added
 *     beside Design's task, its explanations carrying a marker;
 *  2. the preview page: the banner, the six phases in order with their gate
 *     sentences, the files read-only, the quiz without its key, the interview
 *     card with the persona and the opening only, and nothing sealed;
 *  2b. the preview page axe clean (WCAG 2.0/2.1 A and AA, serious and
 *     critical) at 1280 and at 390;
 *  3. no Run, Check, Submit, Ask or mentor control, by role and by test id;
 *  4. the page's network: beyond the shell's own reads (the same as on a
 *     page with no data of its own, /teacher/guide), exactly one preview GET;
 *  5. publish (refused without a deep receipt, then published behind the
 *     test-only deep-receipt seam, writeDeepReceiptSeam) and assign to a new
 *     class;
 *  6. a learner joins with the code (never printed, masked in every frame),
 *     opens Requirements and sees the interview persona's opening. No question
 *     is asked.
 *
 * Every key assertion carries a negative control in the same test (the
 * opposite expectation, which must fail): `negative()`. No real AI; no status
 * of 500 or more anywhere (asserted last).
 */

test.describe.configure({ mode: 'serial' });


assertLoopbackApi(__filename);

/** Per worker: a retry of this serial file (a fixed E2E_RUN_ID) uploads, publishes and registers under new names. */
const NONCE = crypto.randomBytes(2).toString('hex');
const TITLE = `Starter preview ${RUN}${NONCE}`;
const CLASS_NAME = `Preview class ${RUN}${NONCE}`;
const QUIZ_KEY = 'contract-check';
const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/* ------------------------------- pinned words ------------------------------- */

/** The SHA-256 of the starter archive the staff route serves (its own slug, 'starter'). */
/* Generated content, not an AI-request golden: this pin follows the digest
   apps/api/src/authoring/starter-archive.generated.ts serves, re-pinned by hand when the starter is regenerated. */
const STARTER_SHA256 = 'af815a97dfe7bfe4e652d1a83b90853e60bbd58dcf7a69beaf9974c267e500f9';
/** apps/web/components/staff/preview/copy.ts PREVIEW_BANNER. */
const PREVIEW_BANNER = 'Preview: nothing here is saved, graded or seen by learners';
/** apps/api/src/authoring/learner-preview.ts FIRST_PHASE_GATE and previewGateSentence. */
const FIRST_GATE = 'Learners open this first.';
const gate = (previous: string, optional: boolean) =>
  `Learners open this after every ${optional ? 'required ' : ''}task in ${previous} has passed and, where a task needs it, has been signed off.`;
/** The starter's six phases, in order (apps/api/test/fixtures/upload-packs/starter/phases/0N-x/phase.json). */
const PHASES: [string, string][] = [
  ['requirements', 'Requirements'],
  ['design', 'Design'],
  ['implementation', 'Implementation'],
  ['testing', 'Testing'],
  ['deployment', 'Deployment'],
  ['maintenance', 'Maintenance'],
];
/** TaskTrackr's persona and opening words, which the starter's room must never show (content/tasktrackr interview.json). */
const TASKTRACKR_INTERVIEW_WORDS = ['Dana Osei', 'ten minutes', 'TaskTrackr'];

const STARTER_DIR = path.resolve(__dirname, '../apps/api/test/fixtures/upload-packs/starter');
/**
 * The starter's hand-written interview (sealed: a learner reads only the
 * persona and the opening). The product reads the same file, so the persona
 * and the opening below are the words the card and the room must show. Its
 * fact answers are the needles: none may reach the preview, the page or the
 * learner's room before a question.
 */
const INTERVIEW = JSON.parse(fs.readFileSync(path.join(STARTER_DIR, 'phases/01-requirements/interview.json'), 'utf8')) as {
  persona: { name: string; role: string };
  opening: string;
  facts: { id: string; answer: string }[];
};
/** The starter's persona and opening, as its interview.json writes them. */
const PERSONA = INTERVIEW.persona.name;
const PERSONA_ROLE = INTERVIEW.persona.role;
const OPENING = INTERVIEW.opening;
const FACT_ANSWERS: string[] = INTERVIEW.facts.map((one) => one.answer);
const FACT_NEEDLES = [...new Set(FACT_ANSWERS)];
/** One fact answer, drawn on purpose by the negative controls to prove the detector sees it. */
const LEAKED_ANSWER = FACT_ANSWERS[FACT_ANSWERS.length - 1] ?? '';
/** Every folder of the starter a learner never opens as it is (sealed, or held back for grading). */
const SEALED_DIRS = [
  'phases/03-implementation/hidden_tests',
  'phases/03-implementation/solution',
  'phases/04-testing/impl',
  'phases/04-testing/mutants',
  'phases/04-testing/reference',
  'phases/05-deployment/drill',
  'phases/06-maintenance/hidden_tests',
  'phases/06-maintenance/solution',
];
function filesUnder(rel: string): string[] {
  const files: string[] = [];
  const walk = (at: string) => {
    for (const one of fs.readdirSync(at, { withFileTypes: true })) {
      if (one.isDirectory()) walk(path.join(at, one.name));
      else files.push(path.join(at, one.name));
    }
  };
  // A phase need not mount a files/ folder: Requirements is a story phase whose record the room writes.
  if (fs.existsSync(path.join(STARTER_DIR, rel))) walk(path.join(STARTER_DIR, rel));
  return files;
}
const linesOf = (files: string[]) => files.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').map((one) => one.trim()));
/**
 * Lines that exist ONLY in the starter's sealed files of `rel` (a hidden suite, a
 * solution, the mutants): never in a phase's mounted `files/` nor its
 * `readonly/`, because a reference solution may also be a locked file a later
 * phase mounts (SOLUTION_MOUNT_SENTENCE). The three longest such lines.
 */
function sealedOnlyLines(rel: string): string[] {
  const mounted = new Set(
    // every mount: a phase folder's files/ (editable) and readonly/ (locked), spec 7.1
    linesOf(fs.readdirSync(path.join(STARTER_DIR, 'phases')).flatMap((phase) => [...filesUnder(`phases/${phase}/files`), ...filesUnder(`phases/${phase}/readonly`)])),
  );
  return [...new Set(linesOf(filesUnder(rel)))]
    .filter((one) => one.length >= 24 && !mounted.has(one))
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
}

/** The learner-facing control test ids of the rooms (apps/web/components/workspace/**): none may be on the preview. */
const LEARNER_CONTROL_TEST_IDS = [
  'run-button',
  'run-panel',
  'preview-run',
  'interview-send',
  'interview-input',
  'agentic-send',
  'stuck-send',
  'reflection-submit',
  'task-reset-open',
];

/* ------------------------------- run record ------------------------------- */

const SHOTS_ROOT = (() => {
  const fromEnv = process.env.E2E_JOURNEY_SHOTS;
  if (fromEnv) return path.resolve(fromEnv);
  // Default: Playwright's own output folder (cleared each run). Any other folder is chosen only by E2E_JOURNEY_SHOTS.
  return path.resolve(__dirname, '../test-results/journey-shots');
})();
const EPOCH = `preview-${RUN}-${Date.now()}`;
const record: {
  spec: string;
  epoch: string;
  negatives: { label: string; failedAsItShould: boolean; assertion: string }[];
  shots: { file: string; sha256: string; bytes: number }[];
  network: { shell: string[]; preview: string[]; beyondShell: string[]; previewGets: number; injected?: string[] };
  sealedSweep: Record<string, number>;
  axe: Record<string, { violations: { id: string; impact: string | null; count: number }[] }>;
  aiStub: { before: string; after: string };
  outcomes: { title: string; status: string }[];
} = {
  spec: 'e2e/learner-preview.spec.ts',
  epoch: EPOCH,
  negatives: [],
  shots: [],
  network: { shell: [], preview: [], beyondShell: [], previewGets: 0 },
  sealedSweep: {},
  axe: {},
  aiStub: { before: '', after: '' },
  outcomes: [],
};

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
    assertion = failingLine(err, S.joinCode ? [S.joinCode] : []);
  }
  record.negatives.push({ label, failedAsItShould: failed, assertion });
  expect(failed, `negative control "${label}" fails as it should`).toBe(true);
}

/** A masked screenshot: every join-code holder masked, and no frame written that would show the run's code. */
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_ROOT) return;
  const dir = path.join(SHOTS_ROOT, EPOCH);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `${name}.png`);
  await captureMasked(page, file, S.joinCode ? [S.joinCode] : []);
  const bytes = fs.readFileSync(file);
  record.shots.push({ file: path.relative(SHOTS_ROOT, file), sha256: sha256Hex(bytes), bytes: bytes.length });
}

/* ----------------------------------- axe ----------------------------------- */

/** WCAG 2.0/2.1 A and AA, serious and critical: e2e/a11y-axe.spec.ts's own scope (as e2e/teacher-guide.spec.ts). */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const AXE_FAILING = new Set(['serious', 'critical']);
const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
/** The two widths of the axe check: the walk's own 1280, and e2e/a11y-axe.spec.ts's phone-390. */
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** axe-core, injected, over the whole document, every <details> opened first (a closed one hides its content from axe). */
async function runAxe(page: Page): Promise<{ id: string; impact: string | null; count: number; targets: string[] }[]> {
  await page.evaluate(() => document.querySelectorAll('details').forEach((one) => ((one as HTMLDetailsElement).open = true)));
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async (tags) => {
    const axe = (window as unknown as { axe: any }).axe;
    const r = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return r.violations.map((v: any) => ({
      id: v.id,
      impact: v.impact ?? null,
      count: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n: any) => [].concat(n.target).join(' ')),
    }));
  }, AXE_TAGS);
}

const failing = (violations: { id: string; impact: string | null; count: number; targets: string[] }[]) =>
  violations.filter((v) => AXE_FAILING.has(v.impact ?? '')).map((v) => `${v.id} (${v.impact}, ${v.count}): ${v.targets.join(' | ')}`);

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

let teacherCtx: BrowserContext;
let learnerCtx: BrowserContext;
let teacher: Page;
let learner: Page;
let api: APIRequestContext;
let staffHeaders: { authorization: string };
const fiveHundreds: string[] = [];
const S: {
  projectId?: string;
  versionId?: string;
  slug?: string;
  quizMarker?: string;
  previewBody?: string;
  joinCode?: string;
  stubBefore?: Record<string, number>;
} = {};

async function stubCounts(): Promise<Record<string, number>> {
  const res = await fetch(`${AI_STUB_URL}/__stub/counts`);
  if (!res.ok) throw new Error(`the AI stub did not answer its counts (${res.status})`);
  return ((await res.json()).counts ?? {}) as Record<string, number>;
}

async function call(method: string, route: string, data?: unknown, headers: Record<string, string> = staffHeaders) {
  let res;
  try {
    res = await api.fetch(`${API}${route}`, { method, headers, data });
  } catch (err) {
    // A kept-alive socket the API closed while the walk was in the browser: a read is sent once more, a write never.
    if (method !== 'GET' || !/ECONNRESET|socket hang up/.test(String(err))) throw err;
    res = await api.fetch(`${API}${route}`, { method, headers, data });
  }
  if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${method} ${route.replace(IDS, ':id')}`);
  return res;
}

/** Every API request a page sends while `during` runs, as "METHOD /path" with ids as :id (OPTIONS left out). */
async function apiCallsDuring(page: Page, during: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const onRequest = (req: Request) => {
    const url = new URL(req.url());
    if (url.origin !== new URL(API_ORIGIN).origin || req.method() === 'OPTIONS') return;
    seen.push(`${req.method()} ${url.pathname.replace(IDS, ':id')}`);
  };
  page.on('request', onRequest);
  try {
    await during();
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
  } finally {
    page.off('request', onRequest);
  }
  return seen;
}

/** `preview` less `shell`, counted: a call the shell makes once and the page makes twice is beyond the shell once. */
function beyondShell(shell: string[], preview: string[]): string[] {
  const left = new Map<string, number>();
  for (const one of shell) left.set(one, (left.get(one) ?? 0) + 1);
  const beyond: string[] = [];
  for (const one of preview) {
    const n = left.get(one) ?? 0;
    if (n > 0) left.set(one, n - 1);
    else beyond.push(one);
  }
  return beyond;
}

const editorHref = () => `/teacher/projects/${S.projectId}/versions/${S.versionId}`;

test.beforeAll(async ({ browser }) => {
  S.stubBefore = await stubCounts();
  record.aiStub.before = JSON.stringify(S.stubBefore);
  api = await pwRequest.newContext();
  const login = await api.post(`${API}/auth/login`, { data: { email: INSTRUCTOR.email, password: INSTRUCTOR.password } });
  expect(login.ok(), 'the seeded instructor signs in through the API').toBeTruthy();
  staffHeaders = { authorization: `Bearer ${(await login.json()).token}` };
  teacherCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  learnerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  for (const ctx of [teacherCtx, learnerCtx]) {
    ctx.on('response', (res) => {
      if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname.replace(IDS, ':id')}`);
    });
  }
  teacher = await teacherCtx.newPage();
  learner = await learnerCtx.newPage();
  await dismissPhaseTutorial(learner);
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
  await teacherCtx?.close();
  await learnerCtx?.close();
  await api?.dispose();
});

test('1. the starter, from the staff route, uploaded as a draft with a quiz beside Design', async () => {
  await signInAs(teacher, INSTRUCTOR.email, INSTRUCTOR.password);
  await teacherHome(teacher);
  const starter = await call('GET', '/instructor/starter/starter');
  expect(starter.status()).toBe(200);
  const archive = await starter.body();
  expect(sha256Hex(archive), 'the recorded starter bytes').toBe(STARTER_SHA256);
  const uploaded = await call('POST', '/instructor/projects/upload', { title: TITLE, archiveBase64: archive.toString('base64') });
  expect(uploaded.status(), 'the starter is accepted').toBe(201);
  const made = await uploaded.json();
  // The starter is already in the story kind, so the upload converts nothing and says nothing.
  expect(made.warnings, 'the upload changed nothing on the way in').toBeUndefined();
  expect(LEAKED_ANSWER, 'the starter has a fact answer to look for').not.toBe('');
  S.projectId = made.projectId;
  S.versionId = made.versionId;
  // A quiz beside Design's task (optional), its explanations carrying a marker no learner page may show.
  S.quizMarker = `PREVIEW-QUIZ-KEY-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const questions = Array.from({ length: 5 }, (_, at) => ({
    id: `q${at + 1}`,
    stem: `Which status does the shelf contract give a book that is lent out? (question ${at + 1})`,
    options: [
      { id: 'a', text: `On loan (${at + 1})` },
      { id: 'b', text: `On the shelf (${at + 1})` },
    ],
    correct: ['a'],
    explanation: `${S.quizMarker} explanation ${at + 1}: the contract names a lent book "on loan".`,
    concept: `preview-contract-${at + 1}`,
  }));
  const quiz = await call('POST', `/instructor/projects/${S.projectId}/versions/${S.versionId}/phases/design/tasks`, {
    taskKey: QUIZ_KEY,
    title: 'Check the shelf contract',
    brief: 'Three questions about the shelf contract.',
    artefactType: 'quiz',
    required: false,
    quiz: { questions, drawn: 3, shuffleOptions: true, passMark: 80, attempts: { max: 3, cooldownSeconds: null }, criterion: 'concepts' },
  });
  expect(quiz.status(), 'the quiz is added to the draft').toBe(201);
  const draft = await (await call('GET', `/instructor/projects/${S.projectId}/versions/${S.versionId}`)).json();
  S.slug = draft.slug;
});

test('2. the preview page: banner, six phases in order with gates, read-only files, quiz without key, interview persona + opening only', async () => {
  // The guide rail's Preview mark is written by the preview page once it loads, in localStorage.
  const previewedMark = () => teacher.evaluate((key) => window.localStorage.getItem(key), `lsdlc_guide_previewed:${S.versionId}`);
  expect(await previewedMark(), 'no Preview mark before the preview is opened').toBeNull();
  const answered = teacher.waitForResponse((res) => /\/learner-preview$/.test(new URL(res.url()).pathname) && res.request().method() === 'GET');
  await teacher.goto(`${editorHref()}/preview`);
  const res = await answered;
  expect(res.status()).toBe(200);
  S.previewBody = await res.text();
  const view = JSON.parse(S.previewBody);
  const main = teacher.getByTestId('learner-preview');
  await expect(main).toBeVisible({ timeout: NAVIGATION });
  await expect(teacher.getByTestId('preview-banner')).toHaveText(PREVIEW_BANNER);
  await expect(teacher.getByTestId('preview-stepper')).toBeVisible({ timeout: NAVIGATION });
  await expect.poll(previewedMark, { timeout: UI_READY, message: 'the loaded preview marks Preview done for this version' }).toBe('1');

  // The six phases, in order, on the stepper and as sections.
  await expect(teacher.getByTestId('preview-stepper').locator('li')).toHaveText(PHASES.map(([, title], at) => `${at + 1}. ${title}`));
  const sections = await main.locator('[data-testid^="preview-phase-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(sections).toEqual(PHASES.map(([key]) => `preview-phase-${key}`));
  await negative('the phases are in another order', () => expect(sections).toEqual(PHASES.map(([key]) => `preview-phase-${key}`).reverse()));

  // The gate sentences: first, then each after the phase before; Design holds an optional quiz, so Implementation says "required".
  for (const [at, [key]] of PHASES.entries()) {
    const previous = view.phases[at - 1];
    const expected = at === 0 ? FIRST_GATE : gate(previous.title, previous.tasks.some((task: any) => !task.required));
    await expect(teacher.getByTestId(`preview-gate-${key}`)).toHaveText(expected);
  }
  await expect(teacher.getByTestId('preview-gate-implementation')).toHaveText(gate('Design', true));
  await expect(teacher.getByTestId('preview-gate-design')).toHaveText(gate('Requirements', false));
  await negative('a bare "passes" gate (no sign-off clause)', () =>
    expect(teacher.getByTestId('preview-gate-design')).toHaveText('Learners open this after Requirements passes.', { timeout: 1_500 }),
  );

  // Files: shown read-only (a chip says which a learner edits), no editor of any kind on the page.
  // Design is drawn in words (its stories and its floor), never as a file list.
  await expect(teacher.getByTestId('preview-design')).toBeVisible();
  await expect(teacher.getByTestId('preview-files-design')).toHaveCount(0);
  for (const [key] of PHASES.filter(([one]) => one !== 'design')) {
    const files = teacher.getByTestId(`preview-files-${key}`).locator('li');
    expect(await files.count(), `${key} shows the files a learner opens`).toBeGreaterThan(0);
    for (const chip of await files.locator('summary').allInnerTexts()) expect(chip).toMatch(/Learners edit this|Read only/);
  }
  // The runbook and the change request are drawn as the rooms' own forms, read-only: they are there (the
  // negative control), and none of their fields takes typing.
  expect(await teacher.getByTestId('preview-runbook').locator('textarea, select').count(), 'the runbook is drawn as its forms').toBeGreaterThan(0);
  expect(await teacher.getByTestId('preview-change').locator('input, textarea, select').count(), 'the change request is drawn as its forms').toBeGreaterThan(0);
  const writable = 'input:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), select:not([disabled])';
  expect(await main.locator(`${writable}, [contenteditable=""], [contenteditable="true"], .monaco-editor, .cm-editor`).count(), 'nothing on the preview can be typed into').toBe(0);
  await negative('an editor is on the preview', async () => expect(await main.locator(`${writable}, .monaco-editor, .cm-editor`).count()).toBeGreaterThan(0));
  const paths: string[] = view.phases.flatMap((phase: any) => phase.files.map((file: any) => file.path));
  const sealedPath = /hidden_tests|(^|\/)solution\/|(^|\/)mutants\/|(^|\/)reference\/|(^|\/)drill\/|interview\.json|NOTES\.md|START-HERE/;
  expect(paths.filter((one) => sealedPath.test(one)), 'no sealed or unmounted file is listed').toEqual([]);
  // The starter's own content, as an upload carries it. The two rooms that draw
  // the page lock the sample books its preview reads, and Design is written in the room's forms, never in a page.
  const SAMPLE_BOOKS = fs.readFileSync(path.join(STARTER_DIR, 'phases/03-implementation/readonly/preview/sample-data.json'), 'utf8');
  for (const key of ['implementation', 'maintenance']) {
    const room = view.phases.find((phase: any) => phase.key === key);
    expect(room.files.filter((file: any) => file.path === 'preview/sample-data.json'), `${key} locks the sample books`).toEqual([
      { path: 'preview/sample-data.json', content: SAMPLE_BOOKS, editable: false, language: 'json' },
    ]);
  }
  expect(JSON.parse(SAMPLE_BOOKS)['/api/books'], 'four sample books').toHaveLength(4);
  const designRoom = view.phases.find((phase: any) => phase.key === 'design');
  expect(designRoom.intro, "the Design intro names the room's forms").toContain("Design room's forms");
  // The starter's Design ships no starting documents and no markdown page: the record and the API contract are the forms.
  expect(fs.existsSync(path.join(STARTER_DIR, 'phases/02-design/files')), 'the starter ships no Design files').toBe(false);
  expect(designRoom.files.filter((file: any) => /\.md$/.test(file.path)), 'no markdown page in Design').toEqual([]);
  await expect(teacher.getByTestId('preview-files-implementation')).toContainText('preview/sample-data.json');

  // The quiz: its questions and options, never its key.
  const quiz = teacher.getByTestId(`preview-quiz-${QUIZ_KEY}`);
  await expect(quiz).toBeVisible();
  await expect(quiz).toContainText('A paper draws 3 of these 5 questions. The pass mark is 80%.');
  await expect(quiz).toContainText('Which status does the shelf contract give a book that is lent out? (question 1)');
  await expect(quiz).toContainText('On loan (1)');
  const quizView = view.phases.find((phase: any) => phase.key === 'design').quizzes[0];
  expect(Object.keys(quizView.questions[0]).sort()).toEqual(['id', 'multiple', 'options', 'stem']);
  expect(found(S.previewBody!, [S.quizMarker!]), 'no explanation in the preview answer').toEqual([]);
  expect(found(await teacher.content(), [S.quizMarker!]), 'no explanation on the page').toEqual([]);
  expect(S.previewBody).not.toMatch(/"correct"\s*:/);
  await negative('the quiz key is in the preview answer', () => expect(S.previewBody).toMatch(/"correct"\s*:/));

  // The interview card: the persona and the opening, and nothing else.
  const card = teacher.getByTestId('preview-interview-requirements');
  await expect(card.locator('h3')).toHaveText(`Stakeholder: ${PERSONA}`);
  await expect(card.locator('p')).toHaveText(PERSONA_ROLE);
  await expect(card.locator('blockquote')).toHaveText(OPENING);
  expect(OPENING, 'the opening the starter writes names its persona').toContain(PERSONA);
  expect((await card.innerText()).split('\n').map((one) => one.trim()).filter(Boolean)).toEqual([`Stakeholder: ${PERSONA}`, PERSONA_ROLE, OPENING]);
  const interview = view.phases.find((phase: any) => phase.key === 'requirements').interview;
  expect(Object.keys(interview).sort(), 'the interview is persona and opening only').toEqual(['opening', 'persona']);
  await expect(main.locator('[data-testid^="preview-interview-"]'), 'one interview card, in Requirements').toHaveCount(1);
  await negative("the card shows TaskTrackr's persona", () => expect(card).toContainText('Dana Osei', { timeout: 1_500 }));

  // Nothing sealed: no fact answer, no hidden test, solution or mutant line, no forbidden key.
  // Every sealed or unmounted folder of the starter; a reference solution a later phase mounts as a locked file drops out (sealedOnlyLines).
  const sealedOnly: Record<string, string[]> = {};
  for (const rel of SEALED_DIRS) sealedOnly[rel] = sealedOnlyLines(rel);
  for (const rel of ['phases/03-implementation/hidden_tests', 'phases/06-maintenance/solution', 'phases/04-testing/mutants']) {
    expect(sealedOnly[rel].length, `the starter has ${rel} lines no mounted file holds`).toBeGreaterThan(0);
  }
  record.sealedSweep = Object.fromEntries(Object.entries(sealedOnly).map(([rel, lines]) => [rel, lines.length]));
  record.sealedSweep['fact needles (interview.json answers)'] = FACT_NEEDLES.length;
  const sealedLines = [...FACT_NEEDLES, ...Object.values(sealedOnly).flat()];
  expect(FACT_ANSWERS.length).toBeGreaterThan(3);
  expect(found(S.previewBody!, sealedLines), 'no sealed line in the preview answer').toEqual([]);
  const text = await main.innerText();
  expect(found(text, sealedLines), 'no sealed line on the page').toEqual([]);
  expect(found(text, TASKTRACKR_INTERVIEW_WORDS), 'no TaskTrackr word on the page').toEqual([]);
  const keys = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) (keys.add(k), walk(v));
  };
  // `runbook.drill` is the one allowed key that shares a forbidden name: the boolean "this phase drills",
  // never the sealed drill. The walk exempts it at that place only, as learner-preview.spec.ts does.
  expect(view.phases.filter((phase: any) => phase.runbook).length, 'the preview carries a runbook').toBeGreaterThan(0);
  walk(view.phases.map((phase: any) => {
    if (!phase.runbook) return phase;
    expect(typeof phase.runbook.drill, `${phase.key}'s runbook.drill is a boolean`).toBe('boolean');
    const { drill: _drill, ...runbook } = phase.runbook;
    return { ...phase, runbook };
  }));
  walk({ ...view, phases: [] });
  expect(LEARNER_PREVIEW_FORBIDDEN_KEYS.filter((one) => keys.has(one)), 'no forbidden key anywhere in the answer').toEqual([]);
  // The detector sees a fact answer, both in an answer body and drawn on the page.
  await negative('a fact answer in the preview answer goes unseen', () =>
    expect(found(JSON.stringify({ ...view, leaked: LEAKED_ANSWER }), sealedLines)).toEqual([]),
  );
  await main.evaluate((el, leak) => {
    const p = document.createElement('p');
    p.setAttribute('data-e2e-negative', '');
    p.textContent = leak;
    el.appendChild(p);
  }, LEAKED_ANSWER);
  try {
    const leakedText = await main.innerText();
    await negative('a fact answer drawn on the page goes unseen', () => expect(found(leakedText, sealedLines)).toEqual([]));
  } finally {
    await teacher.evaluate(() => document.querySelector('[data-e2e-negative]')?.remove());
  }
  expect(found(await main.innerText(), sealedLines)).toEqual([]);
  await shot(teacher, 'p01-preview-top');
  // The banner stays in view with the page scrolled to its last phase (the first phase's gate is out of view).
  const banner = teacher.getByTestId('preview-banner');
  await teacher.getByTestId('preview-phase-maintenance').scrollIntoViewIfNeeded();
  await expect(teacher.getByTestId('preview-gate-requirements'), 'the page has scrolled past the first phase').not.toBeInViewport();
  await expect(banner).toBeInViewport();
  await shot(teacher, 'p02-preview-last-phase-banner-sticky');
  // The control: the banner's frame made static (not sticky) scrolls away, and the same assertion catches it.
  const frame = teacher.getByTestId('preview-banner-frame');
  await expect(frame).toHaveCSS('position', 'sticky');
  await frame.evaluate((el) => el.style.setProperty('position', 'static', 'important'));
  try {
    await negative('a banner that is not sticky stays in view', () => expect(banner).toBeInViewport({ timeout: 1_500 }));
  } finally {
    await frame.evaluate((el) => el.style.removeProperty('position'));
  }
  await expect(banner).toBeInViewport();
  await quiz.scrollIntoViewIfNeeded();
  await shot(teacher, 'p03-preview-quiz-without-key');
});

test('2b. the preview page is axe clean at 1280 and at 390 (serious and critical)', async () => {
  const main = teacher.getByTestId('learner-preview');
  await expect(main).toBeVisible({ timeout: NAVIGATION });
  // Armed first: a nameless button drawn into the preview is reported.
  await main.evaluate((el) => {
    const armed = document.createElement('button');
    armed.setAttribute('data-e2e-axe-armed', '');
    el.appendChild(armed);
  });
  let armedRun: Awaited<ReturnType<typeof runAxe>>;
  try {
    armedRun = await runAxe(teacher);
  } finally {
    await teacher.evaluate(() => document.querySelector('[data-e2e-axe-armed]')?.remove());
  }
  await negative('axe misses a nameless button', () => expect(armedRun.map((v) => v.id)).not.toContain('button-name'));
  try {
    for (const [label, size] of [['preview page', DESKTOP], ['preview page @390', PHONE]] as const) {
      await atViewport(teacher, size);
      await expect(main).toBeVisible();
      const violations = await runAxe(teacher);
      record.axe[label] = { violations: violations.map(({ id, impact, count }) => ({ id, impact, count })) };
      expect(failing(violations), `the ${label} is axe clean (serious and critical)`).toEqual([]);
    }
    await shot(teacher, 'p04-preview-390');
  } finally {
    await atViewport(teacher, DESKTOP);
  }
});

test('3. no Run, Check, Submit, Ask or mentor control on the preview, by role and by test id', async () => {
  const main = teacher.getByTestId('learner-preview');
  const controlName = /^(run|check|submit|ask|send|hand in|start)\b|mentor/i;
  const buttons = await teacher.getByRole('button').allInnerTexts();
  expect(buttons.filter((one) => controlName.test(one.trim())), 'no learner control by its button name, anywhere on the page').toEqual([]);
  // The records' read-only fields are textboxes on the preview (the runbook's incident and Notes fields among
  // them), and none is named like a learner control.
  expect(await main.getByRole('textbox').count(), 'the records draw read-only fields').toBeGreaterThan(0);
  for (const role of ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio'] as const) {
    expect(await main.getByRole(role, { name: controlName }).count(), `no ${role} named Run/Check/Submit/Ask/mentor in the preview`).toBe(0);
  }
  for (const id of LEARNER_CONTROL_TEST_IDS) await expect(teacher.getByTestId(id), `no ${id}`).toHaveCount(0);
  expect(await teacher.locator('[data-testid$="-submit"], [data-testid^="mentor-"], [data-testid*="-run-"], [data-testid$="-run"]').count(), 'no submit, run or mentor test id').toBe(0);
  expect(await main.locator('a[href^="/workspace/"]').count(), 'no link into a learner room').toBe(0);
  // The control a learner's room has, put on this page, is found by the same checks.
  await teacher.evaluate(() => {
    const run = document.createElement('button');
    run.textContent = 'Run tests';
    run.setAttribute('data-testid', 'run-button');
    run.setAttribute('data-e2e-negative', '');
    document.querySelector('[data-testid="learner-preview"]')!.appendChild(run);
  });
  await negative('a Run control is absent by role', async () => expect(await main.getByRole('button', { name: controlName }).count()).toBe(0));
  await negative('a Run control is absent by test id', () => expect(teacher.getByTestId('run-button')).toHaveCount(0, { timeout: 1_500 }));
  await teacher.evaluate(() => document.querySelector('[data-e2e-negative]')?.remove());
  await expect(teacher.getByTestId('run-button')).toHaveCount(0);
});

test('4. the page asks the API for the preview once, and nothing else beyond the shell', async () => {
  // The shell's own reads, on a page with no data of its own.
  const shell = await apiCallsDuring(teacher, async () => {
    await teacher.goto('/teacher/guide');
    await expect(teacher.getByTestId('teacher-guide')).toBeVisible({ timeout: NAVIGATION });
  });
  const preview = await apiCallsDuring(teacher, async () => {
    await teacher.goto(`${editorHref()}/preview`);
    await expect(teacher.getByTestId('preview-stepper')).toBeVisible({ timeout: NAVIGATION });
  });
  const beyond = beyondShell(shell, preview);
  const previewGet = 'GET /api/v1/instructor/projects/:id/versions/:id/learner-preview';
  record.network = { shell, preview, beyondShell: beyond, previewGets: preview.filter((one) => one === previewGet).length };
  test.info().annotations.push({ type: 'preview-network', description: JSON.stringify(record.network) });
  expect(beyond, 'beyond the shell, only the preview GET').toEqual([previewGet]);
  expect(record.network.previewGets).toBe(1);
  expect(preview.filter((one) => !one.startsWith('GET ')), 'the page writes nothing').toEqual([]);
  await negative('the preview is read twice', () => expect(record.network.previewGets).toBe(2));
  await negative('a second call beyond the shell', () => expect(beyond).toEqual([previewGet, 'GET /api/v1/instructor/projects/:id/versions/:id']));
  // The capture itself: the same page sending one more shell read (a duplicate GET auth/me) is caught, not excused as "the shell's".
  const injected = await apiCallsDuring(teacher, async () => {
    await teacher.goto(`${editorHref()}/preview`);
    await expect(teacher.getByTestId('preview-stepper')).toBeVisible({ timeout: NAVIGATION });
    await teacher.evaluate((url) => void fetch(url).catch(() => undefined), `${API}/auth/me`);
  });
  record.network.injected = injected;
  await negative('a page that sends a duplicate shell read passes the check', () => expect(beyondShell(shell, injected)).toEqual([previewGet]));
});

test('5. publish (refused without a deep receipt, then published behind the ratified seam) and assign to a new class', async () => {
  await teacher.goto(editorHref());
  await expect(teacher.getByTestId('project-editor')).toBeVisible({ timeout: NAVIGATION });
  // The checks are under the editor's Validate tab.
  await teacher.getByTestId('project-section-validate').click();
  await teacher.getByTestId('project-validate').click();
  await expect(teacher.getByTestId('project-validation-tier')).toBeVisible({ timeout: NAVIGATION });
  // The publish form is under the editor's Publish tab.
  await teacher.getByTestId('project-section-publish').click();
  await teacher.getByTestId('project-publish-version').fill('1.0.0');
  await teacher.getByTestId('project-publish-notes').fill('The preview walk publishes the starter.');
  await teacher.getByTestId('project-publish').click();
  await teacher.getByTestId('project-publish-confirm-yes').click();
  await expect(teacher.getByTestId('project-publish-error')).toContainText(deepReceiptRefusal('Implementation'), { timeout: NAVIGATION });
  // The test-only deep-receipt seam: macOS runs no learner code, so the passed deep receipt is written directly.
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
  await expect(teacher.getByTestId('project-published')).toContainText('Version 1.0.0 is published.', { timeout: NAVIGATION });
  const library = await (await call('GET', '/instructor/projects')).json();
  const mine = [...(library.mine ?? []), ...(library.library ?? [])].find((one: any) => one.id === S.projectId);
  expect(mine?.publishedVersion).toBe('1.0.0');

  const made = await createClassFromTeacherHome(teacher, CLASS_NAME);
  S.joinCode = made.joinCode;
  // By the version's id: the option's label is copy, and it names the version's phases.
  // createClassFromTeacherHome leaves the class on its Invite and notes tab, so
  // Project is opened to assign the version.
  await teacher.getByTestId('class-tab-project').click();
  await teacher.getByTestId('class-project-pick').selectOption(mine.publishedVersionId);
  await teacher.getByTestId('class-project-reason').fill('This class works on the starter project.');
  await teacher.getByTestId('class-project-assign').click();
  await expect(teacher.getByTestId('class-project-active')).toContainText(TITLE, { timeout: NAVIGATION });
  await teacher.getByTestId('class-tab-invite').click();
  await teacher.locator('code.exp-code').first().scrollIntoViewIfNeeded();
  await shot(teacher, 'p04-class-assigned-code-masked');
  // JoinCode masks the code in the DOM until Show code is pressed,
  // so the negative below reveals it first, then copies the real code out of view of any mask.
  // The class page may still hold the reveal createClassFromTeacherHome pressed; never toggle it back off.
  const show = teacher.locator('[data-testid="join-code-show"]').first();
  if ((await show.getAttribute('aria-pressed')) !== 'true') await show.click();
  await expect(teacher.locator('code.exp-code').first()).toHaveText(S.joinCode!);
  // The frame's scan holds the code as its needle: a frame that would show it unmasked is never written.
  await negative('an unmasked frame of the code is written', async () => {
    await teacher.evaluate(() => {
      // In view, outside every mask: a copy of the code where no selector covers it.
      const bare = document.createElement('p');
      bare.setAttribute('data-e2e-negative', '');
      bare.setAttribute('style', 'position:fixed;top:8px;left:8px;z-index:2147483647;background:#fff;padding:4px');
      bare.textContent = document.querySelector('code.exp-code')?.textContent ?? '';
      document.body.appendChild(bare);
    });
    try {
      await captureMasked(teacher, path.join(test.info().outputDir, 'never-written.png'), [S.joinCode!]);
    } finally {
      await teacher.evaluate(() => document.querySelector('[data-e2e-negative]')?.remove());
    }
  });
  expect(fs.existsSync(path.join(test.info().outputDir, 'never-written.png')), 'the refused frame was not written').toBe(false);
});

test("6. a learner joins with the code, opens Requirements and sees the interview persona's opening", async () => {
  await registerIntoClass(learner, { name: `Lia Preview ${RUN}`, email: `learner-preview-${RUN}${NONCE}@example.test` }, S.joinCode!);
  await expect(learner.locator('main#main'), 'the dashboard names the uploaded project').toContainText(`Your project: ${TITLE}`, { timeout: NAVIGATION });
  const token = await learner.evaluate(() => window.localStorage.getItem('lsdlc_token'));
  expect(token, 'the page has a session').toBeTruthy();
  const mine = await (await call('GET', '/enrollments/mine', undefined, { authorization: `Bearer ${token}` })).json();
  expect(mine.projectSlug, 'enrolled on the starter').toBe(S.slug);
  await shot(learner, 'p05-learner-dashboard');

  await openRequirements(learner);
  await expect(learner.getByTestId('interview-page')).toBeVisible({ timeout: UI_READY });
  await expect(learner.getByTestId('interview-persona')).toContainText(PERSONA);
  await expect(learner.getByTestId('interview-opening')).toContainText(OPENING);
  await expect(learner.getByTestId('interview-turns-left')).toHaveText('12 questions left');
  await negative("the room opens with TaskTrackr's persona", () => expect(learner.getByTestId('interview-persona')).toContainText('Dana Osei', { timeout: 1_500 }));
  const text = await learner.locator('body').innerText();
  expect(found(text, TASKTRACKR_INTERVIEW_WORDS), 'no TaskTrackr interview word in the room').toEqual([]);
  expect(found(text, FACT_NEEDLES), "no fact answer in the learner's room").toEqual([]);
  await negative("a fact answer in the learner's room goes unseen", () => expect(found(`${text}\n${LEAKED_ANSWER}`, FACT_NEEDLES)).toEqual([]));
  await shot(learner, 'p06-learner-requirements-opening');
  // No question was asked, so no model was asked anything.
  expect(JSON.stringify(await stubCounts()), 'the AI stub was asked nothing').toBe(record.aiStub.before);
});

test('no response anywhere in the walk had a status of 500 or more', async () => {
  expect(fiveHundreds).toEqual([]);
});
