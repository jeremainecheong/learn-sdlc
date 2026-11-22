import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The token table, read the way a learner reads it.
 *
 * Two rules, both checked against the source rather than against a screenshot,
 * so they hold for every page at once and cost no browser:
 *
 *  1. Every foreground the primitives draw clears 4.5 to 1 on every background
 *     they draw it on, in Paper and in Graphite. The pairs below are not a
 *     sample: each one is a place in `components/ui` or `globals.css` where a
 *     token is written on another token, a Notice on its tint, a Stat's label
 *     on the same tint, a chip's word on a solid fill, a line number on the
 *     code surface.
 *  2. `--c-dim` is not a text colour. The design system says so in its token
 *     table; this is the rule that keeps it true, because `text-dim` on a word
 *     is 2.5 to 1.
 *
 * It runs in the Playwright suite, but nothing in it touches Playwright beyond
 * `test` and `expect`, so it would move to the web vitest suite unchanged.
 */
const WEB = path.join(__dirname, '..', 'apps', 'web');
const CSS = path.join(WEB, 'app', 'globals.css');

type Tokens = Record<string, string>;

/** The `--name: r g b;` declarations of one selector's block. */
function tokensIn(css: string, selector: string): Tokens {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`globals.css has no ${selector} block`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('\n}', open);
  const out: Tokens = {};
  for (const m of css.slice(open, close).matchAll(/--([\w-]+):\s*(\d{1,3}\s+\d{1,3}\s+\d{1,3})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

const channel = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

/** WCAG relative luminance of an `r g b` triplet. */
function luminance(triplet: string): number {
  const [r, g, b] = triplet.split(/\s+/).map(Number);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 to 21. */
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const PHASES = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];

/** [foreground token, background token, where it is drawn]. */
const PAIRS: [string, string, string][] = [
  ...['ground', 'surface', 'raised', 'tint', 'code'].map(
    (bg) => ['c-ink', `c-${bg}`, 'h1, h2, h3, readouts, .legal .callout'] as [string, string, string],
  ),
  ...['ground', 'surface', 'raised', 'code'].map(
    (bg) => ['c-ink2', `c-${bg}`, '.prose-docs body text, .chip'] as [string, string, string],
  ),
  ...['ground', 'surface', 'raised', 'code', 'codeline', 'tint', 'passtint', 'failtint', 'warntint'].map(
    (bg) => ['c-muted', `c-${bg}`, '.label, .purpose, and a Stat label on its tint'] as [string, string, string],
  ),
  ...['ground', 'surface', 'raised', 'tint'].map(
    (bg) => ['c-accent', `c-${bg}`, 'links, .chip-accent, an info Notice'] as [string, string, string],
  ),
  ...['ground', 'surface', 'raised', 'passtint'].map(
    (bg) => ['c-pass', `c-${bg}`, 'a passing Notice and Stat'] as [string, string, string],
  ),
  ...['ground', 'surface', 'raised', 'failtint'].map(
    (bg) => ['c-fail', `c-${bg}`, 'every error message in the product'] as [string, string, string],
  ),
  ...['ground', 'surface', 'raised', 'warntint'].map(
    (bg) => ['c-warn', `c-${bg}`, 'a withheld answer, a warning Notice'] as [string, string, string],
  ),
  ['c-onaccent', 'c-accent', '.btn'],
  ['c-onstatus', 'c-pass', '.chip-pass'],
  ['c-onstatus', 'c-fail', '.chip-fail, .btn-danger'],
  ['c-onstatus', 'c-warn', '.chip-warn'],
  ['c-gutter', 'c-code', "the editor's line numbers"],
  ['c-gutter', 'c-codeline', "the editor's line numbers, on the current line"],
  ...PHASES.map((p) => [`hue-${p}`, `tint-${p}`, 'the phase numeral on its tint'] as [string, string, string]),
  ...PHASES.map((p) => [`hue-${p}`, 'c-surface', 'a phase mark on a panel'] as [string, string, string]),
];

test.describe('the token table', () => {
  test('every pair the primitives draw clears 4.5 to 1 in both themes', () => {
    const css = fs.readFileSync(CSS, 'utf-8');
    const paper = tokensIn(css, ':root {');
    // Graphite redeclares only what changes, so it inherits the rest.
    const graphite = { ...paper, ...tokensIn(css, "html[data-theme='graphite']") };

    const failures: string[] = [];
    for (const [name, tokens] of [
      ['paper', paper],
      ['graphite', graphite],
    ] as const) {
      for (const [fg, bg, where] of PAIRS) {
        expect(tokens[fg], `${name} declares --${fg}`).toBeTruthy();
        expect(tokens[bg], `${name} declares --${bg}`).toBeTruthy();
        const r = ratio(tokens[fg], tokens[bg]);
        if (r < 4.5) failures.push(`${name}: ${fg} on ${bg} is ${r.toFixed(2)} to 1 — ${where}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('dim is never a word: no element carrying text-dim has text in it', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(WEB);

    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8');
      // Bare `text-dim` only: `marker:text-dim` and `placeholder:text-dim`
      // colour a glyph and a placeholder, which is what the token is for.
      for (const m of src.matchAll(/(^|[\s"'`])text-dim\b/g)) {
        const at = m.index! + m[1].length;
        const children = jsxChildren(src, at);
        if (children && /[A-Za-z0-9]/.test(children)) {
          const line = src.slice(0, at).split('\n').length;
          offenders.push(
            `${path.relative(WEB, file)}:${line} — "${children.trim().slice(0, 48)}" should be text-muted`,
          );
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/**
 * The children of the JSX element whose class list holds the offset, with
 * nested elements dropped and expressions kept, `{name}` is a word on the
 * screen even though it is not one in the source. Null when the element is
 * self-closing, because an icon has no text to colour.
 */
function jsxChildren(src: string, at: number): string | null {
  const open = src.lastIndexOf('<', at);
  if (open < 0) return null;
  let i = open + 1;
  let depth = 0;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) break;
  }
  if (i >= src.length || src[i - 1] === '/') return null;
  const close = src.indexOf('<', i + 1);
  const children = src.slice(i + 1, close < 0 ? src.length : close);
  return children.replace(/\{([^{}]*)\}/g, (_all, inner: string) => (inner.includes('<') ? '' : inner));
}
