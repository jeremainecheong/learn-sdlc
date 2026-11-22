import {
  INHERITED_TASK_KEY,
  SOLE_TASK_KEY,
  plainTextOf,
  type ElementProvenance,
  type PhaseProvenanceRollup,
  type PhaseProvenanceView,
  type RoomTaskProvenance,
  type VersionProvenanceView,
  type WrittenElementProvenance,
} from '@learnsdlc/shared';
import { canonicalJson, sha256Hex } from '../content/blob.store';
import type { ContentService } from '../content/content.service';
import { referencePackOnDisk } from '../content/reference-pack-disk';
import type { PhaseChecks, PhaseContent } from '../content/content.types';
import type { CompiledTask } from '../content/pack-compiler';
import { isQuizTask } from '../content/pack-compiler';
import {
  isReferenceApplication,
  isReferenceFile,
  isReferenceInterview,
  isReferenceIntro,
  referenceNameOf,
  referencePacks,
} from '../content/reference-content';
import { isReferenceTaskAnchor, phaseRoomTaskKeyOf } from '../assistant/project-scope';
import { isApplicationPhase } from './draft';

/**
 * One provenance resolver.
 *
 * What in one phase is still the reference project's, and what is the
 * teacher's, per element: a pure function of the phase's **pinned** content
 * and its compiled tasks. Every reader (the draft, the class card, the
 * learner's phase summary and detail, the export) asks it, so the editor's
 * chips, the class card's sentence and the learner's switch are one answer.
 *
 * **Only ever asked of the pinned base.** A learner's phase is served
 * through `withScreenCopy`, which rewrites the accepted screen copy's bytes;
 * callers pass `content.getForEnrollment(enrollment).phases`, the registry's
 * identity-stable object, never the overlaid phase. The application digest
 * leaves the overlay's files out besides, so even a wrong caller reads the
 * same answer, but pays the hash on every call, because the overlay is a new
 * object each time.
 *
 * **The vocabulary is `reference`, never a project slug.**
 * The name a person reads is `referenceName`, the registry title before its em
 * dash.
 *
 * **Never a digest, never a byte, never a sealed path.** `files` lists the
 * read-only workspace files a written phase mounts, by path. A phase's files
 * are the rows `phaseFilesFrom` built from `workspace` rows alone, so a sealed
 * or canonical row can never appear (only rows
 * `isAuthoringReadableRole` admits).
 */

/** The keys an inherited task carries: the reference pack's own sole task, and a copy's. */
const INHERITED_KEYS = new Set<string>([INHERITED_TASK_KEY, SOLE_TASK_KEY]);

interface Remembered {
  tasks: readonly CompiledTask[];
  name: string;
  view: PhaseProvenanceView;
}

const memo = new WeakMap<PhaseContent, Remembered>();

const same = (held: Remembered, tasks: readonly CompiledTask[], name: string): boolean =>
  held.name === name && held.tasks.length === tasks.length && held.tasks.every((task, at) => task === tasks[at]);

/**
 * One phase's provenance. `tasks` is the phase's compiled task list, of the
 * same version as `phase` (`getTasksForEnrollment`, or a draft's compiled
 * snapshot). Memoised by the phase object and the identity of its tasks,
 * which is what makes it cheap on the learner's hot reads.
 */
export function phaseProvenance(
  phase: PhaseContent,
  tasks: readonly CompiledTask[],
  referenceName: string,
): PhaseProvenanceView {
  const held = memo.get(phase);
  if (held && same(held, tasks, referenceName)) return held.view;
  const view = resolve(phase, tasks, referenceName);
  memo.set(phase, { tasks: [...tasks], name: referenceName, view });
  return view;
}

/* -------- the sealed side of "the reference's application" -------- */

/**
 * `<phaseKey>|<sha256>` over one executable phase's checks **and the words its
 * learner reads** (the compiled `taskPanel` and `objectives`, which the sole
 * work task's brief and objectives land on) as a key. A copy
 * whose implementation brief a teacher rewrote is graded by the reference's
 * suite against the teacher's words, so it is not the reference's application:
 * the phase reads mixed and publish asks for the deep receipt.
 * The title is left out, as the exec anchor leaves it out and a retitle is
 * marked without being counted (`titleEdited`). So are a Deployment's runbook
 * and a Maintenance's ticket and change request.
 */
export function executableDigestKey(phase: Pick<PhaseContent, 'key' | 'checks' | 'taskPanel' | 'objectives'>): string {
  const words = { taskPanel: phase.taskPanel ?? '', objectives: phase.objectives ?? [] };
  // the runbook, the change ticket and the change request are the teacher's to edit without a deep run
  const { runbook: _runbook, ticket: _ticket, change: _change, ...checks } = phase.checks as PhaseChecks & { runbook?: unknown; ticket?: unknown; change?: unknown };
  return `${phase.key}|${sha256Hex(canonicalJson({ checks, ...words }))}`;
}

/** The keys a reference phase answers to: its words as stored, and as `plainTextOf` makes them, so a
 *  converted copy reads as the reference's own and its bridge notice and deep-run ask are unchanged. */
export function referenceExecutableKeys(phase: Pick<PhaseContent, 'key' | 'checks' | 'taskPanel' | 'objectives'>): string[] {
  const plain = { ...phase, taskPanel: plainTextOf(phase.taskPanel ?? ''), objectives: (phase.objectives ?? []).map(plainTextOf) };
  return [...new Set([executableDigestKey(phase), executableDigestKey(plain)])];
}

const REFERENCE_EXECUTABLE = new Set<string>();
let diskRead = false;

/**
 * Executable-phase keys known to be the reference project's: every published
 * reference version the authoring service has read (`rememberReferenceExecutable`)
 * and, read once and lazily, the reference pack on this deployment's disk.
 */
export function rememberReferenceExecutable(keys: Iterable<string>): void {
  for (const key of keys) REFERENCE_EXECUTABLE.add(key);
}

function knownReferenceExecutable(): ReadonlySet<string> {
  // The pack on this disk, once it has been read (`referencePackOnDisk` retries
  // a failed read at most once a minute, and loads it once for every reader).
  if (!diskRead) {
    const disk = referencePackOnDisk();
    if (disk) {
      if (disk.project) rememberReferenceExecutable(disk.project.phases.filter((one) => isApplicationPhase(one)).flatMap(referenceExecutableKeys));
      diskRead = true;
    }
  }
  return REFERENCE_EXECUTABLE;
}

/**
 * Whether an application phase is the reference project's application:
 * its workspace (`isReferenceApplication`) **and** its checks (the hidden
 * suite, the solution, the mutants, the smoke) so a copy whose sealed side a
 * teacher edited never reads as the reference's (false-proof bridge notice).
 * With no reference checks known at all it answers no, as publish's predicate
 * does: a missing reference pack costs a bridge notice, never
 * names the reference for bytes nobody compared.
 */
export function isReferenceApplicationPhase(phase: PhaseContent): boolean {
  if (!isReferenceApplication(phase)) return false;
  return knownReferenceExecutable().has(executableDigestKey(phase));
}

function resolve(phase: PhaseContent, tasks: readonly CompiledTask[], referenceName: string): PhaseProvenanceView {
  const ordered = [...tasks].sort((a, b) => a.order - b.order);
  const application = isApplicationPhase(phase);
  const applicationName = application ? (isReferenceApplicationPhase(phase) ? referenceName : null) : undefined;

  const intro: WrittenElementProvenance = isReferenceIntro(phase.key, phase.intro) ? 'reference' : 'own';
  const interview: WrittenElementProvenance | null = phase.interview
    ? isReferenceInterview(phase.interview)
      ? 'reference'
      : 'own'
    : null;
  const files = application
    ? []
    : (phase.files ?? [])
        .filter((file) => !file.editable)
        .map((file) => ({
          path: file.path,
          provenance: (isReferenceFile(phase.key, file.path, file.content) ? 'reference' : 'own') as WrittenElementProvenance,
        }));

  const taskState = (task: CompiledTask): ElementProvenance => {
    const inherited = INHERITED_KEYS.has(task.taskKey) && !isQuizTask(task);
    if (application) {
      // An application phase's inherited task is the application's; its
      // anchor is not asked (anchors cover only written tasks). Anything else in
      // it (a quiz a teacher added) is theirs.
      return inherited ? (applicationName ? 'reference' : 'edited') : 'own';
    }
    if (isReferenceTaskAnchor(phase, task)) return 'reference';
    return inherited ? 'edited' : 'own';
  };
  const states = new Map(ordered.map((task) => [task.taskKey, taskState(task)]));
  const taskViews = ordered.map((task) => ({
    taskKey: task.taskKey,
    provenance: states.get(task.taskKey)!,
    // A retitle is marked, never counted. The inherited task came with
    // the phase's own title (`soleTaskFor`), and phase titles are fixed,
    // so a different title is the teacher's.
    titleEdited: INHERITED_KEYS.has(task.taskKey) && !isQuizTask(task) && task.title !== phase.title,
  }));

  const roomKey = phaseRoomTaskKeyOf(phase.key, ordered.filter((task) => !isQuizTask(task)));
  const roomTask: RoomTaskProvenance =
    roomKey === null ? 'none' : states.get(roomKey) === 'reference' ? 'reference' : 'other';

  const elements: boolean[] = [
    intro === 'reference',
    ...(interview === null ? [] : [interview === 'reference']),
    ...files.map((file) => file.provenance === 'reference'),
    ...taskViews.map((task) => task.provenance === 'reference'),
    ...(application ? [applicationName !== null] : []),
  ];
  const rollup: PhaseProvenanceRollup = elements.every(Boolean)
    ? 'reference'
    : elements.some(Boolean)
      ? 'mixed'
      : 'own';

  return {
    phaseKey: phase.key as PhaseProvenanceView['phaseKey'],
    // The reference
    // project's name rides a phase only while something in it is still the
    // reference's. An `own` phase (every phase of an uploaded project, and a
    // copy's phase the teacher rewrote whole) carries null, so no learner
    // body names the platform's project. A reference or mixed phase keeps it:
    // the chip "{referenceName}'s" reads it. On an application phase this is
    // exactly `application !== referenceName`.
    referenceName: rollup === 'own' ? null : referenceName,
    rollup,
    intro,
    interview,
    files,
    tasks: taskViews,
    roomTask,
    ...(application ? { application: applicationName ?? null } : {}),
  };
}

/**
 * A version's provenance in one line (the class card): the written phases'
 * roll-ups counted, and the application the last four phases run: the
 * reference's while every application phase reads its name, null otherwise.
 */
export function versionProvenance(phases: readonly PhaseProvenanceView[]): VersionProvenanceView {
  const written = phases.filter((view) => view.application === undefined);
  const applications = phases.filter((view) => view.application !== undefined);
  const first = applications[0]?.application ?? null;
  return {
    ownPhases: written.filter((view) => view.rollup === 'own').length,
    mixedPhases: written.filter((view) => view.rollup === 'mixed').length,
    referencePhases: written.filter((view) => view.rollup === 'reference').length,
    applicationFrom: first !== null && applications.every((view) => view.application === first) ? first : null,
  };
}

/**
 * The reference project's name as a person reads it, from the registry title
 * of the pack the scenario table records. Never a slug, never a
 * literal; a registry that does not hold the pack answers the generic name.
 */
export function referenceNameFrom(content: Pick<ContentService, 'getProject'>): string {
  const [slug] = referencePacks();
  try {
    return referenceNameOf(slug ? content.getProject(slug).title : null);
  } catch {
    return referenceNameOf(null);
  }
}

/**
 * Every phase of one resolved version, and its one-line summary. `tasksOf`
 * answers a phase's compiled tasks of the same version.
 */
export function projectProvenance(
  phases: readonly PhaseContent[],
  tasksOf: (phase: PhaseContent) => readonly CompiledTask[],
  referenceName: string,
): { phases: PhaseProvenanceView[]; version: VersionProvenanceView } {
  const views = phases.map((phase) => phaseProvenance(phase, tasksOf(phase), referenceName));
  return { phases: views, version: versionProvenance(views) };
}
