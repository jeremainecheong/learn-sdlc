import * as fs from 'fs';
import * as path from 'path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { dismissPhaseTutorial, signInAs, waitForEditor, continueMyProject } from './pw-fixtures';
import { PASSING_DESIGN, PASSING_REQUIREMENTS, enrolByApi, passPhaseByApi, registerByApi } from './passing-work';
import { testEmail } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * What a keystroke costs, and what landing on the app costs.
 *
 * Four measurements, all of them about work the learner never asked for: a
 * markdown engine downloaded by pages that render no markdown, a re-render of
 * the whole IDE for every character typed at the reviewer, a memo chain that
 * hands its consumers a new identity on every commit, and a Home page that
 * fetches the journal nobody has opened.
 *
 * The render assertions are made against React's own fiber tree rather than
 * against the clock. A component that renders builds fresh props objects for
 * the DOM elements it draws; a component that bails out leaves the ones it had.
 * So the probe below walks the *current* tree from the fiber root, remembers
 * `memoizedProps` per element, and after an action says exactly which parts of
 * the page committed again. There is no timing in it, so a loaded machine
 * cannot turn it red, as a timing assertion can.
 */


const LEARNER = {
  name: 'Ren Cost',
  email: testEmail(`e2e-render-${Date.now()}`),
  password: 'Correct-Horse-9',
};

/** A reply with real markdown in it, so a re-parse is a re-parse of something. */
const REPLY = [
  '### Where to look',
  '',
  'Two things decide this:',
  '',
  '1. what `AC-2` says about a task due **today**',
  '2. whether the boundary is `<` or `<=` in `api/repository/tasks.py, line 103`',
  '',
  '| Case | Expected |',
  '| --- | --- |',
  '| due yesterday | in the report |',
  '| due today | out of it |',
  '',
  'Write the criterion first, then the test.',
].join('\n');

// Not serial: each test signs in for itself, and a failure in one, the bundle
// assertion especially, which touches no browser, must not skip the rest.

/* --------------------------------- seeding -------------------------------- */

/**
 * A learner with three phases open, seeded through the API.
 *
 * Home's prefetch is per unlocked phase, so a learner with one open phase
 * cannot show the difference between prefetching the journal and prefetching
 * the phase they are on. Requirements and Design are graded against the rubric
 * rather than in the sandbox, so two passes are cheap; the third phase opens
 * behind them.
 */
async function seed(request: APIRequestContext): Promise<void> {
  // Registered with setup done, enrolled, and the two written phases passed
  // with complete, marked work (e2e/passing-work.ts; assessed by the stub).
  const learner = await registerByApi(request, LEARNER);
  let phases = await enrolByApi(request, learner);
  phases = await passPhaseByApi(request, learner, phases, 1, PASSING_REQUIREMENTS, 'Phase 1 taught me to write the criterion before the code.');
  await passPhaseByApi(request, learner, phases, 2, PASSING_DESIGN, 'Phase 2 taught me to write the criterion before the code.');
}

async function signIn(page: Page): Promise<void> {
  await dismissPhaseTutorial(page);
  await page.goto('/login');
  await signInAs(page, LEARNER.email, LEARNER.password);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
}

/** The phase the learner is on, as a workspace URL. */
async function workspaceUrl(page: Page, tab: 'brief' | 'mentor'): Promise<string> {
  await continueMyProject(page);
  // Implementation opens its room, the IDE, in one step.
  await page.waitForURL(/\/workspace\//, { timeout: UI_READY });
  await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]+$/, { timeout: UI_READY });
  return `${page.url()}?tab=${tab}`;
}

/* ---------------------------- the fiber probe ----------------------------- */

/**
 * Installs `__renders` in the page: a snapshot of every DOM element's props
 * object, taken from React's current fiber tree, and a diff against the last
 * snapshot. An element whose props object is a different object rendered
 * again; an element that kept its object was left alone.
 */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;

    const rootFiber = (): any => {
      for (const host of [document as any, document.body as any, document.documentElement as any]) {
        const key = Object.keys(host).find((k) => k.startsWith('__reactContainer$'));
        if (key) return host[key];
      }
      return null;
    };

    /** Every fiber in the tree React has actually committed. */
    const walk = (): any[] => {
      const container = rootFiber();
      if (!container) throw new Error('no React container on the document');
      const current = container.stateNode?.current ?? container;
      const out: any[] = [];
      const stack = [current];
      while (stack.length) {
        const fiber = stack.pop();
        out.push(fiber);
        if (fiber.sibling && fiber !== current) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      return out;
    };

    const snap = () => {
      const byEl = new Map<Element, unknown>();
      const memos: { deps: unknown[]; value: unknown }[] = [];
      for (const fiber of walk()) {
        const node = fiber.stateNode;
        if (node && node.nodeType === 1) byEl.set(node as Element, fiber.memoizedProps);
        let hook = fiber.memoizedState;
        let guard = 0;
        while (hook && typeof hook === 'object' && guard++ < 400) {
          const held = hook.memoizedState;
          if (Array.isArray(held) && held.length === 2 && Array.isArray(held[1])) {
            memos.push({ deps: held[1] as unknown[], value: held[0] });
          }
          hook = hook.next;
        }
      }
      return { byEl, memos };
    };

    w.__renders = {
      take: () => {
        w.__renders.last = snap();
        return w.__renders.last.byEl.size;
      },
      /**
       * Which elements committed again since the last snapshot, named by the
       * nearest testid above them, and how many of those sit outside `inside`.
       */
      since: (inside: string) => {
        const before = w.__renders.last;
        const now = snap();
        w.__renders.last = now;
        const host = inside ? document.querySelector(inside) : null;
        const changed: { region: string; outside: boolean }[] = [];
        now.byEl.forEach((props: unknown, el: Element) => {
          if (!before.byEl.has(el) || before.byEl.get(el) === props) return;
          const named = el.closest('[data-testid]');
          changed.push({
            region: named ? String(named.getAttribute('data-testid')) : el.tagName.toLowerCase(),
            outside: !host || !host.contains(el),
          });
        });
        return {
          total: changed.length,
          outside: changed.filter((c) => c.outside).map((c) => c.region),
          inside: changed.filter((c) => !c.outside).length,
          elements: now.byEl.size,
        };
      },
      /**
       * Did the element at each of these selectors commit again since the last
       * snapshot, and how many elements committed in all? The total is what
       * stops a "nothing was rebuilt" assertion passing because nothing
       * happened at all.
       */
      changed: (selectors: string[]) => {
        const before = w.__renders.last;
        const now = snap();
        w.__renders.last = now;
        let total = 0;
        now.byEl.forEach((props: unknown, el: Element) => {
          if (before.byEl.has(el) && before.byEl.get(el) !== props) total += 1;
        });
        const each: Record<string, boolean> = {};
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`nothing at ${selector}`);
          if (!now.byEl.has(el)) throw new Error(`no fiber for ${selector}`);
          each[selector] = before.byEl.get(el) !== now.byEl.get(el);
        }
        return { total, each };
      },
      /**
       * The identity of the workspace's memo chain, found by following the
       * dependencies rather than by name (the build is minified): the file
       * text is a dependency of `spans`, `spans` is the third dependency of
       * `allSpans`, and `allSpans` is the second dependency of `problems`.
       */
      chain: (text: string) => {
        const { memos } = snap();
        const spans = memos.find((m) => m.deps.length === 3 && m.deps[1] === text);
        if (!spans) throw new Error('no memo depends on the open file text');
        const all = memos.find((m) => m.deps.length === 3 && m.deps[2] === spans.value);
        if (!all) throw new Error('no memo depends on the spans');
        const problems = memos.find((m) => m.deps.length === 3 && m.deps[1] === all.value);
        if (!problems) throw new Error('no memo depends on allSpans');
        const seen = (w.__renders.ids ||= new WeakMap());
        let next = (w.__renders.nextId ||= 1);
        const id = (v: unknown) => {
          if (typeof v !== 'object' || v === null) return String(v);
          if (!seen.has(v)) {
            seen.set(v, next);
            w.__renders.nextId = next += 1;
          }
          return `#${seen.get(v)}`;
        };
        return { spans: id(spans.value), allSpans: id(all.value), problems: id(problems.value) };
      },
    };
  });
}

const take = (page: Page) => page.evaluate(() => (window as any).__renders.take());
const since = (page: Page, inside: string) =>
  page.evaluate(
    (sel) => (window as any).__renders.since(sel),
    inside,
  ) as Promise<{ total: number; outside: string[]; inside: number; elements: number }>;
const changed = (page: Page, selectors: string[]) =>
  page.evaluate((sel) => (window as any).__renders.changed(sel), selectors) as Promise<{
    total: number;
    each: Record<string, boolean>;
  }>;
const chain = (page: Page, text: string) =>
  page.evaluate((t) => (window as any).__renders.chain(t), text) as Promise<{
    spans: string;
    allSpans: string;
    problems: string;
  }>;

test.beforeAll(async ({ request }) => {
  test.setTimeout(600_000);
  await seed(request);
});

/* ------------------- 1 · the markdown engine on every page ---------------- */

test('the shell every signed-in page loads carries no markdown engine', async () => {
  const root = path.join(__dirname, '..', 'apps', 'web');
  // Next 16's build writes no app-build-manifest.json. The client JS a route
  // loads is named in its client reference manifest instead
  // (.next/server/app/<route>/page_client-reference-manifest.js): every client
  // module the route (its layouts included) renders, with the chunk files it
  // needs. Their union is what the browser downloads for the page.
  const routeChunks = (route: string): string[] | null => {
    const file = path.join(root, '.next', 'server', 'app', route, 'page_client-reference-manifest.js');
    if (!fs.existsSync(file)) return null;
    const holder = { __RSC_MANIFEST: {} as Record<string, { clientModules: Record<string, { chunks?: string[] }> }> };
    new Function('globalThis', fs.readFileSync(file, 'utf8'))(holder);
    const entry = Object.values(holder.__RSC_MANIFEST)[0];
    const files = new Set<string>();
    for (const mod of Object.values(entry?.clientModules ?? {})) {
      for (const chunk of mod.chunks ?? []) if (chunk.endsWith('.js')) files.add(chunk);
    }
    return [...files];
  };
  const shell = routeChunks('(app)/account');
  expect(shell, 'the account route has a client reference manifest — this asserts on a production build, so build the web app first').toBeTruthy();

  // String literals micromark and remark-gfm keep through minification. If a
  // chunk holds either, that chunk holds the markdown engine.
  const MARKERS = ['gfmFootnoteDefinition', 'micromarkExtensions'];
  // Chunk names are URL-encoded in the manifest ([phaseId] is %5BphaseId%5D);
  // a chunk that is not on disk is a failure, never a silent "no markdown".
  const carriesMarkdown = (chunk: string): boolean => {
    const file = path.join(root, '.next', decodeURIComponent(chunk));
    expect(fs.existsSync(file), `${chunk} is on disk`).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    return MARKERS.some((m) => text.includes(m));
  };

  // The layout is every signed-in page's floor, and three of the pages it
  // carries render no markdown at all; each page's manifest includes the
  // layout's own client modules.
  for (const route of ['(app)/account', '(app)/admin', '(app)/join']) {
    const chunks = routeChunks(route);
    if (!chunks) continue;
    const guilty = chunks.filter(carriesMarkdown);
    expect(guilty, `/${route} downloads the markdown engine in ${guilty.join(', ')}`).toEqual([]);
  }

  // And it is still shipped where it is used, so this cannot pass by deleting it.
  const workspace = routeChunks('(app)/workspace/[phaseId]');
  expect(workspace, 'the workspace route is in the build').toBeTruthy();
  expect(workspace!.filter(carriesMarkdown).length, 'the workspace downloads the markdown engine').toBeGreaterThan(0);
});

/* ------------- 2 · typing at the reviewer costs the composer only --------- */

test('typing in the mentor composer re-renders nothing outside it', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const url = await workspaceUrl(page, 'mentor');

  // A canned reply, so the feed holds real markdown and no model is involved.
  await page.route('**/assistant/chat', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        reply: {
          id: `stub-${Date.now()}`,
          role: 'assistant',
          content: REPLY,
          createdAt: new Date().toISOString(),
          meta: { provider: 'local-mentor' },
        },
        usage: { todayTokens: 120 },
      }),
    }),
  );

  await page.goto(url);
  await waitForEditor(page, 60_000);
  await page.getByTestId('chat-input').fill('What should the report do with a task due today?');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('msg-assistant').first()).toBeVisible({ timeout: UI_READY });
  await expect(page.locator('[data-testid="mentor-chat"] .prose-docs').first()).toBeVisible();

  await installProbe(page);
  await page.getByTestId('chat-input').click();
  await take(page);
  await page.keyboard.type('a');
  await page.waitForTimeout(400);
  const one = await since(page, '[data-testid="mentor-composer"]');
  console.log(
    `one keystroke in the composer: ${one.total} of ${one.elements} elements committed, ` +
      `${one.inside} inside the composer, ${one.outside.length} outside ` +
      `(${[...new Set(one.outside)].slice(0, 12).join(', ')})`,
  );
  expect(
    [...new Set(one.outside)],
    'a character typed at the reviewer redrew these parts of the page',
  ).toEqual([]);

  // Five more, to be sure the first was not simply the cheap one.
  await take(page);
  await page.keyboard.type('bcdef');
  await page.waitForTimeout(400);
  const five = await since(page, '[data-testid="mentor-composer"]');
  console.log(`five keystrokes: ${five.total} committed, ${five.outside.length} outside`);
  expect([...new Set(five.outside)], 'five characters redrew these').toEqual([]);
});

/* --------- 2b · typing code costs the editor and its readouts only -------- */

/**
 * The composer's twin.
 *
 * The assertion above holds for the reviewer's box; this one holds the editor
 * beside it. If the open file's text is page state and the save state a
 * dependency of the tree, one character commits hundreds of elements outside
 * the editor, the file tree, the phase brief, the grading guide, the phase
 * strip, the bottom panel and the composer, all rebuilt.
 *
 * What may still commit: the editor itself, the caret readouts in the status
 * bar, and the frame the page draws around them. What may not: any column
 * that has nothing to do with the character just typed.
 */
test('typing in the IDE editor re-renders nothing but the editor and its readouts', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  const url = await workspaceUrl(page, 'brief');
  await page.goto(url);
  await waitForEditor(page, 60_000);
  // The room settles: the phase, its records and the reviewer's thread all
  // land after the first paint, and a commit of theirs is not a keystroke's.
  await page.waitForTimeout(3_000);

  await installProbe(page);
  await page.evaluate(() => {
    const editor = (window as any).monaco.editor.getEditors()[0];
    editor.focus();
    editor.setPosition({ lineNumber: 1, column: 1 });
  });
  await page.waitForTimeout(400);

  // The first character a file ever gets is the one that puts a changed dot
  // beside it in the explorer, so the tree is rebuilt once, that is the dot
  // appearing, not a keystroke's cost. Spend it before the meter goes on.
  await page.keyboard.type('x');
  await page.waitForTimeout(400);

  await take(page);
  await page.keyboard.type('y');
  await page.waitForTimeout(400);
  const one = await since(page, '[data-testid="editor-host"]');
  const regions = [...new Set(one.outside)];
  console.log(
    `one character in the editor: ${one.total} of ${one.elements} elements committed, ` +
      `${one.inside} inside the editor, ${one.outside.length} outside (${regions.slice(0, 12).join(', ')})`,
  );

  // Without this an editor that never took the keystroke would pass by doing
  // nothing at all.
  expect(one.total, 'typing committed nothing, so nothing is proven').toBeGreaterThan(0);

  // The columns the character has nothing to do with.
  const forbidden = regions.filter(
    (r) =>
      r.startsWith('explorer') ||
      ['grading-guide', 'task-panel', 'phase-brief', 'phase-panel-brief', 'workspace-map', 'mentor-composer', 'mentor-chat', 'phase-strip'].includes(r),
  );
  expect(forbidden, 'a character typed in the editor redrew these columns').toEqual([]);

  // And the total, so a rename of a testid cannot quietly restore the cost.
  // The budget allows for the page frame, the status bar's caret readouts,
  // the activity bar and the file tabs (71 elements on the maintenance room
  // at 1440). What this case measures is the room the seeded learner is on,
  // Implementation's IDE, at the default 1280x720 viewport, over the 400 ms
  // after one keystroke. Timed with React's own commit hook: one commit,
  // 6-16 ms after the key, re-commits 231-232 elements outside the editor
  // (workspace-page 141, then the activity bar, the status bar, the file tabs,
  // the preview and mentor panels), the same count whether or not that key
  // also turns save-state to "Unsaved"; nothing commits from +40 to +400 ms or
  // while idle; the autosave's two commits ("Saving…", "Saved") land at
  // +708 ms, outside the window. So the cost is the keystroke's own commit,
  // not the autosave or the save state. Red until the product stops that
  // commit reaching outside the editor.
  expect(one.outside.length, 'elements outside the editor redrawn by one character').toBeLessThan(
    120,
  );

  // Five more, so the first was not simply the cheap one, and the autosave's
  // catch-up (700 ms after the last keystroke) is not counted as typing.
  await take(page);
  await page.keyboard.type('zzzzz');
  await page.waitForTimeout(400);
  const five = await since(page, '[data-testid="editor-host"]');
  console.log(`five more characters: ${five.total} committed, ${five.outside.length} outside`);
  expect(
    [...new Set(five.outside)].filter(
      (r) =>
        r.startsWith('explorer') ||
        ['grading-guide', 'task-panel', 'phase-brief', 'phase-panel-brief', 'mentor-composer', 'phase-strip'].includes(r),
    ),
    'five characters redrew these columns',
  ).toEqual([]);
});

/* ---------------- 3 · the brief is not redrawn while coding --------------- */

test('the brief is not redrawn while the learner types code', async ({ page }) => {
  // The IDE's "The brief" section (phase-brief): the phase's brief as plain
  // text, PlainText's paragraphs, in the aside's "Phase requirements and
  // review" block, which is closed by default. On TaskTrackr's reference
  // Implementation the block sits after the five-task panel. The brief column
  // itself is shut by default below 1440 px, so it is shown first.
  test.setTimeout(180_000);
  await signIn(page);
  const url = await workspaceUrl(page, 'brief');
  await page.goto(url);
  await waitForEditor(page, 60_000);
  const show = page.getByRole('group', { name: 'Workspace panels' }).getByRole('button', { name: 'Show brief', exact: true });
  if (await show.count()) await show.click();
  const block = page.locator('details.phase-contract-detail').filter({ has: page.getByTestId('phase-brief') });
  await expect(block).toHaveCount(1, { timeout: UI_READY });
  if (!(await block.evaluate((el) => (el as HTMLDetailsElement).open))) await block.locator(':scope > summary').click();
  const brief = page.locator('[data-testid="phase-brief"] .plain-text');
  await expect(brief).toBeVisible({ timeout: UI_READY });
  // Plain text: paragraphs and nothing a markdown engine draws.
  expect(await brief.locator('p').count(), 'the brief is drawn as paragraphs').toBeGreaterThan(0);
  await expect(page.locator('[data-testid="phase-brief"] .prose-docs')).toHaveCount(0);

  await installProbe(page);
  // Monaco's own textarea is a 1px offscreen element, so it is focused through
  // the editor rather than clicked.
  await page.evaluate(() => {
    const editor = (window as any).monaco.editor.getEditors()[0];
    editor.focus();
    editor.setPosition({ lineNumber: 1, column: 1 });
  });
  await take(page);
  await page.keyboard.type('# a line the learner typed\n');
  await page.waitForTimeout(600);
  const brief_ = '[data-testid="phase-brief"] .plain-text';
  const seen = await changed(page, [brief_]);
  console.log(`typing a line of code: ${seen.total} elements committed`);
  // Without this, an editor that never took the keystrokes would pass the
  // assertion below by not rendering anything at all.
  expect(seen.total, 'typing code committed nothing, so nothing is proven').toBeGreaterThan(0);
  expect(
    seen.each[brief_],
    'the brief was redrawn while the learner typed code',
  ).toBe(false);
});

/* ------------------ 4 · the memo chain holds across a commit -------------- */

test('moving the caret does not rebuild the spans, the map or the problems', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const url = await workspaceUrl(page, 'brief');
  await page.goto(url);
  await waitForEditor(page, 60_000);
  await installProbe(page);

  const text = await page.evaluate(
    () => (window as any).monaco.editor.getEditors()[0].getValue() as string,
  );
  const before = await chain(page, text);

  // A caret move is a commit that changes neither the file nor the verdict.
  await page.evaluate(() => {
    (window as any).monaco.editor.getEditors()[0].setPosition({ lineNumber: 3, column: 1 });
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    (window as any).monaco.editor.getEditors()[0].setPosition({ lineNumber: 5, column: 2 });
  });
  await page.waitForTimeout(400);

  const after = await chain(page, text);
  console.log(`memo chain before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  expect(after, 'the caret moved and the derivations were all rebuilt').toEqual(before);
});

/* --------------- 5 · landing on the app does not fetch the journal -------- */

test('landing on Home does not prefetch the journal', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  // Signing in lands on Home too, and Home's idle-time work runs up to 1.5s
  // after that. Let it finish before the meter goes on, or the reload below is
  // measured together with the tail of the visit before it.
  await page.waitForTimeout(3_000);

  const calls: { url: string; bytes: number }[] = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/v1/')) return;
    let bytes = Number(res.headers()['content-length'] ?? 0);
    if (!bytes) {
      try {
        bytes = (await res.body()).length;
      } catch {
        bytes = 0;
      }
    }
    calls.push({ url, bytes });
  });

  await page.goto('/dashboard');
  await expect(page.getByTestId('dashboard-project')).toBeVisible({ timeout: UI_READY });
  // The prefetch waits for idle time with a 1.5s ceiling; give it three.
  await page.waitForTimeout(3_000);

  const total = calls.reduce((n, c) => n + c.bytes, 0);
  const submissions = calls.filter((c) => /\/phases\/[^/]+\/submissions$/.test(c.url));
  const threads = calls.filter((c) => /\/assistant\/history\//.test(c.url));
  const bytesOf = (rows: { bytes: number }[]) => rows.reduce((n, r) => n + r.bytes, 0);
  console.log(
    `landing on Home: ${calls.length} requests, ${(total / 1024).toFixed(1)} KB — ` +
      `${submissions.length} submission lists (${(bytesOf(submissions) / 1024).toFixed(1)} KB), ` +
      `${threads.length} mentor threads (${(bytesOf(threads) / 1024).toFixed(1)} KB)`,
  );
  for (const c of calls) console.log(`  ${c.bytes} ${c.url.split('/api/v1')[1]}`);

  // Three phases are open. The journal's records are three requests a phase,
  // and Home has no business fetching more than the one the learner is on.
  expect(submissions.length, 'submission lists fetched by Home').toBeLessThanOrEqual(1);
  expect(threads.length, 'mentor threads fetched by Home').toBeLessThanOrEqual(1);

  // The weight target: under 60 KB per learner. The submission lists are the
  // heavy part, about 51 KB a phase, mostly report blobs nobody opens, so
  // Home fetches only the current phase's.
  expect(total / 1024, 'KB the landing costs one learner').toBeLessThan(60);

  // The request count is recorded rather than asserted: "fewer than eight" is
  // not reachable from the client. The floor for a learner three phases in is
  // auth/me + projects + one enrolment per catalogue project + analytics/me +
  // one /phases/:id per open phase, eight before anything else, and the
  // shell adds four of its own: the bell's count, the address-verification
  // banner, the warm-up row and the reflection record. Getting under eight
  // needs a summary endpoint, which is not a client change.
  test.info().annotations.push({
    type: 'budget',
    description: `landing on Home: ${calls.length} requests, ${(total / 1024).toFixed(1)} KB`,
  });

  // There is no journal timeline to walk to: /journal is the progress page
  // and components/journal/Timeline.tsx is mounted by no page, so the
  // landing's weight is what is measured here.
});

/* -------------- 6 · a failed question keeps what the learner typed -------- */

test('a mentor question that fails keeps the text and leaves no orphan bubble', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const url = await workspaceUrl(page, 'mentor');
  await page.route('**/assistant/chat', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'the mentor is unavailable' }),
    }),
  );
  await page.goto(url);
  await waitForEditor(page, 60_000);

  const asked = 'Does a task due today belong in the overdue report?';
  await page.getByTestId('chat-input').fill(asked);
  const before = await page.getByTestId('msg-user').count();
  await page.getByTestId('chat-send').click();

  // The failure is said once, under the box, and only then is the rest true,
  // so this assertion comes first: the composer was cleared on send, so a
  // value check before the failure has landed would pass without proving it.
  await expect(page.getByTestId('chat-error')).toBeVisible({ timeout: UI_READY });
  // The composer keeps the question, so the learner can send it again.
  await expect(page.getByTestId('chat-input')).toHaveValue(asked);
  // And the thread is not left holding a question with no answer.
  await expect(page.getByTestId('msg-user')).toHaveCount(before);
});
