import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryPackSource, type PackSource } from './pack-source';
import { MemoryPackSource, packRootOf } from './memory-pack-source';
import { UploadRefusal } from './zip-reader';

/**
 * `PackSource` over an archive's entries.
 *
 * The directory source is the reference: the same tree written to a temp
 * directory and read through both must answer every question the loader asks
 * the same way (the walks, the entries, the bytes), and the memory source
 * must answer it without ever naming a byte outside the archive.
 */

const TREE: Record<string, string> = {
  'project.json': '{"slug":"shelf"}',
  'canonical/api/main.py': 'print("api")\n',
  'canonical/.env.example': 'PORT=8000\n',
  'canonical/web/.test/setup.ts': 'export {};\n',
  'canonical/web/src/App.tsx': 'export const App = () => null;\n',
  'canonical/web/src/App.js.map': '{}',
  'canonical/api/__pycache__/main.cpython-311.pyc': 'compiled',
  'canonical/node_modules/x/index.js': 'module.exports = 1;\n',
  'phases/03-implementation/phase.json': '{"key":"implementation"}',
  'phases/03-implementation/hidden_tests/api/test_books.py': 'def test(): pass\n',
  'phases/03-implementation/solution/api/books.py': 'def books(): return []\n',
  'phases/03-implementation/files/.gitignore': '*.pyc\n',
};

function entriesOf(tree: Record<string, string>): { name: string; bytes: Buffer }[] {
  return Object.entries(tree).map(([name, text]) => ({ name, bytes: Buffer.from(text, 'utf8') }));
}

describe('MemoryPackSource', () => {
  let dir: string;
  let disk: DirectoryPackSource;
  let memory: MemoryPackSource;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-up-memory-source-'));
    for (const [name, text] of Object.entries(TREE)) {
      fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    disk = new DirectoryPackSource(dir);
    memory = new MemoryPackSource(entriesOf(TREE), 'shelf');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers the loader’s questions exactly as the directory source does', () => {
    const ask = (source: PackSource) => ({
      available: source.available(),
      root: source.exists(''),
      project: source.exists('project.json'),
      missing: source.exists('nope.json'),
      entries: source.entries(),
      canonicalEntries: source.entries('canonical'),
      walk: source.walk(),
      walkCanonical: source.walk('canonical'),
      digest: source.walkForDigest(),
      phaseWalk: source.child('phases/03-implementation').walk('hidden_tests'),
      phaseDigest: source.child('phases/03-implementation').walkForDigest(),
      read: source.read('canonical/api/main.py'),
      viaParent: source.child('phases/03-implementation').read('../../canonical/api/main.py'),
      parentExists: source.child('phases/03-implementation').exists('../../canonical/.env.example'),
      dirExists: source.exists('canonical/web'),
    });
    expect(ask(memory)).toEqual(ask(disk));
  });

  it('timing guard: building the tree is linear in a name’s depth (one 20,000-segment entry, far below the seconds a prefix-keyed tree costs)', () => {
    const deep = `${Array.from({ length: 20_000 }, () => 'a').join('/')}/leaf.py`;
    const started = process.hrtime.bigint();
    const source = new MemoryPackSource([{ name: 'project.json', bytes: Buffer.from('{}') }, { name: deep, bytes: Buffer.from('x') }], 'deep');
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(source.read(deep)).toBe('x');
    expect(source.entries('a').map((one) => one.name)).toEqual(['a']);
    expect(ms).toBeLessThan(2500);
  });

  it('timing guard: each level costs its own name, not the prefix above it (ten 20,000-segment entries, far below the seconds a prefix-keyed tree costs)', () => {
    // A tree keyed by full prefix paths re-hashes the whole prefix at every
    // level, so this costs seconds; per-folder nodes cost milliseconds. The
    // bound is loose on purpose: a busy shared CI runner measured 866 ms for
    // the linear build, and the point is to catch the quadratic one.
    const deep = (n: number): string => `${Array.from({ length: 20_000 }, (_, i) => (i === 0 ? `d${n}` : 'a')).join('/')}/leaf.py`;
    const entries = [{ name: 'project.json', bytes: Buffer.from('{}') }, ...Array.from({ length: 10 }, (_, n) => ({ name: deep(n), bytes: Buffer.from(`x${n}`) }))];
    const started = process.hrtime.bigint();
    const source = new MemoryPackSource(entries, 'deep');
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(source.read(deep(7))).toBe('x7');
    expect(source.entries().map((one) => one.name)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'project.json']);
    expect(source.exists(`${deep(3).slice(0, -'/leaf.py'.length)}`)).toBe(true);
    expect(ms).toBeLessThan(2500);
  });

  it('names itself, never a host path', () => {
    expect(memory.name).toBe('shelf');
    expect(memory.location).not.toContain(os.tmpdir());
    expect(memory.child('phases/03-implementation').location).toBe(`${memory.location}/phases/03-implementation`);
    expect(memory.resolve('canonical/api/main.py')).toBe(`${memory.location}/canonical/api/main.py`);
  });

  it('resolve never leaves the archive root', () => {
    const phase = memory.child('phases/03-implementation');
    const climbs = [
      '../../../etc/passwd',
      '../../../../../../etc/passwd',
      '/etc/passwd',
      '../../canonical/../../etc/passwd',
      'files/../../../../outside.txt',
    ];
    for (const rel of climbs) {
      expect({ rel, exists: phase.exists(rel) }).toEqual({ rel, exists: false });
      expect(() => phase.read(rel)).toThrow(UploadRefusal);
      expect(() => phase.entries(rel)).toThrow(UploadRefusal);
      expect(() => phase.walk(rel)).toThrow(UploadRefusal);
      expect(() => phase.child(rel)).toThrow(UploadRefusal);
      // The printed path stays under the archive's own name, with no `..`.
      const printed = phase.resolve(rel);
      expect(printed.startsWith(`${memory.location}/`)).toBe(true);
      expect(printed.split('/')).not.toContain('..');
      expect(printed).not.toMatch(/^\/etc|^\/private|^\/Users|^\/home/);
    }
    // Climbing exactly to the root is allowed: that is `../../canonical/...`.
    expect(phase.read('../../canonical/api/main.py')).toBe(TREE['canonical/api/main.py']);
    expect(phase.exists('../..')).toBe(true);
    // A child at the root climbing one more step is outside.
    expect(memory.exists('..')).toBe(false);
    expect(memory.child('canonical').exists('../../project.json')).toBe(false);
  });

  it('a missing file reads as the loader expects a missing file to: an error, not a refusal', () => {
    expect(() => memory.read('canonical/nope.py')).toThrow(/ENOENT|not found/);
  });

  it('finds the pack root: the archive root, or one wrapping directory holding project.json', () => {
    expect(packRootOf(entriesOf(TREE))).toBe('');
    const wrapped = entriesOf(TREE).map((e) => ({ ...e, name: `shelf-main/${e.name}` }));
    expect(packRootOf(wrapped)).toBe('shelf-main');
    const rooted = new MemoryPackSource(wrapped, 'shelf', 'shelf-main');
    expect(rooted.read('project.json')).toBe(TREE['project.json']);
    // The wrapper is the archive root for this source: nothing above it.
    expect(rooted.exists('../shelf-main/project.json')).toBe(false);
    expect(() => packRootOf([{ name: 'a/x.txt', bytes: Buffer.from('') }])).toThrow(UploadRefusal);
    expect(() =>
      packRootOf([
        { name: 'a/project.json', bytes: Buffer.from('{}') },
        { name: 'b/project.json', bytes: Buffer.from('{}') },
      ]),
    ).toThrow(UploadRefusal);
  });

  it('records every file read, by pack-relative path, across children; forgetReads starts a fresh log; bytesOf gives the raw bytes', () => {
    const wrapped = entriesOf(TREE).map((e) => ({ ...e, name: `shelf-main/${e.name}` }));
    const source = new MemoryPackSource(wrapped, 'shelf', 'shelf-main');
    source.read('project.json');
    expect(source.filesRead()).toEqual(['project.json']);
    source.forgetReads();
    expect(source.filesRead()).toEqual([]);
    const phase = source.child('phases/03-implementation');
    phase.read('phase.json');
    phase.read('../../canonical/api/main.py');
    phase.read('../../canonical/api/main.py');
    expect(() => phase.read('nope.py')).toThrow();
    // a walk, an exists and an entries listing read no file
    source.walkForDigest();
    source.exists('canonical/web/src/App.tsx');
    source.entries('canonical');
    expect(source.filesRead()).toEqual(['canonical/api/main.py', 'phases/03-implementation/phase.json']);
    expect(phase.filesRead()).toEqual(source.filesRead());
    const raw = source.bytesOf('canonical/api/main.py');
    expect(Buffer.isBuffer(raw) && raw.equals(Buffer.from(TREE['canonical/api/main.py'], 'utf8'))).toBe(true);
    expect(source.bytesOf('nope.py')).toBeUndefined();
    // a fresh source over the same entries keeps its own log
    expect(new MemoryPackSource(wrapped, 'shelf', 'shelf-main').filesRead()).toEqual([]);
  });
});
