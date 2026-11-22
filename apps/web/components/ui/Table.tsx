'use client';

import type { PhaseKey } from '@learnsdlc/shared';
import type { StatusState } from '@/lib/phase';
import { scrollFocusRef } from '@/lib/scroll-focus';
import { StatusSquare } from './status';

/* ---------------------------------------------------------------------------
   Table: named columns, hairline rows. Every column says what it holds, so a
   reader never has to infer a column from its contents.
--------------------------------------------------------------------------- */
export interface Column {
  label: React.ReactNode;
  /** A grid track: '1fr', '120px', 'auto'. Defaults to 1fr. */
  width?: string;
  align?: 'left' | 'right';
  /** Draw the cells in mono, for times, ids and file positions. */
  mono?: boolean;
  /** Draw the cells muted, for the column that is context rather than content. */
  muted?: boolean;
}

export function Table({
  cols,
  rows,
  className = '',
  testId,
  rowTestId,
  minWidth = 420,
}: {
  cols: Column[];
  rows: React.ReactNode[][];
  className?: string;
  testId?: string;
  /** Called per row for a per-row test id. */
  rowTestId?: (i: number) => string | undefined;
  /** Below this the table scrolls sideways rather than crushing its columns. */
  minWidth?: number;
}) {
  // The table roles are worn by the grid itself: `display: contents` lets a
  // row exist for a reader while its cells stay direct children of the grid,
  // so the columns still line up across rows and the markup stops contradicting
  // `Matrix` and the instructor console, which are real tables.
  const CONTENTS: React.CSSProperties = { display: 'contents' };
  // A bare fractional track has an intrinsic minimum: one long identifier
  // can widen it past its allotted share. Let text wrap inside flexible
  // columns while preserving explicitly sized columns and the scroll floor.
  const tracks = cols.map(({ width }) => {
    const track = width?.trim() || '1fr';
    return /^(?:\d+(?:\.\d+)?|\.\d+)fr$/.test(track) ? `minmax(0,${track})` : track;
  }).join(' ');
  return (
    // Below `minWidth` the table scrolls sideways; while it does, the keyboard
    // can reach it (the dossier's tables at 390px, for example).
    <div ref={scrollFocusRef} className={`min-w-0 overflow-x-auto ${className}`} data-testid={testId}>
      <div
        role="table"
        aria-rowcount={rows.length + 1}
        aria-colcount={cols.length}
        /* No column gap. Every cell draws its own bottom rule, so a 12px gap
           would cut the rule under each row into one segment per column and
           the separator would not run the row. The space
           between columns is the cells' own right padding instead, which the
           rule crosses. */
        className="grid"
        // Cells own their borders, so each must fill the tallest cell's row.
        // Content stays top-aligned inside the cell's flex layout below.
        style={{ gridTemplateColumns: tracks, minWidth, alignItems: 'stretch' }}
      >
        <div role="row" style={CONTENTS}>
          {cols.map((c, i) => (
            <span
              key={`h-${i}`}
              role="columnheader"
              className={`label-sm wrap min-w-0 border-b-1.5 border-edge2 pb-1.5 ${i < cols.length - 1 ? 'pr-3' : ''} ${c.align === 'right' ? 'text-right' : ''}`}
            >
              {c.label}
            </span>
          ))}
        </div>
        {rows.map((r, ri) => (
          <div key={`r-${ri}`} role="row" style={CONTENTS}>
            {r.map((cell, ci) => {
              const c = cols[ci] ?? {};
              return (
                <span
                  key={`${ri}-${ci}`}
                  role="cell"
                  data-testid={ci === 0 ? rowTestId?.(ri) : undefined}
                  className={`wrap flex min-w-0 items-start gap-2 border-b-1.5 border-edge py-2.5 text-[13px] leading-[1.4] ${
                    ci < cols.length - 1 ? 'pr-3' : ''
                  } ${c.align === 'right' ? 'justify-end text-right' : ''} ${c.mono ? 'mono' : ''} ${
                    c.muted ? 'text-muted' : 'text-ink'
                  }`}
                >
                  {cell}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The first cell of a table row: the status square, the thing's name, and one
 * line of detail under it.
 */
export function CellTitle({
  state,
  title,
  detail,
  hue,
  className = '',
}: {
  state: StatusState;
  title: React.ReactNode;
  detail?: React.ReactNode;
  hue?: PhaseKey;
  className?: string;
}) {
  return (
    <span className={`flex min-w-0 items-start gap-2 ${className}`}>
      <StatusSquare state={state} hue={hue} size={11} className="mt-[3px]" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="wrap font-semibold text-ink">{title}</span>
        {detail && <span className="wrap text-[12px] text-muted">{detail}</span>}
      </span>
    </span>
  );
}
