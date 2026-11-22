import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Colour contrast that axe's color-contrast rule checks in the browser,
 * asserted where each colour is defined rather than on each element.
 *
 * The colours covered: the phase lists' task-number labels (TaskPanel
 * text-muted), the experience pages' eyebrow, join code and text
 * links (`--exp-cyan`), the onboarding eyebrow and the setup-mode notes, the
 * learn page's guide label (`--exp-cyan` again), and the working rooms' cyan
 * text (the case-file tabs, the brief's lesson link, the contract summary, the
 * backlog's first-epic button) in phase-experience.css.
 *
 * Each pair here is the text colour as the stylesheet defines it against the
 * lightest ground it is drawn on in Paper, measured the way WCAG 2 measures it:
 * 4.5 to 1 for text under 18.66px bold. The browser proof is the axe spec
 * (`e2e/a11y-axe.spec.ts`).
 */
const web = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The declaration block of the first rule whose selector is exactly `selector`. */
function block(css: string, selector: string): string {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  // A statement at-rule (`@tailwind base;`) can sit before the first selector.
  const selectorOf = (rule: string) => rule.split('{')[0].replace(/^\s*(@[^;{]+;\s*)+/, '').trim();
  const at = flat.split('}').find((rule) => selectorOf(rule) === selector);
  if (at === undefined) throw new Error(`no rule for ${selector}`);
  return at.slice(at.indexOf('{') + 1);
}
/** One property's value in a declaration block. */
function prop(decls: string, name: string): string {
  const m = new RegExp(`(?:^|;)\\s*${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+)`).exec(decls);
  if (!m) throw new Error(`no ${name} in ${decls}`);
  return m[1].trim();
}

const AA = 4.5;

const TOOL_SCOPE = ':where(.phase-lab-workspace,.design-room,.phase-document-room,.requirements-workspace-room,.requirements-toolbar,.jira-issue-dialog)';
/**
 * A colour as a theme draws it: a hex literal as written, or
 * `var(--tool-*[,fallback])` resolved from the rooms' token block for that theme.
 */
function toolColor(css: string, value: string, theme: 'paper' | 'graphite'): string {
  const v = /^var\((--tool-[a-z-]+)(?:,\s*(#[0-9a-f]{6}))?\)$/i.exec(value);
  if (!v) return value;
  const scope = theme === 'paper' ? TOOL_SCOPE : `html[data-theme=graphite] ${TOOL_SCOPE}`;
  const token = prop(block(css, scope), v[1]);
  if (theme === 'paper' && v[2]) expect(v[2], `${v[1]} fallback matches Paper`).toBe(token);
  return token;
}

describe('the experience pages draw cyan text at AA', () => {
  const css = web('components/experience/experience.css');
  const cyan = prop(block(css, '.exp-page'), '--exp-cyan');

  it.each([
    ['the page ground (eyebrow, text links)', '#f2f5f8'],
    ['the join code panel', '#edf7fb'],
    ['the learn page guide label', '#eaf6fb'],
    ['a hovered control', '#eaf5fa'],
  ])('--exp-cyan on %s', (_where, ground) => {
    expect(contrast(cyan, ground)).toBeGreaterThanOrEqual(AA);
  });

  it('the eyebrow, the join code and the text link all take the token', () => {
    expect(prop(block(css, '.exp-eyebrow'), 'color')).toBe('var(--exp-cyan)');
    expect(prop(block(css, '.exp-code'), 'color')).toBe('var(--exp-cyan)');
    expect(prop(block(css, '.exp-text-link'), 'color')).toBe('var(--exp-cyan)');
  });
});

describe('onboarding draws its eyebrow and mode notes at AA', () => {
  const css = web('app/(app)/onboarding/onboarding.css');
  const soft = prop(block(css, '.onboarding-page'), '--onboarding-soft');

  it('the eyebrow on the page ground', () => {
    expect(contrast(prop(block(css, '.onboarding-eyebrow'), 'color'), '#f2f5f8')).toBeGreaterThanOrEqual(AA);
  });

  it('a mode note on the chosen mode (the soft tint)', () => {
    expect(contrast(prop(block(css, '.onboarding-modes small'), 'color'), soft)).toBeGreaterThanOrEqual(AA);
  });
});

describe('the working rooms draw their cyan text at AA', () => {
  const css = web('components/workspace/phase-experience.css');
  /** The grounds that cyan text sits on in the rooms: raised, tint, nav strip, epic list. */
  const GROUNDS = ['#f2f8fc', '#e0f2f9', '#f7fafc', '#f8fafc', '#edf6fb', '#e8f4fb'];

  it.each([
    '.phase-case-file>nav button[aria-pressed=true]',
    '.phase-case-panel>aside a',
    '.phase-contract-detail>summary',
    '.jira-epic-list>p button',
    '.phase-case-kicker',
    '.phase-evidence-detail>summary',
    '.phase-pr-review-state>summary',
  ])('%s', (selector) => {
    const color = toolColor(css, prop(block(css, selector), 'color'), 'paper');
    for (const ground of GROUNDS) expect(contrast(color, ground), `${color} on ${ground}`).toBeGreaterThanOrEqual(AA);
  });
});

/**
 * Graphite, the theme a dark-mode machine follows by
 * default. These rules draw their text on the rooms' token grounds, which
 * Graphite turns dark (`--tool-raised` #1c3345, `--tool-tint` #25485d,
 * `--tool-surface` #172a39); a fixed Paper cyan there reads at 1.7 to 2.3 to 1.
 * The pressed case-file tab's own rule outranks the tabs' token rule, so its
 * colour is the one it declares. Each takes `--tool-accent`, which each theme
 * sets, with the Paper value as the fallback outside a room.
 */
describe('the working rooms draw their cyan text at AA in Graphite too', () => {
  const css = web('components/workspace/phase-experience.css');
  const GRAPHITE_GROUNDS = ['#1c3345', '#25485d', '#172a39'];

  it.each([
    '.phase-case-file>nav button[aria-pressed=true]',
    '.phase-case-panel>aside a',
    '.phase-contract-detail>summary',
    '.jira-epic-list>p button',
    '.phase-case-kicker',
  ])('%s', (selector) => {
    const color = toolColor(css, prop(block(css, selector), 'color'), 'graphite');
    for (const ground of GRAPHITE_GROUNDS) {
      expect(contrast(color, ground), `${color} on ${ground}`).toBeGreaterThanOrEqual(AA);
    }
  });
});

// The account page's privacy link, underlined at rest and not only on hover, is asserted on the rendered page
// in `account-auth-capabilities.test.tsx`.

describe('the bridge notice on phases 3 to 6 is drawn as a note', () => {
  const css = web('components/workspace/phase-experience.css');

  it('has its own rule, in the theme tokens, over the brief prose rule', () => {
    const decls = block(css, '.phase-case-panel>.phase-brief-bridge,.phase-brief-intro>.phase-brief-bridge');
    expect(prop(decls, 'color')).toBe('rgb(var(--c-ink))');
    expect(prop(decls, 'background')).toBe('rgb(var(--c-tint))');
    expect(prop(decls, 'border-left')).toMatch(/solid rgb\(var\(--c-accent\)\)/);
  });

  it('reads at AA in Paper: ink on tint', () => {
    const tokens = block(web('app/globals.css'), ':root');
    const rgb = (name: string) =>
      `#${prop(tokens, name).split(/\s+/).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
    expect(contrast(rgb('--c-ink'), rgb('--c-tint'))).toBeGreaterThanOrEqual(AA);
  });
});

/**
 * The teacher evidence panel's phase tabs (`.exp-tabs`, TeacherPortal): a
 * fixed #627989 for the unpressed labels is 4.16 to 1 on the tab row's ground
 * (`--exp-ground` #f2f5f8) at 11px, below the 4.5 to 1 floor. The label takes the page's muted
 * token, with its Paper value as the fallback outside an `.exp-page`. The
 * Graphite rule is measured on its own row ground (#1b3548).
 */
describe('the teacher evidence panel draws its phase tabs at AA', () => {
  const css = web('components/experience/experience.css');
  const page = block(css, '.exp-page');
  const tokenOf = (value: string) => {
    const v = /^var\((--exp-[a-z-]+)(?:,\s*(#[0-9a-f]{6}))?\)$/i.exec(value);
    if (!v) return value;
    const token = prop(page, v[1]);
    if (v[2]) expect(v[2], `${v[1]} fallback matches the token`).toBe(token);
    return token;
  };

  it('an unpressed tab on the row ground, in Paper', () => {
    const color = tokenOf(prop(block(css, '.exp-tabs button'), 'color'));
    const ground = tokenOf(prop(block(css, '.exp-tabs'), 'background'));
    expect(contrast(color, ground), `${color} on ${ground}`).toBeGreaterThanOrEqual(AA);
    expect(contrast(color, '#ffffff'), `${color} on #ffffff`).toBeGreaterThanOrEqual(AA);
  });

  it('an unpressed tab on the row ground, in Graphite', () => {
    const color = prop(block(css, '[data-theme="graphite"] .exp-tabs button'), 'color');
    const ground = prop(block(css, '[data-theme="graphite"] .exp-tabs'), 'background');
    expect(contrast(color, ground), `${color} on ${ground}`).toBeGreaterThanOrEqual(AA);
  });
});
