'use client';

/**
 * The commit message for the next revision: one line, the shape of a commit
 * subject, saying what this submission changes.
 *
 * It is the same field in two places, the Commit tab in the IDE and the row
 * above "Submit again" on the pull request, reading and writing one draft
 * (lib/commit.ts), because it is one sentence about one revision.
 *
 * Nothing here can stop a submission. The message is a habit the product is
 * teaching, not a gate: a gate in front of the fast loop the whole IDE exists
 * for would be paid for on every attempt, by every learner, for ever. A
 * revision submitted with the field empty is recorded as one with no message.
 */
import { useId } from 'react';
import { COMMIT_MESSAGE_MAX } from '@learnsdlc/shared';
import { Kbd } from '@/components/ui';
import { REFERENCE_COPY } from './reference/copy';

export function CommitField({
  value,
  onChange,
  /** The message the last revision of this phase carried, when there is one. */
  last,
  /** The key that sends it, printed beside the label. */
  keys = '⌘↵',
  className = '',
  /**
   * Whether the phase still runs the reference application.
   * The example message is TaskTrackr's own bug, so a teacher's application
   * gets a placeholder that says what the field is for instead.
   */
  reference = true,
}: {
  value: string;
  onChange: (text: string) => void;
  last?: string | null;
  keys?: string;
  className?: string;
  reference?: boolean;
}) {
  const id = useId();
  const left = COMMIT_MESSAGE_MAX - value.length;
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className}`} data-testid="commit-field">
      <label htmlFor={id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="label-sm text-ink2">Commit message: what this revision changes</span>
        <span className="flex-1" aria-hidden />
        <span className="label-sm inline-flex items-center gap-1.5">
          Sends with <Kbd>{keys}</Kbd>
        </span>
      </label>
      <input
        id={id}
        type="text"
        className="field text-[13px]"
        // The counter and the API's limit are one constant, so the field can
        // never accept a line the API will refuse.
        maxLength={COMMIT_MESSAGE_MAX}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={reference ? REFERENCE_COPY.commitPlaceholder : 'Say what this revision changes'}
        data-testid="commit-input"
      />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="label-sm" aria-live="polite" data-testid="commit-count">
          {left} of {COMMIT_MESSAGE_MAX} left
        </span>
        <span className="flex-1" aria-hidden />
        {last && (
          <span className="label-sm wrap min-w-0" data-testid="commit-last">
            Last time: {last}
          </span>
        )}
      </div>
    </div>
  );
}
