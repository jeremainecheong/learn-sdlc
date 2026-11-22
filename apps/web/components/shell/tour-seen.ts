/**
 * What the browser remembers about tours: the pages whose tour was seen, each
 * phase's tutorial, and the scope a phase tutorial is read for.
 */
import type { PhaseDetail, PhaseKey, PhaseProvenanceView } from '@learnsdlc/shared';

/** The browser key under which the pages whose tour was seen are kept. */
export const COACH_KEY = 'lsdlc_coach';

export const TOUR_PAGES = ['home', 'progress', 'profile', 'learn', 'lesson', 'brief', 'issue', 'design', 'ide', 'page'] as const;

export type TourPage = typeof TOUR_PAGES[number];

export type SeenTours = Partial<Record<TourPage, true>>;

export interface PhaseTutorialScope {
  ownerId: string;
  phaseId: string;
  phaseKey: PhaseKey;
  ready: boolean;
  /**
   * Whether the phase offers its lesson (`lessonsOfferedOn`), so the last step
   * names the strip's "Optional phase guide" only where the strip draws it.
   * Absent reads as offered.
   */
  lessons?: boolean;
  /**
   * The held detail's provenance, so the implementation tour leaves out its
   * App preview step where the room draws no App preview
   * (`runsReferenceApplication`), and the maintenance tour aims at the brief,
   * Edit files, Execution evidence and Pull request where the room draws no
   * Change request. Absent reads as the reference project's tour. `interview`
   * null (the phase holds no interview) leaves the Requirements tour's
   * interview steps out.
   */
  provenance?: TourProvenance;
  /**
   * A Design room's switches, from the room's own completed GET, so the tour
   * of a room that is not the reference project's names only the tabs it
   * draws. Absent reads as the reference project's tour.
   */
  design?: TourDesign;
  /**
   * The learner has passed this phase and moved on from it: the
   * phase passed, and the project completed or the learner standing on a later
   * phase (`movedOnFrom`, the rule the gate band's "You have moved on from this
   * phase" reads). The tutorial then does not open by itself on entry; Replay
   * tutorial still opens it. Absent or false (a phase in progress, not yet
   * started, awaiting a sign-off, or the current phase of a project not yet
   * completed): the tutorial opens once on first entry.
   */
  movedOn?: boolean;
}

/** What the phase tours read of the provenance. */
export type TourProvenance = (Pick<PhaseProvenanceView, 'application'> & Partial<Pick<PhaseProvenanceView, 'interview' | 'roomTask'>>) | null;

/** What the Design tour reads of the room's switches. */
export type TourDesign = Pick<NonNullable<PhaseDetail['design']>, 'contracts' | 'sequence'> | null;

const seenPhaseMemory = new Set<string>();

export function phaseTutorialKey(scope: Pick<PhaseTutorialScope, 'ownerId' | 'phaseId'>): string {
  return `lsdlc_phase_tutorial_v1:${encodeURIComponent(scope.ownerId)}:${encodeURIComponent(scope.phaseId)}`;
}

export function phaseTutorialSeen(scope: PhaseTutorialScope): boolean {
  const key = phaseTutorialKey(scope);
  try { return window.localStorage.getItem(key) === 'seen' || seenPhaseMemory.has(key); }
  catch { return seenPhaseMemory.has(key); }
}

export function markPhaseTutorialSeen(scope: PhaseTutorialScope): void {
  const key = phaseTutorialKey(scope);
  seenPhaseMemory.add(key);
  try { window.localStorage.setItem(key, 'seen'); } catch { /* Once this session; replay remains available. */ }
}

export function readSeenTours(): 'done' | SeenTours {
  try {
    const raw = window.localStorage.getItem(COACH_KEY);
    if (raw === 'done') return 'done';
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(TOUR_PAGES.filter(page => (parsed as Record<string, unknown>)[page] === true).map(page => [page, true]));
  } catch { return {}; }
}

export function tourSeen(page: TourPage): boolean { const seen = readSeenTours(); return seen === 'done' || seen[page] === true; }

export function markTourSeen(page: TourPage): void {
  try { const seen = readSeenTours(); if (seen !== 'done') window.localStorage.setItem(COACH_KEY, JSON.stringify({ ...seen, [page]: true })); } catch { /* Replay also works without storage. */ }
}
