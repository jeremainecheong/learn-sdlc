import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Small rules of the room stylesheet. jsdom lays nothing out, so this reads
 * the sheet, as header-zoom-styles does; the browser e2e measures the boxes (a11y-axe reflow at 320 px and pinned
 * 360 to 460 px; a 1280 by 600 Requirements and Design room).
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

describe('More draws no empty rule where no reset or retry is offered', () => {
  it('the retry slot is not drawn while it is empty', () => {
    expect(css).toContain('.phase-header .phase-header-retry:empty{display:none}');
  });
});

describe('the credit words wrap at phone width instead of running past the row', () => {
  it('the header\'s state chip may shrink and wrap under 700 px, and only there', () => {
    const phone = block('@media(max-width:700px){.phase-header>.chip{');
    expect(phone).toMatch(/\.phase-header>\.chip\{[^}]*flex-shrink:1/);
    expect(phone).toMatch(/\.phase-header>\.chip\{[^}]*min-width:0/);
    expect(phone).toMatch(/\.phase-header>\.chip\{[^}]*height:auto/);
    expect(phone).toMatch(/\.phase-header>\.chip\{[^}]*white-space:normal/);
    // Wider, the chip keeps its one line.
    expect(css).toContain('.phase-header>.chip{flex-shrink:0}');
  });
  it('the story row\'s state wraps inside the row where the row already wraps (1023 px and under)', () => {
    const narrow = block('@media(max-width:1023px){.jira-issue-row small{white-space:normal');
    expect(narrow).toMatch(/\.jira-issue-row small\{[^}]*max-width:calc\(100% - 25px\)/);
  });
});

describe('Requirements and Design scroll their chrome away on a wide, short window', () => {
  const short = block('@media(min-width:1024px) and (max-height:600px){');
  it('Requirements: the page scrolls and the room keeps a height under the top bar', () => {
    expect(short).toMatch(/main\[data-testid=requirements-workspace\]\{overflow-y:auto\}/);
    expect(short).toMatch(/main\[data-testid=requirements-workspace\]>div:last-child\{flex:none;overflow:visible\}/);
    expect(short).toMatch(/\.requirements-workspace-room\{flex:none;min-height:0;height:max\(320px,calc\(100dvh - 96px\)\)\}/);
  });
  it('Design: the same', () => {
    expect(short).toMatch(/#main\[data-testid=design-page\]\{overflow-y:auto\}/);
    expect(short).toMatch(/#main\[data-testid=design-page\]>div:last-child\{flex:none;overflow:visible\}/);
    expect(short).toMatch(/\.design-room\{flex:none;min-height:0;height:max\(320px,calc\(100dvh - 96px\)\)\}/);
  });
  it('from 1024 px only: narrower windows keep the rules that already scroll them, and phones are untouched', () => {
    expect(short.startsWith('@media(min-width:1024px) and (max-height:600px)')).toBe(true);
  });
});

describe('the header note keeps one line in the 55 px row', () => {
  it('from 701 px it does not wrap: it is cut with an ellipsis and never draws past its box', () => {
    const wide = block('@media(min-width:701px){.phase-header .phase-header-note{');
    expect(wide).toMatch(/\.phase-header-note\{[^}]*white-space:nowrap/);
    expect(wide).toMatch(/\.phase-header-note\{[^}]*overflow:hidden/);
    expect(wide).toMatch(/\.phase-header-note\{[^}]*text-overflow:ellipsis/);
  });
  it('it may still shrink (min-width 0), so it gives way to its neighbours rather than overlap them', () => {
    expect(css).toMatch(/\.phase-header \.phase-header-note\{flex:0 1 auto;min-width:0;/);
  });
});
