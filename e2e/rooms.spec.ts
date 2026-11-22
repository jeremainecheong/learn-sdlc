import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN } from './passing-work';
import { dismissPhaseTutorial, signInAs, stripDoor } from './pw-fixtures';
import { API, testEmail } from './support/env';
import { UI_READY } from './support/timeouts';

/**
 * The rooms a learner spends the project in, read the way somebody who does
 * not use a mouse reads them.
 *
 * Three claims, one per section:
 *
 * 1. every working room has exactly one `h1`, and the IDE's survives a
 *    switch of its right column rather than living inside a tab and leaving
 *    with it.
 * 2. the way out of the IDE is named at 1280 and 1366, and the kill
 *    matrix and the incident drill each carry one at 390.
 * 3. below `lg` the files button reveals the explorer, and an edited
 *    file is marked as being worked on rather than as failing.
 *
 * The phases past Requirements are opened with an admin's `reopen` override
 * rather than by grading six phases: what is under test here is the chrome of
 * each room, and journey.spec.ts already proves a learner can earn their way
 * into all six.
 */


const OVERRIDE_REASON =
  'Opened for the accessibility walk of the rooms this phase draws, so the chrome can be read at every width.';

interface Phase {
  id: string;
  order: number;
  key: string;
  title: string;
}

interface Learner {
  name: string;
  email: string;
  password: string;
  token: string;
  userId: string;
  phases: Phase[];
}

/** One learner for the whole file, enrolled and with phases 2, 4 and 5 open. */
let learner: Learner | null = null;

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/auth/login`, { data: ADMIN });
  expect(res.ok(), 'the seeded admin signs in').toBeTruthy();
  return (await res.json()).token as string;
}

/**
 * Registers, enrols, and has an admin reopen Design, Testing and Deployment so
 * the design board, the kill matrix and the drill can be opened. `reopen` from
 * `locked` is the early unlock (instructor.service.ts, overridePhase), which is
 * the cheapest honest way into a room whose door is a gate.
 */
async function ensureLearner(request: APIRequestContext): Promise<Learner> {
  if (learner) return learner;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const who = {
    name: 'Robin Rooms',
    email: testEmail(`e2e-rooms-${stamp}`),
    password: 'Correct-Horse-9',
  };
  const auth = await request.post(`${API}/auth/register`, {
    data: { email: who.email, password: who.password, displayName: who.name },
  });
  expect(auth.ok(), 'the learner registers').toBeTruthy();
  const body = await auth.json();
  const token = body.token as string;
  const userId = body.user.id as string;
  const headers = { authorization: `Bearer ${token}` };
  // Setup is a page of its own; this learner has done it.
  const setup = await request.patch(`${API}/account/profile`, {
    headers,
    data: { displayName: who.name, onboardingCompleted: true },
  });
  expect(setup.ok(), 'the learner finishes setup').toBeTruthy();

  const enrolled = await request.post(`${API}/enrollments`, {
    headers,
    data: { projectSlug: 'tasktrackr' },
  });
  expect(enrolled.ok(), 'the learner enrols').toBeTruthy();
  const phases = (await enrolled.json()).phases as Phase[];

  const staff = { authorization: `Bearer ${await adminToken(request)}` };
  for (const order of [2, 4, 5]) {
    const phase = phases.find((p) => p.order === order)!;
    const opened = await request.post(
      `${API}/instructor/learners/${userId}/phases/${phase.id}/override`,
      { headers: staff, data: { action: 'reopen', reason: OVERRIDE_REASON } },
    );
    expect(opened.ok(), `phase ${order} opens`).toBeTruthy();
  }

  learner = { ...who, token, userId, phases };
  return learner;
}

const phaseOf = (l: Learner, order: number): Phase => l.phases.find((p) => p.order === order)!;

/**
 * Signs in through the page, so the browser holds the same session the app
 * writes itself. The tour is switched off unless a test is about the tour.
 */
async function signIn(
  page: Page,
  who: Learner,
  opts: { tour?: boolean; sidebar?: 'full' | 'rail' } = {},
): Promise<void> {
  const { tour = false, sidebar } = opts;
  // The per-phase tutorials are tours too, and off unless a test is about them.
  if (!tour) await dismissPhaseTutorial(page);
  await page.addInitScript(
    ({ seen, width }) => {
      try {
        if (seen) window.localStorage.setItem('lsdlc_coach', 'done');
        if (width) window.localStorage.setItem('lsdlc_sidebar', width);
      } catch {
        // a browser without storage gets the defaults; no assertion minds
      }
    },
    { seen: !tour, width: sidebar ?? '' },
  );
  await page.goto('/login');
  await signInAs(page, who.email, who.password);
  await page.waitForURL('**/dashboard', { timeout: UI_READY });
}

/** How many `h1` elements the page is drawing, and what they say. */
async function headings(page: Page): Promise<string[]> {
  return page.locator('h1').evaluateAll((nodes) =>
    nodes.map((n) => (n.textContent || '').trim()),
  );
}

// Not serial: the six tests share one learner and nothing else, so a failure in
// one has to leave the other five to say their own piece, which is the whole
// point of the red run that proves each item's test needs its fix.

/* -------------------------------------------------------------------------- */
/* 1 · one heading per room                                                   */
/* -------------------------------------------------------------------------- */

test('every working room names itself once, and the IDE keeps its name when the right column changes', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  await signIn(page, who);

  /* ------------------------- the Requirements room ------------------------ */
  // The issue and the Requirements IDE are one room (interview and
  // backlog on one page), so it is that room that names itself.
  const requirements = phaseOf(who, 1);
  await page.goto(`/workspace/${requirements.id}/interview`);
  await expect(page.getByTestId('requirements-workspace')).toBeVisible({ timeout: UI_READY });
  expect(await headings(page), 'the Requirements room names itself').toEqual([requirements.title]);

  /* -------------------------------- the IDE -------------------------------- */
  // An IDE room: Testing, which the admin opened. The right column has no
  // tabs; its columns are the brief and mentor panels, shown and hidden from
  // the strip. Neither may take the heading.
  const testing = phaseOf(who, 4);
  await page.goto(`/workspace/${testing.id}`);
  await expect(page.getByTestId('editor-host')).toBeVisible({ timeout: UI_READY });
  expect(await headings(page), 'the IDE names itself').toEqual([testing.title]);
  const panels = page.getByRole('group', { name: 'Workspace panels' });
  for (const toggle of ['Show brief', 'Hide mentor', 'Hide brief', 'Show mentor']) {
    await panels.getByRole('button', { name: toggle, exact: true }).click();
    expect(await headings(page), `the IDE after ${toggle}`).toEqual([testing.title]);
  }

  // The strip of modes down the left says what you are looking
  // at, and only that; Jump to is the top bar's.
  await expect(page.getByTestId('activity-files')).toHaveCount(1);
  await expect(page.getByTestId('activity-problems')).toHaveCount(1);
  await expect(page.getByTestId('activity-mentor')).toHaveCount(1);
  await expect(page.getByTestId('activity-search')).toHaveCount(0);
  await expect(page.getByTestId('activity-criteria')).toHaveCount(0);
  await expect(page.getByTestId('jump-to')).toBeVisible();

  /* ---------------------------- the design room ---------------------------- */
  const design = phaseOf(who, 2);
  await page.goto(`/workspace/${design.id}/design`);
  await expect(page.getByTestId('design-page')).toBeVisible({ timeout: UI_READY });
  expect(await headings(page), 'the design room names itself').toEqual([design.title]);
  // and names its parts by its tabs: TaskTrackr 4.0.0 has both contracts and the sequence diagram on
  await expect(page.getByRole('navigation', { name: 'Design working area' }).getByRole('button')).toHaveText([
    'UML model',
    'API contract',
    'Screens',
    'Sequence diagram',
    'Decisions',
    'Review',
  ]);
  // (The architect's column is the shared mentor panel, which names its
  // persona without a board heading of its own, so there is no "Architect"
  // h2 to find.)

  /* -------------------------- the completion record ------------------------ */
  // The record only draws for a finished project, and finishing one costs six
  // graded submissions (journey.spec.ts does exactly that). What is under test
  // here is the document's heading, which does not depend on how the enrolment
  // reached `completed`, so the enrolment the API really returns is marked
  // complete on its way to the page and everything else stays real.
  // The record draws only once every phase has a verified Pass in the
  // learner's review history (completion/page.tsx reads reviews as well as the
  // enrolment), which a stubbed enrolment cannot supply; journey.spec.ts earns
  // a real one. Before that, the page still names itself once.
  await page.goto('/complete');
  await expect(page.getByRole('main')).toContainText('The completion record becomes available after every phase has a Pass.', { timeout: UI_READY });
  await expect(page.locator('h1'), 'the record names itself once').toHaveCount(1);
});

/* -------------------------------------------------------------------------- */
/* 2 · the way out of the IDE                                                 */
/* -------------------------------------------------------------------------- */

test('the way out of the IDE is named at 1280 and 1366, and the matrix and the drill carry one at 390', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  await signIn(page, who);

  // Requirements has no IDE; Testing's is the room walked here. The
  // way out sits in the header's More menu, so that is opened first.
  const testingIde = phaseOf(who, 4);
  for (const width of [1280, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/workspace/${testingIde.id}`);
    await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: UI_READY });
    // The door sits in the header's More menu; stripDoor opens the menu when
    // the door is not on screen.
    const out = await stripDoor(page, 'open-document');
    await expect(out, `the way out at ${width}`).toBeVisible();
    const text = (await out.innerText()).trim();
    expect(text.length, `the way out is named at ${width}, not a bare glyph`).toBeGreaterThan(2);
  }

  /* -------------------------- the two document rooms ----------------------- */
  await page.setViewportSize({ width: 390, height: 844 });

  const testing = phaseOf(who, 4);
  await page.goto(`/workspace/${testing.id}/matrix`);
  await expect(page.getByTestId('matrix-page')).toBeVisible({ timeout: UI_READY });
  await expect(page.getByTestId('matrix-title')).toBeVisible({ timeout: UI_READY });
  // On the planted bugs page the way back is read inside the strip's Details (the row's Write tests is the same door).
  await expect(await stripDoor(page, 'back-workspace')).toHaveAttribute(
    'href',
    `/workspace/${testing.id}`,
  );

  const deployment = phaseOf(who, 5);
  await page.goto(`/workspace/${deployment.id}/drill`);
  await expect(page.getByTestId('drill-title')).toBeVisible({ timeout: UI_READY });
  // The drill page draws no "Back to the workspace" of its own; the frame's working-area row is the way back at
  // every width (its Pipeline opens the workspace, which takes the view's name out of the address).
  await expect(page.getByTestId('back-workspace')).toHaveCount(0);
  const back = page.getByTestId('deployment-area-nav').getByRole('link', { name: 'Pipeline' });
  await expect(back).toBeVisible();
  await back.click();
  await page.waitForURL(`**/workspace/${deployment.id}`, { timeout: UI_READY });
});

/* -------------------------------------------------------------------------- */
/* 3 · the explorer below lg                                                  */
/* -------------------------------------------------------------------------- */

test('below lg the files button reveals the explorer, and an edited file is not marked as failing', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const who = await ensureLearner(request);
  await signIn(page, who);

  await page.setViewportSize({ width: 390, height: 844 });
  // Requirements has no IDE; Testing's, which the admin opened, is
  // the room walked here, with the suite file the learner writes.
  const testingIde = phaseOf(who, 4);
  await page.goto(`/workspace/${testingIde.id}`);
  await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: UI_READY });

  // Type into the file the phase opens on, so the tree has something to mark.
  // The model is found by name the way journey.spec.ts finds it: the editor's
  // own model is the one whose change the workspace hears.
  // On a phone the room opens on the code pane, and the switcher only draws
  // when there is another column to switch to.
  if (await page.getByTestId('pane-code').isVisible().catch(() => false)) await page.getByTestId('pane-code').click();
  await page.waitForFunction(
    (name) =>
      Boolean(
        (window as any).monaco?.editor
          ?.getModels()
          .some((m: any) => m.uri.toString().endsWith(name)),
      ),
    'test_acceptance.py',
    { timeout: UI_READY },
  );
  await page.evaluate((name) => {
    const monaco = (window as any).monaco;
    const model = monaco.editor.getModels().find((m: any) => m.uri.toString().endsWith(name));
    // An edit, not setValue: the editor treats a flush as a refresh of the saved
    // copy and ignores it (CodeEditor.tsx), so typing has to arrive as an edit.
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: `${model.getValue()}\n\n# the tree should say this file is being worked on\n` }], () => null);
  }, 'test_acceptance.py');
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 20_000 });

  // The explorer is not in the row at this width, so the files button has to
  // reveal it rather than set the pane it is already on. The files button is
  // the brief column's own "Files" (the activity strip is not drawn at this
  // width): Show brief, then Files.
  await expect(page.getByTestId('explorer')).toBeHidden();
  await page.getByRole('group', { name: 'Workspace panels' }).getByRole('button', { name: 'Show brief', exact: true }).click();
  await page.locator('nav[aria-label="Phase context"]').getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByTestId('explorer')).toBeVisible();

  const marker = page
    .getByTestId('explorer')
    .getByRole('img', { name: 'Changed, not submitted' })
    .first();
  await expect(marker).toBeVisible({ timeout: UI_READY });
  await expect(marker, 'an edited file is being worked on, not failing').toHaveAttribute(
    'data-state',
    'now',
  );
});
