'use client';

import { CRITERION_TAGS, type AcceptanceCriterion, type Story } from './story';
import { storySentence } from './storySentence';

/** A story as a card reads it: a provided one carries no scope or notes. */
export type CardStory = Pick<Story, 'id' | 'title' | 'persona' | 'capability' | 'benefit'> &
  Partial<Pick<Story, 'scopeExclusions' | 'notes'>> & { criteria?: AcceptanceCriterion[] };

const bare = (text: string) => text.trim().replace(/[.;]+$/, '').trim();

/** A criterion kind as the cards name it: "Happy path", "Boundary", "Error". */
export const tagLabel = (tag: AcceptanceCriterion['tag']) => CRITERION_TAGS.find((one) => one.value === tag)?.label ?? tag;

/**
 * One story, read-only, drawn from its fields: the id and title, the story
 * sentence, and the acceptance criteria. `full` adds what only the learner's
 * own story has, the out-of-scope lines and the open questions, and says so
 * when a part is still empty. Nothing here is markdown.
 */
export function StoryCard({ story, full = false, criteria = true, heading = true, testId }: {
  story: CardStory;
  full?: boolean;
  /** False where the id and title are already the surrounding dialog's title. */
  heading?: boolean;
  /** False where the criteria are drawn beside the card already. */
  criteria?: boolean;
  testId?: string;
}) {
  const sentence = storySentence(story);
  const list = story.criteria ?? [];
  const scope = (story.scopeExclusions ?? []).map(bare).filter(Boolean);
  return (
    <article
      className="flex min-w-0 flex-col gap-2 rounded-ctl border-1.5 border-edge bg-raised p-3 text-[12.5px] leading-[1.6] text-ink2 [overflow-wrap:anywhere]"
      data-testid={testId}
    >
      {heading && (
        <h4 className="m-0 text-[13px] font-semibold text-ink">
          {story.id && <span className="mono mr-2 text-muted">{story.id}</span>}
          {story.title.trim() || 'Untitled story'}
        </h4>
      )}
      {sentence ? <p className="m-0">{sentence}</p> : full && <p className="m-0 text-muted">The story sentence is not written yet.</p>}
      {criteria && list.length > 0 && (
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Acceptance criteria">
          {list.map((c) => (
            <li key={c.id} className="min-w-0">
              <span className="mono mr-2 font-semibold text-ink">{c.id}</span>
              <span className="label-sm">{tagLabel(c.tag)}</span>
              <p className="m-0">Given {bare(c.given) || '…'}, when {bare(c.when) || '…'}, then {bare(c.then) || '…'}.</p>
            </li>
          ))}
        </ol>
      )}
      {criteria && full && list.length === 0 && <p className="m-0 text-muted">No acceptance criteria yet.</p>}
      {full && <p className="m-0"><span className="label-sm mr-2">Out of scope</span>{scope.length ? scope.join('; ') : 'Not specified'}</p>}
      {/* An empty box is a story with nothing left to ask, said as such rather than left out. */}
      {full && <p className="m-0"><span className="label-sm mr-2">Open questions</span>{story.notes?.trim() || 'None'}</p>}
    </article>
  );
}
