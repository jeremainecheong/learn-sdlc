import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * In the Compare window a file's diff does not swallow the wheel.
 *
 * The dialog's body (`.apv-main.apv-scroll`) is its one scroller. A file's changed lines inside it are drawn by ProposedFileDiff in a
 * `.agentic-diff-scroll` box, and its saved copy in `.agentic-complete-copy
 * pre`: both are the mentor column's own 340 px scrollers with
 * `overscroll-behavior: contain`. Inside the dialog that made a second
 * scroller that kept the wheel: measured by hand on a Maintenance proposal,
 * six notches over the diff rows left the body's scrollTop at 0 while the
 * rows under the fold were out of reach. Inside `.apv-scroll` both boxes lose
 * their 340 px height and their overscroll containment, and scroll only
 * sideways: `overflow-x: auto` keeps a line wider than the pane inside its
 * box (with `overflow: visible` it would scroll the whole body sideways, the
 * summary and the column heads with it), and keeps the box a real scrollable
 * region, so its tab stop and region role still mean something. `overflow-y: visible` computes to `auto` beside it, but
 * with no max-height the box is as tall as its rows and has nothing to
 * scroll vertically, so with `overscroll-behavior: auto` a vertical wheel
 * over it scrolls the body. In the mentor column the boxes keep their 340 px
 * height and their containment.
 *
 * jsdom lays nothing out, so this reads the stylesheets, as
 * `mentor-sticky-head.test.ts` does. No browser spec reaches a Compare
 * window with a file diff on the suite's AI stub (its Maintenance proposal
 * changes the record alone), so this is the pin.
 */
const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const compare = read('components/workspace/mentor/ProposalCompare.css');
const agentic = read('components/workspace/mentor/AgenticPanel.css');

/** The declarations of the top-level rule whose selector list is exactly `selector`. */
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open)).trim();
};

describe('the Compare window scrolls a file diff with its body', () => {
  it('lets the diff box and the saved copy scroll only sideways inside the one scrolling body', () => {
    const flat = rule(compare, '.apv-scroll .agentic-diff-scroll, .apv-scroll .agentic-complete-copy pre');
    expect(flat).toBe('max-height: none; overflow-x: auto; overflow-y: visible; overscroll-behavior: auto;');
  });

  it('never gives them back a height, a vertical scroller or the wheel', () => {
    const flat = rule(compare, '.apv-scroll .agentic-diff-scroll, .apv-scroll .agentic-complete-copy pre');
    expect(flat).not.toMatch(/overscroll-behavior(?:-[xy]|-block|-inline)?:\s*contain/);
    expect(flat).not.toMatch(/max-height:\s*[\d.]+px/);
    expect(flat).not.toMatch(/overflow-y:\s*(?:auto|scroll|hidden)/);
    // the shorthand would set the vertical axis too
    expect(flat).not.toMatch(/(?:^|;)\s*overflow:/);
  });

  it('sits beside the other flattening rules of the scrolling body', () => {
    const file = compare.indexOf('\n.apv-scroll .apv-file {');
    const diff = compare.indexOf('\n.apv-scroll .agentic-diff-scroll, .apv-scroll .agentic-complete-copy pre {');
    expect(file).toBeGreaterThanOrEqual(0);
    expect(diff).toBeGreaterThan(file);
    // directly after the file pane's own flattening rule
    expect(compare.slice(file, diff).trim().split('\n')).toHaveLength(1);
  });

  it('leaves the mentor column\'s own 340 px boxes unchanged', () => {
    expect(rule(agentic, '.agentic-diff-scroll')).toBe('max-height: 340px; overflow: auto; overscroll-behavior: contain;');
    expect(rule(agentic, '.agentic-complete-copy pre')).toBe('max-height: 340px; overflow: auto; padding: 10px; white-space: pre; font: 12px/1.65 var(--font-mono, monospace);');
  });

  it('keeps the body the one scroller', () => {
    expect(rule(compare, '.apv-scroll')).toMatch(/overflow-y:\s*auto/);
  });
});
