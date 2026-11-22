'use client';

/**
 * The ten-step rail.
 *
 * Drawn on the draft editor with each step's state, on the Projects page and
 * the guide page without one. It counts only the required steps that apply,
 * names the next one, and says nothing it cannot read from the page.
 */
import { useId, useState } from 'react';
import { Section } from '@/components/ui';
import { StepHelp } from '@/components/staff/guide/StepHelp';
import { nextGuideStep, type DerivedGuideStep } from '@/components/staff/guide/guide-steps';

/** "3 of 7 required steps done. Next: Seal." */
function railProgress(steps: readonly DerivedGuideStep[]): string {
  const counted = steps.filter((step) => !step.optional && step.applies);
  const done = counted.filter((step) => step.state === 'done').length;
  const next = nextGuideStep(steps);
  const head = `${done} of ${counted.length} required steps done.`;
  return next ? `${head} Next: ${next.title}.` : `${head} Every required step is done.`;
}

/** The required steps done, as a bar beside the sentence that says the same. */
function RailBar({ steps }: { steps: readonly DerivedGuideStep[] }) {
  const counted = steps.filter((step) => !step.optional && step.applies);
  const done = counted.filter((step) => step.state === 'done').length;
  const share = counted.length ? Math.round((done / counted.length) * 100) : 0;
  const complete = counted.length > 0 && done === counted.length;
  return (
    <div className="flex items-center gap-2.5" aria-hidden="true" data-complete={complete}>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
        <span className={`block h-full rounded-full ${complete ? 'bg-pass' : 'bg-accent'}`} style={{ width: `${share}%` }} />
      </span>
      <span className="label-sm tabular-nums">{`${done} / ${counted.length}`}</span>
    </div>
  );
}

export function GuideRail({
  steps,
  where,
  stateless = false,
  title = 'Your path through a project',
  testId = 'guide-rail',
  collapsible = false,
  defaultOpen = true,
}: {
  steps: readonly DerivedGuideStep[];
  where: 'projects' | 'editor' | 'guide';
  stateless?: boolean;
  title?: string;
  testId?: string;
  /**
   * The editor's rail folds to its one progress line, so the
   * phases lead the page once the teacher is editing; the teacher can open it.
   */
  collapsible?: boolean;
  /** Open until the editor says otherwise (it closes once a phase is edited). */
  defaultOpen?: boolean;
}) {
  const listId = useId();
  // The teacher's own choice outlives the default.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = !collapsible || (chosen ?? defaultOpen);
  return (
    <Section
      title={title}
      purpose={stateless ? 'Ten steps, in order. Open one to read what it asks of you.' : railProgress(steps)}
      testId={testId}
      right={
        collapsible ? (
          <button
            type="button"
            className="btn-secondary btn-sm"
            aria-expanded={open}
            aria-controls={listId}
            data-testid={`${testId}-toggle`}
            onClick={() => setChosen(!open)}
          >
            {open ? 'Hide the steps' : 'Show the steps'}
          </button>
        ) : undefined
      }
    >
      {!stateless && open && <RailBar steps={steps} />}
      <ol id={listId} hidden={!open} className={open ? 'm-0 flex list-none flex-col gap-0.5 p-0' : 'hidden'}>
        {steps.map((step, at) => (
          <li key={step.key} className="min-w-0 border-b-1.5 border-edge last:border-b-0">
            <StepHelp step={step} number={at + 1} from={where} stateless={stateless} />
          </li>
        ))}
      </ol>
    </Section>
  );
}
