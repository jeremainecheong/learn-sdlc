'use client';

/**
 * Markdown, parsed once per string rather than once per keystroke.
 *
 * The parse happens during render (ReactMarkdown turns the text into elements
 * every time it is called), so an unmemoised copy of this in the reviewer's
 * feed would re-parse every reply in the thread each time anything in the IDE
 * committed, a character typed at the reviewer included. The children
 * are a plain string, so the default shallow comparison is exactly the right
 * one: same text, same output, no work.
 *
 * The engine itself is 143 KB of parser. Where this component is imported
 * statically the page is one that draws markdown and wants it there and then;
 * the shell's reviewer column, which every signed-in page carries whether it
 * draws markdown or not, reaches it through a dynamic import instead (see
 * PersonaPanel.tsx).
 */
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { scrollFocusRef } from '@/lib/scroll-focus';

/**
 * Every heading drops one level.
 *
 * Markdown here is always *inside* a page that already has its own `<h1>`:
 * the pack's brief, the learner's own artefact, a mentor's reply. A leading
 * `#` in any of those would emit a second top-level heading, so a page such
 * as /dossier would announce several documents, and because the learner writes
 * the text it could happen on any room at any time. Shifting the whole ramp
 * keeps the document's own structure and nests it under the page's heading.
 * `data-md` carries the level the author wrote, and `globals.css` sizes the
 * ramp off that rather than off the tag, so nothing on screen moves.
 */
const NESTED_HEADINGS: Components = {
  // `node` is react-markdown's own mdast node and is not a DOM attribute; it
  // has to be taken off the rest before the props are spread, or every
  // heading in the product carries node="[object Object]".
  h1: ({ node, children, ...rest }) => (
    <h2 {...rest} data-md="1">
      {children}
    </h2>
  ),
  h2: ({ node, children, ...rest }) => (
    <h3 {...rest} data-md="2">
      {children}
    </h3>
  ),
  h3: ({ node, children, ...rest }) => (
    <h4 {...rest} data-md="3">
      {children}
    </h4>
  ),
  h4: ({ node, children, ...rest }) => (
    <h5 {...rest} data-md="4">
      {children}
    </h5>
  ),
  h5: ({ node, children, ...rest }) => (
    <h6 {...rest} data-md="5">
      {children}
    </h6>
  ),
  // There is no h7; the sixth level stays where it is rather than becoming a
  // paragraph that no longer reads as a heading at all.
  h6: ({ node, children, ...rest }) => (
    <h6 {...rest} data-md="6">
      {children}
    </h6>
  ),
  // `.prose-docs table` is its own horizontal scroller (globals.css), so on a
  // phone a wide table hides columns past its edge. It joins the tab order
  // while it scrolls, so a keyboard can reach them (axe rule
  // scrollable-region-focusable; the dossier's design.md fields table is one).
  table: ({ node, children, ...rest }) => (
    <table {...rest} ref={scrollFocusRef}>
      {children}
    </table>
  ),
  // `.prose-docs pre` scrolls the same way, so a code block wider than a phone
  // column takes the same tab stop while it scrolls.
  pre: ({ node, children, ...rest }) => (
    <pre {...rest} ref={scrollFocusRef}>
      {children}
    </pre>
  ),
};

export const Markdown = memo(function Markdown({
  children,
  className = '',
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={`prose-docs min-w-0 ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={NESTED_HEADINGS}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
