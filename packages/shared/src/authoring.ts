/**
 * The authoring contract for teacher-authored projects.
 *
 * Every project lives in the database: rows are the editable truth and
 * `project_versions.compiled` is what the runtime reads. This file holds the
 * shapes, routes and sentences a **teacher** meets when
 * they make a project of their own, split a phase, validate it, publish it and
 * hand it to a class.
 *
 * Three properties are worth reading before the declarations.
 *
 * **It is append-only and it reuses `./projects`.** The closed sets a project's
 * rows are written from, the origins, the version statuses, the file roles and
 * the two byte rules that read them, the sole task's key, the eight artefact
 * types, are declared once, in `./projects`, and are imported here rather than
 * restated. A closed set with two copies is not closed. What this file adds is
 * the vocabulary that only an authoring surface needs: the doors, the payloads,
 * the refusals and the derivations.
 *
 * **A phase publishes one task.** A draft may hold any number of tasks in any
 * phase, but a **publish** carries one non-quiz task per phase, with concept
 * quizzes beside it. `publishableTasksPerPhase` is the only place that number
 * lives; every refusal, every validation row and every piece of copy derives
 * from it.
 *
 * **Sealed bytes never leave through here.** `AUTHORING_READABLE_FILE_ROLES` is
 * derived from the role sets rather than listed, and it is the whole answer to
 * "which rows may an authoring response carry content for": a file tree shows
 * every row's path, role and size, and the bytes of a hidden suite, a solution,
 * a mutant, a drill, an interview brief, sealed support material and the
 * finished canonical application are not among them.
 */

import type { Role } from './contract/accounts';
import type { ArtifactKind, PhaseRubric } from './contract/phase-detail';
// The practice-quiz reveal setting is on both quiz shapes below.
import type { QuizOption, QuizQuestion, QuizRevealExplanation } from './contract/quizzes';
import type { PhaseKey } from './phases';
import type { ArtefactType, ProjectFileOwnerKind, ProjectFileRole, ProjectOrigin, ProjectVersionStatus } from './projects';
import {
  PROJECT_FILE_ROLES,
  isSealedFileRole,
} from './projects';
// The executable task's view and edit, carried by the draft row and the task
// save below.
import type { ExecutableTaskView, UpdateExecutableTaskBody } from './upload-contract';
import type { LearnerStorySpec, ProvidedStory, StoryChecksSpec, StoryFloor } from './requirements-story';
import type { DesignChecksSpec, DesignContracts, DesignFloor, DesignStory } from './design-record';
import { RUNBOOK_JSON, type RunbookChecks, type RunbookFloor } from './runbook-record';
import { CHANGE_CAPS, type ChangeFloor, type ChangeTicket } from './change-record';
import type { RemoveSource } from './phase-subset';

/* ---------------------------- the safety gate ----------------------------- */

/**
 * The one sentence that says several tasks are not yet served in an executed
 * phase. Never reworded in a caller.
 *
 * Every phase holds one graded task, beside any concept quizzes. Everything whose
 * evidence is executed stays one task per phase for a second reason: the sandbox jobs, the mutant
 * wave and the smoke run are priced, ordered and scored per phase, not per
 * task. Both refusals a teacher can meet, the validation row and the
 * compiler's own, are built out of this string, so there is one sentence to
 * change if that wall comes down.
 */
export const EXECUTABLE_SPLIT_NOT_READY =
  'Several tasks in a coding, testing or deployment phase arrive next.';

/**
 * What a teacher calls the grader of each executable kind, in the refusal.
 *
 * It excludes `quiz`, `story` and `design`. A `Record`
 * over an exhaustive key type is the reason this line errors the moment
 * `ArtifactKind` gains a member, and the honest answer here is not another
 * label: a quiz is not a grader a teacher is offered a word for, and a story
 * and a design record are written work. The excluded
 * kinds are the kinds whose evidence costs no microVM, which is the same set
 * `splittableCheckKind` answers for.
 */
const EXECUTABLE_GRADER_LABEL: Record<Exclude<ArtifactKind, 'story' | 'design' | 'quiz'>, string> = {
  code: 'code',
  tests: 'test',
  config: 'deployment',
};

/**
 * Whether a **task** of this kind may sit in a phase that holds several.
 *
 * The executable wall (`tasks-in-a-phase-share-one-kind`) is two refusals, and
 * only the second is about a task. Its stated reason is narrow and right, *the
 * sandbox jobs, the mutant wave and the smoke run are priced, ordered and
 * scored per phase*, so what belongs on the written side of it is every kind
 * whose evidence costs no microVM. A quiz runs no sandbox job at all: it adds
 * nothing to `sandboxBudgetFor`, because its graded units are all `question`.
 *
 * It is deliberately **not** read by `publishableTasksPerPhase`, which is
 * kind-only, cannot see a task list, and is called with the **phase's** kind at
 * both of its call sites. Widening that would admit a phase whose own
 * `checks.kind` is `quiz` holding many tasks, which is the shape
 * `phase-needs-a-required-artefact-task` wants refused. One predicate, one call
 * site in the compiler, and `multiTaskPublishRefusal` below, which asks the
 * same question about a sentence.
 *
 * It is a **type predicate** rather than a `boolean` so that the complement is
 * a type: `!splittableCheckKind(kind)` narrows to exactly
 * `Exclude<ArtifactKind, 'story' | 'design' | 'quiz'>`, which is
 * `EXECUTABLE_GRADER_LABEL`'s key type. The two therefore cannot drift: a
 * new kind added on the written side of this predicate and forgotten in that
 * `Record` does not compile.
 */
export function splittableCheckKind(kind: ArtifactKind): kind is 'story' | 'design' | 'quiz' {
  return kind === 'story' || kind === 'design' || kind === 'quiz';
}

/**
 * How many tasks a phase of this kind may hold and still publish: 1 for every
 * kind, counting non-quiz tasks. A phase's work is its one record, executable
 * task or quiz, and concept quizzes sit beside it. A draft may hold more;
 * validation says why publish would refuse it (`multiTaskPublishRefusal`).
 */
export function publishableTasksPerPhase(_checkKind?: ArtifactKind): number {
  return 1;
}

/** Whether publish must refuse a phase of this kind holding this many tasks. */
export function refusesMultiTaskPublish(taskCount: number, checkKind?: ArtifactKind): boolean {
  return taskCount > publishableTasksPerPhase(checkKind);
}

/** The validation check id the gate reports under. Add ids, never rename them. */
export const MULTI_TASK_CHECK_ID = 'phase-holds-one-task';

/** The validation check id the "at least one required task" rule reports under. */
export const REQUIRED_TASK_CHECK_ID = 'required-task-per-phase';

/** The validation check id the artefact-path uniqueness rule reports under. */
export const ARTEFACT_PATH_CHECK_ID = 'artefact-paths-unique';

/** The validation check id the supported-stack rule reports under. */
export const SUPPORTED_STACK_CHECK_ID = 'runtime-is-supported';

/* --------------------------- what a teacher writes ------------------------ */

/**
 * The artefact types a teacher may write in the written builders.
 *
 * The story record, the design record and the concept quiz: each costs no
 * microVM. `code`, `tests`, `api-contract`, `runbook` and `change-request`
 * arrive with the project a teacher copies and are edited in their own builders
 * (or are read-only, with `INHERITED_TASK_NOTICE` beside them). None of the three
 * mints an artefact path: a record is written through its room, and a quiz writes
 * no workspace file at all.
 */
export const AUTHORABLE_ARTEFACT_TYPES: ArtefactType[] = ['user-story', 'design-doc', 'quiz'];

/**
 * Whether a task is one a teacher may write and edit here.
 *
 * **The check kind decides first.** A task whose artefact type looks like prose
 * can still be scored by another grader, so both questions are asked, and that
 * is what keeps the editor's read-only state honest. Three pairs answer yes:
 * `('story', 'user-story')` (the story floor reads the requirements record),
 * `('design', 'design-doc')` (the design floor reads the record and the
 * contracts the task switches on) and `('quiz', 'quiz')`.
 *
 * The two `'markdown'` pairs, `('markdown', 'user-story')` and
 * `('markdown', 'design-doc')`, are legacy readers: the markdown kind is gone,
 * and they are kept so the builder's first save still converts an older
 * Requirements or Design draft the boot pass refused. No other `'markdown'`
 * pair is authorable.
 */
export function isAuthorableTask(checkKind: ArtifactKind | 'markdown', artefactType: ArtefactType): boolean {
  if (artefactType === 'quiz') return checkKind === 'quiz';
  if (checkKind === 'story' || checkKind === 'markdown') return artefactType === 'user-story' || (checkKind === 'markdown' && artefactType === 'design-doc');
  if (checkKind === 'design') return artefactType === 'design-doc';
  return false;
}

// The executable editor's own predicate, beside `isAuthorableTask` rather than
// inside it.

/**
 * The artefact types whose **one work task per executable phase** a teacher
 * may edit: a code task (starter, visible tests, hidden suite,
 * reference solution) and a tests task (the same, plus mutants, `minTests` and
 * coverage keywords).
 *
 * It is a second list and not two more entries in `AUTHORABLE_ARTEFACT_TYPES`,
 * because that list means "written from scratch at no microVM cost", the
 * learner room reads it and four invariants pin it, and an executable task is
 * neither. `config` (deployment) is absent: its smoke and drill are uploadable
 * and never edited here.
 */
export const EXECUTABLE_AUTHORABLE_ARTEFACT_TYPES: ArtefactType[] = ['code', 'tests'];
// Frozen at runtime too: the editor's gate is not a list any code may widen.
Object.freeze(EXECUTABLE_AUTHORABLE_ARTEFACT_TYPES);

/**
 * Whether the executable editor may open this task: exactly a code task graded
 * by the code grader, or a tests task graded by the test grader. Any other
 * pair, a changelog scored as code, a code task scored as tests, answers
 * false, and `isAuthorableTask` still answers for every written task.
 */
export function isAuthorableExecutableTask(checkKind: ArtifactKind, artefactType: ArtefactType): boolean {
  return EXECUTABLE_AUTHORABLE_ARTEFACT_TYPES.includes(artefactType) && (checkKind as string) === artefactType;
}

/**
 * The Notice beside a task that came with the copied project.
 *
 * It says what is true of the row, the task is graded as it came, and it has
 * no Edit or Remove, rather than promising a later feature.
 */
export const INHERITED_TASK_NOTICE =
  'Inherited from the project you copied. It is graded as it came, and it cannot be edited or removed here.';

/**
 * The key a phase's inherited sole task is **materialised** under when a
 * project is created by copying one.
 *
 * A phase declaring no tasks compiles to exactly one, keyed `SOLE_TASK_KEY`,
 * which is the empty string: the platform's own convention for a synthesised
 * sole unit, and a key that can never be a URL segment. An authoring surface
 * has to address every task it shows, so the copy writes the sole task out as a
 * real `project_tasks` row keyed `main` and the editor addresses it like any
 * other. That is safe precisely because it happens on a copy: the new project
 * has no learners, so no state has to follow a key that changed.
 *
 * The materialised row keeps the compiled sole task's own `artefactPath`
 * (the Requirements story record, the Design record and their siblings)
 * rather than a new one, because the workspace file is already there and the
 * room already reads it.
 */
export const INHERITED_TASK_KEY = 'main';

/* ------------------------------ the seal ---------------------------------- */

/**
 * Whether an authoring response may carry this row's **bytes**.
 *
 * Derived rather than listed, so that widening a role set cannot silently widen
 * this. Two roles pass: `workspace`, which is what a workspace is, and
 * `warmup`, a pack's warm-up, which is written for a learner to read. Every
 * sealed role fails, and so does `canonical`: it is not in the sealed set,
 * because a phase may legitimately mount it as a **locked** workspace row, and
 * it is still 484 KB of finished application whose bytes an authoring endpoint
 * has no business handing back.
 */
export function isAuthoringReadableRole(role: ProjectFileRole): boolean {
  return !isSealedFileRole(role) && role !== 'canonical';
}

/** The roles an authoring response may carry bytes for, in role order. */
export const AUTHORING_READABLE_FILE_ROLES: ProjectFileRole[] =
  PROJECT_FILE_ROLES.filter((role) => isAuthoringReadableRole(role));

/** The sentence a file tree renders beside a row whose bytes are withheld. */
export const SEALED_FILE_NOTICE =
  'This file grades learners. You can remove it from this project; you cannot turn it into a file a learner reads.';

/** The sentence a file tree renders beside the finished application. */
export const CANONICAL_FILE_NOTICE =
  'This is the finished application. You can mount it read-only in a later phase, as the course already does; you cannot make it a file a learner edits.';

/* ------------------------------ the task key ------------------------------- */

/** The sentence a bad task key is refused with. */
export const TASK_KEY_INVALID =
  "A task key is lower case, opens on a letter and is at most 32 characters, so that a learner's work follows the task across versions rather than its position.";

/* --------------------------- the refusal sentences ------------------------ */

/** What this deployment's runner bakes, said once, in the editor and in the refusal. */
export const SUPPORTED_STACKS_SENTENCE =
  'This deployment runs Flask and React. Adding a library is a platform change, not a content change.';

/** Which allow-list in the baked runtime manifest a package was measured against. */
export type RuntimeEcosystem = 'python' | 'node' | 'tools';

const ECOSYSTEM_LABEL: Record<RuntimeEcosystem, string> = {
  python: 'Python',
  node: 'Node',
  tools: 'tool',
};

/**
 * Publish refuses a `runtime` block naming anything outside the baked manifest's
 * three allow-lists (`apps/api/runner/runtime_manifest.py`'s `ALLOWED_PYTHON`,
 * `ALLOWED_NODE` and `ALLOWED_TOOLS`). A teacher never builds an image, so the
 * honest answer is what the runner can already import, not a request queue.
 */
export function unsupportedLibraryRefusal(ecosystem: RuntimeEcosystem, name: string): string {
  return `${SUPPORTED_STACKS_SENTENCE} "${name}" is not a ${ECOSYSTEM_LABEL[ecosystem]} package this runner bakes, so this version cannot be published.`;
}

/**
 * Publish refuses a version in which any phase holds more than one task. The
 * draft keeps every task; only the publish is refused, and the sentence says
 * which phase and how many.
 *
 * Two refusals, because there are two reasons. Every phase publishes one
 * non-quiz task, so a written phase holding several is refused with the
 * general one-task-per-phase sentence. A phase graded by the code, test or
 * deployment grader is refused for a further reason (its sandbox work is
 * priced, ordered and scored per phase), and its sentence carries
 * `EXECUTABLE_SPLIT_NOT_READY` verbatim and tells the teacher the two things
 * they can do about it.
 *
 * A caller that names no kind gets the first sentence.
 *
 * The fork is on `splittableCheckKind` rather than on the written kinds alone, so
 * that a phase whose **own** checks are `quiz` does not read a sentence about
 * the code, test and deployment graders: none of which grades it, and none of
 * which is the reason it cannot hold several tasks. The real refusal for that
 * shape is the compiler's `phase-needs-a-required-artefact-task`, which can see
 * the required set this function cannot.
 */
export function multiTaskPublishRefusal(
  phaseTitle: string,
  taskCount: number,
  checkKind?: ArtifactKind,
): string {
  if (checkKind && !splittableCheckKind(checkKind)) {
    const grader = EXECUTABLE_GRADER_LABEL[checkKind];
    return `${phaseTitle} holds ${taskCount} tasks and is graded by the ${grader} grader. ${EXECUTABLE_SPLIT_NOT_READY} Leave one task in ${phaseTitle} to publish this version, or move this work into a written phase; the rest stay in the draft.`;
  }
  return `${phaseTitle} holds ${taskCount} tasks, and a learner can work one task per phase in this release. Leave one task in ${phaseTitle} to publish this version; the rest stay in the draft until per-task work reaches the learner.`;
}

/**
 * A phase whose tasks are all optional could never be gated, and a
 * phase that silently auto-passes is the worst failure available here.
 */
export function noRequiredTaskRefusal(phaseTitle: string): string {
  return `${phaseTitle} has no required task, so no learner could ever pass it. Mark at least one task required.`;
}

/** Two tasks of one phase claiming one file is what makes a per-task reset impossible. */
export function duplicateArtefactPathRefusal(path: string, heldByTaskTitle: string): string {
  return `"${path}" is already the artefact path of "${heldByTaskTitle}". Two tasks cannot write to one file: a reset on one would take the other task's work with it, so give this task a path of its own.`;
}

/**
 * A project the caller neither owns nor may edit. The HTTP shape follows the
 * written 404-not-403 policy (`scopedLearner` in `apps/api/src/instructor/cohort-scope.ts`)
 * for a project the caller cannot see at all; this sentence is the body when
 * the project **is** visible in their library and still is not theirs.
 */
export function projectNotYoursRefusal(): string {
  return 'That project is not yours to change. A teacher edits the projects they made, so copy this one from the library and edit your copy.';
}

/** The platform's own project is assignable and copyable, and never editable in place. */
export function platformProjectCopyOnlyRefusal(title: string): string {
  return `${title} is the platform's project. You can assign it to a class as it stands, or copy it and edit your copy.`;
}

/** A task that came with the copied project, refused as an edit. */
export function inheritedTaskRefusal(taskTitle: string): string {
  return `"${taskTitle}" is read-only here. ${INHERITED_TASK_NOTICE}`;
}

/** An artefact type a teacher cannot write from scratch. */
export function authorableArtefactTypeRefusal(artefactType: ArtefactType): string {
  const writable = `${AUTHORABLE_ARTEFACT_TYPES.slice(0, -1).join(', ')} and ${AUTHORABLE_ARTEFACT_TYPES[AUTHORABLE_ARTEFACT_TYPES.length - 1]}`;
  return `A ${artefactType} task cannot be written here yet. The tasks you write are ${writable}; the rest arrive with the project you copy.`;
}

/** A task added beside a phase's own work: only a concept quiz may be. */
export const QUIZ_ONLY_ADD_REFUSAL = "This phase holds the work it came with. Add a concept quiz here, or edit the phase's own task.";

/** The room's sentence for a phase in the retired written format: nothing grades it any more. */
export const RETIRED_WRITTEN_PHASE_ROOM = 'This phase is in an older format that LearnSDLC no longer grades. Your work is kept; your teacher needs to publish the project again.';

/** The upload door's refusal of a written phase in the older format under a key that does not convert. */
export function retiredWrittenPhaseUploadRefusal(phaseTitle: string): string {
  return `${phaseTitle} is a written phase in the older format, and only Requirements and Design convert from it. Remove the phase from the pack or give it checks of its own.`;
}

/** The class door's refusal of a version holding a written phase in the older format under a key that does not convert. */
export function retiredWrittenPhaseAssignRefusal(phaseTitle: string): string {
  return `This version's ${phaseTitle} is a written phase in the older format, which LearnSDLC no longer grades, and cannot be assigned.`;
}

/** A write aimed at a version that is no longer a draft. */
export function draftOnlyRefusal(version: string, status: ProjectVersionStatus): string {
  return `Version ${version} is ${status}, and a published version never changes. Publish a new version to change what a class works on.`;
}

/**
 * `versions.createDraft`, refused because this project already has its one
 * draft. At most one draft per project is the rule every other route is written
 * against (`projects.get` answers one `draftVersionId`, not a list), so opening
 * a second is refused rather than silently answering the first.
 */
export function draftAlreadyOpenRefusal(draftVersion: string): string {
  return `Version ${draftVersion} is already open as a draft on this project. Edit that draft and publish it, and the draft after it opens from what you published.`;
}

/**
 * `versions.createDraft`, refused because the project has published nothing for
 * the new draft to open from. A project made by `projects.create` opens with a
 * draft already; this is the state a project reaches when that draft is gone
 * and no publish ever landed.
 */
export function nothingPublishedRefusal(projectTitle: string): string {
  return `${projectTitle} has no published version yet, so there is nothing to open a new draft from. Publish the draft you have open, and the next draft starts from what you published.`;
}

/**
 * `versions.createDraft`, refused because `fromVersionId` is not the project's
 * published head any more: a second teacher published while this page was open.
 * The guard is optimistic rather than a lock, and this is the sentence when it
 * loses: without it the new draft would silently open from older work and the
 * publish that landed in between would be edited away.
 */
export function draftFromStaleHeadRefusal(headVersion: string): string {
  return `Version ${headVersion} was published while this page was open, so a draft opened now would start from older work. Reload the project and open the draft from ${headVersion}.`;
}

/* -------------------------- the validation report -------------------------- */

/**
 * What one check says about a draft.
 *
 * `not-applicable` is a neutral state and not a near-miss: eighteen of the
 * twenty-two content checks do not apply to a project with no application, and
 * eighteen grey rows is a worse first impression than one line saying so, which
 * is what `notApplicableLine` is for.
 */
export const VALIDATION_STATUSES = ['passed', 'failed', 'not-applicable'] as const;

export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

/**
 * Which tier ran. `fast` touches no microVM and runs on every save; `deep` runs
 * the `sandbox: true` proofs, and is teacher-initiated and rate-limited.
 */
export type ValidationTier = 'fast' | 'deep';

export interface ValidationCheck {
  /** Stable id, e.g. `phase-holds-one-task`. Add ids, never rename them. */
  id: string;
  /** What the check is about, one line. */
  label: string;
  status: ValidationStatus;
  /**
   * One sentence, always present, always true of the draft as it stands. On a
   * failure it is **the sentence publish would refuse with**, word for word, so
   * a teacher never reads one wording while drafting and another at the door.
   */
  sentence: string;
  /** The phase the row is about, or null for a project-wide check. */
  phaseKey: PhaseKey | null;
  /** The task the row is about, or null. */
  taskKey: string | null;
  /** Paths a teacher should open. Empty when there is nothing to open. */
  files: string[];
  /**
   * Set only on a `passed` row that is not a plain
   * pass. `warning`: its sentence asks the teacher to fix something; `note`:
   * it says a fact. Either way it never blocks publish, and it is not to
   * be drawn as "Passed". Absent on every other row.
   */
  advisory?: 'warning' | 'note';
}

export interface ValidationReport {
  tier: ValidationTier;
  /** ISO 8601, in a string, as every other stamp in this schema is. */
  ranAt: string;
  checks: ValidationCheck[];
  passed: number;
  failed: number;
  notApplicable: number;
  /** True when publish would be accepted on this draft right now. */
  publishable: boolean;
  /** Every failure's sentence, in the order the checks ran. Empty when publishable. */
  blocking: string[];
  /** The one collapsed line standing in for the neutral rows, or null when there are none. */
  notApplicableLine: string | null;
}

/** The collapsed line for the neutral rows, or null when none of them fired. */
export function notApplicableLine(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 check does not apply to this project.'
    : `${count} checks do not apply to this project.`;
}

/**
 * Fold a run of checks into the report the editor draws and the publish reads.
 *
 * `blocking` is the whole of "why publish would refuse", in check order, and
 * `publishable` is exactly "nothing failed": the two can never disagree,
 * because they are computed here rather than at each caller.
 */
export function summariseValidation(
  tier: ValidationTier,
  ranAt: string,
  checks: ValidationCheck[],
): ValidationReport {
  const blocking = checks.filter((one) => one.status === 'failed').map((one) => one.sentence);
  const notApplicable = checks.filter((one) => one.status === 'not-applicable').length;
  return {
    tier,
    ranAt,
    checks: [...checks],
    passed: checks.filter((one) => one.status === 'passed').length,
    failed: blocking.length,
    notApplicable,
    publishable: blocking.length === 0,
    blocking,
    notApplicableLine: notApplicableLine(notApplicable),
  };
}

/* ---------------------------- the derived rubric -------------------------- */

/**
 * One rule as the builder shows it: the shared copy of a config phase's
 * `FileRule` (`apps/api/src/content/content.types.ts`), minus `target`.
 *
 * It is a copy rather than a re-export because `content.types.ts` is the
 * API's and the teacher pages need the shape too.
 */
export interface AuthoredRule {
  /** Stable within the task: lower case, opening on a letter, at most 32 characters. */
  id: string;
  /** What the rule asks for, one line. The learner reads it in their report. */
  label: string;
  /** The rubric criterion this rule scores. The rubric's keys are these values. */
  criterion: string;
  /** A regular expression the artefact must match. Exactly one of `pattern` or `forbidden`. */
  pattern?: string;
  /** A regular expression the artefact must not match. */
  forbidden?: string;
  /** Regular-expression flags, e.g. `i` or `im`. */
  flags?: string;
  /** A failing required rule blocks the pass; an optional one only costs marks. */
  required: boolean;
  /** What the learner is told when it does not match, one sentence. */
  failDetail: string;
}

/** The threshold every phase of the platform's own project carries. */
export const DEFAULT_PASS_THRESHOLD = 70;

/**
 * The pass mark a **required** quiz is created with when the teacher names
 * none, and a number the teacher then changes.
 *
 * It is not `DEFAULT_PASS_THRESHOLD`, and the difference is arithmetic rather
 * than policy drift. A five-question quiz can only score 0, 20, 40, 60, 80 or
 * 100, so a mark of 70 is a mark of 80 wearing a different number:
 * `quiz-pass-mark-reachable` would warn about it on the first quiz anybody
 * writes. 60 is three of five, which is a mark a five-question paper can
 * actually land on. It is a number in this file and never a migration.
 */
export const DEFAULT_QUIZ_PASS_MARK = 60;

/**
 * The rubric key a quiz scores when its author names none.
 *
 * A quiz derives exactly one criterion and `quiz-rubric-key-is-the-quiz's`
 * holds the published snapshot to it, so this is the key a learner's report
 * prints under a quiz nobody gave a criterion to. It lives here rather than in
 * the route that writes it because the teacher's editor pre-fills the same
 * field: two copies of this string is how an editor comes to show one default
 * and a route to write another.
 */
export const DEFAULT_QUIZ_CRITERION = 'concepts';

/** How a learner's report describes a criterion the teacher's own rules score. */
export function learnerRuleCountDescription(rules: number): string {
  return rules === 1
    ? 'Scored by 1 rule your teacher set.'
    : `Scored by ${rules} rules your teacher set.`;
}

/* ------------------------------ the audit trail --------------------------- */

/**
 * The audit events authoring writes. Every mutating route leaves exactly one,
 * with the actor, the subject and a `detail` naming what moved.
 *
 * `AuditEventView['event']` in `./contract/feedback` carries every one of these beside its
 * other names, and the web's `describeAudit` needs a rendering case for each.
 * Add names at the end, never in between.
 */
export const AUTHORING_AUDIT_EVENTS = [
  'project.create',
  'project.update',
  'project.tasks',
  'project.validate',
  'project.publish',
  'project.archive',
  'cohort.project',
  // A teacher opened the next draft from the published head. It is
  // its own act and not a `project.update`: it makes a version row, and it is
  // the row every later `project.tasks` on this project hangs off.
  'project.draft',
  // A teacher read a quiz's answer key. A **read** writes it, and it is written for
  // `solution.read`'s reason rather than for a write's: an MCQ key *is* the
  // passing answer, so who has seen it is a question a class has to be able to
  // answer. `AUTHORING_ROUTES['tasks.quizKey'].audit` is therefore `null`,
  // because that field says what a *write* leaves; see the note on it below.
  'project.quiz-key',
  // The copy becomes the teacher's own. Three writes and one read, one name
  // each. `project.phase` is a
  // phase's intro; `project.interview` is the stakeholder interview written
  // whole or removed; `project.files` is one file's bytes replaced. Their audit
  // detail names the path, the byte length and the fact count, never bytes,
  // answers or digests.
  'project.phase',
  'project.interview',
  'project.files',
  // The interview read, for `project.quiz-key`'s reason: the brief holds the
  // stakeholder's answers, so who has read them is a question a class has to
  // be able to answer. `AUTHORING_ROUTES['interview.read'].audit` is null for
  // the same reason `tasks.quizKey`'s is.
  'project.interview-read',
  // An archive became a teacher's draft, and
  // the owner read a sealed file back. The second is a read that writes a
  // row, for `project.quiz-key`'s reason: a hidden suite or a reference
  // solution is the passing answer, so who has read one is on the record.
  'project.uploaded',
  'project.sealed-read',
  // A version left as an archive. A read that writes a row.
  'project.exported',
  // Deep validation was started on a draft. Its receipt is stored on the
  // version; the row says who spent the microVMs and when, and its detail
  // carries the count, never a byte.
  'project.deep-validation',
  // One bulk sign-off on a class, one class.bulk-signoff row per learner.
  'class.bulk-signoff',
] as const;

export type AuthoringAuditEvent = (typeof AUTHORING_AUDIT_EVENTS)[number];

/* ------------------------------- the routes ------------------------------- */

export type AuthoringRouteMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface AuthoringRoute {
  method: AuthoringRouteMethod;
  /** The API path. Staff API routes live under `/instructor`; the pages live under `/teacher`. */
  path: string;
  /** Enforced by `@Roles` and `RolesGuard` at the API, never by the page alone. */
  roles: readonly Role[];
  /** True for every route that writes, which is exactly every route that audits. */
  mutates: boolean;
  /**
   * The audit event the **write** leaves, or null on a read.
   *
   * It is null on `tasks.quizKey`, which is a read that nonetheless leaves a
   * `project.quiz-key` row, and on `interview.read`, which leaves a
   * `project.interview-read` row. That is not an omission: this field is how a
   * reviewer finds the write behind a row, and a route that writes nothing has
   * no write to name. The row exists for `solution.read`'s reason: a learner's
   * reference solution is a read that is on the record too, and the learner API
   * has no table like this one to declare it in.
   */
  audit: AuthoringAuditEvent | null;
  /** One line: what the route is for. */
  summary: string;
}

export const AUTHORING_ROUTE_KEYS = [
  'projects.list',
  'projects.create',
  'projects.get',
  'projects.updateMeta',
  'projects.archive',
  'version.draft',
  'version.validate',
  'version.publish',
  'tasks.list',
  'tasks.add',
  'tasks.update',
  'tasks.setRequired',
  'tasks.reorder',
  'tasks.remove',
  'files.list',
  'assignment.assignable',
  'assignment.read',
  'assignment.assign',
  // Appended rather than filed beside `version.draft`, so no key moves.
  'versions.createDraft',
  // The one door that carries a quiz's `correct` ids and its explanations. It
  // is a GET that leaves an audit row (as `interview.read` does): see
  // `AuthoringRoute.audit`.
  'tasks.quizKey',
  // The doors that make a copy the teacher's own. A phase's intro; the
  // stakeholder interview written, removed and read (the read is a GET that
  // leaves an audit row); and one file's bytes replaced. Appended, so no key
  // moves.
  'phases.update',
  'interview.replace',
  'interview.remove',
  'interview.read',
  'files.replace',
  // The upload door, the one runtime profile, and a task's sealed files
  // written and, for the owner alone, read back. Appended, so no key moves. A
  // sign-off route never joins this list: it is mounted on the instructor
  // controller, not this one.
  'projects.upload',
  'runtime.profile',
  'sealed.write',
  'sealed.read',
  // A version exported back to the on-disk layout.
  'version.export',
  // Deep validation, started and read. The authoring controller mounts it,
  // like every other key in this list.
  'deepValidation.start',
  'deepValidation.read',
  // The Phases card's three doors: a phase removed from a draft, put back from
  // the version the draft was opened from, or added empty. Appended, so no key
  // moves.
  'phases.remove',
  'phases.restore',
  'phases.add',
] as const;

export type AuthoringRouteKey = (typeof AUTHORING_ROUTE_KEYS)[number];

const STAFF: readonly Role[] = ['INSTRUCTOR', 'ADMIN'];

/**
 * The whole authoring surface, as paths.
 *
 * Membership, ordering and requiredness are three separate teacher actions, so
 * they are three routes, and ordering is one whole-list `PUT`, because an
 * ordering is one fact and a pairwise swap leaves an intermediate state in
 * which two tasks claim position 3.
 */
export const AUTHORING_ROUTES: Record<AuthoringRouteKey, AuthoringRoute> = {
  'projects.list': {
    method: 'GET',
    path: '/instructor/projects',
    roles: STAFF,
    mutates: false,
    audit: null,
    summary: "The caller's own projects, and the library they may copy or assign.",
  },
  'projects.create': {
    method: 'POST',
    path: '/instructor/projects',
    roles: STAFF,
    mutates: true,
    audit: 'project.create',
    summary: 'Make a project by copying a published version into a new draft.',
  },
  'projects.get': {
    method: 'GET',
    path: '/instructor/projects/:projectId',
    roles: STAFF,
    mutates: false,
    audit: null,
    summary: 'One project, its versions and which of them is the open draft.',
  },
  'projects.updateMeta': {
    method: 'PATCH',
    path: '/instructor/projects/:projectId',
    roles: STAFF,
    mutates: true,
    audit: 'project.update',
    summary: "Change the title, tagline or description. Refused on a project that is not the caller's.",
  },
  'projects.archive': {
    method: 'POST',
    path: '/instructor/projects/:projectId/archive',
    roles: STAFF,
    mutates: true,
    audit: 'project.archive',
    summary: 'Withdraw a project from the library. Refused by name while any enrolment pins one of its versions.',
  },
  'version.draft': {
    method: 'GET',
    path: '/instructor/projects/:projectId/versions/:versionId',
    roles: STAFF,
    mutates: false,
    audit: null,
    summary: 'The draft tree: phases, tasks and the last validation report.',
  },
  'version.validate': {
    method: 'POST',
    path: '/instructor/projects/:projectId/versions/:versionId/validate',
    roles: STAFF,
    mutates: true,
    audit: 'project.validate',
    summary: 'Run the fast tier, which touches no microVM, and store the report.',
  },
  'version.publish': {
    method: 'POST',
    path: '/instructor/projects/:projectId/versions/:versionId/publish',
    roles: STAFF,
    mutates: true,
    audit: 'project.publish',
    summary: 'Freeze the draft at a version. Immutable from that moment.',
  },
  'tasks.list': {
    method: 'GET',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks',
    roles: STAFF,
    mutates: false,
    audit: null,
    summary: "One phase's tasks in order, inherited ones included and marked read-only.",
  },
  'tasks.add': {
    method: 'POST',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks',
    roles: STAFF,
    mutates: true,
    audit: 'project.tasks',
    summary: "Add a concept quiz beside a phase's own task, or bring back a Requirements or Design phase's own task.",
  },
  'tasks.update': {
    method: 'PATCH',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey',
    roles: STAFF,
    mutates: true,
    audit: 'project.tasks',
    summary: "Change a task's title, brief or objectives. Refused on an inherited task.",
  },
  'tasks.setRequired': {
    method: 'PUT',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/required',
    roles: STAFF,
    mutates: true,
    audit: 'project.tasks',
    summary: 'Mark a task required or optional. Only required tasks gate the phase.',
  },
  'tasks.reorder': {
    method: 'PUT',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/task-order',
    roles: STAFF,
    mutates: true,
    audit: 'project.tasks',
    summary: 'The whole ordering at once, so two teachers cannot interleave.',
  },
  'tasks.remove': {
    method: 'DELETE',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey',
    roles: STAFF,
    mutates: true,
    audit: 'project.tasks',
    summary: 'Remove a task the caller wrote. Refused on an inherited task.',
  },
  'tasks.quizKey': {
    method: 'GET',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/quiz/key',
    roles: STAFF,
    mutates: false,
    audit: null,
    summary:
      "A quiz's correct option ids and its explanations, for the project's owner alone. Audited on every read.",
  },
  'files.list': {
    method: 'GET',
    path: '/instructor/projects/:projectId/versions/:versionId/files',
    roles: STAFF,
    mutates: false,
    audit: null,
    summary: 'Every file row: path, role and size, with bytes only for the two learner-facing roles.',
  },
  'assignment.assignable': {
    method: 'GET',
    path: '/instructor/cohorts/:cohortId/project/assignable',
    roles: STAFF,
    mutates: false,
    audit: null,
    summary: 'The published versions this class could be put on.',
  },
  'assignment.read': {
    method: 'GET',
    path: '/instructor/cohorts/:cohortId/project',
    roles: STAFF,
    mutates: false,
    audit: null,
    summary: 'The assignment in force and everything the class has held before it.',
  },
  'assignment.assign': {
    method: 'PUT',
    path: '/instructor/cohorts/:cohortId/project',
    roles: STAFF,
    mutates: true,
    audit: 'cohort.project',
    summary: 'Put a class on a published version, with a reason. New enrolments take it; pinned ones do not move.',
  },
  'versions.createDraft': {
    method: 'POST',
    path: '/instructor/projects/:projectId/versions',
    roles: STAFF,
    mutates: true,
    audit: 'project.draft',
    summary: 'Open the next draft from the published head, so a published project can be edited again.',
  },
  // The interview's three routes name
  // `requirements` in the path rather than taking a `:phaseKey`: the content
  // loader drops an interview on every other phase, so there is no other value
  // a door would not have to refuse. It is `INTERVIEW_PHASE` below, written out
  // here because this table is built before that constant is.
  'phases.update': {
    method: 'PATCH',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey',
    roles: STAFF,
    mutates: true,
    audit: 'project.phase',
    summary: "Change a phase's intro. The title stays as the project has it; the intro is the teacher's on every phase.",
  },
  'phases.remove': {
    method: 'DELETE',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey',
    roles: STAFF,
    mutates: true,
    audit: 'project.phase',
    summary: 'Remove a phase from a draft: its task, its files, its sealed files and its quizzes leave it, and the rest renumber.',
  },
  'phases.restore': {
    method: 'POST',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/restore',
    roles: STAFF,
    mutates: true,
    audit: 'project.phase',
    summary: 'Put a removed phase back into a draft, copied from the version the draft was opened from.',
  },
  'phases.add': {
    method: 'POST',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey',
    roles: STAFF,
    mutates: true,
    audit: 'project.phase',
    summary: 'Add an empty Requirements or Design phase to a draft that holds neither the phase nor a source copy of it.',
  },
  'interview.replace': {
    method: 'PUT',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/requirements/interview',
    roles: STAFF,
    mutates: true,
    audit: 'project.interview',
    summary: 'Write the stakeholder interview whole: persona, opening, replies, limits and facts.',
  },
  'interview.remove': {
    method: 'DELETE',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/requirements/interview',
    roles: STAFF,
    mutates: true,
    audit: 'project.interview',
    summary: 'Remove the stakeholder interview. The Requirements room then has no interview to hold.',
  },
  'interview.read': {
    method: 'GET',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/requirements/interview',
    roles: STAFF,
    mutates: false,
    audit: null,
    summary: "The interview with its facts' answers, for the project's owner alone. Audited on every read.",
  },
  'files.replace': {
    method: 'PUT',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/files',
    roles: STAFF,
    mutates: true,
    audit: 'project.files',
    summary: "Replace one file's bytes in a written phase of a draft. Its path and its role never change.",
  },
  // The upload sits beside the project list:
  // it makes a project, so it cannot be addressed by one. Its JSON body is the
  // one other route with a parser of its own, sized to the import cap.
  'projects.upload': {
    method: 'POST',
    path: '/instructor/projects/upload',
    roles: STAFF,
    mutates: true,
    audit: 'project.uploaded',
    summary: 'Upload a project archive as a new draft the caller owns. Nothing is published, and nothing is shared.',
  },
  'runtime.profile': {
    method: 'GET',
    path: '/instructor/runtime-profile',
    roles: STAFF,
    mutates: false,
    audit: null,
    summary: 'The one runtime profile this deployment bakes, named with its manifest digest, before anything is uploaded.',
  },
  'sealed.write': {
    method: 'PUT',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/sealed',
    roles: STAFF,
    mutates: true,
    audit: 'project.files',
    summary: "Write one of a task's sealed files: a hidden test, the reference solution or a mutant. It answers a digest and a size, never the bytes.",
  },
  'sealed.read': {
    method: 'GET',
    path: '/instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/sealed',
    roles: STAFF,
    mutates: false,
    audit: null,
    summary: "One of a task's sealed files with its bytes, for the project's owner alone. Audited on every read.",
  },
  // A read that leaves a `project.exported` row, so `audit` is null here.
  'version.export': {
    method: 'GET',
    path: '/instructor/projects/:projectId/versions/:versionId/export',
    roles: STAFF,
    mutates: false,
    audit: null,
    summary: "A version as an archive in the on-disk layout, sealed files included, for the project's owner alone. Audited on every export.",
  },
  // Deep validation runs in the sandbox and asks
  // no model; the start is refused while the same teacher has one in flight.
  'deepValidation.start': {
    method: 'POST',
    path: '/instructor/projects/:projectId/versions/:versionId/deep-validation',
    roles: STAFF,
    mutates: true,
    audit: 'project.deep-validation',
    summary: 'Start deep validation of a draft in the sandbox, after its microVM count has been shown. One at a time per teacher.',
  },
  'deepValidation.read': {
    method: 'GET',
    path: '/instructor/projects/:projectId/versions/:versionId/deep-validation',
    roles: STAFF,
    mutates: false,
    audit: null,
    summary: "A draft's deep validation: its state, its four checks, and whether its receipt still matches the draft.",
  },
};

/* ------------------------------- the payloads ------------------------------ */

/** The version a copy opens at. */
export const DRAFT_FIRST_VERSION = '0.1.0';

/** A project slug: lower case, opening on a letter, two to forty-eight characters. */
export const PROJECT_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,47}$/;

export function isProjectSlug(value: string): boolean {
  return PROJECT_SLUG_PATTERN.test(value);
}

/** One row of the library. */
export interface AuthoredProjectSummary {
  id: string;
  slug: string;
  title: string;
  /** The platform's own project: assignable and copyable, never editable in place. */
  platformOwned: boolean;
  /** True when the caller owns it, which is the only case they may edit. */
  mine: boolean;
  /** The project a learner who names none is put in. Exactly one row is true. */
  isDefault: boolean;
  origin: ProjectOrigin;
  /** The newest published version, or null when nothing has been published. */
  publishedVersion: string | null;
  publishedVersionId: string | null;
  /** The open draft, or null. At most one per project. */
  draftVersion: string | null;
  draftVersionId: string | null;
  /** How many classes hold an active assignment on any version of it. */
  cohortsUsing: number;
  /** When the draft was last validated, ISO, or null. */
  lastValidatedAt: string | null;
  createdAt: string;
}

/** What `projects.list` answers: the caller's own, and what they may copy or assign. */
export interface AuthoringLibraryView {
  mine: AuthoredProjectSummary[];
  /** Platform-owned projects. Copy-only, and refused as an edit by name. */
  library: AuthoredProjectSummary[];
}

export interface CreateProjectBody {
  title: string;
  /** `PROJECT_SLUG_PATTERN`. Unique across every project. */
  slug: string;
  /** The published version to copy. Its rows are copied; its blobs are referenced. */
  fromVersionId: string;
}

export interface CreateProjectResult {
  project: AuthoredProjectSummary;
  draftVersionId: string;
  /** `DRAFT_FIRST_VERSION`. */
  draftVersion: string;
}

/**
 * `title` lands on the `projects` row; `tagline` and `description` land on the
 * draft version's manifest, so changing them is a draft edit and a published
 * version keeps the words it shipped with.
 */
export interface UpdateProjectMetaBody {
  title?: string;
  tagline?: string;
  description?: string;
}

/** What this deployment's runner can import, read from the baked manifest. */
export interface SupportedStacks {
  /** `ALLOWED_PYTHON`. */
  python: string[];
  /** `ALLOWED_NODE`. */
  node: string[];
  /** `ALLOWED_TOOLS`. */
  tools: string[];
  /** `SUPPORTED_STACKS_SENTENCE`, carried so the editor says it before a teacher starts. */
  sentence: string;
}

/* --------------------------- the authored quiz ---------------------------- */

/*
 * Two types, and the second is not a convenience.
 *
 * `AuthoredQuiz` carries the key and the explanations. `AuthoredQuizView`
 * carries neither, and they are separate types rather than one type with
 * optional fields so that no route can return the wrong one by forgetting to
 * strip a field: a payload builder that starts from the wrong shape does not
 * compile.
 *
 * The reason the draft payload gets the view is sharper than authorship.
 * `readDraft` and `listTasks` are guarded by `requireVisibleProject`, not by
 * `requireOwnedProject`, and that guard admits **every instructor on the
 * deployment for any platform-owned project** and any `ADMIN` for anybody's.
 * The full `AuthoredQuiz` is returned by one route only,
 * `GET …/tasks/:taskKey/quiz/key`, guarded by `requireOwnedProject` and audited
 * the way `solution.read` is audited, which is also what makes *"who looked at
 * this key"* a question with an answer.
 */

/** One question as the teacher's draft payload shows it: no key, no explanation. */
export interface AuthoredQuizViewQuestion {
  id: string;
  stem: string;
  options: QuizOption[];
  /**
   * How many of `options` the key holds: the count, never the ids, so the
   * editor can draw *"pick 2"* without the answer being in the payload.
   *
   * Named `answerCount` and not `correctCount` on purpose: the string `correct`
   * appears nowhere in a payload that is not the key route's, so the seal is
   * one substring assertion over a whole serialised response rather than a
   * field-by-field walk. That is how the API's seal test is written.
   */
  answerCount: number;
  /** What the question tests, in the teacher's words. Not a key. */
  concept?: string;
}

/** A quiz as any instructor who can see the draft may read it. Never the key. */
export interface AuthoredQuizView {
  questions: AuthoredQuizViewQuestion[];
  drawn?: number;
  shuffleOptions: boolean;
  passMark: number;
  attempts: { max: number | null; cooldownSeconds: number | null };
  criterion: string;
  // The reveal, echoed as it was written.
  /** `QuizChecks.revealExplanation`. Absent means the quiz keeps the default rule. */
  revealExplanation?: QuizRevealExplanation;
}

/**
 * A quiz as its owner writes it and as the audited key route reads it back:
 * `QuizQuestion` entire, `correct` and `explanation` included.
 *
 * Everything but `questions` is optional: a teacher who names no pass mark gets
 * `DEFAULT_QUIZ_PASS_MARK` on a required quiz, and the editor's own defaults
 * for `attempts` are `{ max: 3, cooldownSeconds: null }` when it gates and
 * `{ max: null, cooldownSeconds: null }` when it does not. The route fills
 * them; the compiled `QuizChecks` has them all.
 */
export interface AuthoredQuiz {
  /** At least one. Every field of `QuizQuestion`, key included. */
  questions: QuizQuestion[];
  /** Absent draws the whole pool in order. */
  drawn?: number;
  /** Defaults to true. */
  shuffleOptions?: boolean;
  /** 0..100. `DEFAULT_QUIZ_PASS_MARK` when absent. */
  passMark?: number;
  /** `max: null` is unlimited, and is refused on a required quiz. */
  attempts?: { max: number | null; cooldownSeconds: number | null };
  /** The single rubric key this quiz scores. `'concepts'` when absent. */
  criterion?: string;
  // When a practice quiz's explanations are released.
  /**
   * `QuizChecks.revealExplanation`: an **optional** quiz only. The route
   * refuses it on a required quiz (`quiz-reveal-optional-only`), and the
   * runtime ignores it on one. Absent keeps the default rule (a pass or the
   * last attempt opens them, and a formative quiz opens them on every paper).
   */
  revealExplanation?: QuizRevealExplanation;
}

/** Deployment's upload-only half as the builder reads it: the file rules with their targets, the smoke run and the drill. */
export interface DraftConfigView {
  fileRules: { id: string; label: string; criterion: string; target: string }[];
  smoke: { dockerfile: string; commands: string[][]; expectInOutput: string };
  drill?: { fault: string; description: string; faultedFiles: string[] };
}

export interface DraftTaskView {
  /** `''` for a phase's synthesised sole task, which no route addresses. */
  taskKey: string;
  order: number;
  required: boolean;
  title: string;
  /** Markdown: the task panel a learner reads. */
  brief: string;
  artefactType: ArtefactType;
  /** Minted at creation; null for `code` and `tests`, whose room opens `primaryPath`. */
  artefactPath: string | null;
  /** The check kind that scores it, derived from its graded units, not its type. */
  checkKind: ArtifactKind;
  /** The task's rubric: a record's weighted criteria, a quiz's one, or the platform's for code and tests. */
  rubric: PhaseRubric;
  objectives: string[];
  /** The workspace paths this task's work lands in. */
  owns: string[];
  /** `isAuthorableTask` of its check kind and type: false renders the Notice, not a dead control. */
  authorable: boolean;
  /** `INHERITED_TASK_NOTICE` when `authorable` is false, null otherwise. */
  notice: string | null;
  // The quiz, without its key.
  /**
   * Present on a task whose check kind is `quiz`, absent on every other.
   * **`AuthoredQuizView` and not `AuthoredQuiz`**: this payload is readable by
   * every instructor on the deployment for any platform-owned project. The key
   * is the audited route's alone.
   */
  quiz?: AuthoredQuizView;
  // The executable task.
  /**
   * Present on the one work task of a code or tests phase that the executable
   * editor opens (`isAuthorableExecutableTask` of its check kind and type),
   * absent on every other task. Every
   * sealed member is a `SealedFileView` (a path, a digest and a size), so this
   * payload never carries a hidden test, the solution or a mutant.
   */
  executable?: ExecutableTaskView;
  /** Present on a story task: its provided stories, learner story and floor. */
  story?: StoryChecksSpec;
  /**
   * Present on a design task: its switches, stories and floor. A Design task
   * still in the older (markdown) format carries the checks it would convert
   * to, read without writing anything, beside `designOlderFormat`.
   */
  design?: DesignChecksSpec;
  /** Set on a Design task still in the older format: its first design save converts it. */
  designOlderFormat?: true;
  /** Present on Deployment's config task with a runbook: the record, its floor, and whether the phase drills. */
  runbook?: RunbookChecks & { drill: boolean };
  /** Present on Maintenance's code task with a change request: the ticket, the contract switch and the floor. */
  change?: { ticket: ChangeTicket; contract: boolean; floor: ChangeFloor };
  /**
   * Set on a Deployment or Maintenance task still in the older format: its
   * first runbook or change save converts it. `runbook` or `change` and
   * `rubric` then carry what that save would convert it to, read without
   * writing anything.
   */
  recordOlderFormat?: true;
  /** Why the conversion would refuse, shown in the builder, on a task still in the older format. */
  recordConversionRefused?: string;
  /**
   * Present on Deployment's config task with a runbook: what the builder's
   * Files-and-checks card shows read-only and the rubric locks (the file
   * rules' criteria and `build_smoke`). The task view carries no rules of
   * its own, so this is the one view of the file rules.
   */
  config?: DraftConfigView;
  // The sign-off mark.
  /**
   * Whether a learner's pass of this task waits for the teacher's
   * countersignature in the class sign-off queue. Sent only when true: the
   * API leaves it out when the task is not marked, so an absent mark reads as
   * false.
   */
  signOff?: boolean;
}

export interface DraftPhaseView {
  key: PhaseKey;
  order: number;
  title: string;
  intro: string;
  /** The default check kind for a new task here. */
  artifactKind: ArtifactKind;
  /**
   * What actually grades this phase: `checks.kind` on the compiled content,
   * which is what the publish gate and the compiler's wall both ask.
   *
   * It is beside `artifactKind` and not instead of it because they are two
   * facts: `artifactKind` is the phase row's own kind, which pre-fills a new
   * task, and a pack may declare a phase whose checks are graded by something
   * else. They agree on all six phases of the shipped project and therefore on
   * every copy of it; where they do not, the banner and the report have to be
   * reading this one, or a teacher reads two wordings for one refusal.
   *
   * Optional; a client that finds it absent reads the phase's `artifactKind`
   * instead. Every builder in this repository sets it.
   */
  checkKind?: ArtifactKind;
  tasks: DraftTaskView[];
  /**
   * True while this phase alone would refuse the publish, because it holds more
   * than `publishableTasksPerPhase(checkKind)` tasks. The editor reads it to
   * render the gate beside the phase rather than only in the report.
   */
  blocksPublish: boolean;
  // The scenario, and whose it is.
  /**
   * The phase's stakeholder interview **without its answers**:
   * persona, opening, limits and each fact's topic. Present on a phase that
   * holds an interview, which only `INTERVIEW_PHASE` can; absent on every
   * other phase.
   *
   * `DraftInterviewView` and not `InterviewBody`, for the quiz key's reason:
   * this payload is readable by every instructor who can see the project. The
   * answers are `interview.read`'s alone: owner-only and audited.
   */
  interview?: DraftInterviewView;
  /**
   * What in this phase is still the reference project's and what is the
   * teacher's, per element. A client must render without it.
   */
  provenance?: PhaseProvenanceView;
}

export interface DraftVersionView {
  projectId: string;
  versionId: string;
  version: string;
  status: ProjectVersionStatus;
  slug: string;
  title: string;
  tagline: string;
  description: string;
  platformOwned: boolean;
  /** True only on the caller's own project and only while the version is a draft. */
  editable: boolean;
  phases: DraftPhaseView[];
  /** The last report, or null when validate has not run on this draft. */
  validation: ValidationReport | null;
  supportedStacks: SupportedStacks;
  createdAt: string;
  /**
   * The version this draft was opened from (the version a copy was made
   * from, or the head a new draft opened from), or null. A design task's
   * "Reset to the pack's" restores that version's bytes, so it is drawn only
   * where there is one. Optional; absent reads as no version to restore from.
   */
  forkedFromVersionId?: string | null;
  /**
   * Present on a draft whose Design was converted from markdown (at copy, at
   * boot or at the first design save): the conversion's note and every file it
   * removed from the phase, the teacher's reference documents among them, for
   * the builder to say. Optional; absent means nothing was converted.
   */
  designConversion?: { note: string; removed: string[] };
  /**
   * Present on a draft whose texts were converted from markdown to plain text
   * (at its first save, at a Phases card door or at boot): one note
   * per phase that changed, naming the members (`markdownKeptWarning`), and
   * one per phase that holds an HTML comment (`htmlCommentWarning`), for the
   * editor to draw on the phase each names (`plainTextNotesOn`). A phase
   * title and member names, never a teacher's word. Optional; absent means
   * nothing was converted.
   */
  plainTextConversion?: { notes: string[] };
  /**
   * The Phases card: the six phases in LearnSDLC's order, each with its state
   * in this draft and the doors it offers now.
   */
  phaseSet: DraftPhaseSetView[];
}

/** "In this project", "Removed" (the source holds it, the draft does not), "Not in this project" (neither holds it). */
export type DraftPhaseState = 'held' | 'removed' | 'absent';

/** One row of the Phases card. */
export interface DraftPhaseSetView {
  key: PhaseKey;
  state: DraftPhaseState;
  /** What a Remove of a held phase leaves, which words its confirm (`removeConfirm`). Absent unless held. */
  removeSource?: RemoveSource;
  /** The doors this phase offers now, so the card draws only those. All false on a version that is not a draft. */
  canRemove: boolean;
  canPutBack: boolean;
  canAdd: boolean;
  /**
   * The door's refusal for an Add of an application phase (`addByUploadRefusal`), or null; the card draws
   * its own one line, `ADDED_BY_UPLOAD`, beside it.
   */
  why: string | null;
}

export interface AddTaskBody {
  /** `isAuthoredTaskKey`. Unique within the phase and stable across versions. */
  taskKey: string;
  title: string;
  /** Markdown. */
  brief: string;
  /** One of `AUTHORABLE_ARTEFACT_TYPES`; the phase's suggestion when absent. */
  artefactType?: ArtefactType;
  /** Defaults to true. Only required tasks gate the phase. */
  required?: boolean;
  objectives?: string[];
  // The quiz a teacher writes.
  /**
   * Present on a create whose `artefactType` is `quiz`, the one task a phase
   * adds beside its own work: a quiz task is written with `artefactPath: null`,
   * `owns: []`, `checks` from this, and the derived one-criterion rubric, and
   * mints no path and writes no workspace file.
   */
  quiz?: AuthoredQuiz;
}

/**
 * Everything a task may be edited to. `artefactPath` is deliberately not a
 * member: it is minted at creation and a room and a reset key on it, so moving
 * it is a delete and a create. `required` is not a member either: it is its own
 * route, because it is its own teacher decision.
 */
export interface UpdateTaskBody {
  title?: string;
  brief?: string;
  artefactType?: ArtefactType;
  objectives?: string[];
  // The whole quiz, replaced.
  /**
   * The quiz as it should now be: questions, key, explanations and settings
   * together, because a question's key and its options are one edit. Present
   * only on a task whose check kind is `quiz`; the route refuses it on any
   * other.
   *
   * Changing `criterion` here moves the rubric with it:
   * `quiz-rubric-key-is-the-quiz's` refuses a published snapshot whose quiz
   * rubric declares anything but this key, because `assembleCriteria` reads
   * `scores.get(key) ?? 0` and a mismatch is a flat zero with no evidence, on
   * a required quiz, a bar nobody can clear.
   */
  quiz?: AuthoredQuiz;
  // A criterion's wording.
  /**
   * New wording for criteria the task already has, by key: a title of at most
   * `CRITERION_TITLE_MAX` characters and a description of at most
   * `CRITERION_DESCRIPTION_MAX`. A weight and the pass threshold are never
   * members: an inherited task keeps the pack's weights.
   *
   * A criterion it does not name keeps its wording, and the door refuses a key the
   * task's rubric does not hold. A reworded criterion changes the task's
   * rubric, which the task's reference anchor hashes, so the task is no longer
   * the reference project's from that save on.
   */
  criteria?: CriterionWordingBody[];
  // The executable editor's save. `UpdateExecutableTaskBody`'s members, typed from it so there
  // is one shape: the route reads them only on a task that carries
  // `DraftTaskView.executable`, and refuses them on every other. The sealed
  // roles are never members; they go through `sealed.write`.
  owns?: UpdateExecutableTaskBody['owns'];
  runs?: UpdateExecutableTaskBody['runs'];
  minTests?: UpdateExecutableTaskBody['minTests'];
  coverageKeywords?: UpdateExecutableTaskBody['coverageKeywords'];
  // The sign-off mark.
  /**
   * Mark or unmark the task as needing the teacher's sign-off. Absent means
   * unchanged. Only a draft takes it. Any work task may be marked (a written,
   * code, tests or config task). A task neither edit arm changes, such as a
   * copy's inherited task or an uploaded config task, takes a body carrying the
   * mark alone, and only the mark is written. A quiz is refused, even where its
   * other edits are allowed.
   */
  signOff?: boolean;
  /**
   * A story task's provided stories, learner story and floor, replaced whole.
   * Accepted only by a story task (`checks.kind === 'story'`): it has a floor, not rules.
   */
  story?: StoryChecksBody;
  /**
   * A design task's switches, stories and floor, replaced whole. Accepted only
   * on a task of the Design phase: it has a floor, not rules. Sent to a Design
   * task still in the older format, it converts the task first.
   */
  design?: DesignChecksBody;
  /** Deployment's runbook floor, through the runbook arm (a config task of the phase keyed `deployment`). */
  runbook?: RunbookChecksBody;
  /** Maintenance's ticket, through the executable arm (the code task of the phase keyed `maintenance`). */
  ticket?: ChangeTicket;
  /** Maintenance's change request switch and floor, through the executable arm. */
  change?: ChangeChecksBody;
  /**
   * A story or design task's rubric, weights and pass threshold included,
   * replaced whole; also Deployment's (its file rules' criteria and
   * `build_smoke` kept) and Maintenance's (its four fixed keys kept).
   */
  rubric?: RubricBody;
}

/** What the story editor saves: the floor and the stories, without the record path. */
export interface StoryChecksBody {
  providedStories: ProvidedStory[];
  learnerStory: LearnerStorySpec;
  floor: StoryFloor;
}

/** What the design builder saves: the switches, the stories and the floor, without the record path. Every cap is `DESIGN_CAPS`. */
export interface DesignChecksBody {
  contracts: DesignContracts;
  sequence: boolean;
  stories: DesignStory[];
  floor: DesignFloor;
}

/** What the Deployment builder saves of the runbook: the floor, without the record path. Every cap is `RUNBOOK_CAPS`. */
export interface RunbookChecksBody { floor: RunbookFloor }

/** What the Maintenance builder saves of the change request: the contract switch and the floor. Every cap is `CHANGE_CAPS`. */
export interface ChangeChecksBody { contract: boolean; floor: ChangeFloor }

/** A story or design task's rubric as the editor saves it. The weights sum to 1. */
export interface RubricBody {
  passThreshold: number;
  criteria: { key: string; title: string; description: string; weight: number }[];
}

export interface SetTaskRequiredBody {
  required: boolean;
}

/** The whole ordering: every key the phase holds, once each, in the order wanted. */
export interface ReorderTasksBody {
  taskKeys: string[];
}

/** What every task mutation answers, so the editor never has to guess. */
export interface TaskMutationResult {
  phase: DraftPhaseView;
  /** The fast tier, re-run on the save. */
  validation: ValidationReport;
  /**
   * Present only on the answer of the save that converted the draft's texts
   * from markdown (its first save): the draft's notes, as
   * `DraftVersionView.plainTextConversion` carries them. The conversion
   * reaches every phase, and `phase` is one of them, so the editor reads the
   * draft again for the others.
   */
  plainTextConversion?: { notes: string[] };
}

export interface AuthoringFileView {
  id: string;
  ownerKind: ProjectFileOwnerKind;
  /** The phase the row hangs off, or null for a project-level row. */
  phaseKey: PhaseKey | null;
  path: string;
  role: ProjectFileRole;
  editable: boolean;
  language: string | null;
  /** Bytes, from `content_blobs.size`. Present for every row, sealed or not. */
  size: number;
  /** `!isAuthoringReadableRole(role)`: whether the bytes are withheld. */
  sealed: boolean;
  /**
   * The bytes, and only for a row whose role `isAuthoringReadableRole` admits.
   * Null for every other row, `canonical` included.
   */
  content: string | null;
  /** `SEALED_FILE_NOTICE`, `CANONICAL_FILE_NOTICE`, or null on a readable row. */
  notice: string | null;
}

export interface PublishVersionBody {
  /** `MAJOR.MINOR.PATCH`, and newer than every published version of this project. */
  version: string;
  notes?: string;
}

export interface PublishVersionResult {
  versionId: string;
  version: string;
  /** ISO. */
  publishedAt: string;
  /** microVMs one full pass costs, computed at publish. */
  sandboxBudget: number;
  /** The report publish re-ran and accepted. */
  validation: ValidationReport;
}

/**
 * `versions.createDraft`'s body: the published version the caller was looking
 * at when they asked for a draft.
 *
 * It is an optimistic guard and not a choice of parent. A draft always opens
 * from the project's published head, and naming a `fromVersionId` that is no
 * longer the head is refused with `draftFromStaleHeadRefusal` rather than
 * honoured: copying an older version's rows would quietly undo whatever the
 * other teacher published in between.
 *
 * The response is a `DraftVersionView`: the same shape `version.draft` answers,
 * so the editor routes straight into the draft it just opened without a second
 * request.
 */
export interface CreateDraftVersionBody {
  /** `AuthoredProjectSummary.publishedVersionId`, as the caller last read it. */
  fromVersionId: string;
}

/**
 * The version string a new draft opens at: the published head with its patch
 * bumped.
 *
 * A draft needs some version before anybody has chosen one, and it has to be
 * one `PublishVersionBody.version` would accept, newer than every published
 * version, so that a teacher who changes nothing about the number can still
 * publish. A bump of the head's patch is always free, because publish already
 * refuses anything that is not newer than the head.
 *
 * A version string the pattern does not accept is left alone rather than
 * guessed at, and the caller falls back to `DRAFT_FIRST_VERSION`.
 */
export function nextDraftVersion(publishedVersion: string): string {
  const parts = publishedVersion.split('.');
  if (parts.length !== 3) return DRAFT_FIRST_VERSION;
  const [major, minor, patch] = parts;
  const bumped = Number(patch);
  if (!/^\d+$/.test(major) || !/^\d+$/.test(minor) || !/^\d+$/.test(patch)) {
    return DRAFT_FIRST_VERSION;
  }
  return `${major}.${minor}.${bumped + 1}`;
}

/* ---------------------------- the class assignment ------------------------ */

/** The same ten characters every instructor override already asks for a reason. */
export const ASSIGNMENT_REASON_MIN = 10;

/** The reason a teacher gives for assigning a class a project version: at most this many characters. */
export const ASSIGNMENT_REASON_MAX = 1000;

export interface AssignableVersionView {
  projectId: string;
  projectSlug: string;
  projectTitle: string;
  platformOwned: boolean;
  mine: boolean;
  versionId: string;
  version: string;
  /** ISO, or null on the platform's own imported pack, which nobody published here. */
  publishedAt: string | null;
  /** True when this is the version the class is on right now. */
  current: boolean;
  // What the version holds.
  /**
   * How much of this version is the teacher's own, and whose application its
   * last four phases run: what the class card says before a teacher assigns
   * it. A client must render without it.
   */
  provenance?: VersionProvenanceView;
  /**
   * The phases this version holds, in place order, so the class card can say
   * "Requirements, Design and Implementation" (`phaseListSentence`). Absent on
   * a version that holds no phase rows here.
   */
  phases?: PhaseKey[];
}

export interface AssignProjectBody {
  projectVersionId: string;
  /** At least `ASSIGNMENT_REASON_MIN` characters. Read by the audit trail, never by a learner. */
  reason: string;
}

export interface CohortProjectAssignmentView {
  id: string;
  cohortId: string;
  projectVersionId: string;
  projectSlug: string;
  projectTitle: string;
  version: string;
  assignedByUserId: string;
  /** Null once that account is gone: the assignment is the class's record, not the teacher's. */
  assignedByName: string | null;
  reason: string;
  active: boolean;
  createdAt: string;
  // The same summary the assignable version carries, for the version the
  // class is on.
  /** `AssignableVersionView.provenance`, for this assignment's version. A client must render without it. */
  provenance?: VersionProvenanceView;
  /**
   * The phases this assignment's version holds, in place order, read from its
   * phase rows, so the teacher's board and the class levers draw the class's
   * phases whoever owns the version. Absent on a version that holds no phase
   * rows here.
   */
  phases?: PhaseKey[];
}

export interface CohortProjectView {
  cohortId: string;
  /** The assignment in force, or null when the class has never been given one. */
  active: CohortProjectAssignmentView | null;
  /** Every assignment this class has held, newest first, the active one included. */
  history: CohortProjectAssignmentView[];
}

/* ============================================================================
 * The copy becomes the teacher's own.
 *
 * A teacher who copies the reference project can make every **written**
 * element of Requirements and Design their own: each phase's intro, the
 * stakeholder interview, the read-only documents a written phase mounts, the
 * markdown starters a written task owns, and the wording of an inherited
 * task's criteria. In a copy, Implementation, Testing, Deployment and
 * Maintenance stay the reference project's application (a teacher's own
 * application comes through project upload), and every surface says so.
 *
 * Three properties, as at the head of this file:
 *
 * **The vocabulary says `reference`, never a project's slug.** The web's
 * codebase guard refuses a quoted project slug in `lib/`,
 * `components/` and `app/`, and every provenance switch the web writes
 * compares against one of the values below. The name a person reads comes
 * from the payload, `PhaseProvenanceView.referenceName`, `application`,
 * `VersionProvenanceView.applicationFrom`, and is the registry title before
 * its em dash, never a literal in a client.
 *
 * **The caps are the content loader's own** wherever the loader has one
 * so the door and the loader refuse exactly the same interview, and a
 * teacher who re-saves the interview they copied keeps it byte for byte.
 *
 * **Answers never ride the draft.** `DraftInterviewView` has no place for a
 * fact's answer or its keywords, for the reason `AuthoredQuizView` has no
 * key; the whole brief is `interview.read`'s alone.
 * ========================================================================== */

/* -------------------------------- the caps --------------------------------- */

/** A phase's intro, as `phases.update` accepts it: written, ungraded, and never model input. */
export const PHASE_INTRO_MAX = 2000;

/** A task's own caps, one set read by the authoring DTO and the builder's task cards. */
export const TASK_TITLE_MAX = 160;
export const TASK_BRIEF_MAX = 20000;
export const TASK_OBJECTIVES_MAX = 20;
export const TASK_OBJECTIVE_MAX = 300;

/**
 * The most of a phase's intro that `PhaseSummary.intro` carries. A
 * summary rides every `EnrollmentView`, so it carries the intro's opening cut
 * at this many characters; the whole intro stays on `PhaseDetail.intro`.
 */
export const PHASE_SUMMARY_INTRO_MAX = 400;

/**
 * The one phase an interview can sit on. The content loader drops a brief on
 * every other phase (`content.service.ts` `loadInterview`), so the three
 * interview routes name it in their path rather than take a `:phaseKey` they
 * would have to refuse.
 */
export const INTERVIEW_PHASE: Extract<PhaseKey, 'requirements'> = 'requirements';

// The interview's caps. The first five are the content loader's own rules
// (`loadInterview`, `loadInterviewFacts`): the door and the loader refuse the
// same briefs. A string is stored as sent once it is not blank, exactly
// as the loader keeps it, so the reference interview re-saved unchanged is the
// reference interview still.

/** A fact's topic, at most: the loader's 80. */
export const INTERVIEW_TOPIC_MAX = 80;

/** A fact's answer, at most: the loader's 1,200. */
export const INTERVIEW_ANSWER_MAX = 1200;

/** A fact id: the loader's pattern, and short enough to print in a data-testid. */
export const INTERVIEW_FACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

/** At least one fact, and at most this many: the loader's 20. */
export const INTERVIEW_MAX_FACTS = 20;

/** `maxTurns` is an integer from this... */
export const INTERVIEW_MAX_TURNS_MIN = 1;

/**
 * ...to this, the loader's cap. `factsExpected` is an integer from 1 to the
 * number of facts, which is the loader's rule too.
 */
export const INTERVIEW_MAX_TURNS_CAP = 40;

/**
 * The persona's name, at most. The authored interview prints it through
 * `fencedLine(…, 80)`, so a longer one would be cut there; it is refused
 * here instead.
 */
export const INTERVIEW_PERSONA_NAME_MAX = 80;

/** The persona's role, at most: `fencedLine(…, 160)`, for the same reason. */
export const INTERVIEW_PERSONA_ROLE_MAX = 160;

// The loader caps none of the rest. These are the authoring DTO's caps,
// each well above the reference interview's own lengths.

/** `opening`, `unknownReply` and `refusal`, each at most. */
export const INTERVIEW_LINE_MAX = 1000;

/** A fact's keywords: at least one (the loader's rule), and at most this many... */
export const INTERVIEW_KEYWORDS_MAX = 12;

/** ...each at most this long. */
export const INTERVIEW_KEYWORD_MAX = 60;

/** The characters one `files.replace` may write. */
export const REPLACE_FILE_CONTENT_MAX = 200000;

/** A reworded criterion's title, at most. */
export const CRITERION_TITLE_MAX = 120;

/** A reworded criterion's description, at most. */
export const CRITERION_DESCRIPTION_MAX = 500;

/**
 * A criterion's description in a rubric replaced whole (a story or design
 * task's, `RubricDto`), at most. The Design conversion holds every converted
 * description to this cap (a teacher's longer wording is cut at a sentence
 * end, and the note says so), so a converted rubric saves back unchanged.
 * `CRITERION_DESCRIPTION_MAX` is the rewording door's, a different one. The
 * content checker holds every pack's descriptions to this cap too.
 */
export const RUBRIC_CRITERION_DESCRIPTION_MAX = 400;

/**
 * A criterion's title in a rubric replaced whole (`RubricDto`), at most. The
 * content checker holds every pack's titles to it, as it holds descriptions to
 * `RUBRIC_CRITERION_DESCRIPTION_MAX`, so a pack's own rubric saves back
 * through the editor unchanged.
 */
export const RUBRIC_CRITERION_TITLE_MAX = 120;

/** The longest criterion key the editor's Criteria step saves; the loader holds every pack to it. */
export const RUBRIC_CRITERION_KEY_MAX = 48;

/** The most criteria the editor's Criteria step saves; the loader holds every pack to it. */
export const RUBRIC_CRITERIA_MAX = 40;

/**
 * Why one rubric does not fit what the editor's Criteria step saves, one
 * phrase per breach, empty when it fits: a key, title or description over its
 * cap (counted in UTF-16 code units, never fewer than the editor counts), more
 * than `RUBRIC_CRITERIA_MAX` criteria, or a pass mark that is not a whole
 * number from 1 to 100. The loader refuses an upload with these and the
 * content checker reports a shipped pack with them, so a pack's own rubric
 * always saves back through the editor unchanged.
 */
export function rubricCapBreaches(rubric: {
  passThreshold: number;
  criteria: readonly { key: string; title: string; description?: string }[];
}): string[] {
  const out: string[] = [];
  if (!Number.isInteger(rubric.passThreshold) || rubric.passThreshold < 1 || rubric.passThreshold > 100) {
    out.push(`the rubric pass mark is ${rubric.passThreshold}; the editor saves a whole number from 1 to 100`);
  }
  if (rubric.criteria.length > RUBRIC_CRITERIA_MAX) {
    out.push(`the rubric holds ${rubric.criteria.length} criteria; the editor saves at most ${RUBRIC_CRITERIA_MAX}`);
  }
  for (const c of rubric.criteria) {
    if (c.key.length > RUBRIC_CRITERION_KEY_MAX) {
      out.push(`the rubric key "${c.key}" is ${c.key.length} characters; the editor saves at most ${RUBRIC_CRITERION_KEY_MAX}`);
    }
    if (c.title.length > RUBRIC_CRITERION_TITLE_MAX) {
      out.push(`the rubric title of "${c.key}" is ${c.title.length} characters; the editor saves at most ${RUBRIC_CRITERION_TITLE_MAX}`);
    }
    // a description may be absent
    const description = c.description ?? '';
    if (description.length > RUBRIC_CRITERION_DESCRIPTION_MAX) {
      out.push(`the rubric description of "${c.key}" is ${description.length} characters; the editor saves at most ${RUBRIC_CRITERION_DESCRIPTION_MAX}`);
    }
  }
  return out;
}

/* ------------------------------ the provenance ----------------------------- */

/**
 * Where one element of a phase came from.
 *
 * - `reference`: still the reference project's, byte for byte. For a task,
 *   its reference anchor still matches; for an intro, an interview or a file,
 *   its recorded digest still matches.
 * - `own`: the teacher's. A task they added; an intro, interview or file they
 *   wrote or replaced. Replacing a file with the reference's own bytes again
 *   makes it `reference` again, because the digest is what decides.
 * - `edited`: **tasks only.** A task whose key came with the copy and whose
 *   anchor no longer matches, the teacher rewrote its brief, objectives,
 *   rules or criterion wording.
 */
export const ELEMENT_PROVENANCE_STATES = ['reference', 'own', 'edited'] as const;

export type ElementProvenance = (typeof ELEMENT_PROVENANCE_STATES)[number];

/** An intro, an interview or a file: the reference's or the teacher's, never `edited`. */
export type WrittenElementProvenance = Exclude<ElementProvenance, 'edited'>;

/**
 * A phase's roll-up of its elements.
 *
 * - `reference`: every element is the reference project's.
 * - `own`: no element is. An `edited` task counts as the teacher's here,
 *   because its anchor no longer matches.
 * - `mixed`: anything between, which is also every phase whose application
 *   is the reference's while its intro is the teacher's.
 */
export const PHASE_PROVENANCE_ROLLUPS = ['reference', 'mixed', 'own'] as const;

export type PhaseProvenanceRollup = (typeof PHASE_PROVENANCE_ROLLUPS)[number];

/**
 * The phase's room task: the task that owns the structured record the room
 * builds from a learner's work (`requirements/story.json` in Requirements).
 *
 * - `reference`: that task is still the reference project's, by its anchor, so
 *   the room's reference scaffolding is still true of it.
 * - `other`: a task owns the record and it is not the reference's.
 * - `none`: no task owns it, so the room has no desk to draw.
 */
export const ROOM_TASK_PROVENANCES = ['reference', 'other', 'none'] as const;

export type RoomTaskProvenance = (typeof ROOM_TASK_PROVENANCES)[number];

/** One read-only file a written phase mounts, and whose it is. */
export interface FileProvenanceView {
  path: string;
  provenance: WrittenElementProvenance;
}

/** One task of the phase, and whose it is. */
export interface TaskProvenanceView {
  taskKey: string;
  provenance: ElementProvenance;
  /**
   * The task's title differs from the one it came with. Marked and never
   * counted: no reference prompt reads a task's title, so a retitled task
   * keeps its `provenance`, and its learners keep the reviewer bound to it.
   * False on a task the teacher added.
   */
  titleEdited: boolean;
}

/**
 * One phase's provenance: what in it is still the reference project's, and
 * what is the teacher's.
 *
 * Computed only from the version's own pinned content, never from a
 * learner's accepted screen copy laid over it, and never carrying a
 * digest or a sealed byte.
 */
export interface PhaseProvenanceView {
  phaseKey: PhaseKey;
  /**
   * The reference project's name as a person reads it: its registry title
   * before the em dash. What a chip says is "{referenceName}'s", and it is
   * never a slug.
   *
   * Null when the phase holds nothing of the reference project (its rollup is
   * 'own'), so an own project's payload never names it.
   */
  referenceName: string | null;
  rollup: PhaseProvenanceRollup;
  /** The phase's intro. Every phase has one, and every phase's is the teacher's to write. */
  intro: WrittenElementProvenance;
  /** The stakeholder interview, or null where the phase holds none. */
  interview: WrittenElementProvenance | null;
  /**
   * Each read-only file the phase mounts, by path: the provided backlog and
   * `design/architecture.md` in the reference project. A starter a task owns
   * is not listed here: it is part of that task's provenance, because the
   * task's anchor hashes its owned baselines. Empty on a phase whose files are
   * an application's, which `application` speaks for instead.
   *
   * Only rows a learner reads are listed: the resolver filters by
   * `isAuthoringReadableRole`, so the path of a sealed row (every role in
   * `SEALED_FILE_ROLES`, the interview brief's among them) or of a `canonical`
   * row never appears here. This view rides `PhaseDetail` to learners; it
   * carries paths and provenance, never bytes or digests.
   */
  files: FileProvenanceView[];
  /** Every task of the phase, in order. */
  tasks: TaskProvenanceView[];
  roomTask: RoomTaskProvenance;
  /**
   * Implementation, Testing, Deployment and Maintenance only: the name of the
   * application whose code, hidden tests, deployment and maintenance this
   * phase runs, the reference project's while its files still match the
   * recorded application digest (the accepted screen copy excluded), and null
   * if they ever do not. Absent on a written phase.
   */
  application?: string | null;
}

/** A version's provenance in one line: what the class card says before a teacher assigns it. */
export interface VersionProvenanceView {
  /** Written phases whose roll-up is `own`. */
  ownPhases: number;
  /** Written phases whose roll-up is `mixed`. */
  mixedPhases: number;
  /** Written phases whose roll-up is `reference` (never keyed by a slug). */
  referencePhases: number;
  /**
   * The name of the application the last four phases run: the reference
   * project's while every one of them reads that name in `application`, and
   * null otherwise.
   */
  applicationFrom: string | null;
}

/* ------------------------------ the interview ------------------------------ */

/** One fact of the interview as the draft shows it: its id and its topic. Never its answer. */
export interface DraftInterviewFactView {
  id: string;
  /** A short label for what the fact settles. Shown to a learner too; the answer is not. */
  topic: string;
}

/**
 * The stakeholder interview as any instructor who can see the draft reads it:
 * who the stakeholder is, how they open, the limits, and each fact's
 * topic. No answers, no keywords, and no `unknownReply` or `refusal`: the
 * whole brief is `interview.read`'s, owner-only and audited.
 */
export interface DraftInterviewView {
  persona: { name: string; role: string };
  opening: string;
  /** Questions a learner may ask, `INTERVIEW_MAX_TURNS_MIN`..`INTERVIEW_MAX_TURNS_CAP`. */
  maxTurns: number;
  /** Facts worth settling before the story is written: 1 to the number of facts. */
  factsExpected: number;
  facts: DraftInterviewFactView[];
}

/** The stakeholder: a name of at most `INTERVIEW_PERSONA_NAME_MAX` and a role of at most `INTERVIEW_PERSONA_ROLE_MAX`. */
export interface InterviewPersonaBody {
  name: string;
  role: string;
}

/** One thing the stakeholder knows, and the words that ask for it. */
export interface InterviewFactBody {
  /** `INTERVIEW_FACT_ID_PATTERN`, and unique within the interview. */
  id: string;
  /** At most `INTERVIEW_TOPIC_MAX` characters. */
  topic: string;
  /** One to `INTERVIEW_KEYWORDS_MAX`, each at most `INTERVIEW_KEYWORD_MAX` characters. */
  keywords: string[];
  /** At most `INTERVIEW_ANSWER_MAX` characters. Sealed: never on the draft. */
  answer: string;
}

/**
 * The whole interview, as `interview.replace` takes it and `interview.read`
 * answers it: the content loader's shape, field for field.
 *
 * Written whole because it is one document: a persona and the facts they
 * know are one edit. Every string is required and not blank, and is stored as
 * sent. The door validates it with the loader's own rules, so a brief the
 * content loader would refuse is refused here in the loader's words.
 */
export interface InterviewBody {
  persona: InterviewPersonaBody;
  /** What the stakeholder says before the first question. At most `INTERVIEW_LINE_MAX`. */
  opening: string;
  /** What they say about something the facts do not cover. At most `INTERVIEW_LINE_MAX`. */
  unknownReply: string;
  /** What they say when asked to write the artefact. At most `INTERVIEW_LINE_MAX`. */
  refusal: string;
  maxTurns: number;
  factsExpected: number;
  /** One to `INTERVIEW_MAX_FACTS`. */
  facts: InterviewFactBody[];
}

/* ------------------------------ the other bodies --------------------------- */

/**
 * `phases.update`'s body: the intro, one to `PHASE_INTRO_MAX` characters.
 * The title is not a member: a phase's title stays as the project has it.
 */
export interface UpdatePhaseBody {
  intro: string;
}

/**
 * `files.replace`'s body: which file, and its new bytes (at most
 * `REPLACE_FILE_CONTENT_MAX` characters).
 *
 * The path must be one the phase already mounts; a replace never adds a file,
 * and a role is not a member because a row's role never changes. The door
 * refuses, each in one sentence: any phase whose files are an application's
 * (`applicationFileRefusal`), a sealed or canonical row
 * (`withheldFileReplaceRefusal`), a path the phase does not mount
 * (`fileNotMountedRefusal`) and a structured record a task owns
 * (`roomRecordRefusal`), except a design task's documents, which are its
 * Starting point and are replaced validated. A read-only document several written phases mount,
 * the provided backlog, is one document, and is replaced in every one of
 * them in the same transaction.
 */
export interface ReplaceFileBody {
  path: string;
  /** The new bytes. Absent only beside `reset`. */
  content?: string;
  /**
   * `'source'`: put back the bytes the version this draft was opened from
   * holds at the path (`forkedFromVersionId`: the version a copy was made
   * from, or the head a new draft opened from). Taken only for a design
   * task's documents and for a Deployment's starting runbook or a
   * Maintenance's starting change request; a design record in the board's
   * older shape is folded into the schema first.
   */
  reset?: 'source';
}

/** One criterion's new wording: its existing key, a title and a description. Never a weight. */
export interface CriterionWordingBody {
  key: string;
  title: string;
  description: string;
}

/**
 * What `phases.update`, `interview.replace` and `interview.remove` answer: the
 * phase as it now reads, and the fast tier re-run on the save. The same shape
 * every task write answers, so the editor treats a save one way.
 */
export type PhaseMutationResult = TaskMutationResult;

/** What `files.replace` answers. */
export interface ReplaceFileResult extends TaskMutationResult {
  /**
   * The other written phases whose row at the same path was replaced in the
   * same transaction, because it is one document. Empty for a file only this
   * phase mounts.
   */
  alsoReplacedIn: PhaseKey[];
}

/* ------------------------------ the sentences ------------------------------ */

/**
 * What the last four phases of a copy are, said in the editor beside them and
 * in the validation report's application row (a `passed`
 * row that carries this sentence). `application` is
 * `PhaseProvenanceView.application`, never a literal.
 */
export function applicationPhasesSentence(application: string): string {
  return `Implementation, Testing, Deployment and Maintenance are ${application}'s application: its code, hidden tests, deployment and maintenance. Your own application arrives with project upload, and your own code tasks with teacher code tasks.`;
}

/** `files.replace`, refused on a phase whose files are an application's. */
export function applicationFileRefusal(application: string): string {
  return `Implementation, Testing, Deployment and Maintenance are ${application}'s application until project upload arrives, so their files cannot be replaced here.`;
}

/**
 * `files.replace`, refused on a row whose bytes an authoring response never
 * carries: every sealed role, and the finished application
 * (`isAuthoringReadableRole`).
 */
export function withheldFileReplaceRefusal(path: string): string {
  return `"${path}" is withheld from this editor, so its bytes cannot be replaced here. Only a file a learner reads can be replaced.`;
}

/** `files.replace`, refused on a path the phase does not mount. A replace never adds a file. */
export function fileNotMountedRefusal(path: string, phaseTitle: string): string {
  return `${phaseTitle} has no file at "${path}". Replace a file this phase already mounts: its path and its role stay as they are.`;
}

/*
 * The runbook arm's and the Maintenance members' refusals. "Only Deployment
 * carries a runbook." and "Only Maintenance carries a ticket and a change
 * request." are the records' own (`ONLY_DEPLOYMENT_RUNBOOK`,
 * `ONLY_MAINTENANCE_CHANGE`), read by the loader and these doors alike.
 */

/**
 * The rubric keys the grader scores from a fixed set of literals, by
 * `checks.kind`: `code` and `tests` phases are scored in the API's
 * `feedback.service.ts` (`buildCodeReport`, `buildTestsReport`). Maintenance's
 * builder locks the four `code` keys. A rubric key the grader never sets reads
 * as a real zero with no evidence, so the API's loader holds each pack's
 * rubric against this set at boot (re-exported there from `content.service.ts`).
 */
export const FIXED_SCORER_KEYS: Readonly<Record<'code' | 'tests', readonly string[]>> = {
  code: ['correctness_hidden', 'visible_tests', 'code_quality', 'process'],
  tests: ['tests_pass', 'mutants_killed', 'coverage_mapping'],
};

/**
 * The criterion the build check scores itself on a config phase, beside the
 * rule-driven ones (`buildConfigReport`). Deployment's builder locks it; the
 * API's `content.service.ts` re-exports it, so there is one literal.
 */
export const CONFIG_SMOKE_KEY = 'build_smoke';

/** `tasks.update` on Deployment's config task, refused on any member but its words, rubric, runbook floor and sign-off mark. */
export const DEPLOYMENT_UPLOAD_ONLY = "Deployment's files, rules, smoke run and drill change only when the project is uploaded again.";
/** A Maintenance task carrying neither yet takes its ticket and its change request in one save. */
export const TICKET_WITH_CHANGE = 'Save the ticket and the change request together the first time: a change request reads its ticket.';
/** A Deployment rubric with nothing beside its locked keys. */
export const NO_RUNBOOK_CRITERION = 'The rubric needs at least one runbook criterion: a key no file rule claims that is not build_smoke.';
/** A Maintenance rubric with nothing beside its four fixed keys. */
export const NO_CHANGE_CRITERION = 'The rubric needs at least one change criterion: a key other than correctness_hidden, visible_tests, code_quality and process.';

/** A ticket edit dropping an acceptance id the starting change request covers (at most `CHANGE_CAPS.acceptanceId` characters of the id). */
export function ticketCoveredRefusal(id: string): string {
  return `${id.slice(0, CHANGE_CAPS.acceptanceId)} is covered in the starting change request. Remove it there first.`;
}

/** "Reset to the pack's" on a starting record the source version does not mount. */
export function noSourceRecordRefusal(path: string): string {
  return `The version this draft came from has no starting ${path === RUNBOOK_JSON ? 'runbook' : 'change request'}. Start empty, or edit this one.`;
}

/**
 * Words for the keys the grader scores itself, for a sentence where the
 * criterion's own title is not at hand. A teacher reads these, so a key is
 * never the name: not "correctness_hidden is graded by ...".
 */
const LOCKED_CRITERION_WORDS: Readonly<Record<string, string>> = {
  correctness_hidden: 'Hidden tests',
  visible_tests: 'Visible tests',
  code_quality: 'Code quality',
  process: 'Process',
  tests_pass: 'Tests pass',
  mutants_killed: 'Mutants killed',
  coverage_mapping: 'Criteria coverage',
  [CONFIG_SMOKE_KEY]: 'The isolated selfcheck',
};

/**
 * A rubric missing, or a row keeping, a key the phase's own checks grade. Named
 * by the criterion's title when the caller has it (the saved rubric's row, the
 * row on screen), else by the words above for the grader's fixed keys, else by
 * the key itself, quoted as a name (at most 48 characters; a file rule's key has
 * no other name the shared package knows).
 */
export function lockedCriterionRefusal(key: string, title?: string | null): string {
  const named = title?.trim() || LOCKED_CRITERION_WORDS[key];
  return named
    ? `${named.slice(0, RUBRIC_CRITERION_TITLE_MAX)} is graded by the phase's own checks, so it stays in the rubric.`
    : `The criterion "${key.slice(0, RUBRIC_CRITERION_KEY_MAX)}" is graded by the phase's own checks, so it stays in the rubric.`;
}

/** Implementation's and Testing's rubric keys are the grader's own: a key outside them has nothing to score it. */
export function fixedCriteriaRefusal(phase: 'Implementation' | 'Testing'): string {
  return `${phase} is scored by its fixed criteria. Change their sentences and weights; a new criterion has nothing to score it.`;
}

/**
 * `files.replace`, refused on a structured record the room builds from a
 * learner's work and a task is graded on (`story.json`, and the design
 * documents of a Design task still in the older format). An editable record
 * always has an owner, so this is always the answer for one. A design task's
 * documents (`design.json` and each contract switched on) are its Starting
 * point instead: the door replaces them, each validated as the room validates
 * it, and refuses a malformed one in that validator's sentence.
 */
export function roomRecordRefusal(path: string, taskTitle: string): string {
  return `"${path}" is the record the room builds from a learner's work for "${taskTitle}", so it cannot be replaced here.`;
}

/**
 * `files.replace`, refused on a contract a design task's phase still mounts
 * while the task's switch for it is off (only rows written by hand reach this:
 * the builder's switch removes the row). The compile refuses the same phase.
 */
export function designContractOffRefusal(contract: 'API' | 'screen'): string {
  return `The ${contract} contract is switched off for this task; turn it on in step 3 or remove the file.`;
}

/**
 * Beside a replaceable read-only document in the editor. The authored
 * reviewer binds a reference file only when a task's brief names its path, so
 * a teacher's own document is otherwise never read.
 */
export function referenceFileBriefNote(path: string): string {
  return `The reviewer reads "${path}" only when a task brief names it, so name this path in the brief of the task it serves.`;
}
