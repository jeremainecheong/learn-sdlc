// @vitest-environment jsdom
/**
 * The shared study-guide blocks (components/learn/figures): the figure
 * frame, the step-through, the toggles, the status marks and the phase
 * glyphs. Each is mounted and driven the way a reader would: by keyboard,
 * through its labels and the words it says, and under reduced motion.
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhaseKey } from '@learnsdlc/shared';
import { FIGURE_SVG_MAX_SCALE, Figure, FigureSvg, MODEL_TAG, WIDE_PLAN_MIN_SCALE, figureMinWidth } from '@/components/learn/figures/Figure';
import { codeFragments, isCodeWord, wordBreaks } from '@/components/learn/figures/CodeText';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { StepThrough } from '@/components/learn/figures/StepThrough';
import { ToggleSet } from '@/components/learn/figures/ToggleSet';
import { STATUS_WORDS, StatusMark, type FigureStatus } from '@/components/learn/figures/StatusMark';
import { PhaseGlyph } from '@/components/learn/figures/PhaseGlyph';

let host: HTMLDivElement;
let root: Root;
const mount = (node: React.ReactNode) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(node));
};
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'matchMedia');
});
const buttonNamed = (name: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === name)!;
const key = (target: Element, k: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
const reduceMotion = (on: boolean) => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: on && query.includes('reduce'), media: query, addEventListener: () => {}, removeEventListener: () => {} }),
  });
};

describe('Figure', () => {
  it('draws a caption, the how-to line, the honesty tag and a labelled, focusable scroll region', () => {
    mount(<Figure id="demo" title="A demo figure" howTo="Press a button." description="What it shows." model scroll><p>Body</p></Figure>);
    const figure = host.querySelector('figure')!;
    expect(figure.getAttribute('data-figure-id')).toBe('demo');
    expect(figure.querySelector('figcaption')?.textContent).toContain('A demo figure');
    expect(figure.querySelector('.fig-howto')?.textContent).toBe('Press a button.');
    expect(figure.querySelector('.fig-model-tag')?.textContent).toBe(MODEL_TAG);
    const region = figure.querySelector('[role="region"]')!;
    expect(region.getAttribute('aria-label')).toBe('A demo figure: scrollable figure');
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(figure.querySelector('.fig-description')?.textContent).toBe('What it shows.');
  });

  it('takes its own honesty words, and wears none when not a model', () => {
    mount(<><Figure title="One" model="Authored results."><p /></Figure><Figure title="Two"><p /></Figure></>);
    const tags = host.querySelectorAll('.fig-model-tag');
    expect(tags).toHaveLength(1);
    expect(tags[0].textContent).toBe('Authored results.');
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(0);
  });

  it('names each SVG with its own title and description ids', () => {
    mount(<>
      <FigureSvg title="First" description="First facts." viewBox="0 0 10 10"><rect /></FigureSvg>
      <FigureSvg title="Second" description="Second facts." viewBox="0 0 10 10"><rect /></FigureSvg>
    </>);
    const svgs = Array.from(host.querySelectorAll('svg[role="img"]'));
    expect(svgs).toHaveLength(2);
    const [a, b] = svgs.map((svg) => svg.getAttribute('aria-labelledby')!);
    expect(a).not.toBe(b);
    const [titleId, descId] = a.split(' ');
    expect(host.querySelector(`#${titleId}`)?.textContent).toBe('First');
    expect(host.querySelector(`#${descId}`)?.textContent).toBe('First facts.');
  });

  /* SVG text must not draw in a fallback face (Inter is not loaded) or, scaled
   * with a 720-unit drawing across a 1190 px figure, at about 20 px. The text
   * is the page's own font at 13 units, and an SVG draws at
   * most 1.2 times its viewBox width, so the text stays near body size. */
  it('draws SVG text in the page font at 13 units, and caps a drawing at 1.2 times its viewBox width', () => {
    expect(FIGURE_SVG_MAX_SCALE).toBe(1.2);
    mount(<>
      <FigureSvg title="Wide" description="Wide facts." viewBox="0 0 1000 260" minWidth={760}><rect /></FigureSvg>
      <FigureSvg title="Narrow" description="Narrow facts." viewBox="0 0 560 212"><rect /></FigureSvg>
    </>);
    const [wide, narrow] = Array.from(host.querySelectorAll<SVGSVGElement>('svg[role="img"]'));
    expect(wide.style.maxWidth).toBe('1200px');
    // A 1000-unit plan never goes below 0.86 of its width.
    expect(wide.style.minWidth).toBe('860px');
    expect(narrow.style.maxWidth).toBe('672px');
    expect(narrow.style.minWidth).toBe('');
    const css = readFileSync(resolve(__dirname, '../components/learn/figures/figures.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const text = /\.fig-svg text \{([^}]*)\}/.exec(css)![1];
    expect(text).toMatch(/font-family: inherit;/);
    expect(text).toMatch(/font-size: 13px;/);
    expect(css).not.toMatch(/Inter/);
    expect(/\.fig-svg \{([^}]*)\}/.exec(css)![1]).toMatch(/margin-inline: auto/);
  });

  /* FigureSvg's inline cap beats any stylesheet max-width,
   * so a stylesheet cap on a drawing never applies and only misleads. */
  it('leaves the cap to FigureSvg: no figure stylesheet sets a max-width on a drawing', () => {
    const dir = resolve(__dirname, '../components/learn/figures');
    const drawings = new Set(['fig-svg']);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
      const source = readFileSync(resolve(dir, file), 'utf8');
      for (const [, attrs] of source.matchAll(/<FigureSvg\b([\s\S]*?)>/g)) {
        for (const name of (/className=(?:"([^"]+)"|\{`([^`]+)`\})/.exec(attrs)?.slice(1).find(Boolean) ?? '').match(/fig-[\w-]+/g) ?? []) drawings.add(name);
      }
    }
    expect([...drawings].sort()).toEqual(['fig-c-pyramid', 'fig-c-pyramid-compact', 'fig-c-pyramid-wide', 'fig-dm-svg', 'fig-rd-svg', 'fig-svg']);
    let rules = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
      const css = readFileSync(resolve(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        // The drawing itself: a rule whose last compound selector names one of its classes.
        const last = selector.split(',').map((part) => part.trim().split(/\s+|>/).pop()!);
        if (!last.some((compound) => (compound.match(/\.fig-[\w-]+/g) ?? []).some((c) => drawings.has(c.slice(1))))) continue;
        rules += 1;
        expect(body, `${file} ${selector.trim()}`).not.toMatch(/(?<![\w-])max-width\s*:/);
      }
    }
    expect(rules).toBeGreaterThan(2);
  });

  it('marks itself for reduced motion when the reader asks for it', () => {
    reduceMotion(true);
    mount(<Figure title="Still"><p /></Figure>);
    expect(host.querySelector('figure')?.getAttribute('data-motion')).toBe('reduce');
  });

  it('marks full motion otherwise, and when the browser has no matchMedia', () => {
    mount(<Figure title="Moving"><p /></Figure>);
    expect(host.querySelector('figure')?.getAttribute('data-motion')).toBe('full');
  });
});

const STEPS = [
  { title: 'The request', text: 'A brief arrives.', content: <p>frame one</p> },
  { title: 'The proposal', text: 'A change is proposed.', content: <p>frame two</p> },
  { title: 'The explanation', text: 'You explain it.', content: <p>frame three</p> },
];

describe('StepThrough', () => {
  it('counts, announces and moves with Back and Next, which disable at the ends', () => {
    const seen: number[] = [];
    mount(<StepThrough label="Propose, explain, apply" steps={STEPS} onStepChange={(i) => seen.push(i)} />);
    const group = host.querySelector('section[aria-label="Propose, explain, apply"]')!;
    const live = group.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe('Step 1 of 3The requestA brief arrives.');
    expect(buttonNamed('Back').disabled).toBe(true);
    expect(buttonNamed('Start again').disabled).toBe(true);
    act(() => buttonNamed('Next').click());
    expect(live.textContent).toContain('Step 2 of 3');
    expect(live.textContent).toContain('A change is proposed.');
    expect(group.querySelector('.fig-steps-frame')?.textContent).toBe('frame two');
    act(() => buttonNamed('Next').click());
    expect(buttonNamed('Next').disabled).toBe(true);
    act(() => buttonNamed('Start again').click());
    expect(live.textContent).toContain('Step 1 of 3');
    expect(seen).toEqual([1, 2, 0]);
  });

  it('moves with the arrow keys, Home and End from inside the group', () => {
    mount(<StepThrough label="Steps" steps={STEPS} />);
    const group = host.querySelector('section')!;
    const count = () => group.querySelector('.fig-steps-count')!.textContent;
    key(buttonNamed('Next'), 'ArrowRight');
    expect(count()).toBe('Step 2 of 3');
    key(group, 'End');
    expect(count()).toBe('Step 3 of 3');
    key(group, 'ArrowRight');
    expect(count()).toBe('Step 3 of 3');
    key(group, 'ArrowLeft');
    expect(count()).toBe('Step 2 of 3');
    key(group, 'Home');
    expect(count()).toBe('Step 1 of 3');
  });

  it('hands focus to the button that still moves when the focused one disables', () => {
    mount(<StepThrough label="Steps" steps={STEPS} />);
    buttonNamed('Next').focus();
    act(() => buttonNamed('Next').click());
    act(() => buttonNamed('Next').click());
    expect(document.activeElement).toBe(buttonNamed('Back'));
    act(() => buttonNamed('Back').click());
    act(() => buttonNamed('Back').click());
    expect(document.activeElement).toBe(buttonNamed('Next'));
  });

  it('leaves the arrow keys to a ToggleSet inside a frame', () => {
    function Inner() {
      const [v, setV] = useState<'a' | 'b'>('a');
      return <ToggleSet label="Inner" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} value={v} onChange={setV} />;
    }
    mount(<StepThrough label="Steps" steps={[{ title: 'One', text: 'x', content: <Inner /> }, { title: 'Two', text: 'y' }]} />);
    buttonNamed('A').focus();
    key(buttonNamed('A'), 'ArrowRight');
    expect(document.activeElement).toBe(buttonNamed('B'));
    expect(host.querySelector('.fig-steps-count')?.textContent).toBe('Step 1 of 2');
  });

  it('swaps frames without motion under reduced motion', () => {
    reduceMotion(true);
    mount(<StepThrough label="Steps" steps={STEPS} />);
    expect(host.querySelector('section')?.getAttribute('data-motion')).toBe('reduce');
  });
});

describe('ToggleSet', () => {
  const OPTIONS = [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }, { value: 'three', label: 'Three' }] as const;
  type V = (typeof OPTIONS)[number]['value'];

  it('presses one option at a time and says which in words', () => {
    function Single() {
      const [v, setV] = useState<V>('one');
      return <ToggleSet label="Pick one" options={OPTIONS} value={v} onChange={setV} summary="visible" />;
    }
    mount(<Single />);
    const group = host.querySelector('[role="group"][aria-label="Pick one"]')!;
    expect(group.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1);
    expect(buttonNamed('One').querySelector('svg')).not.toBeNull();
    act(() => buttonNamed('Three').click());
    expect(buttonNamed('Three').getAttribute('aria-pressed')).toBe('true');
    expect(buttonNamed('One').getAttribute('aria-pressed')).toBe('false');
    expect(buttonNamed('One').querySelector('svg')).toBeNull();
    const summary = host.querySelector('.fig-toggles-summary')!;
    expect(summary.getAttribute('aria-live')).toBe('polite');
    expect(summary.textContent).toBe('Pick one: Three.');
  });

  it('turns several options on and off, keeping the options’ order', () => {
    const changes: V[][] = [];
    function Multi() {
      const [v, setV] = useState<V[]>(['two']);
      return <ToggleSet multiple label="Tests" options={OPTIONS} value={v} onChange={(next) => { changes.push(next); setV(next); }} />;
    }
    mount(<Multi />);
    act(() => buttonNamed('Three').click());
    act(() => buttonNamed('One').click());
    act(() => buttonNamed('Two').click());
    expect(changes).toEqual([['two', 'three'], ['one', 'two', 'three'], ['one', 'three']]);
    expect(host.querySelector('.sr-only[aria-live="polite"]')?.textContent).toBe('Tests: 2 of 3 on.');
  });

  it('moves focus with the arrow keys, Home and End, wrapping at the ends', () => {
    mount(<ToggleSet label="Pick" options={OPTIONS} value="one" onChange={() => {}} />);
    buttonNamed('One').focus();
    key(buttonNamed('One'), 'ArrowRight');
    expect(document.activeElement).toBe(buttonNamed('Two'));
    key(buttonNamed('Two'), 'End');
    expect(document.activeElement).toBe(buttonNamed('Three'));
    key(buttonNamed('Three'), 'ArrowDown');
    expect(document.activeElement).toBe(buttonNamed('One'));
    key(buttonNamed('One'), 'ArrowLeft');
    expect(document.activeElement).toBe(buttonNamed('Three'));
    key(buttonNamed('Three'), 'Home');
    expect(document.activeElement).toBe(buttonNamed('One'));
  });
});

describe('StatusMark', () => {
  it('draws every state as a word beside a decorative glyph', () => {
    const states = Object.keys(STATUS_WORDS) as FigureStatus[];
    mount(<>{states.map((s) => <StatusMark key={s} status={s} />)}</>);
    const marks = Array.from(host.querySelectorAll('.fig-status'));
    expect(marks.map((m) => m.textContent)).toEqual(['Passed', 'Failed', 'Survived', 'Killed', 'Not run', 'You are here']);
    for (const mark of marks) expect(mark.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(marks.map((m) => m.getAttribute('data-status'))).toEqual(states);
  });

  it('takes another word but keeps its glyph', () => {
    mount(<StatusMark status="not-run" label="Not meaningful" />);
    expect(host.textContent).toBe('Not meaningful');
    expect(host.querySelector('.fig-status-not-run svg path')).not.toBeNull();
  });
});

describe('PhaseGlyph', () => {
  const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];

  it('draws six different flat stroke icons on the 24 px grid', () => {
    mount(<>{KEYS.map((k) => <PhaseGlyph key={k} phaseKey={k} />)}</>);
    const svgs = Array.from(host.querySelectorAll('svg.phase-glyph'));
    expect(svgs).toHaveLength(6);
    expect(new Set(svgs.map((s) => s.innerHTML)).size).toBe(6);
    for (const svg of svgs) {
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('stroke-width')).toBe('1.5');
      expect(svg.getAttribute('fill')).toBe('none');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('is named when it stands alone', () => {
    mount(<PhaseGlyph phaseKey="testing" title="Testing" size={32} />);
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Testing');
    expect(svg.getAttribute('width')).toBe('32');
    expect(svg.hasAttribute('aria-hidden')).toBe(false);
  });
});

/* At a phone's width, 1000-unit plans drawn at 720 to 760 px would put their
 * 13-unit text at 9.4 to 9.9 px. FigureSvg keeps any plan 1000 units wide or more at 0.86 of its width or more, so
 * that text stays at about 11 px; narrower plans keep their own minimum. */
describe('FigureSvg on a phone', () => {
  it('keeps a 1000-unit plan at 860 px or more, and leaves other plans their own minimum', () => {
    expect(WIDE_PLAN_MIN_SCALE).toBe(0.86);
    expect(13 * WIDE_PLAN_MIN_SCALE).toBeGreaterThanOrEqual(11);
    expect(figureMinWidth(1000, 720)).toBe(860);
    expect(figureMinWidth(1000, 760)).toBe(860);
    expect(figureMinWidth(1000, 900)).toBe(900);
    expect(figureMinWidth(1200, 760)).toBe(1032);
    expect(figureMinWidth(720, 620)).toBe(620);
    expect(figureMinWidth(1000)).toBeUndefined();
  });
});

/* Code in the guides' words. The page font draws the two hyphens of the
 * attack text as one dash, so a word holding such a pair is
 * drawn as code (ligatures off, figures.css and lessons.css). Long names get
 * a break after each underscore instead of breaking inside a word. */
describe('code in the guides’ words', () => {
  const html = (node: React.ReactNode) => {
    const box = document.createElement('div');
    const own = createRoot(box);
    act(() => own.render(<p>{node}</p>));
    const out = box.querySelector('p')!.innerHTML;
    act(() => own.unmount());
    return out;
  };

  it('sets every word with a ligature pair, or an operator on its own, in code type, and leaves other text alone', () => {
    for (const word of ['--', '--selfcheck', '<=', '>=', '!=', '=>', '->', '<', '>', '==']) expect(isCodeWord(word), word).toBe(true);
    for (const word of ['x\'', 'OR', '1=1', 'self-check', 'well-known', '—', '-']) expect(isCodeWord(word), word).toBe(false);
    expect(codeFragments('Plain words, no code.')).toBe('Plain words, no code.');
    expect(html(codeFragments('It starts the launcher with --selfcheck.'))).toBe('It starts the launcher with <code class="code-fragment">--selfcheck</code>.');
    expect(html(codeFragments('Both < and <= can pass.'))).toBe('Both <code class="code-fragment">&lt;</code> and <code class="code-fragment">&lt;=</code> can pass.');
    expect(html(codeFragments('OR 1=1 is true, and -- ends it.', ['OR 1=1']))).toBe('<code class="code-fragment">OR 1=1</code> is true, and <code class="code-fragment">--</code> ends it.');
    expect(html(codeFragments('Where due < today and due <= today disagree', ['due < today', 'due <= today']))).toBe('Where <code class="code-fragment">due &lt; today</code> and <code class="code-fragment">due &lt;= today</code> disagree');
  });

  it('draws a code label in code type in a ToggleSet and a Figure caption', () => {
    mount(<Figure title="Rules: due <= today" description="With --selfcheck."><ToggleSet label="Name" options={[{ value: 'a', label: "x' OR 1=1 --", code: true }, { value: 'b', label: 'Bound with ?', code: ['?'] }]} value="a" onChange={() => {}} /></Figure>);
    const [attack, bound] = Array.from(host.querySelectorAll('button'));
    expect(attack.querySelector('code.code-fragment')!.textContent).toBe("x' OR 1=1 --");
    expect(bound.querySelector('code.code-fragment')!.textContent).toBe('?');
    expect(host.querySelector('figcaption strong code.code-fragment')!.textContent).toBe('<=');
    expect(host.querySelector('.fig-description code.code-fragment')!.textContent).toBe('--selfcheck');
  });

  it('turns ligatures and contextual alternates off for code and every code fragment, in figures and chapters alike', () => {
    const flat = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const off = /\{ font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; \}/;
    const figures = flat('components/learn/figures/figures.css');
    expect(figures).toMatch(new RegExp(`\\.fig :is\\(code, pre, kbd, samp\\),\\s*\\.code-fragment ${off.source}`));
    expect(figures).toMatch(/\.code-fragment \{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; \}/);
    const lessons = flat('components/learn/lessons.css');
    expect(lessons).toMatch(new RegExp(`:is\\(\\.lesson-reader-shell, \\.learn-library\\) :is\\(code, pre, kbd, samp, \\.code-fragment\\) ${off.source}`));
  });

  it('breaks a long name only after an underscore, a slash or before an inner capital', () => {
    expect(wordBreaks('Home')).toBe('Home');
    expect(html(wordBreaks('empty_name_accepted'))).toBe('empty_<wbr>name_<wbr>accepted');
    expect(html(wordBreaks('web/src/hooks/useTasks.ts'))).toBe('web/<wbr>src/<wbr>hooks/<wbr>use<wbr>Tasks.ts');
    expect(html(wordBreaks('task_count_by_id survives.'))).toBe('task_<wbr>count_<wbr>by_<wbr>id survives.');
  });
});
