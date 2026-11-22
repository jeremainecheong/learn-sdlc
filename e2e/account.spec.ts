import { expect, test } from "@playwright/test";
import * as fs from "fs";
import { API, RUN_ID, testEmail } from "./support/env";
import { signInAs } from "./pw-fixtures";
import { UI_READY } from "./support/timeouts";

/**
 * The account page, walked.
 *
 * Four things a learner does here and nothing had ever driven any of them: the
 * rename that the whole shell shows, the password change that signs every
 * session out, the export the privacy policy promises, and the deletion that
 * cannot be undone. The last one is the reason this walk exists at all, the
 * typed-email confirmation is the only thing between a mis-click and a term of
 * work, and it was checked by no test in either half of the product.
 *
 * The order is deliberate. Changing the password revokes this session, so it
 * comes after everything that needs one, and the deletion is only ever
 * cancelled: an account this suite destroyed would take the rest of the walk
 * with it.
 */

const EMAIL = testEmail(`e2e-account-${RUN_ID}`);
const PASSWORD = `Maple-account-${RUN_ID}!`;
const NEW_PASSWORD = "Battery-Staple-42";
const NAME = "Ada Lovelace";

test.describe.configure({ mode: "default" }); // in order, one run-wide account (E2E_RUN_ID): a red walk must not skip the rest


/**
 * A retry (CI runs with retries: 1) meets the run-wide account as the first
 * attempts left it: the rename case's first attempt has registered it, and a
 * password case that failed after its change has left NEW_PASSWORD on it. On
 * a retry only, this finds the account under either password, puts PASSWORD
 * back, and hands the case its session: every case then starts where the walk
 * expects it to, and the rename case signs in rather than registering the
 * address again ("already exists"). A first attempt is untouched.
 */
let retrySession: { token: string } | null = null;
test.beforeEach(async ({ request }) => {
  retrySession = null;
  if (test.info().retry === 0) return;
  for (const password of [PASSWORD, NEW_PASSWORD]) {
    const signedIn = await request.post(`${API}/auth/login`, { data: { email: EMAIL, password } });
    if (!signedIn.ok()) continue;
    let token = (await signedIn.json()).token as string;
    if (password !== PASSWORD) {
      const back = await request.post(`${API}/account/password`, {
        headers: { authorization: `Bearer ${token}` },
        data: { currentPassword: password, newPassword: PASSWORD },
      });
      expect(back.ok(), "the retry puts the walk's password back").toBeTruthy();
      const again = await request.post(`${API}/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
      expect(again.ok(), "and signs in with it").toBeTruthy();
      token = (await again.json()).token as string;
    }
    retrySession = { token };
    return;
  }
});

/** Each test gets its own browser context, so each one signs in for itself. */
async function signIn(
  page: import("@playwright/test").Page,
  password = PASSWORD,
): Promise<void> {
  await page.goto("/login");
  await signInAs(page, EMAIL, password);
  // The walk needs an account, not a project, so the shell rather than the
  // dashboard's own heading is what says it arrived.
  await page.waitForURL("**/dashboard", { timeout: UI_READY });
  await expect(page.getByTestId("nav-user")).toBeVisible({ timeout: UI_READY });
}

test("the profile page renames the learner everywhere the shell shows them", async ({
  page,
}) => {
  // A retry whose first attempt registered the run-wide account signs in to it
  // (the beforeEach found it) rather than registering the address again.
  if (retrySession) {
    // Back to the name the walk starts from: the first attempt may have got
    // as far as renaming it.
    const reset = await page.request.patch(`${API}/account/profile`, {
      headers: { authorization: `Bearer ${retrySession.token}` },
      data: { displayName: "Ada" },
    });
    expect(reset.ok(), "the retried walk starts from the name it registered").toBeTruthy();
    await page.goto("/login");
    await signInAs(page, EMAIL, PASSWORD);
    await page.waitForURL(/\/(onboarding|dashboard)$/, { timeout: UI_READY });
    if (page.url().endsWith("/onboarding"))
      await page.getByRole("button", { name: "Start learning", exact: true }).click();
    await page.waitForURL("**/dashboard");
  } else {
    await page.goto("/register");
    await page.getByTestId("displayName").fill("Ada");
    await page.getByTestId("email").fill(EMAIL);
    await page.getByTestId("password").fill(PASSWORD);
    await page.getByTestId("register-submit").click();
    await page.waitForURL("**/login?registered=1", { timeout: UI_READY });
    await signInAs(page, EMAIL, PASSWORD);
    await page.waitForURL("**/onboarding");
    await page
      .getByRole("button", { name: "Start learning", exact: true })
      .click();
    await page.waitForURL("**/dashboard");
  }

  // The name in the top bar is the way in, so the route is walked rather than typed.
  await expect(page.getByTestId("nav-user")).toHaveText("Ada");
  await page.getByTestId("nav-user").click();
  await page.getByTestId("nav-profile").click();
  await expect(page).toHaveURL(/\/profile$/);

  // Padded on purpose: the trim is the API's, and what comes back is what the
  // shell must show.
  await page.getByLabel("Display name", { exact: true }).fill(`  ${NAME}  `);
  await page.getByRole("button", { name: "Save profile", exact: true }).click();

  await expect(page.getByRole("status").filter({ hasText: "Your profile is saved." })).toContainText(
    "Your profile is saved.",
  );
  // No reload: the session store writes through and tells the bar in one breath.
  await expect(page.getByTestId("nav-user")).toHaveText(NAME);

  await page.reload();
  await expect(page.getByTestId("nav-user")).toHaveText(NAME);
  await expect(page.getByRole("main")).toContainText(NAME);
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    NAME,
  );

  // An invalid name cannot replace the saved profile.
  await page.getByLabel("Display name", { exact: true }).fill("");
  await expect(
    page.getByRole("button", { name: "Save profile", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    NAME,
  );
});

test("the export downloads everything the account holds, and no password", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/account");
  await expect(page.getByTestId("export-data")).toBeVisible({
    timeout: UI_READY,
  });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-data").click(),
  ]);

  expect(download.suggestedFilename()).toBe("learnsdlc-export.json");
  const file = await download.path();
  const data = JSON.parse(fs.readFileSync(file as string, "utf8")) as {
    account?: Record<string, unknown>;
  };
  expect(data.account?.email).toBe(EMAIL);
  expect(data.account?.displayName).toBe(NAME);
  // "Your password is not included", says the page. Only a hash is stored and
  // it is deliberately left out.
  expect(JSON.stringify(data)).not.toContain("passwordHash");
  await expect(page.getByTestId("account-pass")).toContainText("ready to save");
});

test("the delete form refuses a mistyped address, and cancels cleanly", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/account");
  await expect(page.getByTestId("delete-account")).toBeVisible({
    timeout: UI_READY,
  });
  await page.getByTestId("delete-account").click();

  const confirm = page.getByTestId("confirm-delete");
  await expect(confirm).toBeDisabled();

  // Somebody else's address, and the learner's own with a typo in it.
  await page.getByTestId("confirm-email").fill(testEmail("someone.else"));
  await expect(confirm).toBeDisabled();
  await page.getByTestId("confirm-email").fill(EMAIL.replace("@", "."));
  await expect(confirm).toBeDisabled();

  // Exactly right, whatever the case: only now is the button live.
  await page.getByTestId("confirm-email").fill(EMAIL.toUpperCase());
  await expect(confirm).toBeEnabled();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("confirm-email")).toHaveCount(0);
  await expect(page.getByTestId("delete-account")).toBeVisible();

  // Nothing was destroyed by any of that.
  await page.reload();
  await expect(page.getByTestId("nav-user")).toHaveText(NAME);
});

test("changing the password refuses the old one afterwards", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/account");
  await expect(page.getByTestId("current-password")).toBeVisible({
    timeout: UI_READY,
  });

  // The wrong current password changes nothing, and says which one was wrong.
  await page.getByTestId("current-password").fill("not-the-current-one");
  await page.getByTestId("new-password").fill(NEW_PASSWORD);
  await page.getByTestId("password-save").click();
  await expect(page.getByTestId("account-fail")).toContainText(
    "current password is not correct",
  );

  await page.getByTestId("current-password").fill(PASSWORD);
  await page.getByTestId("new-password").fill(NEW_PASSWORD);
  await page.getByTestId("password-save").click();
  // Every session ends at once, this one included: the page goes straight to
  // sign-in and says why there, not on the account page.
  await page.waitForURL("**/login**", { timeout: UI_READY });
  await expect(page.getByTestId("password-change-success")).toContainText(
    "all sessions have ended",
  );

  // The session that made the change is one of the ones it ended.
  await page.goto("/login");
  await signInAs(page, EMAIL, PASSWORD);
  await expect(page.getByTestId("auth-error")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  await page.getByTestId("password").fill(NEW_PASSWORD);
  await page.getByTestId("login-submit").click();
  await page.waitForURL("**/dashboard", { timeout: UI_READY });
  await expect(page.getByTestId("nav-user")).toHaveText(NAME);
});
