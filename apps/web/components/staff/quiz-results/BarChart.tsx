/**
 * The one bar chart the quiz-results page draws.
 *
 * Inline SVG, no chart library. Flat horizontal bars on a quiet track, no axes
 * and no gridlines; each row's label above its bar and its value written as
 * text beside it. Colour is meaning only: `pass` is the pass token, `neutral`
 * is ink. The drawing is one image with a name that says every value, and
 * below it a table of the same numbers a teacher can open and read.
 *
 * The table's box scrolls sideways at phone width, so it is a region a
 * keyboard can reach, named by the table's own caption (the pattern
 * LearnerResultsTable uses: role="region", tabIndex 0, a name). The caption id
 * comes from useId, as a page draws several charts.
 */
import { useId } from 'react';

interface BarSegment {
  /** A share of the row's full length, 0..1. */
  share: number;
  tone: 'pass' | 'neutral';
  /** A quieter neutral, for the rest of a whole (the not yet passed). */
  rest?: boolean;
}

export interface BarRow {
  key: string;
  label: string;
  /** Null: nothing to draw for this row, the value text stands alone. */
  segments: BarSegment[] | null;
  valueText: string;
}

interface BarTable {
  head: string[];
  /** Which columns are numbers (right-aligned). */
  numeric?: boolean[];
  rows: { key: string; cells: string[] }[];
}

const WIDTH = 360;
const ROW = 40;
const TRACK = 200;
const LABEL_MAX = 44;

function clip(label: string): string {
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

export function BarChart({
  name,
  rows,
  table,
  testId,
  heading,
}: {
  /** The image's accessible name: what it shows and every value in it. */
  name: string;
  rows: BarRow[];
  table: BarTable;
  testId?: string;
  /** A small title above the drawing (a level-four heading). */
  heading?: string;
}) {
  const height = rows.length * ROW + 4;
  const captionId = useId();
  return (
    <div className="quiz-chart" data-testid={testId}>
      {heading && <h4 className="quiz-chart-title">{heading}</h4>}
      <svg
        className="quiz-chart-svg"
        role="img"
        aria-label={name}
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        preserveAspectRatio="xMinYMin meet"
      >
        {rows.map((row, index) => {
          const top = index * ROW;
          let x = 0;
          return (
            <g key={row.key}>
              <text x={0} y={top + 12}>
                {clip(row.label)}
              </text>
              {row.segments && <rect className="quiz-bar-track" x={0} y={top + 18} width={TRACK} height={12} />}
              {row.segments?.map((segment, at) => {
                const width = Math.max(0, Math.min(1, segment.share)) * TRACK;
                const start = x;
                x += width;
                if (width <= 0) return null;
                return (
                  <rect
                    key={at}
                    className={`quiz-bar is-${segment.tone}${segment.rest ? ' is-rest' : ''}`}
                    x={start}
                    y={top + 18}
                    width={width}
                    height={12}
                  />
                );
              })}
              <text
                x={row.segments ? TRACK + 8 : 0}
                y={top + 28}
                className={row.segments ? 'quiz-value' : 'quiz-value quiz-quiet'}
              >
                {row.valueText}
              </text>
            </g>
          );
        })}
      </svg>
      <details className="quiz-numbers">
        <summary>Show the numbers</summary>
        <div className="quiz-table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
          <table className="quiz-table">
            <caption id={captionId} className="sr-only">
              {name}
            </caption>
            <thead>
              <tr>
                {table.head.map((cell, at) => (
                  <th key={cell} scope="col" className={table.numeric?.[at] ? 'is-number' : undefined}>
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.key}>
                  {row.cells.map((cell, at) =>
                    at === 0 ? (
                      <th key={at} scope="row">
                        {cell}
                      </th>
                    ) : (
                      <td key={at} className={table.numeric?.[at] ? 'is-number' : undefined}>
                        {cell}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
