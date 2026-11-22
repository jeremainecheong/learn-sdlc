import { Fragment, type ReactNode } from 'react';

/**
 * A review sentence with its `code spans` drawn as code.
 *
 * The API writes a command it ran between backticks ("invoked from Dockerfile
 * command `python3 ops/selfcheck.py`"). Printed as text, the learner would read
 * the backticks. A span between two backticks on one line is drawn in the code
 * face without them; a lone backtick, and text with none, is left exactly as
 * written.
 */
const SPAN = /`([^`\n]+)`/g;

export function withInlineCode(text: string): ReactNode {
  if (!text || !text.includes('`')) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(SPAN)) {
    const start = match.index ?? 0;
    if (start > at) out.push(text.slice(at, start));
    out.push(<code key={start} className="mono rounded-[4px] bg-codeline px-1 text-[0.92em]" data-testid="review-inline-code">{match[1]}</code>);
    at = start + match[0].length;
  }
  if (out.length === 0) return text;
  if (at < text.length) out.push(text.slice(at));
  return <Fragment>{out}</Fragment>;
}
