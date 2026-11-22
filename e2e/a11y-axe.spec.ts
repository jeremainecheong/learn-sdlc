import { expect, test, type Page, type Route } from '@playwright/test';
import { PHONE_BELOW, reflow, type Width } from './a11y-reflow';
import { stripDoor } from './pw-fixtures';
import { assertLoopbackApi } from './support/env';
import { NAVIGATION } from './support/timeouts';
import { clean, modalChecks, primaryActionReachable, runAxe, stubCounts, waitLineHeard } from './a11y-checks';
import { ids, session, uploadIds, type Ids, type Role, type UploadIds } from './support/a11y-fixtures';
import { routeName } from './support/api';

/**
 * The permanent automated accessibility check.
 *
 * Every learner and teacher screen in the list below, including the screens
 * a teacher's own copy of a project adds (the bridge notice, a Requirements
 * room with no interview, the editor's Requirements builder, interview editor and
 * file-replace dialog) and the learner's own "Start this task over" dialog,
 * is opened at 1440, 1280 and 390 CSS px (the drill page, the design room,
 * the issue room, the IDE's Runbook view and the change room with the sidebar
 * toggle pressed at 360, 390, 430 and 460) and checked with axe-core 4.11.0
 * (the exact-pinned root devDependency) against the
 * WCAG 2.0 and 2.1 A and AA tags. A test fails on any serious or critical
 * violation. Beside axe it checks the things axe cannot see: a wait line that
 * a screen reader never hears; at phone width, text
 * or a control cut off on the x axis (the clip probe) and a page-sized panel
 * that scrolls sideways (e2e/a11y-reflow.ts); at every width, tabs drawn over
 * each other; on the change page, that a tap reaches Submit; and, on the two
 * modal dialogs (file replace, "Start this task over"), that focus stays
 * inside, Escape closes, focus returns, and the page behind is inert.
 *
 * Reflow (WCAG 1.4.10). The product draws every signed-in
 * screen inside a fixed, overflow-hidden frame and every public one inside an
 * `overflow: clip` page, so the document is never wider than the viewport,
 * whatever the content does: the line "the document is N px wide" is kept as
 * a secondary check and cannot fail inside those frames. Content that does
 * not reflow is cut off instead, or makes a panel scroll sideways, and that is
 * what the clip probe and the sideways check measure (their exceptions are
 * listed in e2e/a11y-reflow.ts).
 *
 * Phone widths are drawn with touch (hasTouch), so `(pointer: coarse)` and
 * `(hover: none)` match and the 44px touch targets apply, as on a phone.
 * Every signed-in screen must show its main landmark (#main, the skip link's
 * target), not busy, before it is checked, so a loading placeholder is not
 * audited in place of the screen. The six legacy addresses are labelled as
 * the redirects they are and must land where they redirect to.
 *
 * Scope, stated exactly. With these tags axe 4.11.0 runs 61
 * of its 104 rules. Its default tagExclude drops 7 WCAG-tagged rules marked
 * experimental or deprecated, label-content-name-mismatch (2.5.3, A) among
 * them, and 6 of the 61 can never fail here because axe fixes their impact
 * below serious (aria-deprecated-role, form-field-multiple-labels,
 * html-xml-lang-mismatch, meta-viewport, no-autoplay-audio,
 * server-side-image-map). axe's "needs review" results are not counted (most
 * of them are colour contrast on gradient, backdrop or overlapped text), so a
 * green contrast line means no decidable failure, not that every pair was
 * measured.
 *
 * Theme. Every row runs in Paper: neither this spec nor
 * playwright.config.ts sets colorScheme, so Playwright emulates
 * `prefers-color-scheme: light`. Graphite, the first paint on every
 * dark-mode machine with nothing stored, has no axe run; it is checked only
 * at source level (e2e/contrast.spec.ts token pairs and the rule pairs in
 * apps/web/test/a11y-contrast-sources.test.ts).
 *
 * Not opened: /admin and /workspace/:id/runs/:runId.
 *
 * This is an automated check. It is not a manual screen-reader pass and does
 * not replace one.
 *
 * How it runs. Under the default config (`playwright.config.ts`): the loopback
 * AI stub, the API on a fresh sqlite file and the web build, with the ports
 * the web build was told at build time:
 *
 *   PW_API_PORT=4194 PW_WEB_PORT=3094 HOSTNAME=127.0.0.1 \
 *     npx playwright test e2e/a11y-axe.spec.ts --workers=1
 *
 * No AI is spent. After the fixture is made through the API's own routes,
 * every request a screen makes other than GET, HEAD or OPTIONS is aborted in
 * the browser, and the two wait lines hold their one POST in the browser and
 * drop it, so it never reaches the API. Each test also reads the stub's
 * request counts before and after and requires them unchanged.
 *
 * axe is read from `node_modules/axe-core` and injected with `page.evaluate`,
 * which the page's CSP (`script-src 'self' 'unsafe-inline'`) does not govern,
 * so no script tag is added and the CSP is unchanged.
 */

/* --------------------------------- setup --------------------------------- */

// Loopback only: this spec seeds accounts and classes, so it never talks to a
// hosted stack, whatever E2E_API_URL says.
assertLoopbackApi(__filename);

const AXE_VERSION = '4.11.0';
const FAILING_IMPACTS = new Set(['serious', 'critical']);

// Two desktop widths, 1280 and 1440, and one phone width.
const WIDTHS = [
  { label: 'desktop-1440', width: 1440, height: 900 },
  { label: 'desktop-1280', width: 1280, height: 900 },
  { label: 'phone-390', width: 390, height: 844 },
] as const;

/**
 * The pinned sidebar as a phone learner meets it. Below `lg` a remembered
 * "Keep open" is drawn as the rail (lib/sidebar.ts), so the "(sidebar pinned
 * open)" screens measure the rail at 390, not the column; each run asserts
 * the shape it measures: the column (html[data-sidebar="full"]) at 1440 and
 * 1280, the rail at 390. The learner's own press of `sidebar-toggle` still
 * pins the column for that page, and that is the case these widths guard:
 * the column can push the change page's Submit out of its overflow-hidden
 * main at 360 and 390, and leaves the page only 228px at 460.
 */
const TOGGLE_WIDTHS: readonly Width[] = [360, 390, 430, 460].map((width) => ({ label: `phone-${width}`, width, height: 844 }));

/* ------------------------ upload and sign-off screens ---------------------- */

/** The upload fixture (support/a11y-fixtures.ts), made before a test titled "Upload: …" and only then. */
let uploadScreens: UploadIds | null = null;
test.beforeEach(async ({}, info) => {
  if (info.title.startsWith('Upload: ')) uploadScreens = await uploadIds();
});
const UPLOAD_WIDTHS: readonly Width[] = [
  { label: 'desktop-1280', width: 1280, height: 900 },
  { label: 'phone-390', width: 390, height: 844 },
];
const uploadEditor = () => `/teacher/projects/${uploadScreens!.uploadProjectId}/versions/${uploadScreens!.uploadDraftVersionId}`;
const uploadClass = () => `/teacher/class?class=${uploadScreens!.signCohortId}`;
// The queue is under the class page's Sign-off tab, opened by its address.
const uploadSignoff = () => `${uploadClass()}&tab=signoff`;

/* --------------------------------- screens -------------------------------- */

interface Screen {
  label: string;
  role: Role;
  url: (fx: Ids) => string;
  /** Leave the per-phase tutorial to open by itself. */
  tutorial?: boolean;
  /** The learner's own "Keep open" sidebar choice (lib/sidebar.ts). */
  sidebarPinned?: boolean;
  /** A POST held in the browser (never sent) while the wait line shows. */
  hold?: RegExp;
  /** What to do before checking; client-side only (writes are aborted). */
  act?: (page: Page) => Promise<void>;
  /**
   * A selector that must be visible: the screen under test really rendered.
   * Every signed-in screen also has to show its main landmark, not busy.
   */
  ready?: string;
  /** A legacy address: the path it must land on (its label says so). */
  lands?: string;
  /** Extra checks after axe, each returning failure sentences. */
  extra?: (page: Page) => Promise<string[]>;
  /** Widths of its own, in place of `WIDTHS`. */
  widths?: readonly Width[];
}

const at = (label: string, role: Role, url: Screen['url'], more: Partial<Screen> = {}): Screen => ({ label, role, url, ...more });
const fixed = (u: string) => () => u;
const room = (phase: string, rest = '') => (fx: Ids) => `/workspace/${fx.phases[phase]}${rest}`;
const editor = (fx: Ids) => `/teacher/projects/${fx.projectId}/versions/${fx.draftVersionId}`;
const evidence = (phase: string) => (fx: Ids) => `/teacher/class?class=${fx.cohortId}&evidence=${fx.learnerId}&phase=${fx.phases[phase]}`;

/**
 * The learner's own press of `sidebar-toggle` on a phone, which pins the
 * column for the page. The two preconditions keep the reflow check honest:
 * without them it would measure the rail and pass for the wrong reason.
 */
async function pressSidebarToggle(page: Page): Promise<void> {
  await page.getByTestId('sidebar-toggle').first().click({ timeout: 20_000 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-sidebar')), {
      message: 'precondition: html[data-sidebar="full"] after the toggle press',
      timeout: 10_000,
    })
    .toBe('full');
  // ...and the column is drawn at its width, not only named.
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.nav-slot')?.getBoundingClientRect().width ?? 0), {
      message: 'precondition: the pinned column (.nav-slot) is drawn at least 200px wide after the toggle press',
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(200);
}

async function holdWait(page: Page, input: string, send: string, text: string, openPanel?: string) {
  if (openPanel && !(await page.getByTestId(input).isVisible().catch(() => false))) {
    await page.getByRole('button', { name: openPanel, exact: true }).first().click({ timeout: 15_000 });
  }
  await page.getByTestId(input).fill(text);
  await page.getByTestId(send).click();
  await page.getByTestId('wait-stage').first().waitFor({ state: 'visible', timeout: 15_000 });
  // Long enough for the wait line to reach its second stage.
  await page.waitForTimeout(7_000);
}

/**
 * The editor's phase tab, and a check that the click selected it: a click that
 * lands on a neighbouring tab would check the wrong phase's panel.
 */
async function openPhaseTab(page: Page, key: string) {
  // A phase is a tab in the editor's one row of section tabs (`project-section-<key>`).
  const tab = page.getByTestId(`project-section-${key}`);
  await tab.click();
  const selected = () =>
    page.evaluate(() => document.querySelector('[role="tab"][data-testid^="project-section-"][aria-selected="true"]')?.getAttribute('data-testid') ?? 'none');
  if ((await selected()) === `project-section-${key}`) return;
  await page.waitForTimeout(500);
  if ((await selected()) === `project-section-${key}`) return;
  throw new Error(`precondition: a click on project-section-${key} left ${await selected()} selected`);
}

const SCREENS: Screen[] = [
  // Public.
  ...['/', '/login', '/register', '/forgot', '/reset', '/confirm', '/verify', '/how-it-works', '/what-you-learn', '/privacy', '/terms', '/login/callback'].map(
    (u) => at(u, 'public', fixed(u)),
  ),
  // A learner who has not finished setup.
  at('/onboarding (setup not finished)', 'newcomer', fixed('/onboarding')),
  // The learner's pages.
  ...['/dashboard', '/progress', '/profile', '/feedback', '/classroom', '/journal', '/artefacts', '/dossier', '/account', '/map', '/learn', '/completion', '/complete', '/join'].map(
    (u) => at(u, 'learner', fixed(u)),
  ),
  // Legacy addresses: each is a redirect, not a screen of its
  // own, and must land where it redirects to.
  at('/phases (legacy, redirects to /progress)', 'learner', fixed('/phases'), { lands: '/progress' }),
  at('/warmup (legacy, redirects to /learn/implementation)', 'learner', fixed('/warmup'), { lands: '/learn/implementation' }),
  ...['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'].map((k) => at(`/learn/${k}`, 'learner', fixed(`/learn/${k}`))),
  // The six phases: door, brief, rooms.
  at('/workspace/:requirements (door)', 'learner', room('requirements')),
  at('/workspace/:requirements/interview', 'learner', room('requirements', '/interview')),
  at('/workspace/:requirements/issue', 'learner', room('requirements', '/issue')),
  at('/workspace/:requirements/brief', 'learner', room('requirements', '/brief')),
  at('/workspace/:design?task=main (the bare path, sent on to the design room)', 'learner', room('design', '?task=main')),
  at('/workspace/:quiz?task=concepts (quiz room, paper open)', 'learner', (fx) => `/workspace/${fx.phases[fx.quizPhase]}/quiz?task=concepts`),
  at('/workspace/:design/quiz?task=design-check (quiz room, marked)', 'learner', room('design', '/quiz?task=design-check')),
  at('/workspace/:design/brief', 'learner', room('design', '/brief')),
  at('/workspace/:design (door)', 'learner', room('design')),
  at('/workspace/:design/design', 'learner', room('design', '/design')),
  // The bridge notice on a teacher's project.
  at('/workspace/:implementation/brief (bridge notice)', 'learner', room('implementation', '/brief'), { ready: '[data-testid="brief-bridge-notice"]' }),
  at('/workspace/:implementation (IDE)', 'learner', room('implementation')),
  at('/workspace/:implementation/pr', 'learner', room('implementation', '/pr')),
  at('/workspace/:testing/brief', 'learner', room('testing', '/brief')),
  at('/workspace/:testing (IDE)', 'learner', room('testing')),
  at('/workspace/:testing/matrix', 'learner', room('testing', '/matrix')),
  at('/workspace/:deployment/brief', 'learner', room('deployment', '/brief')),
  at('/workspace/:deployment (IDE)', 'learner', room('deployment')),
  at('/workspace/:deployment/drill', 'learner', room('deployment', '/drill')),
  at('/workspace/:maintenance/brief', 'learner', room('maintenance', '/brief')),
  at('/workspace/:maintenance (IDE)', 'learner', room('maintenance')),
  at('/workspace/:maintenance/change', 'learner', room('maintenance', '/change')),
  at('/workspace/:design/solution (not earned)', 'learner', room('design', '/solution')),
  // States.
  at('/dashboard (sidebar pinned open)', 'learner', fixed('/dashboard'), { sidebarPinned: true }),
  at('/workspace/:maintenance/change (sidebar pinned open)', 'learner', room('maintenance', '/change'), {
    sidebarPinned: true,
    extra: (page) => primaryActionReachable(page, '[data-testid="phase-maintenance-submit"]'),
  }),
  at('/workspace/:maintenance/change (sidebar toggle pressed)', 'learner', room('maintenance', '/change'), {
    widths: TOGGLE_WIDTHS,
    act: pressSidebarToggle,
    ready: '[data-testid="phase-maintenance-submit"]',
    extra: (page) => primaryActionReachable(page, '[data-testid="phase-maintenance-submit"]'),
  }),
  // Every other room a phone learner can pin the column over, pressed the same way at the same widths.
  ...(
    [
      ['/workspace/:deployment/drill', room('deployment', '/drill')],
      ['/workspace/:design/design', room('design', '/design')],
      ['/workspace/:requirements/issue', room('requirements', '/issue')],
      ['/workspace/:deployment?panel=runbook (the IDE\'s Runbook view)', room('deployment', '?panel=runbook')],
    ] as const
  ).map(([label, url]) => at(`${label} (sidebar toggle pressed)`, 'learner', url, { widths: TOGGLE_WIDTHS, act: pressSidebarToggle })),
  at('/workspace/:requirements/interview (wait line held)', 'learner', room('requirements', '/interview'), {
    hold: /\/interview\/ask$/,
    act: (page) => holdWait(page, 'interview-input', 'interview-send', 'Who uses the room booking desk first thing in the morning?'),
    ready: '[data-testid="wait-stage"]',
    extra: waitLineHeard,
  }),
  at('/workspace/:requirements/issue (mentor wait line held)', 'learner', room('requirements', '/issue'), {
    hold: /\/assistant\/chat$/,
    act: (page) => holdWait(page, 'chat-input', 'chat-send', 'What makes an acceptance criterion testable?', 'Show mentor'),
    ready: '[data-testid="wait-stage"]',
    extra: waitLineHeard,
  }),
  at('/workspace/:design/design (phase tutorial open)', 'learner', room('design', '/design'), { tutorial: true, ready: '[data-testid="coach"]' }),
  // The learner's own reset: its confirm, read from GET …/reset.
  at('/workspace/:design/design?task=main (Start this task over dialog open)', 'learner', room('design', '/design?task=main'), {
    act: async (page) => {
      // Behind the room's header menu where the room draws one.
      await (await stripDoor(page, 'task-reset-open')).click({ timeout: 20_000 });
    },
    ready: '[data-testid="task-reset-dialog"]',
    extra: modalChecks('[data-testid="task-reset-dialog"]', '[data-testid="task-reset-open"]'),
  }),
  // A Requirements room with no interview (the tab is not drawn).
  at('/workspace/:requirements, project with no interview', 'plain', (fx) => `/workspace/${fx.plainPhases.requirements}`, {
    ready: '[data-testid="requirements-workspace"]',
    extra: async (page) =>
      (await page.getByRole('tab', { name: 'Stakeholder interview', exact: true }).count()) === 0
        ? []
        : ['precondition: the Requirements room of a project with no interview still draws a "Stakeholder interview" tab'],
  }),
  // Teacher.
  ...['/teacher', '/teacher/class', '/teacher/projects', '/teacher/settings'].map((u) => at(u, 'teacher', fixed(u))),
  // The class page opens on Overview; its other panels are hidden (axe skips them) until their tab is open.
  at('/teacher/class (Project tab)', 'teacher', (fx) => `/teacher/class?class=${fx.cohortId}&tab=project`, { ready: '[data-testid="class-project-card"]' }),
  at('/teacher/class (Dates and regrades tab)', 'teacher', (fx) => `/teacher/class?class=${fx.cohortId}&tab=dates`, { ready: '[data-testid="schedule-panel"]' }),
  at('/teacher/class (Invite and notes tab)', 'teacher', (fx) => `/teacher/class?class=${fx.cohortId}&tab=invite`, { ready: '[data-testid="notes-card"]' }),
  at('/instructor (legacy, redirects to /teacher)', 'teacher', fixed('/instructor'), { lands: '/teacher' }),
  at('/instructor/retro (legacy, redirects to /teacher)', 'teacher', fixed('/instructor/retro'), { lands: '/teacher' }),
  at('/teacher/projects/:p/versions/:published (read-only)', 'teacher', (fx) => `/teacher/projects/${fx.projectId}/versions/${fx.publishedVersionId}`),
  at('/teacher/projects/:p/versions/:draft (editor)', 'teacher', editor),
  // Validate and Publish are tabs, hidden (and out of the accessibility tree) until opened; scan each by its address.
  at('/teacher/projects/:p/versions/:published?section=validate (read-only, Validate)', 'teacher', (fx) => `/teacher/projects/${fx.projectId}/versions/${fx.publishedVersionId}?section=validate`, { ready: '[data-testid="project-validation"]' }),
  at('/teacher/projects/:p/versions/:published?section=publish (read-only, Publish)', 'teacher', (fx) => `/teacher/projects/${fx.projectId}/versions/${fx.publishedVersionId}?section=publish`, { ready: '[data-testid="project-publish-panel"]' }),
  at('/teacher/projects/:p/versions/:draft?section=validate (editor, Validate)', 'teacher', (fx) => `${editor(fx)}?section=validate`, { ready: '[data-testid="project-validation"]' }),
  at('/teacher/projects/:p/versions/:draft?section=publish (editor, Publish)', 'teacher', (fx) => `${editor(fx)}?section=publish`, { ready: '[data-testid="project-publish-panel"]' }),
  at('/teacher/projects/:p/versions/:draft (quiz editor open)', 'teacher', editor, {
    act: async (page) => {
      const fx = await ids();
      await openPhaseTab(page, fx.quizPhase);
      await page.getByTestId('task-edit-concepts').click();
    },
    ready: '[data-testid="task-form-title"]',
  }),
  // Design, one design task (a quiz may sit beside it), opens in the six-step builder.
  at('/teacher/projects/:p/versions/:draft (Design builder)', 'teacher', editor, {
    act: async (page) => {
      await openPhaseTab(page, 'design');
    },
    ready: '[data-testid="design-builder"]',
  }),
  // The Requirements builder, the interview editor, the file-replace dialog.
  // Requirements, one story task (a quiz may sit beside it), opens in the five-step builder.
  at('/teacher/projects/:p/versions/:draft (Requirements builder)', 'teacher', editor, {
    act: async (page) => {
      await openPhaseTab(page, 'requirements');
    },
    ready: '[data-testid="requirements-builder"]',
  }),
  at('/teacher/projects/:p/versions/:draft (interview editor open, one fact added)', 'teacher', editor, {
    act: async (page) => {
      await openPhaseTab(page, 'requirements');
      await page.getByTestId('phase-interview-edit').click();
      await page.getByTestId('interview-editor').waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByTestId('interview-fact-add').click();
    },
    ready: '[data-testid="interview-editor"]',
  }),
  at('/teacher/projects/:p/versions/:draft (file-replace dialog open, design)', 'teacher', editor, {
    act: async (page) => {
      // Design's starting documents are replaced from the builder's Starting point step.
      await openPhaseTab(page, 'design');
      await page.locator('[data-testid^="phase-starter-replace-"]').first().click({ timeout: 20_000 });
    },
    ready: '[data-testid="file-replace-dialog"]',
    extra: modalChecks('[data-testid="file-replace-dialog"]', '[data-testid^="phase-starter-replace-"]'),
  }),
  // The roster is a class's, so /teacher?learner= goes on to the learner's class page, filtered to them.
  at('/instructor/learners/:learner (legacy, redirects to the class roster filtered to the learner)', 'teacher', (fx) => `/instructor/learners/${fx.learnerId}`, {
    lands: '/teacher/class',
    ready: '[aria-label="Learner phase map and roster"]',
  }),
  at('/teacher/class (evidence panel, task levers)', 'teacher', evidence('design'), { ready: '[data-testid="learner-tasks"]' }),
  at('/teacher/class (evidence panel, marked quiz)', 'teacher', evidence('design'), { ready: '[data-testid="learner-tasks"]' }),
  at('/teacher/class (task lever confirm open)', 'teacher', evidence('design'), {
    act: async (page) => {
      await page.locator('[data-testid="task-reset-main"]:not([disabled])').first().click({ timeout: 20_000 });
    },
    ready: '[data-testid^="task-lever-confirm-"]',
  }),
  at('/instructor/learners/:learner/dossier', 'teacher', (fx) => `/instructor/learners/${fx.learnerId}/dossier`),
  // The upload screens, at 1280 and 390.
  at('Upload: /teacher/projects (upload door open)', 'teacher', fixed('/teacher/projects'), {
    widths: UPLOAD_WIDTHS,
    act: async (page) => {
      await page.getByTestId('projects-upload-open').click({ timeout: 20_000 });
      await expect(page.getByTestId('projects-upload-profile'), 'precondition: the profile line is read').toHaveText(/^This deployment runs:/, { timeout: 20_000 });
    },
    ready: '[data-testid="projects-upload"]',
  }),
  at('Upload: /teacher/projects/:upload/versions/:draft (executable editor, implementation)', 'teacher', () => uploadEditor(), {
    widths: UPLOAD_WIDTHS,
    act: async (page) => {
      await openPhaseTab(page, 'implementation');
      await page.getByTestId('exec-edit-open').click({ timeout: 20_000 });
    },
    ready: '[data-testid="exec-editor"]',
  }),
  at('Upload: /teacher/projects/:upload/versions/:draft (deep validation, cost warning shown)', 'teacher', () => uploadEditor(), {
    widths: UPLOAD_WIDTHS,
    act: async (page) => {
      // Deep validation is under the editor's Validate tab.
      await page.getByTestId('project-section-validate').click({ timeout: 20_000 });
      await page.getByTestId('deep-validation-open').click({ timeout: 20_000 });
    },
    ready: '[data-testid="deep-validation-warning"]',
    // In a real browser: the page behind is inert, Tab and Shift+Tab stay in, Escape closes, focus returns.
    extra: modalChecks('[data-testid="deep-validation-dialog"]', '[data-testid="deep-validation-open"]'),
  }),
  at('Upload: /teacher/class (sign-off queue, one learner waiting)', 'teacher', () => uploadSignoff(), {
    widths: UPLOAD_WIDTHS,
    ready: '[data-testid^="signoff-pick-"]',
  }),
  // The queue's own confirm, a StaffDialog (opened only; the fence aborts the batch).
  at('Upload: /teacher/class (sign-off confirm open)', 'teacher', () => uploadSignoff(), {
    widths: UPLOAD_WIDTHS,
    act: async (page) => {
      await page.locator('[data-testid^="signoff-pick-"]').first().check({ timeout: 20_000 });
      await page.locator('[data-testid^="signoff-reason-"]').first().fill('Read in the lab: the words are the customer’s own.');
      await page.locator('button[data-testid^="signoff-bulk-"]').first().click({ timeout: 20_000 });
    },
    ready: '[data-testid="signoff-confirm"]',
    extra: modalChecks('[data-testid="signoff-confirm"]', 'button[data-testid^="signoff-bulk-"]'),
  }),
  // The draft editor's task rows, where the "Needs your sign-off" toggle sits.
  at('Upload: /teacher/projects/:upload/versions/:draft (requirements, sign-off toggle)', 'teacher', () => uploadEditor(), {
    widths: UPLOAD_WIDTHS,
    act: async (page) => {
      await openPhaseTab(page, 'requirements');
    },
    ready: '[data-testid^="task-signoff-box-"]',
  }),
  at('Upload: /teacher/class (quiz-results export block)', 'teacher', (fx) => `/teacher/class?class=${fx.cohortId}`, {
    widths: UPLOAD_WIDTHS,
    act: async (page) => {
      await page.getByTestId('export-quiz-form').scrollIntoViewIfNeeded({ timeout: 20_000 });
    },
    ready: '[data-testid="export-quiz-form"]',
  }),
];

/* ---------------------------------- tests --------------------------------- */

test.describe('accessibility: axe-core, WCAG 2.0/2.1 A and AA, serious and critical', () => {
  const runs: [Width, Screen][] = [
    ...WIDTHS.flatMap((width) => SCREENS.filter((screen) => !screen.widths).map((screen): [Width, Screen] => [width, screen])),
    ...SCREENS.flatMap((screen) => (screen.widths ?? []).map((width): [Width, Screen] => [width, screen])),
  ];
  for (const [width, screen] of runs) {
    test(`${screen.label} @ ${width.label}`, async ({ browser }) => {
      test.setTimeout(180_000);
      const fx = screen.role === 'public' ? null : await ids();
      const aiBefore = await stubCounts();

      const ctx = await browser.newContext({
        viewport: { width: width.width, height: width.height },
        // A phone is drawn with touch: (pointer: coarse) applies.
        hasTouch: width.width < PHONE_BELOW,
        storageState: fx && screen.role !== 'public' ? await session(browser, screen.role, fx) : undefined,
      });
      const blocked: string[] = [];
      const held: Route[] = [];
      try {
        if (screen.role !== 'public' && !screen.tutorial) {
          await ctx.addInitScript(() => {
            try {
              const read = Storage.prototype.getItem;
              Storage.prototype.getItem = function (this: Storage, key: string) {
                if (typeof key === 'string' && key.startsWith('lsdlc_phase_tutorial_v1:')) return 'seen';
                return read.call(this, key);
              };
              window.localStorage.setItem('lsdlc_coach', 'done');
            } catch {
              /* storage refused: the tutorial shows */
            }
          });
        }
        if (screen.sidebarPinned) {
          await ctx.addInitScript(() => {
            try {
              window.localStorage.setItem('lsdlc_sidebar', 'full');
              window.localStorage.setItem('lsdlc_sidebar_ide', 'full');
            } catch {
              /* storage refused */
            }
          });
        }
        // The fence: reads pass; every write is aborted in the browser; a
        // held request is kept here and never sent.
        await ctx.route('**/*', async (route) => {
          const req = route.request();
          const method = req.method();
          if (screen.hold && method === 'POST' && screen.hold.test(new URL(req.url()).pathname)) {
            held.push(route);
            return;
          }
          if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return route.continue();
          blocked.push(`${method} ${routeName(new URL(req.url()).pathname)}`);
          return route.abort('blockedbyclient');
        });

        const page = await ctx.newPage();
        await page.goto(screen.url(fx as Ids), { waitUntil: 'domcontentloaded', timeout: NAVIGATION });
        await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
        await page.waitForTimeout(900);
        // Park the pointer in the page, as teacher-guide.spec.ts and learner-preview.spec.ts do:
        // a new page's pointer rests on the rail, which peeks open over the content
        // (Sidebar.tsx onPointerEnter) and takes the press meant for what is under it.
        await page.mouse.move(width.width - 2, Math.round(width.height / 2));
        if (screen.act) await screen.act(page);
        if (screen.ready) await expect(page.locator(screen.ready).first(), `precondition: ${screen.ready} is on screen`).toBeVisible({ timeout: 20_000 });
        if (screen.role !== 'public') {
          // A positive proof of render: the main landmark, the
          // skip link's target, is drawn and not a loading placeholder.
          await expect(page.locator('main#main:not([aria-busy="true"])').first(), 'precondition: the main landmark (#main) is on screen and not busy').toBeVisible({
            timeout: 20_000,
          });
          await expect(page.getByTestId('route-loading'), 'precondition: no route is still loading').toHaveCount(0);
        }
        if (screen.sidebarPinned) {
          const shape = width.width >= 1024 ? 'full' : 'rail';
          await expect
            .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-sidebar')), {
              message: `precondition: a remembered "Keep open" is drawn as html[data-sidebar="${shape}"] at ${width.width}px`,
              timeout: 10_000,
            })
            .toBe(shape);
        }
        await expect(page.getByText(/Something went wrong|Application error/i), 'precondition: the screen rendered').toHaveCount(0);
        // A signed-in screen that bounced to sign-in (or to setup) would be
        // checked as the wrong page and pass for the wrong reason.
        const finalPath = new URL(page.url()).pathname;
        if (screen.role !== 'public') {
          expect(finalPath.startsWith('/login'), `precondition: ${screen.label} is not sent to sign-in`).toBe(false);
          if (screen.role !== 'newcomer') expect(finalPath, `precondition: ${screen.label} is not sent to setup`).not.toBe('/onboarding');
        }
        if (screen.lands) expect(finalPath, `precondition: ${screen.label} lands on ${screen.lands}`).toBe(screen.lands);
        const mainTestId = screen.role === 'public' ? null : await page.locator('main#main').first().getAttribute('data-testid').catch(() => null);

        const ax = await runAxe(page);
        expect(ax.version, 'the exact-pinned axe-core').toBe(AXE_VERSION);
        const failures = ax.violations
          .filter((v) => FAILING_IMPACTS.has(v.impact ?? ''))
          .map((v) => `axe:${v.id} (${v.impact}, ${v.count} node${v.count === 1 ? '' : 's'}): ${v.help} — ${v.targets.join(' | ')}`);
        failures.push(...(await reflow(page, width)));
        if (screen.extra) failures.push(...(await screen.extra(page)));

        const lines = failures.map(clean);
        await test.info().attach('a11y-findings.json', {
          body: JSON.stringify(
            { screen: screen.label, width: width.label, landedOn: clean(finalPath), main: mainTestId, axe: ax.version, findings: lines, blockedWrites: blocked },
            null,
            2,
          ),
          contentType: 'application/json',
        });
        expect(lines, lines.join('\n')).toEqual([]);
      } finally {
        for (const route of held) await route.abort('aborted').catch(() => undefined);
        await ctx.close();
        // Soft, so a finding above is not hidden behind this line; it still fails the test.
        expect.soft(await stubCounts(), 'the AI stub received no request while this screen was checked').toBe(aiBefore);
      }
    });
  }
});
