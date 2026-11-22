/**
 * The layout the readable render snapshots are written in (support/markup-snapshot.ts) keeps two different
 * renders apart: a line break the layout adds between two tags never reads like one the render holds.
 */
import { describe, expect, it } from 'vitest';
import { markupLines, namedMarkup } from './support/markup-snapshot';

describe('markupLines', () => {
  it('puts every pair of adjacent tags on lines of their own', () => {
    expect(markupLines('<ul><li>One</li><li>Two</li></ul>')).toBe('<ul>\n<li>One</li>\n<li>Two</li>\n</ul>');
  });

  it('writes a rendered line break between two tags so it differs from an added one', () => {
    const joined = '<p>A</p><p>B</p>';
    const broken = '<p>A</p>\n<p>B</p>';
    expect(markupLines(broken)).toBe('<p>A</p>&#10;<p>B</p>');
    expect(markupLines(broken)).not.toBe(markupLines(joined));
    expect(namedMarkup({ one: broken })).not.toBe(namedMarkup({ one: joined }));
  });

  it('leaves every other character of the render as it is', () => {
    expect(markupLines('<pre>a\nb</pre> <span>\n x</span>')).toBe('<pre>a\nb</pre> <span>\n x</span>');
  });
});
