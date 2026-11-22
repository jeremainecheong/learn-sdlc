'use client';

/**
 * A term of art, at its first use on a page.
 *
 * The word is drawn as ordinary text with a dotted underline; hovering or
 * focusing it opens a small card with the glossary's meaning, and Escape or
 * leaving closes it. The card is rendered only while it is open, so a heading
 * that carries a Term keeps its accessible name and its textContent: a spec
 * that reads `matrix-title` still reads "Kill matrix". While open, the card is
 * a `tooltip` the word is `aria-describedby`, which is what a screen reader
 * announces on focus.
 *
 * Use it once per page, on the first occurrence. A page peppered with dotted
 * words reads like a legal notice.
 */
import { useCallback, useId, useState } from 'react';
import { glossaryEntry, type GlossaryKey } from '@/lib/glossary';

export function Term({
  term,
  children,
  className = '',
}: {
  /** Which glossary entry the word points at. */
  term: GlossaryKey;
  /** The word as it appears in the sentence. Left out, the entry's own word is drawn. */
  children?: React.ReactNode;
  className?: string;
}) {
  const entry = glossaryEntry(term);
  const id = useId();
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
    }
  }, []);

  return (
    <span className={`relative inline ${className}`} onMouseEnter={show} onMouseLeave={hide}>
      <span
        tabIndex={0}
        data-testid={`term-${term.replace(/\s+/g, '-')}`}
        data-term={term}
        aria-describedby={open ? id : undefined}
        onFocus={show}
        onBlur={hide}
        onKeyDown={onKeyDown}
        className="cursor-help rounded-[2px] underline decoration-dotted decoration-muted underline-offset-[3px] outline-none focus-visible:ring-[3px] focus-visible:ring-tint"
      >
        {children ?? entry.word}
      </span>
      {open && (
        <span
          role="tooltip"
          id={id}
          data-testid="term-card"
          className="absolute left-0 top-full z-[60] mt-1.5 block w-[280px] max-w-[80vw] whitespace-normal rounded-ctl border-1.5 border-edge2 bg-surface px-3 py-2.5 text-left text-[12.5px] font-normal leading-[1.45] tracking-normal text-ink2"
        >
          <span className="block text-[12.5px] font-semibold text-ink">{entry.word}</span>
          <span className="mt-0.5 block">{entry.meaning}</span>
        </span>
      )}
    </span>
  );
}
