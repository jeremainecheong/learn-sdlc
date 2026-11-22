import type { ArtifactKind, PhaseDetail, PhaseKey, PhaseProvenanceView, PhaseSummary, PhaseTaskView } from '@learnsdlc/shared';
import { PHASE_ROOM_ARTEFACT_PATHS } from '@learnsdlc/shared';
import { DESIGN_JSON } from '@/components/workspace/panels/design/model';
import { runsReferenceApplication } from '@/components/workspace/application';

/**
 * Where a phase opens.
 *
 * Every phase has one door, {@link phaseDoorHref}, and it opens the phase's
 * room in one step, first visit or return: the interview, the design board,
 * the IDE or the change request, never a case file page in front of the room
 * as a second entrance. What the case file says, the mission, what the phase
 * produces and how it is judged, is read in the room's brief panel under
 * "Mission and review criteria"; the case file page itself ({@link briefHref})
 * stays for the rooms' Brief links and saved addresses. A locked phase has no
 * door and goes to the list instead, where the reason it is locked is written
 * down.
 *
 * Links that open a FILE or a specific document (`?file=`, `?tab=`, the pull
 * request, the kill matrix, the drill, the reference solution) are not doors
 * and stay as they are.
 *
 * **Quizzes.** {@link roomHref} and {@link phaseDocHref} choose a room by
 * phase key and by nothing else, and a quiz is a task that has a room of its
 * own while sharing a phase with another task. So the door also reads the
 * phase's task list: see {@link phaseWorkHref}. A phase whose caller passes no
 * tasks, and a phase whose tasks hold no quiz, produce the phase-key href, for
 * every key: requirements, design, implementation, testing, deployment and
 * maintenance. The rooms are chosen by the key, never by the phase's order,
 * which is only its place in its own project.
 *
 * Which callers pass one is {@link doorWithTasks}, and the list there names
 * the ones that do not.
 */

/**
 * The fields a door needs. `attempts` is the count of submissions in the phase.
 *
 * `tasks` is the phase's task list where the caller has one (`PhaseDetail`
 * carries it, `PhaseSummary` does not) and is what lets the door answer for a
 * quiz. It is optional because every caller that reads a bare summary must
 * still get the phase-key answer.
 */
export type PhaseDoor = Pick<PhaseSummary, 'id' | 'key' | 'status'> &
  Partial<Pick<PhaseSummary, 'attempts'>> & { tasks?: readonly PhaseTaskView[] } & HeldApplication;

/**
 * The held detail's provenance, check kind and change request, where the
 * caller has them: what `opensChangeRoom` reads.
 */
type HeldApplication = {
  provenance?: (Pick<PhaseProvenanceView, 'application'> & Partial<Pick<PhaseProvenanceView, 'interview'>>) | null;
  artifactKind?: ArtifactKind;
  change?: PhaseDetail['change'];
};

/**
 * Whether a Maintenance opens the change room (`/change`) rather than the
 * workspace.
 *
 * A Maintenance of another kind than code has no change request: the
 * workspace. A code Maintenance whose detail carries the teacher's change
 * request (`PhaseDetail.change`) opens the change room, a teacher's own
 * application included. A code Maintenance without one opens the change room
 * while it runs the reference application, the
 * workspace for a teacher's own application, read from the held provenance by
 * the predicate the rooms use (`runsReferenceApplication`). A caller holding a
 * bare summary has none of the three, reads code and the reference
 * application, and keeps `/change`, whose page redirects a phase that is not
 * its own.
 */
export function opensChangeRoom(phase: HeldApplication): boolean {
  if ((phase.artifactKind ?? 'code') !== 'code') return false;
  return phase.change !== undefined || runsReferenceApplication(phase.provenance);
}

/**
 * Whether the held detail's provenance says the phase holds
 * no stakeholder interview (`PhaseProvenanceView.interview` is null exactly
 * there). A bare summary, an older payload, or a provenance that does not say
 * is not "none", so its door stays the phase-key room.
 */
export function heldNoInterview(phase: HeldApplication): boolean {
  return Boolean(phase.provenance) && phase.provenance!.interview === null;
}

/**
 * The room a phase is worked in: Requirements its interview, Design its board,
 * the three build phases the IDE, a Maintenance its change request where
 * `opensChangeRoom` says so and the IDE otherwise.
 * A Requirements phase whose held detail holds no interview
 * opens its room, whose backlog is then its only pane.
 */
export function roomHref(phase: Pick<PhaseSummary, 'id' | 'key' | 'status'> & HeldApplication): string {
  if (phase.status === 'locked') return '/phases';
  const base = `/workspace/${phase.id}`;
  switch (phase.key) {
    case 'requirements':
      return heldNoInterview(phase) ? base : `${base}/interview`;
    case 'design':
      return `${base}/design`;
    case 'maintenance':
      return opensChangeRoom(phase) ? `${base}/change` : base;
    default:
      return base;
  }
}

/**
 * The artefact each special room is built around.
 *
 * Four rooms are built around one record: the backlog writes the story, the
 * design board writes the design record, the Runbook tab writes the runbook
 * and the change room writes the change request. Each works out which task it
 * is by asking `taskForPath(tasks, <its artefact>)`. A panel drawn in one room
 * has to ask the same question about a sibling task, or every row that leads
 * somewhere else is a statement and a sibling task has no door at all.
 *
 * The four paths are lifted here so the question can be asked from outside.
 * The phases with no entry, implementation and testing, have no room built
 * around one record: their work is done in the workspace, which is where every
 * non-quiz task of theirs already resolves.
 */
export const PHASE_ROOM_ARTEFACT: Partial<Record<PhaseKey, string>> = {
  // The shared list's path, which the API's reviewer scoping reads too; the
  // two must stay one list (room-artefact-parity.test.ts).
  requirements: PHASE_ROOM_ARTEFACT_PATHS.requirements,
  design: DESIGN_JSON,
  deployment: PHASE_ROOM_ARTEFACT_PATHS.deployment,
  maintenance: PHASE_ROOM_ARTEFACT_PATHS.maintenance,
};

/**
 * A quiz task's room.
 *
 * The task key rides as a query rather than as a path segment for the reason
 * `?file=` and `?tab=` do: it names *which* of a room's subjects is open, and
 * the room without it is still a room: it opens the phase's first quiz.
 */
export function quizHref(phase: Pick<PhaseSummary, 'id'>, taskKey?: string): string {
  const base = `/workspace/${phase.id}/quiz`;
  return taskKey ? `${base}?task=${encodeURIComponent(taskKey)}` : base;
}

/**
 * The room the phase's work is in: its own, or a quiz when a quiz is the only
 * thing left to pass.
 *
 * The narrow condition is deliberate, and it is a different question from
 * `chooseTask`'s *where is the work*, which this must not become a second copy
 * of. A phase holding a quiz still holds a required task of another kind
 * (`phase-needs-a-required-artefact-task`), and that task's room is where a
 * learner writes, runs and submits; sending them to the paper while the
 * artefact is still open would take them away from the work the phase is
 * about. Only once everything else has passed is the quiz the whole of what is
 * left, and then the door that says so saves a learner a hop through a room
 * they have finished with.
 *
 * A caller that passes no tasks, and a phase whose tasks hold no quiz, get
 * {@link roomHref} unchanged.
 */
export function phaseWorkHref(phase: PhaseDoor): string {
  if (phase.status === 'locked') return '/phases';
  const left = (phase.tasks ?? []).filter((task) => task.status !== 'passed');
  const only = left.length === 1 ? left[0] : undefined;
  return only?.artefactType === 'quiz' ? quizHref(phase, only.key) : roomHref(phase);
}

/**
 * The same phase, with the task list its caller already holds.
 *
 * A door can only answer for a quiz when it is given the phase's tasks, and
 * the live boards read `PhaseSummary[]`, which has none. What they do hold is
 * `useProject`'s `details`: one `PhaseDetail` per open phase, already
 * fetched, and carrying `tasks` on the summary view as much as on the full
 * one. So every caller with that map in hand can answer without a request,
 * and this is the one expression that joins the two, written once so that the
 * six call sites cannot drift into six spellings.
 *
 * A phase that already carries its own tasks keeps them, and **that is why two
 * callers are not on the list below**: the workspace layout resolves its phase
 * from `details` first, and the recorded-run page is handed a whole
 * `PhaseDetail` by `api.phase`. Both can already answer, so neither needs
 * this.
 *
 * It is generic so that the caller's own type survives the join. Home's rows
 * and the journal's need the phase's title and key after the door has been
 * asked for, and a helper that narrowed every caller to `PhaseDoor` would have
 * made them hold two objects for one phase.
 *
 * Three callers hold **no** such map, and each is a door whose quiz arm
 * cannot fire, so nothing is lost:
 * `PhaseGateBanner` pushes the phase an advance just opened and `useProject`
 * pushes the first phase of a fresh enrolment (neither has a submission, so
 * nothing is passed and the quiz arm cannot fire) and `Releases` is
 * handed an `EnrollmentView` alone, with no page in the product mounting it.
 */
export function doorWithTasks<P extends PhaseDoor>(
  phase: P,
  details: Record<string, ({ tasks?: readonly PhaseTaskView[] } & HeldApplication) | undefined> | undefined,
): P & { tasks?: readonly PhaseTaskView[] } & HeldApplication {
  // The held detail's provenance, check kind and change request ride along, so
  // the maintenance door opens the room `opensChangeRoom` names (HeldApplication).
  const provenance = phase.provenance !== undefined ? phase.provenance : details?.[phase.id]?.provenance;
  const artifactKind = phase.artifactKind ?? details?.[phase.id]?.artifactKind;
  const change = phase.change ?? details?.[phase.id]?.change;
  return {
    ...phase, tasks: phase.tasks ?? details?.[phase.id]?.tasks,
    ...(provenance !== undefined ? { provenance } : {}), ...(artifactKind !== undefined ? { artifactKind } : {}),
    ...(change !== undefined ? { change } : {}),
  };
}

/**
 * The case file page: the mission, what the phase produces and the review
 * criteria on one page, with a way into the workspace. No door opens it; the
 * rooms' Brief links and old addresses do.
 */
export function briefHref(phase: Pick<PhaseSummary, 'id'>): string {
  return `/workspace/${phase.id}/brief`;
}

/**
 * The door: the phase's room, or the quiz where the quiz is all that is left;
 * the list for a locked phase. The same answer on a first visit, a return
 * visit, in a new tab and after a pass: nothing before the room.
 */
export function phaseDoorHref(phase: PhaseDoor): string {
  return phaseWorkHref(phase);
}

/**
 * Where a phase opens. The door, by another name: the sidebar's phase rows,
 * Home's strip and the phases page all read this, and they all follow the
 * one-door rule.
 */
export function phaseHref(phase: PhaseDoor): string {
  return phaseDoorHref(phase);
}

/** The document page that sits behind a phase's IDE, for the strip's back link. */
export function phaseDocHref(phase: Pick<PhaseSummary, 'id' | 'key'> & HeldApplication): string {
  const base = `/workspace/${phase.id}`;
  switch (phase.key) {
    case 'requirements':
      return `${base}/issue`;
    case 'design':
      return `${base}/design`;
    case 'implementation':
      return `${base}/pr`;
    case 'testing':
      return `${base}/matrix`;
    case 'deployment':
      return `${base}/drill`;
    default:
      // Maintenance.
      return opensChangeRoom(phase) ? `${base}/change` : base;
  }
}

/** What the strip's secondary link says for each phase. */
export function phaseDocLabel(phase: Pick<PhaseSummary, 'key'>): string {
  switch (phase.key) {
    case 'requirements':
      return 'Open the backlog';
    case 'design':
      return 'Open the design';
    case 'implementation':
      return 'Open the pull request';
    case 'testing':
      return 'Open Planted bugs';
    case 'deployment':
      return 'Open the incident drill';
    default:
      // Maintenance.
      return 'Open the change request';
  }
}

/**
 * Where a phase's reference answer opens.
 *
 * A room of its own rather than a tab on the document, because it is a
 * different act with a different record: opening it is stamped and audited, and
 * a URL you can be sent back to is a URL an appeal can name.
 */
export function solutionHref(phase: Pick<PhaseSummary, 'id'>): string {
  return `/workspace/${phase.id}/solution`;
}
