import * as zlib from 'zlib';
import { UPLOAD_REFUSALS, UPLOAD_REFUSAL_CODES } from '@learnsdlc/shared';
import {
  ARCHIVE_REFUSAL_CODES,
  UploadRefusal,
  readZip,
  zipLimits,
  type ArchiveEntry,
  type ZipLimits,
} from './zip-reader';

/**
 * The in-memory zip reader a teacher's archive
 * meets before anything else in the API reads it.
 *
 * Every archive here is built in-spec with Node `zlib`, byte by byte, because
 * a hostile archive is exactly the one a well-behaved writer will not make.
 * The pack stand-in is a small pack-shaped archive; the hostile set is one
 * archive per attack.
 */

/* ------------------------------ a zip writer ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc(bytes: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Spec {
  name: string | Buffer;
  data?: Buffer | string;
  method?: number;
  flags?: number;
  /** Version made by: high byte is the host (3 = unix). */
  madeBy?: number;
  external?: number;
  /** Overrides of what the headers declare. */
  crc?: number;
  compSize?: number;
  uncompSize?: number;
  localName?: string;
  /** Written after the data when flag bit 3 is set. */
  descriptor?: { crc: number; comp: number; uncomp: number };
  /** Write 0xFFFFFFFF sizes in the central header and a zip64 extra with these. */
  zip64?: { comp: bigint; uncomp: bigint };
  /** Point this central entry's local offset at another entry's local header. */
  sameOffsetAs?: number;
  /** Raw body bytes to store instead of the compressed data. */
  body?: Buffer;
}

function zipOf(specs: Spec[], options: { tail?: Buffer } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  specs.forEach((spec, index) => {
    const name = Buffer.isBuffer(spec.name) ? spec.name : Buffer.from(spec.name, 'utf8');
    const data = Buffer.isBuffer(spec.data) ? spec.data : Buffer.from(spec.data ?? '', 'utf8');
    const method = spec.method ?? 8;
    const body = spec.body ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const sum = spec.crc ?? crc(data);
    const comp = spec.compSize ?? body.length;
    const uncomp = spec.uncompSize ?? data.length;
    const flags = (spec.flags ?? 0) | 0x0800;
    const localName = spec.localName !== undefined ? Buffer.from(spec.localName, 'utf8') : name;
    const descriptorLocal = (flags & 0x08) !== 0;

    const local = Buffer.alloc(30 + localName.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(descriptorLocal ? 0 : sum, 14);
    local.writeUInt32LE(descriptorLocal ? 0 : spec.zip64 ? 0xffffffff : comp, 18);
    local.writeUInt32LE(descriptorLocal ? 0 : spec.zip64 ? 0xffffffff : uncomp, 22);
    local.writeUInt16LE(localName.length, 26);
    localName.copy(local, 30);
    const parts = [local, body];
    if (spec.descriptor) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(spec.descriptor.crc, 4);
      d.writeUInt32LE(spec.descriptor.comp, 8);
      d.writeUInt32LE(spec.descriptor.uncomp, 12);
      parts.push(d);
    }
    const written = Buffer.concat(parts);
    offsets.push(offset);
    const at = spec.sameOffsetAs !== undefined ? offsets[spec.sameOffsetAs] : offset;
    if (spec.sameOffsetAs === undefined) {
      locals.push(written);
      offset += written.length;
    }

    let extra = Buffer.alloc(0);
    if (spec.zip64) {
      extra = Buffer.alloc(4 + 16);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(spec.zip64.uncomp, 4);
      extra.writeBigUInt64LE(spec.zip64.comp, 12);
    }
    const central = Buffer.alloc(46 + name.length + extra.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(spec.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(spec.zip64 ? 0xffffffff : comp, 20);
    central.writeUInt32LE(spec.zip64 ? 0xffffffff : uncomp, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE((spec.external ?? 0) >>> 0, 38);
    central.writeUInt32LE(at, 42);
    name.copy(central, 46);
    extra.copy(central, 46 + name.length);
    centrals.push(central);
    void index;
  });
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(specs.length, 8);
  end.writeUInt16LE(specs.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end, options.tail ?? Buffer.alloc(0)]);
}

/* ------------------------------ the fixtures ------------------------------ */

/** A small pack-shaped archive, built in-spec. */
const SHELF_FILES: Record<string, string> = {
  'project.json': JSON.stringify({ slug: 'shelf', version: '1.0.0', title: 'Shelf', language: 'python' }),
  'canonical/api/main.py': 'from flask import Flask\napp = Flask(__name__)\n\n@app.get("/api/books")\ndef books():\n    return []\n',
  'canonical/web/src/main.tsx': 'export const shelf = (n: number) => `books: ${n}`;\n',
  'phases/03-implementation/phase.json': JSON.stringify({ key: 'implementation', order: 3, artifactKind: 'code' }),
  'phases/03-implementation/hidden_tests/api/test_books.py': 'def test_books():\n    assert True\n',
  'phases/03-implementation/solution/api/books.py': 'def books():\n    return ["Dune", "Emma"]\n',
  'phases/03-implementation/task.md': '# Shelf\n\nList the books on the shelf.\n'.repeat(4),
};

function shelfArchive(): Buffer {
  return zipOf(Object.entries(SHELF_FILES).map(([name, data], i) => ({ name, data, method: i % 2 ? 0 : 8 })));
}

/** Platform cap for the specs; the real one is importMaxBytes (32 MiB). */
const CAP = 256 * 1024;
const LIMITS: ZipLimits = zipLimits(CAP);

/** Deterministic text over four letters: compresses about 4:1, never 100:1. */
function lowEntropy(bytes: number, seed: number): Buffer {
  const out = Buffer.alloc(bytes);
  let s = seed >>> 0;
  for (let i = 0; i < bytes; i += 1) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = 'ACGT'.charCodeAt((s >>> 16) & 3);
  }
  return out;
}

const SYMLINK_MODE = (0o120777 << 16) >>> 0;

/** One archive per attack (the archive-level half of the hostile set), and the code each must meet. */
const HOSTILE_ARCHIVES: Record<string, { archive: () => Buffer; code: string; limits?: ZipLimits }> = {
  'dot-dot path': { archive: () => zipOf([{ name: '../evil.py', data: 'x' }]), code: 'ARCHIVE_PATH_ESCAPE' },
  'nested dot-dot path': {
    archive: () => zipOf([{ name: 'phases/../../evil.py', data: 'x' }]),
    code: 'ARCHIVE_PATH_ESCAPE',
  },
  'absolute path': { archive: () => zipOf([{ name: '/etc/cron.d/evil', data: 'x' }]), code: 'ARCHIVE_PATH_ESCAPE' },
  'drive-letter path': { archive: () => zipOf([{ name: 'C:/evil.py', data: 'x' }]), code: 'ARCHIVE_PATH_ESCAPE' },
  'backslash path': { archive: () => zipOf([{ name: '..\\evil.py', data: 'x' }]), code: 'ARCHIVE_PATH_ESCAPE' },
  'symlink entry': {
    archive: () => zipOf([{ name: 'canonical/shortcut-x9', data: '/etc/passwd', method: 0, madeBy: 0x031e, external: SYMLINK_MODE }]),
    code: 'ARCHIVE_SYMLINK',
  },
  'duplicate names': {
    archive: () => zipOf([{ name: 'a.py', data: 'one' }, { name: 'a.py', data: 'two' }]),
    code: 'ARCHIVE_DUPLICATE_NAME',
  },
  'case-colliding names': {
    archive: () => zipOf([{ name: 'canonical/README.md', data: 'one' }, { name: 'canonical/readme.md', data: 'two' }]),
    code: 'ARCHIVE_CASE_COLLISION',
  },
  'a file where a directory is': {
    archive: () => zipOf([{ name: 'canonical/api', data: 'one' }, { name: 'canonical/api/main.py', data: 'two' }]),
    code: 'ARCHIVE_DUPLICATE_NAME',
  },
  'NUL in a name': {
    archive: () => zipOf([{ name: Buffer.from('ok.py\u0000.txt', 'utf8'), data: 'x' }]),
    code: 'ARCHIVE_NAME_NUL',
  },
  'zip bomb by ratio': {
    archive: () => zipOf([{ name: 'bomb.txt', data: Buffer.alloc(200 * 1024, 0) }]),
    code: 'ARCHIVE_RATIO',
  },
  'zip bomb by total': {
    archive: () =>
      zipOf([0, 1, 2, 3].map((i) => ({ name: `part-${i}.txt`, data: lowEntropy(80 * 1024, i + 1) }))),
    code: 'ARCHIVE_TOTAL_TOO_LARGE',
  },
  'more than 2,000 entries': {
    archive: () => zipOf(Array.from({ length: 2001 }, (_, i) => ({ name: `f/${i}.txt`, data: '', method: 0 }))),
    code: 'ARCHIVE_TOO_MANY_ENTRIES',
  },
  'archive over the cap': {
    archive: () => Buffer.alloc(CAP + 1, 0x50),
    code: 'ARCHIVE_TOO_LARGE',
  },
  encrypted: {
    archive: () => zipOf([{ name: 'secret.py', data: 'x', flags: 0x01 }]),
    code: 'ARCHIVE_ENCRYPTED',
  },
  'AES-encrypted (method 99)': {
    archive: () => zipOf([{ name: 'secret.py', data: 'x', method: 99, body: Buffer.from('xxxx') }]),
    code: 'ARCHIVE_ENCRYPTED',
  },
  'compression method other than stored or deflate': {
    archive: () => zipOf([{ name: 'a.py', data: 'x', method: 12, body: Buffer.from('BZh9') }]),
    code: 'ARCHIVE_METHOD',
  },
  'zip64 sizes beyond the cap': {
    archive: () => zipOf([{ name: 'big.bin', data: 'x', zip64: { comp: 1n << 40n, uncomp: 1n << 41n } }]),
    code: 'ARCHIVE_ZIP64',
  },
  'data descriptor with mismatched sizes': {
    archive: () => {
      const data = Buffer.from('print("hello")\n');
      return zipOf([
        { name: 'a.py', data, flags: 0x08, descriptor: { crc: crc(data), comp: 3, uncomp: 99999 } },
      ]);
    },
    code: 'ARCHIVE_DESCRIPTOR_MISMATCH',
  },
  'CRC mismatch': {
    archive: () => zipOf([{ name: 'a.py', data: 'print(1)\n', crc: 0xdeadbeef }]),
    code: 'ARCHIVE_CRC_MISMATCH',
  },
  'an entry that inflates past its declared size': {
    archive: () => zipOf([{ name: 'a.txt', data: lowEntropy(4096, 7), uncompSize: 100 }]),
    code: 'ARCHIVE_SIZE_MISMATCH',
  },
  'local name differs from the central name': {
    archive: () => zipOf([{ name: 'a.py', localName: 'b.py', data: 'x' }]),
    code: 'ARCHIVE_MALFORMED',
  },
  'two entries share one body': {
    archive: () => zipOf([{ name: 'a.py', data: 'twinbody' }, { name: 'b.py', data: 'twinbody', sameOffsetAs: 0 }]),
    code: 'ARCHIVE_MALFORMED',
  },
  'not a zip at all': { archive: () => Buffer.from('this is plainly not an archive'), code: 'ARCHIVE_MALFORMED' },
  'empty archive': { archive: () => zipOf([]), code: 'ARCHIVE_EMPTY' },
};

/** Every distinguishing string a hostile archive carries; none may reach a sentence. */
const ECHO_PROBES = [
  'evil', 'etc', 'cron', 'passwd', 'secret', 'bomb', 'part-', 'README', 'readme', 'big.bin',
  'a.py', 'b.py', 'ok.py', 'main.py', 'print', 'hello', 'BZh9', 'canonical',
  'ACGT', 'plainly', 'f/', 'C:', 'shortcut-x9', 'twinbody',
];

function refusalOf(run: () => unknown): UploadRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof UploadRefusal) return error;
    throw new Error(`expected an UploadRefusal, got ${(error as Error)?.constructor?.name}: ${String(error)}`);
  }
  throw new Error('expected a refusal, and the archive was read');
}

/* --------------------------------- specs --------------------------------- */

describe('zip-reader', () => {
  it('reads the Shelf stand-in exactly: names, bytes, stored and deflated alike', () => {
    const entries = readZip(shelfArchive(), LIMITS);
    const read = Object.fromEntries(entries.map((e: ArchiveEntry) => [e.name, e.bytes.toString('utf8')]));
    expect(read).toEqual(SHELF_FILES);
  });

  it('treats directory entries as structure, not files', () => {
    const entries = readZip(zipOf([{ name: 'canonical/', data: '', method: 0 }, { name: 'canonical/a.py', data: 'x' }]), LIMITS);
    expect(entries.map((e) => e.name)).toEqual(['canonical/a.py']);
  });

  it('accepts a data descriptor whose sizes agree with the central directory', () => {
    const data = Buffer.from('print("ok")\n');
    const body = zlib.deflateRawSync(data);
    const entries = readZip(
      zipOf([{ name: 'a.py', data, flags: 0x08, descriptor: { crc: crc(data), comp: body.length, uncomp: data.length } }]),
      LIMITS,
    );
    expect(entries[0].bytes.equals(data)).toBe(true);
  });

  it('the default limits are the plan’s: importMaxBytes, 2,000 entries, 100:1', () => {
    const limits = zipLimits(32 * 1024 * 1024);
    expect(limits).toMatchObject({ maxBytes: 32 * 1024 * 1024, maxEntries: 2000, maxRatio: 100 });
  });

  describe('each hostile archive is refused by its sentence', () => {
    for (const [attack, { archive, code, limits }] of Object.entries(HOSTILE_ARCHIVES)) {
      it(attack, () => {
        const refusal = refusalOf(() => readZip(archive(), limits ?? LIMITS));
        expect(refusal.code).toBe(code);
        expect(ARCHIVE_REFUSAL_CODES).toContain(refusal.code);
        expect(refusal.sentence).toMatch(/^[A-Z].*\.$/);
        expect(refusal.message).toBe(refusal.sentence);
      });
    }
  });

  it('folders that differ only in case collide, even when the files inside them differ', () => {
    const refusal = refusalOf(() =>
      readZip(zipOf([{ name: 'canonical/API/x.py', data: 'one' }, { name: 'canonical/api/y.py', data: 'two' }]), LIMITS),
    );
    expect(refusal.code).toBe('ARCHIVE_CASE_COLLISION');
    // a folder entry and a file path through it, in another case
    const viaFolder = refusalOf(() =>
      readZip(zipOf([{ name: 'Docs/', data: '', method: 0 }, { name: 'docs/a.md', data: 'x' }]), LIMITS),
    );
    expect(viaFolder.code).toBe('ARCHIVE_CASE_COLLISION');
    // the same folder, the same case, many files: fine
    expect(readZip(zipOf([{ name: 'canonical/api/x.py', data: '1' }, { name: 'canonical/api/y.py', data: '2' }]), LIMITS)).toHaveLength(2);
  });

  it('a name over 1,024 bytes or 64 segments is refused by sentence, before any per-segment work', () => {
    const long = refusalOf(() => readZip(zipOf([{ name: `canonical/${'n'.repeat(1100)}.py`, data: 'x' }]), LIMITS));
    expect(long.code).toBe('ARCHIVE_NAME_TOO_LONG');
    const deep = refusalOf(() => readZip(zipOf([{ name: `${Array.from({ length: 65 }, () => 'd').join('/')}.py`, data: 'x' }]), LIMITS));
    expect(deep.code).toBe('ARCHIVE_NAME_TOO_LONG');
    expect(ARCHIVE_REFUSAL_CODES).toContain('ARCHIVE_NAME_TOO_LONG');
    // 64 segments inside 1,024 bytes is still a name
    const atLimit = `${Array.from({ length: 63 }, () => 'd').join('/')}/a.py`;
    expect(readZip(zipOf([{ name: atLimit, data: 'x' }]), LIMITS).map((e) => e.name)).toEqual([atLimit]);
  });

  // The two name limits, each at its edge, and the shared sentence that states them.
  it('a name over 1,024 bytes is ARCHIVE_NAME_TOO_LONG (1,024 is still a name, multi-byte characters counted in bytes)', () => {
    const named = (bytes: number) => `docs/${'n'.repeat(bytes - 'docs/'.length)}`;
    expect(Buffer.byteLength(named(1024))).toBe(1024);
    expect(readZip(zipOf([{ name: named(1024), data: 'x' }]), LIMITS).map((e) => e.name)).toEqual([named(1024)]);
    expect(refusalOf(() => readZip(zipOf([{ name: named(1025), data: 'x' }]), LIMITS)).code).toBe('ARCHIVE_NAME_TOO_LONG');
    // 400 characters of three bytes each are 1,200 bytes: refused by bytes, not by characters
    const wide = `docs/${'€'.repeat(400)}`;
    expect(wide.length).toBeLessThan(1024);
    expect(refusalOf(() => readZip(zipOf([{ name: wide, data: 'x' }]), LIMITS)).code).toBe('ARCHIVE_NAME_TOO_LONG');
  });

  it('more than 64 segments is ARCHIVE_NAME_TOO_LONG (64 is still a name; a folder entry’s trailing slash is not a segment)', () => {
    const deep = (segments: number) => Array.from({ length: segments }, (_, i) => `s${i}`).join('/');
    expect(readZip(zipOf([{ name: deep(64), data: 'x' }]), LIMITS).map((e) => e.name)).toEqual([deep(64)]);
    expect(refusalOf(() => readZip(zipOf([{ name: deep(65), data: 'x' }]), LIMITS)).code).toBe('ARCHIVE_NAME_TOO_LONG');
    expect(readZip(zipOf([{ name: `${deep(64)}/`, data: '', method: 0 }, { name: 'a.py', data: 'x' }]), LIMITS).map((e) => e.name)).toEqual(['a.py']);
    expect(refusalOf(() => readZip(zipOf([{ name: `${deep(65)}/`, data: '', method: 0 }]), LIMITS)).code).toBe('ARCHIVE_NAME_TOO_LONG');
  });

  it('GUARD: the reader’s name limits equal the numbers the shared ARCHIVE_NAME_TOO_LONG sentence states', () => {
    const shared = UPLOAD_REFUSALS.ARCHIVE_NAME_TOO_LONG;
    const bytes = /([\d,]+) bytes/.exec(shared);
    // the shared sentence counts parts (folders and the file name)
    const folders = /more than (\d+) parts \(folders and the file name\)/.exec(shared);
    expect(bytes).not.toBeNull();
    expect(folders).not.toBeNull();
    for (const cap of [CAP, 32 * 1024 * 1024]) {
      const limits = zipLimits(cap);
      expect(Number(bytes![1].replace(/,/g, ''))).toBe(limits.maxNameBytes);
      expect(Number(folders![1])).toBe(limits.maxNameSegments);
    }
    expect(UPLOAD_REFUSAL_CODES).toContain('ARCHIVE_NAME_TOO_LONG');
    // and the reader's own (log) sentence says the same two numbers
    const own = refusalOf(() => readZip(zipOf([{ name: `docs/${'n'.repeat(1100)}`, data: 'x' }]), LIMITS)).sentence;
    expect(own).toContain(`${LIMITS.maxNameBytes.toLocaleString('en-US')} bytes`);
    expect(own).toContain(`more than ${LIMITS.maxNameSegments} parts (folders and the file name)`);
  });

  it('the reader’s own ARCHIVE_ZIP64 (log) sentence says what the shared ZIP64_OR_SIZE_MISMATCH sentence says; the code is unchanged', () => {
    const shared = UPLOAD_REFUSALS.ZIP64_OR_SIZE_MISMATCH;
    const words = /a large-archive \(ZIP64\) size or position beyond the upload limit/.exec(shared);
    expect(words).not.toBeNull();
    const refusal = refusalOf(() => readZip(HOSTILE_ARCHIVES['zip64 sizes beyond the cap'].archive(), LIMITS));
    expect(refusal.code).toBe('ARCHIVE_ZIP64');
    expect(refusal.sentence).toContain(words![0]);
    expect(refusal.sentence).toMatch(/^[\x20-\x7e]+$/);
  });

  it('timing guard: names as deep as a zip allows (32,760 segments each) are refused in well under a second', () => {
    const deepName = (tag: string): string => `${tag}/${Array.from({ length: 32_759 }, () => 'a').join('/')}`;
    const archive = zipOf(['p', 'q', 'r', 's'].map((tag) => ({ name: deepName(tag), data: 'x', method: 0 })));
    const started = process.hrtime.bigint();
    const refusal = refusalOf(() => readZip(archive, zipLimits(32 * 1024 * 1024)));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(refusal.code).toBe('ARCHIVE_NAME_TOO_LONG');
    expect(ms).toBeLessThan(500);
  });

  it('timing guard: the worst the caps allow (2,000 entries, each 64 segments and about 1 KB) reads in well under two seconds', () => {
    const segment = 'abcdefghijklmno'; // 15 bytes; 63 folders + a file ≈ 1,015 bytes
    const folders = Array.from({ length: 62 }, () => segment).join('/');
    const specs = Array.from({ length: 2000 }, (_, i) => ({ name: `${String(i).padStart(4, '0')}/${folders}/f.py`, data: '', method: 0 }));
    expect(Buffer.byteLength(specs[0].name)).toBeLessThanOrEqual(1024);
    const archive = zipOf(specs);
    const started = process.hrtime.bigint();
    const entries = readZip(archive, zipLimits(32 * 1024 * 1024));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(entries).toHaveLength(2000);
    expect(ms).toBeLessThan(2000);
  });

  it('a sentence never contains archive bytes or entry names', () => {
    for (const [attack, { archive, limits }] of Object.entries(HOSTILE_ARCHIVES)) {
      const refusal = refusalOf(() => readZip(archive(), limits ?? LIMITS));
      for (const probe of ECHO_PROBES) {
        expect({ attack, echoes: refusal.sentence.includes(probe) }).toEqual({ attack, echoes: false });
      }
      // Nothing outside printable ASCII, so no byte of a name can ride along.
      expect(refusal.sentence).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it('fuzz: 1,000 seeded mutations of the Shelf archive each either read identically or refuse by sentence; none throws an unhandled error; none allocates beyond the cap', () => {
    const original = shelfArchive();
    const clean = readZip(original, LIMITS);
    let seed = 0x5eed1e55;
    const next = (n: number): number => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
      return seed % n;
    };
    let identical = 0;
    let refused = 0;
    for (let round = 0; round < 1000; round += 1) {
      const bytes = Buffer.from(original);
      const kind = next(4);
      const flips = 1 + next(8);
      for (let i = 0; i < flips; i += 1) {
        const at = next(bytes.length);
        if (kind === 0) bytes[at] = next(256);
        else if (kind === 1) bytes[at] ^= 1 << next(8);
        else if (kind === 2) bytes.writeUInt32LE(next(2) ? 0xffffffff : next(0x10000), Math.min(at, bytes.length - 4));
        else bytes.writeUInt16LE(0xffff, Math.min(at, bytes.length - 2));
      }
      const mutated = next(10) === 0 ? bytes.subarray(0, next(bytes.length)) : bytes;
      let granted = 0;
      const inflate = (data: Buffer, maxOutputLength: number): Buffer => {
        granted += maxOutputLength;
        expect(maxOutputLength).toBeLessThanOrEqual(CAP);
        return zlib.inflateRawSync(data, { maxOutputLength });
      };
      let entries: ArchiveEntry[] | null = null;
      try {
        entries = readZip(mutated, LIMITS, { inflate });
      } catch (error) {
        if (!(error instanceof UploadRefusal)) {
          throw new Error(`round ${round}: unhandled ${(error as Error)?.constructor?.name}: ${String(error)}`);
        }
        expect(ARCHIVE_REFUSAL_CODES).toContain(error.code);
        expect(error.sentence).toMatch(/^[\x20-\x7e]+$/);
        refused += 1;
      }
      // The sum of every output buffer the reader asked zlib for stays under the cap.
      expect(granted).toBeLessThanOrEqual(CAP);
      if (entries) {
        const total = entries.reduce((sum, e) => sum + e.bytes.length, 0);
        expect(total).toBeLessThanOrEqual(CAP);
        // A mutation the reader accepts landed somewhere no file depends on
        // (a timestamp, a comment, a version byte): the files read identically.
        expect(entries.map((e) => [e.name, e.bytes.toString('base64')])).toEqual(
          clean.map((e) => [e.name, e.bytes.toString('base64')]),
        );
        identical += 1;
      }
    }
    expect(identical + refused).toBe(1000);
    expect(refused).toBeGreaterThan(0);
  });
});
