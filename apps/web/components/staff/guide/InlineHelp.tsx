'use client';

/**
 * One collapsible "What is this?" line per editor section
 * (tasks, quiz, sealed files, runtime, budget, interview), and the hint under
 * a Requirements phase that has no interview.
 */
import type { DraftPhaseView, InlineHelpKey } from '@learnsdlc/shared';
import { INLINE_HELP, INTERVIEW_PHASE, NO_INTERVIEW_HINT } from '@learnsdlc/shared';
import { Notice } from '@/components/ui';

export function InlineHelp({ topic, className = '' }: { topic: InlineHelpKey; className?: string }) {
  const help = INLINE_HELP[topic];
  return (
    <details className={`min-w-0 text-[12.5px] ${className}`} data-testid={`inline-help-${topic}`}>
      {/* The topic is drawn, not only read out: two of these stacked in one
          section, both reading "What is this?", would look like one line twice. */}
      <summary className="cursor-pointer text-ink2">
        What is this?
        <span className="text-muted">{` About ${help.topic}.`}</span>
      </summary>
      <p className="purpose wrap mt-1">{help.line}</p>
    </details>
  );
}

/** Under a Requirements phase with no interview: where one comes from. */
export function InterviewHint({ phase }: { phase: Pick<DraftPhaseView, 'key' | 'interview'> }) {
  if (phase.key !== INTERVIEW_PHASE || phase.interview) return null;
  return (
    <Notice tone="info" icon="info" testId="guide-no-interview">
      {NO_INTERVIEW_HINT}
    </Notice>
  );
}
