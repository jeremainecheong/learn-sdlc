import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The designed states of the product's controls and the shell's geometry,
 * asserted where they are written. The browser proof of the rail is
 * `e2e/shell.spec.ts` (it measures the rail at 76px); these guard the rules a
 * restyle could quietly drop. The controls are styled by
 * components/ui/controls.css, so the rings and the busy state are pinned at
 * that sheet's values.
 */
const web = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const flat = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const text = flat(css);
  const at = text.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const open = text.indexOf('{', at);
  return text.slice(open + 1, text.indexOf('}', open));
}

const BUTTONS = ':is(.btn, .btn-primary, .btn-secondary, .btn-quiet, .btn-ghost, .btn-danger)';

describe('the controls keep their designed states', () => {
  const controls = web('components/ui/controls.css');

  it('draws a visible accent ring on a focused button', () => {
    expect(rule(controls, `${BUTTONS}:focus-visible`)).toMatch(/outline: 3px solid rgb\(var\(--c-accent\)\)/);
  });

  it('greys a disabled button and stops the pointer', () => {
    const disabled = rule(controls, `${BUTTONS}:is(:disabled, [aria-disabled="true"])`);
    expect(disabled).toMatch(/cursor: not-allowed/);
    expect(disabled).toMatch(/color: rgb\(var\(--c-muted\)\)/);
  });

  it('keeps a busy button labelled, in the accent on its tint, with the progress cursor', () => {
    const busy = rule(controls, `${BUTTONS}[aria-busy="true"]`);
    expect(busy).toMatch(/cursor: progress/);
    expect(busy).toMatch(/color: rgb\(var\(--c-accent\)\)/);
    expect(busy).toMatch(/background: rgb\(var\(--c-tint\)\)/);
  });

  it('rings a focused field in the accent and an invalid one in the fail colour', () => {
    const focused = rule(controls, '.field:focus-visible');
    expect(focused).toMatch(/outline: 2px solid rgb\(var\(--c-accent\)\)/);
    expect(focused).toMatch(/box-shadow: 0 0 0 5px rgb\(var\(--c-tint\)\)/);
    const invalid = rule(controls, '.field[aria-invalid="true"]:focus-visible');
    expect(invalid).toMatch(/outline-color: rgb\(var\(--c-fail\)\)/);
    expect(invalid).toMatch(/box-shadow: 0 0 0 5px rgb\(var\(--c-failtint\)\)/);
    expect(rule(controls, '.field[aria-invalid="true"]')).toMatch(/border-color: rgb\(var\(--c-fail\)\)/);
  });

  it('keeps the small button at 34px or more', () => {
    const min = Number(/min-height: (\d+)px/.exec(rule(controls, '.btn-sm'))?.[1]);
    expect(min).toBeGreaterThanOrEqual(34);
  });

  it('turns the transitions off under reduced motion', () => {
    expect(flat(controls)).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ :is\(\.btn, [^{]+\) \{ transition: none;/);
  });
});

describe('the shell keeps its geometry', () => {
  it('holds the rail at 76px, the width the e2e shell suite measures', () => {
    expect(rule(web('components/shell/shell-fidelity.css'), '.signed-in-frame')).toMatch(/--side-width: 76px;/);
  });
});
