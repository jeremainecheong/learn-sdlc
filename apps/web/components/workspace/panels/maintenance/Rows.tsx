'use client';

/**
 * The one row shape every list in this panel uses: a status square, a title,
 * a detail line under it and a right-aligned result. Anything wider (a field,
 * a clause list) sits under the detail line so the row still reads as a
 * sentence at 390px.
 */
import type { ReactNode } from 'react';
import { STATUS_WORD, StatusSquare } from '@/components/ui';
import type { StatusState } from '@/lib/phase';

/** Column headings above a list. Left names the subject, right names the result. */
export function ListHead({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 border-b-1.5 border-edge2 px-4 pb-1.5">
      <span className="label-sm font-medium">{left}</span>
      {right && <span className="label-sm shrink-0 font-medium">{right}</span>}
    </div>
  );
}

export function ListRow({
  state,
  title,
  mono = false,
  detail,
  right,
  below,
  testId,
}: {
  state: StatusState;
  title: ReactNode;
  /** Draw the title in the mono face: operation and test names are identifiers. */
  mono?: boolean;
  detail?: ReactNode;
  right?: ReactNode;
  /** A control or a nested list that needs the full width. */
  below?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 border-b-1.5 border-edge px-4 py-2.5 last:border-b-0"
    >
      <StatusSquare state={state} size={11} className="mt-[5px]" label={STATUS_WORD[state]} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={`wrap font-semibold text-ink ${mono ? 'mono font-semibold' : 'text-[13px] leading-snug'}`}>
          {title}
        </span>
        {detail && <span className="wrap text-[12.5px] leading-[1.4] text-ink2">{detail}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">{right}</span>
      {below && <span className="col-start-2 col-end-4 mt-2 block min-w-0">{below}</span>}
    </div>
  );
}

/**
 * A heading for a block inside a section whose body draws its own rows. It
 * carries its own `px-4` because the usual parent is a `Section pad={false}`
 * whose rows run full width; `pad={false}` is for the call sites whose parent
 * already insets, where the default would indent the heading past the rows
 * underneath it.
 */
export function SubHead({
  title,
  purpose,
  right,
  pad = true,
}: {
  title: ReactNode;
  purpose?: ReactNode;
  right?: ReactNode;
  pad?: boolean;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 ${pad ? 'px-4' : ''}`}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="group-title">{title}</h3>
        {purpose && <p className="purpose wrap">{purpose}</p>}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}

/**
 * A label and its value on one line, the way a ticket or a contract states a
 * clause. The label column is fixed so a card of clauses reads down its edge.
 */
export function ClauseRow({
  label,
  children,
  testId,
}: {
  label: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1 border-t-1.5 border-edge py-2 first:border-t-0 first:pt-0 sm:grid-cols-[76px_minmax(0,1fr)]"
    >
      <span className="label-sm pt-px font-medium">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/**
 * Prose that names identifiers. The ticket is markdown, so `task_id` arrives
 * in backticks; a row is not a markdown document, so the ticks become the
 * mono face the rest of the product uses for a name.
 */
export function Inline({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="mono">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
