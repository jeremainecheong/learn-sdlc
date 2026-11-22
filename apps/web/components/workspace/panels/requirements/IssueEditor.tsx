'use client';

import Link from 'next/link';
import { SectionHead, Stat } from '@/components/ui';
import type { PhasePanelProps } from '../types';
import { StoryChecks } from './Checks';
import { useReferenceScaffolding } from '@/lib/scenario';
import { shownStoryId } from './story';
import { OLDER_FORMAT_SENTENCE, criterionState, useStoryView } from './useStory';

const TID = 'phase-requirements';

/**
 * The Issue tab in the IDE rail: where the story stands, and the door to the
 * page it is written on.
 *
 * The form itself lives at `/workspace/[phaseId]/issue`. A story is a form with
 * rules, not a file with a cursor, and the rail is too narrow to hold four
 * criteria of three clauses each without clipping the sentence the learner has
 * just typed. What is here is the summary: the counts, the checks, and the
 * link to the form.
 */
export default function IssueEditor(props: PhasePanelProps) {
  const { detail } = props;
  const view = useStoryView(props);
  // No default 'US-4' off the reference room.
  const reference = useReferenceScaffolding('requirements');
  if (!detail.story) {
    return (
      <div className="flex min-w-0 flex-col gap-4 p-4" data-testid={`${TID}-summary`}>
        <p className="purpose wrap" data-testid={`${TID}-older-format`}>{OLDER_FORMAT_SENTENCE}</p>
      </div>
    );
  }
  const ownId = shownStoryId(view.story.id, reference);
  const title = view.story.title.trim();
  const passing = view.results.filter((r) => r.passed).length;
  const criteria = view.story.criteria;
  const runnable = criteria.filter((c) => criterionState(c) === 'runnable').length;

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4" data-testid={`${TID}-summary`}>
      <SectionHead
        title={
          <>
            {(reference || ownId) && <span className="mono mr-2 text-muted">{ownId}</span>}
            {title || 'Untitled'}
          </>
        }
        purpose="The story is written on its own page, where the criteria have room to be sentences."
      />

      <div className="grid min-w-0 grid-cols-2 gap-2">
        <Stat
          value={`${runnable} of ${criteria.length}`}
          label="Criteria a test can check"
          tone={criteria.length >= 2 && runnable >= 2 ? 'pass' : 'neutral'}
        />
        {view.results.length > 0 && (
          <Stat
            value={`${passing} of ${view.results.length}`}
            label="Story checks passing"
            tone={passing === view.results.length ? 'pass' : 'warn'}
          />
        )}
      </div>

      {view.results.length > 0 && <StoryChecks results={view.results} />}

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Link href={`/workspace/${detail.id}/issue`} className="btn btn-sm">
          Open the issue
        </Link>
      </div>
    </div>
  );
}
