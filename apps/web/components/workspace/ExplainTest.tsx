'use client';

/**
 * "Explain this failure": one control beside a test that did not pass.
 *
 * It asks the reviewer the learner already has, in the thread they already
 * have, because that is what it is: a question about their code, typed on
 * their behalf. So it costs a hint, it is metered, and they can scroll back to
 * it tomorrow. Nothing about a reply changes: the answer arrives numbered,
 * with its provider under it, and withheld if the model wrote out the body.
 *
 * Pressing it a second time for the same test spends nothing: the question is
 * a fixed sentence, so the thread already in the browser says whether it has
 * been asked, and the button becomes a way back to the answer.
 */
import type { ExplainSource } from '@learnsdlc/shared';
import { explainedTests, type PersonaThread } from '@/components/shell';

export function ExplainTestButton({
  testName,
  source,
  sourceId,
  step,
  thread,
  onOpenThread,
  className = '',
}: {
  testName: string;
  source: ExplainSource;
  sourceId?: string;
  /** Which half of a full-stack result the case came from (the result's `steps[]`). */
  step?: string;
  /** Null on a page with no thread, a read-only view, where nothing is drawn. */
  thread?: PersonaThread | null;
  /** Bring the reviewer's column or tab into view. */
  onOpenThread?: () => void;
  className?: string;
}) {
  if (!thread || !thread.phaseStateId) return null;
  const asked = explainedTests(thread.messages).get(testName);
  const press = () => {
    onOpenThread?.();
    if (asked) {
      // Already answered: open the thread and go to the turn. No request, no
      // tokens, and nothing added to the count the process criterion charges.
      if (typeof document !== 'undefined') {
        document.getElementById(`msg-${asked}`)?.scrollIntoView({ block: 'center' });
      }
      return;
    }
    void thread.explain({ testName, source, sourceId, step });
  };
  return (
    <button
      type="button"
      onClick={press}
      // One thread, one turn at a time: every button on the page waits while
      // any of them is being answered.
      disabled={thread.busy && !asked}
      className={`btn-ghost btn-sm shrink-0 ${className}`}
      data-testid={`explain-${testName}`}
      aria-label={
        asked ? `Read why ${testName} fails` : `Explain why ${testName} fails`
      }
    >
      {thread.busy && !asked ? 'Asking…' : asked ? 'Read the explanation' : 'Explain this failure'}
    </button>
  );
}
