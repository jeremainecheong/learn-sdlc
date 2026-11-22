'use client';

/**
 * The control that submits a phase's work, as a page's header draws it.
 *
 * One name everywhere it is drawn: `Submit PR-<n>` before the phase's first
 * submission, `Submit PR-<n> again` once one exists ("Submit for review" and
 * "Submit again" on the written phases). One rule for where: it leads (the header's
 * primary button) while there is work to hand in (the workspace header's
 * `submitLeads`: in progress, a review that asked for more, credit still
 * wanting its review); otherwise (Continue is open, the review passed, the
 * countersignature is pending) it is a secondary control read inside the
 * header's Details, as the workspace keeps it inside More. Where it is read is
 * decided from the phase detail the page holds (`frameState`, the workspace
 * header's own reading).
 *
 * Given `onClick`, a press is the page's own submit. Given `submit` instead,
 * the control submits by itself (the incident drill, which had none): the
 * page's `before` (its own save) first, then the submission with the learner's
 * commit message (as the workspace's Submit sends it), the wait for its
 * verdict, the project's copy refreshed (so the header's chip and the gate band
 * say the verdict on this page) and the page's `after`. Once the submission is
 * taken, the commit draft is cleared and, on Deployment, the runbook's
 * "changed by the assistant" marks, as the workspace's Submit does.
 * The settled submission is handed to `after`, and the page holds it and draws
 * it on the header's row with `HeaderSubmitVerdict`: a pass, or a pass awaiting
 * the teacher's countersignature, moves this control into Details, which
 * mounts it afresh, so a verdict held here would be lost exactly then. When the
 * wait ends before the verdict, `after` is handed null and the page reads the
 * phase again, so the revision still in review holds Submit. A failure is said
 * beside the control. A press while `disabled` does nothing: the page's holds
 * (the countersignature awaited, a revision in review, an assistant operation)
 * are passed in as `disabled` with their `reason`.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { PhaseDetail, PhaseKey, SubmissionView } from '@learnsdlc/shared';
import { Button } from '@/components/ui';
import { clearCommitDraft, commitDraft } from '@/lib/commit';
import { api, describeError } from '@/lib/api';
import { jobWake } from '@/lib/job-signal';
import { PollTimeoutError, pollUntil } from '@/lib/poll';
import { invalidateProject } from '@/lib/useProject';
import { isWrittenPhase } from '@/lib/subset';
import { submitArgs } from './TaskPanel';
import { frameState } from './frameState';
import type { LearnerState } from './gate-state';
import { clearRunbookTouched } from './panels/deployment/runbook-edit';

/**
 * The label of a phase's submit control: "Submit for review" for a written
 * phase, `Submit PR-<n>` for a code phase, and "again" once a submission exists.
 */
export function phaseSubmitLabel(phase: { key: PhaseKey; place?: number | null }, hasPr: boolean): string {
  if (isWrittenPhase(phase.key)) return hasPr ? 'Submit again' : 'Submit for review';
  // A copy with no place (an older payload) names no number rather than "PR-".
  if (!phase.place) return hasPr ? 'Submit again' : 'Submit';
  return `Submit PR-${phase.place}${hasPr ? ' again' : ''}`;
}

/** What the settled review of a submission made from a header says: its verdict, from the submission alone. */
export function verdictSentence(job: Pick<SubmissionView, 'status' | 'passed'>): string {
  if (job.status === 'failed') return 'The review could not be completed.';
  return job.passed ? 'The review passed.' : 'The review asked for a revision.';
}

/** Whether Submit is the header's one primary action: the workspace header's rule (page.tsx, `submitLeads`). */
export function submitLeads(state: LearnerState | null): boolean {
  return state === 'inProgress' || state === 'revise' || state === 'credited';
}

/** Whether the phase has a submission: the workspace header's `hasPr` (a held verdict, or any attempt). */
export function phaseHasPr(phase: Pick<PhaseDetail, 'attempts' | 'lastSubmission'> | null | undefined): boolean {
  return Boolean(phase?.lastSubmission) || (phase?.attempts ?? 0) > 0;
}

type Held = Parameters<typeof frameState>[0] & Partial<Pick<PhaseDetail, 'place' | 'attempts'>>;

export interface HeaderSubmitProps {
  phase: Held;
  /** Whether a submission exists (the label's "again"); the phase's own record when left out. */
  hasPr?: boolean;
  testId?: string;
  keys?: string;
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
  reason?: string;
  onClick?: () => void;
  /**
   * The control submits by itself: `before` settles the page's own work, `after` reads the page's copy again
   * and is handed the settled submission (null when the wait ended before the verdict).
   */
  submit?: { before?: () => Promise<void>; after?: (settled: SubmissionView | null) => Promise<void> };
}

/** Where the strip reads this control: on its row while it leads, inside Details otherwise (WorkPage's PhaseStrip). */
function placement(props: HeaderSubmitProps): 'row' | 'details' {
  return submitLeads(frameState(props.phase)) ? 'row' : 'details';
}

export function HeaderSubmit(props: HeaderSubmitProps) {
  const { phase, testId, keys, busyLabel = 'In review', disabled, reason, onClick, submit } = props;
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const leads = placement(props) === 'row';
  const hasPr = props.hasPr ?? phaseHasPr(phase as Pick<PhaseDetail, 'attempts' | 'lastSubmission'>);
  const label = phaseSubmitLabel({ key: phase.key, place: phase.place }, hasPr);
  const own = async () => {
    if (!submit || running || disabled) return;
    setRunning(true);
    setError('');
    try {
      await submit.before?.();
      // What the learner said this revision changes, as the workspace's Submit sends it (page.tsx, doSubmit).
      const message = commitDraft(phase.id).trim();
      const started: SubmissionView = await api.submit(...submitArgs(phase.id, message || undefined, phase.tasks, null));
      // Recorded on the revision now: the draft is spent, and a submitted runbook carries no assistant marks.
      clearCommitDraft(phase.id);
      if (phase.key === 'deployment') clearRunbookTouched(phase.id);
      const settled = await pollUntil(() => api.getSubmission(started.id), (job) => job.status === 'completed' || job.status === 'failed', { wake: jobWake('submission', started.id) });
      invalidateProject();
      await submit.after?.(settled);
    } catch (err) {
      if (err instanceof PollTimeoutError) {
        // The revision is still in review: the page reads it again, so Submit is held with that sentence rather than refused.
        invalidateProject();
        await submit.after?.(null).catch(() => undefined);
        if (alive.current) setError('The review is still running. Open the workspace to read its verdict when it is ready.');
      } else if (alive.current) setError(describeError(err, 'The submission did not go through. Your work is saved; try again.'));
    } finally {
      if (alive.current) setRunning(false);
    }
  };
  return <>
    {/* The workspace header's size (`size="sm"`, workspace/[phaseId]/page.tsx), so Submit is one size on every page of a phase. */}
    <Button
      size="sm"
      variant={leads ? 'primary' : 'secondary'}
      keys={keys}
      testId={testId}
      busy={props.busy ?? running}
      busyLabel={busyLabel}
      disabled={disabled}
      reason={reason}
      onClick={onClick ?? (() => void own())}
    >
      {label}
    </Button>
    {error && <span role="alert" className="label-sm text-fail" data-testid="header-submit-error">{error}</span>}
  </>;
}

/**
 * The verdict of a submission made from a header's Submit, with the way to the review (the verdict is read in
 * the room). The page holds the settled submission and passes this beside `HeaderSubmit` in its header's controls,
 * so it stays on the row when the verdict moves Submit into Details.
 */
export function HeaderSubmitVerdict({ phaseId, settled }: { phaseId: string; settled: Pick<SubmissionView, 'status' | 'passed'> }) {
  return <span role="status" className="label-sm" data-testid="header-submit-verdict">{verdictSentence(settled)} <Link href={`/workspace/${phaseId}`}>Read the review</Link></span>;
}
/** Read by PhaseStrip without rendering: where this element goes in the header. */
HeaderSubmit.headerPlacement = placement;
