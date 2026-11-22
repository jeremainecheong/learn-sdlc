import { expect, Page, test } from '@playwright/test';
import { createUnlockedEditor, signInEditorFixture, type EditorFixture } from './fixtures/unlocked-editor';
import { API_ORIGIN as API } from './support/env';
import { skipCoachMarks, waitForEditor } from './pw-fixtures';
import { SANDBOX_RUN, UI_READY } from './support/timeouts';

/**
 * The workspace, as a room you walk in and out of.
 *
 * An IDE that renders nothing until its own fetch comes back shows one frame
 * with no document, then a one-row shell, then "Loading editor…", then the
 * panes. One that keeps nothing loses the file you had open, where your caret
 * was, what you had asked the reviewer, and, in the seven-tenths of a second
 * after a keystroke, the keystroke itself.
 *
 * So these four are about arriving and leaving rather than about what the IDE
 * can do: the frame is there from the first commit, the editor is there on a
 * return before anyone could see it was not, an edit survives being walked
 * away from, and the room you come back to is the room you left.
 */

let fixture: EditorFixture;


/** A real editable Implementation file in this isolated fixture. */
const STORY = 'api/repository/tasks.py';
/**
 * A file the phase does not open on, so opening it is the learner's own doing.
 * (Implementation opens on api/routes/tasks.py, at its first gap,
 * workspace/[phaseId]/page.tsx "The IDE opens where the work is", so the
 * file is another of the supplied ones.)
 */
const PROVIDED = 'api/repository/lists.py';
const tabId = (path: string) => `file-tab-${path.replace(/[/.]/g, '-')}`;

test.describe.configure({ mode: 'default' }); // in order; a red case restarts the worker and beforeAll opens a fresh editor, so nothing after it is skipped
test.beforeAll(async ({ request }) => { fixture = await createUnlockedEditor(request, 'workspace-lifecycle'); });

/* --------------------------------- helpers -------------------------------- */


async function register(page: Page): Promise<void> {
  await signInEditorFixture(page, fixture);
}

async function signIn(page: Page): Promise<void> {
  await signInEditorFixture(page, fixture);
  await expect(page.getByRole('heading', { name: 'Welcome, Isolated.', exact: true })).toBeVisible();
}

/** The Requirements interview has no editor; use this isolated Implementation room. */
async function intoWorkspace(page: Page): Promise<void> {
  await page.goto(`/workspace/${fixture.phaseId}?file=${encodeURIComponent(STORY)}`);
  await waitForEditor(page, 30000);
}

/**
 * The palette's phase door is the real client-side way into the
 * Implementation IDE, in one step (no case file in front of it). The IDE
 * remembers a room in this tab's memory, and a full page load is a new session
 * for it (workspace/[phaseId]/page.tsx heldView).
 */
async function toTheEditor(page: Page): Promise<void> {
  await page.getByTestId('jump-to').click();
  await page.getByTestId('palette-input').fill('Implementation');
  await page.getByRole('group', { name: 'Phases', exact: true }).getByRole('option', { name: /Implementation/ }).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${fixture.phaseId}$`), { timeout: UI_READY });
}

/** The IDE's own path: the brief and the issue are under /workspace too. */
const IDE_PATH = /^\/workspace\/[^/]+$/;

/**
 * Every DOM mutation from now until it is read: what the document held and
 * whether the phase was named. A frame that lasted one paint is in here.
 */
async function watchDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    const state = { samples: [] as { path: string; main: number; title: boolean }[] };
    const sample = () => {
      const main = document.querySelector('main');
      state.samples.push({
        path: location.pathname,
        main: (main?.textContent ?? '').length,
        title: Boolean(document.querySelector('[data-testid="phase-title"]')),
      });
    };
    w.__ideWatch = state;
    w.__ideObserver?.disconnect();
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    w.__ideObserver = observer;
    sample();
  });
}

async function readDocument(
  page: Page,
): Promise<{ path: string; main: number; title: boolean }[]> {
  return page.evaluate(() => {
    const w = window as any;
    w.__ideObserver?.disconnect();
    return w.__ideWatch.samples;
  });
}

/**
 * A reading every animation frame.
 *
 * `host` is what this suite is actually about: the code column is part of the
 * room's frame, so it is in the document from the first commit at /workspace
 * and the editor arrives inside a column that is already there. That is a
 * statement about what was on screen rather than about when, so a loaded
 * machine makes it slower and never makes it red. `skeleton` counts the frames
 * that showed a placeholder, the lazy chunk's or monaco's own, which are
 * deliberately the same bars, and is reported rather than asserted.
 */
async function watchFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    const t0 = performance.now();
    const samples: Frame[] = [];
    w.__ideFrames = samples;
    w.__ideFramesOn = true;
    const tick = () => {
      if (!w.__ideFramesOn) return;
      samples.push({
        t: Math.round(performance.now() - t0),
        path: location.pathname,
        monaco: Boolean(document.querySelector('.monaco-editor')),
        host: Boolean(document.querySelector('[data-testid="editor-host"]')),
        skeleton: Boolean(document.querySelector('[data-testid="editor-host"] .skeleton')),
        loading: Boolean(document.querySelector('[data-testid="route-loading"]')),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

interface Frame {
  t: number;
  path: string;
  monaco: boolean;
  host: boolean;
  skeleton: boolean;
  loading: boolean;
}

async function readFrames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const w = window as any;
    w.__ideFramesOn = false;
    return w.__ideFrames;
  });
}

/** The return visit both of the next two tests measure. Leaves the frames read. */
async function returnToTheWorkspace(page: Page): Promise<Frame[]> {
  await skipCoachMarks(page);
  await signIn(page);
  // The first visit is what warms the chunk; the second is the one measured.
  await intoWorkspace(page);
  await page.getByTestId('nav-home').click();
  await expect(page.getByRole('heading', { name: 'Welcome, Isolated.', exact: true })).toBeVisible({ timeout: UI_READY });
  await page.waitForTimeout(500);

  // Client-side back into the room, as a learner comes back: a full page load
  // would start a new JS session and throw away the warm chunk this measures.
  // The palette's phase door opens the IDE in one step (there is no
  // case file in front of it), so that press is the one measured.
  await page.getByTestId('jump-to').click();
  await page.getByTestId('palette-input').fill('Implementation');
  const door = page.getByRole('group', { name: 'Phases', exact: true }).getByRole('option', { name: /Implementation/ });
  await expect(door).toBeVisible();
  await watchFrames(page);
  await door.click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${fixture.phaseId}$`), { timeout: UI_READY });
  await waitForEditor(page, 30_000);
  await page.waitForTimeout(400);
  return readFrames(page);
}

/** The phase as the API has it, read with the learner's own token. */
async function fileOnServer(page: Page, phaseId: string, path: string): Promise<string> {
  return page.evaluate(
    async ({ api, id, want }) => {
      const res = await fetch(`${api}/api/v1/phases/${id}`, {
        headers: { authorization: `Bearer ${localStorage.getItem('lsdlc_token')}` },
      });
      const detail = await res.json();
      return (detail.files ?? []).find((f: { path: string }) => f.path === want)?.content ?? '';
    },
    { api: API, id: phaseId, want: path },
  );
}

/**
 * Every value the status bar's save word takes, from now until it is read.
 *
 * A MutationObserver rather than a sample: the word goes 'Unsaved' the instant
 * the model changes and 'Saved' about 700 ms later, so which of them a single
 * read sees is a statement about how busy the machine is.
 */
async function watchSaveState(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    const seen: string[] = [];
    w.__saveWords = seen;
    const read = () => {
      const el = document.querySelector('[data-testid="save-state"]');
      const word = (el?.textContent ?? '').trim();
      if (word && seen[seen.length - 1] !== word) seen.push(word);
    };
    w.__saveObserver?.disconnect();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    w.__saveObserver = observer;
    read();
  });
}

async function readSaveState(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__saveWords ?? []);
}

/** Writes into the open editor the way a keystroke does, without waiting. */
async function typeInto(page: Page, basename: string, content: string): Promise<void> {
  await page.waitForFunction(
    (name) =>
      Boolean(
        (window as any).monaco?.editor
          ?.getModels()
          .some((m: any) => m.uri.toString().endsWith(name)),
      ),
    basename,
    { timeout: UI_READY },
  );
  await page.evaluate(
    ({ name, value }) => {
      const monaco = (window as any).monaco;
      const model = monaco.editor.getModels().find((m: any) => m.uri.toString().endsWith(name));
      // An edit, not setValue: the editor treats a flush as a refresh of the saved
      // copy and ignores it (CodeEditor.tsx), so typing has to arrive as an edit.
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    },
    { name: basename, value: content },
  );
}

/* ---------------------- 1 · the room is there on arrival ------------------- */

test('opening the workspace never shows an empty document', async ({ page }) => {
  await skipCoachMarks(page);
  await register(page);

  // The isolated Implementation case file's Go to the workspace is a
  // client-side entry to the IDE (the doors are measured elsewhere).
  await page.goto(`/workspace/${fixture.phaseId}/brief`);
  await expect(page.getByTestId('go-to-workspace')).toBeVisible();
  await watchDocument(page);
  await page.getByTestId('go-to-workspace').click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${fixture.phaseId}$`), { timeout: UI_READY });
  await waitForEditor(page, 30_000);
  await page.waitForTimeout(500);
  const seen = await readDocument(page);

  expect(seen.length, 'the document was sampled').toBeGreaterThan(0);
  const empty = seen.filter((s) => s.main === 0);
  expect(empty.length, 'no commit left the document empty').toBe(0);
  const inside = seen.filter((s) => IDE_PATH.test(s.path));
  expect(inside.length, 'the workspace was sampled').toBeGreaterThan(0);
  expect(
    inside.filter((s) => !s.title).length,
    'the phase was named in every frame of the workspace',
  ).toBe(0);
});

/* ------------------- 2 · a return visit opens on the editor ---------------- */

test('coming back to the workspace draws the editor straight away', async ({ page }) => {
  const frames = await returnToTheWorkspace(page);

  const arrived = frames.find((f) => IDE_PATH.test(f.path));
  const drawn = frames.find((f) => IDE_PATH.test(f.path) && f.monaco);
  expect(arrived, 'the workspace was reached').toBeTruthy();
  expect(drawn, 'the editor was drawn').toBeTruthy();

  // The claim, stated as a fact about what was on screen rather than as a
  // deadline: the code column is part of the room's frame, so it is in the
  // document from the first commit and the editor is drawn inside a column
  // that is already there, never over an empty one. A machine under load
  // makes this test slower; it cannot make it red, which is the difference
  // between a functional assertion and a budget. The door from Home crosses
  // the (app) loading boundary, so a frame can show the shell's loading card under the new address before
  // the room commits: it is not the room's frame, so it is counted apart and
  // reported, never against the code column.
  const inside = frames.filter((f) => IDE_PATH.test(f.path) && !f.loading);
  expect(
    inside.filter((f) => !f.host).length,
    'the code column was in every frame of the workspace',
  ).toBe(0);

  // Both numbers are worth having in the report and worth nothing as a pass or
  // a fail on a shared runner; the case below is where the first is enforced.
  const waited = drawn!.t - arrived!.t;
  const placeholder = inside.filter((f) => f.skeleton).length;
  test.info().annotations.push({
    type: 'budget',
    description: `the editor was drawn ${waited}ms after the URL changed, with a placeholder in ${placeholder} of ${inside.length} frames, the shell's loading card in ${frames.filter((f) => IDE_PATH.test(f.path) && f.loading).length} frames`,
  });
});

/* ------------ 2b · the same measurement, as a budget rather than a test ----- */

/**
 * Advisory, and skipped unless it is asked for: `PW_BUDGET=1 npx playwright
 * test -g @budget`.
 *
 * It asserts a 300 ms deadline reached after a fixed 400 ms wait, which is a
 * statement about the machine as much as about the code. Inside the functional
 * suite, on a shared runner with one retry, it can turn a green build red for
 * reasons unconnected to the change, so it lives here, where a slow laptop
 * costs a number in a report rather than a failed build.
 */
test(
  'the editor is drawn within 300ms of the URL changing',
  { tag: '@budget' },
  async ({ page }) => {
    test.skip(!process.env.PW_BUDGET, 'advisory; set PW_BUDGET=1 to enforce the budget');

    const frames = await returnToTheWorkspace(page);
    const arrived = frames.find((f) => IDE_PATH.test(f.path))!;
    const drawn = frames.find((f) => IDE_PATH.test(f.path) && f.monaco)!;
    const waited = drawn.t - arrived.t;

    expect(waited, `the editor took ${waited}ms after the URL changed`).toBeLessThanOrEqual(300);
  },
);

/* --------------------- 3 · leaving mid-keystroke still saves --------------- */

test('leaving the workspace saves what was just typed', async ({ page }) => {
  await skipCoachMarks(page);
  await signIn(page);
  await intoWorkspace(page);
  const phaseId = new URL(page.url()).pathname.split('/').pop() as string;

  const original = await page.evaluate(path => (window as any).monaco.editor.getModels().find((model: any) => model.uri.toString().endsWith(path)).getValue(), STORY);
  const written = `${original}\n# Written at ${Date.now()} and left behind immediately.\n`;
  // Every value the status bar takes from here on, recorded as it happens.
  // Sampling it once after a fixed wait races the 700 ms debounce: on a
  // loaded machine the save has already landed by the time the sample is
  // taken, and the test fails for having watched too late rather than for
  // anything the product did.
  await watchSaveState(page);
  await typeInto(page, STORY, written);
  // Straight out of the room, with no wait at all in between: waiting 100 ms
  // and then reading the word once is a coin toss against a 700 ms debounce on
  // a machine that is doing anything else.
  await page.getByTestId('nav-home').click();

  // The recording keeps every value the word took, so the edit having been
  // unsaved cannot be missed by having looked at the wrong moment.
  await expect
    .poll(() => readSaveState(page), {
      timeout: 10_000,
      message: 'the edit was never marked unsaved',
    })
    .toContain('Unsaved');

  await expect(page.getByRole('heading', { name: 'Welcome, Isolated.', exact: true })).toBeVisible({ timeout: UI_READY });

  await expect
    .poll(() => fileOnServer(page, phaseId, STORY), { timeout: 15_000 })
    .toContain('left behind immediately');
});

/* ------------------ 4 · the room is the one that was left ----------------- */

test('coming back to a phase reopens the file and the thread', async ({ page }) => {
  await skipCoachMarks(page);
  await signIn(page);
  await intoWorkspace(page);

  // A file the phase does not open on, so finding it open again means it was
  // remembered rather than seeded.
  // The file tree is the left column's Files tab in every code room, Implementation included; the tab lives in
  // that column, so a room that opened with the column hidden (focused mode) shows it first.
  const showBrief = page.getByRole('button', { name: 'Show brief', exact: true });
  if (await showBrief.isVisible().catch(() => false)) await showBrief.click();
  await page.getByRole('navigation', { name: 'Phase context' }).getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByTestId(`explorer-file-${PROVIDED.replace(/[/.]/g, '-')}`).click();
  await expect(page.getByTestId(tabId(PROVIDED))).toHaveAttribute('aria-selected', 'true');

  // A caret somewhere other than the top of the file, which is where an editor
  // that was rebuilt from nothing would put it.
  // The room keeps more than one editor instance, so the one holding the
  // opened file is the one the caret is put in.
  await page.evaluate((path) => {
    const editors = (window as any).monaco.editor.getEditors();
    const editor = editors.find((e: any) => e.getModel()?.uri.toString().endsWith(path)) ?? editors[0];
    editor.focus();
    editor.setPosition({ lineNumber: 6, column: 1 });
  }, PROVIDED);
  await expect(page.getByTestId('status-bar')).toContainText('Ln 6');

  // One question to the reviewer, which is a conversation from here on.
  const showMentor = page.getByRole('button', { name: 'Show mentor', exact: true });
  if (await showMentor.count()) await showMentor.click();
  await page.getByTestId('chat-input').fill('Which supplied API request should I trace before implementing the repository?');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('msg-assistant').first()).toBeVisible({ timeout: SANDBOX_RUN });
  const asked = await page.getByTestId('msg-user').count();
  const answered = await page.getByTestId('msg-assistant').count();

  await page.getByTestId('nav-home').click();
  await expect(page.getByRole('heading', { name: 'Welcome, Isolated.', exact: true })).toBeVisible({ timeout: UI_READY });
  await toTheEditor(page);

  // The same tab, still the one being read, still at the same line: the editor
  // mounts fresh and is put back where it was, so the status bar would read
  // "Ln 1" if nothing had been remembered.
  await expect(page.getByTestId(tabId(PROVIDED))).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('status-bar')).toContainText('Ln 6');
  // And the thread, without a request having gone out for it: the reviewer's
  // tab is where it is drawn.
  const revealMentor = page.getByRole('button', { name: 'Show mentor', exact: true });
  if (await revealMentor.count()) await revealMentor.click();
  await expect(page.getByTestId('msg-user')).toHaveCount(asked);
  await expect(page.getByTestId('msg-assistant')).toHaveCount(answered);
});
