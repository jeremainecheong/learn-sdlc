'use client';

/**
 * Where you ask the customer, and the count of how many questions are left.
 *
 * The cap is the pack's, not the product's: a customer with ten minutes is the
 * reason the room ends, and the composer says so before it closes rather than
 * refusing a question after it has been typed. A disabled control says why
 * beside it, which is the rule everywhere else in this product too.
 */
import { INTERVIEW_CLOSED_MESSAGE } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { Notice } from '@/components/ui';

/** The API's own floor, so a question it would refuse never leaves the box. */
const MIN_QUESTION = 3;

export function Composer({
  personaName,
  draft,
  setDraft,
  onSend,
  busy,
  turnsLeft,
  /** Why the composer is off when it is off and the turns are not the reason. */
  blockedReason,
}: {
  personaName: string;
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  turnsLeft: number;
  blockedReason?: string;
}) {
  const closed = turnsLeft <= 0;
  const reason = closed ? INTERVIEW_CLOSED_MESSAGE : blockedReason || '';
  const disabled = closed || Boolean(blockedReason);
  const label = `Ask ${personaName} a question`;

  return (
    <div className="shrink-0 border-t-1.5 border-edge px-5 py-3.5" data-testid="interview-composer">
      {reason && (
        <div className="mb-2.5">
          <Notice tone={closed ? 'info' : 'warn'} testId="interview-closed">
            {reason}
          </Notice>
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          aria-label={label}
          className="field max-h-32 min-h-[38px] flex-1 resize-y py-[8px] text-[13px]"
          placeholder="Ask the customer a question"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              onSend();
            }
          }}
          data-testid="interview-input"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={disabled || busy || draft.trim().length < MIN_QUESTION}
          data-testid="interview-send"
          className="btn h-[38px] w-[38px] shrink-0 !px-0"
          aria-label="Ask"
        >
          <Icon name="send" size={15} />
        </button>
      </div>
      <p className="label-sm mt-2 tabular-nums" data-testid="interview-turns-left">
        {closed
          ? 'No questions left'
          : `${turnsLeft} question${turnsLeft === 1 ? '' : 's'} left`}
      </p>
    </div>
  );
}
