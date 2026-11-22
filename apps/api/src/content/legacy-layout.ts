import * as path from 'path';
import {
  DESKTOP_FOLDER,
  EDITOR_FOLDERS,
  MACHINE_OUTPUT_FOLDERS,
  PHASE_ORDER,
  compareMountPaths,
  isDesktopFile,
  isMachineOutputFile,
  languageOfPath,
  phaseFolderName,
  type PhaseKey,
} from '@learnsdlc/shared';
import type { ContentFileSpec, PhaseInputs } from './content.types';
// content.service imports this module and folder-layout imports content.service; each side reads the
// other only from inside a function, so the cycle is safe
import { LAYOUT_SENTENCES, LayoutRefusal, isObject, stringsOf } from './folder-layout';
import { MemoryPackSource } from './memory-pack-source';
import { LayoutWalkRefusal, type PackDirent, type PackSource } from './pack-source';
import { NEW_LAYOUT_SECRET, PRIVATE_KEY, isSecretPath, plainPath } from './secret-paths';
import { req, reqString } from './validate';
import { safeRelativePath } from './zip-reader';

/**
 * The older, pointer layout: a `project.json` that lists its
 * phases, and a `phase.json` that names its files, folders and sources.
 *
 * These are the pointer readers behind `PhaseInputs`. The one conversion of
 * an older archive, `layoutFromManifest` (at the end of this file), reads
 * every pointer through them, so it reads each one exactly as the pointer
 * loader did. `ContentService` keeps every validation; these readers only
 * read.
 */

/**
 * A `faultedFiles` (or similar) value written as a bare relative path rather
 * than inline content. Single line, no wrapping whitespace: inline content
 * that happens to be one line is still checked against the filesystem before
 * being treated as a reference.
 */
function looksLikeSourceRef(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\n\r\0]/.test(value) && value.trim() === value;
}

export function readRel(phase: PackSource, rel: string): string {
  if (!phase.exists(rel)) {
    throw new Error(`source file not found: ${rel} (resolved to ${phase.resolve(rel)})`);
  }
  return phase.read(rel);
}

/**
 * A file value that is either inline content or a reference to a file next
 * to the phase. `{ source }` and `{ content }` say which explicitly; a bare
 * string is a reference when it resolves to a real file and inline content
 * otherwise. Lets a pack keep a large faulted copy in its own file.
 */
export function readFileValue(phase: PackSource, field: string, value: unknown): string {
  if (value && typeof value === 'object') {
    const obj = value as { source?: unknown; content?: unknown };
    if (typeof obj.source === 'string') return readRel(phase, obj.source);
    if (typeof obj.content === 'string') return obj.content;
    throw new Error(`${field} must be a string, { source } or { content }`);
  }
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string, { source } or { content }`);
  }
  if (looksLikeSourceRef(value) && phase.exists(value)) {
    return readRel(phase, value);
  }
  return value;
}

/**
 * `files[]` is the entire editable surface of a phase: a pack that adds a
 * JSON scaffold or a changelog needs an entry here and no loader change.
 * `source` resolves relative to the phase directory, so shared canonical
 * files stay a `../../canonical/...` hop away.
 */
export function loadFiles(phaseDir: PackSource, raw: unknown): ContentFileSpec[] {
  if (raw === undefined || raw === null) return [];
  req(Array.isArray(raw), 'files must be an array');
  const seen = new Set<string>();
  return (raw as Record<string, unknown>[]).map((f, i) => {
    const at = `files[${i}]`;
    req(f && typeof f === 'object', `${at} must be an object`);
    const filePath = reqString(f.path, `${at}.path`);
    req(!seen.has(filePath), `${at}: duplicate path "${filePath}"`);
    seen.add(filePath);
    return {
      path: filePath,
      content: readRel(phaseDir, reqString(f.source, `${at}.source`)),
      editable: !!f.editable,
      language: (f.language as string | undefined) || 'plaintext',
    };
  });
}

export function loadFileMap(phaseDir: PackSource, map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [dest, src] of Object.entries(map || {})) {
    out[dest] = readRel(phaseDir, src);
  }
  return out;
}

/**
 * A directory of source files placed at the workspace paths they overlay.
 *
 * A file is matched by its path **relative to the overlay root** first, and
 * only then by basename: a full-stack pack has
 * `solution/api/repository/tasks.py` beside `solution/web/src/lib/overdue.ts`,
 * and two layers can hold two files of the same name. The basename map is
 * what a flat overlay relies on, so it stays as the fallback.
 *
 * A file that matches no target keeps its own relative path when the overlay
 * nests, and lands under `tests/` when it does not, which is where a helper
 * module a flat suite imports has to go.
 */
export function loadOverlay(dir: PackSource, targets: string[], field: string): Record<string, string> {
  req(dir.available(), `${field}: directory not found (resolved to ${dir.location})`);
  const byPath = new Set(targets);
  const byBasename = new Map(targets.map((t) => [path.basename(t), t]));
  const files: Record<string, string> = {};
  const from: Record<string, string> = {};
  for (const rel of dir.walk()) {
    const target = byPath.has(rel)
      ? rel
      : byBasename.get(path.basename(rel)) ?? (rel.includes('/') ? rel : `tests/${rel}`);
    req(
      files[target] === undefined,
      `${field}: ${from[target]} and ${rel} both overlay "${target}"`,
    );
    from[target] = rel;
    files[target] = dir.read(rel);
  }
  req(Object.keys(files).length > 0, `${field}: no files in ${dir.location}`);
  return files;
}

/**
 * A hidden suite directory, at the workspace paths its files are written to.
 *
 * A flat directory keeps the `tests/` prefix, so
 * every existing pack is unchanged; a directory that nests keeps its own
 * relative paths, which is how a front-end suite lands beside the components
 * it imports rather than in a `tests/` folder that breaks its imports.
 */
export function loadHiddenTests(dir: PackSource, field: string): Record<string, string> {
  req(dir.available(), `${field}: directory not found (resolved to ${dir.location})`);
  const files: Record<string, string> = {};
  for (const rel of dir.walk()) {
    const at = rel.includes('/') ? rel : `tests/${rel}`;
    files[at] = dir.read(rel);
  }
  req(Object.keys(files).length > 0, `${field}: no files in ${dir.location}`);
  return files;
}

/**
 * A mutant directory's files, each placed at the implementation path it
 * replaces: its own relative path first, then its basename, which is how
 * every pack written before a nested implementation named its mutants. A file
 * that matches neither keeps its own path, which the loader then refuses as
 * overlaying nothing.
 */
function placeMutant(dir: PackSource, implPaths: string[]): Record<string, string> {
  const byBasename = new Map(implPaths.map((p) => [path.basename(p), p]));
  const files: Record<string, string> = {};
  for (const rel of dir.walk()) {
    if (rel === 'meta.json') continue;
    const target = implPaths.includes(rel) ? rel : byBasename.get(path.basename(rel)) ?? rel;
    files[target] = dir.read(rel);
  }
  return files;
}

/**
 * The pointer layout's `PhaseInputs`: every piece read where the `phase.json`
 * says it is, by the readers above, with the loader's own field names in its
 * sentences.
 */
export function pointerInputs(phaseDir: PackSource, spec: Record<string, unknown>): PhaseInputs {
  return {
    where: phaseDir.location,
    files: () => loadFiles(phaseDir, spec.files),
    // The brief is a file (`taskFile`) or inline text (`taskPanel`); the file wins.
    brief: (one) => (one.taskFile ? readRel(phaseDir, reqString(one.taskFile, 'taskFile')) : (one.taskPanel as string)),
    // inline content or a file beside the phase, read by the same `readFileValue` every other pack block uses
    interviewText: (one) => (one.interview === undefined || one.interview === null ? null : readFileValue(phaseDir, 'interview', one.interview)),
    hiddenFor: (runSpec, flat, field) =>
      loadHiddenTests(
        phaseDir.child(reqString(runSpec === null || runSpec.hiddenTestDir === undefined ? flat.hiddenTestDir : runSpec.hiddenTestDir, field)),
        field,
      ),
    solution: (raw, targets) => loadOverlay(phaseDir.child(reqString(raw.solutionDir, 'checks.solutionDir')), targets, 'checks.solutionDir'),
    reference: (raw, targets) => loadOverlay(phaseDir.child(reqString(raw.referenceDir, 'checks.referenceDir')), targets, 'checks.referenceDir'),
    // `implDir` is the two-layer shape: one directory whose own tree is the
    // workspace tree, read like every other overlay. `implFiles` is the map
    // every pack written before it used, and both still work.
    impl: (raw, declared) =>
      raw.implDir
        ? loadOverlay(phaseDir.child(reqString(raw.implDir, 'checks.implDir')), declared, 'checks.implDir')
        : loadFileMap(phaseDir, raw.implFiles as Record<string, string>),
    support: (raw) => loadFileMap(phaseDir, raw.supportFiles as Record<string, string>),
    mutants: (raw) => {
      const mutantsDir = phaseDir.child(raw.mutantsDir as string);
      return mutantsDir
        .entries()
        .filter((d) => d.isDirectory)
        .map((d) => {
          const dir = mutantsDir.child(d.name);
          return {
            name: d.name,
            // read when the loader asks, mutant by mutant, as it always has
            get meta(): Record<string, unknown> {
              return JSON.parse(dir.read('meta.json'));
            },
            files: (implPaths: string[]) => placeMutant(dir, implPaths),
          };
        });
    },
    smoke: (raw) => loadFileMap(phaseDir, (raw.smoke as { implFiles: Record<string, string> }).implFiles),
    drill: (raw) => {
      const faultedFiles: Record<string, string> = {};
      for (const [dest, value] of Object.entries((raw.faultedFiles as Record<string, unknown>) || {})) {
        faultedFiles[dest] = readFileValue(phaseDir, `checks.drill.faultedFiles["${dest}"]`, value);
      }
      return faultedFiles;
    },
    named: (member) => member,
  };
}

/* ------------------------- the one conversion ------------------------- */

/** The upload's warning for an older archive, said once. */
export const OLDER_LAYOUT_WARNING = 'This archive was in the older layout, with a list of phases and files. It was read once; its export will be in the folder layout.';

/**
 * A declared value as a warning prints it: text as itself, any other JSON
 * value as its JSON, clipped to 32 code units with every code unit outside
 * printable ASCII shown as `?` (the refusals' clipping rule), since it is
 * archive text.
 */
function declaredText(declared: unknown): string {
  const text = typeof declared === 'string' ? declared : JSON.stringify(declared) ?? String(declared);
  return text.slice(0, 32).replace(/[^\x20-\x7e]/g, '?');
}

/**
 * A mount whose declared language is not its path's: converted
 * with the derived one, and said once. The path is printed through
 * `plainPath` and the declared value through `declaredText`, so no warning
 * carries more than 160 characters of a path or an unsafe byte.
 */
export const languageWarning = (path: string, declared: unknown, derived: string): string =>
  `${plainPath(path)} was declared ${declaredText(declared)}; it is read as ${derived} by its extension now.`;

/**
 * The folder layout holds one copy of a path, so a tests phase's
 * `supportFiles` map whose source gives a path other bytes than the
 * read-only mount at that path cannot be converted. `folder` is the
 * archive's own phase folder, as its `project.json` lists it, never the
 * converted one: a subset that keeps LearnSDLC's numbers is renumbered.
 */
export const supportBytesRefusal = (folder: string, at: string): string =>
  `${folder}: checks.supportFiles gives ${at} other bytes than its read-only mount, and the folder layout holds one copy of a path. Make the two the same file and upload again.`;

/**
 * One refusal in the door's own shape (`PackRefusal`, `authoring/upload-limits.ts`),
 * spelled here so this module's import closure holds none of the door's
 * modules (`deep-validation.spec` walks the loader's closure for model calls).
 */
export interface ConvertedPathRefusal {
  code: string;
  where: string;
  sentence: string;
}

/**
 * A converted path the folder layout's secret rule refuses: each
 * finding in the door's own shape, its sentence the folder layout's
 * (`NEW_LAYOUT_SECRET`), naming the converted path through `plainPath`.
 */
export class ConversionRefusal extends Error {
  constructor(readonly findings: ConvertedPathRefusal[]) {
    super(findings.map((one) => one.sentence).join(' '));
    this.name = 'ConversionRefusal';
  }
}

/** Whether an archive is in the older layout: its `project.json` lists phases. One that cannot be read is not. */
export function isOlderLayout(source: PackSource): boolean {
  try {
    const project = JSON.parse(source.read('project.json'));
    return !!project && typeof project === 'object' && !Array.isArray(project) && Object.prototype.hasOwnProperty.call(project, 'phases');
  } catch {
    return false;
  }
}

/** The run a code phase grades with no `checks.runs`: its hidden suite is `hidden_tests/main/`. */
const FLAT_RUN_ID = 'main';


/** Whether a path, relative to where a walk began, is a desktop file or sits in a `__MACOSX/` folder. */
function isDesktopPath(rel: string): boolean {
  const parts = rel.split('/');
  return parts.slice(0, -1).includes(DESKTOP_FOLDER) || isDesktopFile(parts[parts.length - 1]);
}

/**
 * The archive as the pointer readers read it for the conversion, with every
 * desktop entry left out of a listing or a walk: so a
 * `Thumbs.db` in a solution folder is never converted and renamed, and a
 * `__MACOSX/` under `mutants/` is never a mutant. Everything else is the
 * archive's own answer, so the readers stay verbatim.
 */
class WithoutDesktop implements PackSource {
  constructor(private readonly inner: PackSource) {}

  get name(): string {
    return this.inner.name;
  }

  get location(): string {
    return this.inner.location;
  }

  available(): boolean {
    return this.inner.available();
  }

  exists(rel: string): boolean {
    return this.inner.exists(rel);
  }

  read(rel: string): string {
    return this.inner.read(rel);
  }

  entries(rel?: string): PackDirent[] {
    return this.inner.entries(rel).filter((one) => (one.isDirectory ? one.name !== DESKTOP_FOLDER : !isDesktopFile(one.name)));
  }

  walk(rel?: string): string[] {
    return this.inner.walk(rel).filter((at) => !isDesktopPath(at));
  }

  walkForDigest(rel?: string): string[] {
    return this.inner.walkForDigest(rel);
  }

  walkLayout(rel?: string): string[] {
    return this.inner.walkLayout(rel);
  }

  child(rel: string): PackSource {
    return new WithoutDesktop(this.inner.child(rel));
  }

  resolve(rel: string): string {
    return this.inner.resolve(rel);
  }
}

/** Whether `rel` is a folder of the source. */
function isFolder(source: PackSource, rel: string): boolean {
  try {
    source.entries(rel);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every desktop entry under the archive's own `phases/`, by pack-relative
 * path (the outermost `__MACOSX/` on a path, with its slash; else a desktop
 * file): noted once on the converted source at its original path, never
 * stored and never refused. The archive's source noted
 * every one outside `phases/` when it was built.
 */
function desktopEntriesUnderPhases(source: PackSource): string[] {
  if (!source.entries('').some((one) => one.name === 'phases' && one.isDirectory)) return [];
  const out = new Set<string>();
  for (const rel of source.walkForDigest('phases')) {
    const parts = `phases/${rel}`.split('/');
    const inFolder = parts.slice(0, -1).indexOf(DESKTOP_FOLDER);
    if (inFolder >= 0) out.add(`${parts.slice(0, inFolder + 1).join('/')}/`);
    else if (isDesktopFile(parts[parts.length - 1])) out.add(parts.join('/'));
  }
  return [...out];
}

/** The workspace paths a tests phase's runs say their implementation lives at (the loader's `declaredImplPaths`). */
function declaredImplPaths(raw: Record<string, any>): string[] {
  if (!Array.isArray(raw.runs)) return Object.keys(raw.implFiles || {});
  return (raw.runs as Record<string, unknown>[]).flatMap((run) => (Array.isArray(run.implFiles) ? (run.implFiles as string[]) : []));
}

/**
 * The implementation paths a mutant is placed on, as `loadMutant` places it:
 * the run its `meta.run` names, else the first run; a flat tests phase's one
 * run holds the whole implementation.
 */
function mutantImplPaths(meta: unknown, raw: Record<string, any>, impl: Record<string, string>): string[] {
  if (!Array.isArray(raw.runs)) return Object.keys(impl);
  const runs = (raw.runs as unknown[]).filter(isObject);
  const declared = isObject(meta) && typeof meta.run === 'string' && meta.run.trim() ? meta.run : undefined;
  const run = runs.find((one) => one.id === (declared ?? runs[0]?.id));
  return run ? stringsOf(run.implFiles) : [];
}

/** Where the conversion writes, keyed by pack-relative path; a workspace path that is not a plain relative path is refused in the loader's words. */
class Written {
  readonly files = new Map<string, string>();

  put(at: string, text: string): void {
    this.files.set(at, text);
  }

  /** `text` at `<under>/<workspace>`, once `workspace` is a relative path inside the workspace. */
  placed(under: string, workspace: string, text: string, field: string): void {
    if (!safeRelativePath(workspace)) throw new Error(`${field} ("${workspace}") must be a relative path inside the workspace`);
    this.put(`${under}/${workspace}`, text);
  }

  each(under: string, files: Record<string, string>, field: string): void {
    for (const [at, text] of Object.entries(files)) this.placed(under, at, text, field);
  }
}

/**
 * One phase of an older archive into its folder, every pointer
 * read through `pointerInputs` exactly as the loader reads it, and only
 * where the loader reads it (by the checks' kind): the mounts under `files/`
 * and `readonly/`; the brief inline; the interview as `interview.json`; a
 * code phase's hidden suites by run and its solution; a tests phase's
 * reference suite, implementation, support list and mutants; a config
 * phase's smoke files and the drill's faulted copies. Its `phase.json` is
 * written with every pointer member removed. `archiveFolder` is the
 * folder the archive itself names, for the one refusal that names a phase
 * folder in its own words; everything is written under `folder`.
 */
function convertPhase(phaseDir: PackSource, spec: Record<string, any>, folder: string, archiveFolder: string, out: Written, languages: Set<string>): void {
  const inputs = pointerInputs(phaseDir, spec);
  const raw: Record<string, any> | null = isObject(spec.checks) ? spec.checks : null;
  const checks: Record<string, any> | null = raw ? JSON.parse(JSON.stringify(raw)) : null;

  // the mounts, each at its path by its editable flag, each language by its path (7.2)
  const files = inputs.files();
  files.forEach((file, i) => {
    out.placed(`${folder}/${file.editable ? 'files' : 'readonly'}`, file.path, file.content, `files[${i}].path`);
    const derived = languageOfPath(file.path);
    if (file.language !== derived) languages.add(languageWarning(file.path, file.language, derived));
  });

  // the brief: the taskFile's bytes or taskPanel, replaced by a task block's brief, which leaves the block
  let brief: string | undefined = spec.taskFile || typeof spec.taskPanel === 'string' ? inputs.brief(spec) : undefined;
  const task = isObject(spec.task) ? { ...spec.task } : spec.task;
  if (isObject(task) && typeof task.brief === 'string') {
    brief = task.brief;
    delete task.brief;
  }

  // the interview: a Requirements phase's only; the loader ignores one anywhere else
  if (spec.key === 'requirements') {
    const interview = inputs.interviewText(spec);
    if (interview !== null) out.put(`${folder}/interview.json`, interview);
  }

  if (raw && checks && raw.kind === 'code') {
    if (Array.isArray(raw.runs)) {
      raw.runs.forEach((run: unknown, i: number) => {
        // a run the loader refuses (no object, no id, an id that is no folder name) is left to its sentence
        if (!isObject(run) || typeof run.id !== 'string' || !safeRelativePath(run.id) || run.id.includes('/')) return;
        const field = `checks.runs[${i}].hiddenTestDir`;
        out.each(`${folder}/hidden_tests/${run.id}`, inputs.hiddenFor(run, raw, field, run.id), field);
      });
    } else {
      // a flat code phase is graded as its one run main, and writes no runs
      out.each(`${folder}/hidden_tests/${FLAT_RUN_ID}`, inputs.hiddenFor(null, raw, 'checks.hiddenTestDir', FLAT_RUN_ID), 'checks.hiddenTestDir');
    }
    out.each(`${folder}/solution`, inputs.solution(raw, stringsOf(raw.editableTargets)), 'checks.solutionDir');
  }

  if (raw && checks && raw.kind === 'tests') {
    out.each(`${folder}/reference`, inputs.reference(raw, stringsOf(raw.learnerTestFiles)), 'checks.referenceDir');
    const impl = inputs.impl(raw, raw.implDir ? declaredImplPaths(raw) : []);
    out.each(`${folder}/impl`, impl, raw.implDir ? 'checks.implDir' : 'checks.implFiles');
    // the support map becomes the list of its paths, each the bytes of its read-only mount
    if (isObject(raw.supportFiles)) {
      const support = inputs.support(raw, files);
      for (const [at, text] of Object.entries(support)) {
        const mount = files.find((one) => one.path === at && !one.editable);
        if (mount && mount.content !== text) throw new LayoutRefusal(supportBytesRefusal(archiveFolder, at));
      }
      checks.supportFiles = Object.keys(support);
    } else if (raw.supportFiles === undefined && Array.isArray(raw.runs)) {
      // the pointer layout reads no map as an empty one; the folder layout would read the runs' lists
      checks.supportFiles = [];
    }
    for (const mutant of inputs.mutants(raw)) {
      const under = `${folder}/mutants/${mutant.name}`;
      const metaText = phaseDir.child(raw.mutantsDir as string).child(mutant.name).read('meta.json');
      let meta: unknown;
      try {
        meta = JSON.parse(metaText);
      } catch {
        // the loader refuses it in its own words when the converted pack loads
        meta = null;
      }
      out.put(`${under}/meta.json`, metaText);
      out.each(under, mutant.files(mutantImplPaths(meta, raw, impl)), `mutants/${mutant.name}`);
    }
  }

  if (raw && checks && raw.kind === 'config') {
    if (isObject(raw.smoke)) out.each(`${folder}/smoke`, inputs.smoke(raw), 'checks.smoke.implFiles');
    if (isObject(raw.drill)) out.each(`${folder}/drill`, inputs.drill(raw.drill), 'checks.drill.faultedFiles');
  }

  // every pointer member goes (7.3): the folder and the fixed names say each one now
  if (checks) {
    for (const member of ['solutionDir', 'hiddenTestDir', 'referenceDir', 'implDir', 'mutantsDir']) delete checks[member];
    if (isObject(checks.implFiles)) delete checks.implFiles;
    // a tests phase's map is a list by now; a map on any other phase is one the pointer loader never reads
    if (isObject(checks.supportFiles)) delete checks.supportFiles;
    for (const run of Array.isArray(checks.runs) ? checks.runs : []) if (isObject(run)) delete run.hiddenTestDir;
    if (isObject(checks.smoke)) delete checks.smoke.implFiles;
    if (isObject(checks.drill)) delete checks.drill.faultedFiles;
  }
  const next: Record<string, unknown> = {};
  for (const [member, value] of Object.entries(spec)) {
    if (member === 'key' || member === 'order' || member === 'files' || member === 'interview') continue;
    if (member === 'taskFile' || member === 'taskPanel') {
      // the brief takes the place its pointer or its text held; a taskPanel that is not text stays for the loader to refuse
      if (brief !== undefined) next.taskPanel = brief;
      else if (member === 'taskPanel') next.taskPanel = value;
      continue;
    }
    next[member] = member === 'checks' && checks ? checks : member === 'task' ? task : value;
  }
  if (brief !== undefined) next.taskPanel = brief;
  out.put(`${folder}/phase.json`, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * The folder layout's rules over every path the conversion wrote. A
 * secret-shaped path or a PEM private key refuses the archive with the
 * folder layout's secret sentence, every finding at once, as the door's scan
 * does; then a machine-output folder or file and an editor's folder refuse
 * it by their own sentences, the first one named. Each names the converted
 * path, so a mount whose path makes it a secret is caught though no entry of
 * the archive is named like one.
 */
function refuseConvertedPaths(written: Map<string, string>): void {
  const paths = [...written.keys()].sort(compareMountPaths);
  const secrets: ConvertedPathRefusal[] = paths
    .filter((at) => isSecretPath(at, null) || PRIVATE_KEY.test(written.get(at)!))
    .map((at) => {
      const where = plainPath(at);
      return { code: 'PACK_SECRET_FILE', where, sentence: NEW_LAYOUT_SECRET(where) };
    });
  if (secrets.length) throw new ConversionRefusal(secrets);
  for (const at of paths) {
    const parts = at.split('/');
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const folder = parts.slice(0, depth + 1).join('/');
      if (MACHINE_OUTPUT_FOLDERS.has(parts[depth])) throw new LayoutWalkRefusal(folder, false);
      if (EDITOR_FOLDERS.has(parts[depth])) throw new LayoutWalkRefusal(folder, true);
    }
    if (isMachineOutputFile(parts[parts.length - 1])) throw new LayoutWalkRefusal(at, false);
  }
}

/**
 * An older archive in the folder layout, in memory: every
 * pointer resolved exactly as the pointer loader reads it, through
 * `pointerInputs` and its readers, `readRel` resolving a `../../canonical/`
 * source from the archive's own `canonical/` folder (the one resolver).
 *
 * `project.json` loses its `phases` (and a warm-up it names moves to
 * `warmup/`, where the folder layout finds one); each listed phase becomes
 * `phases/<NN>-<key>/` in LearnSDLC's order. `canonical/` and every file no
 * pointer reached are left behind, never stored. Desktop entries under the
 * archive's `phases/` are noted once on the new source at their original
 * path (`leftOut()`), never converted and never refused; the new source
 * holds no other note of its own (the archive's source holds those outside
 * `phases/`). The converted paths are then held to the secret,
 * machine-output and editor rules.
 *
 * The warnings are `OLDER_LAYOUT_WARNING`, then one `languageWarning` per
 * mount whose declared language is not its path's; the loader's own
 * conversions add theirs when the converted pack loads. A refusal of the
 * layout (`LayoutRefusal`, `LayoutWalkRefusal`, `ConversionRefusal`) names
 * its folder; every other error is prefixed with the pack and the phase as
 * the pointer loader prefixes it.
 */
export function layoutFromManifest(source: PackSource): { source: MemoryPackSource; warnings: string[] } {
  const project = JSON.parse(source.read('project.json'));
  req(isObject(project), `${source.name}/project.json must be an object`);
  req(Array.isArray(project.phases) && project.phases.length > 0, `${source.name}/project.json: phases must be a non-empty array`);
  const named = (rel: unknown, error: unknown): Error =>
    error instanceof LayoutRefusal || error instanceof LayoutWalkRefusal || error instanceof ConversionRefusal
      ? error
      : new Error(`${source.name}/${rel}: ${(error as Error).message}`);

  // each listed phase, read where the list says, by its key
  const listed = (project.phases as unknown[]).map((rel) => {
    try {
      const phaseDir = new WithoutDesktop(source.child(rel as string));
      const spec = JSON.parse(phaseDir.read('phase.json'));
      req(isObject(spec), 'phase.json must be an object');
      const key = reqString(spec.key, 'key') as PhaseKey;
      req(PHASE_ORDER.includes(key), `key "${key}" is not one of ${PHASE_ORDER.join(', ')}`);
      return { rel: rel as string, phaseDir, spec, key };
    } catch (error) {
      throw named(rel, error);
    }
  });
  const byKey = new Map<PhaseKey, string>();
  for (const one of listed) {
    const other = byKey.get(one.key);
    if (other !== undefined) {
      const [a, b] = [other, one.rel].sort(compareMountPaths);
      throw new LayoutRefusal(LAYOUT_SENTENCES.twice(a, b, one.key));
    }
    byKey.set(one.key, one.rel);
  }

  const out = new Written();
  const languages = new Set<string>();
  const ordered = [...listed].sort((a, b) => PHASE_ORDER.indexOf(a.key) - PHASE_ORDER.indexOf(b.key));
  ordered.forEach((one, i) => {
    try {
      convertPhase(one.phaseDir, one.spec, `phases/${phaseFolderName(i + 1, one.key)}`, one.rel, out, languages);
    } catch (error) {
      throw named(one.rel, error);
    }
  });

  const meta: Record<string, unknown> = { ...project };
  delete meta.phases;
  // a warm-up is found by its folder in the folder layout (an upload holding one is then refused by name)
  if (typeof project.warmup === 'string' && safeRelativePath(project.warmup) && isFolder(source, project.warmup)) {
    for (const at of source.walkForDigest(project.warmup)) {
      if (!isDesktopPath(at)) out.put(`warmup/${at}`, source.read(`${project.warmup}/${at}`));
    }
    delete meta.warmup;
  } else if (project.warmup === null) {
    // the pointer loader and the door read a null warm-up as none; the folder layout refuses any warmup member
    delete meta.warmup;
  }
  out.put('project.json', `${JSON.stringify(meta, null, 2)}\n`);

  refuseConvertedPaths(out.files);
  const converted = new MemoryPackSource(
    [...out.files].map(([name, text]) => ({ name, bytes: Buffer.from(text, 'utf-8') })),
    source.name,
    '',
  );
  for (const at of desktopEntriesUnderPhases(source)) converted.noteLeftOut(at);
  return { source: converted, warnings: [OLDER_LAYOUT_WARNING, ...languages] };
}
