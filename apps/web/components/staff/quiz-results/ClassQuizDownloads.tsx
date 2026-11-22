/**
 * The four quiz-results files for this class alone.
 *
 * The quiz-results routes with `?cohort=`: the same files the class page's form
 * saves for every class, narrowed to the one on screen. Saved, never drawn.
 */
import { useState } from 'react';
import {
  QUIZ_RESULTS_COPY,
  QUIZ_RESULTS_EXPORT_KINDS,
  type QuizResultsExportKind,
} from '@learnsdlc/shared';
import { describeError } from '@/lib/api';
import { instructorApi } from '@/lib/api-instructor';
import { saveBlob } from '@/lib/download';

const LABELS: Record<QuizResultsExportKind, string> = {
  learners: 'One row per learner and quiz',
  attempts: 'Every attempt',
  questions: 'Every question drawn, right or wrong',
  class: 'Each question across the class',
};

export function ClassQuizDownloads({ cohortId }: { cohortId: string }) {
  const [busy, setBusy] = useState<QuizResultsExportKind | null>(null);
  const [error, setError] = useState('');

  async function download(kind: QuizResultsExportKind) {
    if (busy) return;
    setBusy(kind);
    setError('');
    try {
      saveBlob(await instructorApi.exportClassQuizResults(kind, cohortId), `quiz-${kind}.csv`);
    } catch (err) {
      setError(describeError(err, 'The file could not be downloaded. Try again in a moment.'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className="exp-panel quiz-section"
      data-testid="quiz-results-downloads"
      aria-labelledby="quiz-downloads-title"
      aria-busy={busy ? true : undefined}
    >
      <h2 id="quiz-downloads-title" className="quiz-section-title">
        {QUIZ_RESULTS_COPY.downloads}
      </h2>
      <div className="exp-actions quiz-downloads">
        {QUIZ_RESULTS_EXPORT_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="exp-button"
            data-testid={`quiz-download-${kind}`}
            disabled={busy !== null}
            onClick={() => void download(kind)}
          >
            {busy === kind ? 'Downloading…' : LABELS[kind]}
          </button>
        ))}
      </div>
      {error && (
        <p className="quiz-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
