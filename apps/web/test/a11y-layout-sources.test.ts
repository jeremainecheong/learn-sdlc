import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorNav } from '@/components/staff/projects/EditorNav';
import { Tabs } from '@/components/ui';
import { moduleText, webSource } from './support/source-text';

/**
 * Three accessibility rules whose fix is a stylesheet rule or a class,
 * asserted where they are written. The browser proof is
 * `e2e/a11y-axe.spec.ts` (its phase-strip probe and axe target-size).
 *
 * - Focus on the code editor. Monaco takes focus in a 1px hidden textarea, so
 *   the global ring (`[tabindex]:focus-visible`, `textarea:focus-visible`) is
 *   drawn on nothing a learner can see, which leaves the IDE rooms and the
 *   requirements task room's editor with no visible focus. The editor draws
 *   the ring itself while it holds focus.
 * - The phase strip on a phone. The strip wraps, and its primary actions must
 *   too: as one unshrinkable row, with the sidebar pinned, the Submit button
 *   sits under the change page's overflow-hidden main, 0% visible at 360 and
 *   390px. The row may shrink to the strip and wrap its buttons, and a button
 *   may wrap its own words.
 * - target-size. The design model's cardinality selects, whose choices can be
 *   one character, must be at least 24px both ways at 390px (WCAG 2.5.8).
 */
// Stylesheets by path; components by a name they export, so a moved file is still found.
const web = (path: string) => webSource(path);
const flat = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

/** The declarations of `selector` inside the first `@media (max-width: 700px)` block. */
function phoneRule(css: string, selector: string): string {
  const text = flat(css);
  const start = text.search(/@media ?\(max-width: ?700px\) ?\{/);
  expect(start, 'the phone block').toBeGreaterThanOrEqual(0);
  let depth = 0;
  let end = start;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const body = text.slice(text.indexOf('{', start) + 1, end);
  const rules = body.split('}').map((r) => r.trim()).filter(Boolean);
  return rules
    .filter((r) => r.split('{')[0].trim() === selector)
    .map((r) => r.slice(r.indexOf('{') + 1))
    .join(';');
}

describe('the code editor shows where focus is', () => {
  it('draws a ring on the editor while its hidden input holds focus', () => {
    const css = flat(web('app/globals.css'));
    const rule = /\.monaco-editor:focus-within ?\{([^}]*)\}/.exec(css);
    expect(rule, '.monaco-editor:focus-within').not.toBeNull();
    expect(rule![1]).toMatch(/outline: ?2px solid rgb\(var\(--c-accent\)\)/);
  });
});

describe('the phase strip never cuts off its primary action on a phone', () => {
  const css = web('components/shell/shell-fidelity.css');

  it('lets the primary row shrink to the strip and wrap', () => {
    const decls = phoneRule(css, '.phase-strip-primary');
    expect(decls).toMatch(/flex-wrap: ?wrap/);
    expect(decls).toMatch(/flex-shrink: ?1/);
    expect(decls).toMatch(/min-width: ?0/);
    expect(decls).toMatch(/max-width: ?100%/);
  });

  it('lets a primary button wrap its own words rather than run past the edge', () => {
    const decls = phoneRule(css, '.phase-strip-primary > *');
    expect(decls).toMatch(/max-width: ?100%/);
    expect(decls).toMatch(/white-space: ?normal/);
  });
});

describe('target-size: the design model draws no control under 24px', () => {
  for (const end of ['from', 'to']) {
    it(`the ${end} cardinality select keeps a 24px floor in both directions`, () => {
      const src = moduleText('RelationsCard');
      const at = src.indexOf(`data-testid={\`design-board-relation-\${i}-${end}-card\`}`);
      expect(at).toBeGreaterThan(0);
      const open = src.lastIndexOf('<SelectCell', at);
      const cls = /className="([^"]*)"/.exec(src.slice(open, at))![1].split(/\s+/);
      const px = (prefix: string) =>
        cls.map((c) => new RegExp(`^${prefix}-\\[(\\d+)px\\]$`).exec(c)).find(Boolean)?.[1];
      expect(Number(px('min-w') ?? 0)).toBeGreaterThanOrEqual(24);
      expect(Number(px('min-h') ?? 0)).toBeGreaterThanOrEqual(24);
    });
  }
});

/**
 * The project editor's phase row is six tabs in one `flex` tablist. Without
 * wrapping, at 390px the row is wider than the panel, each tab shrinks below
 * its label, the labels draw over each other, and a tap on Design lands on
 * Implementation. The row wraps, and a tab keeps its label's width. The
 * phases are tabs in the editor's one row of section tabs (`EditorNav`),
 * nine of them, so that row is the one that must wrap.
 */
describe('reflow: the project editor keeps each phase tab whole on a phone', () => {
  // Rendered to markup: the classes are what the browser receives.
  const classesOf = (html: string, tag: string, attribute: string) =>
    [...html.matchAll(new RegExp(`<${tag}\\b[^>]*${attribute}[^>]*>`, 'g'))].map((m) => /class="([^"]*)"/.exec(m[0])?.[1].split(/\s+/) ?? []);

  it('the editor asks its phase row to wrap, and each tab keeps its label\'s width', () => {
    const html = renderToStaticMarkup(
      createElement(EditorNav, {
        phases: [{ key: 'requirements', label: 'Requirements' }, { key: 'design', label: 'Design' }] as never,
        value: 'overview',
        onChange: () => undefined,
      }),
    );
    const [row] = classesOf(html, 'div', 'role="tablist"');
    expect(row, 'the section row').toContain('flex-wrap');
    const tabs = classesOf(html, 'button', 'role="tab"');
    expect(tabs.length).toBeGreaterThan(3);
    for (const tab of tabs) expect(tab).toContain('shrink-0');
  });

  it('a tab that does not fill its row never shrinks below its label', () => {
    const tabs = (fill: boolean) =>
      classesOf(renderToStaticMarkup(createElement(Tabs, { items: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], value: 'a', onChange: () => undefined, fill })), 'button', 'role="tab"');
    for (const tab of tabs(false)) expect(tab).toEqual(expect.arrayContaining(['shrink-0']));
    for (const tab of tabs(true)) expect(tab).toContain('flex-1');
  });
});

/*
 * Reflow at 390px (WCAG 1.4.10). A name input with a fixed minimum width
 * (`min-w-[160px] flex-1`) beside a Remove button needs a row that wraps:
 * on a non-wrapping row the button is pushed past the card's edge and
 * clipped (axe, the Design builder's Starting point step at 390). Every such
 * row in the Design room's cards wraps.
 */
describe('reflow: a design card never clips the button beside a sized name input', () => {
  const cards = ['OperationsCard', 'RelationsCard', 'DecisionsCard'];
  for (const path of cards) {
    it(`${path}: the row around each sized input wraps`, () => {
      const src = moduleText(path);
      const sized = [...src.matchAll(/min-w-\[\d+px\] flex-1/g)].map((m) => m.index!);
      for (const at of sized) {
        // The nearest flex row opened before the input is the one it sits in.
        const rows = [...src.slice(0, at).matchAll(/<(?:div|header|Panel)[^>]*className="(flex [^"]*)"/g)];
        const row = rows[rows.length - 1]?.[1] ?? '';
        expect(row.split(/\s+/), `${path} at ${at}`).toContain('flex-wrap');
      }
    });
  }
});
