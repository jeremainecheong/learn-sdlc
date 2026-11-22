'use client';

import { SectionHead } from '@/components/ui';
import { storyFloorShown, type StoryFloorResult } from '@learnsdlc/shared';
import { Row, RowList } from './Rows';

const TID = 'phase-requirements';

/**
 * A check's words as a person reads them, with a count of one in the singular: the room's
 * list read "At least 1 out-of-scope lines". The shared floor keeps "lines" and "criteria" for one in the label and
 * the detail it builds, because those reach the reviewer's request byte for byte; the shared `storyFloorShown` is
 * the out-of-scope half, applied where a review shows it, and the criteria half ("1 complete criteria", "fewer than
 * 1 acceptance criteria") is the same rule for the other counted line of this list. Any other text is as it was.
 */
export function storyCheckShown(text: string): string {
  return storyFloorShown(text)
    .replace(/\b1 complete criteria\b/g, '1 complete criterion')
    .replace(/\bfewer than 1 acceptance criteria\b/g, 'fewer than 1 acceptance criterion');
}

/**
 * The checks the review grades the record with: the record itself, then the
 * phase's floor. They move as the learner types, so the verdict is never a
 * surprise.
 */
export function StoryChecks({ results }: { results: StoryFloorResult[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* One heading over the rows, and no second heading above it. */}
      <SectionHead title="Story checks" purpose="The rules your story is checked against as you type. They help you refine it; only a submitted AI review can award a Pass." />
      <RowList head="Check" testId={`${TID}-checks`}>
        {results.map((r) => (
          <Row
            key={r.id}
            testId={`${TID}-rule-${r.id}`}
            state={r.passed ? 'pass' : 'fail'}
            title={
              <>
                {storyCheckShown(r.label)}
                {/* The square carries the result to the eye; the word carries it
                    to a screen reader, and to the test that reads the row. */}
                <span className="sr-only"> {r.passed ? 'Passed' : 'Failed'}</span>
              </>
            }
            detail={storyCheckShown(r.detail)}
          />
        ))}
      </RowList>
    </div>
  );
}
