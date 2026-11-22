import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The signed-in frame must not be a scroll container.
 *
 * `.signed-in-frame` is fixed to the viewport and draws the top bar, the
 * sidebar and the page. With `overflow: hidden` it was still a scroll
 * container, so any programmatic scroll reached it: the project editor's
 * section tabs (`scrollIntoView({ block: 'start' })`) left its scrollTop at 65
 * and then 264, the top bar cut off and a blank band at the foot of the
 * window. `overflow: clip` clips the same way and is not a scroll container,
 * so nothing can scroll it. The browser check is
 * `e2e/signed-in-frame-scroll.spec.ts`; this pins the rule where it is written, and that no other rule anywhere, in a media
 * query or not, turns the frame back into a scroll container.
 *
 * jsdom lays nothing out, so this reads the stylesheets themselves.
 */
const webRoot = resolve(__dirname, '..');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) return [];
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

interface Rule { file: string; selector: string; body: string; at: string[] }

/** Every rule of a stylesheet with declarations, and the at-rules it sits in. */
function rules(file: string): Rule[] {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const stack: string[] = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      stack.push(buf.trim().replace(/\s+/g, ' '));
      buf = '';
    } else if (ch === '}') {
      const selector = stack.pop() ?? '';
      if (buf.trim() && !selector.startsWith('@')) {
        out.push({ file: relative(webRoot, file), selector, body: buf.trim().replace(/\s+/g, ' '), at: [...stack] });
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

/** Whether `.signed-in-frame` itself is the subject of one of the selector's items (not an ancestor of it). */
function framesTheFrame(selector: string): boolean {
  return selector.split(',').some((item) => {
    const last = item.trim().split(/\s*[\s>+~]\s*/).pop() ?? '';
    return /\.signed-in-frame(?![\w-])/.test(last);
  });
}

const overflowOf = (body: string) =>
  [...body.matchAll(/(?:^|;)\s*(overflow(?:-x|-y|-block|-inline)?)\s*:\s*([^;]+)/g)].map(([, property, value]) => ({ property, value: value.trim() }));

const allRules = ['app', 'components', 'lib', 'styles']
  .map((dir) => join(webRoot, dir))
  .filter((dir) => {
    try { return statSync(dir).isDirectory(); } catch { return false; }
  })
  .flatMap(cssFiles)
  .flatMap(rules);
const frameRules = allRules.filter((rule) => framesTheFrame(rule.selector));

describe('the signed-in frame is not a scroll container', () => {
  it('finds the frame\'s own rules (the reader is reading what it should)', () => {
    expect(frameRules.some((rule) => rule.file === 'components/shell/shell-fidelity.css' && rule.selector === '.signed-in-frame')).toBe(true);
    expect(frameRules.some((rule) => rule.file === 'app/redesign.css' && rule.selector === '.signed-in-frame')).toBe(true);
    // a descendant rule is not the frame's own
    expect(framesTheFrame('.signed-in-frame .shell-page')).toBe(false);
    expect(framesTheFrame('html[data-sidebar="full"] .signed-in-frame')).toBe(true);
  });

  it('clips the frame with overflow: clip, and that is the frame\'s only overflow declaration on screen', () => {
    const base = frameRules.find((rule) => rule.file === 'components/shell/shell-fidelity.css' && rule.selector === '.signed-in-frame' && rule.at.length === 0)!;
    expect(overflowOf(base.body)).toEqual([{ property: 'overflow', value: 'clip' }]);
  });

  it('has no rule anywhere, in a media query or not, that gives the frame overflow hidden, auto or scroll', () => {
    const offending = frameRules.flatMap((rule) =>
      overflowOf(rule.body)
        .filter(({ value }) => /\b(hidden|auto|scroll|overlay)\b/.test(value))
        .map(({ property, value }) => `${rule.file}: ${[...rule.at, rule.selector].join(' ')} { ${property}: ${value} }`),
    );
    expect(offending).toEqual([]);
  });

  it('lets print alone draw the frame with overflow visible, so an export pages', () => {
    const others = frameRules.flatMap((rule) => overflowOf(rule.body).map(({ value }) => ({ rule, value }))).filter(({ value }) => value !== 'clip');
    // the print rule is there (an empty list would make the next line true of nothing)
    expect(others.filter(({ rule }) => rule.file === 'components/shell/shell-fidelity.css' && rule.at.includes('@media print'))).toHaveLength(1);
    expect(others.every(({ rule, value }) => rule.at.includes('@media print') && /^visible( !important)?$/.test(value))).toBe(true);
  });
});
