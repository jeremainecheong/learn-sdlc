'use client';

/**
 * The rows "Check the change request" and "Check the runbook" draw: one row
 * per rule of the record's floor, ticked when it passes, in the order the
 * rules run. The row's text is the rule's own sentence ("Passed: …" or
 * "Not yet: …"); the mark beside it is drawn, not spoken,
 * so a reader hears the sentence once. Each press of the check brings the rows
 * into view, so a list that lands below the fold is not missed.
 *
 * Imported by the Runbook tab and the change request's forms, which the
 * teacher's learner preview draws too, so it reaches nothing of the workspace.
 */
import { useEffect, useRef } from 'react';
import { Icon } from '@/components/Icon';

export interface FloorResult {
  id: string;
  label: string;
  detail: string;
  passed: boolean;
}

/** "Passed: The change request record. The record is well formed.": the words the rows have always carried. */
export const floorRowText = (r: Pick<FloorResult, 'label' | 'detail' | 'passed'>): string =>
  `${r.passed ? 'Passed' : 'Not yet'}: ${r.label}. ${r.detail}.`;

export function FloorResults({
  results,
  listTestId,
  rowTestId,
  round,
}: {
  results: FloorResult[];
  listTestId: string;
  /** The row's test id from the rule's id: `change-check-<id>`, `runbook-check-<id>`. */
  rowTestId: (id: string) => string;
  /** How many times the check has been pressed: each press scrolls the rows into view. */
  round: number;
}) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (round > 0) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [round]);
  return (
    <ul ref={ref} className="m-0 flex list-none flex-col p-0" data-testid={listTestId}>
      {results.map((r) => (
        <li
          key={r.id}
          data-testid={rowTestId(r.id)}
          data-passed={r.passed ? 'true' : 'false'}
          className="flex items-start gap-2 border-t-1.5 border-edge py-1.5 text-[13px] leading-[1.45] text-ink2 first:border-t-0"
        >
          <span aria-hidden className={`mt-[2px] inline-flex h-4 w-4 shrink-0 items-center justify-center ${r.passed ? 'text-pass' : 'text-muted'}`}>
            <Icon name={r.passed ? 'check' : 'minus'} size={14} strokeWidth={2.2} />
          </span>
          <span className="wrap min-w-0">{floorRowText(r)}</span>
        </li>
      ))}
    </ul>
  );
}
