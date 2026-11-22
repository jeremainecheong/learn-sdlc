import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Implementation room,
 * passed, Review selected, at Chrome 200 per cent (about 960 by 527 CSS px)
 * and 125 per cent. At 200 "Take the quick check" ran under "Run tests", and
 * the header, the band, the panel switches and the view tabs filled the window
 * so no scroll reached the review; at 125 the phase's place was hidden.
 *
 * jsdom lays nothing out, so this reads the room stylesheet, as
 * quick-check-phone does, and holds the three rules that answer it. The
 * browser e2e on the merged head measures the boxes.
 */
const css = readFileSync(resolve(__dirname, '../components/workspace/phase-experience.css'), 'utf8');
/** The body of the one media block that opens with `head`. */
const block = (head: string): string => {
  const at = css.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error(`unclosed ${head}`);
};

describe('at 960 px wide: the quick check takes a row of its own, so nothing on the header overlaps', () => {
  const narrow = block('@media(min-width:701px) and (max-width:1023px){.phase-header>.quick-check-line-inline{');
  it('a full-width row at the header\'s foot', () => {
    expect(narrow).toMatch(/\.phase-header>\.quick-check-line-inline\{[^}]*flex:\s*1 0 100%/);
    expect(narrow).toMatch(/\.phase-header>\.quick-check-line-inline\{[^}]*order:\s*9/);
    expect(narrow).toMatch(/\.phase-header>\.quick-check-line-inline\{[^}]*flex-wrap:\s*wrap/);
  });
  it('its words and buttons wrap inside that row; none is cut or held to 76 px', () => {
    expect(narrow).toMatch(/\.quick-check-text\{[^}]*width:\s*auto/);
    expect(narrow).toMatch(/\.quick-check-text\{[^}]*white-space:\s*normal/);
    expect(narrow).toMatch(/\.quick-check-actions\{[^}]*flex-wrap:\s*wrap/);
    expect(narrow).toMatch(/\.quick-check-actions \.btn-sm\{[^}]*white-space:\s*normal/);
  });
  it('comes after the wider rule it narrows, so it wins the cascade', () => {
    expect(css.indexOf(narrow)).toBeGreaterThan(css.indexOf('@media(min-width:701px) and (max-width:1279px){.phase-strip-approved.phase-header{'));
  });
});

describe('at 125 per cent: the phase\'s place stays on the row where it costs no line', () => {
  const HIDE = '@media(min-width:701px) and (max-width:1279px){.phase-header:has(>.quick-check-line-inline) .phase-header-place{display:none}}';
  const SHOW = '@media(min-width:701px) and (max-width:1023px),(min-width:1152px) and (max-width:1279px){.phase-header:has(>.quick-check-line-inline) .phase-header-place{display:inline}}';
  /** Every media block in the sheet that shows or hides the place beside a quick check. */
  const placeRules = css.match(/@media[^{]*\{\.phase-header:has\(>\.quick-check-line-inline\) \.phase-header-place\{display:[a-z]+\}\}/g) ?? [];
  it('shown where the wider rule hides it beside a quick check from 1152 px (1440 at 125 per cent) and under 1024 px, and later in the sheet', () => {
    const hide = css.indexOf(HIDE);
    const show = css.indexOf(SHOW);
    expect(hide).toBeGreaterThan(-1);
    expect(show).toBeGreaterThan(hide);
  });
  it('from 1024 to 1151 px (1366 at 125 per cent is 1093) it stays hidden by the wider rule, so Submit keeps the one 55 px line and the editor its height', () => {
    // The hide rule and the show rule are the only two; the show rule's ranges end at 1023
    // and start at 1152, so in 1024 to 1151 the hide rule is the one that applies.
    expect(placeRules).toEqual([HIDE, SHOW]);
    const ranges = [...SHOW.matchAll(/\(min-width:(\d+)px\) and \(max-width:(\d+)px\)/g)].map(m => [Number(m[1]), Number(m[2])]);
    expect(ranges).toEqual([[701, 1023], [1152, 1279]]);
    const shownAt = (w: number) => ranges.some(([lo, hi]) => w >= lo && w <= hi);
    for (const w of [1024, 1093, 1151]) expect(shownAt(w), `${w} px`).toBe(false);
    for (const w of [701, 960, 1023, 1152, 1279]) expect(shownAt(w), `${w} px`).toBe(true);
  });
  it('the row wraps in that range, so the place moves rather than overlaps', () => {
    expect(block('@media(min-width:701px) and (max-width:1279px){.phase-strip-approved.phase-header{')).toMatch(/flex-wrap:\s*wrap/);
  });
});

describe('on a short window: the room\'s chrome scrolls with the page', () => {
  const short = block('@media(min-width:701px) and (max-height:600px){');
  it('the code rooms\' page scrolls, and its inner column grows to its content', () => {
    expect(short).toMatch(/main\[data-testid=workspace-page\]\{overflow-y:\s*auto\}/);
    expect(short).toMatch(/main\[data-testid=workspace-page\]>div:last-child\{flex:\s*none;overflow:\s*visible\}/);
    expect(short).toMatch(/\.workspace-room-scroll\{flex:\s*none;overflow:\s*visible\}/);
  });
  it('the working area keeps a height that fits under the top bar (527 px tall: 431 px)', () => {
    expect(short).toMatch(/\.phase-lab-workspace\{[^}]*height:\s*max\(320px,\s*calc\(100dvh - 96px\)\)/);
    expect(short).toMatch(/\.phase-lab-workspace\{[^}]*flex:\s*none/);
  });
  it('phones (700 px and under) are not touched: their own rules stand', () => {
    expect(short.startsWith('@media(min-width:701px)')).toBe(true);
    expect(css).toMatch(/@media\(max-width:700px\)\{\.quick-check-line-inline\{flex:1 0 100%;order:9;/);
  });
});
