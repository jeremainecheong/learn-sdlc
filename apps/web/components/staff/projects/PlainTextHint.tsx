/**
 * The editor's plain-text sentence under a teacher's text field: every text
 * field of the editor says it is plain text, in the words the quiz form uses. A
 * field points at it with `aria-describedby`, so a
 * screen reader reads it with the field.
 */
export const PLAIN_TEXT_HINT =
  "Plain text. Lists, indented lines and code in backticks are kept as you type them; a heading's # and the stars or underscores around words are removed when you save.";

export function PlainTextHint({ id }: { id: string }) {
  return (
    <p id={id} className="purpose wrap">
      {PLAIN_TEXT_HINT}
    </p>
  );
}
