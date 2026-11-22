'use client';

/**
 * What a review runs, while it runs.
 *
 * The server reports two states for a submission in flight, `queued` and
 * `running`, and the time it recorded the submission. That is all this draws
 * from: the fixed words for the work a review of this checks kind involves,
 * and the seconds since the server recorded it. The server never says which
 * check has finished, so no step here is ever marked done, and nothing is
 * drawn as a percentage or an estimate.
 *
 * A typical-wait line ("Usually about N s.") is drawn only from a measured
 * value handed in as `typicalSeconds`. No call site hands one in until the
 * live read has measured it; `review-steps.test.tsx` checks that.
 *
 * The steps are one unordered group, never numbered: with a fan-out set, the
 * visible and hidden suites run together, and the reference and the planted
 * bugs can overlap, so no order is claimed. The Testing words name no count of
 * planted bugs, since packs plant different numbers (TaskTrackr eight, the
 * starter four).
 *
 * The ticking time is plain text, never a live region, so a screen reader is
 * not handed a count every second. The sentence each call site already shows
 * stays the announced one.
 */
import { useEffect, useId, useState } from 'react';
import type { ArtifactKind, JobStatus } from '@learnsdlc/shared';

type StepKind = Exclude<ArtifactKind, 'quiz'>;

/** The work a review of each checks kind involves; the runs may overlap, so no order is implied. */
export const REVIEW_STEPS: Readonly<Record<StepKind, readonly string[]>> = {
  code: ['Running your visible tests', 'Running the hidden tests', 'AI review'],
  tests: ['Running your suite on the reference', 'Running it against the planted bugs', 'AI review'],
  config: ['Checking the configuration', 'Running the smoke test', 'AI review'],
  story: ['Checking the record', 'AI review'],
  design: ['Checking the record', 'AI review'],
};

/** The steps for a kind, or null for a kind with no fixed words (a quiz, or a kind not known yet). */
export function reviewStepsFor(kind: ArtifactKind | undefined | null): readonly string[] | null {
  return kind && kind !== 'quiz' ? REVIEW_STEPS[kind] : null;
}

/** A wait in plain words: seconds, then minutes and seconds, then no more counting. */
export function elapsedWords(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds >= 3600) return 'over an hour';
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/**
 * Milliseconds since `since`, a server timestamp, counted once a second. Null
 * until mounted (the server draws no clock) and for a time that does not parse.
 * A browser clock behind the server's reads as zero, never as a negative wait;
 * one ahead overstates the wait by the difference, and nothing is claimed
 * beyond the time since the server's record. Pass null to stop the clock.
 */
export function useElapsedMs(since: string | null | undefined): number | null {
  const start = since ? Date.parse(since) : Number.NaN;
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!Number.isFinite(start)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [start]);
  return now === null || !Number.isFinite(start) ? null : Math.max(0, now - start);
}

export function ReviewSteps({
  kind,
  status,
  since,
  typicalSeconds,
}: {
  kind: ArtifactKind | undefined | null;
  /** The submission's own status; the list is drawn only while it is in flight. */
  status: JobStatus;
  /** The submission's `createdAt`, as the server recorded it. */
  since: string | null | undefined;
  /** A measured typical wait in seconds. Left out, nothing is said about how long it usually takes. */
  typicalSeconds?: number | null;
}) {
  const inFlight = status === 'queued' || status === 'running';
  // The clock runs only while something is drawn: a failed or settled review
  // (the requirements room mounts this for both) keeps no interval going.
  const elapsedMs = useElapsedMs(inFlight ? since : null);
  const leadId = useId();
  if (!inFlight) return null;
  const steps = reviewStepsFor(kind);
  const state = status === 'queued' ? 'Queued' : 'Running';
  const typical = typeof typicalSeconds === 'number' && Number.isFinite(typicalSeconds) && typicalSeconds > 0
    ? Math.round(typicalSeconds)
    : null;
  return (
    <div className="mt-2 pl-[23px] text-[12.5px] text-muted" data-testid="review-steps">
      <p className="tabular-nums text-ink2" data-testid="review-elapsed">
        {elapsedMs === null ? state : `${state} for ${elapsedWords(elapsedMs)}`}
      </p>
      {steps && (
        <>
          <p className="mt-1.5" id={leadId} data-testid="review-steps-lead">While the review runs:</p>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-5" aria-labelledby={leadId}>
            {steps.map(step => (
              <li key={step} className="leading-relaxed">{step}</li>
            ))}
          </ul>
        </>
      )}
      {typical !== null && <p className="mt-1.5" data-testid="review-typical">{`Usually about ${typical} s.`}</p>}
    </div>
  );
}
