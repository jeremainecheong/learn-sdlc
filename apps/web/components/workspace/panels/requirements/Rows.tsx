'use client';

import type { ReactNode } from 'react';
import { StatusSquare } from '@/components/ui';
import type { StatusState } from '@/lib/phase';

/**
 * The one list shape this panel uses: a column heading over a rule, then rows
 * that read as sentences; a status square, a title, an optional detail line,
 * and a result on the right.
 */
export function RowList({
  head,
  right,
  children,
  testId,
  className = '',
}: {
  head: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 border-b-1.5 border-edge2 pb-1.5">
        <span className="label-sm min-w-0 wrap">{head}</span>
        {right && <span className="label-sm text-right">{right}</span>}
      </div>
      <ul className="m-0 flex list-none flex-col p-0" data-testid={testId}>
        {children}
      </ul>
    </div>
  );
}

export function Row({
  state,
  title,
  detail,
  right,
  testId,
}: {
  state: StatusState;
  title: ReactNode;
  detail?: ReactNode;
  right?: ReactNode;
  testId?: string;
}) {
  return (
    <li
      className="grid grid-cols-[1fr_auto] items-start gap-x-3 gap-y-1 border-b-1.5 border-edge py-2.5"
      data-testid={testId}
    >
      <span className="flex min-w-0 items-start gap-2">
        <StatusSquare state={state} size={11} className="mt-[3px]" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="wrap text-[13px] font-semibold leading-[1.4] text-ink">{title}</span>
          {detail && <span className="wrap text-[12px] leading-[1.4] text-muted">{detail}</span>}
        </span>
      </span>
      {right && <span className="flex shrink-0 items-center justify-end pt-px">{right}</span>}
    </li>
  );
}
