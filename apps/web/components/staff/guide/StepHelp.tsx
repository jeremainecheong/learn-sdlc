'use client';

/**
 * One step of the teacher's path, opened in place.
 *
 * The summary says the step and its state in words (colour is never the only
 * signal); the body is the step's two to four sentences, "Take me there" where
 * the page can reach it, and the step's section of the in-app guide.
 */
import Link from 'next/link';
import { TEACHER_GUIDE_PATH } from '@learnsdlc/shared';
import { StatusSquare } from '@/components/ui';
import { guideStepHref, type DerivedGuideStep } from '@/components/staff/guide/guide-steps';

/** The state, as the words the rail says beside each step. */
function stepStateWord(step: Pick<DerivedGuideStep, 'state' | 'applies'>): string {
  if (!step.applies) return 'Does not apply';
  return step.state === 'done' ? 'Done' : step.state === 'stale' ? 'Out of date' : 'Not yet';
}

export function StepHelp({
  step,
  number,
  from,
  stateless = false,
}: {
  step: DerivedGuideStep;
  number: number;
  from: 'projects' | 'editor' | 'guide';
  /** Draw the step without a state, where the page holds no draft. */
  stateless?: boolean;
}) {
  const href = guideStepHref(step, from);
  const docs = from === 'guide' ? `#${step.docsAnchor}` : `${TEACHER_GUIDE_PATH}#${step.docsAnchor}`;
  const square = !step.applies ? 'todo' : step.state === 'done' ? 'pass' : step.state === 'stale' ? 'warn' : 'todo';
  return (
    <details className="min-w-0" data-testid={`guide-step-${step.key}`} data-state={stateless ? undefined : step.applies ? step.state : 'n/a'}>
      <summary className="flex min-w-0 cursor-pointer items-center gap-2 py-1 text-[13px] text-ink">
        {!stateless && <StatusSquare state={square} />}
        <span className="min-w-0 flex-1 font-medium">{`${number}. ${step.title}`}</span>
        {step.optional && <span className="label-sm">Optional</span>}
        {!stateless && <span className="label-sm">{stepStateWord(step)}</span>}
      </summary>
      <div className="flex min-w-0 flex-col gap-1.5 pb-2 pl-5">
        {step.help.map((sentence) => (
          <p key={sentence} className="purpose wrap">
            {sentence}
          </p>
        ))}
        <p className="flex flex-wrap gap-3 text-[12.5px]">
          {href && (
            <Link href={href} className="underline" data-testid={`guide-step-go-${step.key}`}>
              {`Take me there: ${step.title}`}
            </Link>
          )}
          <Link href={docs} className="underline" data-testid={`guide-step-docs-${step.key}`}>
            {`Read about ${step.title.toLowerCase()} in the teacher guide`}
          </Link>
        </p>
      </div>
    </details>
  );
}
