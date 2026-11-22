import type { PhaseProvenanceView } from '@learnsdlc/shared';

/**
 * Whether a learner room still runs the reference
 * project's application.
 *
 * Rooms 3–6 are built around TaskTrackr, and some of their scaffolding is only true
 * of it: the implementation room's five-task brief, the deployment room's
 * `.github/workflows/ci.yml` pipeline and Compose wording, the maintenance
 * change request (CR-2, contract v2, the 2.1.0 release record). A teacher's own
 * application, an uploaded pack, carries none of that, and a room that drew
 * it would send the learner to files that do not exist.
 *
 * The answer is read from the provenance the phase detail carries
 * (`PhaseProvenanceView.application`): the reference project's name while the
 * phase's files and checks are still the reference application's, and `null`
 * once they are not (the API's resolver, `isReferenceApplicationPhase`). The
 * roll-up is not the question: a teacher's copy whose teacher rewrote the intro rolls
 * up `mixed` and still runs TaskTrackr's application, and keeps every room.
 *
 * A payload without provenance, or a surface handed no detail,
 * and a written phase (no `application` at all) answer `true`: the room
 * renders the reference scaffolding. Only an explicit `null` turns
 * the reference scaffolding off.
 */
export function runsReferenceApplication(
  provenance: Pick<PhaseProvenanceView, 'application'> | null | undefined,
): boolean {
  return provenance?.application !== null;
}
