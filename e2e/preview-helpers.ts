import { expect, type Page } from '@playwright/test';
import { LEARNER_PASSWORD, dismissPhaseTutorial, signInAs, skipCoachMarks, waitForEditor, continueMyProject } from './pw-fixtures';
import { reachImplementationByApi } from './passing-work';
import { NAVIGATION, UI_READY } from './support/timeouts';

/**
 * Getting a learner to a phase that has an application to run.
 *
 * The preview only exists on implementation, testing and maintenance, and the
 * gate is real: there is no back door into phase 3 and there should not be
 * one. So this is the golden path walked twice, once for the preview beat and
 * once for the unsupported one, kept here rather than copied, and out of a
 * `*.spec.ts` so Playwright does not collect it as a suite of its own.
 */


export async function setEditor(page: Page, basename: string, content: string): Promise<void> {
  await page.waitForFunction(
    (name) =>
      Boolean(
        (window as any).monaco?.editor?.getModels().some((m: any) => m.uri.toString().endsWith(name)),
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
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 15_000 });
}

/**
 * Open a file, from the tab strip if it is already there and from the Explorer
 * if it is not, and open its folder first, because a folder holding no
 * editable file starts closed.
 */
export async function openFile(page: Page, filePath: string): Promise<void> {
  const slug = filePath.replace(/[/.]/g, '-');
  // The room draws its file strip once the editor is up; read it after that.
  await waitForEditor(page, 60_000);
  const tab = page.getByTestId(`file-tab-${slug}`);
  if ((await tab.count()) === 0) {
    const row = page.getByTestId(`explorer-file-${slug}`);
    // The explorer is the left column's Files tab in every code room,
    // Implementation included: open the column first if it is hidden.
    if (!(await page.getByTestId('explorer').isVisible().catch(() => false))) {
      const show = page.getByRole('button', { name: 'Show brief', exact: true });
      if (await show.isVisible().catch(() => false)) await show.click();
      await page.locator('nav[aria-label="Phase context"]').getByRole('button', { name: 'Files', exact: true }).click();
    }
    if ((await row.count()) === 0) await openFolderOf(page, filePath);
    await row.click();
  } else {
    await tab.click();
  }
  await expect(page.getByTestId(`file-tab-${slug}`)).toBeVisible({ timeout: 15_000 });
}

/**
 * Click whichever folder rows stand between the explorer's root and a file.
 * The tree folds single-child chains into one row, so the deepest visible
 * folder row is the one to press, and pressing it may reveal another.
 */
export async function openFolderOf(page: Page, filePath: string): Promise<void> {
  const parts = filePath.split('/').slice(0, -1);
  for (let depth = parts.length; depth > 0; depth--) {
    const folder = parts.slice(0, depth).join('/').replace(/[/.]/g, '-');
    const row = page.getByTestId(`explorer-folder-${folder}`);
    if ((await row.count()) > 0) {
      if ((await row.getAttribute('aria-expanded')) === 'false') await row.click();
      // Opening one folder can reveal the next one down, so try again from the
      // bottom rather than assuming the whole chain is now on screen.
      if (depth < parts.length) return openFolderOf(page, filePath);
      return;
    }
  }
}

export async function writeFile(page: Page, filePath: string, content: string): Promise<void> {
  await openFile(page, filePath);
  await setEditor(page, filePath, content);
}

/**
 * Register a learner, pass requirements and design with complete written work,
 * and leave them in the implementation workspace, the first phase with an
 * application to run.
 *
 * The two written phases are submitted through the API rather than typed into
 * the rooms: Requirements and Design are form-based rooms, walked by their
 * own specs, and what is under test here starts at phase 3. It is not a back
 * door, each phase is saved, submitted, assessed (by the suite's AI stub,
 * e2e/ai-stub.cjs), reflected on and advanced exactly as the rooms do it.
 */
export async function reachImplementation(page: Page, who: string, view: ImplementationView = 'Split'): Promise<void> {
  const email = `${who}-${Date.now()}@preview.test`;
  await reachImplementationByApi(page.request, { email, password: LEARNER_PASSWORD, name: 'Pia Preview' });
  await skipCoachMarks(page);
  await dismissPhaseTutorial(page);
  await signInAs(page, email);
  await page.waitForURL('**/dashboard', { timeout: NAVIGATION });
  await continueMyProject(page);
  await expect(page.getByTestId('phase-title')).toHaveText('Implementation', { timeout: NAVIGATION });
  // Implementation opens its room, the IDE itself, in one step.
  await enterPhase(page);
  await expect(page.getByTestId('phase-title')).toHaveText('Implementation', { timeout: NAVIGATION });
  await expect(page.getByTestId('workspace-page')).toBeVisible({ timeout: NAVIGATION });
  // The room opens on Code below 1600 px and on Split from
  // 1600 px, so a spec that needs the preview on screen asks for its view.
  await chooseImplementationView(page, view);
}

/** The implementation room's view buttons: Code, Split, and the preview's own (App preview or Page preview). */
export type ImplementationView = 'Code' | 'Split' | 'App preview' | 'Page preview';

/**
 * Press one of the implementation room's view buttons and wait until it is the
 * pressed one. The room opens on Split only from 1600 px, on Code below.
 */
export async function chooseImplementationView(page: Page, view: ImplementationView): Promise<void> {
  const button = page.locator('nav[aria-label="Implementation working area"]').getByRole('button', { name: view, exact: true });
  await button.waitFor({ state: 'visible', timeout: NAVIGATION });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/**
 * The implementation IDE keeps its bottom panel (Console, Problems, Health,
 * Review, Commit…) shut until it is asked for; the console bar under the
 * editor opens it. A no-op when it is already open or the phase has no bar.
 */
export async function openConsole(page: Page): Promise<void> {
  const button = page.locator('footer.implementation-console-bar').getByRole('button', { name: 'Console', exact: true });
  // The bar is drawn with the IDE, a beat after the page frame: wait for it
  // rather than count it at once (an early count can say "no bar" and leave
  // the panel shut on a slow first load).
  await button.waitFor({ state: 'visible', timeout: UI_READY }).catch(() => undefined);
  if ((await button.count()) === 0) return;
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
}

/**
 * The verdict of the Submit just pressed, on screen in the IDE.
 *
 * The verdict is drawn only once the review has come back (FeedbackPanel draws
 * its pending steps until then), so attached means landed. Landed is not in
 * view everywhere: Submit selects the Review tab, but where the column is too
 * short for the editor and the results both, the code view keeps the results
 * as their tab bar alone (useResultsSplit), and the verdict's own band makes
 * the column shorter still. The way to the review is then the band's "View
 * review" (PhaseGateBanner's ViewReview), which the band draws exactly while
 * the review is not the results view's selected tab. So it is pressed where
 * it is drawn and not waited for where it is not, and neither answer depends
 * on how tall the runner's window happens to leave the column.
 *
 * On a second Submit the last verdict is still drawn for the moment before
 * the new revision is recorded, so the last wait is given the whole budget as
 * well: the review it may be waiting through is the one just asked for.
 */
export async function verdictOnScreen(page: Page, timeout: number): Promise<void> {
  const verdict = page.getByTestId('feedback-verdict');
  await expect(verdict).toBeAttached({ timeout });
  const door = page.getByTestId('gate-view-review');
  // apps/web/components/workspace/PhaseGateBanner.tsx REVIEW_TAB_SHOWN.
  const inView = page.locator('[data-focus-show="results"] [data-testid="tab-feedback"][aria-selected="true"]');
  await expect(door.or(inView).first()).toBeVisible({ timeout: UI_READY });
  if (await door.isVisible()) await door.click();
  await expect(verdict).toBeVisible({ timeout });
}

/**
 * The door opens the phase's room in one step: no case file in front
 * of it, nothing to press.
 */
export async function enterPhase(page: Page): Promise<void> {
  await page.waitForURL((url) => /^\/workspace\//.test(url.pathname) && !/\/brief(\?|$)/.test(url.pathname), { timeout: UI_READY });
}
