// @vitest-environment jsdom
/**
 * The quiz reveal rule: the teacher's editor and the learner's marked paper,
 * read from what the API answered in
 * `apps/api/test/quiz-reveal-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-bodies/quiz-reveal.json`).
 *
 * The round trip a teacher makes, with the editor's own functions over the
 * recorded payloads:
 *
 *   stored rule → the task list (the view) opens the form on it → the audited
 *   key read opens the form keyed → an untouched save builds exactly the body
 *   the API accepted and kept the rule on → the view after it still says so;
 *   a quiz with no rule builds a body with no `revealExplanation` key at all.
 *
 * And the learner's side: the recorded marked paper of a capped optional quiz set to
 * "after every attempt" draws every explanation on a failed paper; the one
 * without the rule draws none.
 */
import { repoPath } from './support/paths';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoredQuiz, AuthoredQuizView, QuizReport } from '@learnsdlc/shared';

vi.mock('@/components/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));

import { quizDraftOfKey, quizDraftOfView, revealShown, toAuthoredQuiz } from '@/components/staff/projects/QuizEditor';
import { QuizResult } from '@/components/workspace/quiz/QuizResult';

const RECORDING = repoPath('apps/api/test/fixtures/contract-bodies/quiz-reveal.json');
type ListedTask = { taskKey: string; required: boolean; quiz: AuthoredQuizView };
type Save = { title: string; brief: string; artefactType: string; quiz: AuthoredQuiz };
type Sat = { verdict: { passed: boolean; report: { quiz: QuizReport } } };
const bodies = JSON.parse(readFileSync(RECORDING, 'utf-8')).bodies as {
  listed: { tasks: ListedTask[] };
  keyAlways: AuthoredQuiz;
  keyPlain: AuthoredQuiz;
  saveAlways: Save;
  savePlain: Save;
  relisted: { tasks: ListedTask[] };
  rekeyed: AuthoredQuiz;
  learnerAlways: Sat;
  learnerPlain: Sat;
};
const listed = (key: string, from = bodies.listed) => from.tasks.find((one) => one.taskKey === key)!;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('the quiz reveal seam, from the API recording (WIRE)', () => {
  it('opens the form on the stored rule from the view, and keeps it through the key read', () => {
    const always = listed('practice-always');
    expect(always.required).toBe(false);
    const fromView = quizDraftOfView(always.quiz);
    expect(fromView.revealExplanation).toBe('always');
    expect(revealShown(fromView, false)).toBe('always');
    // The key read echoes the rule; the view's is the fallback only.
    expect(bodies.keyAlways.revealExplanation).toBe('always');
    expect(quizDraftOfKey(bodies.keyAlways, fromView.revealExplanation).revealExplanation).toBe('always');
    expect(quizDraftOfKey(bodies.keyAlways, null).revealExplanation).toBe('always');

    const plain = listed('practice-plain');
    expect(quizDraftOfView(plain.quiz).revealExplanation).toBeNull();
    expect(quizDraftOfKey(bodies.keyPlain, null).revealExplanation).toBeNull();
  });

  it('builds, from the recorded key, exactly the untouched-save body the API accepted and kept the rule on', () => {
    const always = listed('practice-always');
    const keyed = quizDraftOfKey(bodies.keyAlways, quizDraftOfView(always.quiz).revealExplanation);
    const sent = toAuthoredQuiz(keyed, 'practice-always', always.required);
    expect(JSON.parse(JSON.stringify(sent))).toEqual(bodies.saveAlways.quiz);
    expect(sent.revealExplanation).toBe('always');

    const plain = listed('practice-plain');
    const plainSent = toAuthoredQuiz(quizDraftOfKey(bodies.keyPlain, null), 'practice-plain', plain.required);
    expect(JSON.parse(JSON.stringify(plainSent))).toEqual(bodies.savePlain.quiz);
    expect('revealExplanation' in plainSent).toBe(false);

    // What the API said after that save: the rule kept, and still absent where there was none.
    expect(listed('practice-always', bodies.relisted).quiz.revealExplanation).toBe('always');
    expect(listed('practice-plain', bodies.relisted).quiz.revealExplanation).toBeUndefined();
    expect(bodies.rekeyed.revealExplanation).toBe('always');
  });

  it('a required quiz never carries the rule, whatever the form holds', () => {
    const keyed = quizDraftOfKey(bodies.keyAlways, 'always');
    expect('revealExplanation' in toAuthoredQuiz(keyed, 'practice-always', true)).toBe(false);
  });

  it('draws every explanation on the recorded failed paper of the "every attempt" quiz, and none without the rule', async () => {
    const always = bodies.learnerAlways.verdict;
    const plain = bodies.learnerPlain.verdict;
    expect([always.passed, plain.passed]).toEqual([false, false]);
    expect(always.report.quiz.attemptsLeft).toBeGreaterThan(0);

    await act(async () => {
      root.render(<QuizResult report={always.report.quiz} passed={always.passed} />);
    });
    const shown = always.report.quiz.questions.filter((question) => (host.textContent ?? '').includes(question.explanation ?? '\u0000'));
    expect(shown).toHaveLength(always.report.quiz.drawn);
    expect(host.textContent).toContain('Fixture explanation');

    await act(async () => {
      root.render(<QuizResult report={plain.report.quiz} passed={plain.passed} />);
    });
    expect(plain.report.quiz.questions.every((question) => question.explanation === null)).toBe(true);
    expect(host.textContent).not.toContain('Fixture explanation');
    expect(host.querySelectorAll('[data-testid^="quiz-marked-"]')).toHaveLength(plain.report.quiz.drawn);
  });
});
