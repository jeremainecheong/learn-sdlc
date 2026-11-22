import * as zlib from 'zlib';
import { PROJECT_UPLOAD_LIMITS } from '@learnsdlc/shared';

/**
 * The reader a teacher's project archive meets
 * before anything else in the API looks at it.
 *
 * The archive arrives from a person, so it is read as hostile: in memory only
 * (no disk write), on Node's own `zlib` (no dependency), stored and deflate
 * only, and with every size it declares checked against the platform's cap
 * **before** a byte is allocated for it. The order is the point:
 *
 * 1. the archive's own length against the cap;
 * 2. the end record, its entry count against the entry cap, and the central
 *    directory inside the archive;
 * 3. every central entry (encryption, method, name, type, declared sizes,
 *    the per-entry ratio, the running uncompressed total) before any entry
 *    is inflated, so a bomb is refused from its headers;
 * 4. each local header against its central entry, the data inside the
 *    archive and before the directory, no two entries sharing bytes;
 * 5. only then inflate, with `maxOutputLength` set to the size the entry
 *    declared (which step 3 already held under the cap), and the CRC.
 *
 * A refusal is an `UploadRefusal`: a stable code and one fixed sentence. The
 * sentence never carries a byte of the archive (not an entry name, not a
 * size it declared), because the archive's author chose those bytes and a
 * refusal is shown back to people.
 */

/* ------------------------------- the refusals ------------------------------ */

/**
 * The reader's own refusal codes, finer than the shared contract's: each is
 * filed under one of the shared contract's `UPLOAD_REFUSAL_CODES` at the HTTP door
 * (`uploadCodeOf` in `authoring/upload.service.ts`), whose fixed sentence is
 * what a teacher reads. The sentences here are the reader's own, for logs and
 * specs, and are held to the same rule: no byte of the archive.
 */
export const ARCHIVE_REFUSAL_CODES = [
  'ARCHIVE_TOO_LARGE',
  'ARCHIVE_NOT_BASE64',
  'ARCHIVE_MALFORMED',
  'ARCHIVE_EMPTY',
  'ARCHIVE_ENCRYPTED',
  'ARCHIVE_METHOD',
  'ARCHIVE_ZIP64',
  'ARCHIVE_DESCRIPTOR_MISMATCH',
  'ARCHIVE_CRC_MISMATCH',
  'ARCHIVE_SIZE_MISMATCH',
  'ARCHIVE_PATH_ESCAPE',
  'ARCHIVE_SYMLINK',
  'ARCHIVE_DUPLICATE_NAME',
  'ARCHIVE_CASE_COLLISION',
  'ARCHIVE_NAME_NUL',
  'ARCHIVE_RATIO',
  'ARCHIVE_TOTAL_TOO_LARGE',
  'ARCHIVE_TOO_MANY_ENTRIES',
  'ARCHIVE_NAME_TOO_LONG',
] as const;

export type ArchiveRefusalCode = (typeof ARCHIVE_REFUSAL_CODES)[number];

/** Megabytes as a sentence says them; the cap is the platform's, never the archive's. */
function mb(bytes: number): string {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

/** One fixed sentence per code. Only the platform's own limits are interpolated. */
export function archiveRefusalSentence(code: ArchiveRefusalCode, limits: ZipLimits): string {
  switch (code) {
    case 'ARCHIVE_TOO_LARGE':
      return `The archive is larger than the ${mb(limits.maxBytes)} an upload accepts. Leave out build output, dependencies and data files, and upload again.`;
    case 'ARCHIVE_NOT_BASE64':
      return 'The upload did not carry a base64-encoded archive. Choose the .zip file again and upload it.';
    case 'ARCHIVE_MALFORMED':
      return 'The file is not a .zip archive this platform can read safely. Create the .zip again with your system archiver and upload it.';
    case 'ARCHIVE_EMPTY':
      return 'The archive holds no files. Zip the project folder itself, with project.json inside it.';
    case 'ARCHIVE_ENCRYPTED':
      return 'The archive is password-protected. Create it again without a password and upload it.';
    case 'ARCHIVE_METHOD':
      return 'The archive uses a compression method other than stored or deflate. Create it again with your system archiver and upload it.';
    case 'ARCHIVE_ZIP64':
      // The words of the shared ZIP64_OR_SIZE_MISMATCH sentence; the code stays ARCHIVE_ZIP64.
      return `The archive declares a large-archive (ZIP64) size or position beyond the upload limit of ${mb(limits.maxBytes)}. Leave out large files and upload again.`;
    case 'ARCHIVE_DESCRIPTOR_MISMATCH':
      return 'The archive describes one of its files with two different sizes. Create the .zip again and upload it.';
    case 'ARCHIVE_CRC_MISMATCH':
      return 'A file in the archive does not match its own checksum, so the archive is damaged. Create the .zip again and upload it.';
    case 'ARCHIVE_SIZE_MISMATCH':
      return 'A file in the archive unpacks to a different size than the archive declares. Create the .zip again and upload it.';
    case 'ARCHIVE_PATH_ESCAPE':
      return 'The archive holds a path that leaves the project folder (an absolute path, a drive letter, a backslash or a .. step). Zip the project folder itself and upload again.';
    case 'ARCHIVE_SYMLINK':
      return 'The archive holds a link or a special file. Only ordinary files and folders can be uploaded; replace links with the files they point to.';
    case 'ARCHIVE_DUPLICATE_NAME':
      return 'The archive holds two entries at the same path, or a file where a folder is. Every path in a project must be unique.';
    case 'ARCHIVE_CASE_COLLISION':
      return 'The archive holds two paths that differ only in upper and lower case. Rename one so every path is unique ignoring case.';
    case 'ARCHIVE_NAME_NUL':
      return 'The archive holds a file name with a control character in it. Rename the file and upload again.';
    case 'ARCHIVE_RATIO':
      return `A file in the archive unpacks to more than ${limits.maxRatio} times its packed size, which this platform refuses. Leave out generated or padded files and upload again.`;
    case 'ARCHIVE_TOTAL_TOO_LARGE':
      return `The archive unpacks to more than the ${mb(limits.maxBytes)} an upload accepts. Leave out build output, dependencies and data files, and upload again.`;
    case 'ARCHIVE_TOO_MANY_ENTRIES':
      return `The archive holds more than ${limits.maxEntries.toLocaleString('en-US')} entries. Leave out dependencies and build output, and upload again.`;
    case 'ARCHIVE_NAME_TOO_LONG':
      return `The archive holds a path longer than ${limits.maxNameBytes.toLocaleString('en-US')} bytes or with more than ${limits.maxNameSegments} parts (folders and the file name). Shorten it and upload again.`;
  }
}

/**
 * A refusal of an upload: a stable code, the one sentence a person reads, and
 * optionally where in the pack (never set by the zip layer).
 */
export class UploadRefusal extends Error {
  constructor(
    readonly code: string,
    readonly sentence: string,
    readonly where?: string,
  ) {
    super(sentence);
    this.name = 'UploadRefusal';
  }
}

/* --------------------------------- limits --------------------------------- */

export interface ZipLimits {
  /** The cap on the archive's own size and, separately, on everything it unpacks to. */
  maxBytes: number;
  maxEntries: number;
  /** Uncompressed : compressed, per entry. */
  maxRatio: number;
  /**
   * Entries at or under this many uncompressed bytes are not ratio-checked: a
   * kilobyte cannot be a bomb, and a short file of repeated characters (an
   * indented JSON stub) legitimately packs past 100:1. The total cap still
   * counts them.
   */
  ratioFloorBytes: number;
  /**
   * The longest entry name, in bytes, and the most `/`-separated segments one
   * may have. Checked on the raw name before any per-segment work, so the
   * folder checks below stay linear (a zip allows a 65,535-byte name).
   */
  maxNameBytes: number;
  maxNameSegments: number;
}

/** The caps: importMaxBytes compressed and uncompressed, 2,000 entries, 100:1 per entry. */
export function zipLimits(maxBytes: number): ZipLimits {
  return {
    maxBytes,
    maxEntries: PROJECT_UPLOAD_LIMITS.maxEntries,
    maxRatio: PROJECT_UPLOAD_LIMITS.maxRatio,
    ratioFloorBytes: 1024,
    maxNameBytes: 1024,
    maxNameSegments: 64,
  };
}

export interface ArchiveEntry {
  /** The entry's path, `/`-separated, relative, as the archive names it. */
  name: string;
  bytes: Buffer;
}

export interface ZipReadOptions {
  /**
   * The inflater, for a spec that wants to see every output buffer the reader
   * asks for. Defaults to `zlib.inflateRawSync` with `maxOutputLength`.
   */
  inflate?: (data: Buffer, maxOutputLength: number) => Buffer;
}

/* ---------------------------------- crc32 --------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* --------------------------------- the read -------------------------------- */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const SIG_DESCRIPTOR = 0x08074b50;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_CENTRAL_ENCRYPTED = 0x2000;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const METHOD_AES = 99;

/** Hosts whose external attributes carry a unix mode in the high 16 bits. */
const UNIX_HOSTS = new Set([3, 19]);
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

interface CentralEntry {
  name: string;
  isDirectory: boolean;
  flags: number;
  method: number;
  crc: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
  zip64: boolean;
}

export function readZip(archive: Buffer, limits: ZipLimits, options: ZipReadOptions = {}): ArchiveEntry[] {
  const refuse = (code: ArchiveRefusalCode): never => {
    throw new UploadRefusal(code, archiveRefusalSentence(code, limits));
  };
  const inflate =
    options.inflate ?? ((data: Buffer, maxOutputLength: number) => zlib.inflateRawSync(data, { maxOutputLength }));

  if (!Buffer.isBuffer(archive)) refuse('ARCHIVE_MALFORMED');
  if (archive.length > limits.maxBytes) refuse('ARCHIVE_TOO_LARGE');
  if (archive.length < 22) refuse('ARCHIVE_MALFORMED');

  /* ---- 1. the end record: exactly one, and it must end the archive ---- */
  const searchFrom = Math.max(0, archive.length - (22 + 0xffff));
  let end = -1;
  for (let at = archive.length - 22; at >= searchFrom; at -= 1) {
    if (archive.readUInt32LE(at) === SIG_END && at + 22 + archive.readUInt16LE(at + 20) === archive.length) {
      end = at;
      break;
    }
  }
  if (end < 0) refuse('ARCHIVE_MALFORMED');

  const disk = archive.readUInt16LE(end + 4);
  const dirDisk = archive.readUInt16LE(end + 6);
  let countOnDisk = archive.readUInt16LE(end + 8);
  let count = archive.readUInt16LE(end + 10);
  let dirSize = archive.readUInt32LE(end + 12);
  let dirOffset = archive.readUInt32LE(end + 16);
  let dirEnd = end;

  const needs64 =
    countOnDisk === 0xffff || count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff;
  if (needs64) {
    // The zip64 locator sits immediately before the end record and points at
    // the zip64 end record. Every value it carries is checked against the
    // archive itself before it is believed.
    const locator = end - 20;
    if (locator < 0 || archive.readUInt32LE(locator) !== SIG_LOCATOR64) refuse('ARCHIVE_MALFORMED');
    const at64 = readU64(archive, locator + 8, limits, refuse);
    if (archive.readUInt32LE(locator + 4) !== 0 || archive.readUInt32LE(locator + 16) > 1) refuse('ARCHIVE_MALFORMED');
    if (at64 + 56 > locator || archive.readUInt32LE(at64) !== SIG_END64) refuse('ARCHIVE_MALFORMED');
    if (archive.readUInt32LE(at64 + 16) !== 0 || archive.readUInt32LE(at64 + 20) !== 0) refuse('ARCHIVE_MALFORMED');
    countOnDisk = readU64(archive, at64 + 24, limits, refuse, 'ARCHIVE_TOO_MANY_ENTRIES');
    count = readU64(archive, at64 + 32, limits, refuse, 'ARCHIVE_TOO_MANY_ENTRIES');
    dirSize = readU64(archive, at64 + 40, limits, refuse);
    dirOffset = readU64(archive, at64 + 48, limits, refuse);
    dirEnd = at64;
  } else if (disk !== 0 || dirDisk !== 0) {
    refuse('ARCHIVE_MALFORMED');
  }
  if (countOnDisk !== count) refuse('ARCHIVE_MALFORMED');
  if (count > limits.maxEntries) refuse('ARCHIVE_TOO_MANY_ENTRIES');
  if (count === 0) refuse('ARCHIVE_EMPTY');
  if (dirOffset + dirSize !== dirEnd || dirOffset > archive.length) refuse('ARCHIVE_MALFORMED');
  // Each central header is at least 46 bytes, so a directory too small for the
  // count it declares is refused before the walk trusts the count.
  if (dirSize < count * 46) refuse('ARCHIVE_MALFORMED');

  /* ---- 2. the central directory: every entry checked before any is read ---- */
  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  const folded = new Set<string>();
  const filePaths = new Set<string>();
  let total = 0;
  let at = dirOffset;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > dirEnd || archive.readUInt32LE(at) !== SIG_CENTRAL) refuse('ARCHIVE_MALFORMED');
    const madeBy = archive.readUInt16LE(at + 4);
    const flags = archive.readUInt16LE(at + 8);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    let compSize = archive.readUInt32LE(at + 20);
    let uncompSize = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const diskStart = archive.readUInt16LE(at + 34);
    const external = archive.readUInt32LE(at + 38);
    let localOffset = archive.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > dirEnd) refuse('ARCHIVE_MALFORMED');
    const rawName = archive.subarray(at + 46, at + 46 + nameLength);

    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_CENTRAL_ENCRYPTED) || method === METHOD_AES) {
      refuse('ARCHIVE_ENCRYPTED');
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) refuse('ARCHIVE_METHOD');

    // zip64: the 0xFFFFFFFF sentinels are replaced from the extended-information
    // extra field, in the spec's fixed order, and each value is held to the cap.
    let zip64 = false;
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff || diskStart === 0xffff) {
      zip64 = true;
      const extra = findExtra(archive, at + 46 + nameLength, extraLength, 0x0001);
      if (!extra) refuse('ARCHIVE_MALFORMED');
      let cursor = extra!.start;
      const take = (): number => {
        if (cursor + 8 > extra!.end) refuse('ARCHIVE_MALFORMED');
        const value = readU64(archive, cursor, limits, refuse, 'ARCHIVE_ZIP64');
        cursor += 8;
        return value;
      };
      if (uncompSize === 0xffffffff) uncompSize = take();
      if (compSize === 0xffffffff) compSize = take();
      if (localOffset === 0xffffffff) localOffset = take();
      if (diskStart === 0xffff) refuse('ARCHIVE_MALFORMED');
    } else if (diskStart !== 0) {
      refuse('ARCHIVE_MALFORMED');
    }

    /* the name: its length first, so nothing below is ever more than linear in it */
    if (nameLength > limits.maxNameBytes) refuse('ARCHIVE_NAME_TOO_LONG');
    if (rawName.includes(0)) refuse('ARCHIVE_NAME_NUL');
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    } catch {
      return refuse('ARCHIVE_MALFORMED');
    }
    if (/[\u0000-\u001f\u007f]/.test(name)) refuse('ARCHIVE_NAME_NUL');
    const isDirectory = name.endsWith('/');
    const clean = isDirectory ? name.slice(0, -1) : name;
    let segments = 1;
    for (let i = 0; i < clean.length; i += 1) if (clean.charCodeAt(i) === 0x2f) segments += 1;
    if (segments > limits.maxNameSegments) refuse('ARCHIVE_NAME_TOO_LONG');
    if (!safeRelativePath(clean)) refuse('ARCHIVE_PATH_ESCAPE');

    /* the type: a unix mode that is neither a file nor a folder is refused */
    if (UNIX_HOSTS.has(madeBy >>> 8)) {
      const type = (external >>> 16) & S_IFMT;
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) refuse('ARCHIVE_SYMLINK');
      if (type === S_IFDIR && !isDirectory) refuse('ARCHIVE_SYMLINK');
    }

    /* uniqueness: exact, then ignoring case and Unicode composition */
    if (seen.has(clean)) refuse('ARCHIVE_DUPLICATE_NAME');
    seen.add(clean);
    const fold = clean.normalize('NFC').toLowerCase();
    if (folded.has(fold)) refuse('ARCHIVE_CASE_COLLISION');
    folded.add(fold);
    if (!isDirectory) filePaths.add(fold);

    /* sizes, before any byte is allocated */
    if (isDirectory) {
      if (uncompSize !== 0) refuse('ARCHIVE_MALFORMED');
    } else {
      if (compSize > limits.maxBytes) refuse(zip64 ? 'ARCHIVE_ZIP64' : 'ARCHIVE_TOO_LARGE');
      if (uncompSize > limits.maxBytes) refuse(zip64 ? 'ARCHIVE_ZIP64' : 'ARCHIVE_TOTAL_TOO_LARGE');
      if (method === METHOD_STORED && compSize !== uncompSize) refuse('ARCHIVE_SIZE_MISMATCH');
      if (uncompSize > limits.ratioFloorBytes && uncompSize > compSize * limits.maxRatio) refuse('ARCHIVE_RATIO');
      total += uncompSize;
      if (total > limits.maxBytes) refuse('ARCHIVE_TOTAL_TOO_LARGE');
    }
    entries.push({ name: clean, isDirectory, flags, method, crc, compSize, uncompSize, localOffset, zip64 });
    at = next;
  }
  if (at !== dirEnd) refuse('ARCHIVE_MALFORMED');

  // Every folder every path passes through, built one segment at a time (each
  // name is at most maxNameSegments segments and maxNameBytes long, so this is
  // bounded and linear in the directory): a file where a folder is (`a` as a
  // file and `a/b` as anything), and two spellings of one folder that differ
  // only in case (`A/x` and `a/y` merge on a case-insensitive disk).
  const folderSpelling = new Map<string, string>();
  for (const entry of entries) {
    const parts = entry.name.split('/');
    const folders = entry.isDirectory ? parts.length : parts.length - 1;
    let exact = '';
    let fold = '';
    for (let depth = 0; depth < folders; depth += 1) {
      const part = parts[depth];
      exact = depth === 0 ? part : `${exact}/${part}`;
      const foldedPart = part.normalize('NFC').toLowerCase();
      fold = depth === 0 ? foldedPart : `${fold}/${foldedPart}`;
      if (filePaths.has(fold)) refuse('ARCHIVE_DUPLICATE_NAME');
      const spelled = folderSpelling.get(fold);
      if (spelled === undefined) folderSpelling.set(fold, exact);
      else if (spelled !== exact) refuse('ARCHIVE_CASE_COLLISION');
    }
  }

  /* ---- 3. local headers and data ranges, still before inflating ---- */
  const ranges: { start: number; end: number; entry: CentralEntry }[] = [];
  for (const entry of entries) {
    const local = entry.localOffset;
    if (local + 30 > dirOffset || archive.readUInt32LE(local) !== SIG_LOCAL) refuse('ARCHIVE_MALFORMED');
    const localFlags = archive.readUInt16LE(local + 6);
    const localMethod = archive.readUInt16LE(local + 8);
    const localCrc = archive.readUInt32LE(local + 14);
    const localComp = archive.readUInt32LE(local + 18);
    const localUncomp = archive.readUInt32LE(local + 22);
    const localNameLength = archive.readUInt16LE(local + 26);
    const localExtraLength = archive.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (dataStart > dirOffset) refuse('ARCHIVE_MALFORMED');
    const localName = archive.subarray(local + 30, local + 30 + localNameLength);
    const centralName = Buffer.from(entry.isDirectory ? `${entry.name}/` : entry.name, 'utf8');
    if (!localName.equals(centralName)) refuse('ARCHIVE_MALFORMED');
    if (localMethod !== entry.method) refuse('ARCHIVE_MALFORMED');
    if ((localFlags & FLAG_ENCRYPTED) !== 0) refuse('ARCHIVE_ENCRYPTED');
    if ((localFlags & FLAG_DESCRIPTOR) !== (entry.flags & FLAG_DESCRIPTOR)) refuse('ARCHIVE_MALFORMED');

    const dataEnd = dataStart + entry.compSize;
    if (dataEnd > dirOffset) refuse('ARCHIVE_MALFORMED');
    let recordEnd = dataEnd;

    if (entry.flags & FLAG_DESCRIPTOR) {
      // The sizes follow the data. Optional signature; 32-bit sizes, or 64-bit
      // for a zip64 entry. They must say exactly what the directory says.
      let cursor = dataEnd;
      if (cursor + 4 <= dirOffset && archive.readUInt32LE(cursor) === SIG_DESCRIPTOR) cursor += 4;
      const width = entry.zip64 ? 8 : 4;
      if (cursor + 4 + width * 2 > dirOffset) refuse('ARCHIVE_DESCRIPTOR_MISMATCH');
      const dCrc = archive.readUInt32LE(cursor);
      const dComp = width === 8 ? Number(archive.readBigUInt64LE(cursor + 4)) : archive.readUInt32LE(cursor + 4);
      const dUncomp =
        width === 8 ? Number(archive.readBigUInt64LE(cursor + 4 + width)) : archive.readUInt32LE(cursor + 4 + width);
      if (dCrc !== entry.crc || dComp !== entry.compSize || dUncomp !== entry.uncompSize) {
        refuse('ARCHIVE_DESCRIPTOR_MISMATCH');
      }
      recordEnd = cursor + 4 + width * 2;
      // What the local header says, when it says anything, must agree too.
      if ((localCrc !== 0 && localCrc !== entry.crc) || (localComp !== 0 && localComp !== 0xffffffff && localComp !== entry.compSize)) {
        refuse('ARCHIVE_DESCRIPTOR_MISMATCH');
      }
      if (localUncomp !== 0 && localUncomp !== 0xffffffff && localUncomp !== entry.uncompSize) {
        refuse('ARCHIVE_DESCRIPTOR_MISMATCH');
      }
    } else {
      if (localCrc !== entry.crc) refuse('ARCHIVE_DESCRIPTOR_MISMATCH');
      const compOk = localComp === entry.compSize || (entry.zip64 && localComp === 0xffffffff);
      const uncompOk = localUncomp === entry.uncompSize || (entry.zip64 && localUncomp === 0xffffffff);
      if (!compOk || !uncompOk) refuse('ARCHIVE_DESCRIPTOR_MISMATCH');
    }
    ranges.push({ start: local, end: recordEnd, entry });
  }

  // No two entries may share bytes: an overlapping layout is how a small
  // archive declares many large files out of one body.
  const ordered = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end) refuse('ARCHIVE_MALFORMED');
  }

  /* ---- 4. inflate, each output bounded by the size its entry declared ---- */
  const out: ArchiveEntry[] = [];
  for (const { entry, start } of ranges) {
    if (entry.isDirectory) continue;
    const local = start;
    const dataStart = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(dataStart, dataStart + entry.compSize);
    let bytes: Buffer;
    if (entry.method === METHOD_STORED) {
      bytes = Buffer.from(data);
    } else {
      try {
        bytes = inflate(data, Math.max(1, entry.uncompSize));
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        return refuse(code === 'ERR_BUFFER_TOO_LARGE' ? 'ARCHIVE_SIZE_MISMATCH' : 'ARCHIVE_MALFORMED');
      }
    }
    if (bytes.length !== entry.uncompSize) refuse('ARCHIVE_SIZE_MISMATCH');
    if (crc32(bytes) !== entry.crc) refuse('ARCHIVE_CRC_MISMATCH');
    out.push({ name: entry.name, bytes });
  }
  if (out.length === 0) refuse('ARCHIVE_EMPTY');
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/* --------------------------------- helpers -------------------------------- */

/**
 * A relative, `/`-separated path that stays where it is put: no leading `/`,
 * no drive letter, no backslash, no empty, `.` or `..` segment.
 */
export function safeRelativePath(at: string): boolean {
  if (!at || at.startsWith('/') || at.includes('\\') || /^[A-Za-z]:/.test(at)) return false;
  return at.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** An unsigned 64-bit value that must fit under the cap to be believed at all. */
function readU64(
  archive: Buffer,
  at: number,
  limits: ZipLimits,
  refuse: (code: ArchiveRefusalCode) => never,
  code: ArchiveRefusalCode = 'ARCHIVE_MALFORMED',
): number {
  if (at < 0 || at + 8 > archive.length) refuse('ARCHIVE_MALFORMED');
  const value = archive.readBigUInt64LE(at);
  if (value > BigInt(Math.max(limits.maxBytes, limits.maxEntries))) refuse(code);
  return Number(value);
}

/** The body of one extra field, by header id, inside an entry's extra block. */
function findExtra(archive: Buffer, start: number, length: number, id: number): { start: number; end: number } | null {
  let at = start;
  const end = start + length;
  while (at + 4 <= end) {
    const header = archive.readUInt16LE(at);
    const size = archive.readUInt16LE(at + 2);
    if (at + 4 + size > end) return null;
    if (header === id) return { start: at + 4, end: at + 4 + size };
    at += 4 + size;
  }
  return null;
}
