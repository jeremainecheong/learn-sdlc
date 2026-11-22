'use client';

import { StatusSquare } from '@/components/ui';
import type { StatusState } from '@/lib/phase';

/**
 * The map's own legend, drawn in the product's one status glyph.
 *
 * It does not copy how a block is *stroked*: that would draw "Done" as an
 * empty square outlined in `edge2`, about 1.3:1 against its own ground, while
 * a done block on the graph beside it carries a solid coloured bar: the same
 * state drawn two ways on one screen, with the legend's version reading as
 * nothing. It uses `StatusSquare`, whose rule is the product's: filled for
 * done, pass, fail and warn, ringed for the one you are in, dashed for what is
 * not open yet. Only the
 * line the learner drew is named: a solid line between two blocks needs no
 * caption, and the dashed call line is named only where it is drawn.
 */
const ITEMS: { state: StatusState; label: string }[] = [
  { state: 'done', label: 'Done' },
  { state: 'now', label: 'In progress' },
  { state: 'todo', label: 'Not yet' },
  { state: 'fail', label: 'Failing' },
  { state: 'warn', label: 'Needs a decision' },
];

export function MapLegend({
  className = '',
  calls = false,
}: {
  className?: string;
  /** Name the dashed line too. Only the System view draws calls. */
  calls?: boolean;
}) {
  return (
    <ul
      className={`flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[12px] text-ink2 ${className}`}
      aria-label="Map legend"
    >
      {ITEMS.map((it) => (
        <li key={it.label} className="inline-flex items-center gap-1.5">
          <StatusSquare state={it.state} size={12} />
          {it.label}
        </li>
      ))}
      {calls && (
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block w-[18px] border-t-[1.5px] border-dashed border-edge" />
          Calls
        </li>
      )}
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block w-[18px] border-t-[1.5px] border-dotted border-edge2" />
        Linked by you
      </li>
    </ul>
  );
}
