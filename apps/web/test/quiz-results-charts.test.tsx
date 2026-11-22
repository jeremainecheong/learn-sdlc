// @vitest-environment jsdom
/**
 * The quiz results' pass-rate bars and score bands.
 *
 * Inline SVG, flat bars, the value written beside each bar, colour only as
 * meaning (passed in the pass token, not yet passed in neutral ink, never the
 * failure red). Every SVG is an image with a name, and every chart carries a
 * table of its own numbers.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QUIZ_RESULTS_COPY, QUIZ_SCORE_BANDS } from '@learnsdlc/shared';
import { PassRateChart } from '@/components/staff/quiz-results/PassRateChart';
import { ScoreBandsChart } from '@/components/staff/quiz-results/ScoreBandsChart';
import { quizFixture } from './fixtures/quiz-results';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (node: ReactNode) => act(async () => root.render(node));
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const tableRows = (scope: Element | null) =>
  [...(scope?.querySelectorAll('table tbody tr') ?? [])].map((tr) => [...tr.children].map((cell) => text(cell)));

function everySvgIsANamedImage(scope: Element) {
  const svgs = [...scope.querySelectorAll('svg')];
  expect(svgs.length).toBeGreaterThan(0);
  for (const svg of svgs) {
    expect(svg.getAttribute('role')).toBe('img');
    expect((svg.getAttribute('aria-label') ?? '').trim().length).toBeGreaterThan(0);
  }
}

describe('PassRateChart: one bar per quiz', () => {
  it('one row per quiz; the sat quiz has its pass rate written beside a pass-coloured bar', async () => {
    const { quizzes } = quizFixture();
    await render(<PassRateChart quizzes={quizzes} />);
    const chart = host.querySelector('[data-testid="quiz-pass-rate-chart"]');
    expect(chart).not.toBeNull();
    everySvgIsANamedImage(chart!);
    const svg = chart!.querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toContain('Design check');
    expect(svg.getAttribute('aria-label')).toContain('67%');
    // The value is text beside the bar, inside the drawing.
    const svgText = [...svg.querySelectorAll('text')].map((t) => text(t));
    expect(svgText).toContain('Design check');
    expect(svgText.some((t) => t.startsWith('67%'))).toBe(true);
    // Passed in the pass token; the rest of the attempted in neutral ink.
    const passBars = svg.querySelectorAll('rect.quiz-bar.is-pass');
    expect(passBars).toHaveLength(1);
    expect(Number(passBars[0].getAttribute('width'))).toBeGreaterThan(0);
    expect(svg.querySelectorAll('rect.quiz-bar.is-neutral')).toHaveLength(1);
    // No axes, no gridlines.
    expect(svg.querySelectorAll('line, path')).toHaveLength(0);
  });

  it('the quiz nobody has sat gets words, not a bar', async () => {
    const { quizzes } = quizFixture();
    await render(<PassRateChart quizzes={quizzes} />);
    const svg = host.querySelector('[data-testid="quiz-pass-rate-chart"] svg')!;
    const svgText = [...svg.querySelectorAll('text')].map((t) => text(t));
    expect(svgText).toContain('Deployment check');
    expect(svgText).toContain(QUIZ_RESULTS_COPY.noAttempts);
    expect(svg.querySelectorAll('rect.quiz-bar')).toHaveLength(2);
  });

  it('carries a table of its numbers', async () => {
    const { quizzes } = quizFixture();
    await render(<PassRateChart quizzes={quizzes} />);
    const chart = host.querySelector('[data-testid="quiz-pass-rate-chart"]');
    expect(chart?.querySelector('table')).not.toBeNull();
    expect([...(chart?.querySelectorAll('table thead th') ?? [])].map((th) => text(th))).toEqual([
      'Quiz',
      'Attempted',
      'Passed',
      'Pass rate',
    ]);
    expect(tableRows(chart)).toEqual([
      ['Design check', '3', '2', '67%'],
      ['Deployment check', '0', '0', QUIZ_RESULTS_COPY.noAttempts],
    ]);
  });

  it('a quiz with no title is named by its task key', async () => {
    const [quiz] = quizFixture().quizzes;
    await render(<PassRateChart quizzes={[{ ...quiz, title: null }]} />);
    expect(tableRows(host)[0][0]).toBe('design-check');
  });
});

describe('ScoreBandsChart: five bands of best scores', () => {
  it('all five bands, the learners in each written beside its bar, in neutral ink', async () => {
    const [quiz] = quizFixture().quizzes;
    await render(<ScoreBandsChart quiz={quiz} />);
    const chart = host.querySelector('[data-testid="quiz-bands-design-check"]');
    expect(chart).not.toBeNull();
    everySvgIsANamedImage(chart!);
    const svg = chart!.querySelector('svg')!;
    const svgText = [...svg.querySelectorAll('text')].map((t) => text(t));
    for (const band of QUIZ_SCORE_BANDS) expect(svgText).toContain(band.key);
    expect(svg.querySelectorAll('rect.quiz-bar.is-pass')).toHaveLength(0);
    // Three bands hold a learner each; empty bands draw no bar.
    expect(svg.querySelectorAll('rect.quiz-bar.is-neutral')).toHaveLength(3);
    expect(tableRows(chart)).toEqual([
      ['0-19', '0'],
      ['20-39', '1'],
      ['40-59', '0'],
      ['60-79', '1'],
      ['80-100', '1'],
    ]);
  });

  it('draws nothing for a quiz nobody has sat', async () => {
    const quiz = quizFixture().quizzes[1];
    await render(<ScoreBandsChart quiz={quiz} />);
    expect(host.querySelector('[data-testid="quiz-bands-deployment-check"]')).toBeNull();
    expect(host.querySelector('svg')).toBeNull();
  });
});

describe('the charts use the existing tokens and never the failure red', () => {
  const dir = resolve(__dirname, '..', 'components/staff/quiz-results');
  const sources = readdirSync(dir).map((name) => ({ name, body: readFileSync(resolve(dir, name), 'utf8') }));

  it('one stylesheet; passed in --c-pass; no failure token, no new colour literal', () => {
    const css = sources.filter((one) => one.name.endsWith('.css'));
    expect(css).toHaveLength(1);
    const body = css[0].body.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(body).toMatch(/\.quiz-bar\.is-pass\s*\{[^}]*rgb\(var\(--c-pass\)\)/);
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\brgba?\(\s*\d/);
    for (const one of sources) {
      expect(one.body, one.name).not.toMatch(/--c-(fail|danger|error|revision)|--exp-revision|\bred\b/);
    }
  });

  it('no chart library: the components import only react, next, the shared contract and the app', () => {
    for (const one of sources.filter((s) => s.name.endsWith('.tsx') || s.name.endsWith('.ts'))) {
      const specifiers = [...one.body.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of specifiers) {
        expect(spec, `${one.name} imports ${spec}`).toMatch(/^(react|next\/|@learnsdlc\/shared$|@\/|\.\/|lucide-react$)/);
      }
    }
  });
});
