/**
 * Where the editor shows an applied proposal.
 *
 * An Apply in a code room replaces the open file's text, and the notice "The reviewed proposal is saved in this
 * workspace." pushes the editor down, so the changed lines can land under the lower panel or below the fold (in
 * TaskTrackr, Implementation's changed line 12 and Testing's new second test, lines 21 to 23). So, once per Apply and
 * at the moment the applied text is in the editor, the editor shows the lines the Apply changed in the file that is
 * open, from the first to the last (showing only the first can leave a later changed line, such as a new assertion,
 * under the fold). Nothing else: no other file is opened, the caret and the keyboard focus stay where they were, and
 * the lower panel's result is left as it is (a red run before the fix is part of what the learner reads).
 */

/**
 * The lines of `after` that differ from `before`, 1-based and inclusive, or null when the two are the same text: the
 * lines both texts share at their start and at their end are left out, and what remains of `after` is the change. A
 * change that only took lines away shows at the line now standing where they were (the last line, when they were
 * taken off the end).
 */
export function changedLines(before: string, after: string): { first: number; last: number } | null {
  if (before === after) return null;
  const was = before.split('\n');
  const now = after.split('\n');
  const shorter = Math.min(was.length, now.length);
  let head = 0;
  while (head < shorter && was[head] === now[head]) head += 1;
  let tail = 0;
  while (tail < shorter - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail += 1;
  const first = Math.min(head + 1, now.length);
  return { first, last: Math.max(first, now.length - tail) };
}

export interface AppliedReveal {
  path: string;
  /** The first changed line of `path`, 1-based. */
  line: number;
  /** The last changed line of `path`, 1-based: `line` itself when the Apply changed one line. */
  last: number;
  /** The applied text: the reveal waits until the editor holds exactly this. */
  text: string;
}

/**
 * What to reveal after an Apply: the file that was open and showing `shown.text` before the Apply, its text as the
 * Apply left it (`after`), and the first and last lines that differ. Null when the open file did not change (the room opens
 * no other file), when nothing was open, or when the file still holds keystrokes of the learner's that the editor
 * keeps over the applied copy (`pending`), so the applied text is not what the editor will show.
 */
export function appliedReveal(
  shown: { path: string; text: string } | null,
  after: readonly { path: string; content: string }[],
  pending: Readonly<Record<string, string>>,
): AppliedReveal | null {
  if (!shown || pending[shown.path] !== undefined) return null;
  const file = after.find((f) => f.path === shown.path);
  if (!file) return null;
  const lines = changedLines(shown.text, file.content);
  return lines === null ? null : { path: shown.path, line: lines.first, last: lines.last, text: file.content };
}
