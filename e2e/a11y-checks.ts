import type { Page } from '@playwright/test';
import * as fs from 'fs';
import { AI_STUB_URL } from './support/env';

/*
 * The accessibility spec's checks (e2e/a11y-axe.spec.ts): axe-core run in the
 * page, and the keyboard, focus and live-region checks a screen can ask for.
 */

const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
/** WCAG 2.0 and 2.1, A and AA. 2.2's target-size is out of this check's scope. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/* --------------------------------- checks -------------------------------- */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** A failure line carries rule, impact, count and selectors only: never page text, an address or an id. */
export const clean = (s: string) => s.replace(EMAIL, '<email>').replace(UUID, ':id');

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  targets: string[];
  count: number;
}

export async function runAxe(page: Page): Promise<{ version: string; violations: AxeViolation[] }> {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async (tags) => {
    const axe = (window as unknown as { axe: any }).axe;
    const r = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return {
      version: axe.version as string,
      violations: r.violations.map((v: any) => ({
        id: v.id,
        impact: v.impact ?? null,
        help: v.help,
        count: v.nodes.length,
        targets: v.nodes.slice(0, 3).map((n: any) => [].concat(n.target).join(' ')),
      })),
    };
  }, AXE_TAGS);
}

/**
 * WCAG 4.1.3: while a wait line shows, a live region that is not busy (and
 * not inside a busy one) says the stage the wait line shows. The wait line
 * itself renders inside an `aria-busy` log, whose announcements are held
 * until the answer replaces it (WaitStage.tsx), so a separate status says it.
 */
export async function waitLineHeard(page: Page): Promise<string[]> {
  const heard = await page.evaluate(() => {
    const norm = (s: string | null) => (s || '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const stage = document.querySelector('[data-testid="wait-stage"]');
    if (!stage) return 'no wait line on screen';
    const drawn = norm(stage.textContent);
    const live = [...document.querySelectorAll<HTMLElement>('[role="status"],[role="alert"],[aria-live="polite"],[aria-live="assertive"]')];
    const ok = live.some((el) => {
      if (el.closest('[aria-busy="true"]')) return false;
      const said = norm(el.textContent);
      return said.length > 0 && drawn.includes(said);
    });
    return ok ? '' : 'rules:wait-line-live (serious, 4.1.3): no live region outside an aria-busy region says the wait line\'s stage';
  });
  return heard ? [heard] : [];
}

/**
 * WCAG 1.4.10: the primary action is on screen and a tap at its centre
 * reaches it. An overflow-hidden ancestor can cut it off without widening the
 * document. The clip probe (e2e/a11y-reflow.ts) sees the
 * cut at phone width on every screen; this check adds the tap, and runs at
 * every width.
 */
export async function primaryActionReachable(page: Page, selector: string): Promise<string[]> {
  const verdict = await page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    let vis = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const c = e.getBoundingClientRect();
      vis = { l: Math.max(vis.l, c.left), t: Math.max(vis.t, c.top), r: Math.min(vis.r, c.right), b: Math.min(vis.b, c.bottom) };
    }
    vis = { l: Math.max(vis.l, 0), t: Math.max(vis.t, 0), r: Math.min(vis.r, window.innerWidth), b: Math.min(vis.b, window.innerHeight) };
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const inside = cx >= vis.l && cx < vis.r && cy >= vis.t && cy < vis.b;
    const hit = inside ? document.elementFromPoint(cx, cy) : null;
    const area = Math.max(1, r.width * r.height);
    const shown = Math.max(0, vis.r - vis.l) * Math.max(0, vis.b - vis.t);
    return { reachable: !!hit && (hit === el || el.contains(hit)), visible: Math.round((100 * shown) / area) };
  });
  return verdict.reachable
    ? []
    : [`probe:primary-action-clipped (serious, 1.4.10): ${selector} is ${verdict.visible}% visible and a tap at its centre does not reach it`];
}

/**
 * A modal dialog keeps keyboard focus inside itself, closes with
 * Escape and gives focus back to the control that opened it.
 */
async function dialogKeepsFocus(page: Page, dialog: string, opener: string): Promise<string[]> {
  const out: string[] = [];
  const inside = () => page.evaluate((sel) => !!document.activeElement && !!document.querySelector(sel)?.contains(document.activeElement), dialog);
  if (!(await inside())) out.push('dialog: focus is not inside the dialog when it opens');
  const stops = await page.locator(dialog).evaluate(
    (d) => d.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])').length,
  );
  for (let i = 0; i < stops + 2; i++) {
    await page.keyboard.press('Tab');
    if (!(await inside())) {
      out.push(`dialog: Tab leaves the dialog after ${i + 1} press(es)`);
      break;
    }
  }
  for (let i = 0; i < stops + 2; i++) {
    await page.keyboard.press('Shift+Tab');
    if (!(await inside())) {
      out.push(`dialog: Shift+Tab leaves the dialog after ${i + 1} press(es)`);
      break;
    }
  }
  await page.keyboard.press('Escape');
  if (await page.locator(dialog).isVisible().catch(() => false)) out.push('dialog: Escape does not close it');
  else if (!(await page.evaluate((sel) => !!document.activeElement?.matches(sel), opener))) out.push('dialog: focus does not return to the control that opened it');
  return out;
}

/**
 * A modal dialog makes the page behind it inert. Every
 * visible control outside the dialog must be out of reach: inside an `inert`
 * subtree, behind a native modal `<dialog>` (which makes the rest of the
 * document inert), or covered so that a tap at its centre lands on something
 * else. A control a pointer can still reach behind an `aria-modal` panel is a
 * finding: a screen-reader user is told the rest of the page is gone while a
 * pointer can still change it.
 */
async function pageBehindInert(page: Page, dialog: string): Promise<string[]> {
  const reachable = await page.evaluate((sel) => {
    const box = document.querySelector(sel);
    if (!box) return -1;
    const nativeModal = !!document.querySelector('dialog:modal');
    const focusable = document.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    );
    let open = 0;
    for (const el of focusable) {
      if (box.contains(el)) continue;
      if (el.closest('[inert]')) continue;
      if (nativeModal && !el.closest('dialog:modal')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) continue;
      const hit = document.elementFromPoint(cx, cy);
      if (hit && (hit === el || el.contains(hit))) open += 1;
    }
    return open;
  }, dialog);
  if (reachable < 0) return ['dialog: not on screen for the inert check'];
  return reachable === 0 ? [] : [`dialog: the page behind is not inert (${reachable} control(s) outside the modal still take a tap at their centre)`];
}

/** Both modal checks, inert first (the focus walk ends by closing the dialog). */
export function modalChecks(dialog: string, opener: string) {
  return async (page: Page): Promise<string[]> => [
    ...(await pageBehindInert(page, dialog)),
    ...(await dialogKeepsFocus(page, dialog, opener)),
  ];
}

export const stubCounts = async (): Promise<string> => {
  const res = await fetch(`${AI_STUB_URL}/__stub/counts`);
  return JSON.stringify((await res.json()).counts ?? {});
};
