'use client';

/**
 * The learner's project, by name, for copy the web writes itself.
 *
 * Some learner copy is written into the web rather than read from the
 * project: the brief asides' `REQUIREMENTS / …` kicker, the case file's
 * `… / REQUIREMENTS`, the backlog's `… PROJECT` header and the `… / Your
 * learning record` eyebrows. A fixed TASKTRACKR there would tell a class on a
 * teacher's project, from outside its task list, that it was working
 * TaskTrackr. They say the name of the project the learner is on, which,
 * for a TaskTrackr learner, is TaskTrackr.
 *
 * TaskTrackr's *story* (US-4, the overdue report, Dana) is kept out of
 * those surfaces rather than switched on a slug: no learner-facing module
 * names a project (`useProject.test.ts`). Where a surface must tell a
 * teacher's copy from TaskTrackr, it reads the phase's provenance (below).
 * What is **content** (a phase's intro, the interview persona, the provided
 * stories) is the project's own and is not decided here.
 */
import type { EnrollmentView, PhaseDetail, PhaseKey, PhaseProvenanceView, PhaseSummary } from '@learnsdlc/shared';
import { useProjectMaybe } from '@/lib/useProject';
import { projectName } from './project-name';

/**
 * The name of the project the shell is showing (the learner's own or, while
 * a teacher is viewing as a learner, that learner's) or `''` while none is
 * known (the shell still loading, or a surface mounted outside it).
 */
export function useProjectName(): string {
  return projectName(useProjectMaybe()?.enrollment?.projectTitle);
}

/** The same name, set as a kicker is: in capitals, and never empty. */
export function kickerName(name: string): string {
  return (name || 'Your project').toUpperCase();
}

/* ---------------------------------------------------------------------------
 * Whose scenario a phase is.
 *
 * Some scaffolding is only true of the reference project's own story (the
 * story desk's placeholders, its headline, the client-side draft checks
 * copied from the reference rules, the design board's story ids and
 * contradiction rules) and so are the lessons, which teach the reference
 * project. Those follow the phase's provenance:
 *
 * - the room's scaffolding follows the room task (`roomIsReference`): a
 *   reference room task keeps it byte for byte, any other gets neutral copy
 *   and no client checks (the server's report still speaks);
 * - the lessons and the interview hint follow the roll-up: `reference` keeps
 *   them, `own` or `mixed` loses them (except the lessons of an
 *   application phase still running the reference application, see
 *   `lessonsVisibleFor`);
 * - a payload with no provenance is read as the reference only
 *   when the enrolment says its project is the platform default, and as
 *   neutral otherwise. Fail closed: a teacher's project never shows a
 *   reference story it does not hold.
 *
 * The comparison is against the contract's `reference` value, never a
 * project slug, and every name a person reads comes from the
 * payload.
 * ------------------------------------------------------------------------- */

type EnrollmentFacts = Pick<EnrollmentView, 'projectIsDefault'> | null | undefined;

/**
 * Whether this phase is still the reference project's own scenario, from its
 * summary's roll-up, or (for a summary that carries none)
 * from whether the enrolment is on the platform's default project.
 */
export function scenarioIsReference(
  summary: Pick<PhaseSummary, 'scenario'> | null | undefined,
  enrollment: EnrollmentFacts,
): boolean {
  if (summary?.scenario) return summary.scenario === 'reference';
  return enrollment?.projectIsDefault === true;
}

/**
 * The four phases whose files are an application's (the provenance resolver
 * reads `application` on these and on no written phase).
 */
const APPLICATION_PHASES: ReadonlySet<PhaseKey> = new Set<PhaseKey>(['implementation', 'testing', 'deployment', 'maintenance']);

type ProvenanceFacts = Pick<PhaseProvenanceView, 'application' | 'tasks'> | null | undefined;

/**
 * The one predicate for whether the phase's lessons (which teach the
 * reference project's story) are shown, and linked to, for this phase.
 * `/learn/:phase` direct entry asks it too.
 *
 * The lessons are shown where the phase is the reference project's, phases
 * 3-6 included. A roll-up of `reference` keeps them. On one of the
 * four application phases a `mixed` roll-up keeps them too when the phase
 * still runs the reference application and its main task is the
 * reference's: a teacher who added an optional quiz to Implementation has
 * not changed what the lesson teaches. The resolver ties the inherited task
 * of an application phase to the application (`reference` exactly while the
 * application is), so:
 *
 * - with the phase detail's provenance in hand, that is read off it: the
 *   application is named and a task is the reference's;
 * - with the summary alone, `mixed` on an application phase means one of its
 *   elements is still the reference's, and the only ones are the intro and
 *   the application with its task; no authoring door changes an
 *   application's files (`applicationFileRefusal`), so it is read as the
 *   reference application, and a held detail that says otherwise wins.
 *
 * On a written phase (Requirements, Design) `mixed` or `own` always
 * hides the lessons, because its interview, backlog or task can be the
 * teacher's while the lesson tells the reference project's story.
 */
export function lessonsVisibleFor(
  summary: (Pick<PhaseSummary, 'scenario'> & { key?: PhaseKey }) | null | undefined,
  enrollment: EnrollmentFacts,
  provenance?: ProvenanceFacts,
): boolean {
  if (scenarioIsReference(summary, enrollment)) return true;
  if (summary?.scenario !== 'mixed' || !summary.key || !APPLICATION_PHASES.has(summary.key)) return false;
  if (!provenance) return true;
  return Boolean(provenance.application) && provenance.tasks.some((task) => task.provenance === 'reference');
}

/** Why a phase's lesson is not offered, for the sentence `/learn/:phase` answers with. */
export type LessonHiddenReason = 'own' | 'mixed' | 'unknown';

/**
 * The reason `lessonsVisibleFor` said no, so direct entry says something true:
 * a phase the teacher wrote (`own`), a phase they changed in part (`mixed`),
 * or one whose payload says nothing (on a project that is not the default).
 */
export function lessonHiddenReason(summary: Pick<PhaseSummary, 'scenario'> | null | undefined): LessonHiddenReason {
  if (summary?.scenario === 'own') return 'own';
  if (summary?.scenario === 'mixed') return 'mixed';
  return 'unknown';
}

/** The shell's enrolment and the summary of one of its phases, or nulls outside the shell. */
function usePhaseFacts(phaseKey: PhaseKey): {
  /** False when the surface is mounted outside the project provider altogether. */
  inShell: boolean;
  summary: PhaseSummary | null;
  enrollment: EnrollmentView | null;
} {
  const state = useProjectMaybe();
  const enrollment = state?.enrollment ?? null;
  const summary = enrollment?.phases.find((one) => one.key === phaseKey) ?? null;
  return { inShell: state !== null, summary, enrollment };
}

/**
 * Whether the phase's **room** is still the reference project's: its room
 * task's provenance (`PhaseProvenanceView.roomTask`, which decides the story
 * desk copy, the client draft checks and the headlines), and, for a detail that carries
 * no provenance (a detail not yet in hand), the roll-up.
 *
 * A teacher who rewrote only the intro keeps a reference room task: the server
 * still grades that task against the reference rules, so the desk keeps the
 * reference story's words and checks. A teacher's own room task loses them
 * even under a roll-up that still reads `reference`.
 */
export function roomIsReference(
  provenance: Pick<PhaseProvenanceView, 'roomTask'> | null | undefined,
  summary: Pick<PhaseSummary, 'scenario'> | null | undefined,
  enrollment: EnrollmentFacts,
): boolean {
  if (provenance?.roomTask) return provenance.roomTask === 'reference';
  return scenarioIsReference(summary, enrollment);
}

/** The detail the shell holds for one phase key, or null. */
function useHeldDetail(phaseKey: PhaseKey): PhaseDetail | null {
  const state = useProjectMaybe();
  return Object.values(state?.details ?? {}).find((one) => one?.key === phaseKey) ?? null;
}

/**
 * Whether a learner surface of this phase's **room** draws the reference
 * project's own scaffolding: the story desk's words and placeholders, the
 * headline, the client draft checks, the Design board's story ids, rule
 * checks and contradiction rules. Keyed on the room task (`roomIsReference`).
 * Inside the shell with no enrolment yet (still loading) it is false: the
 * neutral copy is true of every project, so nothing flashes. A surface mounted
 * outside the project provider altogether (a component test, a teacher's
 * preview) has no project to ask and keeps its standing copy.
 */
export function useReferenceScaffolding(phaseKey: PhaseKey): boolean {
  const { inShell, summary, enrollment } = usePhaseFacts(phaseKey);
  const detail = useHeldDetail(phaseKey);
  if (!inShell) return true;
  return roomIsReference(detail?.provenance, summary, enrollment);
}

/**
 * Whether the phase as a whole is still the reference project's scenario
 * (the roll-up) for copy about the scenario rather than the room: the
 * interview hint. Outside the project provider it answers as
 * `useReferenceScaffolding` does.
 */
export function useScenarioReference(phaseKey: PhaseKey): boolean {
  const { inShell, summary, enrollment } = usePhaseFacts(phaseKey);
  if (!inShell) return true;
  return scenarioIsReference(summary, enrollment);
}

/**
 * `lessonsVisibleFor` for one phase of the shell's enrolment. Outside the
 * project provider it answers as `useReferenceScaffolding` does.
 */
export function useLessonsVisible(phaseKey: PhaseKey): boolean {
  const { inShell, summary, enrollment } = usePhaseFacts(phaseKey);
  const detail = useHeldDetail(phaseKey);
  if (!inShell) return true;
  return lessonsVisibleFor(summary, enrollment, detail?.provenance);
}

/**
 * The phase's own intro where the teacher wrote it, for the room's brief
 * aside (`PhaseBriefIntro`). The whole intro from the detail the shell holds,
 * else the summary's opening. Null on a reference phase (whose aside keeps its standing
 * words), on an intro still the reference project's, outside the shell, and
 * while nothing is known.
 */
export function usePhaseOwnIntro(phaseKey: PhaseKey): string | null {
  const { inShell, summary, enrollment } = usePhaseFacts(phaseKey);
  const detail = useHeldDetail(phaseKey);
  if (!inShell || !enrollment || !summary) return null;
  if (scenarioIsReference(summary, enrollment)) return null;
  // Only an intro known to be the teacher's: the held detail says so, or the
  // whole phase is theirs. A `mixed` phase can still carry the reference
  // project's intro, whose story words the aside never draws on a teacher's
  // phase, and a summary without a roll-up says nothing at all.
  const own = detail?.provenance ? detail.provenance.intro === 'own' : summary.scenario === 'own';
  if (!own) return null;
  const intro = (detail?.intro ?? summary.intro ?? '').trim();
  return intro || null;
}

/**
 * The guidance a room's own words give where the room is not the reference
 * project's: its objectives, as uploaded and in order, from the
 * detail the shell holds (both of its views carry them). The room's standing
 * guidance ("HTTP contract", "Screen states", "the contract and the request
 * path") states the reference project's deliverables, and a teacher's own
 * room (an uploaded project, or a copy whose room task the teacher rewrote)
 * asks for what its pack says, so those words give way to the pack's.
 *
 * Null where the room is still the reference's (`roomIsReference`: the room
 * task, else the roll-up), outside the shell and while the enrolment is not
 * known: the standing words stay, byte for byte. Empty objectives, a detail
 * not yet held, are an empty list and never the reference's.
 */
export function useOwnRoomGuidance(phaseKey: PhaseKey): { objectives: string[] } | null {
  const { inShell, summary, enrollment } = usePhaseFacts(phaseKey);
  const detail = useHeldDetail(phaseKey);
  if (!inShell || !enrollment || !summary) return null;
  if (roomIsReference(detail?.provenance, summary, enrollment)) return null;
  return { objectives: (detail?.objectives ?? []).map((one) => one.trim()).filter(Boolean) };
}

/* ---------------------------------------------------------------------------
 * Every door to a lesson.
 *
 * The lessons are reached from more than the phase strip: the sidebar and the
 * search's "Learn", the catalogue itself, Home's "Explore lessons" and "Read
 * the optional guide", the feedback page's nudge, the case file's aside and
 * the phase tutorial's last step. Each asks the one predicate above, per
 * phase, through these two readers of an enrolment:
 *
 * - an enrolment in hand answers `lessonsVisibleFor` for the phase's summary
 *   (fail closed: no provenance and no `projectIsDefault: true` is hidden);
 * - no enrolment at all (an account that has not started a project, or a
 *   surface mounted outside the shell) has no project for a lesson to
 *   contradict, and keeps its doors, as `/learn/:phase` direct entry does.
 * ------------------------------------------------------------------------- */

type EnrollmentPhases = (Pick<EnrollmentView, 'projectIsDefault'> & { phases: readonly (Pick<PhaseSummary, 'key' | 'scenario'> & { id?: string })[] }) | null | undefined;

/**
 * The phase details a shell holds, by phase id (`ProjectState.details`).
 * `lessonsVisibleFor` reads a held detail's provenance where there is one.
 */
type HeldDetails = Readonly<Record<string, Pick<PhaseDetail, 'key'> & { provenance?: PhaseProvenanceView } | undefined>> | null | undefined;

function heldProvenance(details: HeldDetails, summary: { id?: string; key: PhaseKey } | null): PhaseProvenanceView | undefined {
  if (!details || !summary) return undefined;
  const byId = summary.id ? details[summary.id] : undefined;
  const held = byId ?? Object.values(details).find((one) => one?.key === summary.key);
  return held?.provenance;
}

/** Whether this enrolment is shown, and linked to, the lesson of one phase. */
export function lessonsOfferedOn(enrollment: EnrollmentPhases, phaseKey: PhaseKey, details?: HeldDetails): boolean {
  if (!enrollment) return true;
  const summary = (enrollment.phases ?? []).find((one) => one.key === phaseKey) ?? null;
  return lessonsVisibleFor(summary, enrollment, heldProvenance(details, summary));
}

/**
 * Whether this enrolment is shown any lesson at all: the "Learn" entry and
 * Home's "Explore lessons" lead to the catalogue, which lists only the phases
 * `lessonsOfferedOn` offers.
 */
export function anyLessonsOffered(enrollment: EnrollmentPhases, details?: HeldDetails): boolean {
  if (!enrollment) return true;
  const phases = enrollment.phases ?? [];
  if (phases.length === 0) return enrollment.projectIsDefault === true;
  return phases.some((one) => lessonsVisibleFor(one, enrollment, heldProvenance(details, one)));
}

/**
 * The bridge notice's application name, for one of the last four phases of a
 * teacher's project: the application the phase runs
 * when it is the reference project's while the project is not. Null on the
 * reference project itself (and on an enrolment that does not say it is not),
 * on a written phase, and on a payload without provenance.
 */
export function bridgeApplication(
  provenance: Pick<PhaseProvenanceView, 'application'> | null | undefined,
  enrollment: (Pick<EnrollmentView, 'projectIsDefault' | 'projectTitle'>) | null | undefined,
): string | null {
  const application = provenance?.application;
  if (!application) return null;
  // Only a project the enrolment says is not the platform default. The title
  // is the teacher's to choose, so it decides nothing ("TaskTrackr — Section
  // 2" is a copy); an enrolment that does not say is read as the default.
  if (enrollment?.projectIsDefault !== false) return null;
  return application;
}

/**
 * The bridge notice on the last four phases of a teacher's project that run
 * the reference application, drawn in the code rooms' brief column
 * (PhaseBriefIntro) and on the case file page (components/phases/Brief.tsx).
 * It says only what is true of every such project, whose code, tests and
 * deployment the phase works in, and not that the project lacks an application
 * of its own, which on a finished project that is itself a copy of the
 * reference would read as something missing.
 */
export function bridgeNotice(application: string): string {
  return `This phase uses ${application}, LearnSDLC's reference application: its code, tests and deployment are ${application}'s.`;
}

/**
 * `bridgeApplication` for one phase of the shell's enrolment, read from the
 * phase detail the shell holds for it. Null outside the shell and while the
 * detail is not in hand.
 */
export function useBridgeApplication(phaseKey: PhaseKey): string | null {
  const enrollment = useProjectMaybe()?.enrollment ?? null;
  const detail = useHeldDetail(phaseKey);
  return bridgeApplication(detail?.provenance, enrollment);
}

/**
 * Whether the phase is known to hold no stakeholder interview: its detail says
 * `stakeholder: null`. Absent (a detail not yet in hand)
 * is not "none", so the door stays. The door's words never change with the
 * stakeholder: it reads "Stakeholder interview" on every project.
 */
export function useInterviewAbsent(phaseId: string | null | undefined): boolean {
  const state = useProjectMaybe();
  if (!phaseId) return false;
  return state?.details?.[phaseId]?.stakeholder === null;
}
