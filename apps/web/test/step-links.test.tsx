// @vitest-environment jsdom
/**
 * A link of the row of
 * steps above a builder's cards lands its card's head below the sticky tab
 * bar, however tall the bar has wrapped. The card's scroll margin is the bar's
 * measured height and a gap, the editor's own BELOW_BAR rule, where it was a
 * fixed 80 px that a bar wrapped to two lines (a narrow window, a long save
 * line) covered. That each link names its own card is pressed in each
 * builder's test (`test/support/step-links.ts`); jsdom lays nothing out, so
 * the margin is read from the stylesheet.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BAR_HEIGHT_VAR, BELOW_BAR } from '@/components/staff/projects/page-frame';

describe('a step link lands the card head below the sticky bar', () => {
  const css = readFileSync(resolve(__dirname, '../components/staff/projects/requirements/requirements-builder.css'), 'utf8');
  it("the card's scroll margin is the bar's measured height and the editor's 16 px gap", () => {
    const rule = css.match(/\.tre-card\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('scroll-margin-top:calc(var(--editor-bar-h,64px) + 16px)');
    expect(rule).not.toContain('scroll-margin-top:80px');
    // The same variable and gap as every other scrolled-to place in the editor.
    expect(BAR_HEIGHT_VAR).toBe('--editor-bar-h');
    expect(BELOW_BAR).toBe('scroll-mt-[calc(var(--editor-bar-h,0px)_+_16px)]');
  });
});
