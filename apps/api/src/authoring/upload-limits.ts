import { BadRequestException } from '@nestjs/common';
import {
  BUDGET_CEILING,
  PHASE_ORDER,
  RUN_SHAPE_REFUSAL_CODES,
  UPLOAD_WHERE_NAMES,
  multiTaskPublishRefusal,
  type ArtifactKind,
} from '@learnsdlc/shared';
import { config } from '../config';
import type { ProjectContent, RuntimeSpec } from '../content/content.types';
import { LAYOUT_SENTENCES, derivePack } from '../content/folder-layout';
import { derivedFileRows, refuseReservedWorkspacePaths, refuseSealedWorkspaceBytes } from '../content/importer.service';
import { sandboxBudgetFor, soleTaskFor } from '../content/pack-compiler';
import type { PackSource } from '../content/pack-source';
import { ALLOWED_ENV_FILE, NEW_LAYOUT_SECRET, isSecretPath, plainPath, PRIVATE_KEY } from '../content/secret-paths';
import { UploadRefusal } from '../content/zip-reader';
import { isHiddenTestName } from './door-rules';
import { runtimeProfileRefusals, type RuntimeProfileRefusal } from './runtime-stacks';

/**
 * What an uploaded pack is held to before a single row is
 * written, and, for the run shapes and the learner limit, again at publish
 * (publish re-runs `checkPackRuns` and `checkRunLimits` over the version it is
 * about to publish, so a pack edited between the two cannot reach the sandbox
 * with a shape the upload never saw).
 *
 * **The run-shape rule.** A test run's argv is
 * built by the runner, never by the pack: the pack names a harness, and the
 * harness has a fixed command. What a pack *can* declare is the smoke command,
 * the preview service command and the preview seed (each an argv the runner
 * executes) so those three sites are held to the two shapes TaskTrackr uses,
 * and a command-declaring key anywhere else is refused outright. Two
 * deliberate choices:
 *
 * - the two limit codes are `checkRunLimits`, which reads the learner limit
 *   from config (`config.runTimeoutSeconds` / `config.runMemoryMb`, the values
 *   `SandboxService.execute` stamps on every job) instead of a constant;
 * - no sentence echoes a value the pack chose. Each names **where** (a
 *   manifest path whose phase keys and run ids are printed only when they are
 *   plain identifiers) and the rule; the teacher has the archive and can see
 *   the value.
 *
 * And one widening: a `code` or `tests` phase with no `runs[]` (the
 * flat shape the loader synthesises one run from) is held to the same closed
 * list as a declared run, so the flat shape is not a way around it.
 */

/* --------------------------------- shapes --------------------------------- */

type Json = any;

/** One refusal: a stable code, where in the pack, and the sentence a teacher reads. */
export interface PackRefusal {
  code: string;
  where: string;
  sentence: string;
}

/** One phase as the rule reads it: its raw `phase.json`, and its hidden files on disk. */
export interface RawPhase {
  key: string;
  title?: unknown;
  artifactKind?: unknown;
  checks: Json;
  tasks?: unknown;
  /**
   * run id → the files of that run's hidden suite, phase-relative, under the
   * folder the rule's own `hiddenTestDir` names (`hidden_tests/<run id>` for
   * an archive, `hidden` for loaded content); no archive names it.
   */
  hiddenTestFiles: Record<string, string[]>;
  /** Every other key of `phase.json`, walked for command-declaring keys. */
  rest: Record<string, unknown>;
  /**
   * The folder layout's `smoke/` files, by the workspace path a smoke command
   * names: what the smoke script rule reads in place of the
   * `smoke.implFiles` keys loaded content carries (`rawPackManifestOf`).
   * Absent for loaded content.
   */
  smokeFiles?: string[];
}

/** What the rule reads: the pack's raw JSON, before the loader drops any key. */
export interface RawPackManifest {
  project: Record<string, unknown>;
  warmup: Record<string, unknown> | null;
  phases: RawPhase[];
  /**
   * The scripts a declared argv may run: every path some phase mounts
   * read-only and no phase mounts editable (as `rawPackManifestOf`
   * reads loaded content).
   */
  shippedFiles: string[];
  /**
   * The folder layout's sealed files, by pack-relative path, as the layout
   * walk kept them (desktop entries already left out): every file under a
   * phase's `hidden_tests/`, `solution/`, `reference/`, `impl/`, `mutants/`
   * and `drill/`, for the dot-prefixed part rule (`checkSealedPaths`). Absent for loaded
   * content.
   */
  sealedPaths?: string[];
}

/** The learner limit a pack may never exceed. */
export interface LearnerRunLimits {
  timeoutSeconds: number;
  memoryMb: number;
}

/* ------------------------------- the closed list ------------------------------ */

/** Every code the run-shape rule and the learner limit emit (the contract's closed list). */
export const RUN_SHAPE_CODES = RUN_SHAPE_REFUSAL_CODES;

/** (language, harness, hiddenHarness, transform): exactly TaskTrackr's four test-run shapes. */
const RUN_SHAPES: ReadonlySet<string> = new Set([
  shapeKey('python', 'pytest', 'unittest', false), // 1: impl/maint api run
  shapeKey('typescript', 'js', 'js', true), // 2: impl/maint web run
  shapeKey('python', 'pytest', null, false), // 3: testing api run (no sealed suite)
  shapeKey('typescript', 'js', null, true), // 4: testing web run, and the warm-up check
]);

/** Shapes 5 and 6: the only interpreter a declared argv may start. */
const INTERPRETERS: ReadonlySet<string> = new Set(['python3']);
/** Shape 5: the only argument after the smoke script. */
const SMOKE_FLAGS: ReadonlySet<string> = new Set(['--selfcheck']);
/** Keys that declare a command. Allowed only at the three argv sites. */
const COMMAND_KEYS: ReadonlySet<string> = new Set([
  'command', 'commands', 'cmd', 'argv', 'shell', 'script', 'entrypoint', 'exec', 'run',
]);
/** Shell metacharacters and whitespace: no closed shape needs one. */
const SHELL_META: ReadonlySet<string> = new Set(";&|`$<>(){}[]*?!~'\"\\\n\r\t #=".split(''));

// The hidden-test name (test_*.py, *.test.ts[x]) is door-rules'
// `isHiddenTestName`, the one rule the sealed-role door and draft.ts ask too.

const LIMIT_KEYS: Record<string, 'timeout' | 'memory'> = {
  timeoutSeconds: 'timeout',
  timeout: 'timeout',
  memoryMb: 'memory',
  memory: 'memory',
};

function shapeKey(language: unknown, harness: unknown, hidden: unknown, transform: boolean): string {
  return JSON.stringify([language ?? null, harness ?? null, hidden ?? null, transform]);
}

/* --------------------------------- printing -------------------------------- */

/**
 * A field name, kept only when it is a plain camelCase identifier. A
 * `where` is built from manifest keys and indexes only (the contract's
 * `RunShapeFinding`): never a run id, a path or an argv word. This is
 * the path `walkCommands` compares with the allowed argv sites; what a
 * `where` prints is `named` below.
 */
function label(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(value) ? value : fallback;
}

/** A walked key as a `where` prints it: a name in the shared `UPLOAD_WHERE_NAMES`, else `(a key)`. */
function named(key: string): string {
  return UPLOAD_WHERE_NAMES.has(key) ? key : '(a key)';
}

/** A phase as a `where` names it: its key when it is one of the six, else its position. */
function phaseLabel(key: unknown, index: number): string {
  return typeof key === 'string' && (PHASE_ORDER as readonly string[]).includes(key) ? key : `#${index + 1}`;
}

function refusal(code: string, where: string, sentence: string): PackRefusal {
  return { code, where, sentence };
}

/* ------------------------------ reading the pack ----------------------------- */

function readJson(source: PackSource, rel: string, said: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.read(rel));
  } catch (error) {
    if (error instanceof UploadRefusal) throw error;
    throw new UploadRefusal('PACK_UNREADABLE', `${said} is missing or is not valid JSON. Fix it and upload again.`, said);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UploadRefusal('PACK_UNREADABLE', `${said} must hold one JSON object. Fix it and upload again.`, said);
  }
  return parsed as Record<string, unknown>;
}

/**
 * The raw manifest the rule reads, from a pack in the folder layout.
 *
 * Raw on purpose: the loader drops keys it does not know (`loadHarness` keeps
 * only what a run means), so a `command` on a run is invisible after loading
 * and visible here. An older archive is converted first, as the upload door
 * converts it (`layoutFromManifest`); a `project.json` that still lists its
 * phases is refused in the layout's own sentence (`derivePack`), and no
 * pointer member is read here.
 */
export function buildPackManifest(source: PackSource): RawPackManifest {
  if (!source.exists('project.json')) {
    throw new UploadRefusal(
      'PACK_NO_PROJECT',
      'The archive has no project.json at its top level. Zip the project folder itself, with project.json inside it, and upload again.',
      'project.json',
    );
  }
  return folderManifest(source, readJson(source, 'project.json', 'project.json'));
}

/**
 * The raw manifest of a pack in the folder layout, from what
 * `derivePack` reads: the phases from the folders, in LearnSDLC's order;
 * each phase's `phase.json` as written, with the folder each code run's
 * hidden suite sits in written where the rule reads it (`hiddenTestDir`, as
 * `rawPackManifestOf` writes `hidden` for loaded content) and its files from
 * `hidden_tests/<run id>/`; the `smoke/` files a smoke command may run; the
 * mounts as the shipped scripts; and every sealed path for the dot rule.
 *
 * A pack that holds a warm-up (a `warmup` member or a `warmup/` folder) is
 * not derived: the upload's shape refuses it as a warm-up first
 * (`checkUploadShape`), in its own words. A refusal of the layout
 * (`LayoutRefusal`, `LayoutWalkRefusal`, or the loader's own words for a
 * file that does not parse) is thrown as it is, for the caller to say.
 */
function folderManifest(source: PackSource, project: Record<string, unknown>): RawPackManifest {
  const holdsWarmup = source.exists('warmup');
  if ((project.warmup !== undefined && project.warmup !== null) || holdsWarmup) {
    return { project, warmup: holdsWarmup ? {} : null, phases: [], shippedFiles: [], sealedPaths: [] };
  }
  const derived = derivePack(source, { origin: 'upload' });
  const locked = new Set<string>();
  const editable = new Set<string>();
  const sealedPaths: string[] = [];
  const phases: RawPhase[] = derived.phases.map((phase) => {
    const { title, artifactKind, checks, tasks, ...rest } = phase.spec as Record<string, unknown>;
    const raw: Json = checks && typeof checks === 'object' && !Array.isArray(checks) ? JSON.parse(JSON.stringify(checks)) : {};
    const hiddenTestFiles: Record<string, string[]> = {};
    for (const [id, files] of Object.entries(phase.hidden)) {
      const at = `hidden_tests/${id}`;
      const run = Array.isArray(raw.runs) ? raw.runs.find((one: Json) => one && typeof one === 'object' && one.id === id) : null;
      // the flat shape's one run is keyed '' (the loader's synthesised id), its suite hidden_tests/main/
      if (run) run.hiddenTestDir = at;
      else if (!Array.isArray(raw.runs)) raw.hiddenTestDir = at;
      hiddenTestFiles[run || Array.isArray(raw.runs) ? id : ''] = Object.keys(files).map((file) => `${at}/${file}`);
    }
    for (const mount of phase.mounts) (mount.editable ? editable : locked).add(mount.path);
    const sealed = (folder: string, files: Record<string, string>): void => {
      for (const at of Object.keys(files)) sealedPaths.push(`${phase.folder}/${folder}/${at}`);
    };
    for (const [id, files] of Object.entries(phase.hidden)) sealed(`hidden_tests/${id}`, files);
    sealed('solution', phase.solution);
    sealed('reference', phase.reference);
    sealed('impl', phase.impl);
    for (const mutant of phase.mutants) sealed(`mutants/${mutant.name}`, { 'meta.json': '', ...mutant.files });
    sealed('drill', phase.drill);
    return {
      key: phase.key,
      title,
      artifactKind,
      checks: raw,
      tasks,
      hiddenTestFiles,
      rest,
      smokeFiles: Object.keys(phase.smoke),
    };
  });
  for (const at of editable) locked.delete(at);
  return { project, warmup: null, phases, shippedFiles: [...locked], sealedPaths };
}

/* ------------------------------- the run shapes ------------------------------ */

function checkArgv(
  out: PackRefusal[],
  where: string,
  argv: unknown,
  scripts: ReadonlySet<string>,
  extraAllowed: ReadonlySet<string>,
): void {
  if (typeof argv === 'string') {
    out.push(refusal('RUN_FREEFORM_STRING', where,
      `${where} is a command string; a pack may only declare an argv array of the shapes the runner already knows, never shell text.`));
    return;
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string' && a.length > 0)) {
    out.push(refusal('RUN_FREEFORM_STRING', where, `${where} must be an array of non-empty strings.`));
    return;
  }
  const words = argv as string[];
  if (words.some((word) => [...word].some((ch) => SHELL_META.has(ch)))) {
    out.push(refusal('ARGV_SHELL', where,
      `${where} contains a shell metacharacter or whitespace; they are refused, because no closed run shape needs them.`));
    return;
  }
  if (!INTERPRETERS.has(words[0])) {
    out.push(refusal('ARGV_INTERPRETER', where,
      `${where} starts with an interpreter other than ${[...INTERPRETERS].sort().join(', ')}, the only one a pack may name.`));
  }
  if (words.length < 2 || !words[1].endsWith('.py') || !scripts.has(words[1])) {
    out.push(refusal('ARGV_SCRIPT', where,
      `${where} does not run a .py file this pack ships; the second word must be a shipped script, never a flag or inline code.`));
  }
  const extra = words.slice(2);
  if (extra.length > (extraAllowed.size ? 1 : 0) || extra.some((word) => !extraAllowed.has(word))) {
    const allowed = extraAllowed.size ? [...extraAllowed].sort().join(', ') : 'none';
    out.push(refusal('ARGV_EXTRA', where,
      `${where} passes arguments after the script; the only argument allowed here is ${allowed}.`));
  }
}

// `where` is the path the allowed sites are compared with
// (an identifier or `(a key)` per key, so a dotted key is never a
// site); `said` is the same path as a teacher reads it (`named`).
function walkCommands(node: unknown, where: string, out: PackRefusal[], allowedSites: ReadonlySet<string>, said: string = where): void {
  if (Array.isArray(node)) {
    node.forEach((value, index) => walkCommands(value, `${where}[${index}]`, out, allowedSites, `${said}[${index}]`));
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const at = `${where}.${label(key, '(a key)')}`;
    const shown = `${said}.${named(key)}`;
    if (COMMAND_KEYS.has(key) && !allowedSites.has(at)) {
      out.push(refusal('RUN_OWN_COMMAND', shown,
        `${shown} declares its own command; every test, hidden suite and drill runs under the runner's fixed command, so this key is refused.`));
    }
    walkCommands(value, at, out, allowedSites, shown);
  }
}

function checkShape(
  out: PackRefusal[],
  where: string,
  language: unknown,
  harness: unknown,
  hidden: unknown,
  transform: unknown,
): void {
  if (!RUN_SHAPES.has(shapeKey(language, harness, hidden, Boolean(transform)))) {
    out.push(refusal('HARNESS_NOT_ALLOWED', where,
      `${where} asks for a language, harness, hidden harness and transform that are not one of the run shapes TaskTrackr uses; only those are accepted. Declare runs[] with language, harness, hiddenHarness and transform exactly as a TaskTrackr phase does.`));
  }
}

/**
 * The run-shape rule over a raw manifest. `[]` means every run is a closed shape.
 * Exported for publish, which re-runs it.
 */
export function checkPackRuns(pack: RawPackManifest): PackRefusal[] {
  const out: PackRefusal[] = [];
  const project = (pack.project ?? {}) as Json;
  const shipped = new Set(pack.shippedFiles ?? []);
  const previewSites = new Set(['project.preview.service.command', 'project.preview.seed']);
  const preview = project.preview && typeof project.preview === 'object' ? project.preview : {};
  if ('service' in preview) {
    checkArgv(out, 'project.preview.service.command', (preview.service ?? {})?.command, shipped, new Set());
  }
  if ('seed' in preview) checkArgv(out, 'project.preview.seed', preview.seed, shipped, new Set());
  walkCommands(project, 'project', out, previewSites);

  const warm = pack.warmup as Json;
  if (warm && typeof warm === 'object') {
    const check = warm.check && typeof warm.check === 'object' ? warm.check : {};
    if (check.kind === 'tests') checkShape(out, 'warmup.check', check.language, check.harness, null, check.transform);
    walkCommands(warm, 'warmup', out, new Set());
  }

  pack.phases.forEach((phase, index) => {
    const name = `phases[${phaseLabel(phase.key, index)}]`;
    const base = `${name}.checks`;
    const checks = (phase.checks ?? {}) as Json;
    const sites = new Set<string>();
    const smoke = checks.smoke;
    if (smoke && typeof smoke === 'object' && !Array.isArray(smoke)) {
      sites.add(`${base}.smoke.commands`);
      const commands = smoke.commands;
      if (!Array.isArray(commands)) {
        checkArgv(out, `${base}.smoke.commands`, typeof commands === 'string' ? commands : null, new Set(), SMOKE_FLAGS);
      } else {
        // an archive's smoke/ files, or the smoke.implFiles keys loaded content carries
        const implFiles = new Set(
          phase.smokeFiles ?? (smoke.implFiles && typeof smoke.implFiles === 'object' ? Object.keys(smoke.implFiles) : []),
        );
        commands.forEach((argv: unknown, i: number) =>
          checkArgv(out, `${base}.smoke.commands[${i}]`, argv, implFiles, SMOKE_FLAGS),
        );
      }
    }
    walkCommands(checks, base, out, sites);
    walkCommands(phase.rest, name, out, new Set());
    walkCommands(phase.tasks, `${name}.tasks`, out, new Set());

    const declared: Json[] = Array.isArray(checks.runs) ? checks.runs : [];
    const runs =
      declared.length === 0 && (checks.kind === 'code' || checks.kind === 'tests')
        ? // The flat shape: the run the loader would synthesise, held to the same list.
          [{ id: '', language: checks.language, harness: checks.harness, hiddenHarness: checks.hiddenHarness, transform: checks.transform, ...(checks.hiddenTestDir !== undefined ? { hiddenTestDir: checks.hiddenTestDir } : {}), flat: true }]
        : declared;
    runs.forEach((run: Json, i: number) => {
      if (!run || typeof run !== 'object') return;
      const at = run.flat ? base : `${base}.runs[${i}]`;
      checkShape(out, at, run.language, run.harness, run.hiddenHarness, run.transform);
      if ('hiddenTestDir' in run || 'hiddenHarness' in run) {
        const files = (typeof run.id === 'string' ? phase.hiddenTestFiles?.[run.id] : undefined) ?? [];
        const language = typeof run.language === 'string' ? run.language : '';
        const bad = files.filter((file) => !(safeHidden(file) && isHiddenTestName(file, language)));
        if (files.length === 0 || bad.length > 0 || !safeHidden(run.hiddenTestDir)) {
          out.push(refusal('HIDDEN_NOT_FILE', at,
            `${at}'s hidden suite must be test files the runner executes with its own fixed command (test_*.py or *.test.ts[x]) in the run's folder under hidden_tests/; ${files.length === 0 ? 'it holds no files' : bad.length > 0 ? `${bad.length} of its ${files.length} files are not test files` : "its folder is not a plain path inside the phase"}.`));
        }
      }
    });
  });
  return out;
}

/** The reference's `_safe_path`: relative, inside, no `..`, no shell metacharacter. */
function safeHidden(at: unknown): boolean {
  return (
    typeof at === 'string' &&
    at.length > 0 &&
    !at.startsWith('/') &&
    !at.split('/').includes('..') &&
    ![...at].some((ch) => ch !== '/' && SHELL_META.has(ch))
  );
}

/* ------------------------------- the learner limit ----------------------------- */

function walkLimits(node: unknown, where: string, out: PackRefusal[], limits: LearnerRunLimits): void {
  if (Array.isArray(node)) {
    node.forEach((value, index) => walkLimits(value, `${where}[${index}]`, out, limits));
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // Printed only; nothing compares this path.
    const at = `${where}.${named(key)}`;
    // Own keys only, so a key named like Object.prototype's (toString, constructor) is never a limit.
    const kind = Object.prototype.hasOwnProperty.call(LIMIT_KEYS, key) ? LIMIT_KEYS[key] : undefined;
    if (kind) {
      const cap = kind === 'timeout' ? limits.timeoutSeconds : limits.memoryMb;
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > cap) {
        out.push(
          kind === 'timeout'
            ? refusal('LIMIT_TIMEOUT', at, `${at} asks for more time than a learner's run gets, or is not a whole number of seconds; a pack may never ask for more than the platform limit of ${cap}s.`)
            : refusal('LIMIT_MEMORY', at, `${at} asks for more memory than a learner's run gets, or is not a whole number of megabytes; a pack may never ask for more than the platform limit of ${cap} MB.`),
        );
      }
    }
    walkLimits(value, at, out, limits);
  }
}

/**
 * Every `timeoutSeconds`/`timeout`/`memoryMb`/`memory` a pack declares, held to
 * the learner limit (config; `SandboxService.execute` stamps the same values on
 * every job). The loader reads no such field, so this is defence in depth:
 * an upload can never raise a limit, now or after a loader change.
 * Exported for publish, which re-runs it.
 */
export function checkRunLimits(
  pack: RawPackManifest,
  limits: LearnerRunLimits = { timeoutSeconds: config.runTimeoutSeconds, memoryMb: config.runMemoryMb },
): PackRefusal[] {
  const out: PackRefusal[] = [];
  walkLimits(pack.project, 'project', out, limits);
  if (pack.warmup) walkLimits(pack.warmup, 'warmup', out, limits);
  pack.phases.forEach((phase, index) => {
    const name = `phases[${phaseLabel(phase.key, index)}]`;
    walkLimits(phase.checks, `${name}.checks`, out, limits);
    walkLimits(phase.rest, name, out, limits);
    walkLimits(phase.tasks, `${name}.tasks`, out, limits);
  });
  return out;
}

/* ------------------------------ the rest of the wall ----------------------------- */

/** The folder layout's secret sentence, beside the rule's names in `content/secret-paths.ts`. */
export { NEW_LAYOUT_SECRET } from '../content/secret-paths';

/** A new-layout archive's `canonical/` folder: an older archive's is converted, never stored. */
export const CANONICAL_IN_UPLOAD = "canonical/ is not read in an upload. Put each file a phase mounts under that phase's files/ or readonly/ folder, and upload again.";

/** A sealed file the editor could not replace, since the sealed door refuses a dot-prefixed part. */
export const SEALED_DOT_PATH = (at: string): string =>
  `${at}: a sealed file's path has no part that starts with a dot, so the editor could not replace it. Rename it and upload again.`;

/** One desktop file left out, its path as the refusals print one (`plainPath`). */
export const desktopFileWarning = (at: string): string => `left out: ${plainPath(at)} is a desktop file`;

/** The desktop's resource-fork folder beside or inside the pack, left out. */
export const DESKTOP_FOLDER_WARNING = 'left out: __MACOSX/ is a desktop folder';

/** The desktop entries past the fifth. */
export const moreDesktopFilesWarning = (n: number): string => `left out: ${n} more desktop files`;

/** How many desktop files, and how many desktop folders, are named one by one. */
const DESKTOP_NAMED = 5;

/**
 * The upload's warnings for the desktop entries it left out, from the
 * sources' `leftOut()` lists (pack-relative paths; a folder ends in `/`):
 * the first five files by `desktopFileWarning`, then each `__MACOSX/` folder
 * once (a top-level one is `DESKTOP_FOLDER_WARNING`; a nested one is named by
 * its path, through `plainPath`, with its slash put back; an unprintable one
 * reads as the top-level sentence), at most five, then one line counting the
 * rest. A folder entry is never passed to `desktopFileWarning`.
 */
export function desktopWarnings(leftOut: readonly string[]): string[] {
  const files = leftOut.filter((at) => !at.endsWith('/'));
  const folders: string[] = [];
  for (const at of leftOut.filter((one) => one.endsWith('/'))) {
    const plain = plainPath(at.slice(0, -1));
    const line = plain === plainPath('') ? DESKTOP_FOLDER_WARNING : `left out: ${plain}/ is a desktop folder`;
    if (!folders.includes(line)) folders.push(line);
  }
  const more = Math.max(0, files.length - DESKTOP_NAMED) + Math.max(0, folders.length - DESKTOP_NAMED);
  return [
    ...files.slice(0, DESKTOP_NAMED).map(desktopFileWarning),
    ...folders.slice(0, DESKTOP_NAMED),
    ...(more > 0 ? [moreDesktopFilesWarning(more)] : []),
  ];
}

/**
 * A file under a sealed folder whose path holds a part that starts with
 * a dot, past the phase folder, refused by name (the first one, in path
 * order). Run over the sealed paths the layout walk kept, so a desktop entry
 * under a sealed folder, already left out with a warning, never meets it.
 */
export function checkSealedPaths(pack: RawPackManifest): PackRefusal[] {
  const dotted = [...(pack.sealedPaths ?? [])]
    .sort()
    .find((at) => at.split('/').slice(2).some((part) => part.startsWith('.')));
  return dotted === undefined ? [] : [refusal('PACK_INVALID', 'files', SEALED_DOT_PATH(plainPath(dotted)))];
}

/**
 * Dot-env and secret-shaped files, anywhere in the pack, are refused: the one
 * exception is `canonical/.env.example`, in an older-layout archive only. By name (a `.env*`, a key or
 * keystore, an ssh/npm/pypi/netrc/aws/docker credential, a version-control
 * folder that may hold a remote's token) and by content (a PEM private key).
 * The sentence names the file only when its path is plain, and never a byte
 * of it.
 *
 * `layout` is the archive's, read from `project.json` before the scan:
 * `folder` has no `canonical/` and so no exception, and its sentence is
 * `NEW_LAYOUT_SECRET`; `older`, the default, keeps the older layout's rule
 * and sentence. The walk and the names it reads do not take the layout.
 */
export function checkPackFiles(
  source: PackSource,
  names: string[] = source.walkForDigest(),
  options: { layout?: 'older' | 'folder' } = {},
): PackRefusal[] {
  const folder = options.layout === 'folder';
  const out: PackRefusal[] = [];
  for (const name of names) {
    const byName = isSecretPath(name, folder ? null : ALLOWED_ENV_FILE);
    let byContent = false;
    if (!byName) {
      try {
        byContent = PRIVATE_KEY.test(source.read(name));
      } catch {
        byContent = false;
      }
    }
    if (byName || byContent) {
      const where = plainPath(name);
      out.push(refusal('PACK_SECRET_FILE', where, folder
        ? NEW_LAYOUT_SECRET(where)
        : `${where} looks like a secret (a .env file, a private key or a credential). Only ${ALLOWED_ENV_FILE} may ship; leave secrets out of the archive and upload again.`));
    }
  }
  return out;
}

const EXECUTABLE_KINDS: ReadonlySet<string> = new Set(['code', 'tests', 'config']);

/** `reference-stories.md` directly under any phase folder, whatever the folder is called. */
const REFERENCE_STORIES = /^phases\/[^/]+\/reference-stories\.md$/;
/** Why an archive that still carries `reference-stories.md` is refused. */
export const REFERENCE_STORIES_REFUSAL = "reference-stories.md is no longer read. Type the stakeholder's facts in the editor.";

/**
 * The upload's shape, beyond the runs:
 *
 * - **no warm-up.** The warm-up loader (`content/warmup.loader.ts`) reads a
 *   pack's warm-up from the disk at `source.location`, not through the
 *   `PackSource`, so an uploaded `"warmup": "../../.."` would read the API
 *   host's own files. Refused until that loader reads through the source;
 * - **one work task per executable phase.** The on-disk format has no
 *   task list, so a `tasks` array on an executable phase holding more
 *   than one task that is not a quiz is refused with the
 *   `EXECUTABLE_SPLIT_NOT_READY` sentence;
 * - **no `reference-stories.md`.** The interview is no longer made from it,
 *   so an archive that still carries it is refused rather than read as if it
 *   counted. `names` are the archive's entry names under the pack root.
 */
export function checkUploadShape(pack: RawPackManifest, names: readonly string[] = []): PackRefusal[] {
  const out: PackRefusal[] = [];
  const stories = names.find((name) => REFERENCE_STORIES.test(name));
  if (stories) out.push(refusal('PACK_INVALID', stories, REFERENCE_STORIES_REFUSAL));
  const project = (pack.project ?? {}) as Json;
  if (project.warmup !== undefined && project.warmup !== null) {
    out.push(refusal('PACK_WARMUP_NOT_UPLOADABLE', 'project.warmup',
      'project.warmup declares a warm-up, and a warm-up cannot be uploaded yet. Remove the warmup key from project.json, leave its folder out, and upload again.'));
  } else if (pack.warmup !== null) {
    // an archive's warm-up is its warmup/ folder; a warmup member in project.json is refused above
    out.push(refusal('PACK_WARMUP_NOT_UPLOADABLE', 'warmup', LAYOUT_SENTENCES.warmupUploaded));
  }
  pack.phases.forEach((phase, index) => {
    if (!Array.isArray(phase.tasks)) return;
    const kind = String(phase.artifactKind ?? (phase.checks as Json)?.kind ?? '');
    if (!EXECUTABLE_KINDS.has(kind)) return;
    const work = (phase.tasks as Json[]).filter((task) => (task?.checkKind ?? task?.kind) !== 'quiz');
    if (work.length <= 1) return;
    const where = `phases[${phaseLabel(phase.key, index)}].tasks`;
    const title = typeof phase.title === 'string' && /^[\p{L}\p{N} .,'&()-]{1,80}$/u.test(phase.title)
      ? phase.title
      : `Phase ${index + 1}`;
    out.push(refusal('PACK_EXECUTABLE_SPLIT', where,
      `${where}: ${multiTaskPublishRefusal(title, work.length, kind as ArtifactKind)}`));
  });
  return out;
}

/**
 * A runtime block outside the one baked profile, asked of the runtime profile's
 * `runtimeProfileRefusals`: injectable so a spec can stand in for it.
 */
export function checkRuntimeProfile(
  pack: RawPackManifest,
  refusals: (runtime: RuntimeSpec | null | undefined) => RuntimeProfileRefusal[] = (runtime) =>
    runtimeProfileRefusals(runtime),
): PackRefusal[] {
  const runtime = (pack.project as Json)?.runtime;
  if (runtime === undefined || runtime === null) return [];
  let found: RuntimeProfileRefusal[];
  try {
    found = refusals(runtime as RuntimeSpec);
  } catch {
    return [refusal('RUNTIME_OUTSIDE_PROFILE', 'project.runtime',
      'project.runtime could not be read as a runtime this deployment runs. Name only the packages this deployment bakes, pinned exactly, and upload again.')];
  }
  return found.map((one) => {
    const name = typeof one.package === 'string' && /^[A-Za-z0-9@/._=+-]{1,80}$/.test(one.package) ? one.package : 'a package';
    return refusal('RUNTIME_OUTSIDE_PROFILE', 'project.runtime',
      `project.runtime asks for ${name}, which is outside the runtime this deployment bakes. Use only the packages the runtime profile lists, and upload again.`);
  });
}

/**
 * What can only be asked of the loaded pack: the importer's two byte rules
 * (and the reserved-path rule beside them), asked of the rows the importer
 * would write, and the microVM ceiling, priced by the compiler's own
 * `sandboxBudgetFor`.
 */
export function checkLoadedPack(project: ProjectContent): PackRefusal[] {
  const out: PackRefusal[] = [];
  const rows = derivedFileRows(project);
  // Each rule its own code. PACK_SEALED_BYTES is the importer's byte
  // rules only (the wire's HIDDEN_IN_WORKSPACE / SOLUTION_IN_EDITABLE); a
  // workspace file under a reserved prefix is PACK_RESERVED_PATH (the wire's
  // NOT_A_PACK, the path in `detail`), never "holds the bytes of a hidden test".
  const rules: [string, (where: string, rows: ReturnType<typeof derivedFileRows>) => void][] = [
    ['PACK_SEALED_BYTES', refuseSealedWorkspaceBytes],
    ['PACK_RESERVED_PATH', refuseReservedWorkspacePaths],
  ];
  for (const [code, rule] of rules) {
    try {
      rule('upload', rows);
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      out.push(refusal(code, 'files',
        `files: ${printable(String(error.message)).replace(/^upload: /, '')}.`));
    }
  }
  let total = 0;
  project.phases.forEach((phase, index) => {
    const cost = sandboxBudgetFor(phase, [soleTaskFor(phase)]);
    total += cost;
    if (cost > BUDGET_CEILING.perPhase) {
      const where = `phases[${phaseLabel(phase.key, index)}]`;
      out.push(refusal('PACK_OVER_BUDGET', where,
        `${where}: the ${phaseLabel(phase.key, index)} phase costs ${cost} microVMs per submission, above the ceiling of ${BUDGET_CEILING.perPhase} per phase. Remove runs or mutants until it fits.`));
    }
  });
  if (total > BUDGET_CEILING.perVersion) {
    out.push(refusal('PACK_OVER_BUDGET', 'project',
      `project: the version costs ${total} microVMs across its phases, above the ceiling of ${BUDGET_CEILING.perVersion} per version. Remove runs or mutants until it fits.`));
  }
  return out;
}

/** Printable text only, at most 400 characters, no trailing full stop (the caller adds one). */
export function printable(text: string): string {
  return text.replace(/[^\x20-\x7e -ɏ‘-”—]/g, '').slice(0, 400).replace(/[.\s]+$/, '');
}
