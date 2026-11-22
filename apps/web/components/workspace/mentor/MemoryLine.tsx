'use client';

/**
 * "Remembering what you decided earlier": the one line that makes the mentor's
 * memory visible instead of uncanny.
 *
 * The memory is rebuilt from the learner's own passed artefacts and reaches
 * them only as words inside a reply: the API exposes no memory route on
 * purpose, because a learner cannot correct a memory that is a reading of
 * their own files; they correct the file. So the line is derived from the
 * reply it belongs to, and it appears only when the reply actually carried a
 * memory, never as a promise that one was used.
 */
import { useState } from 'react';
import { Notice } from '@/components/ui';

/**
 * The clause the deterministic mentor appends: `Earlier you decided: …`, its
 * own paragraph. The model is told the same thing inside the LEARNER_DATA
 * fence and answers in its own words, so a model reply usually carries no such
 * paragraph and gets no line: which is the honest outcome, not a bug.
 */
export const REMEMBERED_PREFIX = 'Earlier you decided:';

export function rememberedFrom(content: string): string | null {
  for (const paragraph of content.split(/\n{2,}/)) {
    const line = paragraph.trim();
    if (line.startsWith(REMEMBERED_PREFIX)) {
      const rest = line.slice(REMEMBERED_PREFIX.length).trim();
      if (rest) return rest;
    }
  }
  return null;
}

/**
 * Draws nothing when the reply carried no memory, so a caller can hand it every
 * reply without asking first: which is also what keeps the derivation in one
 * place rather than in the column that renders the thread.
 */
export function MemoryLine({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const remembered = rememberedFrom(content);
  if (!remembered) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="label-sm w-fit text-left font-medium text-ink2 underline decoration-edge2 underline-offset-2 hover:text-ink"
        data-testid="mentor-memory-line"
      >
        Remembering what you decided earlier
      </button>
      {open && (
        <Notice tone="info" testId="mentor-memory-detail" icon="clipboard">
          <span className="font-semibold">{remembered}</span>
          <span className="mt-1 block text-[12.5px]">
            The mentor reads this back out of the artefacts you have already passed. Change the
            artefact and the mentor changes with it.
          </span>
        </Notice>
      )}
    </>
  );
}
