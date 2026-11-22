// A content pack directory as a zip archive, in memory, for the upload door
// (POST /instructor/projects/upload takes the archive as base64).
//
// The same plain writer as the upload fixtures' (apps/api/test/fixtures/
// upload-packs/archive.ts, which is TypeScript and test-only): one deflated
// entry per file, names in byte order, a fixed 1980 timestamp, so the same
// directory is always the same bytes. It skips what a pack never ships:
// __pycache__, node_modules, .DS_Store and *.pyc.
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const SKIPPED_DIRS = new Set(['__pycache__', 'node_modules']);
const SKIPPED_FILES = new Set(['.DS_Store']);
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Every file under `dir`, as pack-relative posix names with their bytes, sorted. */
export function packFiles(dir) {
  const out = [];
  const visit = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
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

let TABLE = null;
export function crc32(data) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The files as one zip archive. */
export function zipFiles(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const stored = deflateRawSync(file.data);
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A pack directory as an archive with the pack root at the archive root. */
export function zipPackDirectory(dir) {
  return zipFiles(packFiles(dir));
}
