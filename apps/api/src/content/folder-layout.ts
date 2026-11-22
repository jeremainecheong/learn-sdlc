import {
  COMMON_FOLDERS,
  DESKTOP_FOLDER,
  EDITOR_FOLDERS,
  INHERITED_TASK_KEY,
  INTERVIEW_JSON,
  KIND_FOLDERS,
  PHASE_JSON,
  PHASE_ORDER,
  PHASE_TITLES,
  TASK_KEY_INVALID,
  compareMountPaths,
  foldersFor,
  isAuthoredTaskKey,
  isDesktopFile,
  isMachineOutputFile,
  kindOfFolder,
  languageOfPath,
  MACHINE_OUTPUT_FOLDERS,
  phaseKeyOfFolder,
  retiredWrittenPhaseUploadRefusal,
  isObject as isPlainObject,
} from '@learnsdlc/shared';
import type { ArtifactKind, PhaseFolder, PhaseKey } from '@learnsdlc/shared';
// content.service imports this module; the cycle is safe because each side
// reads the other only from inside a function
import { ARTIFACT_KINDS } from './content.service';
import type { ContentFileSpec, PhaseInputs } from './content.types';
import { MemoryPackSource } from './memory-pack-source';
import { LayoutWalkRefusal, type PackDirent, type PackSource } from './pack-source';
import { plainPath } from './secret-paths';

/**
 * The folder layout: an archive says what it holds by its
 * folders alone. `project.json` lists no phases; each folder under `phases/`
 * is a phase, named `<NN>-<key>` or `<key>`, ordered by LearnSDLC's order;
 * a phase folder's `files/` and `readonly/` are its mounts at their workspace
 * paths, and its kind's sealed folders hold its hidden suites, solution,
 * reference suite, implementation, mutants and drill.
 *
 * `derivePack` reads all of it once, purely, from a `PackSource`, and refuses
 * every misplaced folder, file or member by name, in its own sentence
 * (`LAYOUT_SENTENCES`).
 * The desktop's own leftovers are left out and noted. Machine output and
 * editor folders (`__pycache__`, `node_modules/`, `.vscode/`, a `.pyc` or
 * `.map` file) are refused in an upload and skipped in silence on a pack on
 * disk (`listLayout`), where a maintainer's machine leaves them. The loader
 * (`ContentService.loadProject`), which reads only this layout, then reads
 * each phase through `folderInputs`; an older archive reaches it converted
 * (`layoutFromManifest`).
 */

/*
 * An archive-chosen string a refusal prints (as the quiz door's
 * `clipEcho` and the desktop warnings print theirs): a path only when it is a
 * plain relative path of at most 160 characters (`plainPath`), a name or a
 * value from phase.json clipped to 48 code units first. Anything else reads
 * "a file in the archive", so the sentence never carries what an archive
 * chose beyond that bound.
 */
const shownPath = (value: string): string => plainPath(value);
const shownName = (value: string): string => plainPath(String(value).slice(0, 48));

/** Whether a `project.json` is in the folder layout: it has no `phases` member. */
export function isFolderLayout(project: Record<string, unknown>): boolean {
  return !Object.prototype.hasOwnProperty.call(project, 'phases');
}

/** A folder-layout refusal: one of `LAYOUT_SENTENCES`, which already names the folder, file or member. */
export class LayoutRefusal extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'LayoutRefusal';
  }
}

/** Every refusal sentence of the folder layout; `<f>` is the phase folder as the archive names it, `phases/03-implementation`. */
export const LAYOUT_SENTENCES = Object.freeze({
  noPhase: "The archive holds no phase folder under phases/. A project holds at least one of LearnSDLC's six phases.",
  unknownPhase: (f: string, key: string) => `${f}: ${key} is not one of LearnSDLC's phases. A phase folder is named for its key: requirements, design, implementation, testing, deployment or maintenance.`,
  twice: (a: string, b: string, key: string) => `${a} and ${b} both hold ${key}. A project holds each phase once.`,
  noPhaseJson: (f: string) => `${f} has no phase.json.`,
  listsPhases: 'project.json lists phases, and the folders under phases/ are the list now. Remove phases from project.json.',
  namesWarmup: 'project.json names a warm-up folder, and a warm-up is found by its folder now. Remove warmup from project.json.',
  // only a platform pack holds a warm-up; an upload's warmup/ is refused, never read off the disk
  warmupUploaded: "warmup/ is a platform pack's warm-up, and a warm-up cannot be uploaded yet. Leave the warmup/ folder out of the archive and upload again.",
  keyOrOrder: (f: string) => `${f}/phase.json names its key or order, and the folder's name says both now. Remove key and order.`,
  namesFiles: (f: string) => `${f}/phase.json names files. Put each file under files/ or readonly/ at the path the learner sees, and remove files.`,
  // a folder slot reads "a folder ... under <folder>/"; the interview's fixed file reads "a file ... in interview.json"
  pointer: (f: string, member: string, folder: string, what: string) => {
    const isFolder = folder.endsWith('/');
    return `${f}/phase.json names ${member}, a ${isFolder ? 'folder' : 'file'} the layout fixes. Put ${what} ${isFolder ? 'under' : 'in'} ${folder} and remove ${member}.`;
  },
  taskFile: (f: string, title: string) => `${f}/phase.json: ${title} keeps its brief in taskPanel, not in a file.`,
  blockBrief: (f: string) => `${f}'s phase.json task block: the brief is the phase's taskPanel now; move it there.`,
  unknownFolder: (f: string, name: string) => `${f}/${name}/ is not one of a phase's folders. A phase folder holds files/, readonly/ and quizzes/, and by its kind hidden_tests/, solution/, reference/, impl/, mutants/, smoke/ or drill/.`,
  wrongKind: (f: string, name: string, owner: string, key: string, kind: string) => `${f}/${name}/ belongs to a ${owner} phase, and ${key} is a ${kind} phase.`,
  interviewElsewhere: (f: string) => `${f}/interview.json: only Requirements holds a stakeholder interview.`,
  noRunFolder: (f: string, run: string) => `${f}: the run ${run} has no hidden_tests/${run}/ folder. Each run's hidden suite sits under hidden_tests/ in a folder named for the run's id.`,
  noSolution: (f: string) => `${f} has no solution/ folder. A code phase holds its reference solution under solution/.`,
  noReference: (f: string) => `${f} has no reference/ folder. A tests phase holds its reference suite under reference/.`,
  quizIsWorkTask: (at: string, key: string) => `${at}: ${key} is the key of the phase's work task. A quiz file is named for a task key of its own.`,
  quizKeyInvalid: (at: string, name: string) => `${at}: ${name} is not a task key. ${TASK_KEY_INVALID}`,
  hiddenAtNoPath: (at: string, run: string, rest: string) => `${at} sits at no workspace path: a hidden test sits at the path it runs from, for example hidden_tests/${run}/tests/${rest}.`,
  hiddenNoRun: (f: string, run: string) => `${f}/hidden_tests/${run} names no run of the phase. Each folder under hidden_tests/ is named for a run's id.`,
  solutionCompletesNothing: (at: string) => `${at} completes no file the learner edits.`,
  checksNamesMissing: (f: string, path: string, member: string, place: string) => `${f}: checks names ${path} in ${member}, which ${place} does not hold.`,
  bothWays: (f: string, path: string) => `${f}/files/${path} and readonly/${path} are one path. A file is editable or read-only, never both.`,
  drillMountsNothing: (at: string) => `${at} faults a file the phase does not mount.`,
  // a sealed drill/ the checks never read is refused, never dropped
  drillUndeclared: (f: string) => `${f}/drill/ holds files, but phase.json declares no drill. Declare the drill in phase.json or remove the folder.`,
  smokeScriptMissing: (f: string, script: string) => `${f}: the smoke command runs ${script}, which smoke/ does not hold.`,
  notAQuiz: (at: string, why: string) => `${at} is not a quiz: ${why}`,
  quizzesInPlatformPack: (f: string) => `${f}/quizzes/ is read in an upload only: a platform pack's tasks are its phases' own.`,
  // nothing under a sealed or quiz folder is dropped in silence
  hiddenOutsideRun: (at: string) => `${at} sits in no run's folder. Each run's hidden suite sits under hidden_tests/ in a folder named for the run's id.`,
  mutantOutsideFolder: (at: string) => `${at} sits in no mutant's folder. Each mutant is a folder under mutants/ holding its meta.json and the files it changes.`,
  notAQuizFile: (at: string) => `${at} is not a quiz file. A quiz is quizzes/<task key>.json.`,
});

/** One phase, as its folder holds it. */
export interface DerivedPhase {
  key: PhaseKey;
  order: number;
  /** The folder as the archive names it: `phases/03-implementation`. */
  folder: string;
  /** `phase.json` as written (pointer-free). */
  spec: Record<string, unknown>;
  /** `files/` editable and `readonly/` locked, each language by its path; unsorted (the loader sorts after seeding). */
  mounts: ContentFileSpec[];
  /** Run id, then workspace path, then bytes. */
  hidden: Record<string, Record<string, string>>;
  solution: Record<string, string>;
  reference: Record<string, string>;
  impl: Record<string, string>;
  mutants: { name: string; meta: Record<string, unknown>; files: Record<string, string> }[];
  smoke: Record<string, string>;
  drill: Record<string, string>;
  interview: string | null;
  /** Upload only, kept for the door, never compiled here; refused in a platform pack. */
  quizzes: { key: string; at: string; text: string }[];
}

export interface DerivedPack {
  project: Record<string, unknown>;
  phases: DerivedPhase[];
  /** Whether a platform pack holds a `warmup/` folder: its warm-up is found by its folder (an upload's is refused). */
  warmup: boolean;
}

/** The ten folder names a phase folder may hold: the one list, read from the kinds' own. */
const PHASE_FOLDERS: readonly PhaseFolder[] = [...COMMON_FOLDERS, ...KIND_FOLDERS.code, ...KIND_FOLDERS.tests, ...KIND_FOLDERS.config];

/**
 * A directory name narrowed to a phase folder against the ten names, before
 * `kindOfFolder` or the role table reads it: the table is a plain object,
 * so `constructor` must never reach it as a key.
 */
function isPhaseFolder(name: string): name is PhaseFolder {
  return (PHASE_FOLDERS as readonly string[]).includes(name);
}

/** The run a code phase grades with no `checks.runs`: its hidden suite is `hidden_tests/main/`. */
const FLAT_RUN_ID = 'main';

const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
/** The shared plain-object test, narrowing to the loose record a pack's JSON is read as. */
export const isObject = isPlainObject as (value: unknown) => value is Record<string, any>;
/** The strings of a list, in order; anything that is not a list has none. */
export const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []);

/**
 * One level of `rel`, every desktop entry left out (a name `isDesktopFile`
 * answers for, or a `__MACOSX` folder), so a Finder leftover is never an
 * unknown phase, an unknown folder, a run, a mutant or a quiz. An upload
 * notes each in `leftOut()` for the door's warnings; the disk skips it.
 *
 * Machine output and an editor's folder at this level (a directory in
 * `MACHINE_OUTPUT_FOLDERS` or `EDITOR_FOLDERS`, a `.pyc` or `.map` file) are
 * decided after the desktop test (so an AppleDouble `._x.pyc` is left out,
 * never refused) and before any structural rule reads the entry, so
 * `hidden_tests/__pycache__/` is never a run the phase lacks, `mutants/
 * __pycache__/` never a mutant, `phases/.idea/` never a phase. An upload
 * refuses each in its own sentence; the disk skips
 * each in silence, as its file walk (`walkLayoutFiles`) does, because it is
 * what a maintainer's local run or editor left in a `content/` folder.
 * `derivePack` lists from the pack's root source, so `${rel}/${name}`
 * is the pack-relative path.
 */
function listLayout(source: PackSource, rel: string): PackDirent[] {
  const kept: PackDirent[] = [];
  for (const entry of source.entries(rel)) {
    const desktop = entry.isDirectory ? entry.name === DESKTOP_FOLDER : isDesktopFile(entry.name);
    if (desktop) {
      if (source instanceof MemoryPackSource) source.noteLeftOut(`${rel}/${entry.name}${entry.isDirectory ? '/' : ''}`);
      continue;
    }
    const machine = entry.isDirectory ? MACHINE_OUTPUT_FOLDERS.has(entry.name) : isMachineOutputFile(entry.name);
    const editor = entry.isDirectory && EDITOR_FOLDERS.has(entry.name);
    if (machine || editor) {
      if (source instanceof MemoryPackSource) throw new LayoutWalkRefusal(`${rel}/${entry.name}`, editor);
      continue;
    }
    kept.push(entry);
  }
  return kept;
}

/**
 * The tests phase's support files: `checks.supportFiles` as a list of
 * workspace paths, or, absent with `runs[]` present, the union of the runs'
 * lists in first-seen order.
 */
function supportPathsOf(checks: Record<string, unknown>): string[] {
  if (Array.isArray(checks.supportFiles)) return stringsOf(checks.supportFiles);
  if (!Array.isArray(checks.runs)) return [];
  const out: string[] = [];
  for (const run of checks.runs) {
    for (const at of isObject(run) ? stringsOf(run.supportFiles) : []) if (!out.includes(at)) out.push(at);
  }
  return out;
}

/** The pointer members of `checks` and the folder each names. */
function pointerRefusal(f: string, checks: Record<string, any>): string | null {
  const runs: unknown[] = Array.isArray(checks.runs) ? checks.runs : [];
  if (has(checks, 'hiddenTestDir')) {
    return LAYOUT_SENTENCES.pointer(f, 'hiddenTestDir', `hidden_tests/${Array.isArray(checks.runs) ? '<run id>' : FLAT_RUN_ID}/`, "the run's hidden suite");
  }
  for (const [i, run] of runs.entries()) {
    if (isObject(run) && has(run, 'hiddenTestDir')) {
      const id = typeof run.id === 'string' ? run.id : '<run id>';
      return LAYOUT_SENTENCES.pointer(f, `runs[${i}].hiddenTestDir`, `hidden_tests/${id}/`, "the run's hidden suite");
    }
  }
  if (has(checks, 'solutionDir')) return LAYOUT_SENTENCES.pointer(f, 'solutionDir', 'solution/', 'the solution');
  if (has(checks, 'referenceDir')) return LAYOUT_SENTENCES.pointer(f, 'referenceDir', 'reference/', 'the reference suite');
  if (has(checks, 'implDir')) return LAYOUT_SENTENCES.pointer(f, 'implDir', 'impl/', 'the implementation');
  if (isObject(checks.implFiles)) return LAYOUT_SENTENCES.pointer(f, 'implFiles', 'impl/', 'the implementation');
  if (isObject(checks.supportFiles)) return LAYOUT_SENTENCES.pointer(f, 'supportFiles', 'readonly/', 'each support file');
  if (has(checks, 'mutantsDir')) return LAYOUT_SENTENCES.pointer(f, 'mutantsDir', 'mutants/', 'each mutant');
  if (isObject(checks.smoke) && has(checks.smoke, 'implFiles')) return LAYOUT_SENTENCES.pointer(f, 'smoke.implFiles', 'smoke/', "the smoke run's files");
  if (isObject(checks.drill) && has(checks.drill, 'faultedFiles')) return LAYOUT_SENTENCES.pointer(f, 'drill.faultedFiles', 'drill/', "the drill's faulted files");
  return null;
}

/**
 * The phase's kind for its folders, held to today's sentences first, so a
 * missing or unknown kind is refused in the loader's words, never as a phase
 * of an undefined kind. The older written kind converts only for Requirements
 * and Design, and its folders are those of the kind it converts to.
 */
function folderKindOf(f: string, key: PhaseKey, spec: Record<string, any>): ArtifactKind {
  const declared = spec.artifactKind;
  if (typeof declared !== 'string' || !declared.trim()) throw new Error(`${f}: artifactKind must be a non-empty string`);
  // the loader's own order (`loadChecks`): checks of the older written kind on a key that does not convert
  // say so, whatever the declared kind, before any folder the declared kind would ask for is missed
  if (isObject(spec.checks) && spec.checks.kind === 'markdown' && key !== 'requirements' && key !== 'design') {
    throw new Error(`${f}: ${retiredWrittenPhaseUploadRefusal(PHASE_TITLES[key])}`);
  }
  if (declared === 'markdown') {
    if (key === 'requirements') return 'story';
    if (key === 'design') return 'design';
  }
  if (!ARTIFACT_KINDS.includes(declared as ArtifactKind)) throw new Error(`${f}: artifactKind "${declared}" is not one of ${ARTIFACT_KINDS.join(', ')}`);
  return declared as ArtifactKind;
}

function derivePhase(source: PackSource, f: string, key: PhaseKey, order: number, origin: 'platform' | 'upload'): DerivedPhase {
  const refuse = (sentence: string): never => {
    throw new LayoutRefusal(sentence);
  };
  const read = (rel: string): string => source.read(`${f}/${rel}`);

  // 3. phase.json and the members the layout fixes, then the folders beside it
  const entries = listLayout(source, f);
  if (!entries.some((one) => one.name === PHASE_JSON && !one.isDirectory)) refuse(LAYOUT_SENTENCES.noPhaseJson(f));
  let spec: Record<string, any>;
  try {
    spec = JSON.parse(read(PHASE_JSON));
  } catch (error) {
    throw new Error(`${f}/${PHASE_JSON}: ${(error as Error).message}`);
  }
  if (!isObject(spec)) throw new Error(`${f}/${PHASE_JSON} must be an object`);
  if (has(spec, 'key') || has(spec, 'order')) refuse(LAYOUT_SENTENCES.keyOrOrder(f));
  if (has(spec, 'files')) refuse(LAYOUT_SENTENCES.namesFiles(f));
  if (has(spec, 'taskFile')) refuse(LAYOUT_SENTENCES.taskFile(f, PHASE_TITLES[key]));
  if (has(spec, 'interview')) refuse(LAYOUT_SENTENCES.pointer(f, 'interview', INTERVIEW_JSON, 'the interview'));
  if (isObject(spec.task) && has(spec.task, 'brief')) refuse(LAYOUT_SENTENCES.blockBrief(f));
  const checks: Record<string, any> = isObject(spec.checks) ? spec.checks : {};
  const pointer = pointerRefusal(f, checks);
  if (pointer) refuse(pointer);
  const kind = folderKindOf(f, key, spec);
  const present = new Set<PhaseFolder>();
  let interview: string | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory) {
      // any other loose file beside phase.json is the author's own
      if (entry.name === INTERVIEW_JSON) {
        if (key !== 'requirements') refuse(LAYOUT_SENTENCES.interviewElsewhere(f));
        interview = read(INTERVIEW_JSON);
      }
      continue;
    }
    if (!isPhaseFolder(entry.name)) return refuse(LAYOUT_SENTENCES.unknownFolder(f, shownName(entry.name)));
    if (!foldersFor(kind).includes(entry.name)) refuse(LAYOUT_SENTENCES.wrongKind(f, entry.name, kindOfFolder(entry.name)!, key, kind));
    if (entry.name === 'quizzes' && origin === 'platform') refuse(LAYOUT_SENTENCES.quizzesInPlatformPack(f));
    present.add(entry.name);
  }
  const walk = (folder: PhaseFolder | string): string[] => source.walkLayout(`${f}/${folder}`);
  const walkIf = (folder: PhaseFolder): string[] => (present.has(folder) ? walk(folder) : []);
  const filesOf = (folder: string, paths: string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const at of paths) out[at] = read(`${folder}/${at}`);
    return out;
  };

  // 4. the mounts
  const editable = walkIf('files');
  const locked = walkIf('readonly');
  const lockedPaths = new Set(locked);
  for (const at of editable) if (lockedPaths.has(at)) refuse(LAYOUT_SENTENCES.bothWays(f, at));
  const mounts: ContentFileSpec[] = [
    ...editable.map((at) => ({ path: at, content: read(`files/${at}`), editable: true, language: languageOfPath(at) })),
    ...locked.map((at) => ({ path: at, content: read(`readonly/${at}`), editable: false, language: languageOfPath(at) })),
  ];
  const editablePaths = new Set(editable);
  const isMount = (at: string): boolean => editablePaths.has(at) || lockedPaths.has(at);
  const need = (paths: unknown, member: string, holds: (at: string) => boolean, place: string): void => {
    for (const at of stringsOf(paths)) if (!holds(at)) refuse(LAYOUT_SENTENCES.checksNamesMissing(f, shownPath(at), member, place));
  };
  const runs: Record<string, any>[] = Array.isArray(checks.runs) ? checks.runs.filter(isObject) : [];

  const phase: DerivedPhase = {
    key, order, folder: f, spec, mounts, hidden: {}, solution: {}, reference: {}, impl: {}, mutants: [], smoke: {}, drill: {}, interview, quizzes: [],
  };

  // 5. a code phase: a hidden suite per run, and the solution
  if (kind === 'code') {
    const runIds = Array.isArray(checks.runs) ? runs.map((run) => run.id).filter((id): id is string => typeof id === 'string') : [FLAT_RUN_ID];
    const runFolders = new Set<string>();
    if (present.has('hidden_tests')) {
      for (const entry of listLayout(source, `${f}/hidden_tests`)) {
        if (!entry.isDirectory) refuse(LAYOUT_SENTENCES.hiddenOutsideRun(`${f}/hidden_tests/${entry.name}`));
        if (!runIds.includes(entry.name)) refuse(LAYOUT_SENTENCES.hiddenNoRun(f, shownName(entry.name)));
        runFolders.add(entry.name);
      }
    }
    const suites = new Map<string, string[]>();
    for (const id of runIds) {
      const paths = runFolders.has(id) ? walk(`hidden_tests/${id}`) : [];
      // a run folder holding only desktop leftovers holds no suite
      if (paths.length === 0) refuse(LAYOUT_SENTENCES.noRunFolder(f, shownName(id)));
      suites.set(id, paths);
    }
    for (const [id, paths] of suites) {
      for (const at of paths) if (!at.includes('/')) refuse(LAYOUT_SENTENCES.hiddenAtNoPath(`${f}/hidden_tests/${id}/${at}`, id, at));
      phase.hidden[id] = filesOf(`hidden_tests/${id}`, paths);
    }
    const solution = walkIf('solution');
    if (solution.length === 0) refuse(LAYOUT_SENTENCES.noSolution(f));
    if (Array.isArray(checks.editableTargets)) {
      const targets = stringsOf(checks.editableTargets);
      for (const at of solution) if (!targets.includes(at)) refuse(LAYOUT_SENTENCES.solutionCompletesNothing(`${f}/solution/${at}`));
    }
    phase.solution = filesOf('solution', solution);
  }

  // 6. a tests phase: the reference suite, the implementation, the support files, the mutants
  if (kind === 'tests') {
    const reference = walkIf('reference');
    if (reference.length === 0) refuse(LAYOUT_SENTENCES.noReference(f));
    phase.reference = filesOf('reference', reference);
    const impl = walkIf('impl');
    const implPaths = new Set(impl);
    for (const run of runs) need(run.implFiles, 'implFiles', (at) => implPaths.has(at), 'impl/');
    phase.impl = filesOf('impl', impl);
    need(supportPathsOf(checks), 'supportFiles', (at) => lockedPaths.has(at), 'readonly/');
    if (present.has('mutants')) {
      for (const entry of listLayout(source, `${f}/mutants`)) {
        if (!entry.isDirectory) refuse(LAYOUT_SENTENCES.mutantOutsideFolder(`${f}/mutants/${entry.name}`));
        const folder = `mutants/${entry.name}`;
        const paths = walk(folder);
        let meta: Record<string, unknown>;
        try {
          meta = JSON.parse(read(`${folder}/meta.json`));
        } catch (error) {
          throw new Error(`${f}: ${(error as Error).message}`);
        }
        phase.mutants.push({ name: entry.name, meta, files: filesOf(folder, paths.filter((at) => at !== 'meta.json')) });
      }
    }
  }

  // 7. a config phase: the smoke run's files, and the drill's faulted copies
  if (kind === 'config') {
    phase.smoke = filesOf('smoke', walkIf('smoke'));
    const commands = isObject(checks.smoke) && Array.isArray(checks.smoke.commands) ? checks.smoke.commands : [];
    for (const command of commands) {
      if (Array.isArray(command) && typeof command[1] === 'string' && !has(phase.smoke, command[1])) refuse(LAYOUT_SENTENCES.smokeScriptMissing(f, shownPath(command[1])));
    }
    const drill = walkIf('drill');
    // a drill/ holding only desktop leftovers holds nothing and reads as absent, as solution/ and reference/ do
    if (drill.length > 0 && (checks.drill === undefined || checks.drill === null)) refuse(LAYOUT_SENTENCES.drillUndeclared(f));
    for (const at of drill) if (!isMount(at)) refuse(LAYOUT_SENTENCES.drillMountsNothing(`${f}/drill/${at}`));
    phase.drill = filesOf('drill', drill);
  }

  // 8. every other path a check names: a mount of the right editability, or a smoke/ file for the Dockerfile
  if (kind === 'code') {
    need(checks.editableTargets, 'editableTargets', (at) => editablePaths.has(at), 'files/');
    need(checks.visibleTests, 'visibleTests', isMount, 'files/ or readonly/');
    for (const run of runs) {
      need(run.visibleTests, 'visibleTests', isMount, 'files/ or readonly/');
      need(run.supportFiles, 'supportFiles', (at) => lockedPaths.has(at), 'readonly/');
    }
  }
  if (kind === 'tests') {
    need(checks.learnerTestFiles, 'learnerTestFiles', (at) => editablePaths.has(at), 'files/');
    for (const run of runs) need(run.learnerTestFiles, 'learnerTestFiles', (at) => editablePaths.has(at), 'files/');
  }
  if (kind === 'config') {
    for (const rule of Array.isArray(checks.rules) ? checks.rules : []) {
      if (isObject(rule) && typeof rule.target === 'string') need([rule.target], 'rules', isMount, 'files/ or readonly/');
    }
    if (isObject(checks.smoke) && typeof checks.smoke.dockerfile === 'string') {
      need([checks.smoke.dockerfile], 'smoke.dockerfile', (at) => isMount(at) || has(phase.smoke, at), 'files/, readonly/ or smoke/');
    }
  }

  // 9. quizzes, in an upload: each a quiz file named for a task key of its own, kept for the door
  if (present.has('quizzes')) {
    const workKey = isObject(spec.task) && typeof spec.task.key === 'string' ? spec.task.key : INHERITED_TASK_KEY;
    for (const entry of listLayout(source, `${f}/quizzes`)) {
      const at = `${f}/quizzes/${entry.name}`;
      if (entry.isDirectory || !entry.name.endsWith('.json')) refuse(LAYOUT_SENTENCES.notAQuizFile(entry.isDirectory ? `${at}/` : at));
      const name = entry.name.slice(0, -'.json'.length);
      if (name === workKey) refuse(LAYOUT_SENTENCES.quizIsWorkTask(at, name));
      if (!isAuthoredTaskKey(name)) refuse(LAYOUT_SENTENCES.quizKeyInvalid(shownPath(at), shownName(name)));
      phase.quizzes.push({ key: name, at, text: read(`quizzes/${entry.name}`) });
    }
  }
  return phase;
}

/**
 * A pack in the folder layout, derived from its folders, its rules
 * checked in a fixed order; the first refusal wins. Every listing goes
 * through `listLayout` and every folder whose files the phase keeps through
 * `walkLayout`, so desktop entries are left out everywhere and machine output
 * is refused by name (an upload) or skipped (the disk).
 */
export function derivePack(source: PackSource, options: { origin: 'platform' | 'upload' }): DerivedPack {
  const project = JSON.parse(source.read('project.json')) as Record<string, unknown>;
  // 1. project.json
  if (!isFolderLayout(project)) throw new LayoutRefusal(LAYOUT_SENTENCES.listsPhases);
  if (has(project, 'warmup')) throw new LayoutRefusal(LAYOUT_SENTENCES.namesWarmup);
  // a warm-up is a platform pack's alone; the loader would read an upload's off the server's disk
  const holdsWarmup = source.exists('warmup');
  if (holdsWarmup && options.origin === 'upload') throw new LayoutRefusal(LAYOUT_SENTENCES.warmupUploaded);
  // 2. the phase folders: the directories directly under phases/ (a loose file there is the author's own)
  const holdsPhases = source.entries('').some((one) => one.name === 'phases' && one.isDirectory);
  const folders = holdsPhases ? listLayout(source, 'phases').filter((one) => one.isDirectory) : [];
  if (folders.length === 0) throw new LayoutRefusal(LAYOUT_SENTENCES.noPhase);
  const held = new Map<PhaseKey, string>();
  for (const entry of folders) {
    const folder = `phases/${entry.name}`;
    // as written, so 03-Implementation reads Implementation; the number is never read
    const key = phaseKeyOfFolder(entry.name);
    if (!(PHASE_ORDER as string[]).includes(key)) throw new LayoutRefusal(LAYOUT_SENTENCES.unknownPhase(shownPath(folder), shownName(key)));
    const other = held.get(key as PhaseKey);
    if (other !== undefined) {
      const [a, b] = [other, folder].sort(compareMountPaths);
      throw new LayoutRefusal(LAYOUT_SENTENCES.twice(a, b, key));
    }
    held.set(key as PhaseKey, folder);
  }
  const ordered = [...held].sort(([a], [b]) => PHASE_ORDER.indexOf(a) - PHASE_ORDER.indexOf(b));
  const phases = ordered.map(([key, folder], i) => derivePhase(source, folder, key, i + 1, options.origin));
  // 10. the platform's warm-up is found by its folder (an upload holding one was refused above)
  return { project, phases, warmup: holdsWarmup };
}

/** How the folder path names a piece in a sentence that once named a pointer member (7.3). */
const FOLDER_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'checks.solutionDir': 'solution/',
  'checks.referenceDir': 'reference/',
  'checks.smoke.implFiles': 'smoke/',
  faultedFiles: 'drill/',
  'taskFile or taskPanel': 'taskPanel',
});

/** The folder layout's `PhaseInputs`: every piece answered from what `derivePack` read. */
export function folderInputs(phase: DerivedPhase): PhaseInputs {
  return {
    where: phase.folder,
    files: () => phase.mounts.map((one) => ({ ...one })),
    brief: (spec) => spec.taskPanel as string,
    interviewText: () => phase.interview,
    hiddenFor: (_runSpec, _flat, _field, runId) => {
      if (!has(phase.hidden, runId)) throw new LayoutRefusal(LAYOUT_SENTENCES.noRunFolder(phase.folder, shownName(runId)));
      return { ...phase.hidden[runId] };
    },
    solution: () => ({ ...phase.solution }),
    reference: () => ({ ...phase.reference }),
    impl: () => ({ ...phase.impl }),
    support: (raw, files) => {
      const out: Record<string, string> = {};
      for (const at of supportPathsOf(raw)) {
        const mount = files.find((one) => one.path === at && !one.editable);
        if (!mount) throw new LayoutRefusal(LAYOUT_SENTENCES.checksNamesMissing(phase.folder, shownPath(at), 'supportFiles', 'readonly/'));
        out[at] = mount.content;
      }
      return out;
    },
    mutants: () => phase.mutants.map((one) => ({ name: one.name, meta: one.meta, files: () => ({ ...one.files }) })),
    smoke: () => ({ ...phase.smoke }),
    drill: () => ({ ...phase.drill }),
    named: (member) => (has(FOLDER_NAMES, member) ? FOLDER_NAMES[member] : member),
  };
}
