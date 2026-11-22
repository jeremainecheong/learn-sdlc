/**
 * The contract for a teacher's own uploaded project: a teacher uploads a
 * project of their own, it runs in phases 3–6, and its one executable task per
 * phase is editable.
 *
 * The upload's route keys and audit names sit in the authoring table in
 * `./authoring`, where every other door is. This module holds the rest: the
 * upload door's request, result, limits and refusals; the closed list of run
 * shapes a pack may declare; the one runtime profile; the executable task's
 * shapes, with sealed roles as write-only inputs; the budget ceiling; deep
 * validation and its cost warning; and, each in a region of its own so it can
 * be removed whole, the sign-off table and the quiz-results export kinds.
 *
 * Three properties are worth reading before the declarations.
 *
 * **No refusal echoes the archive.** An uploaded archive is hostile input
 * until proved otherwise, so every upload and run-shape sentence below is a
 * fixed string: it never carries an entry name, a byte, a path or a package
 * name the archive supplied. Where a refusal needs to say where, it says so in
 * a separate `where` field built from manifest keys and indexes, never from
 * archive text.
 *
 * **Sealed bytes have no field to ride in.** A hidden test, a reference
 * solution or a mutant is written through one route and read back through one
 * owner-only, audited route. Every view of one is `SealedFileView`, a path, a
 * digest and a size, so a payload builder that starts from a view cannot
 * carry bytes by forgetting to strip them.
 *
 * **One of everything that an upload does not widen.** One runtime profile (what the
 * deployment already bakes), one work task per executable phase (the wall that
 * exists), and the learner's own time and memory limits as a ceiling no upload
 * can raise.
 */

import type { ArtifactKind } from './contract/phase-detail';
import type { PhaseKey } from './phases';
import type { ArtefactType } from './projects';
import type { AuthoringRoute, SupportedStacks, ValidationReport, ValidationStatus } from './authoring';
import { EXECUTABLE_SPLIT_NOT_READY, SUPPORTED_STACKS_SENTENCE } from './authoring';
import { withThousands } from './words';

/* ---------------------------- the budget ceiling ---------------------------- */

/**
 * The most microVMs one full pass may boot: per phase, and
 * per version. TaskTrackr's own price is 20, with no phase above 10.
 */
export const BUDGET_CEILING = Object.freeze({
  perPhase: 10,
  perVersion: 24,
} as const);

/**
 * Publish, refused above the ceiling: naming the phase and its count, or,
 * when `phaseTitle` is null, the version and its count.
 */
export function budgetCeilingRefusal(microVMs: number, phaseTitle: string | null): string {
  if (phaseTitle !== null) {
    return `${phaseTitle} would boot ${microVMs} microVMs for one full pass, and a phase may boot at most ${BUDGET_CEILING.perPhase}. Remove runs or mutants from ${phaseTitle} to publish this version.`;
  }
  return `This version would boot ${microVMs} microVMs for one full pass, and a version may boot at most ${BUDGET_CEILING.perVersion}. Remove runs or mutants to publish it.`;
}

/* -------------------------------- the upload -------------------------------- */

/**
 * `projects.upload`'s body: the title the new project takes and the archive,
 * base64 in JSON (the class-import precedent). The slug is minted from the
 * title, never taken from the archive, so an upload can never shadow
 * another project.
 */
export interface ProjectUploadRequest {
  title: string;
  /** A `.zip` in the authoring-format layout, base64. At most the import cap, packed and unpacked. */
  archiveBase64: string;
}

/**
 * The archive's own caps beside the byte cap. The byte cap is the existing
 * import cap (`IMPORT_MAX_BYTES`, default `COHORT_IMPORT_MAX_BYTES`) for the
 * archive packed and for its entries unpacked; it is not restated here, so
 * there is one number to move.
 */
export const PROJECT_UPLOAD_LIMITS = Object.freeze({
  /** Entries in the archive, directories included. */
  maxEntries: 2000,
  /** Unpacked to packed, per entry. */
  maxRatio: 100,
} as const);

/** What the compile of an accepted upload found, in counts. */
export interface ProjectUploadCompileSummary {
  phases: number;
  tasks: number;
  /** File rows written, every role included. */
  files: number;
  /** microVMs one full pass of the draft costs (`sandboxBudgetFor`). */
  sandboxBudget: number;
}

/**
 * What an accepted upload answers: the new draft's ids, and the compile and
 * fast-validation reports. The draft is owned by the caller, not
 * platform-owned, not published and not the default.
 */
export interface ProjectUploadResult {
  projectId: string;
  versionId: string;
  /** Minted from the title. */
  slug: string;
  /** `DRAFT_FIRST_VERSION`. */
  version: string;
  compile: ProjectUploadCompileSummary;
  /** The fast tier, run once on the new draft. */
  validation: ValidationReport;
}

/** Every reason an upload is refused. Add codes, never rename them. */
export const UPLOAD_REFUSAL_CODES = [
  'PATH_CLIMB',
  'SYMLINK',
  'DUPLICATE_NAME',
  'CASE_COLLISION',
  'NUL_IN_NAME',
  'RATIO_BOMB',
  'TOTAL_SIZE_BOMB',
  'TOO_MANY_ENTRIES',
  'ENCRYPTED_ENTRY',
  'ZIP64_OR_SIZE_MISMATCH',
  'CRC_MISMATCH',
  'RUNTIME_OUTSIDE_PROFILE',
  'RUN_LIMIT_ABOVE_LEARNER',
  'RUN_SHAPE_NOT_ALLOWED',
  'TWO_WORK_TASKS',
  'HIDDEN_IN_WORKSPACE',
  'SOLUTION_IN_EDITABLE',
  'CEILING_PER_PHASE',
  'CEILING_PER_VERSION',
  'RESERVED_NAME',
  'SECRET_FILE',
  'ARCHIVE_TOO_LARGE',
  'NOT_A_ZIP',
  // Every other refusal the door answers, so a 4xx body's
  // `code` is always one of these. A zip that holds no project in the authoring
  // format, a declared warm-up, a title that makes no address, and a real zip
  // that is not "not a zip": an entry packed by a method the reader does not
  // read, or no entries at all.
  'NOT_A_PACK',
  'WARMUP_NOT_UPLOADABLE',
  'TITLE_INVALID',
  'UNSUPPORTED_ARCHIVE',
  'EMPTY_ARCHIVE',
  // An entry name the reader will not walk: over 1,024 bytes, or
  // more than 64 parts (folders and the file name). Appended last, so no code moves.
  'ARCHIVE_NAME_TOO_LONG',
] as const;
Object.freeze(UPLOAD_REFUSAL_CODES);

export type UploadRefusalCode = (typeof UPLOAD_REFUSAL_CODES)[number];

/**
 * One fixed sentence per refusal. Rendered verbatim by the upload page; none
 * names an entry, a byte or a package from the archive.
 */
export const UPLOAD_REFUSALS: Readonly<Record<UploadRefusalCode, string>> = Object.freeze({
  PATH_CLIMB:
    'An entry in this archive climbs out of the project folder or starts at the root of the disk, so nothing was imported.',
  SYMLINK: 'An entry in this archive is a symbolic link, and an upload holds ordinary files only, so nothing was imported.',
  DUPLICATE_NAME:
    'Two entries in this archive have the same name, so which one a learner would get cannot be told, and nothing was imported.',
  CASE_COLLISION:
    'Two entries in this archive differ only in upper and lower case, which some disks treat as one file, so nothing was imported.',
  NUL_IN_NAME: 'An entry name in this archive holds a control character, such as a null, so nothing was imported.',
  RATIO_BOMB: `An entry in this archive unpacks to more than ${PROJECT_UPLOAD_LIMITS.maxRatio} times its packed size, so nothing was imported.`,
  TOTAL_SIZE_BOMB: 'This archive unpacks to more than the upload limit, so nothing was imported.',
  TOO_MANY_ENTRIES: `This archive holds more than ${withThousands(PROJECT_UPLOAD_LIMITS.maxEntries)} entries, so nothing was imported.`,
  ENCRYPTED_ENTRY:
    'An entry in this archive is encrypted, and an upload is read as it is, without a password, so nothing was imported.',
  ZIP64_OR_SIZE_MISMATCH:
    'An entry in this archive declares a size or checksum it does not have, or a large-archive (ZIP64) size or position beyond the upload limit, so nothing was imported.',
  CRC_MISMATCH: 'An entry in this archive does not match its own checksum, so it is damaged and nothing was imported.',
  RUNTIME_OUTSIDE_PROFILE: `This project asks for a library this deployment does not bake. ${SUPPORTED_STACKS_SENTENCE} Nothing was imported.`,
  RUN_LIMIT_ABOVE_LEARNER:
    "A run in this project asks for more time or memory than a learner's run gets, and an upload can never raise those limits, so nothing was imported.",
  RUN_SHAPE_NOT_ALLOWED:
    'A run in this project declares a command or a harness outside the shapes this platform runs, so nothing was imported.',
  TWO_WORK_TASKS: `A coding, testing or deployment phase in this project holds more than one work task. ${EXECUTABLE_SPLIT_NOT_READY} Nothing was imported.`,
  HIDDEN_IN_WORKSPACE:
    'A file a learner reads in this project holds the bytes of a hidden test, so the hidden suite would be shown and nothing was imported.',
  SOLUTION_IN_EDITABLE:
    'A file a learner edits in this project holds the bytes of the reference solution, so the answer would be handed out and nothing was imported.',
  CEILING_PER_PHASE: `One phase of this project would boot more than ${BUDGET_CEILING.perPhase} microVMs for one full pass, and the ceiling is ${BUDGET_CEILING.perPhase} a phase, so nothing was imported.`,
  CEILING_PER_VERSION: `This project would boot more than ${BUDGET_CEILING.perVersion} microVMs for one full pass, and the ceiling is ${BUDGET_CEILING.perVersion} a version, so nothing was imported.`,
  RESERVED_NAME:
    'When the address a title makes is taken or kept for the platform, a number is added to the end of it, such as -2, and the upload goes ahead.',
  SECRET_FILE:
    'This archive holds a file shaped like a secret, such as an environment file, outside the one example a project may ship, so nothing was imported.',
  ARCHIVE_TOO_LARGE: 'This archive is larger than the upload limit, so nothing was imported.',
  NOT_A_ZIP: 'This file is not a zip archive, so nothing was imported.',
  NOT_A_PACK: 'This archive is not a project in the authoring format, so nothing was imported.',
  WARMUP_NOT_UPLOADABLE:
    'This project declares a warm-up, and an upload cannot carry one, so nothing was imported. Remove the warm-up and upload again.',
  TITLE_INVALID:
    'A project needs a title of 1 to 120 characters, because its address is made from it, so nothing was imported.',
  UNSUPPORTED_ARCHIVE:
    'An entry in this archive is compressed in a way this upload does not read. An upload reads stored and deflated entries only, so nothing was imported.',
  EMPTY_ARCHIVE: 'This archive holds no files, so nothing was imported.',
  ARCHIVE_NAME_TOO_LONG:
    'An entry name in this archive is longer than 1,024 bytes or has more than 64 parts (folders and the file name), so nothing was imported.',
});

/**
 * One run-shape finding: the rule's code, where in the manifest it was found,
 * and the code's fixed sentence.
 *
 * `where` is built from manifest keys and indexes only, a phase key from
 * `PHASE_ORDER`, field names, `runs[0]`, never from a run id, a path, an
 * argv word or any other text the archive supplied.
 */
export interface RunShapeFinding {
  code: RunShapeRefusalCode;
  where: string;
  /** `RUN_SHAPE_REFUSALS[code]`. */
  sentence: string;
}

/**
 * What a refused upload answers, as the body of its 4xx. `findings` lists the
 * run-shape rule's findings when the code is `RUN_SHAPE_NOT_ALLOWED` or
 * `RUN_LIMIT_ABOVE_LEARNER`, and is empty otherwise.
 */
export interface ProjectUploadRefusal {
  code: UploadRefusalCode;
  /** `UPLOAD_REFUSALS[code]`. */
  sentence: string;
  findings: RunShapeFinding[];
  /**
   * The loader's cleaned-up text behind `NOT_A_PACK`, at most
   * `UPLOAD_REFUSAL_DETAIL_MAX` characters. It may name entry paths and values
   * the pack chose, and never carries a byte of a file. The page renders it as
   * plain text under the fixed sentence; `sentence` stays `UPLOAD_REFUSALS[code]`.
   * `RUNTIME_OUTSIDE_PROFILE` carries one too, the sentence
   * naming the first package the runtime profile does not bake.
   */
  detail?: string;
}

/** The most characters `ProjectUploadRefusal.detail` carries. */
export const UPLOAD_REFUSAL_DETAIL_MAX = 400;

/* ---------------------------- the run-shape rule ---------------------------- */

/**
 * A learner's run, as the API sets it from config (`RUN_TIMEOUT_SECONDS`,
 * `RUN_MEMORY_MB`, defaults 15 and 256). A pack never needs to declare either,
 * and one that declares more is refused at upload and again at publish. The
 * door compares against the live config; these are its defaults and the
 * numbers the refusal sentences say.
 */
export const LEARNER_RUN_LIMITS = Object.freeze({
  timeoutSeconds: 15,
  memoryMb: 256,
} as const);

/** The run shapes a pack may declare. Exactly TaskTrackr's, and no other. */
export type RunShapeId =
  | 'run-python-hidden'
  | 'run-typescript-hidden'
  | 'run-python'
  | 'run-typescript'
  | 'smoke-python'
  | 'preview-python'
  | 'drill-faulted-files';

/** The four shapes a phase's test run may take. */
export type TestRunShapeId = Extract<RunShapeId, `run-${string}`>;

/**
 * A test run: the runner builds its argv itself (`harness_for`), so the pack
 * names a language, a harness, the sealed run's harness and whether esbuild
 * transforms the workspace, and nothing else.
 */
export interface TestRunShape {
  id: TestRunShapeId;
  kind: 'test-run';
  language: 'python' | 'typescript';
  harness: 'pytest' | 'js';
  /** The sealed run's harness, or null on a run with no hidden suite. */
  hiddenHarness: 'unittest' | 'js' | null;
  transform: boolean;
  /** Also the warm-up check's shape. */
  warmup: boolean;
  summary: string;
}

/**
 * A command the pack declares as an argv array: the interpreter, a script the
 * pack ships, and at most the extra arguments listed here, at the listed
 * manifest sites only.
 */
export interface CommandShape {
  id: Extract<RunShapeId, 'smoke-python' | 'preview-python'>;
  kind: 'smoke' | 'preview';
  interpreter: 'python3';
  /** `smoke-impl-file`: a `.py` in `smoke.implFiles`. `shipped-file`: a `.py` the pack ships. */
  script: 'smoke-impl-file' | 'shipped-file';
  extraArgs: readonly string[];
  /** The manifest sites a command of this shape may sit at. */
  sites: readonly string[];
  summary: string;
}

/** The drill: no command at all, only `faultedFiles` swapped in before smoke runs again. */
export interface DrillShape {
  id: 'drill-faulted-files';
  kind: 'drill';
  summary: string;
}

export type RunShape = TestRunShape | CommandShape | DrillShape;

/** The closed list, in its fixed order. */
export const RUN_SHAPES: readonly RunShape[] = Object.freeze([
  {
    id: 'run-python-hidden',
    kind: 'test-run',
    language: 'python',
    harness: 'pytest',
    hiddenHarness: 'unittest',
    transform: false,
    warmup: false,
    summary: 'A Python test run with a hidden suite: pytest for the learner, unittest for the sealed run.',
  },
  {
    id: 'run-typescript-hidden',
    kind: 'test-run',
    language: 'typescript',
    harness: 'js',
    hiddenHarness: 'js',
    transform: true,
    warmup: false,
    summary: 'A TypeScript test run with a hidden suite, built by esbuild and run by the JavaScript harness.',
  },
  {
    id: 'run-python',
    kind: 'test-run',
    language: 'python',
    harness: 'pytest',
    hiddenHarness: null,
    transform: false,
    warmup: false,
    summary: 'A Python test run with no hidden suite, run by pytest.',
  },
  {
    id: 'run-typescript',
    kind: 'test-run',
    language: 'typescript',
    harness: 'js',
    hiddenHarness: null,
    transform: true,
    warmup: true,
    summary: "A TypeScript test run with no hidden suite, built by esbuild; the warm-up check's shape too.",
  },
  {
    id: 'smoke-python',
    kind: 'smoke',
    interpreter: 'python3',
    script: 'smoke-impl-file',
    extraArgs: ['--selfcheck'],
    sites: ['checks.smoke.commands'],
    summary: 'A smoke check: python3, one of the smoke files the project ships, and the self-check flag, nothing more.',
  },
  {
    id: 'preview-python',
    kind: 'preview',
    interpreter: 'python3',
    script: 'shipped-file',
    extraArgs: [],
    sites: ['preview.service.command', 'preview.seed'],
    summary: 'The live preview or its seed: python3 and one Python file the project ships, with no argument.',
  },
  {
    id: 'drill-faulted-files',
    kind: 'drill',
    summary: 'An incident drill declares no command: it swaps in its faulted files and runs the smoke check again.',
  },
] satisfies RunShape[]);
// Each shape and its lists are frozen too: `Object.freeze` above is shallow.
for (const shape of RUN_SHAPES) {
  if (shape.kind === 'smoke' || shape.kind === 'preview') {
    Object.freeze(shape.extraArgs);
    Object.freeze(shape.sites);
  }
  Object.freeze(shape);
}

/** The keys that declare a command. Refused anywhere but a `CommandShape`'s sites. */
export const RUN_SHAPE_COMMAND_KEYS = [
  'command',
  'commands',
  'cmd',
  'argv',
  'shell',
  'script',
  'entrypoint',
  'exec',
  'run',
] as const;
Object.freeze(RUN_SHAPE_COMMAND_KEYS);

/**
 * The keys docs/authoring-format.md documents for a phase's checks, its runs,
 * the smoke check, the drill and the run limits, which a refusal's `where`
 * may print.
 */
const UPLOAD_DOCUMENTED_LAYOUT_NAMES = [
  'label', 'testPaths', 'visibleTests', 'hiddenTestDir', 'learnerTestFiles', 'implFiles', 'supportFiles',
  'editableTargets', 'solutionDir', 'referenceDir', 'mutantsDir', 'coverageKeywords', 'minTests',
  'smoke', 'expect', 'dockerfile', 'drill', 'faultedFiles', 'source',
  'timeout', 'memory',
] as const;
Object.freeze(UPLOAD_DOCUMENTED_LAYOUT_NAMES);

/**
 * The key names an upload refusal's `where` prints: the run-shape member
 * names, the manifest keys the rule names (the command sites of `RUN_SHAPES`,
 * `RUN_SHAPE_COMMAND_KEYS`, `LEARNER_RUN_LIMITS`), the documented layout keys
 * and the layout's own names a `where` is built from. Any other key is one the
 * archive chose, and is printed as `(a key)`, never as itself. The upload page
 * prints exactly these names.
 */
export const UPLOAD_WHERE_NAMES: ReadonlySet<string> = new Set<string>([
  ...RUN_SHAPES.flatMap((shape) => Object.keys(shape)),
  'code', 'where', 'sentence',
  ...RUN_SHAPES.flatMap((shape) => ('sites' in shape ? shape.sites.flatMap((site) => site.split('.')) : [])),
  ...RUN_SHAPE_COMMAND_KEYS,
  ...Object.keys(LEARNER_RUN_LIMITS),
  ...UPLOAD_DOCUMENTED_LAYOUT_NAMES,
  'project', 'warmup', 'phases', 'checks', 'runs', 'tasks', 'check',
]);

/** The rule's ten findings. Add codes, never rename them. */
export const RUN_SHAPE_REFUSAL_CODES = [
  'RUN_FREEFORM_STRING',
  'RUN_OWN_COMMAND',
  'ARGV_INTERPRETER',
  'ARGV_SCRIPT',
  'ARGV_EXTRA',
  'ARGV_SHELL',
  'HARNESS_NOT_ALLOWED',
  'HIDDEN_NOT_FILE',
  'LIMIT_TIMEOUT',
  'LIMIT_MEMORY',
] as const;
Object.freeze(RUN_SHAPE_REFUSAL_CODES);

export type RunShapeRefusalCode = (typeof RUN_SHAPE_REFUSAL_CODES)[number];

/** One fixed sentence per finding. Where it was found rides in `RunShapeFinding.where`. */
export const RUN_SHAPE_REFUSALS: Readonly<Record<RunShapeRefusalCode, string>> = Object.freeze({
  RUN_FREEFORM_STRING:
    'A command is written as one string. A project may declare a command only as a list of words in a shape the runner already knows, never as shell text.',
  RUN_OWN_COMMAND:
    "A test run or a check declares its own command. Every test run, hidden suite and drill runs under the runner's fixed command, so the key is refused.",
  ARGV_INTERPRETER: 'A command starts with an interpreter other than python3, the only one a project may name.',
  ARGV_SCRIPT:
    "A command's second word is not a Python file this project ships. It must name a shipped script, never a flag or inline code.",
  ARGV_EXTRA:
    'A command passes an argument after its script that is not allowed there. A smoke check may pass only --selfcheck, and every other command passes nothing.',
  ARGV_SHELL: 'A command word holds a shell character or a space. No run shape needs one, so it is refused.',
  HARNESS_NOT_ALLOWED:
    'A test run asks for a language, a harness or a build step outside the run shapes this platform grades with.',
  HIDDEN_NOT_FILE:
    'A hidden suite must be test files the runner executes with its own fixed command: Python files whose names start with test_, or TypeScript files ending in .test.ts or .test.tsx.',
  LIMIT_TIMEOUT: `A run asks for more than the ${LEARNER_RUN_LIMITS.timeoutSeconds} seconds a learner's run gets. A project can never raise that limit.`,
  LIMIT_MEMORY: `A run asks for more than the ${LEARNER_RUN_LIMITS.memoryMb} MB a learner's run gets. A project can never raise that limit.`,
});

/** The upload code a run-shape finding is filed under: a limit, or any other shape. */
export function uploadRefusalForRunShape(code: RunShapeRefusalCode): UploadRefusalCode {
  return code === 'LIMIT_TIMEOUT' || code === 'LIMIT_MEMORY' ? 'RUN_LIMIT_ABOVE_LEARNER' : 'RUN_SHAPE_NOT_ALLOWED';
}

/* ---------------------------- the runtime profile ---------------------------- */

/**
 * The runtime profiles a version may run on. There is one: `baked`, the three
 * allow-lists the deployment's runner already holds. Another profile would be
 * a guest-image change.
 */
export type RuntimeProfileId = 'baked';

/** A profile as the contract names it. The lists themselves are read from the baked manifest at runtime. */
export interface RuntimeProfileDescriptor {
  id: RuntimeProfileId;
  name: string;
  sentence: string;
}

export const RUNTIME_PROFILES: readonly RuntimeProfileDescriptor[] = Object.freeze([
  Object.freeze({ id: 'baked', name: 'Baked runtime', sentence: SUPPORTED_STACKS_SENTENCE } as const),
]);

/**
 * `runtime.profile`'s answer: the one profile, its allow-lists as
 * `SupportedStacks` reads them, and the manifest's digest, so the editor and
 * the version can say which manifest a check was made against.
 */
export interface RuntimeProfileView extends SupportedStacks {
  id: RuntimeProfileId;
  name: string;
  /**
   * sha256 of the baked allow-lists (python, node, tools): hex, of the three
   * lists exactly as `SupportedStacks` reads them from the baked runtime
   * manifest. It moves when a list moves, and not when only a comment or a
   * checksum in the manifest file does.
   */
  manifestSha256: string;
  /**
   * The configured archive cap (`IMPORT_MAX_BYTES`), in bytes of the
   * archive, not of the base64 body. Optional so an answer without it still
   * reads; the web then falls back to `COHORT_IMPORT_MAX_BYTES`.
   */
  uploadMaxBytes?: number;
}

/* ---------------------- the executable task, and its seal ---------------------- */

/**
 * The sealed roles of an executable task, written through `sealed.write` and
 * never returned by any other route: `hidden` (a run's hidden suite, or a tests
 * task's reference tests), `solution` (a code task's reference solution, or a
 * tests task's reference implementation) and `mutant` (a tests task's
 * mutants).
 */
export const SEALED_ROLE_KINDS = ['hidden', 'solution', 'mutant'] as const;
Object.freeze(SEALED_ROLE_KINDS);

export type SealedRoleKind = (typeof SEALED_ROLE_KINDS)[number];

/** A sealed file as every view carries it: a path, a digest and a size. Never its bytes. */
export interface SealedFileView {
  path: string;
  /** sha256 of the bytes, hex. */
  sha256: string;
  bytes: number;
}

/**
 * `sealed.write`'s body: one sealed file, written whole. Write-only: the
 * answer is a `SealedFileView`, and nothing in the authoring surface reads the
 * bytes back except `sealed.read`, for the owner alone.
 */
export interface SealedFileWriteBody {
  role: SealedRoleKind;
  /**
   * The run the file belongs to, where the pack keeps it per run: a `hidden`
   * file, and a tests task's `solution` (its reference implementation). Null
   * for a code task's solution and for a mutant.
   */
  runId: string | null;
  path: string;
  contentBase64: string;
}

/**
 * `sealed.read`'s query: which sealed file. The route answers it only to the
 * project's owner (ADMIN 403, another teacher 404) and writes a
 * `project.sealed-read` row on every read.
 */
export interface SealedFileReadQuery {
  role: SealedRoleKind;
  path: string;
  /** As `SealedFileWriteBody.runId`; absent reads as null. */
  runId?: string;
}

/** `sealed.read`'s answer: owner-only, and an audit row on every read. */
export interface SealedFileOwnerRead {
  role: SealedRoleKind;
  runId: string | null;
  path: string;
  sha256: string;
  bytes: number;
  contentBase64: string;
}

/** One test run of an executable task, as the editor shows it. */
export interface ExecutableRunView {
  /** `^[a-z][a-z0-9-]{0,15}$`, unique in the phase. */
  id: string;
  shape: TestRunShapeId;
  /** The words a learner reads above this group, e.g. "API tests". */
  label: string;
  /** What the graded run collects. */
  testPaths: string[];
  /** `code`: the tests the learner can see and run. */
  visibleTests: string[];
  /** `tests`: the learner's own suite files that belong to this run. */
  learnerTestFiles: string[];
  /** The run's sealed suite: digests and sizes only. */
  hidden: SealedFileView[];
}

/**
 * A phase's one executable task, as the editor reads it. Every sealed member is
 * a `SealedFileView`; there is no member for bytes.
 */
export interface ExecutableTaskView {
  taskKey: string;
  checkKind: Extract<ArtifactKind, 'code' | 'tests'>;
  artefactType: Extract<ArtefactType, 'code' | 'tests'>;
  /** The workspace paths the learner's work lands in. */
  owns: string[];
  profile: RuntimeProfileId;
  runs: ExecutableRunView[];
  /** `tests`: how many tests the learner's suite must hold; null on a code task. */
  minTests: number | null;
  /** `tests`: words the learner's suite must cover. Empty on a code task. */
  coverageKeywords: string[];
  /** The reference solution. */
  solution: SealedFileView[];
  /** `tests`: the mutants the learner's suite must kill. Empty on a code task. */
  mutants: SealedFileView[];
  /** microVMs one full pass of this phase costs. */
  sandboxBudget: number;
}

/** One test run, as the editor writes it. Its sealed suite goes through `sealed.write`. */
export interface ExecutableRunBody {
  id: string;
  shape: TestRunShapeId;
  label: string;
  testPaths: string[];
  visibleTests: string[];
  learnerTestFiles: string[];
}

/**
 * An executable task's editable members. The sealed roles are not members: a
 * hidden test, the solution and a mutant are written through `sealed.write`,
 * one file at a time, and answered with a digest. The smoke and the drill are
 * not members either: they change only by re-upload.
 */
export interface UpdateExecutableTaskBody {
  owns?: string[];
  runs?: ExecutableRunBody[];
  minTests?: number | null;
  coverageKeywords?: string[];
}

/* ========================== the sign-off table ========================== */

/**
 * The sign-off queue and the bulk sign-off. A table of their own, mounted on
 * the instructor controller and never `AuthoringRouteKey`s: the
 * authoring controller's spec holds it to exactly `AUTHORING_ROUTES`.
 */
export const SIGNOFF_ROUTE_KEYS = ['signoff.queue', 'signoff.bulk'] as const;
Object.freeze(SIGNOFF_ROUTE_KEYS);

export type SignoffRouteKey = (typeof SIGNOFF_ROUTE_KEYS)[number];

export const SIGNOFF_ROUTES: Record<SignoffRouteKey, AuthoringRoute> = {
  'signoff.queue': {
    method: 'GET',
    path: '/instructor/cohorts/:cohortId/signoff-queue',
    roles: ['INSTRUCTOR', 'ADMIN'],
    mutates: false,
    audit: null,
    summary: "The class's tasks awaiting a countersignature, by learner and task.",
  },
  'signoff.bulk': {
    method: 'POST',
    path: '/instructor/cohorts/:cohortId/signoff',
    roles: ['INSTRUCTOR', 'ADMIN'],
    mutates: true,
    audit: 'class.bulk-signoff',
    summary: 'Sign off one task for many learners of the class, with one reason. One audited row per learner.',
  },
};
// The table and each row, frozen: no code in the process may add a door to it.
Object.freeze(SIGNOFF_ROUTES);
for (const key of SIGNOFF_ROUTE_KEYS) Object.freeze(SIGNOFF_ROUTES[key]);

/** One learner's task awaiting a countersignature. */
export interface SignoffQueueRow {
  userId: string;
  learnerName: string;
  phaseKey: PhaseKey;
  taskKey: string;
  taskTitle: string;
  /** ISO: when the task reached awaiting sign-off. */
  awaitingSince: string;
}

export interface SignoffQueueView {
  cohortId: string;
  rows: SignoffQueueRow[];
}

/** One task, one reason (at least `ASSIGNMENT_REASON_MIN` characters), many learners. */
export interface BulkSignoffBody {
  phaseKey: PhaseKey;
  taskKey: string;
  userIds: string[];
  reason: string;
}

/** Who was signed off, and who was not and why, one sentence each. */
export interface BulkSignoffResult {
  signedOff: string[];
  refused: { userId: string; sentence: string }[];
}

/* ------------------------------ deep validation ------------------------------ */

/**
 * The four checks, a to d: the reference solution passes its hidden suite; the
 * starter fails it; every mutant is killed by the reference tests; the
 * deployment phase's smoke passes. Add ids, never rename them.
 */
export const DEEP_VALIDATION_CHECK_IDS = [
  'solution-passes-hidden',
  'starter-fails-hidden',
  'mutants-killed',
  'smoke-passes',
] as const;
Object.freeze(DEEP_VALIDATION_CHECK_IDS);

export type DeepValidationCheckId = (typeof DEEP_VALIDATION_CHECK_IDS)[number];

export const DEEP_VALIDATION_STATUSES = ['not-run', 'queued', 'running', 'passed', 'failed'] as const;
Object.freeze(DEEP_VALIDATION_STATUSES);

export type DeepValidationStatus = (typeof DEEP_VALIDATION_STATUSES)[number];

export interface DeepValidationCheckView {
  id: DeepValidationCheckId;
  /** `pending` until the check has run. */
  status: ValidationStatus | 'pending';
  /** One sentence, always present, always true of the run as it stands. */
  sentence: string;
  phaseKey: PhaseKey | null;
  taskKey: string | null;
}

/** What the teacher reads before the start control enables. microVMs, never money. */
export interface DeepValidationCostWarning {
  microVMs: number;
  /** `deepValidationCostWarning(microVMs)`. */
  sentence: string;
}

/**
 * `deepValidation.start`'s body: the microVM count the teacher was shown in the
 * cost warning. The start is refused, and nothing boots, when the draft's
 * count is not that number any more, so a run never costs more than what was
 * shown.
 */
export interface DeepValidationStartBody {
  acknowledgedMicroVMs: number;
}

/** `deepValidation.read` and `deepValidation.start` answer this. */
export interface DeepValidationView {
  versionId: string;
  status: DeepValidationStatus;
  /** True when the stored receipt's digest is the draft's executable-content digest now, made on the phases the draft holds now. */
  current: boolean;
  /** The executable-content digest the last run was made against, or null when none has run. */
  contentDigest: string | null;
  checks: DeepValidationCheckView[];
  costWarning: DeepValidationCostWarning;
  /** ISO, or null. */
  startedAt: string | null;
  /** ISO, or null. */
  finishedAt: string | null;
}

/** The receipt deep validation stores on the version, beside the fast report. */
export interface DeepValidationReceipt {
  contentDigest: string;
  status: Extract<DeepValidationStatus, 'passed' | 'failed'>;
  checks: DeepValidationCheckView[];
  microVMs: number;
  startedAt: string;
  finishedAt: string;
}

/**
 * `project_versions.validation`, as the contract names it: the fast report's
 * three fields, and the deep receipt beside them, optional, so a fast
 * validation never overwrites it and a row written without a deep receipt
 * still reads.
 */
export interface ProjectVersionValidation {
  findings: { severity: string; message: string }[];
  tier: string;
  when: string;
  deep?: DeepValidationReceipt;
}

/** The cost warning, in microVMs. It never names money: the sandbox has no per-call price. */
export function deepValidationCostWarning(microVMs: number): string {
  const count = microVMs === 1 ? '1 microVM' : `${microVMs} microVMs`;
  return `Deep validation boots ${count} in the sandbox, one at a time, and asks no AI model. You can run one deep validation at a time.`;
}

/* ==================== the quiz-results export kinds ==================== */

/**
 * The four read-only CSVs of quiz results a teacher may export for their own
 * classes: `quiz-learners.csv`, `quiz-attempts.csv`, `quiz-questions.csv` and
 * `quiz-class.csv`. None carries a key, an explanation, a stem or an option.
 */
export const QUIZ_RESULTS_EXPORT_KINDS = ['learners', 'attempts', 'questions', 'class'] as const;
Object.freeze(QUIZ_RESULTS_EXPORT_KINDS);

export type QuizResultsExportKind = (typeof QUIZ_RESULTS_EXPORT_KINDS)[number];
