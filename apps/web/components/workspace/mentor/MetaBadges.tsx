'use client';

/**
 * What happened to one reply, said on the reply.
 *
 * Both shapes of message, a withheld answer and an ordinary one, use this one
 * label row, so they cannot drift apart. Two separate rows would carry
 * different parts (an ordinal and a reason on one; an ordinal, two chips and a
 * provider on the other), and neither would say anything at all about a reply
 * that came out of the cache.
 *
 * The row reads left to right: which question this is, what happened to it, and
 * who answered. An ordinary answer wears no chip, the absence is the label,
 * and only the four replies that are not ordinary get a sentence under them.
 *
 * It is text and a chip. Nothing here is focusable and nothing here is new tab
 * order; the row wraps rather than truncating, so at 320 px the three parts
 * stack. It sits inside the feed's `role="log" aria-live="polite"`, so a screen
 * reader hears "Question 4, withheld, because I will not write the fix for you"
 * as part of the message rather than as an event of its own.
 */
import type { AssistantMessageView, PhaseKey } from '@learnsdlc/shared';
import { Chip } from '@/components/ui';
import { PHASE_META } from '@/lib/phase';
import { outcomeLine, providerFor, providerNote, replyOutcome } from '@/lib/hints';

/** The chip one outcome wears, or null for the ordinary answer that wears none. */
const CHIPS = {
  withheld: { label: 'Withheld', tone: 'warn', testId: 'badge-redacted' },
  redirected: { label: 'Redirected', tone: 'accent', testId: 'badge-redirected' },
  cached: { label: 'Answered before', tone: 'neutral', testId: 'badge-cached' },
  budget: { label: 'Earlier token limit', tone: 'neutral', testId: 'badge-budget' },
} as const;

export function MetaBadges({
  meta,
  phaseKey,
  phaseTitle,
  ordinal,
}: {
  meta: AssistantMessageView['meta'];
  phaseKey: PhaseKey;
  /**
   * The phase's own title, so the redirect line names the room the learner is
   * in. Defaults to the pack-independent name for the phase, which is what the
   * feed has: the column knows its phase key and not its title.
   */
  phaseTitle?: string;
  /** Which question this reply answers, or undefined for a reply with none above it. */
  ordinal?: number;
}) {
  const title = phaseTitle ?? PHASE_META[phaseKey].title;
  const outcome = replyOutcome(meta);
  const chip = outcome === 'answered' ? null : CHIPS[outcome];
  const provider = providerFor(meta);
  const line = outcomeLine(outcome, phaseKey, title);
  return (
    <div className="flex flex-col gap-1" data-testid="reply-label">
      <p className="flex flex-wrap items-center gap-1.5">
        {ordinal !== undefined && (
          <span className="label-sm font-medium text-ink2" data-testid="reply-ordinal">
            Question {ordinal}
          </span>
        )}
        {chip && (
          <Chip tone={chip.tone} testId={chip.testId}>
            {chip.label}
          </Chip>
        )}
        {provider && (
          <span className="label-sm" data-testid="reply-provider" title={providerNote(meta?.provider)}>
            {provider}
          </span>
        )}
      </p>
      {/* The separator is a word, never a middle dot standing in for one, which
          is the one thing the product's voice does not do. The word is
          "because", and on a withheld answer the sentence begins with it. */}
      {line && (
        <p className="label-sm font-medium text-muted wrap" data-testid="reply-line">
          {line}
        </p>
      )}
    </div>
  );
}
