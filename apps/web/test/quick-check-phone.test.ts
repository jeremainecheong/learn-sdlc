import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The quick check sits on the header strip as one line. The strip wraps
 * under 700 px (shell-fidelity.css); unwrapped, "Take the
 * quick check" would be cut at the viewport's edge at 360 and 390 px (WCAG 1.4.10).
 * On phones the line now takes a row of its own, its title and its buttons
 * wrapping inside the viewport. jsdom lays nothing out, so this reads the
 * sheet, as case-file-tabs.test.ts does.
 */

const css = readFileSync(resolve(__dirname, '../components/workspace/phase-experience.css'), 'utf8');
const phone = css.slice(css.indexOf('@media(max-width:700px){.quick-check-line-inline{'));
const block = phone.slice(0, phone.indexOf('\n'));

describe('the quick-check line on phones', () => {
  it('takes a full row of its own at the strip\'s foot', () => {
    expect(block).toMatch(/\.quick-check-line-inline\{[^}]*flex:\s*1 0 100%/);
    expect(block).toMatch(/\.quick-check-line-inline\{[^}]*order:\s*9/);
    expect(block).toMatch(/\.quick-check-line-inline\{[^}]*flex-wrap:\s*wrap/);
  });

  it('lets its title and its buttons wrap instead of overflowing', () => {
    expect(block).toMatch(/\.quick-check-text\{[^}]*white-space:\s*normal/);
    expect(block).toMatch(/\.quick-check-text\{[^}]*overflow:\s*visible/);
    expect(block).toMatch(/\.quick-check-actions\{[^}]*flex-wrap:\s*wrap/);
    expect(block).toMatch(/\.quick-check-actions \.btn-sm\{[^}]*max-width:\s*100%/);
  });

  it('lets the line drawn above a room wrap by the word on a narrow column', () => {
    const at = css.indexOf('@media(max-width:700px){.quick-check-line{');
    expect(at).toBeGreaterThanOrEqual(0);
    const narrow = css.slice(at, css.indexOf('\n', at));
    expect(narrow).toMatch(/\.quick-check-actions \.btn-sm\{[^}]*overflow-wrap:\s*anywhere/);
    expect(narrow).toMatch(/\.quick-check-actions \.btn-sm\{[^}]*max-width:\s*100%/);
    expect(narrow).toMatch(/\.quick-check-actions\{[^}]*flex-wrap:\s*wrap/);
  });

  it('hides the strip\'s place label where the strip wraps', () => {
    expect(css).toMatch(/@media\(max-width:700px\)\{\.phase-strip-approved>\.phase-header-place\{display:none\}\}/);
  });
});

/**
 * At 125 per cent zoom, 1366 and 1440 are 1093 and 1152 CSS px. There a row
 * holding a credited chip and an offered quick check is too narrow, and the
 * quick check's buttons could overlap Run tests (10 cases with the sidebar
 * collapsed, more with it pinned). The header row (a fixed 55 px, nowrap)
 * wraps where it has no room, from 701 to 1279 px and to
 * 1439 px with the sidebar pinned open, so what does not fit moves to a second
 * line instead of overlapping; where everything fits it stays one line. The
 * e2e workspace-viewport spec measures the row in the app at every size, with
 * the longest chip and with the sidebar pinned.
 */
describe('the header row at 1093 and 1152 CSS px (125 per cent zoom)', () => {
  const blockAt = (start: string) => {
    const at = css.indexOf(start);
    expect(at, start).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('\n', at));
  };
  const collapsed = blockAt('@media(min-width:701px) and (max-width:1279px){.phase-strip-approved.phase-header{');
  const pinned = blockAt('@media(min-width:701px) and (max-width:1439px){html[data-sidebar="full"] .phase-strip-approved.phase-header{');

  it.each([['sidebar collapsed', 1093], ['sidebar collapsed', 1152], ['sidebar pinned', 1093], ['sidebar pinned', 1152], ['sidebar pinned', 1366]])('%s at %i px: the row wraps instead of overlapping', (sidebar, width) => {
    const block = sidebar === 'sidebar pinned' ? pinned : collapsed;
    expect(width).toBeGreaterThanOrEqual(701);
    expect(width).toBeLessThanOrEqual(Number(/max-width:(\d+)px/.exec(block)![1]));
    // Two classes, so it outranks shell-fidelity's one-class `.phase-strip-approved{height:55px}`
    // whatever order the sheets load in.
    expect(block).toMatch(/\.phase-strip-approved\.phase-header\{[^}]*height:\s*auto/);
    expect(block).toMatch(/\.phase-strip-approved\.phase-header\{[^}]*flex-wrap:\s*wrap/);
    // A wrapping row breaks by its items' widths before they shrink: the quick check counts
    // only what it cannot give up, so an "In progress" row that fits stays one line (the e2e
    // in-progress cases at 1093 and 1152 read 55 px), and it never shrinks below that.
    expect(block).toMatch(/\.quick-check-line-inline\{flex:\s*1 1 0;min-width:\s*min-content\}/);
    expect(block).toMatch(/\.quick-check-line-inline \.quick-check-text\{flex:\s*1 1 76px;width:\s*76px\}/);
  });

  it('keeps the quick check\'s "Optional" label on screen when its text gives way', () => {
    expect(css).toMatch(/\n\.quick-check-line-inline \.quick-check-text\{min-width:\s*76px\}/);
  });
});
