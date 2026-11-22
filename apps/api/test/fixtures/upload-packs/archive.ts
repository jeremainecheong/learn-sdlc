import * as fs from 'fs';
import * as path from 'path';
import { deflateRawSync } from 'zlib';

/**
 * In-memory zip archives for the upload fixtures.
 *
 * A small, deliberately literal writer: one local header per entry, the data,
 * a central directory and the end record, every field written by hand so a
 * hostile archive (see `hostile.ts`) can set exactly the field it attacks (a flag, a
 * CRC, a declared size, an external attribute) and nothing else. No archive
 * is written to disk, and no large file is committed: the bombs are generated
 * here, in memory, when a test asks for one.
 *
 * `listArchive` is the matching reader for the fixtures' own specs. It trusts
 * the central directory and is NOT the product's reader (UP's
 * `content/zip-reader.ts` is, and it trusts nothing).
 */

/** One file of a pack directory: its archive name (posix, pack-relative) and bytes. */
export interface PackFile {
  name: string;
  data: Buffer;
}

/** What `writeZip` writes for one entry. Every override is one attack. */
export interface ZipEntrySpec {
  /** The name exactly as written into both headers, NUL and all. */
  name: string;
  /** The bytes the entry holds before compression. */
  data: Buffer;
  /** 8 (deflate, the default) or 0 (stored). */
  method?: 0 | 8;
  /** General-purpose bit flags. Bit 0 says "encrypted". */
  flags?: number;
  /** A CRC-32 to declare instead of the real one. */
  crc32?: number;
  /** An uncompressed size to declare instead of the real one. */
  declaredUncompressedSize?: number;
  /** Central-directory external attributes (a symlink is 0xA000 in the high half). */
  externalAttributes?: number;
  /** Central-directory "version made by" (host in the high byte: 3 is Unix). */
  versionMadeBy?: number;
}

/** One entry as `listArchive` reads it back. */
export interface ArchiveRecord {
  name: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  externalAttributes: number;
  versionMadeBy: number;
  /** The entry's bytes as stored (compressed when `method` is 8). */
  rawData: Buffer;
}

const SKIPPED_DIRS = new Set(['__pycache__', 'node_modules']);
const SKIPPED_FILES = new Set(['.DS_Store']);

/** Byte order, not locale order: the archive must not depend on the machine. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every file under `dir`, as pack-relative posix names, sorted, with their bytes. */
export function packFilesOf(dir: string): PackFile[] {
  const out: PackFile[] = [];
  const visit = (rel: string): void => {
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) visit(child);
      } else if (!SKIPPED_FILES.has(entry.name) && !entry.name.endsWith('.pyc')) {
        out.push({ name: child, data: fs.readFileSync(path.join(dir, child)) });
      }
    }
  };
  visit('');
  return out.sort((a, b) => byName(a.name, b.name));
}

let CRC_TABLE: Uint32Array | null = null;

/** CRC-32 (IEEE), the checksum both zip headers carry. */
export function crc32Of(data: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A fixed timestamp (1980-01-01 00:00), so the same entries are the same bytes. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/** Write a zip archive, in memory, exactly as the entries say. */
export function writeZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const stored = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = entry.crc32 ?? crc32Of(entry.data);
    const size = entry.declaredUncompressedSize ?? entry.data.length;
    const flags = entry.flags ?? 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMadeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.externalAttributes ?? 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

/** A pack directory's files as entries, in the order `packFilesOf` gives them. */
export function entriesOf(dir: string): ZipEntrySpec[] {
  return packFilesOf(dir).map((file) => ({ name: file.name, data: file.data }));
}

/** The Shelf pack (or any pack directory) as a clean archive: pack root at the archive root. */
export function zipDirectory(dir: string): Buffer {
  return writeZip(entriesOf(dir));
}

/** Read an archive back through its central directory (fixture specs only). */
export function listArchive(buf: Buffer): ArchiveRecord[] {
  let end = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: ArchiveRecord[] = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`central entry ${n} has no signature`);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const compressedSize = buf.readUInt32LE(at + 20);
    const localAt = buf.readUInt32LE(at + 42);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    out.push({
      name: buf.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      flags: buf.readUInt16LE(at + 8),
      method: buf.readUInt16LE(at + 10),
      crc32: buf.readUInt32LE(at + 16),
      compressedSize,
      uncompressedSize: buf.readUInt32LE(at + 24),
      externalAttributes: buf.readUInt32LE(at + 38),
      versionMadeBy: buf.readUInt16LE(at + 4),
      rawData: buf.subarray(dataAt, dataAt + compressedSize),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
