/**
 * Which mode the mentor opens in on a phase's pages.
 *
 * Each page of a phase mounts its own mentor. Were each mount to open in
 * Guided, a learner who had chosen Agentic on the workspace would find Guided
 * on the review page, with the proposal they were working on kept but out of
 * view until they pressed Agentic again. So, per phase state and for this
 * browser tab's session:
 *
 * - the mode the learner last pressed is the mode the next mentor of the same
 *   phase opens in, on the workspace and on every document page alike;
 * - a mentor that knows an open (not applied) proposal for the phase opens on
 *   Agentic whatever was pressed last, so the proposal is in view;
 * - a phase with nothing kept opens in Guided.
 *
 * "Knows" is this tab's knowledge: the Agentic panel says whether its loaded
 * conversation holds an open proposal ({@link keepProposalOpen}), and only
 * while it is mounted. A proposal made in another tab or before this session
 * is not known until the Agentic panel has loaded once; nothing here asks the
 * API.
 *
 * Kept in `sessionStorage` (a reload keeps it, a new tab or a closed window
 * does not), keyed by the phase state id, which belongs to one learner. Where
 * the storage is missing or throws (a private window), the same record is kept
 * in memory for as long as the page lives, so moving between the phase's
 * pages still keeps the mode; nothing else changes.
 */

import { onSessionEnd } from '@/lib/session';

export type MentorMode = 'guided' | 'agentic';
type Kept = { mode?: MentorMode; proposal?: boolean };

export const MENTOR_MODE_KEY = 'lsdlc_mentor_mode:';
const EMPTY: Kept = {};
/** The records a storage that throws could not hold, by phase state id. */
const memory = new Map<string, Kept>();
const listeners = new Set<() => void>();
onSessionEnd(() => { memory.clear(); notify(); });

function notify() { listeners.forEach((listener) => listener()); }

function parse(raw: string | null): Kept {
  if (!raw) return EMPTY;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY;
    const record = value as Record<string, unknown>;
    return {
      ...(record.mode === 'guided' || record.mode === 'agentic' ? { mode: record.mode } : {}),
      ...(record.proposal === true ? { proposal: true } : {}),
    };
  } catch { return EMPTY; }
}

function read(phaseId: string): Kept {
  if (typeof window === 'undefined') return EMPTY;
  const held = memory.get(phaseId);
  if (held) return held;
  try { return parse(window.sessionStorage.getItem(MENTOR_MODE_KEY + phaseId)); }
  catch { return EMPTY; }
}

function write(phaseId: string, next: Kept) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(MENTOR_MODE_KEY + phaseId, JSON.stringify(next));
    memory.delete(phaseId);
  } catch { memory.set(phaseId, next); }
  notify();
}

/** The mode a mentor of this phase opens in now. */
export function openingMode(phaseId: string | undefined): MentorMode {
  if (!phaseId) return 'guided';
  const kept = read(phaseId);
  return kept.proposal ? 'agentic' : kept.mode ?? 'guided';
}

/** A press on Guided or Agentic: the next mentor of this phase opens in it. */
export function keepMode(phaseId: string | undefined, mode: MentorMode) {
  if (!phaseId) return;
  const kept = read(phaseId);
  if (kept.mode === mode) return;
  write(phaseId, { ...kept, mode });
}

/** What the Agentic panel's loaded conversation says: whether it holds an open proposal. */
export function keepProposalOpen(phaseId: string | undefined, open: boolean) {
  if (!phaseId) return;
  const kept = read(phaseId);
  if (Boolean(kept.proposal) === open) return;
  const next: Kept = { ...kept };
  if (open) next.proposal = true; else delete next.proposal;
  write(phaseId, next);
}

export function subscribeMentorMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
