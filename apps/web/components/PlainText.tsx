import { memo } from 'react';
import { withoutHtmlComments } from '@learnsdlc/shared';

/**
 * A teacher's text, as plain text (spec 6.1, 6.3): paragraphs at blank lines,
 * every line break and every line's leading whitespace kept, long words
 * wrapped, HTML comments not shown, nothing interpreted. Model output keeps
 * `Markdown`; every brief, quiz text and phase text a teacher wrote is this.
 *
 * A code span's backticks and a fenced block's fence lines, which
 * `plainTextOf` keeps, are drawn as the characters they are.
 *
 * The comments are hidden once per display path, because a second
 * `withoutHtmlComments` over a text it already produced can read a different
 * fence and take a comment the first kept as code. A text the API served
 * through `learnerText` has been displayed already, so its surface passes
 * `commentsHidden` and nothing more is taken. Every quiz report is one of
 * these: the API converts its stems, options and explanations once, where it
 * serves the report (`FeedbackService.toView`, `RepoService.historyRevision`,
 * `conceptSubmissionView`), whenever it was marked. The only texts displayed
 * here are the ones the API serves as stored: the editor's own fields
 * (BriefCard's read-only brief and background).
 *
 * Line endings are read once, after the comment display: CRLF and a lone CR
 * each become one line break. Paragraphs then split at a run of blank lines (a
 * line of only spaces or tabs counts as blank); the split takes the blank lines
 * only, so the next paragraph keeps its first line's indentation, and a
 * paragraph drops only the blank lines at its ends.
 */
export const PlainText = memo(function PlainText({
  text,
  className,
  testId,
  commentsHidden = false,
}: {
  text: string;
  className?: string;
  testId?: string;
  /** The API already removed this text's comments (`learnerText`): display nothing more. */
  commentsHidden?: boolean;
}) {
  const shown = commentsHidden ? text : withoutHtmlComments(text);
  const paragraphs = shown
    .replace(/\r\n?/g, '\n')
    .split(/\n(?:[ \t]*\n)+/)
    .map((one) => one.replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, ''))
    .filter((one) => one.trim() !== '');
  return (
    <div className={['plain-text min-w-0', className ?? 'text-[14px] leading-[1.65] text-ink2'].join(' ')} data-testid={testId}>
      {paragraphs.map((one, at) => (
        <p key={at} className={at > 0 ? 'mt-3' : undefined} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {one}
        </p>
      ))}
    </div>
  );
});
