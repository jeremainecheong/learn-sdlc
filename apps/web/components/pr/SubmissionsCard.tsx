'use client';

/**
 * The pull request's history: one row per submission, newest first, with what
 * that revision left behind and what it scored.
 */
import { Chip, Section, Table } from '@/components/ui';
import {
  checksSummary,
  timeOf,
  type Revision,
} from '@/components/workspace/panels/implementation/pr';

export function SubmissionsCard({ revisions }: { revisions: Revision[] }) {
  const rows = [...revisions].reverse();
  return (
    <Section
      testId="phase-implementation-revisions"
      title="Submissions"
      purpose="Each submission is a revision of this pull request. Threads carry over until the line changes."
    >
      {rows.length === 0 ? (
        <p className="purpose">
          Nothing is submitted yet. Submitting opens the pull request and starts the review.
        </p>
      ) : (
        <Table
          minWidth={280}
          rowTestId={(i) => `phase-implementation-revision-${rows[i].attempt}`}
          cols={[
            { label: 'When', width: '60px', mono: true, muted: true },
            { label: 'What' },
            { label: 'Verdict', width: 'auto', align: 'right' },
          ]}
          rows={rows.map((r) => [
            timeOf(r.createdAt),
            <span key="what" className="wrap">
              Submission {r.attempt}:{' '}
              {/* The learner's own words next to the score, so a reader who
                  never opens History still meets them. */}
              {r.message && <span className="text-ink">“{r.message}”. </span>}
              {r.report ? checksSummary(r.report) : r.result.toLowerCase()}
            </span>,
            <Chip key="score" tone={r.state === 'pass' ? 'pass' : r.state === 'fail' ? 'fail' : 'neutral'}>
              {r.report?.aiReview.assessmentError ? 'Needs revision' : r.state === 'pass' ? 'Pass' : r.state === 'fail' ? 'Needs revision' : r.result}
            </Chip>,
          ])}
        />
      )}
    </Section>
  );
}
