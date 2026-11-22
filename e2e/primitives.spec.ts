import { expect, test, type Locator, type Page } from "@playwright/test";
import { createUnlockedEditor, signInEditorFixture } from "./fixtures/unlocked-editor";
import { dismissPhaseTutorial, openRequirements, signInAs } from "./pw-fixtures";
import { testEmail } from "./support/env";
import { NAVIGATION, UI_READY } from "./support/timeouts";

/**
 * The shared primitives, held to what their roles promise: tabs, dialogs, the
 * focus ring and disabled controls.
 *
 * A `role="tablist"` that handles no keys, a `role="dialog"` that lets Tab
 * walk out of it, a component that opts out of the global focus ring and
 * draws a 1.5 to 1 replacement, a disabled control that fades its own label
 * to illegible without saying why: none of that is visible in a screenshot,
 * so it is checked here in a browser instead.
 */

const PASSWORD = `Maple-primitives-${Date.now()}!`;
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * One learner, one browser context, in order. Registering ten times over is a
 * minute of bcrypt and ten rows in someone else's class list, and none of the
 * assertions below are about signing up.
 */
test.describe.configure({ mode: "default" }); // in order; a red test restarts the worker and beforeAll signs a new learner in, so nothing after it is skipped

let page: Page;
/** The workspace this learner's project opened on. */
let workspace = "";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await dismissPhaseTutorial(page);
  await page.goto("/register");
  await page.getByTestId("displayName").fill("Primitive Learner");
  await page.getByTestId("email").fill(testEmail(`e2e-prim-${stamp}`));
  await page.getByTestId("password").fill(PASSWORD);
  await page.getByTestId("register-submit").click();
  await page.waitForURL("**/login?registered=1", { timeout: NAVIGATION });
  await signInAs(page, testEmail(`e2e-prim-${stamp}`), PASSWORD);
  await page.waitForURL("**/onboarding");
  await page
    .getByRole("button", { name: "Start learning", exact: true })
    .click();
  await page.waitForURL("**/dashboard");
  // A new learner's Requirements room opens at the stakeholder interview.
  await openRequirements(page);
  await expect(page.getByRole('tab', { name: 'Stakeholder interview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId("phase-title")).toBeVisible({
    timeout: NAVIGATION,
  });
  workspace = page.url();
});

test.afterAll(async () => {
  await page?.close();
});

/* --------------------------------- helpers -------------------------------- */

/** The `data-testid`, `id` or tag of whatever holds focus. */
async function focused(): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "nothing";
    return el.getAttribute("data-testid") ?? el.id ?? el.tagName.toLowerCase();
  });
}

/** Whether focus is anywhere inside the element the selector names. */
async function focusInside(selector: string): Promise<boolean> {
  return page.evaluate(
    (sel) =>
      Boolean(document.querySelector(sel)?.contains(document.activeElement)),
    selector,
  );
}

/** The phases page, ready. */
async function openPhases(): Promise<void> {
  await page.goto("/phases");
  await expect(
    page.getByRole("heading", { name: "Your progress, in view.", exact: true }),
  ).toBeVisible({ timeout: UI_READY });
}

/**
 * The keyboard contract every tablist owes: one stop for the row, arrows that
 * move both the selection and the focus, Home and End at the ends, and every
 * tab that is not selected left out of the tab order.
 */
async function checkTablist(tablist: Locator, where: string, targetPage: Page = page): Promise<void> {
  const tabs = tablist.getByRole("tab");
  // Every tablist in the product is drawn from data the page fetches, so the
  // element can be on the screen a beat before the tabs inside it are. `count()`
  // asks once and never retries, which on a slow machine reads an empty row as
  // a row with no tabs, the CI failure this waits out. The assertion below is
  // the same one; this only gives the data time to arrive.
  await expect(tabs.nth(1), `${where} has more than one tab`).toBeAttached({
    timeout: UI_READY,
  });
  const count = await tabs.count();
  expect(count, `${where} has more than one tab`).toBeGreaterThan(1);

  // One stop for the whole row: exactly one tab at tabindex 0.
  const zeros = await tablist.locator('[role="tab"][tabindex="0"]').count();
  expect(zeros, `${where} has one tab in the tab order`).toBe(1);

  await tabs.first().focus();
  await expect(
    tabs.first(),
    `${where}: the first tab takes focus`,
  ).toBeFocused();
  const firstId = (await tabs.first().getAttribute("id")) ?? "";
  expect(firstId, `${where}: a tab has an id`).not.toBe("");

  await targetPage.keyboard.press("ArrowRight");
  await expect(
    tabs.nth(1),
    `${where}: ArrowRight moves focus to the next tab`,
  ).toBeFocused();
  await expect(
    tabs.nth(1),
    `${where}: ArrowRight moves the selection too`,
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    targetPage.locator(`[id="${firstId}"]`),
    `${where}: the tab left behind leaves the tab order`,
  ).toHaveAttribute("tabindex", "-1");
  await expect(
    targetPage.locator(`[id="${firstId}"]`),
    `${where}: the tab left behind is no longer selected`,
  ).toHaveAttribute("aria-selected", "false");

  await targetPage.keyboard.press("ArrowLeft");
  await expect(tabs.first(), `${where}: ArrowLeft comes back`).toBeFocused();

  await targetPage.keyboard.press("End");
  await expect(
    tabs.nth(count - 1),
    `${where}: End goes to the last tab`,
  ).toBeFocused();
  await targetPage.keyboard.press("Home");
  await expect(
    tabs.first(),
    `${where}: Home comes back to the first`,
  ).toBeFocused();
}

/** Every tab points at a panel that exists, and the panel points back. */
async function checkTabPanelPairing(
  tablist: Locator,
  where: string,
  targetPage: Page = page,
): Promise<void> {
  const tabs = tablist.getByRole("tab");
  for (let i = 0; i < (await tabs.count()); i += 1) {
    const tab = tabs.nth(i);
    const controls = await tab.getAttribute("aria-controls");
    expect(
      controls,
      `${where}: tab ${i} names the panel it controls`,
    ).toBeTruthy();
    if ((await tab.getAttribute("aria-selected")) !== "true") continue;
    const panel = targetPage.locator(`[id="${controls as string}"]`);
    await expect(
      panel,
      `${where}: the selected tab's panel is on the page`,
    ).toHaveCount(1);
    await expect(panel, `${where}: the panel is a tabpanel`).toHaveAttribute(
      "role",
      "tabpanel",
    );
    await expect(
      panel,
      `${where}: the panel names the tab back`,
    ).toHaveAttribute(
      "aria-labelledby",
      (await tab.getAttribute("id")) as string,
    );
  }
}

/* ---------------------------------- tabs ---------------------------------- */

test("the six-phase path has native keyboard access without links through locked gates", async () => {
  await openPhases();
  const path = page.locator(".exp-phase-path");
  await expect(path.locator(".exp-phase-step")).toHaveCount(6);
  await expect(path.getByRole("link")).toHaveCount(1);
  await expect(path.locator(".is-locked")).toHaveCount(5);
  await expect(path.locator(".is-locked").getByRole("link")).toHaveCount(0);
  const current = path.getByRole("link", { name: /Requirements/ });
  const phaseId = /\/workspace\/([^/]+)/.exec(new URL(workspace).pathname)![1];
  // A new learner's Requirements door is the stakeholder interview.
  await expect(current).toHaveAttribute('href', `/workspace/${phaseId}/interview`);
  await current.focus();
  await expect(current).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/workspace/${phaseId}/interview$`));
  await expect(page.getByRole('tab', { name: 'Stakeholder interview', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test("the Requirements interview and backlog tabs retain native keyboard and labelled-panel access", async () => {
  await page.goto(workspace);
  const areas = page.getByRole('tablist', { name: 'Requirements workspace', exact: true });
  await checkTablist(areas, 'Requirements working areas');
  await checkTabPanelPairing(areas, 'Requirements working areas');
  await expect(page.getByTestId('editor-host')).toHaveCount(0);
});

test("the panel under Implementation code keeps keyboard access and a named panel", async ({ browser, request }) => {
  const fixture = await createUnlockedEditor(request, 'primitive-tabs');
  const editorPage = await browser.newPage();
  try {
    await signInEditorFixture(editorPage, fixture);
    await editorPage.goto(`/workspace/${fixture.phaseId}`);
    // Implementation keeps its console retracted until the learner opens it.
    await editorPage.locator('.implementation-console-bar').getByRole('button', { name: 'Console', exact: true }).click();
    const bottom = editorPage.getByTestId('bottom-panel');
    await expect(bottom).toBeVisible({ timeout: NAVIGATION });
    // Console opens its own selected tab. Start at the first real tab before
    // exercising relative arrow movement through the roving tab order.
    await bottom.getByRole('tab', { name: 'Terminal', exact: true }).click();
    await checkTablist(bottom.getByRole('tablist'), 'the panel under the code', editorPage);
    await checkTabPanelPairing(bottom.getByRole('tablist'), 'the panel under the code', editorPage);
  } finally { await editorPage.close(); }
});

test("the review chart exposes six phase rails and no invented review links", async () => {
  await openPhases();
  const chart = page.getByRole("region", {
    name: "Review history chart. Scroll horizontally for more reviews.",
  });
  await expect(chart).toBeVisible();
  await expect(chart.locator(".exp-journey-labels > span")).toHaveText([
    "Requirements",
    "Design",
    "Implementation",
    "Testing",
    "Deployment",
    "Maintenance",
  ]);
  await expect(chart.getByRole("link")).toHaveCount(0);
  await expect(chart).toContainText(
    "Your first review will begin the journey.",
  );
  await chart.focus();
  await expect(chart).toBeFocused();
});

/* --------------------------------- dialogs -------------------------------- */

test("Tab does not walk out of the palette, and the rows are options", async () => {
  await openPhases();
  await page.getByTestId("jump-to").click();
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  await expect(page.getByTestId("palette-input")).toBeFocused();

  // The rows are a listbox the input drives, not forty tab stops.
  expect(await palette.getByRole("option").count()).toBeGreaterThan(1);
  await expect(palette.getByRole("listbox")).toHaveCount(1);
  const input = page.getByTestId("palette-input");
  await expect(input).toHaveAttribute("role", "combobox");
  const active = await input.getAttribute("aria-activedescendant");
  expect(active, "the input says which row is active").toBeTruthy();
  await expect(page.locator(`[id="${active as string}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Past the last row, and past it again: focus is still in the dialog.
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("Tab");
  expect(
    await focusInside('[data-testid="palette"]'),
    `focus after four Tabs, at ${await focused()}`,
  ).toBe(true);
  await page.keyboard.press("Shift+Tab");
  expect(
    await focusInside('[data-testid="palette"]'),
    "focus after Shift+Tab",
  ).toBe(true);

  // The arrows still move the highlight, and it is the input that reports it.
  // The trap cycles two stops (the input and "Close search"), so the
  // caret is put back in the input the arrows belong to.
  await input.focus();
  await page.keyboard.press("ArrowDown");
  expect(await input.getAttribute("aria-activedescendant")).not.toBe(active);
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
});

test("the shortcut that opens the palette closes it, and gives focus back", async () => {
  await openPhases();
  await page.getByTestId("jump-to").focus();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.getByTestId("palette-input").fill("design");

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(
    page.getByTestId("jump-to"),
    "focus goes back where it came from",
  ).toBeFocused();

  // And the query went with it, rather than waiting inside for next time.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("palette-input")).toHaveValue("");
  await page.keyboard.press("Escape");
});

test("clicking the page with the bell open puts focus back on the bell", async () => {
  await openPhases();
  const bell = page.getByTestId("bell");
  await bell.click();
  await expect(page.getByTestId("bell-panel")).toBeVisible();
  expect(
    await focusInside('[data-testid="bell-panel"]'),
    "focus moves into the panel",
  ).toBe(true);

  // A heading, not another control: the click closes the panel and nothing
  // else asks for focus, so the bell has to take it back. The panel is a modal
  // dialog, so the pointer lands on its backdrop over the heading, which
  // is where a person's click lands too; it is made at the heading's place
  // rather than on the element the backdrop covers.
  const heading = await page
    .getByRole("heading", { name: "Your progress, in view.", exact: true })
    .boundingBox();
  await page.mouse.click(heading!.x + heading!.width / 2, heading!.y + heading!.height / 2);
  await expect(page.getByTestId("bell-panel")).toHaveCount(0);
  await expect(
    bell,
    `focus after the outside click, at ${await focused()}`,
  ).toBeFocused();
});

/* --------------------------------- the ring ------------------------------- */

test("a phase row focused by keyboard draws the ring the rest of the product draws", async () => {
  await openPhases();
  // Keyboard focus, not a click: `:focus-visible` is the whole point.
  await page
    .locator(".exp-phase-path")
    .getByRole("link", { name: /Requirements/ })
    .focus();
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    return {
      href: el.getAttribute("href"),
      width: s.outlineWidth,
      style: s.outlineStyle,
      colour: s.outlineColor,
    };
  });
  expect(ring.href).toBe(new URL(workspace).pathname);
  expect(ring.style, "the outline is drawn").not.toBe("none");
  expect(
    parseFloat(ring.width),
    `the outline has width (${JSON.stringify(ring)})`,
  ).toBeGreaterThan(0);
});

/* -------------------------------- disabled -------------------------------- */

/** WCAG relative luminance of an `rgb(r, g, b)` string. */
function luminance(colour: string): number {
  const [r, g, b] = (colour.match(/[\d.]+/g) ?? ["0", "0", "0"])
    .slice(0, 3)
    .map(Number);
  const ch = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The colours a disabled control actually *paints*, which is not the same as
 * the colours it declares. `opacity` is a compositing step, not a colour: it
 * leaves `getComputedStyle().color` alone and blends the whole element into
 * whatever is behind it at paint time. Reading the declared pair would have
 * called a 1.84 to 1 button legible, so this composites the element's own
 * opacity, and every ancestor's, over the first opaque background behind it.
 */
type Rgb = [number, number, number];

const parse = (colour: string): Rgb => {
  const n = (colour.match(/[\d.]+/g) ?? ["0", "0", "0"]).map(Number);
  return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0];
};

const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb =>
  [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as Rgb;

const rgb = (c: Rgb) => `rgb(${c.map((v) => Math.round(v)).join(", ")})`;

async function paintedColours(
  testId: string,
): Promise<{ fg: string; bg: string }> {
  const raw = await page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!el) throw new Error(`no control with data-testid="${id}"`);
    const own = getComputedStyle(el);
    // Every opacity between the control and the page, multiplied together.
    let alpha = 1;
    let node: HTMLElement | null = el;
    while (node) {
      alpha *= Number(getComputedStyle(node).opacity || "1");
      node = node.parentElement;
    }
    // The first opaque fill behind the control, which is what it blends into.
    let behind = "rgb(255, 255, 255)";
    let up: HTMLElement | null = el.parentElement;
    while (up) {
      const bg = getComputedStyle(up).backgroundColor;
      if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        behind = bg;
        break;
      }
      up = up.parentElement;
    }
    return { fg: own.color, fill: own.backgroundColor, alpha, behind };
  }, testId);

  const behind = parse(raw.behind);
  const fill =
    raw.fill === "rgba(0, 0, 0, 0)" || raw.fill === "transparent"
      ? behind
      : parse(raw.fill);
  return {
    fg: rgb(over(parse(raw.fg), behind, raw.alpha)),
    bg: rgb(over(fill, behind, raw.alpha)),
  };
}

test("a disabled control stays readable, in Paper and in Graphite", async () => {
  await page.goto("/account");
  await expect(page.getByTestId("password-save")).toBeVisible({
    timeout: UI_READY,
  });
  // Nothing typed, so the save is off: the state in which a faded primary
  // button can measure as low as 1.84 to 1.
  await expect(page.getByTestId("password-save")).toBeDisabled();

  for (const theme of ["paper", "graphite"] as const) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-theme", t);
    }, theme);
    // A theme change starts colour transitions; the colours are read once they
    // have finished, not part-way between the two themes.
    await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined))));
    // And the page's own arrival (`page-content-arrival`, opacity .65 to 1 on
    // the shell's main, components/shell/page-loading.css) must be over too:
    // measured part-way, the save composites through an ancestor at .65 to
    // .77 and reads as a paler pair than it paints once settled. Every
    // finite animation is waited for, and then the ancestors'
    // opacity product must read 1; the control's own opacity
    // is the disabled state under test and is not waited on.
    await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime))).map((a) => a.finished.catch(() => undefined))));
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            let product = 1;
            let node = document.querySelector<HTMLElement>('[data-testid="password-save"]')?.parentElement ?? null;
            while (node) {
              product *= Number(getComputedStyle(node).opacity || "1");
              node = node.parentElement;
            }
            return product;
          }),
        { message: "the page behind the save has settled to full opacity", timeout: 10_000, intervals: [100, 100, 250] },
      )
      .toBe(1);
    const { fg, bg } = await paintedColours("password-save");
    expect(
      ratio(fg, bg),
      `the disabled save's label on its own fill in ${theme} (${fg} on ${bg})`,
    ).toBeGreaterThanOrEqual(4.5);
  }
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "paper"),
  );
});

test("the mentor composer is focusable whenever the panel renders", async () => {
  await page.goto(workspace);
  const showMentor = page.getByRole("button", { name: "Show mentor", exact: true });
  if (await showMentor.count()) await showMentor.click();
  const composer = page.getByTestId("chat-input");
  await expect(composer).toBeVisible({ timeout: NAVIGATION });
  // Disabled would take it out of the tab order entirely, which is how a
  // learner ends up unable to reach the one control the phase is about.
  await expect(composer).not.toBeDisabled();
  await composer.focus();
  await expect(composer).toBeFocused();
});

/**
 * Every control a learner meets that is switched off, on the pages this suite
 * walks through. A control that says nothing is a dead end: the learner cannot
 * tell what would turn it on, and a disabled control is out of the tab order,
 * so focus will never reach an explanation either.
 */
const SWEPT: [string, string][] = [
  ["the dashboard", "/dashboard"],
  ["the phases page", "/phases"],
  ["the map", "/map"],
  ["the journal", "/journal"],
  ["the artefacts shelf", "/artefacts"],
  ["the account page", "/account"],
];

test("every control that renders switched off says why", async () => {
  const silent: string[] = [];
  for (const [where, path] of SWEPT) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const found = await page.evaluate(() => {
      const text = (el: Element | null) => (el?.textContent ?? "").trim();
      const out: { label: string; reason: string }[] = [];
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>(
          'button[disabled], [aria-disabled="true"]',
        ),
      )) {
        const described = (el.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => text(document.getElementById(id)))
          .join(" ")
          .trim();
        out.push({
          label:
            el.getAttribute("data-testid") ||
            el.getAttribute("aria-label") ||
            text(el).slice(0, 40) ||
            "an unnamed control",
          reason: (el.getAttribute("title") ?? "").trim() || described,
        });
      }
      return out;
    });
    for (const control of found) {
      if (!control.reason) silent.push(`${where}: ${control.label}`);
    }
  }

  expect(silent, "disabled controls with no reason beside them").toEqual([]);
});
