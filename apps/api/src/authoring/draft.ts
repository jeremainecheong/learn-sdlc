import {
  CANONICAL_FILE_NOTICE,
  INHERITED_TASK_KEY,
  INHERITED_TASK_NOTICE,
  SEALED_FILE_NOTICE,
  RUN_SHAPES,
  isAuthorableExecutableTask,
  isAuthorableTask,
  isAuthoringReadableRole,
  learnerRuleCountDescription,
  plainTextOf,
  refusesMultiTaskPublish,
  TASK_BRIEF_MAX,
  TASK_OBJECTIVE_MAX,
  TASK_TITLE_MAX,
} from '@learnsdlc/shared';
import type {
  ExecutableTaskView,
  SealedFileView,
  TestRunShape,
  TestRunShapeId,
  UpdateExecutableTaskBody,
  ArtifactKind,
  ProjectFileRole,
  AuthoredQuizView,
  AuthoredQuizViewQuestion,
  AuthoredRule,
  AuthoringFileView,
  DraftInterviewView,
  DraftPhaseView,
  DraftTaskView,
  PhaseKey,
  PhaseRubric,
  QuizChecks,
  RubricCriterion,
} from '@learnsdlc/shared';
import { canonicalJson, sha256Hex } from '../content/blob.store';
import { seedDesignDocuments } from '../content/content.service';
import type {
  CodeChecks,
  ContentFileSpec,
  DesignChecks,
  PhaseRun,
  InterviewBrief,
  PhaseContent,
  ProjectContent,
  TestsChecks,
} from '../content/content.types';
import type {
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionManifest,
} from '../content/project.entities';
import { RESERVED_FILE_PREFIXES, gradedPathsOf, gradedUnitsOf, nonQuizTasks } from '../content/pack-compiler';
import type { AuthoredTask } from '../content/pack-compiler';
// the editor's draft compile and words overlay live here too (shared with the importer)
import { BadRequestException } from '@nestjs/common';
import { compilePack, isQuizTask } from '../content/pack-compiler';
import type { CompiledSnapshot } from '../content/pack-compiler';
// the hidden-test name, one rule for every door
import { isHiddenTestName } from './door-rules';

/**
 * The derivations between the rows a teacher edits and the pack the compiler
 * reads (teacher-authored projects).
 *
 * Every project lives in the database and `project_versions.compiled` is
 * what the runtime reads. This file is the join between the two halves: it is
 * a function of rows, so everything that decides what a task owns, what scores
 * it, and whether its bytes may leave can be asked without a database.
 *
 * **The draft's own `compiled.content` is the base pack.** A project is created
 * by copying a published one, so the draft opens holding the source's compiled
 * `ProjectContent`: the phases' checks, the rubrics, the assistant blocks and
 * the sealed material a teacher cannot author and does not touch. What the rows
 * then carry is what a teacher can change: a phase's title and intro, a task's
 * title, brief, rules and requiredness, and the workspace files a task writes
 * to. `contentForDraft` overlays the second onto the first, which is why a task
 * mutation never rewrites a pack and never has to.
 */

/* ------------------------------ the two grains ---------------------------- */

/**
 * Whether this row is the task the copy inherited.
 *
 * A phase of the source compiles to exactly one task keyed `SOLE_TASK_KEY`,
 * which is the empty string and can never be a URL segment, so the copy
 * materialises it as a real row keyed `main`. That key is reserved (a teacher
 * adding a task may not claim it) so "inherited" stays a question with one
 * answer rather than a guess about a row's contents.
 */
export function isInheritedTask(taskKey: string): boolean {
  return taskKey === INHERITED_TASK_KEY;
}

/**
 * The workspace paths a task's work lands in.
 *
 * At most one task in a phase carries a path the *pack* mounted (the inherited
 * one) and it owns every editable file the phase mounts except the ones a
 * teacher's own tasks minted for themselves. Every other task owns exactly the
 * file it was minted, plus anything its own checks are graded on.
 *
 * Owning is what makes a per-task reset true, so a path with no owner is a file
 * a learner would edit and nothing would grade, which `compilePack` refuses by
 * name, and which this derivation is written not to produce.
 */
export function ownsFor(
  row: ProjectTaskEntity,
  siblings: ProjectTaskEntity[],
  editablePaths: string[],
): string[] {
  if (isInheritedTask(row.taskKey)) {
    const minted = new Set(
      siblings
        .filter((one) => !isInheritedTask(one.taskKey))
        .map((one) => one.artefactPath)
        .filter((at): at is string => at !== null),
    );
    return editablePaths.filter((at) => !minted.has(at));
  }
  const own = new Set<string>();
  if (row.artefactPath) own.add(row.artefactPath);
  for (const at of gradedPathsOf(row.checks)) own.add(at);
  return [...own];
}

/**
 * The phase's task rows as the compiler wants them.
 *
 * `checks` is omitted where the row's slice is byte for byte the phase's own,
 * which is the inherited task of a phase nobody has edited. That is not a
 * micro-optimisation: the whole snapshot is one JSON column per version and
 * `checks` is where the hidden suites, solutions, mutants and support files
 * live, so a copy would put 373 KB of the shipped pack in that column twice.
 * `checksOf` is the reader that makes the omission invisible.
 */
export function authoredTasksFor(phase: PhaseContent, rows: ProjectTaskEntity[]): AuthoredTask[] {
  const editable = phase.files.filter((file) => file.editable).map((file) => file.path);
  const phaseChecks = canonicalJson(phase.checks);
  const ordered = [...rows].sort((a, b) => a.order - b.order);
  return ordered.map((row, at) => {
    const task: AuthoredTask = {
      taskKey: row.taskKey,
      order: at + 1,
      required: row.required,
      signOff: row.signOff,
      artefactType: row.artefactType,
      artefactPath: row.artefactPath,
      title: row.title,
      brief: row.brief,
      objectives: row.objectives ?? [],
      owns: ownsFor(row, ordered, editable),
      gradedUnits: gradedUnitsOf({ ...phase, checks: row.checks }),
      rubric: row.rubric,
    };
    if (canonicalJson(row.checks) !== phaseChecks) task.checks = row.checks;
    return task;
  });
}

/* ------------------------ the phase a draft compiles to ------------------------ */

/**
 * The phase a draft compiles to, from its tasks: a phase's checks are its sole
 * non-quiz task's. A code or tests phase is assembled from its sole work task's
 * slice, with the sealed rows a teacher wrote overlaid on it
 * (`executablePhaseFromTasks`); every other phase is handed back as it is, and a
 * shape the compiler refuses is left for its wall to say in its own words.
 */
export function phaseFromTasks(
  phase: PhaseContent,
  rows: ProjectTaskEntity[],
  sealed: readonly SealedRowBytes[] = [],
): PhaseContent {
  if (phase.checks.kind === 'code' || phase.checks.kind === 'tests') return executablePhaseFromTasks(phase, rows, sealed);
  return phase;
}

/* ----------------------- the sole executable work task ----------------------- */

/**
 * The code or tests phase its **sole work task** makes.
 *
 * An uploaded or edited executable phase holds exactly one task that is not a
 * quiz, and that task's slice *is* the phase: its runs, its visible and hidden
 * suites, its reference solution, and (for `tests`) its learner test files,
 * minimum test count, coverage keywords and mutants. Without this arm the
 * phase would keep the checks the copy brought, so an edit that reached the
 * row (a sealed write) would reach nothing a learner is graded on.
 *
 * **The flat unions are derived, never copied.** `hiddenTestFiles` is
 * the union over the runs, built exactly as the loader builds it
 * (`content.service.ts`), and `solutionSources` is the values of
 * `solutionFiles`: the mentor's `redactSolutions` reads it. A row whose run
 * holds a new hidden case while its flat field still holds the old one would
 * otherwise compile and grade one suite and redact another.
 *
 * **Refused by handing the phase back untouched**, so the compiler's own wall
 * says it in its own words (`EXECUTABLE_SPLIT_NOT_READY`): a second work task,
 * and a work row of another kind. A quiz row is never read.
 *
 * **An untouched copy is the identity**: the derived checks are compared with
 * the phase's own and the same object comes back, so every reference phase and
 * every plain copy compiles byte for byte unchanged.
 *
 * **Where the bytes come from.** The task row's slice is what the copy or the
 * upload wrote; a teacher's edit arrives as sealed `project_files` rows written
 * through the sealed-role door (`sealed-roles.ts`), which goes through
 * `ProjectImporterService.insertFiles` and so is held to the importer's two
 * byte rules and the reserved prefixes before a byte lands. `sealed` is those
 * rows, overlaid here (`overlaySealedRows`). Nothing writes a task row's
 * `checks` directly, so no byte this grades has skipped the rules.
 */
function executablePhaseFromTasks(
  phase: PhaseContent,
  rows: ProjectTaskEntity[],
  sealed: readonly SealedRowBytes[],
): PhaseContent {
  const slice = soleExecutableSliceOf(phase, rows);
  if (!slice) return phase;
  const checks = executableChecksOf(sealed.length ? overlaySealedRows(slice, sealed) : slice);
  if (canonicalJson(checks) === canonicalJson(phase.checks)) return phase;
  return { ...phase, checks };
}

/**
 * The rows as the compiler should read them once `phaseFromTasks` has made an
 * executable phase its sole work task's: that row carries the **derived**
 * checks, so `authoredTasksFor` omits its slice (it is the phase's) and the
 * overlay keeps the derived unions rather than the row's raw ones. Every other
 * shape (and an untouched copy, whose row already equals the phase) is
 * returned as it came.
 */
export function rowsForExecutablePhase(phase: PhaseContent, rows: ProjectTaskEntity[]): ProjectTaskEntity[] {
  if (phase.checks.kind !== 'code' && phase.checks.kind !== 'tests') return rows;
  const work = rows.filter((row) => row.checks.kind !== 'quiz');
  if (work.length !== 1 || work[0].checks.kind !== phase.checks.kind) return rows;
  return rows.map((row) => (row === work[0] ? ({ ...row, checks: phase.checks } as ProjectTaskEntity) : row));
}

/** The sole work task's executable slice, or null for every shape the compiler's wall refuses. */
export function soleExecutableSliceOf(
  phase: Pick<PhaseContent, 'checks'>,
  rows: ProjectTaskEntity[],
): CodeChecks | TestsChecks | null {
  if (phase.checks.kind !== 'code' && phase.checks.kind !== 'tests') return null;
  const work = rows.filter((row) => row.checks.kind !== 'quiz');
  if (work.length !== 1 || work[0].checks.kind !== phase.checks.kind) return null;
  return work[0].checks as CodeChecks | TestsChecks;
}

/* ------------ rows → checks: the sealed rows the sealed-role door writes ------------ */

/** One sealed `project_files` row of a phase, with its bytes. `path` is the row's own path. */
export interface SealedRowBytes {
  role: ProjectFileRole;
  path: string;
  bytes: string;
}

/** The roles a sealed write of an executable task lands as (`sealed-roles.ts` `sealedRowFor`). */
const EXECUTABLE_SEALED_ROLES: ReadonlySet<ProjectFileRole> = new Set<ProjectFileRole>(['hidden', 'solution', 'reference', 'mutant']);

/*
 * A stored run per sealed row.
 *
 * No column and no migration: a sealed row that belongs to ONE run of a phase
 * whose path that run does not already hold carries the run in its own path,
 * as a reserved segment right after the role's folder:
 * `hidden/\run\<runId>/<path>` (and `reference/\run\<runId>/<path>` for a
 * tests task's suite or implementation). The segment holds a backslash, which
 * no upload path can spell: the zip reader refuses an entry name holding one
 * (`safeRelativePath`, ARCHIVE_PATH_ESCAPE), MemoryPackSource refuses to walk
 * one (`normalise`), and the sealed door's path rule (`checkedSealedPath`)
 * refuses one. A row without the segment (an older row, or one a door
 * writes for a run the overlay would choose anyway) is placed by
 * `runForPath`, or in every run that holds the path.
 */
export const SEALED_RUN_MARK = '\\run\\';
const RUN_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** A sealed row's path with its run carried (`hidden/<path>` → `hidden/\run\<runId>/<path>`). */
export function sealedRunRowPath(rowPath: string, runId: string): string {
  const slash = rowPath.indexOf('/');
  if (slash <= 0 || !RUN_ID.test(runId) || rowPath.slice(slash + 1).startsWith(SEALED_RUN_MARK)) {
    throw new Error('a sealed row carries one run, after its role folder, under a plain run id');
  }
  return `${rowPath.slice(0, slash + 1)}${SEALED_RUN_MARK}${runId}/${rowPath.slice(slash + 1)}`;
}

/** The run a sealed row's path carries, and the path without it; `runId` null for a row with the default placement. */
export function sealedRowRunOf(rowPath: string): { path: string; runId: string | null } {
  const slash = rowPath.indexOf('/');
  const rest = slash > 0 ? rowPath.slice(slash + 1) : '';
  if (!rest.startsWith(SEALED_RUN_MARK)) return { path: rowPath, runId: null };
  const end = rest.indexOf('/', SEALED_RUN_MARK.length);
  const runId = end > 0 ? rest.slice(SEALED_RUN_MARK.length, end) : '';
  // A malformed carried run places nowhere (fail closed), never in a guessed run.
  if (!RUN_ID.test(runId)) return { path: rowPath, runId: '' };
  return { path: `${rowPath.slice(0, slash + 1)}${rest.slice(end + 1)}`, runId };
}

/**
 * Every sealed byte of a slice at the row path the importer stores it under
 * (`importer.service.ts` `derivedFileRows`), so a row and the slice can be
 * compared by sha without reading a blob.
 */
function slicePathsOf(slice: CodeChecks | TestsChecks): Map<string, string> {
  const out = new Map<string, string>();
  const put = (prefix: string, files: Record<string, string> | undefined): void => {
    for (const [at, bytes] of Object.entries(files ?? {})) out.set(`${prefix}${at}`, bytes);
  };
  if (slice.kind === 'code') {
    put('hidden/', slice.hiddenTestFiles);
    for (const run of slice.runs) put('hidden/', run.hiddenTestFiles);
    put('solution/', slice.solutionFiles);
  } else {
    put('reference/', slice.referenceTestFiles);
    put('reference/', slice.implFiles);
    for (const run of slice.runs) {
      put('reference/', run.referenceTestFiles);
      put('reference/', run.implFiles);
    }
    for (const mutant of slice.mutants) put(`mutants/${mutant.name}/`, mutant.files);
  }
  return out;
}

/**
 * The sealed rows of one executable phase whose bytes are **not** already the
 * sole work task's slice: the only blobs `load` has to read. An untouched
 * copy or upload answers none, so it reads nothing and compiles unchanged.
 */
export function sealedRowsToOverlay(
  rows: readonly Pick<ProjectFileEntity, 'role' | 'path' | 'blobSha'>[],
  slice: CodeChecks | TestsChecks,
): Pick<ProjectFileEntity, 'role' | 'path' | 'blobSha'>[] {
  const held = slicePathsOf(slice);
  return rows.filter((row) => {
    if (!EXECUTABLE_SEALED_ROLES.has(row.role)) return false;
    const bytes = held.get(row.path);
    return bytes === undefined || sha256Hex(bytes) !== row.blobSha;
  });
}

/** A test file by its name: `test_*.py`, `*_test.py`, `*.test.[jt]s[x]`, `*.spec.[jt]s[x]`. */
const TEST_FILE = /(^|\/)test_[^/]+\.py$|_test\.py$|\.(test|spec)\.[jt]sx?$/;

/** Whether a run's collected paths already cover a workspace path (the path itself, or a directory above it). */
function collects(run: PhaseRun, at: string): boolean {
  return run.testPaths.some((path) => {
    const dir = path.replace(/\/+$/, '');
    return at === dir || at.startsWith(`${dir}/`);
  });
}

/**
 * A new **hidden** test file a code run would mount but never collect is added
 * to what it collects, so it is graded. Code runs only: a tests run's
 * testPaths are the learner's suite's, never the reference's.
 */
function collectNew(run: PhaseRun, at: string): void {
  // Test files only, by the hidden-test name rule in the run's own
  // language (`isHiddenTestName`, the rule the sealed-role door and publish
  // ask), so what is collected is exactly what may be held.
  if (isHiddenTestName(at, run.language) && !collects(run, at)) run.testPaths = [...run.testPaths, at];
}

/**
 * The run a new sealed file belongs to: the one in its language, else the first.
 *
 * A row whose path carries a run (`sealedRunRowPath`) is placed in that run
 * alone; a row without one is placed here, and a file a run
 * already holds is replaced in every run that holds it.
 */
function runForPath(runs: PhaseRun[], at: string): PhaseRun | undefined {
  const wanted = languagesOfPath(at) ?? [];
  return runs.find((run) => wanted.includes(run.language)) ?? runs[0];
}

/** The language(s) a run must speak to grade a file at this path, by its extension; null when the name says none. */
export function languagesOfPath(at: string): string[] | null {
  return /\.py$/.test(at) ? ['python'] : /\.[jt]sx?$/.test(at) ? ['typescript', 'javascript'] : null;
}

/**
 * The slice with each sealed row's bytes put where the loader would have put
 * them: a code task's hidden file into the run that holds that path (a new
 * path into the run of its language), its solution by workspace path; a tests
 * task's reference suite or implementation file into the flat map and every
 * run that holds it (a new test file into the suite, anything else into the
 * implementation), and a mutant file into its named mutant (a new name is a
 * new mutant, in the run of its language, in the loader's name order). The
 * flat unions are not touched here: `executableChecksOf` derives them after.
 */
export function overlaySealedRows(slice: CodeChecks | TestsChecks, sealed: readonly SealedRowBytes[]): CodeChecks | TestsChecks {
  const out = JSON.parse(JSON.stringify(slice)) as CodeChecks | TestsChecks;
  // A row that carries its run goes into that run alone, after every row
  // with the default placement, so the order rows arrive in never decides which run a
  // path-only row joins (a carried row never makes a run a "holder").
  const plain: SealedRowBytes[] = [];
  const carried: { row: SealedRowBytes; runId: string }[] = [];
  for (const row of sealed) {
    const own = sealedRowRunOf(row.path);
    if (own.runId === null) plain.push(row);
    else carried.push({ row: { ...row, path: own.path }, runId: own.runId });
  }
  for (const row of plain) {
    if (out.kind === 'code') {
      if (row.role === 'hidden' && row.path.startsWith('hidden/')) {
        const at = row.path.slice('hidden/'.length);
        const holders = out.runs.filter((run) => at in run.hiddenTestFiles);
        const targets = holders.length ? holders : [runForPath(out.runs, at)].filter((run): run is PhaseRun => Boolean(run));
        for (const run of targets) {
          run.hiddenTestFiles[at] = row.bytes;
          collectNew(run, at);
        }
        if (out.runs.length === 0) out.hiddenTestFiles[at] = row.bytes;
      } else if (row.role === 'solution' && row.path.startsWith('solution/')) {
        // The loader maps a solution onto the editable targets and nothing else
        // (`loadOverlay(solutionDir, editableTargets)`): a file at any other
        // path completes no stub, so it is not a solution of this task.
        const at = row.path.slice('solution/'.length);
        if (out.editableTargets.includes(at)) out.solutionFiles[at] = row.bytes;
      }
      continue;
    }
    if (row.role === 'reference' && row.path.startsWith('reference/')) {
      const at = row.path.slice('reference/'.length);
      const inSuite = at in out.referenceTestFiles || out.runs.some((run) => at in run.referenceTestFiles);
      const inImpl = at in out.implFiles || out.runs.some((run) => at in run.implFiles);
      const field: 'referenceTestFiles' | 'implFiles' = inSuite ? 'referenceTestFiles' : inImpl ? 'implFiles' : TEST_FILE.test(at) ? 'referenceTestFiles' : 'implFiles';
      out[field][at] = row.bytes;
      const holders = out.runs.filter((run) => at in run[field]);
      const targets = holders.length ? holders : [runForPath(out.runs, at)].filter((run): run is PhaseRun => Boolean(run));
      // A tests run collects the
      // learner's test files and nothing else: the loader refuses any
      // testPath that covers none of them (`loadRunTestPaths`). The reference
      // suite rides in the job's files where the learner's suite stands, so a
      // new reference test is mounted with its run and never collected here.
      for (const run of targets) run[field][at] = row.bytes;
    } else if (row.role === 'mutant' && row.path.startsWith('mutants/')) {
      const [name, ...rest] = row.path.slice('mutants/'.length).split('/');
      const file = rest.join('/');
      if (!name || !file) continue;
      const held = out.mutants.find((one) => one.name === name);
      if (held) held.files[file] = row.bytes;
      else out.mutants.push({ name, description: name, files: { [file]: row.bytes }, run: runForPath(out.runs, file)?.id ?? '' });
    }
  }
  for (const { row, runId } of carried) {
    const run = out.runs.find((one) => one.id === runId);
    if (!run) continue; // a run the slice does not have grades nothing (fail closed)
    if (out.kind === 'code') {
      if (row.role !== 'hidden' || !row.path.startsWith('hidden/')) continue;
      const at = row.path.slice('hidden/'.length);
      run.hiddenTestFiles[at] = row.bytes;
      collectNew(run, at);
      continue;
    }
    if (row.role !== 'reference' || !row.path.startsWith('reference/')) continue;
    const at = row.path.slice('reference/'.length);
    const inSuite = at in run.referenceTestFiles || at in out.referenceTestFiles;
    const inImpl = at in run.implFiles || at in out.implFiles;
    const field: 'referenceTestFiles' | 'implFiles' = inSuite ? 'referenceTestFiles' : inImpl ? 'implFiles' : TEST_FILE.test(at) ? 'referenceTestFiles' : 'implFiles';
    run[field][at] = row.bytes;
    // the flat map keeps what the runs that already hold the path hold
    if (!(at in out[field])) out[field][at] = row.bytes;
  }
  if (out.kind === 'tests') out.mutants.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * A sole work task's slice, with the flat unions the readers use derived from
 * it. A Maintenance's ticket and change request ride with the slice, so a
 * draft compile keeps the record its task row holds.
 */
function executableChecksOf(slice: CodeChecks | TestsChecks): CodeChecks | TestsChecks {
  if (slice.kind === 'tests') {
    return {
      kind: 'tests',
      learnerTestFiles: [...slice.learnerTestFiles],
      referenceTestFiles: { ...slice.referenceTestFiles },
      implFiles: { ...slice.implFiles },
      mutants: slice.mutants.map((mutant) => ({ ...mutant, files: { ...mutant.files } })),
      coverageKeywords: slice.coverageKeywords.map((group) => ({ ...group, keywords: [...group.keywords] })),
      minTests: slice.minTests,
      supportFiles: { ...slice.supportFiles },
      runs: slice.runs.map((run) => ({ ...run })),
    };
  }
  const runs = slice.runs.map((run) => ({ ...run }));
  const hiddenTestFiles: Record<string, string> = {};
  if (runs.length > 0) for (const run of runs) Object.assign(hiddenTestFiles, run.hiddenTestFiles);
  else Object.assign(hiddenTestFiles, slice.hiddenTestFiles);
  const solutionFiles = { ...slice.solutionFiles };
  return {
    kind: 'code',
    editableTargets: [...slice.editableTargets],
    visibleTests: runs.length > 0 ? [...new Set(runs.flatMap((run) => run.visibleTests))] : [...slice.visibleTests],
    hiddenTestFiles,
    solutionFiles,
    solutionSources: Object.values(solutionFiles),
    runs,
    ...(slice.ticket ? { ticket: { ...slice.ticket, acceptance: slice.ticket.acceptance.map((one) => ({ ...one })) } } : {}),
    ...(slice.change ? { change: { ...slice.change, floor: { ...slice.change.floor } } } : {}),
  };
}

/* ---- the executable task, read and saved ---- */

/**
 * A draft task row with the executable editor's view beside it.
 *
 * `DraftTaskView` in the contract declares the same optional member; this
 * alias names the shape the API builds (the web reads the same duck type,
 * `executable.ts`).
 */
export type DraftTaskWithExecutable = DraftTaskView & { executable?: ExecutableTaskView };

/** The longest run label a learner reads above a group of tests. */
export const RUN_LABEL_MAX = 80;
/** The longest workspace path a run may name, and the sealed-role door's cap on a sealed file's path. */
export const RUN_PATH_MAX = 240;

/**
 * A test run's closed shape, keyed exactly as the upload's rule keys it
 * (`upload-limits.ts`): a code run carries its hidden harness, a tests run
 * none. A run outside the list (publish refuses it, `runs-are-closed-shapes`)
 * reads as the shape of its language and kind, which is what the editor draws.
 */
export function testRunShapeOf(run: PhaseRun, kind: 'code' | 'tests'): TestRunShapeId {
  const hidden = kind === 'code' ? run.hiddenHarness ?? null : null;
  const found = RUN_SHAPES.find(
    (shape): shape is TestRunShape =>
      shape.kind === 'test-run' &&
      shape.language === run.language &&
      shape.harness === run.harness &&
      shape.hiddenHarness === hidden &&
      shape.transform === Boolean(run.transform),
  );
  if (found) return found.id;
  return `run-${run.language === 'python' ? 'python' : 'typescript'}${kind === 'code' ? '-hidden' : ''}` as TestRunShapeId;
}

/** Digests and sizes of a path -> bytes map, by path. Never the bytes. */
function sealedDigestsOf(files: Record<string, string>): SealedFileView[] {
  return Object.keys(files)
    .sort()
    .map((at) => ({ path: at, sha256: sha256Hex(files[at]), bytes: Buffer.byteLength(files[at], 'utf-8') }));
}

/**
 * The executable editor's view of a phase's **sole work task**, or
 * null for every other row.
 *
 * `phase` is the phase as `phaseFromTasks` derives it (the row's slice with
 * the teacher's sealed rows overlaid) so the view says what the next compile
 * grades. Every sealed member (the hidden suite, the reference solution or
 * implementation, the mutants) is a `SealedFileView`: a path, a sha256 and a
 * size. No member of this view holds a sealed byte, and the editor never reads
 * one back except through the owner-only `sealed.read`.
 */
export function executableTaskViewOf(
  row: ProjectTaskEntity,
  phase: Pick<PhaseContent, 'checks'>,
  owns: string[],
  sandboxBudget: number,
): ExecutableTaskView | null {
  if (!isAuthorableExecutableTask(row.checks.kind, row.artefactType)) return null;
  const checks = phase.checks;
  if (checks.kind !== row.checks.kind || (checks.kind !== 'code' && checks.kind !== 'tests')) return null;
  const kind = checks.kind;
  return {
    taskKey: row.taskKey,
    checkKind: kind,
    artefactType: kind,
    owns: [...owns],
    profile: 'baked',
    runs: checks.runs.map((run) => ({
      id: run.id,
      shape: testRunShapeOf(run, kind),
      label: run.label,
      testPaths: [...run.testPaths],
      visibleTests: kind === 'code' ? [...run.visibleTests] : [],
      learnerTestFiles: kind === 'tests' ? [...run.learnerTestFiles] : [],
      // the sealed-role door's `hidden` role: a code run's sealed suite, a tests run's reference suite
      hidden: sealedDigestsOf(kind === 'code' ? run.hiddenTestFiles : run.referenceTestFiles),
    })),
    minTests: checks.kind === 'tests' ? checks.minTests : null,
    coverageKeywords: checks.kind === 'tests' ? checks.coverageKeywords.flatMap((group) => [...group.keywords]) : [],
    solution: sealedDigestsOf(checks.kind === 'code' ? checks.solutionFiles : checks.implFiles),
    mutants:
      checks.kind === 'tests'
        ? checks.mutants.flatMap((mutant) =>
            sealedDigestsOf(mutant.files).map((one) => ({ ...one, path: `${mutant.name}/${one.path}` })),
          )
        : [],
    sandboxBudget,
  };
}

/** What `editedExecutableSlice` answers: the row's new slice, or the sentence that refuses the save. */
export type ExecutableEdit =
  | { checks: CodeChecks | TestsChecks; detail: Record<string, unknown> }
  | { refusal: string };

/** A workspace path a run may name: relative, `/`-separated, no `.`/`..` step, no reserved prefix. */
function isRunPath(at: unknown): at is string {
  if (typeof at !== 'string' || at.length === 0 || at.length > RUN_PATH_MAX) return false;
  if (at.startsWith('/') || at.includes('\\') || at.includes('\u0000') || /^[A-Za-z]:/.test(at)) return false;
  const parts = at.replace(/\/+$/, '').split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  return !RESERVED_FILE_PREFIXES.some((prefix) => at.startsWith(prefix));
}

/** Whether `entry` (a file or a folder) holds `at`, as the loader's `covers` asks it. */
function holds(entry: string, at: string): boolean {
  const dir = entry.replace(/\/+$/, '');
  return at === dir || at.startsWith(`${dir}/`);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((one, at) => one === b[at]);
}

/**
 * An executable task's editable members (`UpdateExecutableTaskBody`) applied
 * to its row's slice, or the sentence that refuses them. Pure.
 *
 * **Only what is not a byte, and only inside what the upload declared.** The
 * sealed roles go through the sealed-role door one file at a time; the smoke
 * and the drill change only by re-upload. What this saves:
 *
 * - each run's **label**, **testPaths** and (on a code run) **visibleTests**.
 *   The runs themselves are the project's: none added, removed, renamed,
 *   reordered or given another shape, because a run is a microVM priced
 *   at upload and a shape is a command the runner was reviewed for;
 * - a tests task's **minTests** (a whole number from 1 to 500).
 *
 * And it holds them to the loader's own rules, plus the one the grader needs:
 * a code run's every hidden file stays collected by
 * its `testPaths`, a tests run's every learner file likewise, so no sealed or
 * learner suite is mounted and never graded; a visible test is a file the
 * phase ships. `owns`, a tests run's `learnerTestFiles` and the coverage
 * keywords are accepted only as they are: which files are editable is set on
 * the starter's rows at upload (a role is never updated), a learner file is
 * where the reference suite lands, and a keyword group is the criterion it
 * evidences: a flat list cannot regroup it (the contract's
 * `coverageKeywords: string[]` is flat).
 *
 * `current` is the derived slice the view showed (sealed rows overlaid), which
 * is what the hidden files are asked of; the answer is written onto `slice`,
 * the row's own, so the overlay still applies on the next compile.
 */
export function editedExecutableSlice(input: {
  slice: CodeChecks | TestsChecks;
  current: CodeChecks | TestsChecks;
  phase: Pick<PhaseContent, 'title' | 'files'>;
  owns: readonly string[];
  body: UpdateExecutableTaskBody;
}): ExecutableEdit {
  const { slice, current, phase, owns, body } = input;
  const title = phase.title;
  const kind = slice.kind;
  const refuse = (refusal: string): ExecutableEdit => ({ refusal });

  if (body.owns !== undefined) {
    const asked = [...new Set(body.owns)].sort();
    if (!sameList(asked, [...new Set(owns)].sort())) {
      return refuse(
        `${title}'s learner works in the files the project's starter makes editable, and those are set when the project is uploaded. Upload the project again to change which files are editable.`,
      );
    }
  }
  if (kind === 'code') {
    if (body.minTests !== undefined && body.minTests !== null) {
      return refuse(`${title} grades the learner's code against its hidden tests, so it has no smallest suite to set; only a testing task does.`);
    }
    if (body.coverageKeywords !== undefined && body.coverageKeywords.length > 0) {
      return refuse(`${title} grades the learner's code against its hidden tests, so it has no coverage keywords; only a testing task does.`);
    }
  } else {
    if (body.minTests !== undefined) {
      const wanted = body.minTests;
      if (wanted === null || !Number.isInteger(wanted) || wanted < 1 || wanted > 500) {
        return refuse(`The smallest suite a learner may hand in for ${title} is a whole number of tests from 1 to 500.`);
      }
    }
    if (body.coverageKeywords !== undefined) {
      const held = (current as TestsChecks).coverageKeywords.flatMap((group) => group.keywords);
      if (!sameList(body.coverageKeywords, held)) {
        return refuse(
          `${title}'s coverage keywords are grouped by the acceptance criterion each group evidences, and this editor cannot regroup them yet. Upload the project again to change them.`,
        );
      }
    }
  }

  const out = JSON.parse(JSON.stringify(slice)) as CodeChecks | TestsChecks;
  const detail: Record<string, unknown> = {};
  if (body.runs !== undefined) {
    const was = current.runs;
    if (!sameList(body.runs.map((run) => run?.id), was.map((run) => run.id))) {
      return refuse(
        `${title}'s test runs are the ones the project was uploaded with: a run cannot be added, removed, renamed or moved here. Upload the project again to change its runs.`,
      );
    }
    const files = new Set(phase.files.map((file) => file.path));
    for (const [index, asked] of body.runs.entries()) {
      const held = was[index];
      const name = `${title}'s run "${held.id}"`;
      if (asked.shape !== testRunShapeOf(held, kind)) {
        return refuse(`${name} keeps the run shape it was uploaded with: a shape is a command the runner was reviewed for. Upload the project again to change it.`);
      }
      const label = typeof asked.label === 'string' ? asked.label.trim() : '';
      if (label.length === 0 || label.length > RUN_LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label)) {
        return refuse(`${name} needs a label of 1 to ${RUN_LABEL_MAX} characters on one line: it is the heading a learner reads above its tests.`);
      }
      const paths = [...(asked.testPaths ?? []), ...(asked.visibleTests ?? []), ...(asked.learnerTestFiles ?? [])];
      if (!paths.every(isRunPath)) {
        return refuse(`${name} names a path that is not a plain path inside the project (no leading /, no . or .. step, no reserved folder).`);
      }
      const testPaths = asked.testPaths ?? [];
      if (testPaths.length === 0 || testPaths.length > 20) {
        return refuse(`${name} must collect between 1 and 20 test paths.`);
      }
      // what the graded run must collect: a code run's sealed suite, a tests run's learner suite
      const graded = kind === 'code' ? Object.keys(held.hiddenTestFiles) : held.learnerTestFiles;
      if (!testPaths.every((entry) => graded.some((at) => holds(entry, at)))) {
        return refuse(`${name} collects a test path that holds none of its ${kind === 'code' ? 'hidden' : "learner's"} test files.`);
      }
      if (!graded.every((at) => testPaths.some((entry) => holds(entry, at)))) {
        return refuse(
          `${name} would no longer collect ${kind === 'code' ? 'every file of its hidden suite, so part of it would be mounted and never graded' : "every file of the learner's suite, so part of it would never run"}. Keep each one under a test path.`,
        );
      }
      const target = out.runs.find((run) => run.id === held.id);
      if (!target) return refuse(`${name} is not one of the runs this task was uploaded with.`);
      target.label = label;
      target.testPaths = [...testPaths];
      if (kind === 'code') {
        const visible = asked.visibleTests ?? [];
        if ((asked.learnerTestFiles ?? []).length > 0) {
          return refuse(`${name} grades the learner's code, so it holds no learner suite; only a testing task does.`);
        }
        if (visible.length === 0 || visible.length > 40 || !visible.every((at) => files.has(at))) {
          return refuse(`${name}'s visible tests must be 1 to 40 files the phase ships, so the learner can run them.`);
        }
        target.visibleTests = [...visible];
      } else {
        if ((asked.visibleTests ?? []).length > 0) {
          return refuse(`${name} grades the learner's own suite, so it has no visible tests; only a coding task does.`);
        }
        if (!sameList(asked.learnerTestFiles ?? [], held.learnerTestFiles)) {
          return refuse(
            `${name}'s learner test files are where the reference suite lands, and they are set when the project is uploaded. Upload the project again to change them.`,
          );
        }
      }
    }
    if (out.kind === 'code') out.visibleTests = [...new Set(out.runs.flatMap((run) => run.visibleTests))];
    detail.runs = body.runs.length;
  }
  if (out.kind === 'tests' && body.minTests !== undefined && body.minTests !== null) {
    out.minTests = body.minTests;
    detail.minTests = body.minTests;
  }
  return { checks: out, detail };
}

/* ------------- the wording an older-format conversion keeps ------------- */

/** The rules and the word floor one task is scored by, at one moment. */
export interface TaskScoring {
  rules: AuthoredRule[];
  minWords?: number;
  minWordsCriterion?: string;
}

/**
 * The keys of `existing`'s criteria whose wording the teacher wrote: neither
 * what the scoring `was` derives nor the pack's (`pack`, by key; `[]` for a
 * task the teacher added). None when `pack` is null, since wording that
 * cannot be told apart from the pack's is not guessed at. The older-format
 * conversions keep them in front of the rule sentences they write.
 */
export function teacherWordedKeys(
  existing: PhaseRubric,
  was: TaskScoring,
  pack: readonly RubricCriterion[] | null,
): Set<string> {
  if (pack === null) return new Set();
  const derived = derivedWordingOf(was);
  const shipped = new Map(pack.map((one) => [one.key, one]));
  const same = (a: Pick<RubricCriterion, 'title' | 'description'> | undefined, b: RubricCriterion) =>
    a !== undefined && a.title === b.title && (a.description ?? '') === (b.description ?? '');
  return new Set(
    existing.criteria
      .filter((one) => !same(derived.get(one.key), one) && !same(shipped.get(one.key), one))
      .map((one) => one.key),
  );
}

/**
 * The title and description a rules rubric gives each criterion of `at`, by
 * key, in the learner's voice: the first rule's label and the rule count, or
 * "Enough written" and the word floor for a criterion only the floor scores.
 * Worked out here from the rules and the floor alone.
 */
function derivedWordingOf(at: TaskScoring): Map<string, Pick<RubricCriterion, 'key' | 'title' | 'description' | 'weight'>> {
  const out = new Map<string, Pick<RubricCriterion, 'key' | 'title' | 'description' | 'weight'>>();
  const counts = new Map<string, number>();
  for (const rule of at.rules) counts.set(rule.criterion, (counts.get(rule.criterion) ?? 0) + 1);
  for (const rule of at.rules) {
    if (out.has(rule.criterion)) continue;
    out.set(rule.criterion, { key: rule.criterion, title: rule.label, weight: 0, description: learnerRuleCountDescription(counts.get(rule.criterion)!) });
  }
  if (at.minWordsCriterion && !out.has(at.minWordsCriterion)) {
    out.set(at.minWordsCriterion, {
      key: at.minWordsCriterion,
      title: 'Enough written',
      weight: 0,
      description: at.minWords === undefined ? 'The artefact is long enough to judge.' : `The artefact is at least ${at.minWords} words long.`,
    });
  }
  return out;
}

/* ------------------------------ the draft pack ---------------------------- */

export interface DraftPhaseSource {
  row: ProjectPhaseEntity;
  /** The phase's workspace rows, as the pack mounts them. */
  files: ContentFileSpec[];
}

export interface DraftContentInput {
  /** The copy's own compiled content: everything a teacher cannot author. */
  base: ProjectContent;
  slug: string;
  /** What this content will be published as, or the draft's version while drafting. */
  version: string;
  title: string;
  manifest: ProjectVersionManifest;
  phases: DraftPhaseSource[];
}

/**
 * The `ProjectContent` a draft compiles to: the base pack, with everything a
 * teacher can change overlaid from the rows.
 *
 * A phase the rows do not carry is dropped rather than kept, and a row with no
 * base phase is dropped rather than invented: a phase's checks, assistant
 * block and sealed material come from the pack, so there is nothing to build a
 * phase out of that the copy did not bring.
 */
export function contentForDraft(input: DraftContentInput): ProjectContent {
  const basePhases = new Map(input.base.phases.map((phase) => [phase.key, phase]));
  const phases = [...input.phases]
    .sort((a, b) => a.row.order - b.row.order)
    .map((source, at) => {
      const base = basePhases.get(source.row.key);
      if (!base) return null;
      const phase: PhaseContent = {
        ...base,
        order: at + 1,
        title: source.row.title,
        intro: source.row.intro,
        artifactKind: source.row.artifactKind,
        canRun: source.row.canRun,
        canPreview: source.row.canPreview,
        runLabel: source.row.runLabel,
        assistant: source.row.assistant,
        files: source.files,
      };
      if (source.row.interview) phase.interview = source.row.interview;
      else delete phase.interview;
      return phase;
    })
    .filter((phase): phase is PhaseContent => phase !== null);

  const content: ProjectContent = {
    ...input.base,
    slug: input.slug,
    version: input.version,
    title: input.title,
    tagline: input.manifest.tagline,
    description: input.manifest.description,
    language: input.manifest.language,
    languages: [...input.manifest.languages] as ProjectContent['languages'],
    phases,
  };
  if (input.manifest.build) content.build = input.manifest.build;
  else delete content.build;
  if (input.manifest.runtime) content.runtime = input.manifest.runtime;
  else delete content.runtime;
  if (input.manifest.preview) content.preview = input.manifest.preview;
  else delete content.preview;
  if (input.manifest.warmup) content.warmup = input.manifest.warmup;
  else delete content.warmup;
  return content;
}

/**
 * A phase's workspace rows as the pack mounts them, in an order that does not
 * move when a teacher adds a file.
 *
 * The base pack's own order first, because that is the order the project was
 * written in and the order every golden digest of it was taken in; anything a
 * teacher added after it, by path, so the list is a function of the rows and
 * not of the order rows happened to be inserted.
 */
export function phaseFilesFrom(
  rows: ProjectFileEntity[],
  baseFiles: ContentFileSpec[],
  bytesOf: (blobSha: string) => string,
  options: BaseBytesOptions = {},
): ContentFileSpec[] {
  const at = new Map(baseFiles.map((file, index) => [file.path, index]));
  const baseAt = new Map(baseFiles.map((file) => [file.path, file]));
  return [...rows]
    .sort((a, b) => {
      const left = at.get(a.path) ?? Number.MAX_SAFE_INTEGER;
      const right = at.get(b.path) ?? Number.MAX_SAFE_INTEGER;
      return left === right ? a.path.localeCompare(b.path) : left - right;
    })
    .map((row) => {
      const base = baseAt.get(row.path);
      return {
        path: row.path,
        // The base's bytes only while the row still holds them. The base
        // holds the bytes of every path the copy brought, so an untouched row
        // costs no read, but a row whose bytes a teacher replaced at a
        // brought path holds a new blob, and taking the base's bytes by path
        // alone would compile the old document and write it back into the
        // snapshot on the next save.
        content: base !== undefined && holdsBaseBytes(row, base, options) ? base.content : bytesOf(row.blobSha),
        editable: row.editable,
        language: row.language ?? '',
      };
    });
}

/**
 * How `phaseFilesFrom` and `blobsToRead` treat the bytes the base holds.
 *
 * `trustBase` is for a phase whose files are an **application's** (`code`,
 * `tests`, `config`): every authoring door refuses their bytes, so a row there
 * always holds what the copy brought, and hashing half a megabyte of
 * application on every load to learn that is a cost worth avoiding. A written
 * phase is always asked.
 *
 * `record` is the one path of such a phase a door does write: a Deployment's
 * starting runbook or a Maintenance's starting change request
 * (`recordPathOf`), which `replaceFile` stores. Its row is always asked, so an
 * edited starting record is what the draft compiles and publish publishes.
 */
export interface BaseBytesOptions {
  trustBase?: boolean;
  record?: string | null;
}

/**
 * The base file's sha256, once per file object. A load hands the same
 * base objects to `blobsToRead` and then to `phaseFilesFrom`, so each is hashed
 * once per load and never twice.
 */
const baseShas = new WeakMap<ContentFileSpec, string>();

function baseShaOf(file: ContentFileSpec): string {
  let sha = baseShas.get(file);
  if (sha === undefined) {
    sha = sha256Hex(file.content);
    baseShas.set(file, sha);
  }
  return sha;
}

/** Whether a row at a brought path still holds the base's bytes. */
function holdsBaseBytes(row: ProjectFileEntity, base: ContentFileSpec, options: BaseBytesOptions): boolean {
  return (options.trustBase === true && row.path !== options.record) || baseShaOf(base) === row.blobSha;
}

/**
 * The blobs a load has to read for one phase's rows: every row the base does
 * not hold, and every row whose bytes are no longer the base's.
 * The same question `phaseFilesFrom` asks, so the two can never disagree about
 * which rows read a blob.
 */
export function blobsToRead(
  rows: ProjectFileEntity[],
  baseFiles: ContentFileSpec[],
  options: BaseBytesOptions = {},
): string[] {
  const baseAt = new Map(baseFiles.map((file) => [file.path, file]));
  const out = new Set<string>();
  for (const row of rows) {
    const base = baseAt.get(row.path);
    if (base === undefined || !holdsBaseBytes(row, base, options)) out.add(row.blobSha);
  }
  return [...out];
}

/** The three kinds whose files are an application's, which no authoring door writes. */
const APPLICATION_KINDS: ReadonlySet<string> = new Set(['code', 'tests', 'config']);

/**
 * Whether a phase's files are an application's: Implementation, Testing,
 * Deployment and Maintenance in the reference project. Asked of the phase's
 * own checks, which is what grades it.
 */
export function isApplicationPhase(phase: Pick<PhaseContent, 'checks'> | undefined): boolean {
  return Boolean(phase && phase.checks && APPLICATION_KINDS.has(phase.checks.kind));
}

/* -------------------------------- the views ------------------------------- */

/**
 * A quiz as the draft payload shows it: stems, options, counts, and neither
 * the key nor the explanations.
 *
 * The reason is the guard rather than authorship. `readDraft` and `listTasks`
 * are behind `requireVisibleProject`, which admits **every instructor on the
 * deployment for any platform-owned project** and any `ADMIN` for anybody's;
 * and `authorable` is a question about kind and type, so widening it for quiz
 * sets it true for inherited quiz rows too. The full `AuthoredQuiz` is
 * returned by one route only, `GET …/tasks/:taskKey/quiz/key`, guarded by
 * `requireOwnedProject` and audited the way `solution.read` is.
 *
 * `answerCount` and not `correctCount`: the string `correct` appears nowhere
 * in a payload that is not the key route's, so the seal is one substring
 * assertion over a whole serialised response rather than a field-by-field
 * walk.
 */
export function quizViewOf(checks: QuizChecks): AuthoredQuizView {
  const view: AuthoredQuizView = {
    questions: checks.questions.map((question) => {
      const one: AuthoredQuizViewQuestion = {
        id: question.id,
        stem: question.stem,
        options: question.options.map((option) => ({ id: option.id, text: option.text })),
        answerCount: question.correct.length,
      };
      if (question.concept !== undefined) one.concept = question.concept;
      return one;
    }),
    shuffleOptions: checks.shuffleOptions,
    passMark: checks.passMark,
    attempts: { ...checks.attempts },
    criterion: checks.criterion,
  };
  if (checks.drawn !== undefined) view.drawn = checks.drawn;
  // The reveal, echoed as it was written; absent on
  // a quiz that keeps the default rule. It names when explanations are shown and
  // carries none of them, so the view stays sealed.
  if (checks.revealExplanation !== undefined) view.revealExplanation = checks.revealExplanation;
  return view;
}

/**
 * One task, as the editor draws it. `olderDesign` is a Design task still in
 * the older format, as it would convert (`olderDesignView`): the view carries
 * those checks and that rubric, marked, and nothing is written.
 */
export function draftTaskView(
  row: ProjectTaskEntity,
  owns: string[],
  olderDesign?: { checks: DesignChecks; rubric: PhaseRubric } | null,
): DraftTaskView {
  const checkKind = row.checks.kind;
  const authorable = isAuthorableTask(checkKind, row.artefactType);
  if (row.checks.kind === 'quiz') {
    return {
      taskKey: row.taskKey,
      order: row.order,
      required: row.required,
      title: row.title,
      brief: row.brief,
      artefactType: row.artefactType,
      artefactPath: row.artefactPath,
      checkKind,
      quiz: quizViewOf(row.checks),
      rubric: row.rubric,
      objectives: row.objectives ?? [],
      owns,
      authorable,
      notice: authorable ? null : INHERITED_TASK_NOTICE,
      // The sign-off mark, present only when set
      // (absent reads as false), so an unmarked draft's payload keeps
      // the shape every recording pins (contract-bodies/copy-provenance.json).
      ...(row.signOff === true ? { signOff: true } : {}),
    };
  }
  return {
    taskKey: row.taskKey,
    order: row.order,
    required: row.required,
    title: row.title,
    brief: row.brief,
    artefactType: row.artefactType,
    artefactPath: row.artefactPath,
    checkKind,
    rubric: row.rubric,
    objectives: row.objectives ?? [],
    owns,
    authorable,
    notice: authorable ? null : INHERITED_TASK_NOTICE,
    // A story task's floor and stories, which its editor draws in place of rules.
    ...(row.checks.kind === 'story' ? { story: row.checks } : {}),
    // A design task's switches, stories and floor, which the builder draws in place of rules.
    ...(row.checks.kind === 'design' ? { design: row.checks } : {}),
    ...(olderDesign ? { design: olderDesign.checks, designOlderFormat: true as const, rubric: olderDesign.rubric } : {}),
    // The sign-off mark, present only when set
    // (absent reads as false), so an unmarked draft's payload keeps
    // the shape every recording pins (contract-bodies/copy-provenance.json).
    ...(row.signOff === true ? { signOff: true } : {}),
  };
}

/**
 * One phase, as the editor draws it, with the gate beside it and not only in
 * the report.
 *
 * `checkKind` is **what scores the phase**, and the caller passes the same
 * answer the report is built from: `content.checks.kind` where the draft has
 * compiled content, and the phase row's own `artifactKind` where it has not.
 * The two fields are independent in a pack and the gate is per kind, so
 * asking the wrong one would let the editor say a phase blocks
 * publish while the report it is drawn beside says it does not, which is the
 * one property this whole tier exists to keep.
 */
export function draftPhaseView(
  row: ProjectPhaseEntity,
  tasks: DraftTaskView[],
  checkKind: ArtifactKind = row.artifactKind,
): DraftPhaseView {
  return {
    key: row.key,
    order: row.order,
    title: row.title,
    intro: row.intro,
    artifactKind: row.artifactKind,
    // What grades the phase, carried beside what the phase row calls itself,
    // so the editor's banner says the same sentence the report's gate row
    // says. Without it the console can only ask `artifactKind`, and the day a
    // pack declares a phase graded by something other than its own kind a
    // teacher reads two wordings for one refusal.
    checkKind,
    tasks,
    // The **non-quiz** count, which is what the compiler's wall
    // counts. `publishableTasksPerPhase` is kind-only
    // and is asked the phase's kind here, and widening it would admit a phase
    // whose own checks are `quiz` holding many tasks. Counting every task
    // instead would have the editor tell a teacher their version cannot ship
    // while the door let it through, which is the one property this tier
    // exists to keep. For a phase with no quiz this is `tasks.length`.
    blocksPublish: refusesMultiTaskPublish(nonQuizTasks(tasks).length, checkKind),
  };
}

/**
 * The stakeholder interview as the draft payload shows it: who the
 * stakeholder is, how they open, the limits and each fact's
 * topic, and no answer, no keyword, no `unknownReply` and no `refusal`. The
 * draft is readable by every instructor who can see the project, so the whole
 * brief is `interview.read`'s alone, as a quiz's key is `quizKey`'s.
 */
export function draftInterviewViewOf(brief: InterviewBrief): DraftInterviewView {
  return {
    persona: { name: brief.persona.name, role: brief.persona.role },
    opening: brief.opening,
    maxTurns: brief.maxTurns,
    factsExpected: brief.factsExpected,
    facts: brief.facts.map((fact) => ({ id: fact.id, topic: fact.topic })),
  };
}

/**
 * One file row, and the seal on it.
 *
 * `sealed` is `!isAuthoringReadableRole(role)` and `content` is the bytes only
 * where that admits them, which is `workspace` and `warmup` and nothing else.
 * `canonical` is not in the sealed set (a phase may legitimately mount it as a
 * locked workspace row) and it is still 484 KB of finished application whose
 * bytes an authoring response has no business carrying, so it is withheld here
 * with a sentence of its own.
 *
 * The tree shows no role control at all rather than a disabled one, because a
 * role is set when a row is created and is never updated.
 */
export function authoringFileView(
  row: ProjectFileEntity,
  size: number,
  bytes: string | null,
  phaseKey: PhaseKey | null,
): AuthoringFileView {
  const readable = isAuthoringReadableRole(row.role);
  return {
    id: row.id,
    ownerKind: row.ownerKind,
    phaseKey,
    path: row.path,
    role: row.role,
    editable: row.editable,
    language: row.language,
    size,
    sealed: !readable,
    content: readable ? bytes : null,
    notice: readable ? null : row.role === 'canonical' ? CANONICAL_FILE_NOTICE : SEALED_FILE_NOTICE,
  };
}

/* ------- the editor's words overlay and draft compile ------- */

/**
 * A member's name with the article it reads with at the head of a sentence:
 * "An objective", "A brief", "A criterion title". Every empty and cap sentence
 * of the editor's doors, and of the upload door that repeats them, opens with
 * it, so no sentence says "A objective".
 */
export function withArticle(what: string): string {
  return `${/^[aeiou]/i.test(what) ? 'An' : 'A'} ${what}`;
}

/** The editor's empty sentence for a member: "An objective cannot be empty.", "A brief cannot be empty.". */
export function emptyRefusal(what: string): string {
  return `${withArticle(what)} cannot be empty.`;
}

/** The editor's cap sentence for a member, naming the teacher's own length. */
export function overCapRefusal(what: string, max: number, length: number): string {
  return `${withArticle(what)} is at most ${max} characters, and this one is ${length}.`;
}

/**
 * A text field trimmed, non-empty and at most `max` characters, or the
 * editor's own refusal. `authoring.service.ts` imports it from here.
 */
export function requireText(value: unknown, what: string, max: number): string {
  const text = String(value ?? '').trim();
  if (text.length === 0) throw new BadRequestException(emptyRefusal(what));
  if (text.length > max) throw new BadRequestException(overCapRefusal(what, max, text.length));
  return text;
}

/**
 * A teacher's text as the editor's doors store it: `requireText`'s
 * refusals asked of what was sent (so a cap names the teacher's own length),
 * then `plainTextOf` of it, and a text the conversion leaves blank (only `#`,
 * `---` or `***`) refused in `requireText`'s own empty sentence, so no member is
 * stored as "".
 */
export function requirePlainText(value: unknown, what: string, max: number): string {
  const plain = plainTextOf(requireText(value, what, max));
  if (plain.trim().length === 0) throw new BadRequestException(emptyRefusal(what));
  return plain;
}

/**
 * `plainTextOf` of a text a door's own check has already passed.
 * A text the conversion turns blank (only `#`, `---` or `***`) is refused in
 * `sentence`, the door's own empty sentence, so markdown alone is never stored
 * as "". A text sent blank stays the door's check's to judge; a
 * member that is not a string is returned as it is.
 */
export function plainOrRefuse<T>(text: T, sentence: string): T {
  if (typeof text !== 'string') return text;
  const plain = plainTextOf(text);
  if (text.trim().length > 0 && plain.trim().length === 0) throw new BadRequestException(sentence);
  return plain as T;
}

/** The words of a task an edit may carry: `UpdateTaskBody`'s three. */
export interface TaskWordsBody {
  title?: string;
  brief?: string;
  objectives?: string[];
}

/**
 * The editor's overlay of a task's words (`tasks.update`, the written arm and
 * the executable arm alike): each member present is trimmed, held to its cap
 * and stored as `plainTextOf` of it, refused as empty when that
 * is blank (`requirePlainText`); an absent one is unchanged.
 * The cap is asked of what was sent, so a refusal names the teacher's own
 * length; a text already plain is stored as sent. `patch` is what the task row takes and
 * `moved` what the audit row says. The importer's phase.json `task` block is
 * applied through this same function, so an uploaded task
 * reads exactly as the same words saved in the editor would.
 */
export function taskWordsPatch(body: TaskWordsBody): {
  patch: Partial<Pick<ProjectTaskEntity, 'title' | 'brief' | 'objectives'>>;
  moved: Record<string, unknown>;
} {
  const patch: Partial<Pick<ProjectTaskEntity, 'title' | 'brief' | 'objectives'>> = {};
  const moved: Record<string, unknown> = {};
  if (body.title !== undefined) {
    patch.title = requirePlainText(body.title, 'title', TASK_TITLE_MAX);
    moved.title = patch.title;
  }
  if (body.brief !== undefined) {
    patch.brief = requirePlainText(body.brief, 'brief', TASK_BRIEF_MAX);
    moved.brief = true;
  }
  if (body.objectives !== undefined) {
    patch.objectives = body.objectives.map((one) => requirePlainText(one, 'objective', TASK_OBJECTIVE_MAX));
    moved.objectives = patch.objectives.length;
  }
  return { patch, moved };
}

/** The phase, with the documents its design task switches on seeded where no row mounts them; the phase itself when nothing is missing. */
function withDesignDocuments(phase: PhaseContent, rows: readonly ProjectTaskEntity[]): PhaseContent {
  const design = rows.find((row) => row.checks.kind === 'design');
  if (!design || design.checks.kind !== 'design') return phase;
  const files = [...phase.files];
  seedDesignDocuments(files, design.checks);
  return files.length === phase.files.length ? phase : { ...phase, files };
}

/** What `compileDraft` reads: a draft's content and its rows (`DraftContext`'s four members). */
export interface DraftCompileInput {
  content: ProjectContent;
  phases: readonly ProjectPhaseEntity[];
  /** Task rows by phase row id, in order. */
  tasks: ReadonlyMap<string, ProjectTaskEntity[]>;
  /** Per executable phase key, the sealed rows whose bytes are not the slice's. */
  sealed: ReadonlyMap<string, SealedRowBytes[]>;
}

/**
 * The editor's draft compile: the compiled snapshot of a draft's rows, or the
 * compiler's own sentence. `AuthoringService.compile` delegates here, so the
 * importer's task block
 * compiles a fresh upload exactly as the editor compiles the same edit.
 */
export function compileDraft(
  context: DraftCompileInput,
  version: string,
): { snapshot: CompiledSnapshot | null; error: string | null; content: ProjectContent } {
  const content: ProjectContent = { ...context.content, version };
  const authored: Record<string, AuthoredTask[]> = {};
  const phases: ProjectContent['phases'] = [];
  // A derivation refusal is carried, never thrown, for the same reason the
  // compiler's is: a teacher saving a half-finished pair of tasks must be
  // able to save it and read why it would not publish. The loop still runs
  // to the end so `content.phases` stays whole and the report keeps a row
  // for every phase.
  let derivationError: string | null = null;
  for (const phase of content.phases) {
    const row = context.phases.find((one) => one.key === phase.key);
    if (!row) {
      phases.push(phase);
      continue;
    }
    const rows = context.tasks.get(row.id) ?? [];
    // A split pack does not arrive from a fixture, it
    // arrives from here. `gradedUnitsOf(phase)` is minted from
    // `phase.checks.rules`, so a phase holding two tasks has to *be* its
    // tasks before `compilePack` asks whether they partition it: otherwise
    // `tasks-partition-units` refuses every split written phase a teacher
    // writes, naming a rule the phase declares and no task owns. A phase
    // holding one task is handed back untouched, so the overlay below is
    // the ordinary one-task overlay.
    // A design task's phase mounts its record (and each contract switched on)
    // seeded when no row holds it, as the loader seeds a pack's, before
    // anything asks what the phase's tasks own.
    const mounted = withDesignDocuments(phase, rows);
    let source = mounted;
    try {
      source = phaseFromTasks(mounted, rows, context.sealed.get(phase.key) ?? []);
    } catch (error) {
      derivationError ??= (error as Error).message;
    }
    // Against the derived phase, so `authoredTasksFor`'s omission asks the
    // question `checksOf` will answer: a task whose slice is byte for byte
    // the phase's carries no `checks` and reads the phase's back. On a split
    // phase every slice is a proper part of the union, so every task
    // declares one and `authored-tasks-declare-a-slice` is satisfiable.
    // The sole executable work row carries the derived checks, on
    // every compile: the base is the previous compile's output, so a
    // derivation that already landed comes back as `source === phase` and
    // the raw row (stale unions) must still not reach the overlay.
    const tasks = authoredTasksFor(source, rowsForExecutablePhase(source, rows));
    authored[phase.key] = tasks;
    // What a learner actually reads, and what actually scores them.
    //
    // `PhaseContent.taskPanel` is the markdown the room's right column
    // renders: `workflow.service.ts` hands it to `PhaseDetail`, and
    // `openai.provider.ts` sends it to the reviewer as the trusted
    // brief. A task's Brief *lands on* `PhaseContent.taskPanel`, and nothing
    // else in authoring writes that field, so without this line a teacher can rewrite a
    // brief, publish it, assign it and watch their class read the words
    // TaskTrackr shipped with. The whole teacher half would reach no
    // learner.
    //
    // **The phase's sole non-quiz task's, not its first task's.** `tasks[0]`
    // is whatever `tasks.reorder` last put first, so a quiz ordered first
    // would put *the quiz's* brief on a field that is read
    // by the room (`workflow.service.ts`), by the IDE mentor's system
    // prompt as the *trusted phase brief* (`agentic.service.ts`), by the
    // mentor's output reviewer (`openai.provider.ts`), by
    // `mentorInstructionIdentity` (so every cached reply for the
    // phase is invalidated), by `integrityFor`'s `given` set
    // (`feedback.service.ts`, which is what stops words the pack handed
    // the learner reading as a mentor paste on the *executable* task's
    // report), by the `CR-\d+` parser the learner's project map and the
    // maintenance ticket panel both scan (`packages/shared/src/map.ts`),
    // and by the testing panel. A quiz speaks for its own
    // questions and for nothing else, so the phase's brief is the task that
    // produces its artefact. `find` and not `soleNonQuizTask`: a phase
    // holding two written tasks has no sole one, and its first task is
    // still the right brief.
    //
    // For every phase that holds no quiz this is `tasks[0]` exactly, which
    // is the identity the content golden net already asserts.
    //
    // An untouched copy is unchanged by it: `createProject` materialises the
    // inherited task with `brief: sole.brief`, and `soleTaskFor` sets that
    // from `phase.taskPanel`. The seeded default never passes through here
    // at all (the importer compiles its own pack) so no golden digest of
    // TaskTrackr moves.
    //
    // **`checks` and `rubric` ride the same overlay, for the same reason.**
    // The grader reads neither from a task: `buildFeedback` switches on
    // `phase.checks.kind` and hands `phase.checks` to the builder, and
    // the builder scores against `phase.rubric`. A teacher's rules
    // land on the task row and reach the snapshot as `CompiledTask.checks`,
    // which nothing on the grading path reads, so without these two lines
    // no rule a teacher ever writes scores a learner, and the supported
    // sequence "add my own task, remove the one I inherited, publish" ships a
    // phase whose checks name a file the version no longer mounts: the
    // grader reads the empty string, every rule fails, and every learner
    // scores 0.
    //
    // Only where the phase holds exactly one task. That is not caution for
    // its own sake: `authoredTasksFor` omits a task's `checks` when they are
    // byte for byte the phase's, and `checksOf` reads that omission back off
    // the phase, so overlaying one task's checks onto a phase that still
    // holds a second, un-overlaid task would silently re-point that task's
    // grading at the first one's files. A split written phase is assembled
    // by `phaseFromTasks` instead, which is the derivation above.
    //
    // A split written phase is refused at publish (`publishableTasksPerPhase`
    // in `packages/shared/src/authoring.ts` allows one non-quiz task per
    // phase), and while it is a draft this overlay stops for it. The
    // count is the right test for every kind but a story: a quiz beside a
    // written or executable artefact task makes `sole` null and stops the
    // overlay, and that is the identity rather than a gap. A story phase is
    // the exception, below: its one work task beside concept quizzes is still
    // `sole`, and its checks and rubric are overlaid onto the phase, because
    // the learner room reads the story from `phase.checks`. The phase's **sole non-quiz
    // task** may omit its own slice
    // precisely because `checksOf` answers the phase's checks for it, so
    // `phase.checks` and `phase.rubric` already hold the values this overlay
    // would have written. The exemption is that task's and never a quiz's:
    // a quiz falling back to an executable phase's checks would reach
    // `case 'code'` in `referenceFiles` and hand a learner the model answer
    // through a gate its own pass had opened.
    //
    // An untouched copy is again the identity: the inherited task carries
    // the phase's own checks and rubric, so `sole.checks` is undefined and
    // `sole.rubric` is the phase's.
    const isQuiz = (task: AuthoredTask): boolean =>
      isQuizTask({ checkKind: task.checks?.kind ?? source.checks.kind });
    const lead = tasks.find((task) => !isQuiz(task)) ?? tasks[0];
    // A story phase whose one work task sits beside concept quizzes is still
    // that task's: the learner room draws the story, its floor and its provided
    // stories from `phase.checks` (`phaseDetailStory`), so without this a
    // teacher's story edit would grade the learner on one story and show them
    // another. A quiz always declares its own slice, so the overlay re-points
    // no quiz's grading.
    // A design phase is the same: the room reads its switches and floor from
    // `phase.checks` (`PhaseDetail.design`), and the workspace guard reads
    // them there too. The work task's own kind decides, not the base's: a
    // Design task converted by its first design save sits on a phase whose
    // stored checks are still the older markdown ones until this compile.
    const work = tasks.filter((task) => !isQuiz(task));
    const workKind = work.length === 1 ? (work[0].checks?.kind ?? source.checks.kind) : null;
    const structuredBesideQuizzes =
      (workKind === 'story' && source.checks.kind === 'story') || workKind === 'design';
    const sole = tasks.length === 1 ? lead : structuredBesideQuizzes ? work[0] : null;
    // **The phase's objectives are its non-quiz tasks' objectives**,
    // de-duplicated in task order. Left as the copy brought them, a copy's
    // learners would read the reference project's objectives over the
    // teacher's own tasks (`PhaseDetail.objectives`, the Brief). An untouched copy is
    // the identity: the inherited task's objectives are the sole task's,
    // which are the phase's (`soleTaskFor`). A quiz speaks for its own
    // questions, as it does for the brief. The reference review prints the
    // reviewed **task's** objectives (`openai.provider.ts`
    // `composeReferenceReviewMessages`), so a teacher's objectives beside
    // the inherited task never reach the reference reviewer's bytes.
    const objectives = [...new Set(tasks.filter((task) => !isQuiz(task)).flatMap((task) => task.objectives ?? []))];
    const movesObjectives = canonicalJson(objectives) !== canonicalJson(source.objectives ?? []);
    if (lead?.brief || sole || source !== phase || movesObjectives) {
      const overlaid: PhaseContent = { ...source };
      if (lead?.brief) overlaid.taskPanel = lead.brief;
      if (sole) {
        // `source`, not `phase`: `authoredTasksFor(source, …)`
        // omitted the task's slice because it *is* the derived phase's, so
        // reading the omission back off the copy's phase would undo an
        // executable task's edit. Identical wherever no derivation ran
        // (`source === phase`).
        overlaid.checks = sole.checks ?? source.checks;
        overlaid.rubric = sole.rubric ?? phase.rubric;
      }
      if (movesObjectives) overlaid.objectives = objectives;
      phases.push(overlaid);
    } else {
      phases.push(phase);
    }
  }
  content.phases = phases;
  // Before the compiler, because the derivation is what builds the phase the
  // compiler would be asked about: compiling a phase whose union could not
  // be assembled would refuse it for a second reason and tell the teacher
  // about the wrong one.
  if (derivationError) return { snapshot: null, error: derivationError, content };
  try {
    return { snapshot: compilePack(content, { authored }), error: null, content };
  } catch (error) {
    return { snapshot: null, error: (error as Error).message, content };
  }
}
