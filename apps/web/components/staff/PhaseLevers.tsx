'use client';

/**
 * The phase's own levers, for the teacher looking at one learner.
 *
 * Four levers over a whole phase (Pass, Reopen (Unlock early on a locked
 * one), Reset the workspace and Reset this phase) plus a regrade of that one
 * learner's phase. The three per-task levers (`LearnerTasks`) draw nothing on
 * a phase whose list is the synthesised sole task: every phase of the default
 * project. The server serves all five (`POST …/override` with a
 * `PhaseOverrideAction` and no task key; `POST /instructor/regrades` with a
 * `userId`), and its own refusal of a per-task lever on such a phase tells the
 * teacher to "use Pass, Reopen or Reset phase". This panel is those buttons,
 * on every phase the evidence panel can open.
 *
 * It asks before it acts, in the same in-page two-button shape `LearnerTasks`
 * asks with, and every question says what the lever does: including that a
 * Pass credits the board and does not stand in for the review the
 * strict-evidence gate wants. The answer's `note` (the sentence a lever may add about what
 * it could not do on its own) is drawn, not only announced.
 */
import { useId, useState } from 'react';
import type { InstructorPhaseView, PhaseOverrideAction, RegradeBatchView } from '@learnsdlc/shared';
import { OVERRIDE_REASON_MIN } from '@learnsdlc/shared';
import { describeError } from '@/lib/api';
import { instructorApi } from '@/lib/api-instructor';
import { phaseStatusWord } from '@/components/staff/LearnerTasks';
import { REGRADE_POLL_MS } from '@/components/staff/RegradePanel';
import { ReasonCount } from '@/components/staff/primitives';

/** The four phase-wide overrides, and the single-learner regrade beside them. */
type PhaseLever = Extract<PhaseOverrideAction, 'pass' | 'reopen' | 'reset-workspace' | 'reset-phase'> | 'regrade';

const PHASE_LEVERS: PhaseLever[] = ['pass', 'reopen', 'reset-workspace', 'reset-phase', 'regrade'];

/** How long the panel waits on a batch of one before saying it is still going. */
const PHASE_REGRADE_MAX_WAIT_MS = 300_000;

/** What each lever's button says. */
function phaseLeverWord(lever: PhaseLever, phase: Pick<InstructorPhaseView, 'status'>): string {
  switch (lever) {
    case 'pass':
      return 'Mark as passed';
    case 'reopen':
      return phase.status === 'locked' ? 'Unlock early' : 'Reopen';
    case 'reset-workspace':
      return 'Reset the workspace';
    case 'reset-phase':
      return 'Reset this phase';
    default:
      return 'Regrade this phase';
  }
}

/**
 * Why a lever is not offered on this phase, or null when it is: each the
 * fact the route would answer with (`overridePhase`: `pass` conflicts on a
 * passed phase and `reopen` on an open one), said before the press.
 */
function phaseLeverUnavailable(
  lever: PhaseLever,
  phase: Pick<InstructorPhaseView, 'status' | 'title' | 'lastSubmission'>,
): string | null {
  if (lever === 'pass' && phase.status === 'passed') return `${phase.title} is already passed.`;
  if (lever === 'reopen' && phase.status === 'in_progress') return `${phase.title} is already open.`;
  if (lever === 'regrade' && !phase.lastSubmission) return `${phase.title} has no revision to re-run yet.`;
  return null;
}

/** The one question each lever asks before it acts. */
function phaseLeverQuestion(
  lever: PhaseLever,
  phase: Pick<InstructorPhaseView, 'status' | 'title' | 'passThreshold'>,
  name: string,
): string {
  switch (lever) {
    case 'pass':
      return (
        `Mark ${phase.title} as passed for ${name}? It reads passed on the board at the pass mark of ` +
        `${phase.passThreshold}, or their best score if that is higher. A Pass credits the work; it does not ` +
        `stand in for the review, so ${name} moves on only once the work has a reviewed pass of its own, and ` +
        `the answer says whether one is still owed.`
      );
    case 'reopen':
      return phase.status === 'locked'
        ? `Unlock ${phase.title} for ${name} now, before they reach it? It opens for them to work in, and ` +
            `nothing they have done in any other phase changes.`
        : `Reopen ${phase.title} for ${name}? Its pass is withdrawn and they can edit and resubmit it. ` +
            `Their scores and revisions stay on the record.`;
    case 'reset-workspace':
      return (
        `Reset ${name}'s ${phase.title} workspace to the starting files? The files they have there now are ` +
        `replaced. Their revisions, verdict and score stay.`
      );
    case 'reset-phase':
      return (
        `Reset ${phase.title} for ${name}? It clears their files, links, incident write-up, merge message and ` +
        `verdict for this phase, and removes the release it recorded. The revision history is kept, and later ` +
        `phases keep their work. This cannot be undone.`
      );
    default:
      return (
        `Regrade ${phase.title} for ${name}? Their newest revision is re-run against the project's current ` +
        `content, and the new verdict is added beside the old one: a score can only go up, and a pass is ` +
        `never withdrawn.`
      );
  }
}

/** What a finished override says, before the lever's own note. */
function doneSentence(lever: PhaseOverrideAction, before: InstructorPhaseView, after: InstructorPhaseView, name: string): string {
  switch (lever) {
    case 'pass':
      return `${before.title} now reads ${phaseStatusWord(after)}.`;
    case 'reopen':
      return before.status === 'locked'
        ? `${before.title} is unlocked for ${name}.`
        : `${before.title} reopened. ${name} can edit and resubmit it.`;
    case 'reset-workspace':
      return `${before.title} workspace reset to the starting files.`;
    default:
      return `${before.title} was reset. The reason you gave is in the record of changes.`;
  }
}

/** What a finished (or unfinished) regrade of one learner's phase says. */
function regradeSentence(batch: RegradeBatchView, phaseTitle: string): string {
  if (batch.status === 'running')
    return `The regrade of ${phaseTitle} is still running. It carries on in the background, and the evidence here updates once it lands.`;
  if (batch.status === 'stopped')
    return `${phaseTitle} was not regraded: the code runner could not be reached. Nothing was changed.`;
  if (batch.requested === 0)
    return `${phaseTitle} was not regraded: ${batch.skipped[0]?.reason ?? 'there was no revision to re-run.'}`;
  if (batch.failed > 0) return `${phaseTitle} could not be re-run. The old verdict is unchanged.`;
  return `${phaseTitle} was regraded on version ${batch.packVersionTo ?? 'current'}. The new verdict is a revision beside the old one.`;
}

export function PhaseLevers({
  userId,
  learnerName,
  projectSlug,
  phase,
  onPhase,
  onRegraded,
}: {
  userId: string;
  /** What to call the learner in a question about their work. */
  learnerName: string;
  /** The project the phase belongs to, which a regrade is filed under. */
  projectSlug: string;
  phase: InstructorPhaseView;
  /** The phase as the override left it, so the page around this redraws. */
  onPhase: (phase: InstructorPhaseView & { note?: string }) => void;
  /** A regrade moved the revision, the score and the status on the server. */
  onRegraded?: () => void;
}) {
  const base = useId().replace(/[^\w-]/g, '');
  const [asking, setAsking] = useState<PhaseLever | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [note, setNote] = useState('');

  const ask = (lever: PhaseLever) => {
    setAsking(lever);
    setReason('');
    setError('');
    setSaid('');
    setNote('');
  };

  const regrade = async (trimmed: string): Promise<string> => {
    let batch = await instructorApi.regradeStart({
      projectSlug,
      phaseKey: phase.key,
      scope: 'everyone',
      reason: trimmed,
      userId,
    });
    // Bounded: a batch is queue work and keeps running whatever this page does.
    for (
      let waited = 0;
      batch.status === 'running' && waited < PHASE_REGRADE_MAX_WAIT_MS;
      waited += REGRADE_POLL_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, REGRADE_POLL_MS));
      batch = await instructorApi.regradeStatus(batch.id);
    }
    onRegraded?.();
    return regradeSentence(batch, phase.title);
  };

  const send = async (lever: PhaseLever) => {
    const trimmed = reason.trim();
    if (busy || trimmed.length < OVERRIDE_REASON_MIN) return;
    setBusy(true);
    setError('');
    try {
      if (lever === 'regrade') {
        setSaid(await regrade(trimmed));
        setNote('');
      } else {
        const next = await instructorApi.override(userId, phase.id, lever, trimmed);
        onPhase(next);
        setSaid(doneSentence(lever, phase, next, learnerName));
        setNote(next.note?.trim() ?? '');
      }
      setAsking(null);
      setReason('');
    } catch (err) {
      // The typed reason is kept, so a refused lever is one press from a retry.
      setError(describeError(err, 'That did not go through. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const confirmId = `${base}-phase-lever-confirm`;
  const reasons = PHASE_LEVERS.map((lever) => [lever, phaseLeverUnavailable(lever, phase)] as const).filter(
    (pair): pair is readonly [PhaseLever, string] => pair[1] !== null,
  );

  return (
    <section className="exp-panel" data-testid="phase-levers" aria-labelledby={`${base}-heading`}>
      <header className="exp-section-heading">
        <div>
          <span className="exp-eyebrow">The whole phase</span>
          <h2 id={`${base}-heading`}>{phase.title} for {learnerName}</h2>
          <p>
            For a learner the gate is holding back unfairly, or a phase that has to begin again. Each lever is
            recorded with your name and the reason you give.
          </p>
        </div>
      </header>
      <p aria-live="polite" role="status" className="exp-caption" data-testid="phase-levers-said">
        {said}
      </p>
      {note && (
        <p className="exp-inline-note" data-testid="phase-levers-note">
          {note}
        </p>
      )}
      <div className="exp-actions">
        <span className="flex flex-wrap items-center gap-2">
          {PHASE_LEVERS.map((lever) => {
            const off = phaseLeverUnavailable(lever, phase);
            return (
              <button
                key={lever}
                type="button"
                className="exp-button"
                data-testid={`phase-lever-${lever}`}
                disabled={Boolean(off) || busy}
                title={off ?? undefined}
                aria-describedby={off ? `${base}-why-${lever}` : undefined}
                aria-expanded={asking === lever}
                aria-controls={asking === lever ? confirmId : undefined}
                onClick={() => ask(lever)}
              >
                {phaseLeverWord(lever, phase)}
              </button>
            );
          })}
        </span>
      </div>
      {reasons.length > 0 && (
        <p className="exp-caption">
          {reasons.map(([lever, why]) => (
            <span key={lever} id={`${base}-why-${lever}`}>
              {why}{' '}
            </span>
          ))}
        </p>
      )}
      {asking && (
        <div className="exp-inline-note mt-2" role="status" id={confirmId} data-testid="phase-lever-confirm">
          <div>
            <span className="block">{phaseLeverQuestion(asking, phase, learnerName)}</span>
            <label className="exp-field mt-2">
              Your reason, kept on the record of changes
              <textarea
                rows={3}
                required
                minLength={OVERRIDE_REASON_MIN}
                value={reason}
                disabled={busy}
                data-testid="phase-lever-reason"
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="exp-caption">At least {OVERRIDE_REASON_MIN} characters. It is recorded with your name.</p>
              <ReasonCount value={reason} min={OVERRIDE_REASON_MIN} />
            </div>
            {error && (
              <p role="alert" className="exp-error" data-testid="phase-lever-error">
                {error}
              </p>
            )}
            <span className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="exp-button exp-primary"
                disabled={busy || reason.trim().length < OVERRIDE_REASON_MIN}
                data-testid="phase-lever-do"
                onClick={() => void send(asking)}
              >
                {busy ? 'Recording…' : phaseLeverWord(asking, phase)}
              </button>
              <button
                type="button"
                className="exp-button"
                disabled={busy}
                data-testid="phase-lever-cancel"
                onClick={() => {
                  setAsking(null);
                  setReason('');
                  setError('');
                }}
              >
                Leave it as it is
              </button>
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
