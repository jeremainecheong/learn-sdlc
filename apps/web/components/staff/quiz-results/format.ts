/**
 * How the quiz-results page writes its numbers.
 *
 * Display only. The summary carries stored scores as the files do; nothing
 * here regrades or recounts, it rounds what it is given for reading.
 */
import type { QuizTaskSummary } from '@learnsdlc/shared';

/** A score to one decimal at most (66.66 reads 66.7, 100 reads 100); a dash when there is none. */
export function formatScore(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return '—';
  return String(Math.round(score * 10) / 10);
}

/** A whole percent as sent (the route rounds it); a dash when there is none. */
export function formatPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return '—';
  return `${Math.round(percent)}%`;
}

/** A quiz by its title, or by its task key when the version read gives none. */
export function quizName(quiz: Pick<QuizTaskSummary, 'title' | 'taskKey'>): string {
  return quiz.title?.trim() || quiz.taskKey;
}

/** One quiz across projects and phases: a task key alone can repeat. */
export function quizIdentity(quiz: Pick<QuizTaskSummary, 'project' | 'phaseKey' | 'taskKey'>): string {
  return `${quiz.project}\u0000${quiz.phaseKey}\u0000${quiz.taskKey}`;
}
