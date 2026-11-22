'use client';

/**
 * The class diagram the platform draws from the learner's own record: the
 * operations become one box's methods, the entities the other box's members.
 * Nothing is templated: an empty design draws an empty diagram, which is the
 * point.
 *
 * Fixed size inside its own horizontal scroller: scaling an SVG to the pane
 * would push the labels under 12px on a phone.
 */
import { phaseHue } from '@/lib/phase';
import { scrollFocusRef } from '@/lib/scroll-focus';
import type { Design } from '@learnsdlc/shared';
import { baseName } from './model';

const W = 300;
const PAD = 10;
const BOX_W = W - PAD * 2;
const INNER = BOX_W - 20;
const HEADER_H = 26;
const LINE_H = 16;
const SECTION_PAD = 7;
const GAP = 40;
/** Geist Mono at 12px advances ~7.2px per character. */
const CHARS = Math.floor(INNER / 7.2);

interface DiagramLine {
  text: string;
  /** An entity no story claims: the diagram says so rather than hiding it. */
  open?: boolean;
}

interface DiagramBox {
  title: string;
  note: string;
  lines: DiagramLine[];
  empty: string;
}

const clip = (s: string, max = CHARS): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function boxHeight(box: DiagramBox): number {
  const rows = Math.max(box.lines.length, 1);
  return HEADER_H + SECTION_PAD * 2 + rows * LINE_H;
}

export function ClassDiagram({
  doc,
  codePath,
  testId,
  horizontal = false,
  apiContract = true,
}: {
  horizontal?: boolean;
  doc: Design;
  /** The manager file the workspace carries, when it carries one. */
  codePath: string | null;
  testId?: string;
  /**
   * Whether the project has an API contract (the teacher's switch). With no file to name and no contract, the
   * operations box carries no note, since "Operations / API contract" would name a contract the project does not
   * have. Left out, the box keeps its note.
   */
  apiContract?: boolean;
}) {
  const manager: DiagramBox = {
    title: 'Operations',
    note: codePath ? codePath.split('/').pop()! : apiContract ? 'API contract' : '',
    lines: doc.operations.map((op) => ({ text: clip(op.name.trim() || baseName(op.name) || '—') })),
    empty: 'No operations yet',
  };
  const task: DiagramBox = {
    title: 'Model',
    note: 'Entities',
    lines: doc.entities.map((e) => ({
      text: clip(`${e.kind === 'class' ? '' : `«${e.kind}» `}${e.name.trim() || '—'}`),
      open: e.satisfies.length === 0,
    })),
    empty: 'No entities yet',
  };

  const hManager = boxHeight(manager);
  const hTask = boxHeight(task);
  const yManager = 4;
  const yTask = horizontal ? yManager : yManager + hManager + GAP;
  const height = horizontal ? Math.max(hManager, hTask) + 10 : yTask + hTask + 6;
  const width = horizontal ? W * 2 + GAP : W;
  const cx = PAD + BOX_W / 2;
  const hue = phaseHue('design');

  const drawBox = (box: DiagramBox, y: number, h: number) => (
    <g>
      <rect
        x={PAD}
        y={y}
        width={BOX_W}
        height={h}
        rx={8}
        fill="rgb(var(--c-surface))"
        stroke="rgb(var(--c-edge2))"
        strokeWidth={1.5}
      />
      <rect x={PAD + 1} y={y + 7} width={3.5} height={HEADER_H - 14} rx={2} fill={hue} />
      <text
        x={PAD + 12}
        y={y + 17}
        className="font-mono"
        fontSize={12}
        fontWeight={600}
        fill="rgb(var(--c-ink))"
      >
        {box.title}
      </text>
      {box.note && (
        <text x={PAD + BOX_W - 10} y={y + 17} textAnchor="end" fontSize={12} fill="rgb(var(--c-muted))">
          {box.note}
        </text>
      )}
      <line
        x1={PAD}
        y1={y + HEADER_H}
        x2={PAD + BOX_W}
        y2={y + HEADER_H}
        stroke="rgb(var(--c-edge))"
        strokeWidth={1.5}
      />
      {box.lines.length === 0 ? (
        <text x={PAD + 12} y={y + HEADER_H + SECTION_PAD + 12} fontSize={12} fill="rgb(var(--c-muted))">
          {box.empty}
        </text>
      ) : (
        box.lines.map((line, i) => (
          <text
            key={i}
            x={PAD + 12}
            y={y + HEADER_H + SECTION_PAD + 12 + i * LINE_H}
            className="font-mono"
            fontSize={12}
            fill={line.open ? 'rgb(var(--c-warn))' : 'rgb(var(--c-ink2))'}
          >
            {line.text}
          </text>
        ))
      )}
    </g>
  );

  const openFields = task.lines.filter((l) => l.open).length;
  const description = `Class diagram: ${manager.lines.length} operation${
    manager.lines.length === 1 ? '' : 's'
  }, using ${task.lines.length} entit${task.lines.length === 1 ? 'y' : 'ies'}${
    openFields ? `, ${openFields} without a story` : ''
  }.`;

  return (
    // Wider than a phone, it scrolls; while it does, the keyboard can reach it.
    <div ref={scrollFocusRef} className="overflow-x-auto">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={description}
        data-testid={testId}
        className="block"
      >
        <title>{description}</title>
        {drawBox(manager, yManager, hManager)}
        <g transform={horizontal ? `translate(${W + GAP}, 0)` : undefined}>{drawBox(task, yTask, hTask)}</g>
        {!horizontal && <><line
          x1={cx}
          y1={yManager + hManager}
          x2={cx}
          y2={yTask - 7}
          stroke="rgb(var(--c-edge2))"
          strokeWidth={1.5}
        />
        <path
          d={`M${cx - 5} ${yTask - 7} L${cx} ${yTask} L${cx + 5} ${yTask - 7}`}
          fill="none"
          stroke="rgb(var(--c-edge2))"
          strokeWidth={1.5}
        />
        <text x={cx + 10} y={yManager + hManager + GAP / 2 + 4} fontSize={12} fill="rgb(var(--c-muted))">
          Uses
        </text></>}
        {horizontal && <path d={`M${PAD + BOX_W} 54 H${W + GAP + PAD - 7} m-5 -5 5 5 -5 5`} fill="none" stroke="rgb(var(--c-edge2))" strokeWidth={1.5} />}
      </svg>
    </div>
  );
}
