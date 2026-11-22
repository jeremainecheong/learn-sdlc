'use client';

import { Chip, Stat } from '@/components/ui';
import { statusState, statusWord } from '@/lib/phase';
import type { StatusState } from '@/lib/phase';
import type { PhasePanelProps } from '../types';
import { useReferenceScaffolding } from '@/lib/scenario';
import { Row, RowList } from './Rows';
import { storyCheckShown } from './Checks';
import { shownStoryId } from './story';
import { OLDER_FORMAT_SENTENCE, criterionState, useStoryView } from './useStory';
import { STATE_LABEL, isCredited } from '../../gate-state';

/**
 * The foot of the brief pane: what the issue is, how far the story has got,
 * and the backlog it belongs to. The check list itself lives beside the fields
 * in the Issue tab, where the typing happens.
 */
export default function RequirementsBrief(props: PhasePanelProps) {
  const { detail } = props;
  const view = useStoryView(props);
  // No default 'US-4' off the reference room.
  const reference = useReferenceScaffolding('requirements');
  if (!detail.story) return <p className="purpose wrap" data-testid="phase-requirements-older-format">{OLDER_FORMAT_SENTENCE}</p>;

  const ownId = shownStoryId(view.story.id, reference);
  const title = view.story.title.trim();
  const passing = view.results.filter((r) => r.passed).length;
  const criteria = view.story.criteria;
  const runnable = criteria.filter((c) => criterionState(c) === 'runnable').length;
  // A phase passed on the board by the teacher's credit reads as credit, in
  // the warn tone, never as a pass (the gate band's source).
  const credited = isCredited(detail.id, detail);
  const storyState: StatusState = credited ? 'warn' : statusState(detail.status, true);
  const provided = detail.story.providedStories.filter((s) => s.id !== view.story.id);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="h3 wrap min-w-0">
            {(reference || ownId) && <span className="mono mr-2 text-muted">{ownId}</span>}
            {title || 'Untitled'}
          </h2>
          <Chip tone={storyState === 'pass' ? 'pass' : storyState === 'warn' ? 'warn' : 'accent'}>
            {credited ? STATE_LABEL.credited : statusWord(detail.status)}
          </Chip>
        </div>
        <p className="purpose wrap">Reported by the product owner, who reviews what you write.</p>
      </div>

      <div className="grid min-w-0 grid-cols-2 gap-2">
        <Stat
          value={`${runnable} of ${criteria.length}`}
          label="Criteria a test can check"
          tone={criteria.length >= 2 && runnable >= 2 ? 'pass' : 'neutral'}
        />
        <Stat
          value={`${passing} of ${view.results.length}`}
          label="Story checks passing"
          tone={passing === view.results.length ? 'pass' : 'warn'}
        />
      </div>

      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Story checks">
        {view.results.map((r) => (
          <li key={r.id}>
            <Chip tone={r.passed ? 'pass' : 'fail'} title={storyCheckShown(r.detail)}>
              {storyCheckShown(r.label)}
              <span className="sr-only"> {r.passed ? 'passed' : 'failed'}</span>
            </Chip>
          </li>
        ))}
      </ul>

      <RowList head="Story" right="Status">
        {provided.map((s) => (
          <Row
            key={s.id}
            state={'pass' as StatusState}
            title={
              <>
                <span className="mono mr-2 text-muted">{s.id}</span>
                {s.title}
              </>
            }
            detail="Approved by the product owner"
            right={<Chip tone="neutral">Given</Chip>}
          />
        ))}
        <Row
          state={storyState}
          title={
            <>
              {ownId && <span className="mono mr-2 text-muted">{ownId}</span>}
              {title || 'Your story'}
            </>
          }
          detail={`${criteria.length} acceptance criteria`}
          right={<Chip tone="accent">Yours</Chip>}
        />
      </RowList>
    </div>
  );
}
