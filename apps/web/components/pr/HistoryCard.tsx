'use client';

/**
 * The pull request's log: one row per revision, newest first, read as
 * sentences: when it was submitted, what the learner said it changes, and
 * what it scored.
 *
 * The Submissions card on the Merge tab says the same thing in the margin of
 * the merge; this is the whole log, given the width to be read. Both draw the
 * `Revision` the implementation panel already derives, so neither re-reads a
 * submission.
 */
import { Button, Chip, Section, Table } from '@/components/ui';
import {
  checksSummary,
  count,
  timeOf,
  type Revision,
} from '@/components/workspace/panels/implementation/pr';

export function HistoryCard({
  revisions,
  /**
   * Whether this revision's files are still kept: true when they have been
   * read, false when retention has pruned them, undefined when the page has
   * not asked. Selecting a revision loads its retained files.
   */
  filesKept,
  /** Open the diff, for a revision whose files are still there to read. */
  onOpenFiles,
}: {
  revisions: Revision[];
  filesKept: (id: string) => boolean | undefined;
  onOpenFiles: (id: string) => void;
}) {
  const rows = [...revisions].reverse();
  const withMessage = rows.filter((r) => r.message).length;
  return (
    <Section
      testId="pr-history"
      title="History"
      purpose={
        rows.length === 0
          ? 'Every revision of this pull request will be listed here, newest first.'
          : withMessage === 0
            ? 'None of these revisions carries a message yet. The message is what a reviewer reads first.'
            : `${count(rows.length, 'revision')}, newest first. The message is what a reviewer reads first.`
      }
      right={
        rows.length > 0 ? (
          <Chip tone="outline">{count(withMessage, 'message')}</Chip>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <p className="purpose">
          Nothing is submitted yet. Submitting opens the pull request and starts the review.
        </p>
      ) : (
        <Table
          minWidth={360}
          rowTestId={(i) => `pr-history-row-${rows[i].attempt}`}
          cols={[
            { label: 'When', width: '60px', mono: true, muted: true },
            { label: 'What' },
            { label: 'Verdict', width: 'auto', align: 'right' },
          ]}
          rows={rows.map((r) => {
            const kept = filesKept(r.id);
            return [
              timeOf(r.createdAt),
              <span key="what" className="wrap flex min-w-0 flex-col gap-1">
                <span className="wrap">
                  Submission {r.attempt}.{' '}
                  {r.message ? (
                    <span className="text-ink">“{r.message}”</span>
                  ) : (
                    <span className="text-muted">No message</span>
                  )}
                  . {r.report ? checksSummary(r.report) : r.result.toLowerCase()}
                </span>
                {kept === false ? (
                  <span className="label-sm">Files are not kept for this revision.</span>
                ) : r.report ? (
                  <span>
                    <Button variant="ghost" size="sm" onClick={() => onOpenFiles(r.id)} testId={`pr-history-files-${r.attempt}`}>
                      Read the files
                    </Button>
                  </span>
                ) : null}
              </span>,
              <Chip key="score" tone={r.state === 'pass' ? 'pass' : r.state === 'fail' ? 'fail' : 'neutral'}>
                {r.report?.aiReview.assessmentError ? 'Needs revision' : r.state === 'pass' ? 'Pass' : r.state === 'fail' ? 'Needs revision' : r.result}
              </Chip>,
            ];
          })}
        />
      )}
    </Section>
  );
}
