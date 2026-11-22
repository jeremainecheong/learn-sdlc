import { expect, Page, test } from "@playwright/test";
import { createUnlockedEditor, signInEditorFixture } from "./fixtures/unlocked-editor";
import { dismissPhaseTutorial, openRequirements } from "./pw-fixtures";
import { API_ORIGIN as API, testEmail } from "./support/env";
import { UI_READY } from "./support/timeouts";

/**
 * The two edges of the web client, either of which can end a learner's day.
 *
 * The first is a token that stops working while someone is typing. If a 401
 * ended the session and sent the browser to /login, the workspace's last save,
 * the one that catches the keystrokes the seven-tenths-of-a-second debounce
 * has not fired for yet, would run on the way out, after the token had been
 * thrown away. It would go out unsigned, be refused, and nobody would be there
 * to see it, while the error page said "nothing you wrote has been lost". The
 * same save has a second way to fail: the Fetch standard caps a `keepalive`
 * body at 64 KiB and the API takes 200,000 characters a file, so a long enough
 * file sent that way is refused by the browser before it leaves the page.
 *
 * The last is a browser that keeps nothing. Safari's private windows and a
 * locked-down lab profile refuse `localStorage.setItem`. If signing in
 * swallowed the refusal, the shell would read the token straight back, find
 * nothing, and send the learner to /login, for ever, with no message.
 */

const LEARNER_PASSWORD = `Maple-edge-${Date.now()}!`;

/** The one file phase one keeps: the story record the backlog's dialog writes. */
const STORY = "requirements/story.json";

/* --------------------------------- helpers -------------------------------- */


async function register(
  page: Page,
  email: string,
  name: string,
): Promise<void> {
  await page.goto("/register");
  await page.getByTestId("displayName").fill(name);
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill(LEARNER_PASSWORD);
  await page.getByTestId("register-submit").click();
  await page.waitForURL("**/login?registered=1", { timeout: UI_READY });
  await signIn(page, email);
  await page.waitForURL("**/onboarding");
  await page
    .getByRole("button", { name: "Start learning", exact: true })
    .click();
  await page.waitForURL("**/dashboard");
  // A new learner's Requirements room opens at the stakeholder interview.
  await openRequirements(page);
  await expect(page.getByRole('tab', { name: 'Stakeholder interview', exact: true })).toHaveAttribute('aria-selected', 'true');
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill(LEARNER_PASSWORD);
  await page.getByTestId("login-submit").click();
}

/** Writes into the open editor the way a keystroke does, without waiting. */
async function typeInto(
  page: Page,
  basename: string,
  content: string,
): Promise<void> {
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
      const model = monaco.editor
        .getModels()
        .find((m: any) => m.uri.toString().endsWith(name));
      // An edit, not setValue: the editor treats a flush as a refresh of the saved
      // copy and ignores it (CodeEditor.tsx), so typing has to arrive as an edit.
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    },
    { name: basename, value: content },
  );
}

/** The phase as the API has it, read with the learner's own token. */
async function fileOnServer(
  page: Page,
  phaseId: string,
  path: string,
): Promise<string> {
  return page.evaluate(
    async ({ api, id, want }) => {
      const res = await fetch(`${api}/api/v1/phases/${id}`, {
        headers: {
          authorization: `Bearer ${localStorage.getItem("lsdlc_token")}`,
        },
      });
      if (!res.ok) return "";
      const detail = await res.json();
      return (
        (detail.files ?? []).find((f: { path: string }) => f.path === want)
          ?.content ?? ""
      );
    },
    { api: API, id: phaseId, want: path },
  );
}

/* --------- 1 · a token that expires mid-keystroke keeps the keystroke ------ */

test("an expiring token does not take the last edit with it", async ({
  page,
}) => {
  const email = testEmail(`e2e-edge-token-${Date.now()}`);
  await dismissPhaseTutorial(page);
  await register(page, email, "Tessa Token");

  const phaseId = /\/workspace\/([^/]+)/.exec(new URL(page.url()).pathname)![1];
  await page.getByRole('tab', { name: 'My backlog', exact: true }).click();
  await expect(page.getByTestId('requirements-backlog-panel')).toBeVisible();
  await page.locator('.jira-own-story').click();
  await expect(page.getByTestId('phase-requirements-title')).toBeVisible();

  // Every write this page makes to its own workspace, and whether it was
  // signed. The unsigned one is the bug.
  const writes: { signed: boolean }[] = [];
  page.on("request", (req) => {
    if (req.method() !== "PUT") return;
    if (!req.url().includes(`/phases/${phaseId}/workspace`)) return;
    writes.push({ signed: Boolean(req.headers()["authorization"]) });
  });

  const marker = `overdue-report-${Date.now()}`;
  await page.getByTestId('phase-requirements-title').fill(marker);
  // The saver binds its local draft to its original session. Refuse its first
  // real signed write at the API, as an expired session would be refused,
  // without replacing the owner of the pending draft before it can save.
  let expiredWrite = false;
  await page.route(`**/phases/${phaseId}/workspace`, async route => {
    if (route.request().method() === 'PUT' && !expiredWrite) {
      expiredWrite = true;
      await route.continue({ headers: { ...route.request().headers(), authorization: 'Bearer no.longer.valid' } });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Save story', exact: true }).click();

  // The autosave fires, the API refuses it, and the client ends the session.
  await page.waitForURL(/\/login/, { timeout: UI_READY });
  expect(expiredWrite, 'the actual API refused the first expired-token write').toBe(true);

  await signIn(page, email);
  // The 401 carried where they were, so signing back in returns them to it.
  await expect(page).toHaveURL(new RegExp(`/workspace/${phaseId}/issue$`), {
    timeout: UI_READY,
  });
  await expect(page.getByTestId('requirements-backlog-panel')).toBeVisible();

  // The text reached the server under the new session, so it is not merely
  // sitting in this tab.
  await expect
    .poll(() => fileOnServer(page, phaseId, STORY), { timeout: 20_000 })
    .toContain(marker);

  // And it is in the file the learner opens, after a reload that keeps nothing
  // of the page that was there before.
  await page.reload();
  await page.locator('.jira-own-story').click();
  await expect(page.getByTestId('phase-requirements-title')).toHaveValue(marker);

  expect(writes.length, "the workspace was written to").toBeGreaterThan(0);
  expect(
    writes.filter((w) => !w.signed).length,
    "every write to the workspace carried an authorization header",
  ).toBe(0);
});

/* ---------- 2 · a browser that keeps nothing can still be signed in -------- */

/**
 * `setItem` throws the way a private window does; reads keep working, which is
 * what makes the loop invisible. The coach-marks flag is written first, before
 * the stub is in place, so the tour is not what this test measures.
 */
async function blockSiteData(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("lsdlc_coach", "done");
    } catch {
      // already blocked in this document
    }
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      writable: true,
      value: () => {
        throw new DOMException(
          "The quota has been exceeded.",
          "QuotaExceededError",
        );
      },
    });
  });
}

test("signing in with site data blocked does not loop back to the sign-in page", async ({
  page,
}) => {
  const email = testEmail(`e2e-edge-storage-${Date.now()}`);
  const name = "Sam Storage";
  await dismissPhaseTutorial(page);
  await register(page, email, name);

  // Same browser, same account, but from here on it keeps nothing.
  await page.evaluate(() => window.localStorage.clear());
  await blockSiteData(page);

  await page.goto("/login");
  // Said before they start, rather than after they lose the page: the session
  // this browser is about to hold lives only as long as the tab.
  await expect(page.getByTestId("storage-blocked")).toBeVisible();
  await signIn(page, email);

  // A shell that read the token straight back would find nothing and send the
  // learner here again. It has to stay put, and the URL is only read once the
  // shell has settled, because the push to /dashboard lands for a frame either
  // way before the redirect takes it back.
  await expect(page.getByTestId("nav-user")).toHaveText(name, {
    timeout: UI_READY,
  });
  await page.waitForTimeout(1_500);
  await expect(page).toHaveURL(/\/dashboard/);

  // Nothing was kept: the loop was broken by holding the session in memory, not
  // by a browser that quietly started storing again.
  const kept = await page.evaluate(() =>
    window.localStorage.getItem("lsdlc_token"),
  );
  expect(kept, "the browser stored no token").toBeNull();

  // And the session is a real one: another signed-in page opens, and an
  // authenticated write from it goes through.
  await page.getByTestId("nav-user").click();
  await page.getByTestId("nav-profile").click();
  await expect(page).toHaveURL(/\/profile/, { timeout: UI_READY });
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    name,
    { timeout: UI_READY },
  );
  await page
    .getByLabel("Display name", { exact: true })
    .fill(`${name} of the lab`);
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByText("Your profile is saved.")).toBeVisible({
    timeout: UI_READY,
  });
  await expect(page).toHaveURL(/\/profile/);
});

/* ------- 3 · a file too big for a keepalive body still leaves the page ----- */

test("a long file is still saved on the way out of the workspace", async ({
  page, request,
}) => {
  const fixture = await createUnlockedEditor(request, 'large-file');
  await signInEditorFixture(page, fixture);
  const phaseId = fixture.phaseId;
  const sourcePath = 'api/repository/tasks.py';
  await page.goto(`/workspace/${phaseId}?file=${encodeURIComponent(sourcePath)}`);
  await expect(
    page.getByTestId("editor-host").locator(".monaco-editor"),
  ).toBeVisible({
    timeout: UI_READY,
  });

  const writes: number[] = [];
  page.on("request", (req) => {
    if (req.method() !== "PUT") return;
    if (!req.url().includes(`/phases/${phaseId}/workspace`)) return;
    writes.push((req.postData() ?? "").length);
  });

  // Over the 64 KiB the Fetch standard allows a keepalive body, and well inside
  // the 200,000 characters the API takes for one file. Marked keepalive, this
  // request is refused by the browser before it reaches the network.
  const marker = `long-source-${Date.now()}`;
  const filler = "# A note that goes on.\n".repeat(3_500);
  await typeInto(page, sourcePath, `# Marker ${marker}\n${filler}`);
  // The edit marks the file unsaved at once and the debounce holds its save
  // for 0.7 s, so this is read inside that window rather than after a sleep.
  await expect(page.getByTestId("save-state")).toHaveText("Unsaved");

  // Away before the debounce fires, so the save on the way out is the only one.
  await page.getByTestId("nav-home").click();
  await expect(page.getByRole("heading", { name: "Welcome, Isolated.", exact: true })).toBeVisible({
    timeout: UI_READY,
  });

  await expect
    .poll(
      async () => {
        const text = await fileOnServer(page, phaseId, sourcePath);
        return text.includes(marker)
          ? "saved"
          : `not saved (${text.length} characters)`;
      },
      { timeout: 20_000 },
    )
    .toBe("saved");

  expect(
    writes.filter((size) => size > 65_536).length,
    "the long file left the browser",
  ).toBeGreaterThan(0);
});
