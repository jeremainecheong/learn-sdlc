import { expect, test, type Route } from '@playwright/test';
import {
  SOLUTION_OVERDUE,
  SOLUTION_REPOSITORY,
  SOLUTION_ROUTES,
  SOLUTION_USE_TASKS,
} from './fixtures';
import { reachImplementation, writeFile } from './preview-helpers';
import { foldStripDetails, pressStripDoor, stripDoor } from './pw-fixtures';
import { NAVIGATION, SANDBOX_RUN, UI_READY } from './support/timeouts';

/**
 * Run app: the learner starts their own application and looks at it.
 *
 * Everything here is one learner on phase 3, because that is the first phase
 * with an application to run and the gate in front of it is real. The beats
 * are in the order a learner meets them, and two of them are the whole point
 * of the feature:
 *
 *  - the frame serves *their* code. It is proved by starting the scaffold,
 *    seeing the empty app the scaffold produces, writing the four gaps and
 *    starting again, the same button, a different application;
 *  - a broken API is their bug, said in their words, with the front end still
 *    on screen. An app that half works is the normal state of an application
 *    being written, and the panel has to be honest about which half.
 */

const STOPPED_BY_LEARNER = 'You stopped the app.';

/** A promise resolved from outside, for a route handler the test lets go. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// In order, one worker, not serial: each test makes its own learner and its
// own app, so one that stops (a host that cannot run learner code) does not
// hide the others.
test.describe.configure({ mode: 'default' });

test('a learner runs their own app, sees their own code in it, and stops it', async ({ page }) => {
  test.setTimeout(900_000);

  await reachImplementation(page, 'run-app');

  /* ------------------------- the tab, before anything ---------------------- */

  // The pane and the button are drawn from the phase alone, with no request of
  // their own: a pack that declares an application has both the moment the
  // workspace lands. There is no preview tab: the preview is the
  // centre column's own pane, beside the code in the Split view that
  // reachImplementation chooses (the room opens on Code below 1600 px).
  await expect(page.getByTestId('preview-pane')).toBeVisible();
  await expect(page.getByTestId('preview-idle')).toBeVisible();
  await stripDoor(page, 'header-run-app'); // visible, under the strip's Details
  await foldStripDetails(page);
  await expect(page.getByTestId('preview-pane')).toContainText('Run app builds your front end');
  // Under every state, on every deployment.
  await expect(page.getByTestId('preview-not-marked')).toHaveText(
    'The preview is for you. It is not marked.',
  );

  /* ----------------------------- the first start --------------------------- */

  await pressStripDoor(page, 'header-run-app');
  // The pane the learner is looking at shows what they started.
  await expect(page.getByTestId('preview-pane')).toBeVisible();
  await expect(page.getByTestId('preview-starting')).toContainText('Starting your app.');

  await expect(page.getByTestId('preview-frame')).toBeVisible({ timeout: SANDBOX_RUN });
  const app = page.frameLocator('[data-testid="preview-frame"]');
  await expect(app.getByRole('heading', { name: 'Your lists' })).toBeVisible({ timeout: NAVIGATION });
  // Their own seed data, through their own API, over the door.
  await expect(app.getByText('Home', { exact: true })).toBeVisible({ timeout: UI_READY });

  // And the scaffold's own holes, named in the learner's own file at the
  // learner's own line, the app is real from the first press, and what is
  // missing from it is what they have not written yet.
  await app.getByText('Home', { exact: true }).click();
  await expect(
    app.getByRole('heading', { name: 'useTasks is not implemented yet' }),
  ).toBeVisible({ timeout: UI_READY });

  await expect(page.getByTestId('preview-status')).toContainText('Running since');
  await expect(page.getByTestId('preview-status')).toContainText(
    'Stops after ten minutes, or five minutes with nothing happening.',
  );

  /* --------------------------- what the app printed ------------------------ */

  await page.getByTestId('preview-console-toggle').click();
  const console_ = page.getByTestId('console-pane');
  await expect(console_).toBeVisible();
  await expect(console_).not.toContainText('Your app has printed nothing yet.');
  // The seed and the server, in the order the app printed them.
  await expect(console_).toContainText('seed:');
  // The runner strips its own workspace root out of every line before it
  // stores one, so nothing here names a directory on this machine.
  await expect(console_).not.toContainText('/var/folders');
  await expect(console_).not.toContainText('lsdlc-');

  /* --------------- what the pane makes of what the app printed ------------- */

  /**
   * Flask writes its whole startup banner and every access log line to
   * stderr, in colour. Coloured by stream, a working app would read as four
   * failures in red with a red "4" on the tab; with the escapes left in,
   * "\x1b[31mWARNING" would reach the learner as "[31mWARNING".
   */
  const printed = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-testid="console-pane"] span[data-stream]'),
    ).map((el) => ({
      stream: el.getAttribute('data-stream'),
      severity: el.getAttribute('data-severity'),
      text: el.textContent ?? '',
    })),
  );
  expect(printed.length, 'the app printed something').toBeGreaterThan(0);
  expect(printed.filter((l) => /\x1B|\[0m|\[31m/.test(l.text)), 'terminal colour').toEqual([]);
  const banner = printed.find((l) => l.text.includes('This is a development server'));
  expect(banner?.stream, "Flask's banner goes to stderr").toBe('err');
  expect(banner?.severity, "and a warning is not a failure").toBe('warn');
  const access = printed.find((l) => /"[A-Z]+ [^"]*"\s+2\d\d\b/.test(l.text));
  expect(access?.severity, 'a 200 in an access log is not a failure').toBe('info');
  // The tab's badge counts the lines a learner should look at, not the
  // stderr lines, of which a working app writes plenty.
  const problems = printed.filter((l) => l.severity === 'error').length;
  const onStderr = printed.filter((l) => l.stream === 'err').length;
  expect(onStderr, 'the app wrote more to stderr than it had problems').toBeGreaterThan(problems);
  expect((await page.getByTestId('preview-console-toggle').textContent())?.trim()).toBe(
    problems === 0 ? 'Console' : `Console${problems}`,
  );

  /* ------------------------------ the controls ----------------------------- */

  // Tab order through the pane's controls: they come before the frame, so a
  // keyboard reaches them without walking through somebody's application.
  // There is no tab to start from, so the walk starts on Refresh.
  await page.getByTestId('preview-refresh').focus();
  const order: string[] = ['preview-refresh'];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    order.push(
      (await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.getAttribute('data-testid'),
      )) ?? '',
    );
  }
  // The four controls, in order, before anything of the learner's own
  // application.
  expect(order.filter(Boolean).slice(0, 4)).toEqual([
    'preview-refresh',
    'preview-open',
    'preview-stop',
    'preview-console-toggle',
  ]);
  // And the frame really is after them in the document, which is what puts it
  // after them in the tab order. (Chrome does not stop on the iframe element
  // itself when the document inside has nothing focusable, which is why this
  // is asserted rather than tabbed to.)
  expect(
    await page.evaluate(() => {
      const stop = document.querySelector('[data-testid="preview-console-toggle"]');
      const frame = document.querySelector('[data-testid="preview-frame"]');
      if (!stop || !frame) return 'missing';
      return stop.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING
        ? 'frame after the controls'
        : 'frame before the controls';
    }),
  ).toBe('frame after the controls');

  // Refresh reloads the document rather than asking for a URL the browser
  // already has.
  const before = await page.getByTestId('preview-frame').getAttribute('src');
  await page.getByTestId('preview-refresh').click();
  await expect(page.getByTestId('preview-frame')).not.toHaveAttribute('src', before ?? '');
  await expect(app.getByRole('heading', { name: 'Your lists' })).toBeVisible({ timeout: NAVIGATION });

  // Open in a new tab points at the same door, and hands the app nothing.
  const open = page.getByTestId('preview-open');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await open.getAttribute('href')).toContain('/api/v1/preview/');

  /* ------------------- the beat: it serves the learner's code -------------- */

  // No pane to switch to: at 1280 the preview and the editor both fit, so the
  // file strip is right there beside the frame. (Below 1280 the switcher is
  // what puts the code back on screen, the layout test walks that.)
  await writeFile(page, 'api/repository/tasks.py', SOLUTION_REPOSITORY);
  await writeFile(page, 'api/routes/tasks.py', SOLUTION_ROUTES);
  await writeFile(page, 'web/src/lib/overdue.ts', SOLUTION_OVERDUE);
  await writeFile(page, 'web/src/hooks/useTasks.ts', SOLUTION_USE_TASKS);

  const firstDoor = await page.getByTestId('preview-frame').getAttribute('src');
  await pressStripDoor(page, 'header-run-app');
  // A second start is a second application behind a second capability, and
  // the frame the last one was in is still on screen while it boots.
  await expect
    .poll(
      async () => {
        const frame = page.getByTestId('preview-frame');
        const src = (await frame.count()) > 0 ? await frame.getAttribute('src') : null;
        return src && src !== firstDoor ? 'a new app' : 'the old one';
      },
      { timeout: 180_000 },
    )
    .toBe('a new app');
  await expect(page.getByTestId('preview-frame')).toBeVisible({ timeout: SANDBOX_RUN });
  const written = page.frameLocator('[data-testid="preview-frame"]');
  await expect(written.getByText('Home', { exact: true })).toBeVisible({ timeout: NAVIGATION });
  // The same button and the same click, a different application: the page
  // that named an unwritten function a moment ago is the learner's own list.
  await written.getByText('Home', { exact: true }).click();
  await expect(written.getByText('Renew the passport')).toBeVisible({ timeout: UI_READY });
  await expect(
    written.getByRole('heading', { name: 'useTasks is not implemented yet' }),
  ).toHaveCount(0);

  /* ------------- the press is answered before the API answers -------------- */

  /**
   * The pane must not wait for the API's own `status` before it says
   * anything, or it sits on "The app is not running" for about a second and
   * a half after the press. Held here on purpose: the start is
   * held back until the pane has said its sentence, so the sentence cannot
   * have come from the answer.
   *
   * Held until released, not for a fixed four seconds. `page.unroute` lets an
   * in-flight request go the moment it is called, so a handler that sleeps
   * and then continues is continuing a request that has already gone. That
   * error lands after the test on a fast machine and inside it on a slow
   * one, where the stop beat takes longer than the sleep.
   */
  await page.getByTestId('preview-stop').click();
  await expect(page.getByTestId('preview-stopped')).toBeVisible({ timeout: UI_READY });
  const held = deferred();
  const release = deferred();
  const continued = deferred();
  const hold = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    held.resolve();
    await release.promise;
    await route.continue();
    continued.resolve();
  };
  await page.route('**/api/v1/phases/*/preview', hold);
  await pressStripDoor(page, 'header-run-app');
  await expect(page.getByTestId('preview-starting')).toContainText('Starting your app.', {
    timeout: 1_500,
  });
  await held.promise;
  release.resolve();
  await continued.promise;
  await page.unroute('**/api/v1/phases/*/preview', hold);
  await expect(page.getByTestId('preview-frame')).toBeVisible({ timeout: 180_000 });

  /* --------------------------------- Stop ---------------------------------- */

  await page.getByTestId('preview-stop').click();
  const stopped = page.getByTestId('preview-stopped');
  await expect(stopped).toBeVisible({ timeout: UI_READY });
  await expect(stopped).toHaveAttribute('data-reason', 'learner');
  await expect(stopped).toContainText(STOPPED_BY_LEARNER);
  await expect(page.getByTestId('preview-frame')).toHaveCount(0);
});

test('an API that does not start is the learner\'s bug, and the front end still renders', async ({
  page,
}) => {
  test.setTimeout(900_000);
  await reachImplementation(page, 'run-app-broken');

  // A syntax error in one of the phase's own editable API files. `api/main.py`
  // is locked, and rightly, the fault a learner actually meets is in the file
  // they are writing, and it stops the import chain the runner starts just the
  // same. Nothing on the front end is touched, so the bundle still builds.
  await writeFile(page, 'api/routes/tasks.py', 'def broken(\n');

  await pressStripDoor(page, 'header-run-app');
  const failed = page.getByTestId('preview-failed');
  await expect(failed).toBeVisible({ timeout: SANDBOX_RUN });
  await expect(failed).toContainText('Your API');

  // Their traceback, in their own file, with nothing of this machine in it.
  await page.getByTestId('preview-console-toggle').click();
  const console_ = page.getByTestId('console-pane');
  await expect(console_).toContainText('tasks.py');
  await expect(console_).not.toContainText('/var/folders');
});
