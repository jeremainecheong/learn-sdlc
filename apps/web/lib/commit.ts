'use client';

/**
 * The commit message being written, before it is sent.
 *
 * A revision's message is typed in two places (the Commit tab in the IDE and
 * the field above "Submit again" on the pull request) and they are the same
 * sentence about the same revision. So the draft belongs to the phase and to
 * the session rather than to either component: typing in the workspace and
 * walking to the pull request finds the words still there, and coming back
 * finds them again.
 *
 * Not localStorage, while the session is whole. This is a sentence a learner is
 * part-way through writing, not work: lib/api.ts already documents that a
 * locked-down browser answers `setItem` with a throw or a silent no-op, and a
 * draft that survives a reload but belongs to a session somebody deliberately
 * ended is worse than one that does not. It is dropped when the token changes,
 * exactly as lib/records.ts is.
 *
 * With one exception, which is where the two cases part company. A session that
 * ends *under* the learner (the one-hour token of a managed deployment, which
 * can end at a Submit click) is not them
 * leaving: they are still at the keyboard and about to sign straight back in,
 * and the Map below is the only copy of what they had written. So
 * {@link stashCommitDrafts} runs on the way out, under the live session, and
 * writes the words to lib/pending-action.ts, which bounds them exactly as an
 * unsaved file is bounded: owner-stamped, a day at most, dropped when read by
 * another account, and swept from a shared browser. Which rule serves which
 * case:
 *
 * - **the session ended under them**: the leaving hooks run before
 *   `clearAuth()`, so the sentence is stashed and {@link restoreCommitDraft}
 *   puts it back;
 * - **they pressed Sign out**: `onSignOut` runs after that same flush and
 *   deletes every record, so nothing of theirs is left on the machine.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { onSessionLeaving, onSignOut, rememberUnsentMessageKept } from './api';
import {
  forgetAllPendingActions,
  readPendingAction,
  readPendingActions,
  rememberPendingText,
} from './pending-action';
import { onSessionEnd, ownedByToken } from './session';

const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

/**
 * These belong to one signed-in session. Signing in as someone else in the
 * same tab must never hand the next learner the last one's half-written line.
 */
const own = ownedByToken(() => {
  drafts.clear();
});

function announce(): void {
  listeners.forEach((fn) => fn());
}

/** What is typed for a phase right now, '' when nothing is. */
export function commitDraft(phaseId: string): string {
  own();
  return drafts.get(phaseId) ?? '';
}

/** Hold what is typed. An empty draft is removed rather than kept as ''. */
export function setCommitDraft(phaseId: string, text: string): void {
  own();
  if (text) drafts.set(phaseId, text);
  else drafts.delete(phaseId);
  announce();
}

/**
 * Forget the draft for a phase: the submission was accepted and the words are
 * on the revision now. A submission that never left the browser keeps its
 * draft: the learner would otherwise be asked to write it again.
 */
export function clearCommitDraft(phaseId: string): void {
  own();
  if (!drafts.delete(phaseId)) return;
  announce();
}

/** Everything, for a sign-out. */
export function resetCommitDrafts(): void {
  if (drafts.size === 0) return;
  drafts.clear();
  announce();
}

/**
 * Write every unsent sentence down, while the session that owns it is still
 * whole.
 *
 * Registered as a leaving hook, so it runs before `clearAuth()` on an expiry
 * and before the sweep on a deliberate sign-out. It records a `'draft'`, never
 * a `'submit'`: a sentence typed and never sent is not a submission that was
 * lost, and a notice calling it one would be the product saying something
 * untrue. Where a submission really was attempted, `api.submit` has already
 * written that record and this only fills in the words that went with it.
 *
 * It tells lib/api.ts when a message really did survive, and only then. The
 * sign-in page the browser lands on is a different document with no session,
 * so it cannot read the record itself; that one bit is what lets it say a
 * message is waiting when one is, and say nothing when a locked-down browser
 * kept nothing or there was nothing to keep.
 */
export function stashCommitDrafts(): void {
  own();
  let kept = false;
  for (const [phaseId, text] of drafts) {
    if (text && rememberPendingText(phaseId, text)) kept = true;
  }
  if (kept) rememberUnsentMessageKept();
}

/**
 * Put a stashed sentence back in the field.
 *
 * Through {@link setCommitDraft} rather than into the Map, so every field
 * writing this phase's message repaints. What is typed now always wins: a
 * learner who has started again is not overwritten by what they wrote before.
 */
export function restoreCommitDraft(phaseId: string): boolean {
  const text = readPendingAction(phaseId)?.text;
  if (!text || commitDraft(phaseId)) return false;
  setCommitDraft(phaseId, text);
  return true;
}

/** The same, for every phase a record was kept for. */
export function restoreCommitDrafts(): void {
  for (const record of readPendingActions()) restoreCommitDraft(record.phaseId);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The draft as React state: `[text, setText]`, shared by every field that is
 * writing the same phase's message.
 */
export function useCommitDraft(phaseId: string): [string, (text: string) => void] {
  // Read through the store rather than held in state, so two fields on one
  // page cannot disagree about what has been typed.
  const text = useSyncExternalStore(
    subscribe,
    () => commitDraft(phaseId),
    () => '',
  );
  // The setter keeps its identity. A fresh function on every render is a
  // fresh prop for whatever holds the field, and in the IDE that is the whole
  // bottom panel: the terminal, the run, the ledger and the code health
  // would be rebuilt every time the caret moved.
  const write = useCallback((next: string) => setCommitDraft(phaseId, next), [phaseId]);
  return [text, write];
}

onSessionEnd(resetCommitDrafts);
onSessionLeaving(stashCommitDrafts);
onSignOut(forgetAllPendingActions);
