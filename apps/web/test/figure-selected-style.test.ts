/* One neutral selected look for every figure of the six guides. Drawn in the
 * guide's accent, a selection would be the green of "Passed" in Deployment (a
 * faulted container outlined green) and a red-pink beside the fail red in
 * Testing. A selection is an ink stroke over the tinted fill, set once in
 * figures.css, and green, red and amber are left for verdicts. Some figure
 * files name the selected colour --fig-accent; figures.css makes that name the
 * same ink, so every guide has the look without a per-figure change. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE_EXPERIENCE } from '@/components/phases/experience';

const LEARN = resolve(__dirname, '../components/learn');
const css = (path: string) => readFileSync(resolve(LEARN, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const FIGURE_CSS = ['figures/figures.css', 'figures/requirements-design.css', 'figures/implementation-testing.css', 'figures/deployment-maintenance.css'];
/** Rules that draw a selected, pressed, lit, open or current state. */
const SELECTED = /aria-pressed="true"|aria-expanded="true"|aria-current|data-current="true"|data-lit="true"|data-on="true"|data-filled="true"|data-state="lit"|-lit\b|:checked/;
/** What a selected state may be drawn with: the ink, its fill, and the grounds. */
const NEUTRAL = new Set(['--fig-selected', '--fig-selected-fill', '--fig-accent', '--fig-tint', '--fig-ground', '--fig-ink', '--guide-ink', '--guide-tint']);
const COLOUR_PROPS = /^(fill|stroke|color|background|background-color|border|border-color|border-left|box-shadow|outline|outline-color|accent-color)$/;

function rules(text: string) {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}
function token(text: string, name: string) {
  return new RegExp(`${name}:\\s*([^;]+);`).exec(text)?.[1].trim();
}

describe('the selected look in the guides’ figures', () => {
  it('sets one neutral ink for a selection, and makes --fig-accent the same ink', () => {
    const shared = css('figures/figures.css');
    const ink = token(shared, '--fig-selected');
    expect(ink).toBe('#17323f');
    expect(token(shared, '--fig-selected-fill')).toBe('var(--fig-tint)');
    expect(token(shared, '--fig-accent')).toBe('var(--fig-selected)');
    // Not a phase accent, and not a verdict colour.
    const verdicts = ['--fig-pass', '--fig-fail', '--fig-warn'].map((name) => token(shared, name));
    for (const colour of [...Object.values(PHASE_EXPERIENCE).map((one) => one.colour), ...verdicts]) expect(ink).not.toBe(colour);
  });

  it('never reads the phase accent inside a figure', () => {
    for (const file of FIGURE_CSS) expect(css(file), file).not.toMatch(/--phase-accent/);
  });

  it.each(FIGURE_CSS)('%s draws every selected state with the neutral look only', (file) => {
    const selected = rules(css(file)).filter((rule) => SELECTED.test(rule.selector));
    expect(selected.length, file).toBeGreaterThan(0);
    for (const rule of selected) {
      for (const declaration of rule.body.split(';').map((d) => d.trim()).filter(Boolean)) {
        const [prop, ...rest] = declaration.split(':');
        if (!COLOUR_PROPS.test(prop.trim())) continue;
        const value = rest.join(':');
        const names = [...value.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
        for (const name of names) expect(NEUTRAL.has(name), `${file} ${rule.selector}: ${declaration}`).toBe(true);
        expect(value, `${file} ${rule.selector}: ${declaration}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
      }
    }
  });

  it('holds Design 1’s filled contract slot to the neutral look: an ink outline, on data-filled, not aria-pressed', () => {
    const design = rules(css('figures/requirements-design.css'));
    const filled = design.filter((rule) => rule.selector === '.fig-ds-slot[data-filled="true"]');
    expect(filled).toHaveLength(1);
    expect(SELECTED.test(filled[0].selector)).toBe(true);
    expect(filled[0].body).toContain('border-color: var(--fig-ink)');
    expect(design.filter((rule) => rule.selector.includes('.fig-ds-slot[aria-pressed'))).toHaveLength(0);
  });

  it('draws the chosen practice card, the open phase and "You are here" on the map in ink, not the accent', () => {
    const lessons = rules(css('lessons.css'));
    const find = (selector: string) => lessons.filter((rule) => rule.selector === selector).map((rule) => rule.body).join(';');
    for (const selector of ['.lesson-practice label:has(input:checked)', '.phase-map-node[aria-expanded="true"]', '.phase-map-item[data-state="current"] .phase-map-glyph']) {
      const body = find(selector);
      expect(body, selector).toContain('var(--guide-ink)');
      expect(body, selector).not.toMatch(/phase-accent/);
    }
  });
});
