import * as fs from 'fs';
import * as path from 'path';
import { compareMountPaths, DESKTOP_FOLDER, EDITOR_FOLDERS, isDesktopFile, isMachineOutputFile, MACHINE_OUTPUT_FOLDERS } from '@learnsdlc/shared';

/**
 * Where a pack's bytes come from (teacher-authored projects).
 *
 * A project can be rows as well as a directory, so the loader keeps two
 * questions apart: *what a pack declares* stays in `content.service.ts`, and
 * *where the bytes are* comes in through this interface rather than through
 * `fs.readFileSync` and `path.join` inside the loader's own methods.
 *
 * The directory-backed implementation below is the reference one: it is what
 * the importer reads `content/tasktrackr` through, and it is what every spec
 * that builds a pack in a temp directory works against. `MemoryPackSource`
 * (`memory-pack-source.ts`) is the other, over an uploaded archive's entries.
 * Either way the loader's refusal sentences, its overlay rules and its path
 * arithmetic are in one place.
 *
 * **Path semantics, because a pack depends on them.** A relative path is
 * resolved against the source's own root and may leave it: the packs' phases
 * reach shared files by `../../canonical/...`, which is the whole reason
 * `resolve` is `path.resolve` and not a join with a containment check. A source
 * of another kind implements the same arithmetic over its own namespace.
 */
export interface PackDirent {
  name: string;
  isDirectory: boolean;
}

export interface PackSource {
  /** The pack's own name, as its refusal sentences print it (`tasktrackr`). */
  readonly name: string;
  /**
   * Where this source reads from, as the sentences that name a directory print
   * it. For a directory it is that directory's path; a source of another kind
   * names itself in the same slot.
   */
  readonly location: string;
  /** Whether the source's own root is there at all. */
  available(): boolean;
  /** Whether `rel` names something this source holds. `''` names the root. */
  exists(rel: string): boolean;
  /** `rel`'s bytes as text. The caller has already said what a missing file means. */
  read(rel: string): string;
  /** One level of `rel`, sorted by name. */
  entries(rel?: string): PackDirent[];
  /** Every source file under `rel`, recursively, as paths relative to it, sorted. */
  walk(rel?: string): string[];
  /**
   * The same walk, for identity rather than for loading: dot-prefixed files
   * and dot-directories included. See `walkAllFiles`.
   */
  walkForDigest(rel?: string): string[];
  /**
   * Every file under `rel` that the folder layout mounts or seals, as paths
   * relative to it, sorted in code-unit order: dot-prefixed entries
   * included; on disk, machine output, tool and editor folders and desktop
   * files skipped; in an upload, machine output refused by name and desktop
   * entries left out with a warning. A walk of its own, beside `walk`, which
   * the pointer layout keeps reading.
   */
  walkLayout(rel?: string): string[];
  /** A source rooted at `rel`: a phase directory, an overlay, one mutant. */
  child(rel: string): PackSource;
  /** `rel` as the sentences that print a resolved path print it. */
  resolve(rel: string): string;
}

/**
 * Files an overlay directory hands to the runner (test suites, solutions,
 * hidden suites, mutants).
 *
 * A skip list, not an allow list. The allow list was `.py || .js`, so a
 * TypeScript solution, hidden suite or mutant was silently dropped: the
 * overlay loaded empty and a `.tsx` mutant graded as unkillable. What a run
 * does with a file is the run's business; the loader's job is only to leave
 * out what is never source.
 */
export function isSourceFile(name: string): boolean {
  const base = path.basename(name);
  return !base.startsWith('.') && !base.endsWith('.pyc') && !base.endsWith('.map');
}

/** Directories no overlay walk descends into. */
const SKIPPED_DIRS = new Set(['__pycache__', 'node_modules']);

/**
 * Every source file under `dir`, as paths relative to it, sorted.
 *
 * The walk is recursive because a full-stack pack nests its overlays
 * (`solution/api/repository/tasks.py` beside `solution/web/src/lib/overdue.ts`)
 * and a flat `readdirSync` reads neither.
 */
function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child);
      else if (isSourceFile(entry.name)) out.push(child);
    }
  };
  visit('');
  return out;
}

/**
 * Every file under `dir` that belongs to the pack's **identity**, as paths
 * relative to it, sorted.
 *
 * The difference from `walkSourceFiles` is the dot: that walk skips every
 * dot-prefixed entry at every level because an overlay must not mount a
 * `.gitignore` or a `.env.example` as a learner file, which is a rule about
 * *loading*. Identity is the other question (a pack's bytes are a pack's
 * bytes, `read()` and `exists()` skip nothing, and a phase may source
 * `../../canonical/.env.example`), so a digest built on the loading walk was
 * blind to files the pack really holds, and a fix to one of them redeployed at
 * the same version was reported as "unchanged" and then as compiler drift.
 *
 * Machine output stays out, because it is not authored and it moves on its
 * own: `__pycache__` and `node_modules` as directories, `.pyc` and `.map` as
 * files. Everything else a hand put there counts.
 */
function walkAllFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child);
      else if (!entry.name.endsWith('.pyc') && !entry.name.endsWith('.map')) out.push(child);
    }
  };
  visit('');
  return out;
}

/** A path the upload's layout walk refuses by name. */
export class LayoutWalkRefusal extends Error {
  constructor(readonly path: string, readonly editor: boolean) {
    super(editor ? editorFolderSentence(path) : machineOutputSentence(path));
  }
}

/** The machine-output refusal: a tool's folder or a built file, named by its pack-relative path. */
export const machineOutputSentence = (at: string): string => `${at} is machine output. Remove it from the archive and upload again.`;

/** The editor-folder refusal, for `.idea` and `.vscode`. */
export const editorFolderSentence = (at: string): string => `${at} is an editor's settings folder. Remove it from the archive and upload again.`;

/**
 * The platform's disk walk for the folder layout: every file under
 * `dir` a phase mounts or seals, as paths relative to it, in code-unit order.
 *
 * Unlike `walkSourceFiles`, a dot-prefixed entry is a mount at its path
 * (`files/.github/workflows/ci.yml`), because in this layout every file under
 * a phase folder is the author's deliberate placement. What a maintainer's
 * machine leaves in a `content/` folder is skipped, never mounted: the
 * machine-output and local-tool folders, the editor folders, a `__MACOSX/`
 * folder, the desktop files and the `.pyc` and `.map` files. An upload walks
 * by the same rule but refuses machine output by name instead
 * (`MemoryPackSource.walkLayout`), so the two walks are two.
 */
function walkLayoutFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (MACHINE_OUTPUT_FOLDERS.has(entry.name) || EDITOR_FOLDERS.has(entry.name) || entry.name === DESKTOP_FOLDER) continue;
      if (!entry.isDirectory() && (isDesktopFile(entry.name) || isMachineOutputFile(entry.name))) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child);
      else out.push(child);
    }
  };
  visit('');
  return out.sort(compareMountPaths);
}

/** A pack in a directory: the authoring format, and the importer's source. */
export class DirectoryPackSource implements PackSource {
  constructor(private readonly root: string) {}

  get name(): string {
    return path.basename(this.root);
  }

  get location(): string {
    return this.root;
  }

  available(): boolean {
    return fs.existsSync(this.root);
  }

  exists(rel: string): boolean {
    return fs.existsSync(this.resolve(rel));
  }

  read(rel: string): string {
    return fs.readFileSync(this.resolve(rel), 'utf-8');
  }

  entries(rel = ''): PackDirent[] {
    return fs
      .readdirSync(this.resolve(rel), { withFileTypes: true })
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  walk(rel = ''): string[] {
    return walkSourceFiles(this.resolve(rel));
  }

  walkForDigest(rel = ''): string[] {
    return walkAllFiles(this.resolve(rel));
  }

  walkLayout(rel = ''): string[] {
    return walkLayoutFiles(this.resolve(rel));
  }

  /**
   * A source rooted at `rel`.
   *
   * `path.join`, not `path.resolve`, because the joined string is what the
   * loader's "directory not found (resolved to ...)" and "no files in ..."
   * sentences have always printed, and those sentences are read by pack
   * authors and matched by tests.
   */
  child(rel: string): DirectoryPackSource {
    return new DirectoryPackSource(path.join(this.root, rel));
  }

  resolve(rel: string): string {
    return path.resolve(this.root, rel);
  }
}

/**
 * The packs under a content root, sorted by directory name, or null when the
 * root itself is not there.
 *
 * A directory without a `project.json` is not a pack and is skipped in silence,
 * exactly as the boot walk has always skipped it: the content root holds
 * whatever a deployment put there.
 */
export function directoryPacksIn(root: string): DirectoryPackSource[] | null {
  if (!fs.existsSync(root)) return null;
  const source = new DirectoryPackSource(root);
  return source
    .entries()
    .filter((entry) => entry.isDirectory)
    .map((entry) => source.child(entry.name))
    .filter((pack) => pack.exists('project.json'));
}

/**
 * A file from the runner's own directory, or null when it is not on this tree.
 *
 * It is here rather than in the loader because it is the last thing the loader
 * read off a disk that was not a pack: the runner's package allowlist
 * (`runtime_manifest.py`) lives with the runner on purpose (a pack declares
 * what it needs pre-baked, but putting a new package inside the jail is a code
 * change with a review), and after the storage swap `content.service.ts` may
 * not touch `fs` at all.
 */
export function readRunnerFile(runnerDir: string, name: string): string | null {
  const at = path.join(runnerDir, name);
  return fs.existsSync(at) ? fs.readFileSync(at, 'utf-8') : null;
}
