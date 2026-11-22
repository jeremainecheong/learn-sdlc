import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { IMPLEMENTATION_ARTEFACT } from "./fixtures";
import { CONFIGURED_ADMIN, PASSING_DESIGN, PASSING_REQUIREMENTS, markPassing } from "./passing-work";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { API, testEmail } from "./support/env";
import { signInAs, skipCoachMarks } from "./pw-fixtures";
import { NAVIGATION, UI_READY } from "./support/timeouts";

/**
 * The dossier: a learner's whole project as one document they can print.
 *
 * There is no PDF library in this product; the browser's print engine is the
 * pipeline. That makes the print stylesheet the whole feature and it is
 * invisible in ordinary QA, a page that looks right on screen can print six
 * blank sheets with a sidebar on each. So two of the three journeys below
 * exist to look at paper rather than at the screen: one switches the page into
 * print media and checks what survives, and one takes an actual PDF out of
 * chromium and checks it is a real file. Neither is optional.
 *
 * The third is the privacy line. An instructor's copy of the dossier carries
 * the count of a learner's mentor questions and never the questions, and
 * reading it leaves a row on the audit trail.
 *
 * The assertions about `buildDossier`, a locked phase, a pruned snapshot, the
 * order of the journal, are made here against the rendered page.
 */

const INSTRUCTOR = {
  email: `e2e-dossier-teacher-${randomUUID()}@example.test`,
  password: `Maple-dossier-${randomUUID()}`,
};
const LEARNER = {
  name: "Dora Dossier",
  email: testEmail(`e2e-dossier-${Date.now()}`),
  password: "Correct-Horse-9",
};
const CLASS_NAME = `E2E dossier class ${Date.now()}`;
const COMMIT = "Add the overdue report and keep due today out of it";
const MERGE_NOTE =
  "Writing the criteria before the code meant the report only had one boundary left to argue about.";
const QUESTION =
  "What should the overdue report do with a task that is due today?";

let learnerId = "";
let outDir = "";
let staffHeaders: Record<string, string> = {};
test.describe.configure({ mode: "serial", timeout: 600_000 });

/* ----------------------------- the seeding ------------------------------- */

/**
 * A learner three phases in, through the API.
 *
 * The click path through Requirements, Design and Implementation is
 * `journey.spec.ts`'s job and takes minutes; what is under test here is the
 * document those phases produce, so the learner arrives the cheap way and
 * every assertion below is made in the browser.
 */
async function seed(request: APIRequestContext): Promise<void> {
  const administrator = await request.post(`${API}/auth/login`, {
    data: CONFIGURED_ADMIN,
  });
  expect(administrator.ok(), "the configured test administrator signs in").toBe(
    true,
  );
  const adminHeaders = {
    authorization: `Bearer ${(await administrator.json()).token}`,
  };
  const teacher = await request.post(`${API}/auth/register`, {
    data: {
      email: INSTRUCTOR.email,
      password: INSTRUCTOR.password,
      displayName: "Dossier Teacher",
    },
  });
  expect(teacher.ok()).toBe(true);
  const teacherUser = await teacher.json();
  expect(
    (
      await request.patch(`${API}/admin/users/${teacherUser.user.id}`, {
        headers: adminHeaders,
        data: { role: "INSTRUCTOR" },
      })
    ).ok(),
  ).toBe(true);
  const signedIn = await request.post(`${API}/auth/login`, {
    data: INSTRUCTOR,
  });
  expect(signedIn.ok()).toBe(true);
  const staff = { authorization: `Bearer ${(await signedIn.json()).token}` };
  staffHeaders = staff;
  expect(
    (
      await request.patch(`${API}/account/profile`, {
        headers: staff,
        data: { displayName: "Dossier Teacher", onboardingCompleted: true },
      })
    ).ok(),
  ).toBe(true);
  const cohort = await request.post(`${API}/instructor/cohorts`, {
    headers: staff,
    data: { name: CLASS_NAME },
  });
  expect(cohort.ok(), "the instructor mints a class").toBeTruthy();
  const joinCode = (await cohort.json()).joinCode as string;

  const auth = await request.post(`${API}/auth/register`, {
    data: {
      email: LEARNER.email,
      password: LEARNER.password,
      displayName: LEARNER.name,
    },
  });
  expect(auth.ok(), "the learner registers").toBeTruthy();
  const body = await auth.json();
  learnerId = body.user.id as string;
  const headers = { authorization: `Bearer ${body.token as string}` };

  expect(
    (
      await request.patch(`${API}/account/profile`, {
        headers,
        data: { displayName: LEARNER.name, onboardingCompleted: true },
      })
    ).ok(),
  ).toBe(true);
  const joined = await request.post(`${API}/enrollments/join`, {
    headers,
    data: { code: joinCode },
  });
  expect(joined.ok(), "the learner joins the class").toBeTruthy();

  const enrolled = await request.post(`${API}/enrollments`, {
    headers,
    data: { projectSlug: "tasktrackr" },
  });
  expect(enrolled.ok(), "the learner enrols").toBeTruthy();
  let phases = (await enrolled.json()).phases as {
    id: string;
    order: number;
  }[];

  const pass = async (
    order: number,
    files: Record<string, string>,
    message?: string,
  ) => {
    const phase = phases.find((p) => p.order === order)!;
    const detail = await request.get(`${API}/phases/${phase.id}`, { headers });
    expect(detail.ok()).toBe(true);
    const saved = await request.put(`${API}/phases/${phase.id}/workspace`, {
      headers,
      data: { files, baseVersion: (await detail.json()).workspaceUpdatedAt },
    });
    expect(saved.ok()).toBe(true);
    if (order === 3) {
      const execution = await request.post(`${API}/phases/${phase.id}/run`, { headers });
      expect(execution.ok(), "Implementation runs before submission").toBe(true);
      const runId = (await execution.json()).id;
      let run: any;
      await expect.poll(async () => {
        const response = await request.get(`${API}/runs/${runId}`, { headers });
        expect(response.ok()).toBe(true);
        run = await response.json();
        return run.status;
      }, { timeout: 180_000, intervals: [1000, 2000] }).toMatch(/completed|failed/);
      // The runner's own sentence rides on a failure, so a host that cannot
      // run learner code says so in the report.
      expect(run.status, run.result?.stderr).toBe("completed");
      expect(run.result?.ok).toBe(true);
      expect(run.result?.exitKind).toBe("ok");
      expect(run.result?.tests?.total).toBeGreaterThan(0);
      expect(run.result?.tests?.passed).toBe(run.result?.tests?.total);
    }
    const started = await request.post(`${API}/phases/${phase.id}/submit`, {
      headers,
      data: message ? { message } : {},
    });
    expect(started.ok(), `phase ${order} submits`).toBeTruthy();
    const id = (await started.json()).id as string;
    const deadline = Date.now() + 180_000;
    let done: any = null;
    while (Date.now() < deadline) {
      const res = await request.get(`${API}/submissions/${id}`, { headers });
      done = await res.json();
      if (done.status === "completed" || done.status === "failed") break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(
      done?.report?.assessmentMode,
      `phase ${order} uses strict grading`,
    ).toBe("strict_binary");
    expect(
      done?.report?.aiReview?.assessmentError,
      `phase ${order} has valid provider evidence`,
    ).toBeFalsy();
    expect(
      done?.passed,
      `phase ${order} passes its gate with complete evidence`,
    ).toBe(true);
    const history = await request.get(
      `${API}/submissions/review-history/pages?project=tasktrackr`,
      { headers },
    );
    expect(history.ok()).toBe(true);
    expect(
      (await history.json()).items.find(
        (item: { id: string }) => item.id === id,
      )?.verifiedPass,
    ).toBe(true);
    await request.post(`${API}/phases/${phase.id}/reflect`, {
      headers,
      data: { reflection: `${MERGE_NOTE} (phase ${order})` },
    });
    const after = await request.post(`${API}/phases/${phase.id}/advance`, {
      headers,
    });
    expect(
      after.ok(),
      `phase ${order} advances only after a verified Pass`,
    ).toBe(true);
    phases = (await after.json()).phases;
  };

  await pass(1, PASSING_REQUIREMENTS);
  // This is an actual private conversation, and failures are not hidden.
  const first = phases.find((p) => p.order === 2)!;
  const conversation = await request.post(`${API}/assistant/chat`, {
    headers,
    data: { phaseStateId: first.id, message: QUESTION },
  });
  expect(
    conversation.ok(),
    "the private learner conversation is recorded",
  ).toBe(true);
  await pass(2, PASSING_DESIGN);
  await pass(3, markPassing(IMPLEMENTATION_ARTEFACT), COMMIT);
}

async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await skipCoachMarks(page);
  await page.goto("/login");
  await signInAs(page, email, password);
  // A learner lands on Home and staff land on the class console; this helper
  // signs in both, so it waits for whichever of the two the API sent them to.
  await page.waitForURL(/\/(dashboard|teacher)(\?|$)/, { timeout: UI_READY });
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(600_000);
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsdlc-dossier-"));
  await seed(request);
});

test.afterAll(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

test("a learner prints the record of their project", async ({ page }) => {
  await signIn(page, LEARNER.email, LEARNER.password);

  await page.goto("/artefacts");
  await expect(
    page.getByRole("heading", { name: "Your project portfolio", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Print project evidence", exact: true })
    .click();
  await page.waitForURL("**/dossier");

  await expect(page.getByTestId("dossier")).toBeVisible({ timeout: NAVIGATION });
  for (let n = 1; n <= 12; n += 1) {
    await expect(page.getByTestId(`dossier-section-${n}`)).toBeVisible();
  }
  await expect(page.getByTestId("dossier-cover-name")).toHaveText(LEARNER.name);

  // What the learner wrote, at the revision it was merged on, and the one line
  // they said about it.
  await expect(page.getByTestId("dossier-section-5")).toContainText(
    "api/repository/tasks.py",
  );
  await expect(page.getByTestId("dossier-section-6")).toContainText(COMMIT);
  await expect(page.getByTestId("dossier-section-10")).toContainText(
    MERGE_NOTE,
  );

  // An unfinished project is the common case: the phases not yet reached print
  // one line rather than an empty panel.
  // Testing is open but ungraded: it prints what exists and says what does not.
  await expect(page.getByTestId("dossier-section-7")).toContainText(
    "Testing is open, and no suite has been graded yet.",
  );
  // Deployment and Maintenance are not reached yet.
  await expect(page.getByTestId("dossier-section-8")).toContainText(
    "Opens in phase 5",
  );
  await expect(page.getByTestId("dossier-score-6")).toBeVisible();
  await expect(page.getByTestId("dossier-section-2")).toContainText(
    "Opens in phase 6",
  );

  // Print is not ready while a section is still loading, and when it is ready
  // it says nothing about waiting.
  await expect(page.getByTestId("dossier-print")).toBeEnabled({
    timeout: NAVIGATION,
  });
  await expect(page.getByTestId("dossier-waiting")).toBeHidden();

  // The print view is a single document; its lower sections remain reachable.
  await page.getByTestId("dossier-section-11").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("dossier-section-11")).toBeInViewport({
    timeout: 10_000,
  });

  /* ------------------------------ on paper ------------------------------- */
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("nav")).toBeHidden();
  await expect(
    page.getByTestId("sidebar").or(page.getByTestId("rail")),
  ).toBeHidden();
  await expect(page.getByTestId("dossier-print")).toBeHidden();
  await expect(page.getByTestId("dossier-section-1")).toBeVisible();
  await expect(page.getByTestId("dossier-section-12")).toBeVisible();
  await expect(page.getByTestId("dossier-colophon")).toContainText(
    "Prepared by this browser for the print destination you choose",
  );
  await page.emulateMedia({ media: "screen" });
});

test("the dossier is a real PDF, and the same one in either theme", async ({
  page,
}) => {
  await signIn(page, LEARNER.email, LEARNER.password);
  await page.goto("/dossier");
  await expect(page.getByTestId("dossier")).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId("dossier-print")).toBeEnabled({
    timeout: NAVIGATION,
  });

  const normalize = (value: string) => value.replace(/\s+/g, "");
  const contradiction = normalize(await page.getByTestId("dossier-contradictions").innerText());
  expect(contradiction).not.toBe(normalize("Contradictions at merge"));
  const journalCells = (await page.locator('[data-testid^="dossier-day-"] [role="cell"]').allInnerTexts())
    .map(normalize).filter(Boolean);
  expect(journalCells.some(value => value.includes(normalize(QUESTION)))).toBe(true);
  const sizes: number[] = [];
  for (const theme of ["paper", "graphite"] as const) {
    await page.evaluate((t) => {
      window.localStorage.setItem("lsdlc_theme", t);
      document.documentElement.setAttribute("data-theme", t);
    }, theme);
    await page.emulateMedia({ media: "print" });
    // The Design section prints the record and both contracts as facts: the model,
    // the API contract's endpoints and the screens, each in print.
    const contract = page.getByTestId("dossier-section-4");
    await expect(contract.getByTestId("dossier-model"), `${theme}: the record's model prints`).toContainText("Task");
    await expect(contract.getByTestId("dossier-api"), `${theme}: the API contract prints`).toBeVisible();
    await expect(contract.getByTestId("dossier-screens"), `${theme}: the screen contract prints`).toBeVisible();
    const file = path.join(outDir, `dossier-${theme}.pdf`);
    // The only assertion that proves the print path produces a document rather
    // than a page that merely looks printable.
    await page.pdf({ path: file, format: "A4", printBackground: true });
    expect(fs.existsSync(file), `${theme} produced a file`).toBeTruthy();
    const bytes = fs.readFileSync(file);
    expect(bytes.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(30_000);
    expect(
      (bytes.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length,
      "the complete document spans at least twelve sections, rather than clipping to one viewport",
    ).toBeGreaterThanOrEqual(12);
    // Page count and nonempty headers cannot detect silently clipped body
    // content. Match the actual persisted paragraphs and every journal cell.
    const text = normalize(execFileSync("pdftotext", ["-raw", file, "-"], { encoding: "utf8" }));
    expect(text).toContain(normalize(QUESTION));
    expect(text).toContain(normalize(COMMIT));
    expect(text).toContain(normalize(MERGE_NOTE));
    expect(text).toContain(contradiction);
    for (const cell of journalCells) expect(text).toContain(cell);
    await page.emulateMedia({ media: "screen" });
    sizes.push(bytes.length);
    // Kept with the run's report, so a reader can open the document the checks read.
    await test.info().attach(`dossier-${theme}.pdf`, { path: file, contentType: "application/pdf" });
  }
  // The palette is restated for print, so a learner reading in Graphite prints
  // the same dark ink on white a Paper reader does.
  const [paper, graphite] = sizes;
  expect(Math.abs(paper - graphite) / Math.max(paper, graphite)).toBeLessThan(
    0.1,
  );
});

test("an instructor prints a learner dossier, and it is on the record", async ({
  page,
  request,
}) => {
  await signIn(page, INSTRUCTOR.email, INSTRUCTOR.password);
  await page.goto(`/instructor/learners/${learnerId}`);
  // /teacher?learner= goes on to the learner's class page, its roster filtered to them.
  await expect(page).toHaveURL(new RegExp(`/teacher/class\\?class=[^&]+&learner=${learnerId}`), { timeout: NAVIGATION });
  await page
    .getByRole("button", {
      name: `Inspect ${LEARNER.name}, Implementation`,
      exact: true,
    })
    .click();
  await page
    .getByRole("link", { name: "Print submitted evidence", exact: true })
    .click();
  // The link carries the project and the way back (TeacherPortal.tsx dossierHref).
  await page.waitForURL((url) => url.pathname.endsWith("/dossier"));
  await expect(page.getByTestId("dossier")).toBeVisible({ timeout: NAVIGATION });
  await expect(page.getByTestId("dossier-cover-name")).toHaveText(LEARNER.name);
  // The code section is the point: this is the only route that hands an
  // instructor the learner's own files.
  await expect(page.getByTestId("dossier-section-5")).toContainText(
    "api/repository/tasks.py",
  );

  // The privacy line: mentor rows are a count, and the question is nowhere on
  // the page.
  const journal = page.getByTestId("dossier-section-11");
  await expect(journal).toContainText("never quoted");
  await expect(journal).not.toContainText(QUESTION);
  // A mentor row, if the deployment had a model to answer with, is a count.
  if (await journal.getByText("Asked the mentor").count()) {
    await expect(journal).toContainText(/\d+ questions?/);
  }
  await expect(page.getByTestId("dossier")).not.toContainText(QUESTION);

  // The portal keeps evidence review focused; the audit endpoint remains authoritative.
  const audit = await request.get(
    `${API}/instructor/audit?learnerId=${learnerId}`,
    { headers: staffHeaders },
  );
  expect(audit.ok()).toBe(true);
  expect(
    (await audit.json()).some(
      (event: { event: string }) => event.event === "dossier.read",
    ),
  ).toBe(true);
});
