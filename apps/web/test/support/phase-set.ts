import { ADDABLE_PHASES, PHASE_ORDER, addByUploadRefusal, type DraftPhaseSetView, type PhaseKey } from '@learnsdlc/shared';

/**
 * The Phases card rows the API answers on a draft view (`phaseSetOf` in
 * `apps/api/src/authoring/authoring-bodies.ts`), for a version that holds
 * `held` and was forked from a source holding the same phases. Every draft
 * view the API sends carries them.
 */
export function phaseSetFor(held: readonly PhaseKey[], editable: boolean): DraftPhaseSetView[] {
  return PHASE_ORDER.map((key): DraftPhaseSetView => {
    if (held.includes(key)) {
      return { key, state: 'held', removeSource: 'held', canRemove: editable && held.length > 1, canPutBack: false, canAdd: false, why: null };
    }
    const addable = ADDABLE_PHASES.includes(key);
    return { key, state: 'absent', canRemove: false, canPutBack: false, canAdd: editable && addable, why: addable ? null : addByUploadRefusal(key) };
  });
}
