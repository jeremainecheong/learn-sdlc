'use client';

/**
 * What you have learned: one row per thing the customer knows, ticked as they
 * say it.
 *
 * The topics come from the pack and the answers never do, a row reads "who
 * the report is for", not what Dana said about it, so the card is a list of
 * questions worth asking rather than a set of answers to copy. Nothing here is
 * graded; it is the readout that tells a learner when they have enough to write
 * the story, which is the only thing the room is for.
 */
import Link from 'next/link';
import { useState } from 'react';
import type { InterviewFactView } from '@learnsdlc/shared';
import { EmptyState, Notice, SectionHead, StatusSquare } from '@/components/ui';

/**
 * The story the "enough" notice names.
 *
 * It comes from the version's own content: the id in the room's own story
 * file (`requirements/story.json`), the same id the backlog row beside it
 * shows. A project whose story file carries no usable id, none yet, a broken
 * file, a teacher's project without one, gets "your user story", never an id
 * borrowed from another project. No project is named here by its slug.
 */
const NEUTRAL_STORY = 'your user story';
const STORY_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export function interviewStoryName(storyFile: string | null | undefined): string {
  if (!storyFile?.trim()) return NEUTRAL_STORY;
  let raw: unknown;
  try {
    raw = JSON.parse(storyFile);
  } catch {
    return NEUTRAL_STORY;
  }
  const id = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { id?: unknown }).id : undefined;
  const named = typeof id === 'string' ? id.trim() : '';
  return STORY_ID.test(named) ? named : NEUTRAL_STORY;
}

export function Checklist({
  facts,
  factsExpected,
  issueHref,
  story = interviewStoryName(undefined),
}: {
  facts: InterviewFactView[];
  /** How many settled topics are enough to write the story. */
  factsExpected: number;
  /** Back to the issue, for the notice once there is enough. */
  issueHref: string;
  /** The story the notice names; see {@link interviewStoryName}. */
  story?: string;
}) {
  const settled = facts.filter((fact) => fact.uncovered).length;
  const enough = settled >= factsExpected;
  /**
   * Beside the transcript this list is a readout; above it on a phone it would
   * be the room: ten topics take the top 500 px of an 844 px screen and leave
   * the conversation a 76 px window. So below `md` the topics
   * fold away behind their own count, and the count, the head and the "you have
   * enough" notice, the three things a learner acts on, stay where they were.
   * `md` and not `lg`: at 768 the room fits with no scroller at all, and a fold
   * there would take away something that works.
   */
  const [open, setOpen] = useState(false);
  return (
    <aside
      className="flex max-h-[45vh] w-full shrink-0 flex-col gap-3 overflow-y-auto border-b-1.5 border-edge bg-surface p-4 lg:max-h-none lg:w-[300px] lg:border-b-0 lg:border-l-1.5"
      data-testid="interview-checklist"
    >
      <SectionHead
        title="What you have learned"
        purpose="The customer knows these things. Ask, and they will tell you."
      />

      {facts.length === 0 ? (
        <EmptyState
          icon="requirements"
          title="Nothing to settle here"
          body="This pack ships no topics for the customer to answer."
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            {/* The topic count, then the number the teacher saved as enough
                (factsExpected), in the room's words (`interviewCountSentence`);
                never the topic count as that number. */}
            <p className="label-sm tabular-nums" data-testid="interview-checklist-count">
              <span data-testid="interview-settled">
                {settled} of {facts.length} settled
              </span>
              , {factsExpected} {factsExpected === 1 ? 'is' : 'are'} enough
            </p>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls="interview-facts"
              className="label-sm font-medium text-ink2 underline decoration-edge2 underline-offset-2 hover:text-ink md:hidden"
              data-testid="interview-checklist-toggle"
            >
              {open ? 'Hide the topics' : 'Show the topics'}
            </button>
          </div>
          <ul
            id="interview-facts"
            className={`m-0 ${open ? 'flex' : 'hidden'} list-none flex-col p-0 md:flex`}
          >
            {facts.map((fact) => (
              <li
                key={fact.id}
                className="grid grid-cols-[12px_minmax(0,1fr)] items-start gap-x-2.5 border-t-1.5 border-edge py-2 first:border-t-0"
                data-testid={`interview-fact-${fact.id}`}
                data-settled={fact.uncovered ? 'yes' : 'no'}
              >
                <span className="inline-flex pt-[5px]">
                  <StatusSquare
                    state={fact.uncovered ? 'pass' : 'todo'}
                    size={10}
                    label={fact.uncovered ? 'Settled' : 'Not settled'}
                  />
                </span>
                <span
                  className={`wrap text-[13px] leading-[1.45] ${
                    fact.uncovered ? 'font-semibold text-ink' : 'text-ink2'
                  }`}
                >
                  {fact.topic}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {enough && (
        <Notice tone="pass" testId="interview-enough">
          You have enough to write {story}.{' '}
          <Link
            href={issueHref}
            className="font-semibold underline"
            data-testid="interview-back-to-issue"
          >
            Back to the issue
          </Link>
        </Notice>
      )}
    </aside>
  );
}
