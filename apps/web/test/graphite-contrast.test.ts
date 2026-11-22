/**
 * The learn pages in the graphite (dark) theme. jsdom cannot
 * compute the cascade, so this reads the rules from the CSS sources, resolves
 * each colour token from where the theme defines it, and checks every
 * scoped graphite text rule against the ground it sits on there (at least
 * 4.5:1). The grounds are the ones the same sources set: the catalogue card
 * (`.learn-feature`, #223c51ed over the page's graphite ground, rgb 19 20
 * 23), the library banner's two gradient ends, the chapter cards' strip, and
 * the white chapter, figures, phase map and how-checks section.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const web = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
const lessons = web('components/learn/lessons.css');
const experience = web('components/experience/experience.css');
const figures = web('components/learn/figures/figures.css');
const reqDesign = web('components/learn/figures/requirements-design.css');

/** The custom properties a block defines, by name. */
function tokens(css: string, opener: string): Record<string, string> {
  const at = css.indexOf(opener);
  expect(at, opener).toBeGreaterThanOrEqual(0);
  const block = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const exp = tokens(experience, '[data-theme="graphite"] .exp-page {');
const guide = tokens(lessons, '.lesson-reader-shell,\n.learn-library {');
const fig = tokens(figures, '.fig {');

/** The colour a rule sets, with its var() resolved. */
function colourOf(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(at + selector.length + 2, css.indexOf('}', at));
  const value = /(?:^|[;\s])color:\s*([^;]+);/.exec(body)?.[1].trim();
  expect(value, `${selector} sets a color`).toBeTruthy();
  const name = /^var\((--[\w-]+)\)$/.exec(value!)?.[1];
  if (!name) return value!;
  const resolved = exp[name] ?? guide[name] ?? fig[name];
  expect(resolved, name).toBeTruthy();
  return resolved;
}

const rgb = (hex: string, base = [19, 20, 23]): number[] => {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return c.map((v, i) => v * a + base[i] * (1 - a));
};
const luminance = (c: number[]) => {
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (fg: string, ground: string) => {
  const g = rgb(ground);
  const [hi, lo] = [luminance(rgb(fg, g)), luminance(g)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const CARD = '#223c51ed';
const WHITE = '#ffffff';

describe('graphite theme: text on the ground it sits on', () => {
  const G = '[data-theme="graphite"]';
  const pairs: [string, string, string, string][] = [
    ['the catalogue banner line, light end', lessons, `${G} .learn-library-hero p`, '#224a5d'],
    ['the catalogue banner line, dark end', lessons, `${G} .learn-library-hero p`, '#193d50'],
    ['a card’s "You make" line', lessons, `${G} .learn-makes`, CARD],
    ['a card’s "You make" label', lessons, `${G} .learn-makes > span`, CARD],
    // The how-checks section is framed white as the phase map is.
    ['the how-checks intro line', lessons, `${G} .learn-how-checks .how-checks > p`, WHITE],
    ['the phase map’s and how-checks’ side notes', lessons, `${G} :is(.phase-map, .learn-how-checks) .learn-section-heading > span`, WHITE],
    ['the chapter cards’ outcomes list', lessons, `${G} .lesson-outcomes ul`, '#24465b'],
    ['the chapter’s eyebrows', lessons, `${G} .lesson-article .learn-eyebrow`, WHITE],
    ['an option under the pointer', lessons, `${G} .lesson-article .lesson-practice label:is(:hover, :focus-within)`, guide['--guide-tint']],
    ['the sources’ links', lessons, `${G} .lesson-article .lesson-sources > a`, WHITE],
    ['a scroll hint on a white ground', lessons, `${G} :is(.lesson-article, .fig, .phase-map) .experience-scroll-controls > span`, WHITE],
    ['a scroll button on a white ground', lessons, `${G} :is(.lesson-article, .fig, .phase-map) .experience-scroll-controls button`, WHITE],
    ['a step’s sentence in a figure', figures, '.fig-steps-text', WHITE],
    ['a quoted explanation in a figure', reqDesign, '.fig-card-quote', WHITE],
  ];
  it.each(pairs)('%s reads at 4.5:1 or more', (_name, css, selector, ground) => {
    expect(ratio(colourOf(css, selector), ground)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the worked example a white card in the white chapter', () => {
    const at = lessons.indexOf('[data-theme="graphite"] .lesson-article .lesson-worked-example {');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lessons.slice(at, lessons.indexOf('}', at))).toContain('background: #ffffff');
    expect(ratio(guide['--guide-ink'], WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it('draws the chosen option’s letter white on ink, not on a phase accent', () => {
    const at = lessons.indexOf('.lesson-practice label:has(input:checked) .lesson-practice-letter {');
    const body = lessons.slice(at, lessons.indexOf('}', at));
    expect(body).toContain('background: var(--guide-ink)');
    expect(ratio(WHITE, guide['--guide-ink'])).toBeGreaterThanOrEqual(4.5);
  });
});

/* The figures' own colours, generically. Every colour a
 * figure stylesheet sets is a --fig-* token, so a ground or token change is
 * one edit in figures.css; and every token the figures write words in reads
 * at 4.5:1 on both figure grounds, the white ground and the tint that a
 * selected, lit or hovered thing sits on. A disabled control's grey is the
 * one exception (WCAG 1.4.3 exempts inactive controls): it has its own
 * token, used on :disabled rules only. */
describe('figures: every colour a token, every word token readable on both figure grounds', () => {
  const dir = resolve(__dirname, '../components/learn/figures');
  const sheets = readdirSync(dir).filter((file) => file.endsWith('.css'));
  const decls = sheets.flatMap((file) => {
    const css = readFileSync(resolve(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selector, body]) =>
      [...body.matchAll(/(?<![\w-])(color|fill)\s*:\s*([^;]+)/g)].map((d) => ({ file, selector: selector.trim().replace(/\s+/g, ' '), prop: d[1], value: d[2].trim() })),
    );
  });
  /** A --fig-* token's colour, following var() chains inside the .fig block. */
  const value = (name: string): string => {
    const raw = fig[name];
    expect(raw, name).toBeTruthy();
    const next = /^var\((--fig-[\w-]+)\)$/.exec(raw)?.[1];
    return next ? value(next) : raw;
  };
  const tokenOf = (v: string) => /^var\((--fig-[\w-]+)\)$/.exec(v)?.[1];
  const disabled = (selector: string) => selector.split(',').every((part) => /:disabled\b/.test(part));
  // Words: any colour property, and a fill on SVG text (the text element, or a class only text carries).
  const forWords = decls.filter((d) => !disabled(d.selector) && (d.prop === 'color' || /\btext\b|\.word-/.test(d.selector)));
  const wordTokens = [...new Set(forWords.map((d) => tokenOf(d.value)).filter((t): t is string => !!t))].sort();
  const GROUNDS = ['--fig-ground', '--fig-tint'] as const;

  it('reads the four figure stylesheets and every colour in them', () => {
    expect(sheets.sort()).toEqual(['deployment-maintenance.css', 'figures.css', 'implementation-testing.css', 'requirements-design.css']);
    expect(decls.length).toBeGreaterThan(90);
  });

  it('sets every color and fill from a --fig-* token (or currentColor, inherit, none)', () => {
    for (const d of decls) {
      const ok = /^(currentColor|inherit|none)$/.test(d.value) || (!!tokenOf(d.value) && !!fig[tokenOf(d.value)!]);
      expect(ok, `${d.file} ${d.selector} { ${d.prop}: ${d.value} }`).toBe(true);
    }
  });

  it('writes words in ink, muted, pass, warn and fail, and in nothing unexamined', () => {
    for (const name of ['--fig-ink', '--fig-muted', '--fig-pass', '--fig-warn', '--fig-fail']) expect(wordTokens).toContain(name);
    expect(wordTokens).not.toContain('--fig-disabled');
  });

  it.each(wordTokens.flatMap((t) => GROUNDS.map((g) => [t, g] as const)))('%s reads at 4.5:1 or more on %s', (token, ground) => {
    expect(value(ground)).toMatch(/^#[0-9a-f]{6}$/i);
    expect(ratio(value(token), value(ground))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the disabled grey to :disabled rules', () => {
    const uses = decls.filter((d) => d.value === 'var(--fig-disabled)');
    expect(uses.length).toBeGreaterThan(0);
    for (const d of uses) expect(disabled(d.selector), d.selector).toBe(true);
  });

  it('gives the phase map the figure tokens’ own colours where it renames them', () => {
    const map = tokens(lessons, '.phase-map {');
    for (const [name, raw] of Object.entries(map)) {
      if (!name.startsWith('--fig-')) continue;
      const v = /^var\((--guide-[\w-]+)\)$/.exec(raw)?.[1];
      expect(v ? guide[v] : raw, name).toBe(value(name));
    }
  });
});

describe('the chapter’s video list', () => {
  it('reads its chapter line at 4.5:1 or more on the white chapter', () => {
    expect(ratio(colourOf(lessons, '.lesson-video-chapter'), WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it('reads its "this chapter" tag at 4.5:1 or more on the tint it sits on', () => {
    const at = lessons.indexOf('.lesson-video-here {');
    expect(lessons.slice(at, lessons.indexOf('}', at))).toContain('background: var(--guide-tint)');
    expect(ratio(colourOf(lessons, '.lesson-video-here'), guide['--guide-tint'])).toBeGreaterThanOrEqual(4.5);
  });
});
