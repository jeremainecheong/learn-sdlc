import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The room header's optional quick check at 1280 px ("Optional Quick check before you start 6 questions, not
 * graded." with Take the quick check and Later) would be cut with an ellipsis where the header's row runs out
 * (`.quick-check-line-inline .quick-check-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`). From
 * 1280 to 1439 px the words wrap onto a second line inside the 55 px header instead (two lines at most),
 * and on a code room's header (the one that holds Run tests) the count steps out, as it already does on a document
 * page from 1280 to 1365 px and on every header under 1280. Neither button is touched.
 *
 * jsdom lays nothing out, so this reads the room stylesheet, as header-zoom-styles and quick-check-phone do.
 */
const css = readFileSync(resolve(__dirname, '../components/workspace/phase-experience.css'), 'utf8');
const HEAD = '@media(min-width:1280px) and (max-width:1439px){.phase-header>.quick-check-line-inline .quick-check-text{';
const ruleOf = (head: string): string => {
  const at = css.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error(`unclosed ${head}`);
};

describe('the header quick check from 1280 to 1439 px', () => {
  const block = ruleOf(HEAD);

  it('wraps onto two lines at most instead of ending in an ellipsis', () => {
    const text = block.slice(block.indexOf('.quick-check-text{'), block.indexOf('}') + 1);
    expect(text).toMatch(/white-space:normal/);
    expect(text).toMatch(/text-overflow:clip/);
    expect(text).toMatch(/-webkit-line-clamp:2/);
    // two 17 px lines are 34 px, inside the header's 55 px row with its 6 px padding
    expect(text).toMatch(/line-height:17px/);
    expect(2 * 17).toBeLessThanOrEqual(55 - 2 * 6);
  });

  it("on a code room's header, the one that holds Run tests, the count steps out; the title, the Optional label and both buttons stay", () => {
    expect(block).toContain('.phase-header:has([data-testid=header-run])>.quick-check-line-inline [data-testid=concept-prompt-body]{display:none}');
    expect(block).not.toMatch(/concept-prompt-(title|optional|start|skip)/);
    expect(block).not.toMatch(/quick-check-actions/);
  });

  it('stops at 1439 px, so 1440 px and wider are not touched by it', () => {
    expect(block.startsWith('@media(min-width:1280px) and (max-width:1439px){')).toBe(true);
  });
});
