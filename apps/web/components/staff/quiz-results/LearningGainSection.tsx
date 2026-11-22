'use client';

/**
 * Learning gain, the quick concept check before a phase
 * against the same check after it, one card per phase.
 *
 * One read (`GET /instructor/quiz-results/learning-gain`, the class sent): the
 * before average, the after average and the change, over the learners who
 * took both (n), a small paired bar, and every learner with a blank where a
 * check is not taken yet. One download: the same numbers as a CSV file.
 * Rounded for reading only; nothing is regraded.
 */
import { useEffect, useState } from 'react';
import { describeError } from '@/lib/api';
import { instructorApi } from '@/lib/api-instructor';
import { saveBlob } from '@/lib/download';
import {
  LEARNING_GAIN_EMPTY,
  pct,
  signedPoints,
  type LearningGain,
  type LearningGainPhase,
} from '@/lib/api-concept';

const width = (value: number | null) => `${Math.max(0, Math.min(100, value ?? 0))}%`;

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div data-testid={testId}>
      <dt>{label}</dt> <dd>{value}</dd>
    </div>
  );
}

function PairedBar({ phase }: { phase: LearningGainPhase }) {
  return (
    <div
      className="learning-gain-bars"
      role="img"
      aria-label={`Before ${pct(phase.beforeAvgPct)}, after ${pct(phase.afterAvgPct)}`}
      data-testid={`learning-gain-bars-${phase.phaseKey}`}
    >
      <div className="learning-gain-row" aria-hidden="true">
        <span className="learning-gain-label">Before</span>
        <span className="learning-gain-track">
          <span
            className="learning-gain-bar is-before"
            style={{ width: width(phase.beforeAvgPct) }}
            data-testid={`learning-gain-bar-before-${phase.phaseKey}`}
          />
        </span>
        <span className="learning-gain-value">{pct(phase.beforeAvgPct)}</span>
      </div>
      <div className="learning-gain-row" aria-hidden="true">
        <span className="learning-gain-label">After</span>
        <span className="learning-gain-track">
          <span
            className="learning-gain-bar is-after"
            style={{ width: width(phase.afterAvgPct) }}
            data-testid={`learning-gain-bar-after-${phase.phaseKey}`}
          />
        </span>
        <span className="learning-gain-value">{pct(phase.afterAvgPct)}</span>
      </div>
    </div>
  );
}

/**
 * What one learner's figures are, said where they are read. A
 * card whose averages rest on a single learner is that learner's change, not
 * a finding about the class; with two or more the "Learners with both checks"
 * figure beside the averages says how many it rests on.
 */
export const ONE_LEARNER_CARD = "One learner took both checks, so these figures are that learner's own change, not a class trend.";
export const ONE_LEARNER_EACH = "Each figure here rests on one learner who took both checks: read it as that learner's own change, not a class trend.";

function PhaseCard({ phase, saidAbove }: { phase: LearningGainPhase; saidAbove: boolean }) {
  const titleId = `learning-gain-title-${phase.phaseKey}`;
  return (
    <article className="exp-panel quiz-card" data-testid={`learning-gain-${phase.phaseKey}`} aria-labelledby={titleId}>
      <h3 id={titleId}>{phase.title}</h3>
      {phase.n === 0 ? (
        <p className="quiz-card-line">{LEARNING_GAIN_EMPTY}</p>
      ) : (
        <>
          <dl className="quiz-stats">
            <Stat label="Before" value={pct(phase.beforeAvgPct)} testId={`learning-gain-before-${phase.phaseKey}`} />
            <Stat label="After" value={pct(phase.afterAvgPct)} testId={`learning-gain-after-${phase.phaseKey}`} />
            <Stat label="Change" value={signedPoints(phase.deltaPct)} testId={`learning-gain-delta-${phase.phaseKey}`} />
            <Stat label="Learners with both checks" value={String(phase.n)} testId={`learning-gain-n-${phase.phaseKey}`} />
          </dl>
          {phase.n === 1 && !saidAbove && (
            <p className="quiz-card-line" data-testid={`learning-gain-one-${phase.phaseKey}`}>
              {ONE_LEARNER_CARD}
            </p>
          )}
          <PairedBar phase={phase} />
        </>
      )}
      {phase.learners.length > 0 && (
        <div className="quiz-table-scroll" role="region" aria-label={`${phase.title}: each learner`} tabIndex={0}>
          <table className="quiz-table" data-testid={`learning-gain-table-${phase.phaseKey}`}>
            <thead>
              <tr>
                <th scope="col">Learner</th>
                <th scope="col" className="is-number">
                  Before
                </th>
                <th scope="col" className="is-number">
                  After
                </th>
                <th scope="col" className="is-number">
                  Change
                </th>
              </tr>
            </thead>
            <tbody>
              {phase.learners.map((row, index) => (
                <tr key={index}>
                  <th scope="row">{row.learner}</th>
                  <td className="is-number">{pct(row.beforePct)}</td>
                  <td className="is-number">{pct(row.afterPct)}</td>
                  <td className="is-number">{row.deltaPct === null ? '—' : signedPoints(row.deltaPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

type Read = { key: string; gain: LearningGain } | { key: string; error: string };

export function LearningGainSection({ cohortId }: { cohortId: string }) {
  const [read, setRead] = useState<Read | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  useEffect(() => {
    let current = true;
    instructorApi.learningGain(cohortId).then(
      (gain) => {
        if (current) setRead({ key: cohortId, gain });
      },
      (err: unknown) => {
        if (current) setRead({ key: cohortId, error: describeError(err, 'Learning gain could not be read. Try again in a moment.') });
      },
    );
    return () => {
      current = false;
    };
  }, [cohortId]);

  async function download() {
    if (busy) return;
    setBusy(true);
    setDownloadError('');
    try {
      saveBlob(await instructorApi.exportLearningGain(cohortId), 'learning-gain.csv');
    } catch (err) {
      setDownloadError(describeError(err, 'The file could not be downloaded. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  }

  const here = read && read.key === cohortId ? read : null;
  const gain = here && 'gain' in here ? here.gain : null;
  const error = here && 'error' in here ? here.error : '';
  const phases = gain?.phases ?? [];
  // Every card with figures rests on one learner: said once, above them all,
  // rather than on each card.
  const measured = phases.filter((phase) => phase.n > 0);
  const oneEach = measured.length > 0 && measured.every((phase) => phase.n === 1);

  return (
    <section className="quiz-cards-section" aria-labelledby="learning-gain-heading" data-testid="learning-gain">
      <h2 id="learning-gain-heading" className="quiz-section-title">
        Learning gain
      </h2>
      <p className="quiz-section-note">
        Each phase has a quick check on what its chapter teaches, taken before the phase and again after it. The
        averages count only learners who took both.
      </p>
      {error ? (
        <p className="exp-panel quiz-error" role="alert">
          {error}
        </p>
      ) : !gain ? (
        <p className="exp-panel quiz-empty" role="status">
          Reading learning gain…
        </p>
      ) : phases.length === 0 ? (
        <p className="exp-panel quiz-empty" data-testid="learning-gain-empty">
          {LEARNING_GAIN_EMPTY}
        </p>
      ) : (
        <>
          {oneEach && (
            <p className="quiz-section-note" data-testid="learning-gain-one-each">
              {ONE_LEARNER_EACH}
            </p>
          )}
          <div className="quiz-cards">
            {phases.map((phase) => (
              <PhaseCard key={phase.phaseKey} phase={phase} saidAbove={oneEach} />
            ))}
          </div>
        </>
      )}
      {gain && (
        <div className="exp-actions quiz-downloads" aria-busy={busy || undefined}>
          <button
            type="button"
            className="exp-button"
            data-testid="learning-gain-download"
            disabled={busy}
            onClick={() => void download()}
          >
            {busy ? 'Downloading…' : 'Download learning-gain CSV'}
          </button>
        </div>
      )}
      {downloadError && (
        <p className="quiz-error" role="alert">
          {downloadError}
        </p>
      )}
    </section>
  );
}
