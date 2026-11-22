'use client';

/**
 * What every editable surface on the design shares: the cell that looks like
 * a document until you touch it, the box that grows to its content instead of
 * scrolling inside itself, the product's own select, and the two list fields
 * (comma-separated and one per line) that keep what the learner is typing.
 *
 * They live here rather than in any one card, because two copies of a text
 * cell would be two designs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { DESIGN_CAPS } from '@learnsdlc/shared';

const LINE_GRID = 'grid grid-cols-1 items-start gap-x-3 gap-y-1 sm:grid-cols-[120px_minmax(0,1fr)]';

/** One labelled row of a card: the label beside the field from the small breakpoint up, above it below. */
export function Line({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className={LINE_GRID}>
      <label className="label-sm pt-1.5" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A row laid out as `Line` whose value is text, not a control, so its label names nothing. */
export function TextLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={LINE_GRID}>
      <span className="label-sm pt-1.5">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** One line of a list as the record keeps it: no line longer than the record's field cap, a long paste cut there. */
export const capLine = (line: string) => line.slice(0, DESIGN_CAPS.fieldChars);

/**
 * A cell that is a field. The design reads as a document, a table of values,
 * a card of clauses, so the borders stay out of the way until the pointer or
 * the caret is on the cell that owns them.
 */
export const CELL =
  'field border-transparent bg-transparent px-2 py-1 text-[12.5px] read-only:bg-transparent hover:border-edge2 focus:border-accent';
export const MONO_CELL = `${CELL} font-mono`;

/**
 * A cell that grows to its content instead of scrolling inside itself. Every
 * clause on this page is meant to be read whole, a returns line half shown is
 * a contract half written, so the box takes the height the words need.
 */
export function AutoText({
  className = '',
  minRows = 1,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const el = ref.current;
    // Tab panels stay mounted while hidden. They have no measurable width,
    // so sizing them then would collapse a saved clause to zero height.
    if (!el || el.clientWidth === 0) return;
    el.style.height = 'auto';
    const style = getComputedStyle(el);
    const adjustment = style.boxSizing === 'border-box'
      ? parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
      : -parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    el.style.height = `${el.scrollHeight + adjustment}px`;
  }, []);
  // Re-fit on every value the parent hands down, not only on keystrokes: the
  // record arrives from the server after the first paint.
  useEffect(fit, [fit, rest.value]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let previousWidth = 0;
    let frame: number | null = null;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width === previousWidth) return;
      previousWidth = width;
      // Width changes include revealing a tab and toggling side panels.
      // A width guard stops repeated fitting, but a height write during this
      // delivery can still create a skipped observation in WebKit. Fit once
      // in the next frame, outside ResizeObserver's delivery cycle.
      if (width > 0 && frame === null) frame = requestAnimationFrame(() => {
        frame = null;
        fit();
      });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [fit]);
  return (
    <textarea
      ref={ref}
      rows={minRows}
      className={`${className} resize-none overflow-hidden`}
      onInput={fit}
      {...rest}
    />
  );
}

/**
 * A select that is the product's control rather than the operating system's.
 *
 * A native `<select>` draws its own chevron, its own radius and its own text
 * size, so on a row beside a Button the two shapes disagree.
 * `appearance: none` takes the OS control away and the chevron is drawn
 * here, in the ink the rest of the field uses.
 */
export function SelectCell({
  className = '',
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`${CELL} appearance-none bg-no-repeat pr-6 ${className}`}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none' stroke='%23808080' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><path d='M3 4.5L6 7.5L9 4.5'/></svg>\")",
        backgroundPosition: 'right 6px center',
        backgroundSize: '12px 12px',
      }}
      {...rest}
    >
      {children}
    </select>
  );
}

const sameItems = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * What the learner is typing into a list field, kept while it still reads as
 * the saved list: the list drops blanks, so without it a comma or a new line
 * would vanish the moment it was typed. When the saved list moves on (a reload,
 * an applied proposal) the saved list is shown instead.
 */
function useListDraft(items: string[], parse: (text: string) => string[], join: (items: string[]) => string) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft !== null && sameItems(parse(draft), items) ? draft : join(items);
  return { shown, type: (text: string) => setDraft(text), done: () => setDraft(null) };
}

const byComma = (text: string) => text.split(',').map((x) => x.trim()).filter(Boolean);

/** A list typed on one line, separated by commas: trimmed, blanks dropped. */
export function ListInput({
  items,
  onItems,
  className = '',
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { items: string[]; onItems: (items: string[]) => void }) {
  const draft = useListDraft(items, byComma, (list) => list.join(', '));
  return (
    <input
      {...rest}
      className={className}
      value={draft.shown}
      onChange={(e) => {
        draft.type(e.target.value);
        onItems(byComma(e.target.value));
      }}
      onBlur={draft.done}
    />
  );
}

/** A list typed one item per line: blank lines are dropped from the list, at most `maxItems` kept. */
export function LinesText({
  items,
  onItems,
  maxItems,
  ...rest
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  items: string[];
  onItems: (items: string[]) => void;
  maxItems: number;
  minRows?: number;
}) {
  const parse = (text: string) => text.split('\n').map((x) => capLine(x.trim())).filter(Boolean).slice(0, maxItems);
  const draft = useListDraft(items, parse, (list) => list.join('\n'));
  return (
    <AutoText
      {...rest}
      value={draft.shown}
      onChange={(e) => {
        draft.type(e.target.value);
        onItems(parse(e.target.value));
      }}
      onBlur={draft.done}
    />
  );
}
