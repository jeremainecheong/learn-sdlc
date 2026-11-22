'use client';

/**
 * Deep validation, from the editor.
 *
 * Deep validation runs the draft in the sandbox and asks no AI model: (a) the
 * reference solution passes its hidden suite, (b) the starter fails it, (c)
 * every mutant is killed by the reference tests, (d) the deployment smoke
 * check passes. It boots microVMs, so two rules hold here:
 *
 * **The warning comes first.** The start control lives in a dialog that reads
 * the draft afresh and stays off until the warning (the contract's
 * `deepValidationCostWarning`, in microVMs and never in money) has been
 * drawn. The start is described by that sentence.
 *
 * **The start sends what the teacher read.** `acknowledgedMicroVMs` is the
 * count in the warning on screen; the API refuses, and boots nothing, if the
 * draft would boot any other number by then.
 *
 * The result is the four checks a to d, each in its own sentence, and a line
 * saying when the stored run no longer matches the draft. A run in flight is
 * read again every few seconds until it settles.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DeepValidationCheckId, DeepValidationCheckView, DeepValidationView } from '@learnsdlc/shared';
import { DEEP_VALIDATION_CHECK_IDS, deepValidationCostWarning } from '@learnsdlc/shared';
import { Button, Chip, Notice, Section } from '@/components/ui';
import { projectsApi } from '@/lib/api-projects';
import { StaffDialog } from '@/components/staff/StaffDialog';
import { refusalOf } from '@/components/staff/projects/refusal';
import { describeInstant } from '@/lib/schedule';

/** How often a run in flight is read again. */
export const DEEP_VALIDATION_POLL_MS = 4000;

const LETTER: Record<DeepValidationCheckId, string> = {
  'solution-passes-hidden': 'a',
  'starter-fails-hidden': 'b',
  'mutants-killed': 'c',
  'smoke-passes': 'd',
};

const LABEL: Record<DeepValidationCheckId, string> = {
  'solution-passes-hidden': 'The reference solution passes its hidden suite',
  'starter-fails-hidden': 'The starter fails the hidden suite',
  'mutants-killed': 'Every mutant is killed by the reference tests',
  'smoke-passes': 'The deployment smoke check passes',
};

const STATUS_LINE: Record<DeepValidationView['status'], string> = {
  'not-run': 'Not run on this draft yet.',
  queued: 'Queued, waiting for a sandbox slot.',
  running: 'Running, one microVM at a time.',
  passed: 'Passed.',
  failed: 'Failed. Each check below says why.',
};

function checkChip(status: DeepValidationCheckView['status']) {
  if (status === 'passed') return <Chip tone="pass">Passed</Chip>;
  if (status === 'failed') return <Chip tone="fail">Failed</Chip>;
  if (status === 'not-applicable') return <Chip tone="outline">Does not apply</Chip>;
  return <Chip tone="neutral">Not run yet</Chip>;
}

const inFlight = (view: DeepValidationView | null) => view?.status === 'queued' || view?.status === 'running';

export function DeepValidationPanel({
  projectId,
  versionId,
  editable,
  refreshKey = 0,
  onView,
}: {
  projectId: string;
  versionId: string;
  /** False on a version that is not a draft the caller may change: the result shows, the start does not. */
  editable: boolean;
  /** Bumped by the editor after a sealed write, so the stored run is read again. */
  refreshKey?: number;
  /** Told each view this panel reads, so the editor's rail follows it without a read of its own. */
  onView?: (view: DeepValidationView | null) => void;
}) {
  const warningId = useId();
  const [view, setView] = useState<DeepValidationView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [startError, setStartError] = useState('');
  const [asking, setAsking] = useState(false);
  const [fresh, setFresh] = useState<DeepValidationView | null>(null);
  const [freshError, setFreshError] = useState('');
  const [starting, setStarting] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const alive = useRef(true);
  /**
   * Counts failed reads. A failed read leaves the view as it was, so without
   * this a run in flight would never be polled again after one failure.
   */
  const [misses, setMisses] = useState(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    try {
      const next = await projectsApi.deepValidation(projectId, versionId);
      if (!alive.current) return;
      setView(next);
      setLoadError('');
    } catch (err) {
      if (alive.current) {
        setLoadError(refusalOf(err, 'Deep validation could not be read. Try again in a moment.'));
        setMisses((n) => n + 1);
      }
    }
  }, [projectId, versionId]);

  useEffect(() => {
    void read();
  }, [read, refreshKey]);

  // The rail above reads what this panel reads, polls included.
  useEffect(() => {
    onView?.(view);
  }, [view, onView]);

  // A run in flight is read again until it settles.
  const status = view?.status ?? null;
  useEffect(() => {
    if (status !== 'queued' && status !== 'running') return;
    const timer = setTimeout(() => void read(), DEEP_VALIDATION_POLL_MS);
    return () => clearTimeout(timer);
  }, [status, view, read, misses]);

  const open = async () => {
    setStartError('');
    setFresh(null);
    setFreshError('');
    setAsking(true);
    try {
      const next = await projectsApi.deepValidation(projectId, versionId);
      if (!alive.current) return;
      setFresh(next);
      setView(next);
    } catch (err) {
      if (alive.current) setFreshError(refusalOf(err, 'How many microVMs this run boots could not be read. Try again in a moment.'));
    }
  };

  const close = () => {
    if (starting) return;
    setAsking(false);
    setFresh(null);
  };

  const start = async () => {
    if (!fresh) return;
    setStarting(true);
    try {
      const next = await projectsApi.startDeepValidation(projectId, versionId, {
        acknowledgedMicroVMs: fresh.costWarning.microVMs,
      });
      if (!alive.current) return;
      setView(next);
    } catch (err) {
      if (alive.current) setStartError(refusalOf(err, 'Deep validation could not be started. Try again in a moment.'));
    } finally {
      if (alive.current) {
        setStarting(false);
        setAsking(false);
        setFresh(null);
        // The opener is off while the run is in flight, so focus goes to the
        // line that says what the run is doing rather than to the page's top.
        requestAnimationFrame(() => {
          if (opener.current?.disabled) statusRef.current?.focus();
        });
      }
    }
  };

  const checks: DeepValidationCheckView[] = DEEP_VALIDATION_CHECK_IDS.map(
    (id) =>
      view?.checks.find((one) => one.id === id) ?? {
        id,
        status: 'pending',
        sentence: 'This check has not run on this draft.',
        phaseKey: null,
        taskKey: null,
      },
  );
  const stale = Boolean(view && view.contentDigest && !view.current && !inFlight(view));
  const warning = fresh ? deepValidationCostWarning(fresh.costWarning.microVMs) : '';

  return (
    <Section
      title="Deep validation"
      purpose="Runs this draft in the sandbox with no AI model: the solution must pass its hidden suite, the starter must fail it, every mutant must die, and the deployment smoke check must pass. Publishing a coding or testing phase of your own needs a passing run."
      testId="deep-validation"
      right={
        editable ? (
          <button
            ref={opener}
            type="button"
            className="btn btn-sm"
            data-testid="deep-validation-open"
            disabled={inFlight(view)}
            onClick={() => void open()}
          >
            Run deep validation
          </button>
        ) : undefined
      }
    >
      {loadError && (
        <Notice tone="fail" role="alert" testId="deep-validation-load-error">
          {loadError}
        </Notice>
      )}
      {startError && (
        <Notice tone="fail" role="alert" testId="deep-validation-error-box">
          <span data-testid="deep-validation-error">{startError}</span>
        </Notice>
      )}

      <p ref={statusRef} tabIndex={-1} className="purpose wrap outline-none" role="status" data-testid="deep-validation-status">
        {view ? STATUS_LINE[view.status] : 'Reading the last deep validation of this draft.'}
        {view?.finishedAt ? ` Finished on ${describeInstant(view.finishedAt)}.` : ''}
      </p>

      {stale && (
        <Notice tone="warn" testId="deep-validation-stale">
          This run was made against an earlier state of the draft. Run deep validation again before you publish.
        </Notice>
      )}

      <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label="The four checks">
        {checks.map((check) => (
          <li
            key={check.id}
            className="flex min-w-0 flex-col gap-1 rounded-ctl border-1.5 border-edge px-3 py-2"
            data-testid={`deep-validation-check-${check.id}`}
          >
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="mono text-[12.5px] text-muted">{`${LETTER[check.id]}.`}</span>
              <span className="min-w-0 flex-1 text-[13px] font-medium text-ink">{LABEL[check.id]}</span>
              {checkChip(check.status)}
            </span>
            <span className={`wrap text-[13px] leading-[1.45] ${check.status === 'failed' ? 'text-fail' : 'text-ink2'}`}>
              {check.sentence}
            </span>
          </li>
        ))}
      </ol>

      {asking && (
        <StaffDialog
          title="Before deep validation starts"
          describedBy={fresh ? warningId : undefined}
          onClose={close}
          closable={!starting}
          returnFocus={opener}
          testId="deep-validation-dialog"
        >
          {freshError && (
            <Notice tone="fail" role="alert">
              {freshError}
            </Notice>
          )}
          {fresh ? (
            <p id={warningId} className="m-0 wrap text-[13.5px] leading-[1.5] text-ink" data-testid="deep-validation-warning">
              {warning}
            </p>
          ) : (
            !freshError && (
              <p className="purpose" role="status" data-testid="deep-validation-reading">
                Reading how many microVMs this run boots.
              </p>
            )
          )}
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              className="btn"
              data-testid="deep-validation-start"
              disabled={!fresh || starting}
              aria-busy={starting || undefined}
              aria-describedby={fresh ? warningId : undefined}
              onClick={() => void start()}
            >
              {starting ? 'Starting…' : 'Start deep validation'}
            </button>
            <Button variant="ghost" testId="deep-validation-cancel" onClick={close} disabled={starting}>
              Not now
            </Button>
          </div>
        </StaffDialog>
      )}
    </Section>
  );
}
