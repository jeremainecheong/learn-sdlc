'use client';

/**
 * /teacher/class/quiz-results?class=<id>, one class's
 * quiz results as charts on a page of their own.
 *
 * One read per view (`GET /instructor/quiz-results/summary`, the class always
 * sent), counted by the same code as the four quiz-results files, and drawn as:
 * the pass rate of every quiz, then each quiz's numbers with its score bands
 * and its questions, then each learner, then the four files for this class.
 * Scores are rounded for reading only; nothing is regraded.
 *
 * Staff only: a learner who lands here is sent home before anything is read,
 * and the route refuses them as well.
 */
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { QUIZ_RESULTS_COPY, type QuizResultsSummary } from '@learnsdlc/shared';
import { describeError } from '@/lib/api';
import { instructorApi } from '@/lib/api-instructor';
import { useSession } from '@/lib/session';
import { ExperiencePage, LoadingState } from '@/components/experience/shared';
import { classPageHref } from '@/components/staff/console/class-tabs';
import { ClassQuizDownloads } from './ClassQuizDownloads';
import { LearnerResultsTable } from './LearnerResultsTable';
import { LearningGainSection } from './LearningGainSection';
import { PassRateChart } from './PassRateChart';
import { QuestionBarsChart } from './QuestionBarsChart';
import { QuizSummaryCard } from './QuizSummaryCard';
import { ScoreBandsChart } from './ScoreBandsChart';
import { quizIdentity } from './format';
import './quiz-results.css';

type Read = { classId: string; summary: QuizResultsSummary } | { classId: string; error: string };

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="exp-panel quiz-empty" data-testid="quiz-results-empty">
      {children}
    </p>
  );
}

function QuizResults() {
  const user = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const classId = params.get('class') ?? '';
  // The learning-gain view, before vs after each phase.
  const view = params.get('view') === 'gain' ? 'gain' : 'scores';
  const pageHref = (gain: boolean) =>
    `/teacher/class/quiz-results?class=${encodeURIComponent(classId)}${gain ? '&view=gain' : ''}`;
  const isLearner = user?.role === 'LEARNER';
  const canRead = Boolean(user) && !isLearner;
  const [read, setRead] = useState<Read | null>(null);

  useEffect(() => {
    if (isLearner) router.replace('/dashboard');
  }, [isLearner, router]);

  useEffect(() => {
    if (!canRead || !classId) return;
    let current = true;
    instructorApi.quizResultsSummary(classId).then(
      (summary) => {
        if (current) setRead({ classId, summary });
      },
      (err: unknown) => {
        if (current) {
          setRead({ classId, error: describeError(err, 'The quiz results could not be read. Try again in a moment.') });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [canRead, classId]);

  if (isLearner) return null;
  const here = read && read.classId === classId ? read : null;
  const summary = here && 'summary' in here ? here.summary : null;
  const error = here && 'error' in here ? here.error : '';

  return (
    <ExperiencePage
      title={summary?.className ?? 'Your class'}
      eyebrow={QUIZ_RESULTS_COPY.eyebrow}
      active="class"
      variant="teacher"
      actions={
        classId ? (
          <Link href={classPageHref(classId)} className="exp-button">
            {QUIZ_RESULTS_COPY.back}
          </Link>
        ) : (
          <Link href="/teacher" className="exp-button">
            All classes
          </Link>
        )
      }
    >
      <div className="quiz-results" data-testid="quiz-results-page">
        <p className="quiz-note">{QUIZ_RESULTS_COPY.bestScoreNote}</p>
        {classId && (
          <nav className="quiz-views" aria-label="Quiz results views">
            <Link href={pageHref(false)} className="exp-button" aria-current={view === 'scores' ? 'page' : undefined} data-testid="quiz-view-scores">
              Quiz scores
            </Link>
            <Link href={pageHref(true)} className="exp-button" aria-current={view === 'gain' ? 'page' : undefined} data-testid="quiz-view-gain">
              Learning gain
            </Link>
          </nav>
        )}
        {classId && view === 'gain' ? (
          <LearningGainSection cohortId={classId} />
        ) : !classId ? (
          <Empty>Open a class from your classes to see its quiz results.</Empty>
        ) : error ? (
          <p className="exp-panel quiz-error" role="alert">
            {error}
          </p>
        ) : !summary ? (
          <p className="exp-panel quiz-empty" role="status">
            Reading the quiz results…
          </p>
        ) : summary.learnersInClass === 0 ? (
          <Empty>{QUIZ_RESULTS_COPY.noLearners}</Empty>
        ) : summary.quizzes.length === 0 ? (
          <Empty>{QUIZ_RESULTS_COPY.noQuizzes}</Empty>
        ) : (
          <>
            <PassRateChart quizzes={summary.quizzes} />
            <section className="quiz-cards-section" aria-labelledby="quiz-each-title">
              <h2 id="quiz-each-title" className="quiz-section-title">
                Each quiz
              </h2>
              <div className="quiz-cards">
                {summary.quizzes.map((quiz) => (
                  <QuizSummaryCard key={quizIdentity(quiz)} quiz={quiz} learnersInClass={summary.learnersInClass}>
                    <ScoreBandsChart quiz={quiz} />
                    <QuestionBarsChart quiz={quiz} />
                  </QuizSummaryCard>
                ))}
              </div>
            </section>
            <LearnerResultsTable learners={summary.learners} quizzes={summary.quizzes} />
          </>
        )}
        {classId && summary && view === 'scores' && <ClassQuizDownloads cohortId={classId} />}
      </div>
    </ExperiencePage>
  );
}

export function QuizResultsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <QuizResults />
    </Suspense>
  );
}
