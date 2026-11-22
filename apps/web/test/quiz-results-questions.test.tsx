// @vitest-environment jsdom
/**
 * How often each question was answered right,
 * by its questionId only. No stem, option or key is drawn: the summary holds
 * none, and the chart reads only the id and the three numbers.
 *
 * This file tests QuestionBarsChart.tsx alone, so removing that component
 * removes this file with it.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QuestionBarsChart } from '@/components/staff/quiz-results/QuestionBarsChart';
import { SEALED_TEXT, quizFixture, quizFixtureWithSealedText } from './fixtures/quiz-results';

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

describe('QuestionBarsChart', () => {
  it('one neutral bar per question, the rate right written beside it, and a table of the numbers', async () => {
    const [quiz] = quizFixture().quizzes;
    await render(<QuestionBarsChart quiz={quiz} />);
    const chart = host.querySelector('[data-testid="quiz-questions-design-check"]');
    expect(chart).not.toBeNull();
    const svg = chart!.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toContain('q1');
    const svgText = [...svg.querySelectorAll('text')].map((t) => text(t));
    expect(svgText).toEqual(expect.arrayContaining(['q1', 'q2', 'q3']));
    expect(svgText.filter((t) => t.startsWith('67%'))).toHaveLength(1);
    expect(svgText.filter((t) => t.startsWith('33%'))).toHaveLength(2);
    expect(svg.querySelectorAll('rect.quiz-bar.is-neutral')).toHaveLength(3);
    expect(svg.querySelectorAll('rect.quiz-bar.is-pass')).toHaveLength(0);
    expect(
      [...(chart?.querySelectorAll('table tbody tr') ?? [])].map((tr) => [...tr.children].map((cell) => text(cell))),
    ).toEqual([
      ['q1', '6', '4', '67%'],
      ['q2', '6', '2', '33%'],
      ['q3', '6', '2', '33%'],
    ]);
  });

  it('a question never drawn has no rate and no bar', async () => {
    const [quiz] = quizFixture().quizzes;
    await render(
      <QuestionBarsChart quiz={{ ...quiz, questions: [{ questionId: 'q9', drawn: 0, right: 0, percentRight: null }] }} />,
    );
    const chart = host.querySelector('[data-testid="quiz-questions-design-check"]');
    expect(chart?.querySelectorAll('rect.quiz-bar')).toHaveLength(0);
    expect(text(chart?.querySelector('tbody tr'))).toContain('q9');
  });

  it('draws nothing for a quiz with no questions', async () => {
    const quiz = quizFixture().quizzes[1];
    await render(<QuestionBarsChart quiz={quiz} />);
    expect(host.innerHTML).toBe('');
  });

  it('draws no question text, option or key, whatever rides on the answer', async () => {
    const [quiz] = quizFixtureWithSealedText().quizzes;
    await render(<QuestionBarsChart quiz={quiz} />);
    expect(host.querySelector('[data-testid="quiz-questions-design-check"]')).not.toBeNull();
    for (const sealed of SEALED_TEXT) expect(host.innerHTML).not.toContain(sealed);
  });
});
