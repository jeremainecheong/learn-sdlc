'use client';

/**
 * Conversation: the review as a thread, and the reviewer you can ask.
 *
 * The threads are the same ones the diff carries, listed here in one place so
 * the argument can be read end to end; under them is the phase's persona
 * panel, which is where the hints already live. One reviewer, one thread:
 * a reply from the diff and a question asked here land in the same history.
 */
import { pluralWord, type PhaseKey } from '@learnsdlc/shared';
import { PersonaColumn, PersonaPanel, type PersonaThread } from '@/components/shell';
import { EmptyState, Section } from '@/components/ui';
import { Thread } from './Thread';
import type { PrThread } from './threads';

export function Conversation({
  threads,
  phaseKey,
  phaseStateId,
  closedByMerge = false,
  onReply,
  thread,
  showMentor = true,
}: {
  showMentor?: boolean;
  threads: PrThread[];
  phaseKey: PhaseKey;
  phaseStateId?: string;
  /** The phase is merged: the threads on it are closed, not waiting. */
  closedByMerge?: boolean;
  onReply?: (thread: PrThread, text: string) => Promise<string>;
  /**
   * The page's own conversation with the reviewer. When the page
   * holds it, the Checks tab can put a question into this same thread; without
   * it the tab opens one of its own, which is what every other caller does.
   */
  thread?: PersonaThread | null;
}) {
  const open = closedByMerge ? 0 : threads.filter((t) => t.state === 'open').length;
  return (
    <div className="flex flex-col gap-3.5" data-testid="pr-conversation">
      <Section
        title="Review threads"
        purpose="One thread for every case that failed, every analyzer finding, and every contract the code argues with."
        pad={false}
      >
        {threads.length === 0 ? (
          <div className="px-4 pb-4">
            <EmptyState
              icon="pr"
              title="No thread on this submission"
              body="Nothing failed with a line in your files, the analyzer reported nothing, and no contract is contradicted."
            />
          </div>
        ) : (
          <div className="flex flex-col pb-1.5 pt-1.5">
            {threads.map((t, i) => (
              <Thread
                key={t.key}
                thread={t}
                phaseKey={phaseKey}
                index={i + 1}
                showPath
                closedByMerge={closedByMerge}
                onReply={onReply}
              />
            ))}
          </div>
        )}
      </Section>
      {showMentor && <Section
        title={`Ask the reviewer${open > 0 ? `, ${open} ${pluralWord(open, 'thread')} open` : ''}`}
        purpose="The same reviewer, the same history. Every question is numbered, and every reply says what happened to it."
        pad={false}
      >
        <div className="flex h-[460px] min-h-0">
          {thread ? (
            <PersonaColumn
              thread={thread}
              header={false}
              className="!w-full border-t-1.5 !border-l-0"
            />
          ) : (
            <PersonaPanel
              phaseKey={phaseKey}
              phaseStateId={phaseStateId}
              header={false}
              className="!w-full border-t-1.5 !border-l-0"
            />
          )}
        </div>
      </Section>}
    </div>
  );
}
