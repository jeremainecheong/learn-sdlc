'use client';

import type { ReactNode } from 'react';
import { Chip } from '@/components/ui';
import { useReferenceScaffolding } from '@/lib/scenario';
import { Clause, IconButton } from './Fields';
import { CRITERION_WORD, criterionState, type CriterionState } from './useStory';
import { CRITERION_TAGS, type AcceptanceCriterion, type CriterionTag } from './story';
import { REFERENCE_COPY } from '../../reference/copy';

const TID = 'phase-requirements';

const CRITERION_TONE: Record<CriterionState, 'pass' | 'warn' | 'neutral'> = {
  runnable: 'pass',
  weak: 'warn',
  blank: 'neutral',
};

export interface CriterionActions {
  set: (fields: Partial<AcceptanceCriterion>) => void;
  move: (delta: number) => void;
  remove: () => void;
}

/**
 * One acceptance criterion: the id down the left, the three clauses in the
 * middle, and on the right whether a test could read it. A criterion whose
 * "then" hedges is outlined, because that is the one the review will send back.
 */
export function CriterionCard({
  criterion,
  index,
  count,
  actions,
  boxed = false,
  note,
}: {
  criterion: AcceptanceCriterion;
  /** Drawn under the criterion's verdict: a mark about it, such as who last changed it. */
  note?: ReactNode;
  index: number;
  count: number;
  actions: CriterionActions;
  /** The rail's older look: every clause in its own bordered field. */
  boxed?: boolean;
}) {
  const state = criterionState(criterion);
  // The example is the reference story's only on its own phase.
  const reference = useReferenceScaffolding('requirements');
  const n = index + 1;
  const weak = state === 'weak';
  return (
    <li
      className={`group grid min-w-0 grid-cols-[44px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1.5 rounded-ctl border-1.5 bg-ground px-3 py-2.5 sm:grid-cols-[44px_minmax(0,1fr)_auto] ${
        weak ? 'border-warn' : 'border-edge2'
      }`}
      data-testid={`${TID}-criterion-${n}`}
    >
      <span
        className={`mono row-start-1 pt-0.5 text-[11.5px] font-bold sm:row-span-3 ${weak ? 'text-warn' : 'text-ink2'}`}
      >
        {criterion.id}
      </span>

      <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1"><Clause
        id={`${TID}-criterion-${n}-given`}
        testId={`${TID}-criterion-${n}-given`}
        word="Given"
        value={criterion.given}
        placeholder={reference ? REFERENCE_COPY.requirements.givenPlaceholder : 'the situation the story starts from'}
        boxed={boxed}
        onChange={(v) => actions.set({ given: v })}
      /></div>

      <span className="col-start-2 row-start-1 flex flex-col items-end gap-1 sm:col-start-3 sm:row-span-3">
        <Chip tone={CRITERION_TONE[state]}>{CRITERION_WORD[state]}</Chip>
        {note}
        {/* At rest a criterion is three sentences and a verdict, as the design
            draws it. The controls that reorder and retype it come out on hover,
            and on focus so the keyboard can still reach them. */}
        <span className="flex items-center gap-1 opacity-100 transition-opacity focus-within:opacity-100 group-hover:opacity-100 sm:opacity-0">
          <label htmlFor={`${TID}-criterion-${n}-tag`} className="sr-only">
            Kind of {criterion.id}
          </label>
          <select
            id={`${TID}-criterion-${n}-tag`}
            data-testid={`${TID}-criterion-${n}-tag`}
            className="w-[86px] cursor-pointer rounded-[5px] border-1.5 border-transparent bg-transparent py-0 pl-1 text-[11.5px] text-muted outline-none transition-colors hover:border-edge focus:border-accent"
            value={criterion.tag}
            onChange={(e) => actions.set({ tag: e.target.value as CriterionTag })}
          >
            {CRITERION_TAGS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <IconButton
            label={`Move ${criterion.id} up`}
            icon="arrow-up"
            onClick={() => actions.move(-1)}
            disabled={index === 0}
          />
          <IconButton
            label={`Move ${criterion.id} down`}
            icon="arrow-down"
            onClick={() => actions.move(1)}
            disabled={index === count - 1}
          />
          <IconButton label={`Remove ${criterion.id}`} icon="trash" onClick={actions.remove} />
        </span>
      </span>

      <div className="col-span-2 row-start-3 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-2"><Clause
        id={`${TID}-criterion-${n}-when`}
        testId={`${TID}-criterion-${n}-when`}
        word="When"
        value={criterion.when}
        placeholder={reference ? REFERENCE_COPY.requirements.whenPlaceholder : 'I take the action the story is about'}
        boxed={boxed}
        onChange={(v) => actions.set({ when: v })}
      /></div>
      <div className="col-span-2 row-start-4 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-3"><Clause
        id={`${TID}-criterion-${n}-then`}
        testId={`${TID}-criterion-${n}-then`}
        word="Then"
        value={criterion.then}
        placeholder={reference ? REFERENCE_COPY.requirements.thenPlaceholder : 'the outcome a test can check'}
        boxed={boxed}
        onChange={(v) => actions.set({ then: v })}
      /></div>

      {weak && (
        <p className="wrap col-span-2 mt-0.5 text-[12px] leading-[1.4] text-warn sm:col-span-1 sm:col-start-2">
          The then clause hedges. Say the outcome a test could read.
        </p>
      )}
    </li>
  );
}
