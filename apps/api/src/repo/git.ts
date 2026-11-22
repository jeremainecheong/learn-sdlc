import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/**
 * A git object writer, in Node's own built-ins.
 *
 * `isomorphic-git` is deliberately not a dependency: it pulls
 * a browser-first dependency tree into an API that has no zip, no compression
 * and no git library, and every byte it would write is fifty lines of
 * `node:zlib`. A loose-object repository needs exactly two things Node already
 * ships (sha1 and deflate) and real `git` reads what comes out.
 *
 * Everything here is pure. Nothing touches Nest, TypeORM or the file system,
 * which is what lets `git.spec.ts` check the object ids against the ones git
 * itself is known to write.
 */

/** The one branch an exported repository has, matching REPO_BRANCH in shared. */
export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

/** Who wrote it, as git records a person. */
export interface GitIdentity {
  name: string;
  email: string;
  /** Seconds since the epoch. Git stores a second, not a millisecond. */
  when: number;
}

/** One object, ready to be written into `.git/objects`. */
export interface GitObject {
  id: string;
  type: GitObjectType;
  /** The zlib stream that goes in the file, header included. */
  deflated: Buffer;
}

/** One entry of a tree: a file, or a subtree. */
export interface TreeEntry {
  name: string;
  /** '100644' for a file, '40000' for a subtree. Nothing here is executable. */
  mode: '100644' | '40000';
  id: string;
}

const HEX = (id: string): Buffer => Buffer.from(id, 'hex');

/** `blob 6\0hello\n` is what the id is taken over: header, then payload. */
export function objectId(type: GitObjectType, payload: Buffer): string {
  return createHash('sha1')
    .update(Buffer.from(`${type} ${payload.length}\0`, 'latin1'))
    .update(payload)
    .digest('hex');
}

/**
 * The bytes of the file at `.git/objects/ab/cdef...`.
 *
 * Level 1 on purpose: the archive is a few hundred kilobytes of small text
 * files and the export runs on the laptop that is also the class database, so
 * the last few percent of compression is not worth the milliseconds.
 */
export function looseObject(type: GitObjectType, payload: Buffer): GitObject {
  const header = Buffer.from(`${type} ${payload.length}\0`, 'latin1');
  return {
    id: objectId(type, payload),
    type,
    deflated: deflateSync(Buffer.concat([header, payload]), { level: 1 }),
  };
}

/** `.git/objects/ce/013625030ba8dba906f756967f9e9ca394464a`. */
export function looseObjectPath(id: string): string {
  return `.git/objects/${id.slice(0, 2)}/${id.slice(2)}`;
}

export function blob(content: Buffer): GitObject {
  return looseObject('blob', content);
}

/**
 * Git compares tree entry names with a `/` appended for a subtree, so `a.txt`
 * sorts after a tree called `a` even though the plain strings say otherwise.
 * Getting this wrong produces an archive that unzips, that `git log` reads and
 * that `git fsck` rejects, which is the worst kind of wrong, so it is its own
 * exported function with its own test.
 */
export function gitTreeSort(entries: TreeEntry[]): TreeEntry[] {
  const key = (entry: TreeEntry): Buffer =>
    Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
  return [...entries].sort((a, b) => Buffer.compare(key(a), key(b)));
}

export function tree(entries: TreeEntry[]): GitObject {
  const parts: Buffer[] = [];
  for (const entry of gitTreeSort(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), HEX(entry.id));
  }
  return looseObject('tree', Buffer.concat(parts));
}

/**
 * A person, as one line. Angle brackets and newlines would end the header
 * early and produce an object git refuses, and a display name is whatever the
 * learner typed, so both are stripped rather than trusted.
 */
export function signature(who: GitIdentity): string {
  const clean = (value: string): string => value.replace(/[<>\n\r]/g, ' ').trim();
  const name = clean(who.name) || 'A learner';
  const email = clean(who.email).replace(/\s+/g, '') || 'learner@learnsdlc.local';
  return `${name} <${email}> ${Math.floor(who.when)} +0000`;
}

/** The message as git stores it: no trailing blank lines, one final newline. */
export function messageBody(message: string): string {
  return `${message.replace(/\r\n/g, '\n').replace(/\s+$/, '')}\n`;
}

export function commit(input: {
  tree: string;
  parents: string[];
  author: GitIdentity;
  committer?: GitIdentity;
  message: string;
}): GitObject {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${signature(input.author)}`);
  lines.push(`committer ${signature(input.committer ?? input.author)}`);
  const payload = `${lines.join('\n')}\n\n${messageBody(input.message)}`;
  return looseObject('commit', Buffer.from(payload, 'utf8'));
}

/** An annotated tag, so `git tag -n` prints the learner's own merge message. */
export function tag(input: {
  object: string;
  name: string;
  tagger: GitIdentity;
  message: string;
}): GitObject {
  const payload =
    `object ${input.object}\ntype commit\ntag ${input.name}\n` +
    `tagger ${signature(input.tagger)}\n\n${messageBody(input.message)}`;
  return looseObject('tag', Buffer.from(payload, 'utf8'));
}

/** One row of `.git/index`: a path, the blob it points at, and its real size. */
export interface IndexEntry {
  path: string;
  id: string;
  size: number;
}

/**
 * `.git/index`, version 2, so the first `git status` in the unzipped folder is
 * clean rather than "everything is untracked".
 *
 * Times, device and inode are zeroed. Git then re-hashes the working tree on
 * the first status (instant for a few dozen small text files) and reports
 * nothing to commit, which is the truth.
 */
export function indexFile(entries: IndexEntry[]): Buffer {
  const rows = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')),
  );
  const header = Buffer.alloc(12);
  header.write('DIRC', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(rows.length, 8);

  const parts: Buffer[] = [header];
  for (const row of rows) {
    const name = Buffer.from(row.path, 'utf8');
    // 62 fixed bytes, then the path, then at least one NUL, padded to eight.
    const length = Math.ceil((62 + name.length + 1) / 8) * 8;
    const entry = Buffer.alloc(length);
    entry.writeUInt32BE(0o100644, 24); // mode; ctime, mtime, dev and ino stay zero
    entry.writeUInt32BE(Math.min(row.size, 0xffffffff), 36);
    HEX(row.id).copy(entry, 40);
    entry.writeUInt16BE(Math.min(name.length, 0x0fff), 60);
    name.copy(entry, 62);
    parts.push(entry);
  }

  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * A flat `path -> blob id` map as the tree objects git wants, deepest first.
 * Returns every tree it made and the id of the root, so a caller writes the
 * objects and points a commit at the root.
 */
export function treesFor(files: Map<string, string>): { root: string; objects: GitObject[] } {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, id] of files) {
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node.dirs.get(segment);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1], id);
  }

  const objects: GitObject[] = [];
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, id] of node.files) entries.push({ name, mode: '100644', id });
    for (const [name, child] of node.dirs) entries.push({ name, mode: '40000', id: write(child) });
    const object = tree(entries);
    objects.push(object);
    return object.id;
  };
  return { root: write(root), objects };
}
