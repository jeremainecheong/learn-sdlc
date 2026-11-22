/**
 * The Diagram studio draws its own styling.
 *
 * The teacher's Design section draws the studio in its Starting point card and
 * never loads the learner rooms' stylesheet, so the studio's rules live in a
 * stylesheet the component imports itself, moved (not copied) out of
 * phase-experience.css; the learner's Design room reads the same rules.
 */
import { describe, expect, it } from 'vitest';
import { moduleText, webSource } from './support/source-text';

const web = (path: string) => webSource(path);
/** Every rule of a stylesheet as [selector, declarations], comments dropped, at-rules flattened. */
function rules(css: string): Array<[string, string]> {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  const out: Array<[string, string]> = [];
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push([m[1].trim(), m[2].trim()]);
  }
  return out;
}
const declsOf = (css: string, selector: string) =>
  rules(css)
    .filter(([sel]) => sel === selector)
    .map(([, d]) => d)
    .join(';');
const prop = (decls: string, name: string) =>
  new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(decls)?.[1].trim() ?? null;


describe('the Diagram studio draws its own styling', () => {
  const studio = web('components/workspace/panels/design/diagram-studio.css');
  const rooms = web('components/workspace/phase-experience.css');

  it('the component imports its stylesheet, so a page that draws it cannot draw it bare', () => {
    // A stylesheet import is not in any render; it is read from the component's own module, wherever it lives.
    expect(moduleText('DiagramStudio')).toMatch(/^import '\.\/diagram-studio\.css';$/m);
    // The teacher's Design section draws it, and loads no learner room stylesheet.
    // (That it draws the studio is asserted on the rendered builder in `design-builder.test.tsx`.)
    expect(moduleText('StartingPointCard')).not.toContain('phase-experience.css');
  });

  it('its rules have one source: the learner rooms\' stylesheet names neither the studio nor its canvas', () => {
    expect(rooms).not.toMatch(/\.diagram-(studio|canvas)\b/);
    expect(studio).toMatch(/\.diagram-studio\s*\{/);
    expect(studio).toMatch(/\.diagram-canvas\s*\{/);
  });

  it('no rule needs to sit inside a learner room to apply', () => {
    for (const [selector] of rules(studio)) expect(selector).not.toContain('design-tool-room');
  });

  it('reads the rooms\' tool tokens where they are set, and the rooms\' own values where they are not, in both themes', () => {
    const scope = ':where(.phase-lab-workspace,.design-room,.phase-document-room,.requirements-workspace-room,.requirements-toolbar,.jira-issue-dialog)';
    const token = (theme: 'paper' | 'graphite', name: string) =>
      prop(declsOf(rooms, theme === 'paper' ? scope : `html[data-theme=graphite] ${scope}`), name);
    const uses = [...studio.matchAll(/var\((--tool-[a-z-]+)(,\s*([^)]+))?\)/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use[3], `${use[1]} has no fallback`).toBeTruthy();
    for (const [theme, selector] of [
      ['paper', '.diagram-studio'],
      ['graphite', 'html[data-theme=graphite] .diagram-studio'],
    ] as const) {
      const decls = declsOf(studio, selector);
      const own = [...decls.matchAll(/(--studio-[a-z-]+)\s*:\s*var\((--tool-[a-z-]+),\s*(#[0-9a-f]+)\)/gi)];
      expect(own.length, selector).toBe(9);
      for (const [, , tool, fallback] of own) expect(fallback, `${theme} ${tool}`).toBe(token(theme, tool));
    }
  });

  it('the Sequence | Class / UML toggle sets every property it is drawn with, needing no mentor stylesheet', () => {
    const box = declsOf(studio, '.diagram-studio .mentor-mode-switch');
    expect(prop(box, 'display')).toBe('flex');
    expect(prop(box, 'border')).toMatch(/^1px solid /);
    expect(prop(box, 'border-radius')).toBe('10px');
    const button = declsOf(studio, '.diagram-studio .mentor-mode-switch button');
    expect(prop(button, 'flex')).toBe('1');
    expect(prop(button, 'font-size')).toBe('12px');
    expect(prop(button, 'border-radius')).toBe('7px');
    expect(prop(declsOf(studio, '.diagram-studio .mentor-mode-switch button[aria-pressed=true]'), 'box-shadow')).toContain('inset 0 -2px');
  });

  it('the source field is a full-width box of 160px or more', () => {
    const field = declsOf(studio, '.diagram-studio textarea');
    expect(prop(field, 'width')).toBe('100%');
    expect(prop(field, 'min-height')).toBe('160px');
  });
});

