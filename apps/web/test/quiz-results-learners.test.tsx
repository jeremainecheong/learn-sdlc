// @vitest-environment jsdom
/**
 * The quiz results' per-learner table.
 *
 * One row per learner and quiz, in the summary's order (the learners CSV's):
 * the learner's name, the quiz, attempts used, best score (one decimal at
 * most) and whether they passed. No email column: the page is shown on a
 * screen, and the learners CSV beside it carries the email for a teacher who
 * needs it.
 *
 * This file tests LearnerResultsTable.tsx alone, so removing that component
 * removes this file with it.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LearnerResultsTable } from '@/components/staff/quiz-results/LearnerResultsTable';
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

describe('LearnerResultsTable', () => {
  it('names, quiz, attempts used, best score and passed, in the order sent', async () => {
    const { learners, quizzes } = quizFixture();
    await render(<LearnerResultsTable learners={learners} quizzes={quizzes} />);
    const table = host.querySelector('[data-testid="quiz-learner-table"]');
    expect(table).not.toBeNull();
    expect([...(table?.querySelectorAll('thead th') ?? [])].map((th) => text(th))).toEqual([
      'Learner',
      'Quiz',
      'Attempts used',
      'Best score',
      'Passed',
    ]);
    expect(
      [...(table?.querySelectorAll('tbody tr') ?? [])].map((tr) => [...tr.children].map((cell) => text(cell))),
    ).toEqual([
      ['Learner A', 'Design check', '2', '100', 'Yes'],
      ['Learner B', 'Design check', '3', '66.7', 'Yes'],
      ['Learner C', 'Design check', '1', '33.3', 'Not yet'],
    ]);
  });

  it('shows no email', async () => {
    const { learners, quizzes } = quizFixture();
    await render(<LearnerResultsTable learners={learners} quizzes={quizzes} />);
    expect(host.innerHTML).not.toContain('@example.test');
    expect(text(host)).not.toMatch(/email/i);
  });

  it('a blank best score and an unknown pass read as a dash; an unlisted quiz by its task key', async () => {
    const [row] = quizFixture().learners;
    await render(
      <LearnerResultsTable
        learners={[{ ...row, taskKey: 'other-check', bestScore: null, passed: null }]}
        quizzes={quizFixture().quizzes}
      />,
    );
    const cells = [...(host.querySelector('tbody tr')?.children ?? [])].map((cell) => text(cell));
    expect(cells).toEqual(['Learner A', 'other-check', '2', '—', '—']);
  });

  it('draws nothing when no learner has a row', async () => {
    await render(<LearnerResultsTable learners={[]} quizzes={quizFixture().quizzes} />);
    expect(host.querySelector('[data-testid="quiz-learner-table"]')).toBeNull();
  });
});
