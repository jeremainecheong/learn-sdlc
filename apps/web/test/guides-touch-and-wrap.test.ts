/* The guides on a phone's width. jsdom cannot lay pages out, so these read the rules from the
 * CSS sources: a catalogue title that keeps its words whole, tap targets at
 * least 32 px tall, an honesty tag that turns from a pill into a rounded box
 * when it wraps, and a chapter footer whose forward button keeps its place. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const LEARN = resolve(__dirname, '../components/learn');
const read = (path: string) => readFileSync(resolve(LEARN, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const lessons = read('lessons.css');
const hero = read('lesson-hero.css');
const figures = read('figures/figures.css');

/** Every declaration block whose selector list names `selector` exactly. */
function bodiesOf(css: string, selector: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').map((s) => s.trim()).includes(selector))
    .map((m) => m[2]);
}

describe('the guides at a phone’s width', () => {
  it('keeps a catalogue card’s title whole on a narrow library, a size smaller', () => {
    const at = hero.indexOf('@container learning (max-width: 560px)');
    const narrow = hero.slice(at, hero.indexOf('}\n}', hero.indexOf('.learn-feature h3', at)));
    expect(narrow).toMatch(/\.learn-library \.learn-feature h3 \{\s*font-size: 21px;\s*overflow-wrap: break-word;/);
    // The wide rule may break anywhere; the narrow one overrides it by being more specific.
    expect(bodiesOf(lessons, '.learn-feature h3').join(';')).toMatch(/font-size: 25px/);
  });

  it.each([
    '.lesson-page-top > a',
    '.lesson-outcomes summary',
    '.lesson-transfer-practice summary',
    '.lesson-sources > a',
    '.phase-map-gate',
  ])('gives %s a tap target at least 32 px tall (L-19)', (selector) => {
    expect(bodiesOf(lessons, selector).join(';')).toMatch(/min-height: 32px/);
  });

  it('pads the two disclosures and the sources to their 32 px, and draws the phone map’s gates 32 px tall', () => {
    for (const selector of ['.lesson-outcomes summary', '.lesson-transfer-practice summary', '.lesson-sources > a']) {
      const bodies = bodiesOf(lessons, selector);
      expect(bodies.at(-1), selector).toMatch(/padding-block: 7px/);
    }
    const phone = lessons.slice(lessons.lastIndexOf('@media (max-width: 520px)'));
    expect(phone).toMatch(/\.phase-map-gate \{ width: auto; min-width: 44px; height: 32px;/);
    expect(phone).not.toMatch(/height: 28px/);
    expect(figures).toMatch(/\.fig input\[type="range"\] \{ min-height: 32px; \}/);
  });

  it('draws the honesty tag as a rounded box that is still a pill on one line', () => {
    const tag = bodiesOf(figures, '.fig-model-tag').join(';');
    expect(tag).toMatch(/border-radius: 12px/);
    expect(tag).not.toMatch(/999px/);
    // One line is 11.5 px at 1.45 plus 2 px padding and a 1 px border on each
    // side, 22.7 px: a 12 px radius rounds it into a pill.
    expect(11.5 * 1.45 + 2 * 2 + 2 * 1).toBeLessThanOrEqual(24);
  });

  it('wraps a long unbroken word in a figure’s sentence instead of widening the page', () => {
    expect(figures).toMatch(/\.fig :is\(\.fig-live, \.fig-verdict, \.fig-description\) \{ overflow-wrap: anywhere; \}/);
  });

  /* The chapter chip's room link is a tap target, 32 px tall at 390 (its
   * text alone is 19 px), and its negative margins give the height back so the chip's line looks the same. */
  it('gives the chapter chip’s room link a 32 px tap target without changing the line', () => {
    const body = bodiesOf(lessons, '.lesson-where a').join(';');
    expect(body).toMatch(/min-height: 32px/);
    expect(body).toMatch(/display: inline-flex/);
    // The 13 px chip line is about 19 px tall: half the difference back on each side.
    const margin = /margin-block: (-[\d.]+)px/.exec(body);
    expect(margin).not.toBeNull();
    expect(32 + 2 * Number(margin![1])).toBeLessThanOrEqual(19);
    expect(body).toMatch(/text-decoration: underline/);
  });

  it('keeps the chapter footer’s forward button at the row’s end when it is alone', () => {
    expect(bodiesOf(lessons, '.lesson-chapter-footer > :last-child').join(';')).toMatch(/margin-left: auto/);
  });
});
