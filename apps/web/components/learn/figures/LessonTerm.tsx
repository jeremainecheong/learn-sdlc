'use client';
import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { LESSON_TERMS, findTerm, type LessonTermKey } from './lesson-terms';
import { codeFragments } from './CodeText';

/** The space kept between an open card and the screen's edge. */
const GUTTER = 16;

/** A guide term at its first use in a chapter: dotted underline; hovering,
 * focusing or pressing it (a real button, so a tap on a phone opens it too)
 * opens a small card with the guide's meaning, Escape or leaving closes it. The card is drawn only while open (so the sentence's text stays
 * the sentence), as a `tooltip` the word is `aria-describedby`. The same
 * behaviour as `components/ui/Term.tsx`, over the guides' own list. */
export function LessonTerm({ term, children }: { term: LessonTermKey; children?: ReactNode }) {
  const entry = LESSON_TERMS[term];
  const id = useId();
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); }
  }, []);
  // The card opens under the word; near the right edge of a narrow screen it
  // is moved left so it never runs past the page and widens it.
  const card = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const box = card.current;
    if (!open || !box) return;
    box.style.left = '0px';
    const edge = document.documentElement.clientWidth || window.innerWidth;
    const rect = box.getBoundingClientRect();
    const over = rect.right - (edge - GUTTER);
    if (over > 0) box.style.left = `${-Math.min(over, Math.max(0, rect.left - GUTTER))}px`;
  }, [open]);
  return (
    <span className="lesson-term" onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        className="lesson-term-word"
        data-lesson-term={term}
        aria-describedby={open ? id : undefined}
        onFocus={show}
        onBlur={hide}
        onClick={show}
        onKeyDown={onKeyDown}
      >
        {children ?? entry.word}
      </button>
      {open && (
        <span ref={card} role="tooltip" id={id} className="lesson-term-card">
          <strong>{entry.word}</strong>
          <span>{entry.meaning}</span>
        </span>
      )}
    </span>
  );
}

/** Which term a chapter marks: the chapter's own choice when it names one
 * that appears, else the term that appears first in the paragraphs. `null`
 * marks none (a chapter whose only listed word is used in another sense). */
export function chooseTerm(paragraphs: string[], preferred?: LessonTermKey | null): { paragraph: number; index: number; length: number; key: LessonTermKey } | null {
  if (preferred === null) return null;
  const keys = (preferred ? [preferred] : Object.keys(LESSON_TERMS)) as LessonTermKey[];
  for (let paragraph = 0; paragraph < paragraphs.length; paragraph += 1) {
    let best: { index: number; length: number; key: LessonTermKey } | null = null;
    for (const key of keys) {
      const hit = findTerm(paragraphs[paragraph], key);
      if (hit && (!best || hit.index < best.index)) best = { ...hit, key };
    }
    if (best) return { paragraph, ...best };
  }
  return preferred ? chooseTerm(paragraphs) : null;
}

/** The paragraphs drawn as `<p>`s, with one term marked at its first use. */
export function TermParagraphs({ paragraphs, preferred }: { paragraphs: string[]; preferred?: LessonTermKey | null }) {
  const mark = chooseTerm(paragraphs, preferred);
  return (
    <>
      {paragraphs.map((text, i) => {
        if (!mark || mark.paragraph !== i) return <p key={i}>{codeFragments(text)}</p>;
        const end = mark.index + mark.length;
        return (
          <p key={i}>
            {codeFragments(text.slice(0, mark.index))}
            <LessonTerm term={mark.key}>{text.slice(mark.index, end)}</LessonTerm>
            {codeFragments(text.slice(end))}
          </p>
        );
      })}
    </>
  );
}
