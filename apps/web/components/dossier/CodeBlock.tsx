'use client';

/**
 * One file the learner wrote, printed with numbered lines.
 *
 * A plain `<pre>` on purpose. Monaco cannot print (it draws only the rows in
 * the viewport), and a highlighter is another dependency on a page that
 * already holds six workspaces; react-markdown on every signed-in page is
 * already too much, and a syntax highlighter is heavier than react-markdown.
 * Numbered lines are what a reader needs from a listing in a
 * record anyway: a line to point at.
 *
 * Long files are cut rather than truncated silently. The repo download has
 * every byte, and the cut says so in the product's own words.
 */

import { pluralWord } from '@learnsdlc/shared';
import { scrollFocusRef } from '@/lib/scroll-focus';

/**
 * Past this a file is a listing rather than a document: the printed record
 * points to the zip for the rest, and the reference solution's page to the IDE.
 */
export const MAX_LINES = 400;

export function CodeBlock({
  path,
  content,
  testId,
}: {
  path: string;
  content: string;
  testId?: string;
}) {
  const all = content.replace(/\n$/, '').split('\n');
  const shown = all.slice(0, MAX_LINES);
  const rest = all.length - shown.length;
  const width = String(shown.length).length;
  return (
    <div className="dossier-code min-w-0" data-testid={testId}>
      <p className="mono border-b-1.5 border-edge2 pb-1 text-[12.5px] font-semibold text-ink">
        {path}
      </p>
      <div ref={scrollFocusRef} className="dossier-scroll min-w-0 overflow-x-auto">
        <pre className="mono m-0 whitespace-pre pt-2 text-[11.5px] leading-[1.5] text-ink">
          {shown.map((line, i) => (
            <span key={i} className="block">
              {/* Muted, not dim: a line number is text a reader looks for,
                  and the dim token is for glyphs nobody reads
                  (e2e/contrast.spec.ts, "dim is never a word"). */}
              <span className="select-none pr-3 text-muted">
                {String(i + 1).padStart(width, ' ')}
              </span>
              {line}
            </span>
          ))}
        </pre>
      </div>
      {rest > 0 && (
        <p className="label-sm pt-1.5">
          …and {rest} more {pluralWord(rest, 'line')}, in the repo download.
        </p>
      )}
    </div>
  );
}
