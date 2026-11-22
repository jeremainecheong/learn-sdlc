import { Fragment, type ReactNode } from 'react';

/* Code in the guides' words. The page font draws some
 * character pairs as one glyph: Manrope's contextual alternates turn the two
 * hyphens of `x' OR 1=1 --` into a single dash, so a projected payload read
 * as one that would not work. Any word of the guides' words that holds such
 * a pair, or is a comparison on its own ("due < today"), is drawn as
 * `<code class="code-fragment">`: code type with ligatures and contextual
 * alternates off (figures.css and lessons.css). The reader, `Figure`,
 * `ToggleSet` and `StepThrough` pass their words through `codeFragments`,
 * so every guide's words get the rule without a per-guide change. */

/** Pairs a page font may join into one glyph. */
export const LIGATURE_PAIRS = /--|->|<-|<=|>=|!=|=>|==/;
/** A word that is a comparison or an arrow on its own. */
const OPERATOR = /^(?:[<>]=?|[!=]=|=>|->|<-|--)$/;
const LEAD = /^[(“"‘]+/;
const TRAIL = /[.,;:!?)”"’]+$/;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is this word (without its punctuation) code that the page font could misdraw? */
export function isCodeWord(word: string): boolean {
  return LIGATURE_PAIRS.test(word) || OPERATOR.test(word);
}

/**
 * The text with every code fragment set in code type: the fragments named in
 * `also` (a payload, an expression) wherever they appear, and any word that
 * holds a ligature pair or is an operator on its own. Text with none comes
 * back as the same string, so the page is unchanged where there is no code.
 */
export function codeFragments(text: string, also: readonly string[] = []): ReactNode {
  const named = [...also].filter(Boolean).sort((a, b) => b.length - a.length);
  const pieces = named.length ? text.split(new RegExp(`(${named.map(escape).join('|')})`)) : [text];
  let changed = false;
  const out: ReactNode[] = [];
  pieces.forEach((piece, i) => {
    if (!piece) return;
    if (named.includes(piece)) {
      changed = true;
      out.push(<code key={`n${i}`} className="code-fragment">{piece}</code>);
      return;
    }
    piece.split(/(\s+)/).forEach((word, j) => {
      const lead = LEAD.exec(word)?.[0] ?? '';
      const trail = TRAIL.exec(word.slice(lead.length))?.[0] ?? '';
      const core = word.slice(lead.length, word.length - trail.length);
      if (core && isCodeWord(core)) {
        changed = true;
        out.push(<Fragment key={`w${i}-${j}`}>{lead}<code className="code-fragment">{core}</code>{trail}</Fragment>);
      } else out.push(word);
    });
  });
  return changed ? <>{out}</> : text;
}

/**
 * A long name with a break opportunity (`<wbr>`) after each underscore and
 * slash and before each inner capital, so at a phone's width
 * `empty_name_accepted` breaks as `empty_name_` / `accepted`, never inside a
 * word. Every whitespace-separated word of `text` gets the same treatment;
 * text with nothing to break comes back as the same string.
 */
export function wordBreaks(text: string): ReactNode {
  const parts = text.split(/(?<=[_/](?=\w))|(?<=[a-z0-9])(?=[A-Z][a-z])/);
  if (parts.length === 1) return text;
  return <>{parts.map((part, i) => <Fragment key={i}>{i > 0 && <wbr />}{part}</Fragment>)}</>;
}
