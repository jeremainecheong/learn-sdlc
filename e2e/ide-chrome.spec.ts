import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { dismissPhaseTutorial, signInAs } from './pw-fixtures';
import { reachImplementationByApi } from './passing-work';
import { API, testEmail } from './support/env';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * The IDE's chrome, two tabs on one account, rooms with the server away, the
 * palette, and what a page costs to draw.
 *
 * The cases are grouped by the room a learner meets them in.
 */

const LEARNER = {
  name: 'Ida Chrome',
  email: testEmail(`e2e-ide-chrome-${Date.now()}`),
  password: 'Correct-Horse-9',
};

let phaseIds: { order: number; id: string }[] = [];
let token = '';

// In order, one worker, not serial: the cases share only the learner the
// beforeAll makes, and each must say its own piece.
test.describe.configure({ mode: 'default' });

/**
 * A learner three phases in, through the API: the implementation room is where
 * the tab strip, the status bar and the two-tab save all live, and it needs
 * real files behind it.
 */
test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
  // Registered with setup done, enrolled, and the two written phases passed
  // with complete, marked work (e2e/passing-work.ts).
  const reached = await reachImplementationByApi(request, LEARNER);
  token = reached.learner.token;
  phaseIds = reached.phases.map((p) => ({ order: p.order, id: p.id }));
});

async function signIn(page: Page): Promise<void> {
  await dismissPhaseTutorial(page);
  await page.goto('/login');
  await signInAs(page, LEARNER.email, LEARNER.password);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
}

const workspace = () => `/workspace/${phaseIds.find((p) => p.order === 3)!.id}`;

/* -------------------------------------------------------------------------- */
/*  The IDE's own chrome                                                       */
/* -------------------------------------------------------------------------- */

test('the editor chrome is in the product\'s voice and nothing is cut mid-word', async ({ page }) => {
  await signIn(page);
  await page.goto(workspace());
  // The link to the room's document sits under the strip's Details; its
  // presence says the room has loaded.
  await expect(page.getByTestId('open-document')).toBeAttached({ timeout: NAVIGATION });

  // Labels are in sentence case, never upper-cased or letter-spaced, and that
  // holds for the explorer's three block heads too.
  const heads = await page
    .locator('.block-head')
    .evaluateAll((els) =>
      els.map((e) => ({
        text: (e.textContent ?? '').trim(),
        transform: getComputedStyle(e).textTransform,
        spacing: getComputedStyle(e).letterSpacing,
      })),
    );
  expect(heads.length, 'the explorer draws its block heads').toBeGreaterThan(0);
  for (const head of heads) {
    expect(head.transform, `${head.text} is not upper-cased`).toBe('none');
    expect(['normal', '0px'], `${head.text} is not letter-spaced`).toContain(head.spacing);
  }

  // The room's heading is drawn, not only spoken, and nothing
  // above it in the type ramp.
  const h1 = page.locator('h1');
  await expect(h1, 'one heading names the room').toHaveCount(1);
  const ramp = await page.evaluate(() => {
    const head = document.querySelector('h1');
    const size = (el: Element | null) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0);
    const rect = head?.getBoundingClientRect();
    // Words only: the sidebar's logo mark is an empty span sized for its glyph.
    const bigger = [...document.querySelectorAll('h2, h3, p, span')].filter(
      (el) => size(el) > size(head) && (el as HTMLElement).offsetParent !== null && (el.textContent ?? '').trim() !== '',
    ).length;
    return { size: size(head), width: rect?.width ?? 0, bigger };
  });
  expect(ramp.width, 'the heading is on the screen, not only in the DOM').toBeGreaterThan(40);
  // The strip draws the room's name at 18px (shell-fidelity.css,
  // .phase-strip-identity h1); what this protects is that nothing in the
  // room is drawn larger than it.
  expect(ramp.size, 'the heading is at the top of the ramp').toBeGreaterThanOrEqual(18);
  expect(ramp.bigger, 'nothing in the room is drawn larger than the heading').toBe(0);

  // (The IDE has no right rail or reviewer tab; the reviewer is a panel shown
  // from the strip.)
});

test('two files with one basename are told apart, and the tab strip says it scrolls', async ({
  page,
}) => {
  await signIn(page);
  await page.goto(workspace());
  // The link to the room's document sits under the strip's Details; its
  // presence says the room has loaded.
  await expect(page.getByTestId('open-document')).toBeAttached({ timeout: NAVIGATION });

  // This pack holds api/repository/tasks.py and api/routes/tasks.py, so the
  // strip must not draw two tabs both reading "tasks.py".
  const strip = page.locator('[role="tablist"][aria-label="Files"]');
  const labels = await strip
    .locator('[role="tab"]')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
  expect(labels.length, 'the strip opens on the phase files').toBeGreaterThan(1);
  const repeated = labels.filter((l, i) => labels.indexOf(l) !== i);
  expect(repeated, 'no two tabs wear the same label').toEqual([]);

  // And where it does run out of width, the edge that has more behind it fades
  // rather than cutting a word against a hard border.
  const fade = await strip.evaluate((el) => ({
    scrolls: el.scrollWidth > el.clientWidth + 2,
    mask: getComputedStyle(el).maskImage || (getComputedStyle(el) as any).webkitMaskImage,
  }));
  if (fade.scrolls) expect(fade.mask, 'a scrolling strip fades at its edge').not.toBe('none');
});

/* -------------------------------------------------------------------------- */
/*  The editor does not take the first Tab of a workspace room                  */
/* -------------------------------------------------------------------------- */

test('the code editor does not swallow the first Tab of the room', async ({ page }) => {
  await signIn(page);
  await page.goto(workspace());
  // The link to the room's document sits under the strip's Details; its
  // presence says the room has loaded.
  await expect(page.getByTestId('open-document')).toBeAttached({ timeout: NAVIGATION });
  // Monaco is what moves the browser's focus starting point, so wait until it
  // is genuinely up rather than until the room has drawn.
  await page.waitForFunction(() => Boolean((window as any).monaco), null, { timeout: NAVIGATION });
  await page.waitForTimeout(1_000);

  // One Tab from a fresh room reaches the skip link, as it does on every other
  // route, not the editor's hidden textarea, Tab inside an editor inserts a
  // tab, so a keyboard user there cannot get back out to the file strip, the
  // run button or the sidebar without a mouse.
  await page.keyboard.press('Tab');
  await expect(page.locator('a', { hasText: 'Skip to main content' })).toBeFocused();
  await page.keyboard.press('Enter');
  const landed = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el?.closest('main')?.id ?? el?.tagName ?? 'nothing';
  });
  expect(landed, 'Enter on the skip link reaches the room').toBe('main');
});

/* -------------------------------------------------------------------------- */
/*  Two tabs on one account                                                    */
/* -------------------------------------------------------------------------- */

test('a second tab cannot write over the first in silence', async ({ page, request }) => {
  const id = phaseIds.find((p) => p.order === 3)!.id;
  const headers = { authorization: `Bearer ${token}` };
  const path = 'api/repository/tasks.py';

  // The version this "tab" loaded.
  const before = await (await request.get(`${API}/phases/${id}`, { headers })).json();
  const base = before.workspaceUpdatedAt ?? '';
  const original = (before.files as { path: string; content: string }[]).find(
    (f) => f.path === path,
  )!.content;

  // Somebody else saves first.
  const theirs = await request.put(`${API}/phases/${id}/workspace`, {
    headers,
    data: { files: { [path]: `${original}\n# tab B was here\n` } },
  });
  expect(theirs.ok(), 'the other tab saves').toBeTruthy();

  // Our tab, quoting the version it loaded, is refused rather than obeyed.
  const mine = await request.put(`${API}/phases/${id}/workspace`, {
    headers,
    data: { files: { [path]: `${original}\n# tab A was here\n` }, baseVersion: base },
  });
  expect(mine.status(), 'the stale save is a conflict, not a write').toBe(409);
  const body = await mine.json();
  expect(JSON.stringify(body)).toContain('saved somewhere else');

  // And nothing of ours reached the file.
  const after = await (await request.get(`${API}/phases/${id}`, { headers })).json();
  const now = (after.files as { path: string; content: string }[]).find((f) => f.path === path)!
    .content;
  expect(now, "the other tab's line is what the server holds").toContain('# tab B was here');
  expect(now, 'ours was never written over it').not.toContain('# tab A was here');

  // A save that quotes nothing still lands: the keepalive write on the way out
  // has no version to quote and must never be refused.
  const onExit = await request.put(`${API}/phases/${id}/workspace`, {
    headers,
    data: { files: { [path]: original } },
  });
  expect(onExit.ok(), 'the last-gasp save still lands').toBeTruthy();

  await signIn(page);
});

/* -------------------------------------------------------------------------- */
/*  A room with the server away                                                */
/* -------------------------------------------------------------------------- */

test('the reference room says what happened and offers the one control that fixes it', async ({
  page,
}) => {
  await signIn(page);
  const id = phaseIds.find((p) => p.order === 1)!.id;

  // The room's own requests fail; the shell's identity and project calls are
  // left alone, because on a load where those fail the session gate answers
  // first (SessionGate.tsx) and the room is never reached.
  await page.route(`**/api/v1/phases/${id}**`, (route) => route.abort());
  await page.goto(`/workspace/${id}/solution`);

  const notice = page.getByTestId('room-error');
  await expect(notice).toBeVisible({ timeout: UI_READY });
  // The browser's own string is not a sentence this product says.
  await expect(notice).not.toContainText('Failed to fetch');
  await expect(notice).toContainText("Can't reach the server");
  // A room that says what went wrong and then offers only the way
  // home is a dead end.
  await expect(page.getByTestId('room-retry')).toBeVisible();
});

test('the workspace offers a way to try again, and the issue room keeps a heading on screen', async ({
  page,
}) => {
  await signIn(page);
  const id = phaseIds.find((p) => p.order === 3)!.id;
  const requirementsId = phaseIds.find((p) => p.order === 1)!.id;

  // The rooms' own requests fail; the shell's are left alone (see above).
  await page.route(`**/api/v1/phases/${id}**`, (route) => route.abort());
  await page.route(`**/api/v1/phases/${requirementsId}**`, (route) => route.abort());
  await page.goto(`/workspace/${id}`);
  await expect(page.getByTestId('workspace-error')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('room-retry'), 'the workspace can be tried again').toBeVisible();

  // /issue must draw its `h1`, not keep it in the DOM at 1x1px and clipped,
  // which leaves the page a learner is looking at with no name on it.
  await page.goto(`/workspace/${phaseIds.find((p) => p.order === 1)!.id}/issue`);
  await expect(page.getByTestId('room-error')).toBeVisible({ timeout: UI_READY });
  const heading = await page
    .locator('h1')
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(heading, 'the room names itself where it can be read').toBeGreaterThan(40);
});

/* -------------------------------------------------------------------------- */
/*  An unreachable API is never drawn as an empty result                       */
/* -------------------------------------------------------------------------- */

test('the design room never says an unloaded design is an empty one', async ({ page }) => {
  await signIn(page);
  const id = phaseIds.find((p) => p.order === 2)!.id;

  // The room's own requests fail; the shell's are left alone (see above).
  await page.route(`**/api/v1/phases/${id}**`, (route) => route.abort());
  await page.goto(`/workspace/${id}/design`);
  await expect(page.getByTestId('room-error')).toBeVisible({ timeout: UI_READY });

  const body = page.locator('main');
  await expect(body, 'no rail asserts an empty model').not.toContainText('No fields yet');
  await expect(body, 'no rail asserts an empty contract set').not.toContainText('None yet');
  await expect(body, 'no rail asserts an unwritten decision log').not.toContainText('Not written');
  await expect(
    page.getByTestId('save-state'),
    'nothing is saved in a room that never opened',
  ).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/*  The palette keeps its own promise                                          */
/* -------------------------------------------------------------------------- */

test('the palette answers for actions, ids and file names', async ({ page }) => {
  await signIn(page);
  await page.goto(workspace());
  // The link to the room's document sits under the strip's Details; its
  // presence says the room has loaded.
  await expect(page.getByTestId('open-document')).toBeAttached({ timeout: NAVIGATION });

  const open = async (query: string) => {
    await page.keyboard.press('Escape');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const box = page.getByTestId('palette-input');
    await expect(box).toBeVisible({ timeout: 10_000 });
    await box.fill(query);
    // The list is drawn from what the shell already holds; give the project
    // rows the one tick they need to arrive.
    await page.waitForTimeout(400);
    return page.getByTestId('palette-row-0');
  };

  // The palette's own footer promises actions, so "submit" must find one in
  // every room.
  await expect(await open('submit'), 'submit is an action the palette knows').toBeVisible();
  // A criterion's row draws its story, so the file it lives in, the story
  // record, is searchable outside the IDE too.
  await expect(await open('story.json'), 'the file a criterion lives in answers').toBeVisible();
  await page.keyboard.press('Escape');
});

/* -------------------------------------------------------------------------- */
/*  What it costs to draw a page                                               */
/* -------------------------------------------------------------------------- */

test('the shell asks the API once for every open phase, not once per phase', async ({ page }) => {
  await signIn(page);

  const calls: string[] = [];
  page.on('request', (r) => {
    const url = r.url();
    if (url.includes('/api/v1/')) calls.push(url);
  });
  // /journal is the progress record.
  await page.goto('/journal');
  await expect(page.getByRole('heading', { name: 'Your progress, in view.' })).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(1_500);

  const perPhaseSummaries = calls.filter((u) => /\/phases\/[^/?]+\?view=summary/.test(u)).length;
  const batched = calls.filter((u) => u.includes('/phases/summaries')).length;
  expect(batched, 'the summaries come down together').toBeGreaterThan(0);
  expect(perPhaseSummaries, 'and not one request per phase as well').toBe(0);

  const perPhaseRecords = calls.filter((u) =>
    /\/phases\/[^/?]+\/(submissions|runs)$/.test(u),
  ).length;
  expect(perPhaseRecords, 'the journal no longer walks the project three calls at a time').toBe(0);
});

/* -------------------------------------------------------------------------- */
/*  A page never leaves a prefetch in flight                                   */
/* -------------------------------------------------------------------------- */

test('no page prefetches the room it links to', async ({ page }) => {
  await signIn(page);
  const prefetches: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('_rsc=')) prefetches.push(r.url());
  });
  await page.goto('/artefacts');
  await expect(page.getByTestId('artefacts-title').or(page.locator('h1'))).toBeVisible({
    timeout: 45_000,
  });
  await page.waitForTimeout(2_000);
  const workspacePrefetches = prefetches.filter((u) => u.includes('/workspace/'));
  expect(workspacePrefetches, 'the shelves do not prefetch every room they list').toEqual([]);
});
