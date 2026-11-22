import {
  ARTEFACT_TYPES,
  EXECUTABLE_SPLIT_NOT_READY,
  SOLE_TASK_KEY,
  artefactTypeFor,
  designDocumentPaths,
  mountedSwitchedOffContract,
  isAuthoredTaskKey,
  splittableCheckKind,
  type ArtefactType,
  type ArtifactKind,
  type PhaseKey,
  type PhaseRubric,
  type ProjectVersionStatus,
} from '@learnsdlc/shared';
import { digestOf } from './blob.store';
import type {
  FileRule,
  PhaseChecks,
  PhaseContent,
  ProjectContent,
} from './content.types';
import { SCREEN_CONTRACT_PATH } from './screen-copy';

/**
 * The pack compiler.
 *
 * Rows are the editable truth and this is what the runtime reads: one
 * immutable snapshot per published version, holding the `ProjectContent` the
 * loader builds from a pack, the tasks each phase compiles to, and the
 * microVM price of one full pass. `ContentService` then answers every phase
 * load, run and grading out of the snapshot instead of walking a directory.
 *
 * Two things it is not. It is not a second validator: the twenty-odd checks a
 * pack is held to run in the loader, and a pack that does
 * not load never reaches here. And it is not a place a rule may be weakened:
 * every rule below is a **publish** refusal in the loader's own style, a
 * sentence naming the phase and the field. A phase with one task passes every
 * split rule untouched, so the imported default project compiles cleanly.
 *
 * The rules live with the model rather than with the editor, so that whatever
 * surface splits a phase, the shapes that cannot be graded are unpublishable:
 * a task nothing scores (`runsFor` fails open on an empty subset), a phase-wide test
 * threshold neither of two tasks can read, an incident drill two tasks would
 * each pay a microVM for.
 */

/* --------------------------------- shapes --------------------------------- */

/**
 * Which build's compile rules produced a snapshot.
 *
 * A published version keeps the snapshot it was published with, for ever: that
 * is the pin's guarantee, and recompiling one in place would move the ground
 * under an attempt. The cost of that promise is that a deployment whose *code*
 * has moved on serves snapshots its own compiler would not produce, and
 * without this constant the only sign of it would be a log line at boot,
 * which is to say, no sign at all on a machine nobody is tailing.
 *
 * So the identity travels with the snapshot, `ProjectRegistryService` compares
 * it against this build's as it installs, and the answer is a readiness detail
 * and a line the import CLI prints. **Bump it whenever a change to this file
 * would make `compilePack` produce a different snapshot from the same pack**:
 * the derivations, the budget, the task shape. A rule that only refuses does
 * not change a snapshot and does not need a bump.
 */
export const COMPILER_IDENTITY = 'block1.pack-compiler.1';

/**
 * The path prefixes a version's own rows are stored under, and which a learner
 * file therefore cannot be mounted at.
 *
 * `project_files` is keyed `UNIQUE (projectVersionId, ownerId, path)`, and a
 * phase's sealed material is stored under its own directory inside the same
 * owner: `hidden/`, `solution/`, `reference/`, `drill/`, one `mutants/<name>/`
 * per mutant and `interview/brief.json`
 * (`importer.service.ts`'s `SEALED_ROW_DIRECTORY` and its two neighbours). A
 * pack mounting a workspace file at `hidden/test_tasks.py` therefore collides
 * with the row holding that phase's hidden suite: one insert would fail on
 * the natural key, and the interesting half is the other one: a collision is
 * two different roles arguing over one row, which the importer's two byte
 * rules (no hidden-test bytes in a workspace row, no solution bytes in an
 * editable one) exist to rule out.
 *
 * No pack this platform ships is near the rule; it is the wall for teacher
 * authoring and upload, and it is here rather than in the importer because a
 * pack is refused before a row is written.
 */
export const RESERVED_FILE_PREFIXES: readonly string[] = [
  'hidden/',
  'solution/',
  'reference/',
  'drill/',
  'mutants/',
  'interview/',
];

/**
 * The structured requirements record a requirements phase mounts beside the
 * learner's prose.
 *
 * The path is the platform's own convention, not a teacher's choice: no
 * field of a pack and no compile rule can move it. The rule below is what
 * keeps two tasks from both answering for it.
 */
export const STORY_RECORD_PATH = 'requirements/story.json';

/**
 * One thing that produces a score for exactly one task: a graded run, a
 * config rule, a record, a question, or a mutant.
 *
 * The kind is carried rather than inferred from the id because the three
 * namespaces are separate, a rule and a run may legitimately share a name,
 * and "these two tasks own the same unit" has to be a question about a pair,
 * not about a string.
 */
export interface GradedUnit {
  /**
   * `question` is the fourth, and the only one whose
   * evidence costs no microVM. One per question in a quiz task's **pool**,
   * not per drawn question, because the pool is what the version declares and
   * the draw is what one paper takes.
   *
   * `record` is a story phase's one unit: the structured record at
   * `checks.record`, graded against the floor. It costs no microVM either.
   */
  kind: 'run' | 'rule' | 'mutant' | 'question' | 'record';
  id: string;
}

/** A compiled task: the grain a score, a reset and a room will hang off. */
export interface CompiledTask {
  /** `''` for a phase's synthesised sole task; an authored key otherwise. */
  taskKey: string;
  /** Contiguous `1..N` within the phase. */
  order: number;
  required: boolean;
  signOff: boolean;
  /** The kind of check that scores it: the phase's kind for a sole task. */
  checkKind: ArtifactKind;
  artefactType: ArtefactType;
  /** The workspace path the task's room reads, or null when the room uses `primaryPath`. */
  artefactPath: string | null;
  title: string;
  /** Markdown: the task panel a learner reads. */
  brief: string;
  objectives: string[];
  /** Every workspace path this task's work lands in. Tasks may overlap here. */
  owns: string[];
  /** Pairwise disjoint within a phase: this is what makes a per-task score true. */
  gradedUnits: GradedUnit[];
  rubric: PhaseRubric;
  /**
   * The task's **own slice** of its phase's checks, and absent when it has
   * none of its own, which is every sole task, because a phase's sole task is
   * scored by exactly the phase's checks.
   *
   * Absent rather than a copy, and the difference is not cosmetic: the whole
   * snapshot is stored in one JSON column per published version, and
   * `checks` is where `hiddenTestFiles`, `solutionFiles`, `referenceTestFiles`,
   * `implFiles`, `supportFiles`, `mutants` and `drill.faultedFiles` live. A copy
   * would put every sealed byte of the shipped pack in that column twice (373 KB of
   * 1194 KB, measured), which is exactly the cost the sha-keyed blob store
   * exists to avoid. Read it through `checksOf`, never directly.
   */
  checks?: PhaseChecks;
}

/** A phase's compiled tasks, in order. */
export interface CompiledPhaseTasks {
  key: PhaseKey;
  tasks: CompiledTask[];
}

/**
 * What a published version stores and the runtime reads.
 *
 * `content` is exactly what the on-disk loader produces, byte for byte
 * (that equality is the acceptance test for serving projects from the database
 * (`import-identity.spec.ts`)), so every reader downstream of
 * `ContentService` is unchanged by construction.
 */
export interface CompiledSnapshot {
  slug: string;
  version: string;
  content: ProjectContent;
  phases: CompiledPhaseTasks[];
  /** `COMPILER_IDENTITY` of the build that produced it; absent on a snapshot written before it existed. */
  compiler: string;
  /** microVMs one full pass of the whole project costs. */
  sandboxBudget: number;
  /** The same, per phase, so a change names the phase that moved. */
  sandboxBudgetByPhase: Record<string, number>;
}

/**
 * A task as a teacher authors it, through the authoring surface or an
 * uploaded pack's task block; the rules below hold every one of them.
 *
 * Everything the phase can answer is optional and taken from the phase, which
 * is also what makes a phase's sole task exactly the phase it already was.
 */
export interface AuthoredTask {
  taskKey: string;
  order: number;
  required?: boolean;
  signOff?: boolean;
  artefactType?: ArtefactType;
  artefactPath?: string | null;
  title?: string;
  brief?: string;
  objectives?: string[];
  owns: string[];
  gradedUnits: GradedUnit[];
  rubric?: PhaseRubric;
  /** The task's own slice of the phase's checks; absent means the phase's. */
  checks?: PhaseChecks;
}

/** The version a compile is about to replace, when there is one. */
export interface ExistingVersion {
  version: string;
  status: ProjectVersionStatus;
}

export interface CompileOptions {
  /** Authored tasks by phase key. A phase that is absent compiles to its sole task. */
  authored?: Record<string, AuthoredTask[]>;
  /** The row already holding this version, so a published one is refused. */
  existing?: ExistingVersion | null;
}

/* ------------------------------ the derivations ---------------------------- */

/**
 * The checks a task is scored by: its own slice where it declares one, and
 * otherwise its phase's.
 *
 * Every reader of a compiled task's checks goes through here rather than
 * through `task.checks`, because the snapshot stores the sole task's checks
 * once, on the phase, and a reader that missed the fallback would grade
 * against `undefined`.
 */
export function checksOf(phase: Pick<PhaseContent, 'checks'>, task: CompiledTask): PhaseChecks {
  return task.checks ?? phase.checks;
}

/** The graded units a phase declares, runs first, then rules, then mutants. */
export function gradedUnitsOf(phase: PhaseContent): GradedUnit[] {
  const checks = phase.checks;
  const units: GradedUnit[] = [];
  if (checks.kind === 'code' || checks.kind === 'tests') {
    for (const run of checks.runs) units.push({ kind: 'run', id: run.id });
  }
  if (checks.kind === 'config') {
    for (const rule of checks.rules) units.push({ kind: 'rule', id: rule.id });
  }
  if (checks.kind === 'tests') {
    for (const mutant of checks.mutants) units.push({ kind: 'mutant', id: mutant.name });
  }
  // ONE OF THE SITES THE COMPILER IS SILENT ABOUT.
  //
  // This is an if-chain, not a switch, so a fifth kind compiles here and
  // answers the empty list. A quiz with zero graded units is then refused by
  // `no graded unit` at publish: loud, but with a sentence about runs, rules
  // and mutants, which is the wrong sentence for a teacher who wrote five
  // questions. The arm is reached through the **synthetic phase**
  // `authoredTasksFor` builds from the task's own slice
  // (`draft.ts`: `gradedUnitsOf({ ...phase, checks: row.checks })`), which is
  // also what lets a task-level quiz slice mint its own units at all.
  if (checks.kind === 'quiz') {
    for (const question of checks.questions) units.push({ kind: 'question', id: question.id });
  }
  // A story phase grades one record, so it declares one unit: the record's path.
  if (checks.kind === 'story') units.push({ kind: 'record', id: checks.record });
  // A design phase grades the record and each contract that is on, one unit each.
  if (checks.kind === 'design') for (const at of designDocumentPaths(checks.contracts)) units.push({ kind: 'record', id: at });
  // A Deployment's runbook and a Maintenance's change request: one record unit beside the rules or the runs.
  if (checks.kind === 'config' && checks.runbook) units.push({ kind: 'record', id: checks.runbook.record });
  if (checks.kind === 'code' && checks.change) units.push({ kind: 'record', id: checks.change.record });
  return units;
}

/**
 * A graded unit's identity, as a string: the kind and the id together, because
 * the namespaces are separate and a rule and a run may share a name.
 *
 * Exported because `servablePhase` asks the same
 * question at the enrolment seam that the wall asks at publish. Two spellings
 * of one identity would let the runtime read a phase as servable while the
 * compiler and it disagreed about which unit is which, and the whole point of
 * that pair is that they are one statement with two readers.
 */
export function unitKey(unit: GradedUnit): string {
  return `${unit.kind}:${unit.id}`;
}

/** The rules a set of checks grades by: a config phase's file rules, and none for every other kind. */
function rulesOf(checks: PhaseChecks): readonly FileRule[] {
  return checks.kind === 'config' ? checks.rules : [];
}

/**
 * The workspace paths a set of checks reads or grades.
 *
 * This is the other half of the coverage rule: a task must own every path
 * its own checks are about, or it carries a `static-analysis` row, a rule
 * failure or a consistency finding about somebody else's bytes.
 */
export function gradedPathsOf(checks: PhaseChecks): string[] {
  switch (checks.kind) {
    case 'code':
      // the record is graded, never analysed or run: it is not an editable target
      return [...checks.editableTargets, ...(checks.change ? [checks.change.record] : [])];
    case 'tests':
      return [...checks.learnerTestFiles];
    case 'config': {
      // a stored rule compiled from an older version may name no target, and grades no path
      const targets = [...new Set(checks.rules.map((r) => r.target).filter((at): at is string => !!at))];
      return checks.runbook ? [...targets, checks.runbook.record] : targets;
    }
    // A quiz grades no path. It reads nothing in the
    // workspace and writes nothing to it, which is also why `quiz-owns-no-file`
    // has to be its own rule: the coverage rule below is quantified over this
    // list and an empty list clears it vacuously.
    case 'quiz':
      return [];
    case 'story':
      return [checks.record];
    case 'design':
      return designDocumentPaths(checks.contracts);
    default: {
      // Every kind is handled above, so a new one fails to compile here. At run time a row stored before the
      // markdown kind was retired reaches this arm and grades no path: the draft it sits in still opens (the
      // compile then refuses it in its own words), and its conversion is what moves it.
      const retired: never = checks;
      void retired;
      return [];
    }
  }
}

/**
 * Whether this compiled task is a quiz: asked of the kind that **scores** it
 * and never of its artefact type, because the type picks a room and the kind
 * picks a grader, and only the second is a statement about evidence.
 */
export function isQuizTask(task: { checkKind: ArtifactKind }): boolean {
  return task.checkKind === 'quiz';
}

/**
 * The phase's tasks that are not quizzes.
 *
 * The all-six-phases rule is a statement about this list and never about
 * `tasks.length`: a phase that holds exactly one non-quiz task divides no
 * executable unit, so every phase-keyed quantity still has exactly one owner.
 * Written once here so the wall, the three narrower walls, the slice
 * exemption, the editor's gate and the history repairs cannot answer
 * differently.
 */
export function nonQuizTasks<T extends { checkKind: ArtifactKind }>(tasks: readonly T[]): T[] {
  return tasks.filter((task) => !isQuizTask(task));
}

/**
 * The phase's **sole** non-quiz task, or null where there is not exactly one.
 *
 * Null is the honest answer in both directions: a phase of two executable
 * tasks has no sole one and is refused by the wall, and a phase of quizzes
 * alone has none and is refused by `phase-needs-a-required-artefact-task`.
 */
export function soleNonQuizTask<T extends { checkKind: ArtifactKind }>(
  tasks: readonly T[],
): T | null {
  const mine = nonQuizTasks(tasks);
  return mine.length === 1 ? mine[0] : null;
}

/** Every editable path a phase mounts: what the phase's tasks must cover. */
export function editablePathsOf(phase: PhaseContent): string[] {
  return phase.files.filter((f) => f.editable).map((f) => f.path);
}

/** True for a file a room reads as prose: the `'markdown'` here is a file language, not a check kind. */
function isProse(path: string, language: string): boolean {
  return language === 'markdown' || path.endsWith('.md');
}

/**
 * The path a task's room reads, where the room reads one file.
 *
 * `code` and `tests` have no such path: their room is the IDE and the test
 * runner, and the file they open is the task's `primaryPath`, which is what
 * they open. Every other type reads prose, and the path is the phase's
 * own editable prose file (an older Deployment's `RUNBOOK.md`
 * (a record is JSON, so it reads none)) as long as the task owns it and the phase has
 * exactly one. A phase with two editable prose files has no obvious answer,
 * so the room falls back to `primaryPath` rather than the compiler guessing.
 */
export function artefactPathFor(
  phase: PhaseContent,
  artefactType: ArtefactType,
  owns: string[],
): string | null {
  if (artefactType === 'code' || artefactType === 'tests') return null;
  const owned = new Set(owns);
  const prose = phase.files
    .filter((f) => f.editable && isProse(f.path, f.language) && owned.has(f.path))
    .map((f) => f.path);
  if (prose.length === 1) return prose[0];
  return null;
}

/**
 * The phase's synthesised sole task.
 *
 * Keyed `''`, which is the platform's own convention and not an invention: a
 * phase declaring no runs already gets one synthesised run with `id: ''`
 * because a phase with one run has nothing to group by, and every reader loops
 * over the list rather than branching. Following it exactly means a
 * single-task phase needs no task rows and no data migration, and the
 * empty key never appears in a URL.
 */
export function soleTaskFor(phase: PhaseContent): CompiledTask {
  const owns = editablePathsOf(phase);
  const artefactType = artefactTypeFor(phase.checks.kind, phase.key);
  return {
    taskKey: SOLE_TASK_KEY,
    order: 1,
    required: true,
    signOff: false,
    checkKind: phase.checks.kind,
    artefactType,
    artefactPath: artefactPathFor(phase, artefactType, owns),
    title: phase.title,
    brief: phase.taskPanel,
    objectives: phase.objectives,
    owns,
    gradedUnits: gradedUnitsOf(phase),
    rubric: phase.rubric,
    // no `checks`: the sole task's checks *are* the phase's, and the snapshot
    // carries them once. `checksOf` is the reader.
  };
}

/** An authored task, with everything it did not say taken from its phase. */
function authoredTaskFor(phase: PhaseContent, authored: AuthoredTask): CompiledTask {
  const checks = authored.checks ?? phase.checks;
  const artefactType = authored.artefactType ?? artefactTypeFor(checks.kind, phase.key);
  const owns = [...authored.owns];
  // `authored.checks`, not `checks`: a task that declared none carries none,
  // so the snapshot holds the phase's copy once whatever the task list looks
  // like.
  return {
    taskKey: authored.taskKey,
    order: authored.order,
    required: authored.required !== false,
    signOff: authored.signOff === true,
    checkKind: checks.kind,
    artefactType,
    artefactPath:
      authored.artefactPath === undefined
        ? artefactPathFor(phase, artefactType, owns)
        : authored.artefactPath,
    title: authored.title ?? phase.title,
    brief: authored.brief ?? phase.taskPanel,
    objectives: authored.objectives ?? phase.objectives,
    owns,
    gradedUnits: authored.gradedUnits.map((unit) => ({ kind: unit.kind, id: unit.id })),
    rubric: authored.rubric ?? phase.rubric,
    checks: authored.checks,
  };
}

/* --------------------------------- the rules ------------------------------- */

function refuse(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * The reserved prefix a path is under, or null. Exported because the row
 * writer asks the same question of a row an authoring surface hands it, one
 * file at a time, with no pack to compile.
 */
export function reservedPrefixOf(at: string): string | null {
  return RESERVED_FILE_PREFIXES.find((prefix) => at.startsWith(prefix)) ?? null;
}

/**
 * The compile rules, in the order a reader of a failure wants them: the shape of the task
 * list first, then what scores it, then what it is about, then the two
 * phase-wide readers a split phase cannot express.
 *
 * `fromAuthoredList` says which list this is: a phase's synthesised sole task,
 * or the tasks a teacher wrote. Only one rule asks, the empty key is the
 * synthesised task's and nothing else's, but it has to ask, because a
 * one-element authored list and a synthesised one are otherwise the same shape.
 */
function checkPhase(
  where: string,
  phase: PhaseContent,
  tasks: CompiledTask[],
  fromAuthoredList: boolean,
): void {
  // The paths a phase mounts, before anything about tasks: a file the store
  // cannot hold under its own role is a pack that has not been compiled, not a
  // pack that compiles and then fails to import.
  for (const file of phase.files) {
    const reserved = reservedPrefixOf(file.path);
    refuse(
      reserved === null,
      `${where}: the workspace file "${file.path}" is mounted under "${reserved}", which is where this version's ${reserved?.slice(0, -1)} rows are stored — a learner file cannot share a path with sealed material, so rename it`,
    );
  }

  // `design-contract-off-is-unmounted`, the loader's own rule asked of a
  // teacher's draft too: a contract switched off is not part of the artefact,
  // so a version mounting one would hand learners a document nothing grades.
  if (phase.checks.kind === 'design') {
    const off = mountedSwitchedOffContract(phase.files.map((one) => one.path), phase.checks.contracts);
    refuse(!off, `${where}: ${off} is mounted, but that contract is switched off.`);
  }

  // task keys, and the orders that make a task list a list
  const byKey = new Map<string, CompiledTask>();
  for (const task of tasks) {
    refuse(
      task.taskKey === SOLE_TASK_KEY || isAuthoredTaskKey(task.taskKey),
      `${where}: the task key "${task.taskKey}" is not lower-case, opening on a letter and at most 32 characters, so a learner's state could not follow it across versions`,
    );
    const clash = byKey.get(task.taskKey);
    refuse(
      clash === undefined,
      `${where}: two tasks are keyed "${task.taskKey}" (orders ${clash?.order} and ${task.order}) — a task key is unique within a phase, because it is what a learner's state follows`,
    );
    byKey.set(task.taskKey, task);
  }
  const orders = tasks.map((t) => t.order);
  refuse(
    orders.slice().sort((a, b) => a - b).every((order, i) => order === i + 1),
    `${where}: task orders must be contiguous 1..${tasks.length}, and these are ${orders.join(', ')}`,
  );

  // a phase no required task can open is a phase nobody can pass
  refuse(
    tasks.some((t) => t.required),
    `${where}: no task is required, so the phase could never pass — mark at least one task required`,
  );

  /* ------------------------------- quizzes -------------------------------- */

  /*
   * Three rules about a quiz TASK, and they stand above the early return
   * because none of them is about a split. A phase holding exactly one task
   * can hold a quiz and nothing else, which is the shape the first of them
   * refuses; and a quiz that owned a file or claimed the wrong rubric key
   * would be just as wrong alone as beside a sibling.
   */
  const quizzes = tasks.filter(isQuizTask);
  if (quizzes.length > 0) {
    // `phase-needs-a-required-artefact-task`, and it is scoped to the
    // **required** set rather than to the task list because that is what
    // `phaseRollup` quantifies over. A teacher who marks the quiz required and
    // the artefact task optional would otherwise get a phase opened by an MCQ
    // alone: a gate strictly weaker than any this platform has had, and
    // reachable without the phase being all-quiz.
    refuse(
      tasks.some((task) => task.required && !isQuizTask(task)),
      `${where}: this phase holds a quiz and no required task of another kind, so a learner could open it by answering multiple-choice questions alone — mark the task that produces the phase's artefact required`,
    );
  }
  for (const task of quizzes) {
    // `quiz-owns-no-file`. `gradedPathsOf` answers `[]` for a quiz, so the
    // coverage rule above clears vacuously and cannot catch this. A quiz that
    // named a path would be a second owner of the learner's code: the panel
    // could route a file's revision to it, the paste signal would look for a
    // pasted passage in somebody else's artefact, and a task-scoped reset
    // would have a file to delete that the quiz never wrote.
    refuse(
      task.owns.length === 0 && task.artefactPath === null,
      `${where}: the quiz task "${task.taskKey}" declares a workspace file — a quiz writes nothing a learner edits, so it owns no path and mints no artefact; clear its owns and its artefact path`,
    );
    // `quiz-rubric-key-is-the-quiz's`, in a loop of its OWN: a quiz sits in
    // every kind of phase, and `checks.criterion` is held here against the key its report writes:
    // `assembleCriteria` reads `scores.get(key) ?? 0`, so a mismatch is a flat
    // zero with no evidence, which on a required quiz is a bar nobody can
    // clear.
    const slice = checksOf(phase, task);
    refuse(
      slice.kind === 'quiz',
      `${where}: the quiz task "${task.taskKey}" is graded by the quiz grader and declares ${slice.kind} checks — a quiz carries its own questions as its slice`,
    );
    const keys = task.rubric.criteria.map((one) => one.key);
    refuse(
      slice.kind === 'quiz' && keys.length === 1 && keys[0] === slice.criterion,
      `${where}: the quiz task "${task.taskKey}" scores the rubric key "${slice.kind === 'quiz' ? slice.criterion : ''}" and its rubric claims ${keys.length === 0 ? 'none' : keys.map((key) => `"${key}"`).join(', ')} — a quiz derives exactly one criterion and it is the key its own report writes, or every learner would see 0 there with no evidence`,
    );
  }

  // what scores each task, and that no two tasks are scored by the same thing
  const owner = new Map<string, CompiledTask>();
  for (const task of tasks) {
    refuse(
      task.gradedUnits.length > 0,
      `${where}: task "${task.taskKey}" declares no graded unit — no run, no rule and no mutant — so nothing would score it and its report would be the phase's`,
    );
    for (const unit of task.gradedUnits) {
      const key = unitKey(unit);
      const held = owner.get(key);
      refuse(
        held === undefined,
        `${where}: tasks "${held?.taskKey}" and "${task.taskKey}" both own the ${unit.kind} "${unit.id}" — a graded unit belongs to exactly one task, or neither task's score is its own`,
      );
      owner.set(key, task);
    }
  }

  // every editable path belongs to a task, and every task is graded on paths
  // it owns. Owned paths may overlap: two tasks about two functions in one
  // file is the most natural authoring move there is, and the platform's own
  // implementation phase is shaped that way.
  const owned = new Set(tasks.flatMap((t) => t.owns));
  for (const at of editablePathsOf(phase)) {
    refuse(
      owned.has(at),
      `${where}: no task owns the editable file "${at}" — a learner would edit a file nothing grades`,
    );
  }
  for (const task of tasks) {
    const mine = new Set(task.owns);
    for (const at of gradedPathsOf(checksOf(phase, task))) {
      refuse(
        mine.has(at),
        `${where}: task "${task.taskKey}" is graded on "${at}", which it does not own — a task owns every path its graded units read`,
      );
    }
    refuse(
      task.artefactPath === null || mine.has(task.artefactPath),
      `${where}: task "${task.taskKey}" declares the artefact path "${task.artefactPath}", which it does not own`,
    );
  }

  // artefact paths, which are what a room and a reset key on
  const atPath = new Map<string, CompiledTask>();
  for (const task of tasks) {
    if (task.artefactPath === null) continue;
    const held = atPath.get(task.artefactPath);
    refuse(
      held === undefined,
      `${where}: tasks "${held?.taskKey}" and "${task.taskKey}" both declare the artefact path "${task.artefactPath}" — an artefact path is unique within a phase, or a reset on one task would take the other's work with it`,
    );
    atPath.set(task.artefactPath, task);
  }

  // `authored-keys-are-not-the-sole-key`, and it is the one rule of the task
  // list that stands ABOVE the early return, because the list it is about is
  // the one the early return cannot tell apart. A synthesised sole task really
  // is keyed `SOLE_TASK_KEY`, so a key check alone is not the predicate that
  // tells the two lists apart, which is why `soleTaskList` asks for the length
  // too, and why a ONE-element authored list keyed `""` satisfies both of its
  // conjuncts. Such a phase would take the phase-wide arm of every per-task
  // derivation: no task row is written, `strictPass` returns before the row
  // conjunct, `unitsOf` answers with the phase's units rather than the ones the
  // task declares, and `required: false` on that task would be ignored. Two
  // elements are no better: an authored list `['' required, 'web' optional]`
  // takes the same arm, where the verdict is whichever submission landed, and
  // passing the optional task would open the phase and serve its answer key.
  // Both shapes are one sentence, so both are refused by one rule, at the only
  // place it can catch them both.
  if (fromAuthoredList) {
    for (const task of tasks) {
      refuse(
        task.taskKey !== SOLE_TASK_KEY,
        `${where}: a task in an authored list is keyed "" — the empty key is the synthesised sole task's and nothing else's, because it is what every reader uses to tell a phase with tasks from a phase without; give this task a name`,
      );
    }
  }

  if (tasks.length < 2) return;

  // The non-quiz tasks, which is what every rule below counts. The
  // all-six-phases rule: a phase holding exactly one of them divides no
  // executable unit, so the walls whose reason is about a partition are asked
  // about this list and never about `tasks.length`.
  const graded = nonQuizTasks(tasks);

  // The two readers of a `tests` report that are neither a run, a rule nor a
  // mutant, so the partition above cannot see them: `enough-tests` is failed
  // against `checks.minTests`, one number over the whole suite, and one
  // `coverage-<criterion>` check is emitted per keyword group, `failed` when
  // the keyword is not in the learner's suite. The strict gate refuses any
  // non-passed check, so a two-task testing phase with either of these
  // declared at the phase publishes in which **neither task can pass**. There
  // is no per-task reading of either, so this is the wall.
  //
  // The count is the **non-quiz** one, and the sentences are verbatim. Each
  // reason above is *"neither task could be scored by it"*: true of a split,
  // false of one executable task beside a quiz, which is scored by the whole
  // suite because it owns the whole suite. Counting every task instead would
  // refuse a quiz beside an executable task on a testing phase, and with the compiler's narrowest sentences, which are the ones a teacher
  // can act on and which would here be wrong.
  if (phase.checks.kind === 'tests' && graded.length >= 2) {
    refuse(
      phase.checks.minTests <= 0,
      `${where}: checks.minTests is declared on a phase with ${tasks.length} tasks — it is one number over the whole suite, so neither task could be scored by it; partition it onto the tasks`,
    );
    refuse(
      phase.checks.coverageKeywords.length === 0,
      `${where}: checks.coverageKeywords is declared on a phase with ${tasks.length} tasks — one check is emitted per group over the whole suite, so a task would carry a failed check for a behaviour it does not own; partition the groups onto the tasks`,
    );
  }

  // The incident drill is a microVM keyed on the phase and on `checks.drill`,
  // run straight off the request path and outside every task's graded units,
  // so N tasks would cost N drill smokes where the phase costs one. It is not
  // an ownable graded unit, so it cannot be shared.
  if (phase.checks.kind === 'config' && phase.checks.drill && graded.length >= 2) {
    refuse(
      false,
      `${where}: checks.drill is declared on a phase with ${tasks.length} tasks — the drill's smoke run is priced once per phase and belongs to one task, so it cannot be shared; give the drill to a single task`,
    );
  }

  /* ---------------------- what a split phase must be ---------------------- */

  /*
   * Everything below is about a phase a teacher split, and the three walls
   * above still answer first for the shapes their own assertions cover. That
   * ordering is deliberate and it is what keeps `enough-tests`, the coverage
   * groups and the incident drill refusing with the narrow sentence a teacher
   * can act on, "partition `checks.minTests` onto the tasks", rather than
   * with the general wall's paragraph.
   *
   * The wall itself is the LAST statement in this function, for the same
   * reason and for one more: a shape that trips a narrower rule is refused by
   * the narrower rule, so a two-task `tests` phase declaring `minTests` never
   * carries `EXECUTABLE_SPLIT_NOT_READY`, and nothing here promises that it
   * does.
   */

  // `authored-tasks-declare-a-slice`. `checksOf` falls back to the phase's
  // checks, which is exactly the mechanism a sole task rests on; on a split
  // phase that fallback would stand in for an author's omission, and the task
  // would be graded by its sibling's rules over its sibling's targets.
  //
  // The phase's **sole non-quiz task** is exempt, because the reason
  // already implies it. That task has no sibling to be confused with: the
  // fallback stands in for nothing, and `checksOf` then answers the phase's
  // checks, which is exactly what it is graded by. Forcing it to carry a copy
  // would put `hiddenTestFiles`, `solutionFiles`, `referenceTestFiles`,
  // `implFiles`, `supportFiles`, `mutants` and `drill.faultedFiles` in
  // `project_versions.compiled` twice: 373 KB of 1194 KB, measured. The
  // exemption is never a quiz's: a quiz falling back to the phase's checks
  // would be graded by its sibling's suite, and on a `code` phase it would
  // reach the reference solution through a gate its own pass had opened.
  const exempt = soleNonQuizTask(tasks);
  for (const task of tasks) {
    if (task === exempt) continue;
    refuse(
      task.checks !== undefined,
      `${where}: task "${task.taskKey}" declares no checks of its own, so it would be graded by the whole phase's — its sibling's rules would be its rules and its sibling's targets would be its targets; give it the slice of the phase's checks it is about`,
    );
  }

  // `tasks-partition-units`. The `owner` map above gives disjointness: no unit
  // in two tasks, and this gives completeness, in both directions. Without the first half a
  // graded unit the pinned version declares is owned by nobody, evaluated by
  // nobody, and the phase reads fully graded.
  const phaseUnits = gradedUnitsOf(phase);
  const declaredUnits = new Set(phaseUnits.map(unitKey));
  for (const unit of phaseUnits) {
    refuse(
      owner.has(unitKey(unit)),
      `${where}: the ${unit.kind} "${unit.id}" is declared by the phase and owned by no task — nothing would run it, so the phase could never be fully graded; give it to a task`,
    );
  }
  for (const task of tasks) {
    for (const unit of task.gradedUnits) {
      // A `question` is exempt, and the exemption is narrow
      // because the first half's reason is narrow. That half exists so a unit
      // the **phase** declares is run by exactly one task; a quiz declares no
      // phase-level unit: it brings its own pool. Without this clause every
      // quiz on a written phase is refused at publish, because a phase's
      // checks declare rules and never questions. Disjointness above is
      // untouched, so question ids stay unique within the phase.
      if (unit.kind === 'question') continue;
      refuse(
        declaredUnits.has(unitKey(unit)),
        `${where}: task "${task.taskKey}" owns the ${unit.kind} "${unit.id}", which this phase does not declare`,
      );
    }
  }

  // `tasks-partition-rules`, whose fourth clause is the one that matters for a
  // written phase: the units are the id-truth and the slice is the body-truth,
  // and they have to name the same rules. A task owning three rule units whose
  // slice declares one emits a single check, strict-passes on it: the gate
  // refuses a failed check, not an absent one, and two graded rules the
  // pinned version declares are never evaluated.
  for (const task of tasks) {
    const sliceIds = new Set(rulesOf(checksOf(phase, task)).map((rule) => rule.id));
    const unitIds = new Set(
      task.gradedUnits.filter((unit) => unit.kind === 'rule').map((unit) => unit.id),
    );
    for (const id of unitIds) {
      refuse(
        sliceIds.has(id),
        `${where}: task "${task.taskKey}" declares ${sliceIds.size} rules in its checks and owns ${unitIds.size} as graded units; the rule "${id}" is one it owns and its slice omits, so it is a graded rule nothing would evaluate`,
      );
    }
    for (const id of sliceIds) {
      refuse(
        unitIds.has(id),
        `${where}: task "${task.taskKey}" declares the rule "${id}" in its checks and does not own it as a graded unit, so nothing would evaluate it and its criterion would be demanded of the task's rubric for nothing`,
      );
    }
  }

  // `story-record-belongs-to-one-task`. Path ownership overlaps by design, and
  // this is a rule about one path: the check that holds the structured record
  // against the learner's prose is emitted by the task that owns the record, so
  // two owners is two tasks answering for one document.
  if (phase.files.some((one) => one.path === STORY_RECORD_PATH)) {
    const owners = tasks.filter((task) => task.owns.includes(STORY_RECORD_PATH));
    refuse(
      owners.length < 2,
      `${where}: tasks "${owners[0]?.taskKey}" and "${owners[1]?.taskKey}" both own "${STORY_RECORD_PATH}" — the requirements record is one document, and the check that holds it against the learner's prose is emitted by the task that owns it, so exactly one task may own it`,
    );
  }

  // `screen-contract-belongs-to-one-task`, the twin of the rule above, and it
  // reaches further: the accepted screen copy is frozen at the design phase's
  // advance and injected read-only into implementation, testing, deployment and
  // maintenance, where it is graded. A `design` phase is written and its
  // `screens.json` is editable, so this is the release where two tasks can
  // claim it, and with no rule, an arbitrary one's passing submission would
  // become the contract four later phases are judged against.
  if (phase.files.some((one) => one.path === SCREEN_CONTRACT_PATH)) {
    const owners = tasks.filter((task) => task.owns.includes(SCREEN_CONTRACT_PATH));
    refuse(
      owners.length < 2,
      `${where}: tasks "${owners[0]?.taskKey}" and "${owners[1]?.taskKey}" both own "${SCREEN_CONTRACT_PATH}" — the accepted screen copy is read from one task's passing submission and carried into four later phases, so exactly one task may own it`,
    );
  }

  // `design-phase-holds-one-task`. A Design phase is one learner's design: one
  // task owns the record and the contracts, and a quiz may sit beside it.
  if (phase.checks.kind === 'design') {
    const work = tasks.filter((task) => !isQuizTask(task));
    refuse(
      work.length === 1,
      `${where}: a Design phase holds exactly one task beside any quizzes, and this one holds ${work.length}. Move other written work into its own phase.`,
    );
  }

  // `tasks-in-a-phase-share-one-kind`: THE WALL, and it is last on purpose.
  //
  // Several tasks may share a phase whose work is written. Everything whose
  // evidence is executed stays with one task per phase: the sandbox jobs, the
  // mutant wave and the smoke run are priced, ordered and scored per phase, and
  // a split executable phase would grade both tasks against the whole phase's
  // suite. Both refusals a teacher can meet are built out of one shared
  // sentence, so there is one string to change if the wall moves.
  //
  // **It is a SHAPE test, not a count test.**
  // Its stated reason is about a **partition**, and a phase holding exactly
  // one executable task partitions nothing: the mapping from unit to task is
  // total and constant, so every phase-keyed quantity still has exactly one
  // owner and the executable task's grading is the phase's grading, expression
  // for expression. So a phase holding several tasks is refused unless
  // **either** its checks are written (`story` or `design`) and every task's check kind is
  // written or `quiz`, **or** exactly one of its tasks is not a quiz, and
  // that task's check kind is the phase's, and it owns every graded unit the
  // phase declares, and it owns every editable path the phase mounts.
  //
  // The three ownership conjuncts are not decoration. They are the difference
  // between a rule about a shape a teacher happens to author and a rule a
  // published snapshot is held to, and they are cheap, because both sets are
  // computed a few lines above. Nor is the kind conjunct: *"all but one of its
  // tasks are quizzes"* would admit a `story` task beside a `code` task on
  // a `code` phase, which is what the second refusal catches.
  if (phase.checks.kind === 'story' || phase.checks.kind === 'design') {
    for (const task of tasks) {
      refuse(
        splittableCheckKind(task.checkKind),
        `${where}: task "${task.taskKey}" is graded by the ${task.checkKind} grader on a phase holding ${tasks.length} tasks. ${EXECUTABLE_SPLIT_NOT_READY} Leave one task in the phase, or give every task written checks.`,
      );
    }
    return;
  }

  refuse(
    graded.length === 1,
    `${where}: this phase holds ${graded.length} tasks that are not quizzes and its checks are ${phase.checks.kind}, so this version cannot be published. ${EXECUTABLE_SPLIT_NOT_READY} Leave one task in the phase, or move this work into a written phase.`,
  );
  const only = graded[0];
  refuse(
    only.checkKind === phase.checks.kind,
    `${where}: task "${only.taskKey}" is graded by the ${only.checkKind} grader on a phase whose checks are ${phase.checks.kind}. ${EXECUTABLE_SPLIT_NOT_READY} Give the phase's one graded task the phase's own checks, or move this work into a written phase.`,
  );
  const mine = new Set(only.gradedUnits.map(unitKey));
  for (const unit of phaseUnits) {
    refuse(
      mine.has(unitKey(unit)),
      `${where}: the ${unit.kind} "${unit.id}" is declared by the phase and not owned by "${only.taskKey}", which is the phase's one graded task. ${EXECUTABLE_SPLIT_NOT_READY} A quiz may sit beside it only while that task owns every graded unit the phase declares.`,
    );
  }
  const held = new Set(only.owns);
  for (const at of editablePathsOf(phase)) {
    refuse(
      held.has(at),
      `${where}: the editable file "${at}" is not owned by "${only.taskKey}", which is the phase's one graded task. ${EXECUTABLE_SPLIT_NOT_READY} A quiz may sit beside it only while that task owns every editable path the phase mounts.`,
    );
  }
}

/* -------------------------------- the budget ------------------------------- */

/**
 * The microVMs one full pass of a phase costs.
 *
 * Per task, because a task owns a partition of the phase's runs rather than a
 * copy of them: a `code` run costs two, the learner's visible run and the
 * sealed one, a `tests` run costs one and every mutant one more. The smoke
 * run and the incident drill are priced **per phase**, because both are keyed
 * on the phase rather than on a run, so a deployment phase with a drill costs
 * two: the smoke run plus the drill's smoke.
 */
export function sandboxBudgetFor(phase: PhaseContent, tasks: CompiledTask[]): number {
  let total = 0;
  for (const task of tasks) {
    // ONE OF THE SITES THE COMPILER IS SILENT ABOUT.
    //
    // A quiz costs **zero** microVMs, which is the whole argument for letting
    // one sit beside an executable task. It is already zero by accident: a
    // quiz's units are all `question`, so both filters below are empty, and
    // this line is what makes it zero on purpose, so that a future `else`
    // cannot price a quiz wrong. The written kinds (`story` and
    // `design`, whose units are records) cost nothing the same way.
    // That holds for the budget; the report's
    // `reportExtras` is keyed on `phase.key` rather than on the task, so it
    // returns early for a quiz task (`feedback.service.ts`).
    if (isQuizTask(task)) continue;
    const runs = task.gradedUnits.filter((u) => u.kind === 'run').length;
    const mutants = task.gradedUnits.filter((u) => u.kind === 'mutant').length;
    if (phase.checks.kind === 'code') total += runs * 2;
    if (phase.checks.kind === 'tests') total += runs + mutants;
  }
  if (phase.checks.kind === 'config') {
    total += 1;
    if (phase.checks.drill) total += 1;
  }
  return total;
}

/* ------------------------------- the compile ------------------------------- */

/**
 * Compile a loaded pack into the snapshot a published version stores.
 *
 * `existing` is the row this compile would replace. A **published** version is
 * immutable (that is the whole reason the pin works, because a learner
 * resolved to a published version cannot have the ground move under an attempt),
 * so recompiling one is refused by name and a content fix is a version bump.
 * A draft is mutable and is simply replaced.
 */
export function compilePack(
  content: ProjectContent,
  options: CompileOptions = {},
): CompiledSnapshot {
  const existing = options.existing ?? null;
  refuse(
    !existing || existing.status !== 'published' || existing.version !== content.version,
    `${content.slug} ${content.version} is already published, and a published version is immutable — bump project.json's version to import this change`,
  );

  const phases: CompiledPhaseTasks[] = [];
  const sandboxBudgetByPhase: Record<string, number> = {};
  let sandboxBudget = 0;
  for (const phase of content.phases) {
    const where = `${content.slug}/${phase.key}`;
    const authored = options.authored?.[phase.key];
    const fromAuthoredList = !!authored && authored.length > 0;
    const tasks = fromAuthoredList
      ? authored.map((one) => authoredTaskFor(phase, one))
      : [soleTaskFor(phase)];
    for (const task of tasks) {
      refuse(
        ARTEFACT_TYPES.includes(task.artefactType),
        `${where}: task "${task.taskKey}" declares the artefact type "${task.artefactType}", which is not one of ${ARTEFACT_TYPES.join(', ')}`,
      );
    }
    checkPhase(where, phase, tasks, fromAuthoredList);
    const budget = sandboxBudgetFor(phase, tasks);
    sandboxBudgetByPhase[phase.key] = budget;
    sandboxBudget += budget;
    phases.push({ key: phase.key, tasks });
  }

  return {
    slug: content.slug,
    version: content.version,
    content,
    phases,
    compiler: COMPILER_IDENTITY,
    sandboxBudget,
    sandboxBudgetByPhase,
  };
}

/**
 * The digest a published version is keyed on for idempotence, over the whole
 * compiled snapshot.
 *
 * It is what makes "this version is already published, from the same bytes" a
 * no-op and "already published, from different bytes" a refusal instead of a
 * silent nothing, which is the failure mode a baked-in pack would otherwise
 * have, since a content fix reaches production by redeploying the image.
 */
export function contentDigestOf(snapshot: CompiledSnapshot): string {
  return digestOf(snapshot);
}
