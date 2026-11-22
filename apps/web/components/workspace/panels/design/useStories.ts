'use client';

/**
 * The learner's own story record, the one thing the Design room reads from
 * another phase.
 *
 * The stories the design is checked against are the Design phase's own list
 * (`PhaseDetail.design.stories`), which arrives with the phase. Beside them
 * the room reads the learner's story record from the Requirements phase,
 * read-only and never graded here. The shell holds phase summaries with no
 * file bodies, so this hook fetches that one phase, once, keeps only
 * `requirements/story.json`, and remembers it for a minute.
 *
 * A failure is not an error. The record simply is not there, and the rules
 * that need the learner's own criteria stay quiet.
 */
import { useEffect, useState } from 'react';
import { STORY_JSON, type EnrollmentView } from '@learnsdlc/shared';
import { workspaceApi } from '@/lib/api-workspace';

/** The learner's story record among a phase's files: its text, or undefined. Nothing else is read. */
export function ownStoryRecordOf(files: readonly { path: string; content: string }[]): string | undefined {
  return files.find((f) => f.path === STORY_JSON)?.content;
}

/** Requirements phase id → its story record, and when it was read. */
const cache = new Map<string, { record: string | undefined; at: number }>();
const inflight = new Map<string, Promise<string | undefined>>();

/**
 * How long a copy is used without asking again. The same minute the shell
 * gives its own project data (`FRESH_MS`, `lib/useProject.tsx`), so a learner
 * who edits their story and walks straight to the design room sees the
 * warning move.
 */
const FRESH_MS = 60_000;

async function loadOwnRecord(phaseId: string): Promise<string | undefined> {
  const held = cache.get(phaseId);
  if (held && Date.now() - held.at < FRESH_MS) return held.record;
  const running = inflight.get(phaseId);
  if (running) return running;
  const run = workspaceApi
    .phase(phaseId)
    .then((detail) => {
      const record = ownStoryRecordOf(detail.files);
      cache.set(phaseId, { record, at: Date.now() });
      return record;
    })
    // A stale copy is better than nothing, so it is what a failure falls back to.
    .catch(() => held?.record)
    .finally(() => inflight.delete(phaseId));
  inflight.set(phaseId, run);
  return run;
}

/**
 * The text of the learner's own `requirements/story.json`, or undefined when
 * the project has no open Requirements phase or no record. The fetch happens
 * once per phase id a minute, is shared between the design page and the IDE
 * tab, and never blocks either: both draw with what they have.
 */
export function useOwnStoryRecord(enrollment: EnrollmentView | null | undefined): string | undefined {
  const requirements = enrollment?.phases?.find((p) => p.key === 'requirements');
  const phaseId = requirements && requirements.status !== 'locked' ? requirements.id : null;
  // Opens on the copy this session already read, so coming back to the room
  // draws the warnings in the first paint rather than after a round trip.
  const [record, setRecord] = useState<string | undefined>(() => (phaseId ? cache.get(phaseId)?.record : undefined));

  useEffect(() => {
    if (!phaseId) {
      setRecord(undefined);
      return;
    }
    let stale = false;
    void loadOwnRecord(phaseId).then((next) => {
      if (!stale) setRecord(next);
    });
    return () => {
      stale = true;
    };
  }, [phaseId]);

  return phaseId ? record : undefined;
}
