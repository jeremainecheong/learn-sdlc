import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The case file's section tabs stay clickable on the brief page
 * (browser proof: e2e/phase-brief.spec.ts).
 *
 * At 1280 and 1440 wide, the case file's section tabs ("Your mission", "What
 * you will produce", "Review criteria") can end up unclickable, with the point
 * at a tab's centre on `.phase-case-panel`. The cause is flex shrinking, not
 * stacking. `.phase-document-content` is a column flex
 * box that scrolls (`min-height:0`), the case file inside it is a column flex
 * box allowed to shrink (`min-height:0`), and of its children only the tab
 * row has `overflow:auto`, which makes its automatic minimum height zero.
 * A long mission panel therefore squeezes the tab row to its border, the
 * tabs overflow a box that clips them, and the panel sits where they are
 * drawn. The tab row must not shrink.
 *
 * jsdom lays nothing out, so this reads the stylesheet the page loads, as
 * `split-phase-room-reads.test.tsx` does for the workspace floor. The browser proof is
 * the e2e spec.
 */

const css = readFileSync(resolve(__dirname, '../components/workspace/phase-experience.css'), 'utf8');

/** Every declaration block whose selector list is exactly `selector`. */
const blocks = (selector: string): string[] => {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.replace(/\s+/g, ''));
    if (selectors.includes(selector.replace(/\s+/g, ''))) out.push(m[2]);
  }
  return out;
};

describe('the case file’s section tabs', () => {
  it('sit in a case file that may shrink inside a scrolling column (the premise)', () => {
    expect(blocks('.phase-document-content').join(';')).toMatch(/flex-direction:\s*column/);
    expect(blocks('.phase-case-file').join(';')).toMatch(/min-height:\s*0/);
    expect(blocks('.phase-case-file>nav').join(';')).toMatch(/overflow:\s*auto/);
  });

  it('are in a row that never shrinks, so the panel below cannot take their place', () => {
    const nav = blocks('.phase-case-file>nav').join(';');
    expect(nav).toMatch(/(^|;)\s*(flex:\s*none|flex-shrink:\s*0)\s*(;|$)/);
  });
});
