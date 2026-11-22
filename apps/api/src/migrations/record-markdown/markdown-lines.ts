/**
 * What the `RUNBOOK.md` and `CHANGELOG.md` readers share, pure:
 * a file read as lines, each `<!-- ... -->` comment a line of its own after
 * the line it sat in (a learner's comment is their words, kept like any other
 * line), and the markers both readers strip. The folder keeps TypeORM from loading this as a
 * migration, as `design-records/` does.
 */

/** A bullet or numbered-list marker at the start of a line. */
export const MARKER = /^\s*(?:[-*+]|\d+\.)\s+/;
const COMMENTS = /<!--([\s\S]*?)-->/g;
const TODO_ONLY = /^\s*(?:[-*+]\s+)?TODO\(learner\)\s*$/i;
const TODO_COMMENT = /^TODO\(learner\)/i;
/** No line of a text file holds it, so it marks where a comment sat: `\u0000<index>\u0000`. */
const COMMENT_AT = /\u0000(\d+)\u0000/;

/** Whitespace collapsed: how the template rule compares a line with the template's. */
export const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

export type MarkdownLine = { kind: 'comment'; text: string } | { kind: 'line'; raw: string };

/**
 * `markdown`'s lines in order, each comment a `comment` line with its text
 * collapsed (an empty comment says nothing and is left out). A comment that
 * shares its line with other text is taken out of that line, never splitting
 * it (the text either side joins with one space), and follows it. `dropTodo`
 * leaves out a line that is only a `TODO(learner)` marker and a comment that
 * opens with one: the template's instructions, which a draft's starting
 * record does not carry.
 */
export function markdownLines(markdown: string, dropTodo: boolean): MarkdownLine[] {
  const comments: string[] = [];
  const marked = markdown.replace(COMMENTS, (_comment, inner: string) => `\u0000${comments.push(collapse(inner)) - 1}\u0000`);
  const out: MarkdownLine[] = [];
  for (const line of marked.split('\n')) {
    // split at the comments it holds: the text pieces at even places, the comments' indexes at odd ones
    const parts = line.split(COMMENT_AT);
    let raw = parts[0];
    for (let at = 2; at < parts.length; at += 2) {
      const next = parts[at];
      if (!next.trim()) raw = raw.replace(/[ \t]+$/, '');
      else if (!raw.trim()) raw += next.replace(/^[ \t]+/, '');
      else raw = `${raw.replace(/[ \t]+$/, '')} ${next.replace(/^[ \t]+/, '')}`;
    }
    if (parts.length === 1 || raw.trim()) {
      if (!(dropTodo && TODO_ONLY.test(raw))) out.push({ kind: 'line', raw });
    }
    for (let at = 1; at < parts.length; at += 2) {
      const text = comments[Number(parts[at])];
      if (text && !(dropTodo && TODO_COMMENT.test(text))) out.push({ kind: 'comment', text });
    }
  }
  return out;
}
