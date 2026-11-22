'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PhaseDetail, PhaseKey } from '@learnsdlc/shared';
import { useSession } from '@/lib/session';
import { useViewAs } from '@/lib/view-as';
import { CoachMarks } from './CoachMarks';
import { replayTour, type PhaseTutorialScope } from './tours';
// Whether the tutorial is open, for the quick-check card.
import { PhaseTutorialOpenContext, usePhaseTutorialOpen } from '@/components/workspace/concept/tutorial-open';

export { usePhaseTutorialOpen };

type ReadyPhase = Pick<PhaseDetail, 'id' | 'key' | 'status' | 'files'> & { view?: string; provenance?: PhaseDetail['provenance']; design?: PhaseDetail['design'] };
/** A ready room, and the provenance (and a Design room's switches) of the phase it fetched. */
type Registered = { scope: string; provenance?: PhaseDetail['provenance']; design?: PhaseDetail['design'] };
type TutorialContext = {
  register: (phase: ReadyPhase) => () => void;
  ready: boolean;
};
const Context = createContext<TutorialContext | null>(null);

/** A ready signal comes from a mounted tool's completed phase GET, never its shell summary. */
export function usePhaseTutorialReady(phase: ReadyPhase | null | undefined): void {
  const register = useContext(Context)?.register;
  const full = Boolean(phase && phase.view !== 'summary' && Array.isArray(phase.files));
  const id = phase?.id, key = phase?.key, status = phase?.status;
  useEffect(() => {
    if (!register || !phase || !full) return;
    return register(phase);
    // File edits do not remount a tutorial or reset its readiness.
  }, [register, full, id, key, status]);
}

export function PhaseTutorialProvider({ phaseId, phaseKey, lessons = true, provenance, movedOn = false, children }: { phaseId: string; phaseKey: PhaseKey; /** Whether the phase offers its lesson. */ lessons?: boolean; /** The held detail's provenance, so the tour skips a control an own application's room does not draw. */ provenance?: PhaseTutorialScope['provenance']; /** The learner has passed this phase and moved on from it: no first-entry tutorial (`PhaseTutorialScope.movedOn`). */ movedOn?: boolean; children: ReactNode }) {
  const user = useSession();
  const viewing = useViewAs();
  const ownerId = user?.role === 'LEARNER' && !viewing ? user.id : '';
  const scope = `${ownerId}:${phaseId}:${phaseKey}`;
  const [mounted, setMounted] = useState<Map<symbol, Registered>>(() => new Map());
  const register = useCallback((phase: ReadyPhase) => {
    if (!ownerId || phase.id !== phaseId || phase.key !== phaseKey || phase.status === 'locked' || phase.view === 'summary') return () => {};
    const mount = Symbol('phase-tutorial-ready');
    setMounted(current => new Map(current).set(mount, { scope, provenance: phase.provenance, design: phase.design }));
    return () => setMounted(current => { const next = new Map(current); next.delete(mount); return next; });
  }, [ownerId, phaseId, phaseKey, scope]);
  const registered = [...mounted.values()].find(one => one.scope === scope);
  const ready = Boolean(ownerId && registered);
  // The tour reads the phase the room registered (its own completed GET)
  // before the shell's held detail, which may not be in the details map yet.
  // CoachMarks fixes its steps when it opens, so a fallback to the enrolment
  // summary would walk an own application through the reference steps.
  const tourProvenance = registered?.provenance ?? provenance;
  const value = useMemo(() => ({ register, ready }), [register, ready]);
  // A context of its own, so a room reading `ready`
  // does not re-render when the tutorial opens or closes.
  const [tutorialOpen, setTutorialOpen] = useState(false);
  return <Context.Provider value={value}>
    <PhaseTutorialOpenContext.Provider value={tutorialOpen}>{children}</PhaseTutorialOpenContext.Provider>
    <CoachMarks key={`${ownerId}:${phaseId}`} phaseTutorial={{ ownerId, phaseId, phaseKey, ready, lessons, provenance: tourProvenance, design: registered?.design, movedOn }} onOpenChange={setTutorialOpen} />
  </Context.Provider>;
}

export function PhaseTutorialReplay() {
  const tutorial = useContext(Context);
  if (!tutorial?.ready) return null;
  return <button type="button" className="phase-tutorial-replay" data-testid="phase-tutorial-replay" onClick={event => {
    // Safari does not focus buttons on a pointer click. Give the modal a real
    // invoking control to restore when the learner chooses Done or Escape.
    event.currentTarget.focus({ preventScroll: true });
    replayTour();
  }}>Replay tutorial</button>;
}
