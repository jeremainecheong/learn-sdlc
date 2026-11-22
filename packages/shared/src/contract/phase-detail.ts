/**
 * A phase as the learner's client and the instructor's console read it:
 * the artefact kinds, workspace files, the rubric, the task grain, the phase
 * summary and detail, the enrolment and the project's metadata.
 */

import type { PhaseProvenanceRollup, PhaseProvenanceView } from '../authoring';
import type { ChangeFloor, ChangeTicket } from '../change-record';
import type { DesignContracts, DesignFloor, DesignStory } from '../design-record';
import type { PhaseKey, PhaseStatus } from '../phases';
import type { ArtefactType } from '../projects';
import type { ProvidedStory, StoryFloor } from '../requirements-story';
import type { RunbookFloor } from '../runbook-record';
import type { DrillState, PhaseLink, ReleaseRecordView, SubmissionView } from './feedback';
import type { PreviewUnsupported } from './preview';
import type { PhaseSolutionMeta } from './solution';

/**
 * What decides a task's verdict. Six kinds: two written (`story`, `design`),
 * three executable (`code`, `tests`, `config`) and `quiz`.
 *
 * `story` and `design` grade a structured record rather than prose: the
 * requirements record (`./requirements-story`) and the design record with its
 * contracts (`./design-record`). `quiz` is scored server-side by set equality
 * against a key sealed in the task's `checks` slice, no regex over a file, no
 * sandbox, no model call, which is why every site that answers for the other
 * kinds answers for it. The type a quiz task carries is `ArtefactType: 'quiz'`,
 * which picks the room; this is what scores it, and the two stay separate facts.
 *
 * No task is graded as `markdown`; only the readers that convert a Requirements
 * or Design written in the older format still read that literal.
 */
export type ArtifactKind = 'story' | 'design' | 'code' | 'tests' | 'config' | 'quiz';

/** A file in a phase workspace. Locked files are shown read-only. */
export interface WorkspaceFile {
  path: string;
  content: string;
  editable: boolean;
  language: string;
  // Two facts the API already knows, so the shell does not have to download
  // the file to derive them. Set only on the
  // summary view of a phase (`PhaseDetail.view === 'summary'`), where `content`
  // is empty; the full view leaves them undefined and the content speaks.
  /** Lines in the file as it stands, learner's edits included. */
  lines?: number;
  /** Editable, non-empty and no longer the stub the phase shipped with. */
  touched?: boolean;
}

export interface RubricCriterion {
  key: string;
  title: string;
  weight: number; // 0..1, weights sum to 1 within a phase
  description: string;
}

export interface PhaseRubric {
  passThreshold: number; // 0..100
  criteria: RubricCriterion[];
}

/* ---------------------------------------------------------------------------
 * The task grain
 *
 * A phase may hold more than one task where its work is written, and every
 * phase of every teacher-authored project holds at least one authored task.
 * These shapes are what a learner's client and an instructor's console read
 * that grain through. They are already shaped per task, so letting coding,
 * testing and deployment phases split would need no change to them.
 * ------------------------------------------------------------------------- */

/**
 * How many of a phase's tasks are done, over all of them and over the required
 * set, so "3 of 4 done, 2 of 2 required" is expressible on a tile.
 *
 * The two are separate because an optional task moves no gate: it is shown,
 * scored and recorded, and `passedRequired === required` is the only half that
 * says whether the phase can open.
 */
export interface PhaseTaskCounts {
  total: number;
  required: number;
  passed: number;
  passedRequired: number;
}

/**
 * One task of a phase, as the learner's client reads it.
 *
 * `evidence` and `sealed` are **derived from the task's graded units, never
 * chosen from a dropdown**, so an authoring surface tells a teacher what kind
 * of proof their task will produce and they strengthen it by adding evidence
 * rather than by picking a stricter word.
 *
 * The four heavy fields at the foot are the **full view only**. The shell holds
 * a summary of every open phase, and a rubric is a list of criteria with titles
 * and weights: carrying them per task per phase is the payload the summaries
 * view exists to keep small. The room fetches the full view it already fetches.
 */
export interface PhaseTaskView {
  key: string;
  order: number;
  required: boolean;
  title: string;
  /** Picks the room this task is worked in. */
  artefactType: ArtefactType;
  /** The single file that room reads, where it reads one. */
  artefactPath?: string;
  primaryPath?: string;
  /** Derived from the units. Never chosen. */
  evidence: 'automated' | 'reviewed' | 'assisted' | 'signed-off';
  /** Whether a pass of this task alone can open the phase. Derived from the units. */
  sealed: boolean;
  status: PhaseStatus;
  awaitingSignOff: boolean;
  attempts: number;
  bestScore: number | null;
  passedAt: string | null;
  lastSubmissionId: string | null;
  resetAt: string | null;
  /** This task's own door, so a room never offers one that is not there. */
  solution: PhaseSolutionMeta;

  /* The full view only. Absent on `PhaseDetail.view === 'summary'`. */
  brief?: string;
  objectives?: string[];
  /** The workspace paths this task owns. */
  files?: string[];
  /** The task's own criteria and weights. */
  rubric?: PhaseRubric;
}

/** One task of a phase, as the instructor console reads it. */
export interface InstructorTaskView {
  key: string;
  order: number;
  required: boolean;
  title: string;
  status: PhaseStatus;
  bestScore: number | null;
  attempts: number;
  passedAt: string | null;
  awaitingSignOff: boolean;
  signedOffAt: string | null;
  /** The newest revision of **this task**, never of the phase. */
  lastSubmission: SubmissionView | null;
  /**
   * Quizzes only: every allowed paper handed in this run, and not passed.
   *
   * The learner cannot draw another, so this task will not move again until
   * this teacher resets it, which returns the attempts by starting a new
   * attempt epoch, keeping every paper already sat in the record. It is the
   * console's half of `QuizRoomView.needsInstructorReset`, computed from the
   * same two facts, so the person who has to act sees the same state as the
   * person waiting.
   *
   * Absent on any task that is not a quiz.
   */
  quizAttemptsSpent?: boolean;
}

export interface PhaseSummary {
  id: string;
  key: PhaseKey;
  order: number;
  title: string;
  status: PhaseStatus;
  bestScore: number | null;
  attempts: number;
  reflection: string | null;
  passedAt: string | null;
  // Optional because this shape has external readers and every one of them
  // must keep reading a payload written without the field.
  /** How far this phase's tasks have got. */
  taskCounts?: PhaseTaskCounts;
  /**
   * `MAX(task_states.updatedAt)` for this phase, or null where the phase has no
   * task rows, which for a project of sole-task phases is every phase.
   *
   * It is not polish: a client decides whether a cached phase detail may be
   * reused by comparing the summary's fields, so a task moving without its
   * phase moving would be invisible and a learner would silently read stale
   * progress.
   */
  tasksUpdatedAt?: string | null;
  // The class's dates for this phase, so every phase
  // renderer (the dashboard tile, the phases card, the stepper, the workspace
  // strip and the instructor's InstructorPhaseView) reads them from the one
  // place. Required and nullable rather than optional: a missing date and an
  // unset date are the same fact, and optional would hide a plumbing mistake.
  /** When this class opens the phase, or null when nothing is scheduled. */
  opensAt: string | null;
  /** When this class's work is due, or null. Late is derived, never stored. */
  dueAt: string | null;
  // The phase's own words, and whose they are, for the surfaces that draw
  // every phase at once.
  /**
   * The roll-up of this phase's provenance (`PhaseProvenanceView.rollup`):
   * `reference` where every element is still the reference project's.
   * A client must render without it.
   */
  scenario?: PhaseProvenanceRollup;
  /**
   * The opening of the phase's intro, at most `PHASE_SUMMARY_INTRO_MAX`
   * characters, because a summary rides every `EnrollmentView`. The whole
   * intro is `PhaseDetail.intro`, which is required there. A client must
   * render without it.
   */
  intro?: string;
}

/** Server-pinned presentation copy from one retained, strict Design Pass. */
export interface AcceptedScreenCopy {
  version: 1;
  sourceSubmissionId: string;
  sourcePhaseStateId: string;
  title: string;
  empty: string;
}

export interface PhaseDetail extends PhaseSummary {
  /** Null means the shipped reference copy, not an accepted learner design. */
  acceptedScreenCopy?: AcceptedScreenCopy | null;
  /**
   * Which project this phase belongs to. A workspace URL can be bookmarked or
   * shared, so the client cannot assume it is the project it last remembered:
   * the phase has to say.
   */
  projectSlug: string;
  intro: string;
  taskPanel: string; // plain text: the teacher's brief
  /** The phase's place in its own project, 1 to n: what the screen calls "Phase 2 of 3". */
  place: number;
  /** How many phases the project holds. */
  count: number;
  /**
   * On a Testing phase only: the prefixes the version's own stories use (its
   * Requirements phase's provided stories' ids, `SH` for `SH-1`), in code-unit
   * order, or `['US']` when the version holds no Requirements stories. The
   * Testing room's criterion harvest offers `<prefix>-n` stories and their
   * `AC-n` criteria from the brief, and no other id-shaped line. Grading
   * never reads it.
   */
  storyPrefixes?: string[];
  /**
   * The learner's story on a phase whose check kind is `story`: its id, the
   * pack's hints, the floor it is graded against, and the stories the pack
   * provides. Absent on every other phase.
   */
  story?: { id: string; hints: { persona?: string; capability?: string; benefit?: string }; floor: StoryFloor; providedStories: ProvidedStory[] };
  /**
   * A Design phase of the `design` kind: which contracts are part of the
   * artefact, whether the sequence diagram is (its tab and its floor rule show
   * only when it is), the stories it must trace to, and the floor it is checked
   * against. Absent on every other phase, and on a Design still in the older format.
   */
  design?: { contracts: DesignContracts; sequence: boolean; stories: DesignStory[]; floor: DesignFloor };
  /**
   * A Deployment of the config kind whose checks carry a runbook: its floor and
   * whether it declares a drill (then the incident is written from the drill
   * page). Absent on every other phase, and on a Deployment still in the older format.
   */
  runbook?: { floor: RunbookFloor; drill: boolean };
  /**
   * A Maintenance of the code kind whose checks carry a change request: the
   * teacher's ticket, the contract switch and the floor. Absent on every other
   * phase, and on a Maintenance still in the older format.
   */
  change?: { ticket: ChangeTicket; contract: boolean; floor: ChangeFloor };
  objectives: string[];
  artifactKind: ArtifactKind;
  files: WorkspaceFile[];
  rubric: PhaseRubric;
  /**
   * This phase's tasks, in order, on **both** views: the shell holds summaries for every
   * open phase and the tile, Home, Progress and Artefacts all draw from that
   * copy. The summary's copy omits the four heavy fields.
   *
   * `rubric` above stays the phase's, for the phase-level score bar and every
   * caller that reads the phase; a room prefers the selected task's.
   */
  tasks?: PhaseTaskView[];
  canRun: boolean;
  runLabel: string;
  lastSubmission: SubmissionView | null;
  /**
   * Last write of any kind to this phase state (ISO). A grading, a drill step,
   * a link, a run clock and an autosave all move it, so it is a row stamp and
   * not a save receipt: `workspaceUpdatedAt` is the one to show a learner.
   */
  updatedAt: string | null;
  /**
   * When the learner's files were last written, to the millisecond, or null
   * for a phase whose workspace has no recorded save. Only `saveWorkspace`
   * sets it, which is what makes it the thing the
   * status bar can honestly call "Saved at".
   */
  workspaceUpdatedAt?: string | null;
  /** Learner-made links (test → criterion). */
  links?: PhaseLink[];
  /** Deployment only: the drill state, null until the learner is paged. */
  drill?: DrillState | null;
  // The learner's run clock for this phase.
  /**
   * What the sandbox will call "today" when this phase runs: an ISO date, or
   * null for the machine's clock. Testing only: a suite about overdue work
   * is only reproducible if the day it runs on is a decision rather than an
   * accident.
   */
  runClock?: string | null;
  // The live preview.
  /**
   * Whether this phase can start the learner's own application. The pack's own
   * `canPreview`, and false for every phase of a pack that declares no preview
   * block, so the tab is absent rather than present and refusing.
   */
  canPreview?: boolean;
  /**
   * Why this deployment cannot preview at all, or null when it can. It is on
   * the phase rather than on a settings route because the tab has to say
   * something the moment it is drawn, and a second request would draw an empty
   * panel first. See PreviewUnsupported.
   */
  previewUnsupported?: PreviewUnsupported;
  // Which of the two views this is.
  /**
   * `summary` is what `GET /phases/:id?view=summary` answers and what the shell
   * holds for every open phase: no `taskPanel`, and `files` is an index, every
   * path, with `lines` and `touched`, and `content` empty. `full` (the default,
   * and what an absent value means) is the whole
   * workspace, which is what the IDE, the dossier and the repo export read.
   *
   * A reader that needs file bodies must check this rather than trusting an
   * empty string: the shell's copy is a summary, and only `GET /phases/:id`
   * with no view answers with the bodies.
   */
  view?: 'summary' | 'full';
  // The door to the pack's reference answer.
  /**
   * Whether this phase has a reference answer behind its gate, how many files
   * it answers, and when this learner first read it. Optional: a phase detail
   * without it draws no door, which is the right behaviour. Carried on both views: it is three
   * fields, and the phases card needs it without the workspace's files.
   */
  solution?: PhaseSolutionMeta;
  // What `advance` will say.
  /**
   * The required tasks of this phase whose pass the strict-evidence gate would
   * not accept yet, in task order, present **only** on a `passed` phase the
   * learner is standing on (not past, project not complete) when
   * `POST /phases/:id/advance` would refuse it with *"Submit this phase for a
   * strict evidence review before advancing"*, or, on the project's last
   * phase, with *"Course completion requires a strict, evidenced Pass in every
   * phase"*, whose gaps name the earlier phase they are in (`phaseId`). Absent
   * means Continue will be accepted.
   *
   * It is reached by a teacher's Sign off or phase-wide Pass: both write the
   * board, the task row, then the phase row, read `passed`, without a
   * revision behind it, and a countersignature is the second half of a pass,
   * never the first. The gate still wants a sealed, strictly reviewed revision
   * of each task named here, so the room offers that task's Submit instead of
   * Continue. It is the gate's own predicate (`requiredTasksWithoutEvidence`),
   * not a second reading of it.
   *
   * On a phase with one task the key is `''` and the title is the phase's.
   *
   * Also present beside `notReachedYet`,
   * on a `passed` phase AHEAD of the learner, naming what the same gate will
   * still want of that phase once they reach it, a teacher's board-only Pass,
   * so no room promises a Continue that reaching it will not open. Absent
   * there when the learner's own reviewed pass is in. Never the completion
   * arm's gaps on an ahead phase.
   */
  evidenceNeeded?: PhaseEvidenceGap[];
  // A pass ahead of the learner.
  /**
   * Present, and true, only on a phase that reads `passed` while the learner
   * still stands on an EARLIER phase and the project is not complete: what a
   * teacher's Unlock early and Pass leave behind. `POST /phases/:id/advance`
   * refuses it until the learner reaches it, so no room offers Continue there.
   * Absent everywhere else.
   */
  notReachedYet?: true;
  // Whose this phase is, and who the learner interviews.
  /**
   * What in this phase is still the reference project's, per element, from
   * the version the enrolment is pinned to: never from the learner's
   * accepted screen copy laid over it. A learner surface draws a
   * reference project's scaffolding only where this says `reference`. A client
   * must render without it.
   */
  provenance?: PhaseProvenanceView;
  /**
   * The stakeholder this phase's interview is with, from the pinned version's
   * own content: a name and a role, never a fact. Null on a phase with no
   * interview; a client must render without it.
   */
  stakeholder?: { name: string; role: string } | null;
}

/** One required task the strict-evidence gate would refuse (`PhaseDetail.evidenceNeeded`). */
export interface PhaseEvidenceGap {
  /** The task's key; `''` on a phase with one task, or for a whole phase that needs a pass. */
  key: string;
  /** The task's learner-visible title; the phase's own on a phase with one task. */
  title: string;
  // The two gaps a Submit door cannot close.
  /**
   * A quiz whose every allowed paper of this run is handed in and marked, none
   * of them a pass the gate accepts. The learner cannot draw another paper, so
   * the way out is a teacher's Reset of that quiz, not a Submit. Reached when a
   * teacher signs off a quiz the learner has run out of papers on, or the
   * learner spends the rest after a sign-off. Absent otherwise.
   */
  noPapersLeft?: true;
  /**
   * Set only on a project's last phase, for a gap in an EARLIER phase that
   * project completion checks again (`advance`'s completion arm): that phase's
   * state id, key and title. `key` and `title` are then that phase's task, or
   * the phase itself where `key` is `''`. Absent for a gap in the phase the
   * field is on.
   */
  phaseId?: string;
  phaseKey?: PhaseKey;
  phaseTitle?: string;
}

export interface EnrollmentView {
  id: string;
  projectSlug: string;
  projectTitle: string;
  currentPhaseOrder: number;
  completed: boolean;
  startedAt: string;
  completedAt: string | null;
  phases: PhaseSummary[];
  /** One record per merged phase, oldest first. */
  releases?: ReleaseRecordView[];
  // The pack version this enrolment is on. Every instructor export carries
  // it too; the learner's own dossier reads it here, so it can print the
  // version rather than "Not recorded" over a complete project.
  packVersion?: string | null;
  // The pin.
  /**
   * The published project version this enrolment is on, by id. `packVersion`
   * above is the version *string* the enrolment was stamped with and is what
   * the regrade tooling reads; this is the row the runtime resolves content
   * from, so a published version staying immutable means a content change
   * never alters an attempt in flight.
   *
   * Null on an enrolment with no recorded pin, in which case the server falls
   * back to the project's newest published version; a client must also read
   * it absent.
   */
  projectVersionId?: string | null;
  // Whether this is the platform's default project.
  /**
   * True when the enrolment's project is the platform default: read from the
   * project row's `isDefault` on the server, never from a slug. A client reads
   * absent as false wherever it gates the reference project's own material
   * (the lessons), so a payload without it never shows them on a teacher's
   * project.
   */
  projectIsDefault?: boolean;
}

export interface ProjectMeta {
  slug: string;
  title: string;
  tagline: string;
  description: string;
  language: string;
  phaseTitles: { key: PhaseKey; order: number; title: string }[];
  /** Whether this pack ships a warm-up. */
  hasWarmup: boolean;
  /**
   * Present, and `true`, only on an entry of a
   * learner's own catalogue (`GET /projects` for a LEARNER): a project they
   * started that is **set aside because their class works another project**.
   *
   * The class's project is then the catalogue's first entry, and it is the one
   * `POST /enrollments` starts. This entry stays in the learner's record,
   * never deleted, its pin never moved, and every route that names it with
   * `?project=<slug>` still answers it (board, summaries, records, dossier,
   * export). Absent on every other entry, on every staff listing, and on a
   * project set aside because the learner left the class that was given it.
   */
  setAside?: true;
}
