'use client';

/**
 * The merge, which is what a pull request is for.
 *
 * Before the gate it is a locked button with the reason next to it and the
 * message box already open, so the learner writes the "what changed and why"
 * while the argument is still in front of them. After the merge the same card
 * keeps the message (it is the changelog entry and the decision record) and
 * points at the phase that just opened.
 */
import { useState } from 'react';
import { andList, pluralWord, type PhaseKey, type PhaseSummary } from '@learnsdlc/shared';
import { PHASE_SPEC } from '@/components/phases/spec';
import { ownMentorPurpose } from '@/components/phases/experience';
import { PHASE_REVIEWER } from '@/lib/phase';
import { Button, PhaseTile, Section, StatusSquare } from '@/components/ui';
import { CommitField } from '@/components/workspace/CommitField';
import { REFLECTION_MIN, reflectionLength } from '@/components/workspace/MergePanel';
import { signOffPassLine } from '@/components/workspace/signoff-status';

/**
 * The note's floor, and how it is counted: the API's own rule
 * (`ReflectDto`, class-validator's `isLength`), through the one function the
 * merge sheet uses. `String.length` would count ten emoji as twenty, light
 * Merge, and the post would be refused.
 */
const MIN = REFLECTION_MIN;

/**
 * The purpose and the note's placeholder while the work waits on the
 * teacher's countersignature. "A Pass lets you complete this phase" and
 * "Leave blank to continue" would stand beside a Merge that cannot be pressed:
 * the work has passed, and only the countersignature opens the next phase,
 * or on the project's last phase passes it so the project can be completed
 * (`signOffPassLine`'s words).
 */
const PURPOSE = 'A Pass lets you complete this phase. You may leave an optional note about what changed and why.';
const signOffPurpose = (isLast: boolean) => `${signOffPassLine(isLast)} You may leave an optional note about what changed and why.`;
const PLACEHOLDER = 'Leave blank to continue, or record what you changed and learned.';
const SIGN_OFF_PLACEHOLDER = 'Record what you changed and learned, or leave it blank.';

/**
 * The Merge label on a split phase whose work
 * waits while a required task is still open. "A", "A and B", "A, B and C".
 */
export function openTasksWaitLabel(openTitles: readonly string[]): string {
  return `Available once ${andList([...openTitles])} ${pluralWord(openTitles.length, 'passes', 'pass')}`;
}

export function MergeCard({
  pr,
  merged,
  gateMet,
  reviewPassed = gateMet,
  waitLabel = 'Available after a Pass',
  score,
  gate,
  attempt,
  reason,
  reflection,
  next,
  nextPlace,
  nextHref,
  busy,
  submitLabel,
  submitLeads = true,
  submitReason,
  signOffPending = false,
  isLast = false,
  onMerge,
  onSubmitAgain,
  commitMessage,
  setCommitMessage,
  lastCommitMessage,
  reference = true,
}: {
  /** "PR-3". */
  pr: string;
  merged: boolean;
  /** Whether Merge may be pressed now. */
  gateMet: boolean;
  /**
   * Whether the review passed, which the status line reports.
   * The same as `gateMet` except on a phase ahead of the learner, where a
   * passed review waits for them to reach it; left out, it is `gateMet`.
   */
  reviewPassed?: boolean;
  /** What stands beside a Merge that is not open yet. */
  waitLabel?: string;
  score: number | null;
  gate: number;
  /** The submission the card is reporting on. */
  attempt: number | null;
  /** Why the gate is not met yet, in the report's own terms. */
  reason: string;
  /** The merge message, once it is written. */
  reflection: string | null;
  /** The phase the merge opens, when there is one. */
  next: PhaseSummary | null;
  /** That phase's place in its own project, printed before its title. */
  nextPlace?: number;
  nextHref: string;
  busy: boolean;
  /** "Submit PR-3 again", or "Submit PR-3" while the pull request has no revision yet (`prSubmitLabel`). */
  submitLabel: string;
  /**
   * Whether handing in is the next step (`prSubmitLeads`): then Submit is the
   * primary control; after a Pass, while the countersignature is awaited, it
   * is a secondary one. Left out, it is primary.
   */
  submitLeads?: boolean;
  /**
   * Why "Submit again" is off, when it is (the work passed and waits on the
   * teacher's countersignature). Left out, the button is on.
   */
  submitReason?: string;
  /**
   * The phase's work passed and waits on the
   * teacher's countersignature. While Merge is off it turns the purpose and
   * the note's placeholder to the sign-off words; left out, nothing changes.
   */
  signOffPending?: boolean;
  /** The phase is the project's last (`isLastPhase`): the sign-off words say the project can then be completed. */
  isLast?: boolean;
  onMerge: (message: string) => Promise<void>;
  /** Submit again, carrying the commit message for the new revision. */
  onSubmitAgain: (commitMessage: string) => void;
  /** The commit message draft for this phase, shared with the IDE's Commit tab. */
  commitMessage: string;
  setCommitMessage: (text: string) => void;
  /** The message the last revision carried, shown under the field. */
  lastCommitMessage?: string | null;
  /** The phase still runs the reference application (the commit field's example). */
  reference?: boolean;
}) {
  const [text, setText] = useState('');
  const length = reflectionLength(text.trim());
  const short = length > 0 && length < MIN;
  // Only while Merge is off: a gate the API's roll-up opens (a waiting
  // OPTIONAL task) keeps the ordinary words.
  const awaiting = signOffPending && !gateMet;
  // The next phase's standing purpose names the reference project's
  // deliverables; a phase that is wholly a teacher's own (an uploaded
  // project's) says what its own intro says, or nothing.
  const nextPurpose = !next ? '' : next.scenario === 'own' ? ownMentorPurpose(next.intro) : PHASE_SPEC[next.key as PhaseKey].purpose;

  if (merged) {
    return (
      <Section
        testId="phase-implementation-merged"
        title="Merged"
        purpose={
          attempt
            ? `Submission ${attempt} passed every required criterion.${
                next ? ` ${next.title} is open.` : ' The project is finished.'
              }`
            : 'This phase is merged.'
        }
      >
        <div className="rounded-ctl border-1.5 border-edge2 bg-ground px-3 py-2.5">
          <p className="label-sm">
            Your merge message, kept as docs/pr/{pr}.md
          </p>
          <p className="wrap mt-1 text-[13px] leading-[1.5] text-ink">
            {reflection || 'No merge message was recorded for this phase.'}
          </p>
        </div>
        {next && (
          <>
            <div className="flex items-center gap-3">
              <PhaseTile phaseKey={next.key as PhaseKey} size={40} icon />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13.5px] font-semibold text-ink">
                  Next: {nextPlace ? `${nextPlace}. ` : ''}{next.title}, with the {PHASE_REVIEWER[next.key as PhaseKey].role}
                </span>
                {nextPurpose && <span className="label-sm wrap">{nextPurpose}</span>}
              </div>
            </div>
            <Button href={nextHref} keys="⌘O" className="justify-center" testId="pr-open-next">
              Open {next.title}
            </Button>
          </>
        )}
      </Section>
    );
  }

  return (
    <Section
      testId="pr-merge"
      title="Merge"
      purpose={awaiting ? signOffPurpose(isLast) : PURPOSE}
    >
      <div className="flex items-center gap-2.5 rounded-ctl border-1.5 border-edge2 px-3 py-2.5">
        <StatusSquare state={attempt === null ? 'todo' : reviewPassed ? 'pass' : 'fail'} size={12} />
        <span className="wrap text-[13px] text-ink">
          {attempt === null
            ? 'Submit your work for an evidence-based review.'
            : reviewPassed
              ? 'Pass. Every required criterion has acceptable evidence.'
              : `Needs revision. ${reason}`}
        </span>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="label-sm text-ink2">Optional note: what changed and why</span>
        <textarea
          className="field min-h-[72px] resize-y text-[13px] leading-[1.5]"
          placeholder={awaiting ? SIGN_OFF_PLACEHOLDER : PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="reflection-input"
        />
      </label>
      {/* The commit message for the next revision, above the button that
          sends it. The same draft the IDE's Commit tab writes:
          one sentence about one revision, wherever it is typed. */}
      <CommitField value={commitMessage} onChange={setCommitMessage} last={lastCommitMessage} reference={reference} />
      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          variant={gateMet && !short ? 'primary' : 'secondary'}
          disabled={!gateMet || short}
          busy={busy}
          busyLabel="Merging"
          onClick={() => onMerge(text.trim())}
          testId="reflection-submit"
        >
          Merge {pr}
        </Button>
        <span className="label-sm">
          {gateMet
            ? short
              ? `At least ${MIN} characters`
              : 'Ready to merge'
            : reviewPassed
              ? waitLabel
              : 'Available after a Pass'}
        </span>
        <span className="flex-1" aria-hidden />
        {/* Only once a submission exists. Before one, this card sits in the page's closed "Submission
            status" fold and the header's Submit PR-<n> is the one in view; a second Submit, folded away,
            would be a control a person could not see and a script could not press. */}
        {attempt !== null && (
          <Button
            keys="⌘↵"
            variant={submitLeads ? 'primary' : 'secondary'}
            disabled={Boolean(submitReason)}
            reason={submitReason}
            onClick={() => onSubmitAgain(commitMessage)}
            testId="pr-submit-again"
          >
            {submitLabel}
          </Button>
        )}
      </div>
    </Section>
  );
}
