import { compareMountPaths, DESKTOP_FOLDER, EDITOR_FOLDERS, isDesktopFile, isMachineOutputFile, MACHINE_OUTPUT_FOLDERS } from '@learnsdlc/shared';
import { isSourceFile, LayoutWalkRefusal, type PackDirent, type PackSource } from './pack-source';
import { UploadRefusal, type ArchiveEntry } from './zip-reader';

/**
 * A pack held in memory, the entries of a
 * teacher's uploaded archive, behind the same `PackSource` the importer
 * reads `content/tasktrackr` through.
 *
 * **The path arithmetic is the directory source's, inside a fence.** A phase
 * reaches shared files by `../../canonical/...`, so a relative path climbs:
 * `resolve` normalises `rel` against the source's own root exactly as
 * `path.resolve` does. What a directory has and an archive does not is a
 * filesystem above its root, and that is the fence: a path that climbs to
 * the archive root is answered, a path that climbs **above** it is not there
 * (`exists` is false) and every read of it is refused. No method of this
 * class touches a disk, so there is nothing above the root to reach: the
 * fence is what makes that true of the *names* too, so a refusal sentence
 * can never print a host path.
 *
 * `location` is a label, `upload:<name>`, never a directory: one place in the
 * loader (the warm-up) still reads `location` as a disk path, which is why an
 * upload refuses a warm-up before the loader runs (`upload-limits.ts`).
 */

/** Directories no walk descends into, as `pack-source.ts`'s walks skip them. */
const SKIPPED_DIRS = new Set(['__pycache__', 'node_modules']);

/** The folder of the layout the phase walks cover; what sits outside it no walk reaches. */
const PHASES_FOLDER = 'phases';

/** The refusal for a path that climbs above the archive root. */
function outside(): UploadRefusal {
  return new UploadRefusal(
    'ARCHIVE_PATH_ESCAPE',
    'The project names a path that leaves the archive (a .. step above the project folder, or an absolute path). Every path must stay inside the project.',
  );
}

/** `rel` normalised against `base` (both `/`-separated, root `''`), or null above the root. */
function normalise(base: string, rel: string): string | null {
  if (rel.startsWith('/') || rel.includes('\\') || /^[A-Za-z]:/.test(rel) || rel.includes('\u0000')) return null;
  const parts = base ? base.split('/') : [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

/** One folder of the tree: its direct children by name (with whether each is a folder), and its sub-folders. */
interface Folder {
  kids: Map<string, boolean>;
  folders: Map<string, Folder>;
}

/** The tree an archive's file list implies: every folder, and the files in each. */
interface Tree {
  files: Map<string, Buffer>;
  /** The pack root's folder; every other folder hangs from it by name. */
  root: Folder;
  /**
   * Every file `read` has returned since the log was last
   * cleared, by pack-relative path. One log per tree, so a `child` reads into
   * its parent's log: the door asks it which files the loader consumed.
   */
  reads: Set<string>;
  /**
   * The desktop entries left out, by pack-relative path (a folder with a
   * trailing `/`): those a layout walk met under `phases/`, and, noted when
   * the tree is built, every one outside `phases/` (a top-level `__MACOSX/`,
   * beside the pack folder or directly inside it, and a `.DS_Store` beside
   * `project.json`), which no walk reaches. One list per tree, so a `child`'s
   * walks record into its parent's: the door reads every walk's from the root.
   */
  leftOut: Set<string>;
}

function folder(): Folder {
  return { kids: new Map(), folders: new Map() };
}

function treeOf(entries: ArchiveEntry[], root: string): Tree {
  const files = new Map<string, Buffer>();
  const top = folder();
  const leftOut = new Set<string>();
  const prefix = root ? `${root}/` : '';
  for (const entry of entries) {
    if (prefix && !entry.name.startsWith(prefix)) {
      // The resource-fork folder macOS archivers write beside the pack folder,
      // which `packRootOf` sets aside: never stored, but named in the warnings.
      if (entry.name.startsWith(`${DESKTOP_FOLDER}/`)) leftOut.add(`${DESKTOP_FOLDER}/`);
      continue;
    }
    const at = entry.name.slice(prefix.length);
    if (!at) continue;
    // Still stored in the tree, so the secret scan and the digest walk read it.
    const desktop = at.startsWith(`${PHASES_FOLDER}/`) ? null : desktopEntryOf(at);
    if (desktop) leftOut.add(desktop);
    files.set(at, entry.bytes);
    // One pass down the path, one folder node per level, each found by its
    // own name in its parent: a level costs its name, never the prefix above
    // it, so the work is linear in the path (a tree keyed by full prefix
    // paths would re-hash the whole prefix at every level).
    const parts = at.split('/');
    let here = top;
    for (let depth = 0; depth < parts.length; depth += 1) {
      const part = parts[depth];
      const isDirectory = depth < parts.length - 1;
      here.kids.set(part, isDirectory || here.kids.get(part) === true);
      if (!isDirectory) break;
      let next = here.folders.get(part);
      if (!next) {
        next = folder();
        here.folders.set(part, next);
      }
      here = next;
    }
  }
  return { files, root: top, reads: new Set(), leftOut };
}

/**
 * The desktop entry a pack-relative file path is, or sits in: the outermost
 * `__MACOSX` folder on it (with a trailing `/`), else the path itself when its
 * last part is a desktop file, else null.
 */
function desktopEntryOf(at: string): string | null {
  const parts = at.split('/');
  const inFolder = parts.slice(0, -1).indexOf(DESKTOP_FOLDER);
  if (inFolder >= 0) return `${parts.slice(0, inFolder + 1).join('/')}/`;
  return isDesktopFile(parts[parts.length - 1]) ? at : null;
}

/** The folder at a normalised path (root `''`), or undefined when there is none. */
function folderAt(tree: Tree, at: string): Folder | undefined {
  if (!at) return tree.root;
  let here: Folder | undefined = tree.root;
  for (const part of at.split('/')) {
    here = here.folders.get(part);
    if (!here) return undefined;
  }
  return here;
}

/**
 * Where the pack starts inside the archive: the archive root when it holds
 * `project.json`, or the one top-level folder every entry sits in when that
 * folder does (zipping a folder writes it that way). Anything else is refused:
 * a pack is found by its `project.json`, never guessed.
 */
export function packRootOf(entries: ArchiveEntry[]): string {
  if (entries.some((entry) => entry.name === 'project.json')) return '';
  const tops = new Set(entries.map((entry) => entry.name.split('/')[0]));
  // macOS archivers add a `__MACOSX/` resource-fork folder beside the real one.
  tops.delete('__MACOSX');
  if (tops.size === 1) {
    const [top] = [...tops];
    if (entries.some((entry) => entry.name === `${top}/project.json`)) return top;
  }
  throw new UploadRefusal(
    'PACK_NO_PROJECT',
    'The archive has no project.json at its top level. Zip the project folder itself, with project.json inside it, and upload again.',
  );
}

export class MemoryPackSource implements PackSource {
  private readonly tree: Tree;

  /**
   * @param entries the archive's files, as `readZip` returns them
   * @param name the pack's name as sentences print it
   * @param root the folder inside the archive the pack starts at (`packRootOf`)
   * @param base this source's own root inside the pack, for `child`
   */
  constructor(
    entries: ArchiveEntry[],
    readonly name: string,
    root = '',
    private readonly base = '',
    tree?: Tree,
  ) {
    this.tree = tree ?? treeOf(entries, root);
  }

  get location(): string {
    return this.base ? `upload:${this.name}/${this.base}` : `upload:${this.name}`;
  }

  available(): boolean {
    return this.isDirectory(this.base);
  }

  exists(rel: string): boolean {
    const at = normalise(this.base, rel);
    if (at === null) return false;
    return this.tree.files.has(at) || this.isDirectory(at);
  }

  read(rel: string): string {
    const at = this.inside(rel);
    const bytes = this.tree.files.get(at);
    if (!bytes) throw new Error(`ENOENT: no such file in the upload: ${this.printed(at)}`);
    this.tree.reads.add(at);
    return bytes.toString('utf-8');
  }

  /**
   * Every file `read` has returned since `forgetReads` (or
   * since the source was made), by pack-relative path, sorted: this source's
   * and every `child`'s reads, which share one log. A walk, `exists` or
   * `entries` reads no file. `read` decodes leniently (a byte that is not
   * UTF-8 becomes U+FFFD), so the upload door asks this log which files the
   * loader consumed and holds each one's raw bytes (`bytesOf`) to the strict
   * text rule before the importer can store them.
   */
  filesRead(): string[] {
    return [...this.tree.reads].sort();
  }

  /** Clears the read log `filesRead` answers from (for this source and every `child`). */
  forgetReads(): void {
    this.tree.reads.clear();
  }

  /** A file's raw bytes by pack-relative path (the pack root's, not this source's own base), or undefined. */
  bytesOf(at: string): Buffer | undefined {
    return this.tree.files.get(at);
  }

  entries(rel = ''): PackDirent[] {
    const at = this.inside(rel);
    const kids = folderAt(this.tree, at)?.kids;
    if (!kids) throw new Error(`ENOENT: no such folder in the upload: ${this.printed(at)}`);
    return [...kids]
      .map(([name, isDirectory]) => ({ name, isDirectory }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  walk(rel = ''): string[] {
    // `walkSourceFiles`: a dot-prefixed or skipped name is left out at every
    // level, and a file must also be a source file.
    return this.walkUnder(this.inside(rel), (name, isDirectory) =>
      !name.startsWith('.') && !SKIPPED_DIRS.has(name) && (isDirectory || isSourceFile(name)),
    );
  }

  walkForDigest(rel = ''): string[] {
    // `walkAllFiles`: only machine output is left out.
    return this.walkUnder(this.inside(rel), (name, isDirectory) =>
      !SKIPPED_DIRS.has(name) && (isDirectory || (!name.endsWith('.pyc') && !name.endsWith('.map'))),
    );
  }

  /**
   * The upload's walk for the folder layout, in code-unit order.
   * A dot-prefixed file or folder is a mount, or a sealed file, at its path.
   * Machine output is refused by name, never skipped in silence: a folder in
   * `MACHINE_OUTPUT_FOLDERS` or a `.pyc` or `.map` file throws the
   * machine-output sentence, an editor's folder its own, each naming the
   * pack-relative path. A desktop file and a `__MACOSX/` folder, at any depth,
   * are left out and recorded once in `leftOut`, never mounted and never a
   * refusal, because the desktop's own archiver adds them to every archive.
   */
  walkLayout(rel = ''): string[] {
    const at = this.inside(rel);
    const packPath = (childRel: string): string => (at ? `${at}/${childRel}` : childRel);
    return this.walkUnder(at, (name, isDirectory, childRel) => {
      if (isDirectory && name === DESKTOP_FOLDER) {
        this.tree.leftOut.add(`${packPath(childRel)}/`);
        return false;
      }
      if (!isDirectory && isDesktopFile(name)) {
        this.tree.leftOut.add(packPath(childRel));
        return false;
      }
      if (isDirectory && MACHINE_OUTPUT_FOLDERS.has(name)) throw new LayoutWalkRefusal(packPath(childRel), false);
      if (isDirectory && EDITOR_FOLDERS.has(name)) throw new LayoutWalkRefusal(packPath(childRel), true);
      if (!isDirectory && isMachineOutputFile(name)) throw new LayoutWalkRefusal(packPath(childRel), false);
      return true;
    }).sort(compareMountPaths);
  }

  /**
   * The desktop entries every layout walk of this upload has left out, by
   * pack-relative path in code-unit order, for the door's warnings:
   * kept on the shared tree, so every `child()` source's walks reach it, and
   * holding from construction every desktop entry outside `phases/`, a
   * top-level `__MACOSX/` among them, beside the pack folder or directly
   * inside it. Entries under `phases/` join as the walks that reach them run.
   */
  leftOut(): readonly string[] {
    return [...this.tree.leftOut].sort(compareMountPaths);
  }

  /**
   * Records a desktop entry a directory listing left out (the folder
   * layout's `listLayout`, `folder-layout.ts`), so the door names it once
   * beside those the walks left out. `at` is relative to this source, a
   * folder with a trailing `/`; it is kept by its pack-relative path.
   */
  noteLeftOut(at: string): void {
    const folder = at.endsWith('/');
    const inside = this.inside(folder ? at.slice(0, -1) : at);
    this.tree.leftOut.add(folder ? `${inside}/` : inside);
  }

  child(rel: string): MemoryPackSource {
    return new MemoryPackSource([], this.name, '', this.inside(rel), this.tree);
  }

  /**
   * `rel` as the sentences that print a resolved path print it: always under
   * `location`'s archive label. A path above the archive root is printed
   * clamped to the root and marked, never as a host path and never with `..`.
   */
  resolve(rel: string): string {
    const at = normalise(this.base, rel);
    if (at === null) return `upload:${this.name}/(outside the archive)`;
    return this.printed(at);
  }

  /* -------------------------------- private -------------------------------- */

  private printed(at: string): string {
    return at ? `upload:${this.name}/${at}` : `upload:${this.name}`;
  }

  private inside(rel: string): string {
    const at = normalise(this.base, rel);
    if (at === null) throw outside();
    return at;
  }

  private isDirectory(at: string): boolean {
    return folderAt(this.tree, at) !== undefined && !this.tree.files.has(at);
  }

  /**
   * Depth first, each level sorted by `localeCompare`, as the directory walks
   * visit. `keep` also gets the entry's path relative to `at`.
   */
  private walkUnder(at: string, keep: (name: string, isDirectory: boolean, rel: string) => boolean): string[] {
    const start = this.isDirectory(at) ? folderAt(this.tree, at) : undefined;
    if (!start) throw new Error(`ENOENT: no such folder in the upload: ${this.printed(at)}`);
    const out: string[] = [];
    const visit = (dir: Folder, rel: string): void => {
      const kids = [...dir.kids].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, isDirectory] of kids) {
        const childRel = rel ? `${rel}/${name}` : name;
        if (!keep(name, isDirectory, childRel)) continue;
        if (isDirectory) visit(dir.folders.get(name) ?? folder(), childRel);
        else out.push(childRel);
      }
    };
    visit(start, '');
    return out;
  }
}
