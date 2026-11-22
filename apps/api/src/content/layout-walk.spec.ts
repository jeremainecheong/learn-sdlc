import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkPackFiles } from '../authoring/upload-limits';
import { packDigestOf } from './importer.service';
import { DirectoryPackSource, LayoutWalkRefusal } from './pack-source';
import { MemoryPackSource, packRootOf } from './memory-pack-source';
import { uploadPack } from '../../test/fixtures/paths';

/**
 * The folder layout's two walks: the upload's, which mounts dot
 * entries at their paths, refuses machine output by name and leaves desktop
 * entries out with a note; and the platform's disk walk, which mounts dot
 * entries and skips what a maintainer's machine leaves. Beside them, the two
 * readers that must keep seeing what the walks leave out or skip: the pack
 * digest leaves leftovers out by its own filter, and the secret scan still
 * reads every byte.
 */

const entries = (files: Record<string, string>) => Object.entries(files).map(([name, text]) => ({ name, bytes: Buffer.from(text) }));

const SHELF_DIR = uploadPack('shelf');

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

describe('the upload walk', () => {
  it('mounts a dot-prefixed file or folder at its path', () => {
    const source = new MemoryPackSource(entries({ 'project.json': '{}', 'phases/05-deployment/files/.github/workflows/ci.yml': 'on: push', 'phases/05-deployment/files/.gitignore': 'dist' }), 'upload', '');
    expect(source.walkLayout('phases/05-deployment/files')).toEqual(['.github/workflows/ci.yml', '.gitignore']);
  });
  it('refuses machine output under files/, readonly/, smoke/ and a sealed folder, naming its path', () => {
    const named: Record<string, string> = {
      'files/api/__pycache__/x.pyc': 'phases/03-implementation/files/api/__pycache__',
      'readonly/node_modules/a.js': 'phases/03-implementation/readonly/node_modules',
      'smoke/.pytest_cache/v/x': 'phases/03-implementation/smoke/.pytest_cache',
      'hidden_tests/api/.venv/lib/x.py': 'phases/03-implementation/hidden_tests/api/.venv',
      'files/app.js.map': 'phases/03-implementation/files/app.js.map',
    };
    for (const [at, printed] of Object.entries(named)) {
      const source = new MemoryPackSource(entries({ 'project.json': '{}', [`phases/03-implementation/${at}`]: 'x' }), 'upload', '');
      expect(() => source.walkLayout('phases/03-implementation')).toThrow(LayoutWalkRefusal);
      expect(() => source.walkLayout('phases/03-implementation')).toThrow(`${printed} is machine output. Remove it from the archive and upload again.`);
    }
  });
  it('names the pack-relative path when a child source walks', () => {
    const source = new MemoryPackSource(entries({ 'project.json': '{}', 'phases/03-implementation/files/api/__pycache__/x.pyc': 'x' }), 'upload', '');
    let refused: unknown;
    try {
      source.child('phases/03-implementation').walkLayout('files');
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(LayoutWalkRefusal);
    expect((refused as LayoutWalkRefusal).path).toBe('phases/03-implementation/files/api/__pycache__');
    expect((refused as LayoutWalkRefusal).editor).toBe(false);
  });
  it("refuses an editor's settings folder in its own sentence", () => {
    const source = new MemoryPackSource(entries({ 'project.json': '{}', 'phases/03-implementation/files/.vscode/settings.json': '{}' }), 'upload', '');
    expect(() => source.walkLayout('phases/03-implementation')).toThrow('phases/03-implementation/files/.vscode is an editor\'s settings folder. Remove it from the archive and upload again.');
    const idea = new MemoryPackSource(entries({ 'project.json': '{}', 'phases/03-implementation/readonly/.idea/w.xml': 'x' }), 'upload', '');
    expect(() => idea.walkLayout('phases/03-implementation')).toThrow(expect.objectContaining({ path: 'phases/03-implementation/readonly/.idea', editor: true }));
  });
  it('leaves desktop files out, names each once, and never mounts one', () => {
    const source = new MemoryPackSource(entries({
      'project.json': '{}', 'phases/03-implementation/files/.DS_Store': '\u0000', 'phases/03-implementation/files/._main.py': '\u0000',
      'phases/03-implementation/files/main.py': 'x', 'phases/03-implementation/files/sub/__MACOSX/a': 'x',
    }), 'upload', '');
    expect(source.walkLayout('phases/03-implementation/files')).toEqual(['main.py']);
    expect(source.leftOut()).toEqual(['phases/03-implementation/files/.DS_Store', 'phases/03-implementation/files/._main.py', 'phases/03-implementation/files/sub/__MACOSX/']);
    source.walkLayout('phases/03-implementation/files');
    expect(source.leftOut()).toHaveLength(3);
  });
  it('leaves Thumbs.db and desktop.ini out under a sealed folder, never refusing or sealing them', () => {
    const source = new MemoryPackSource(entries({
      'project.json': '{}', 'phases/03-implementation/hidden_tests/api/Thumbs.db': 'x', 'phases/03-implementation/hidden_tests/api/desktop.ini': 'x',
      'phases/03-implementation/hidden_tests/api/tests/test_x.py': 'x',
    }), 'upload', '');
    expect(source.walkLayout('phases/03-implementation/hidden_tests')).toEqual(['api/tests/test_x.py']);
    expect(source.leftOut()).toEqual(['phases/03-implementation/hidden_tests/api/Thumbs.db', 'phases/03-implementation/hidden_tests/api/desktop.ini']);
  });
  it("records a child source's walks on the root's list", () => {
    const source = new MemoryPackSource(entries({ 'project.json': '{}', 'phases/04-testing/reference/.DS_Store': 'x', 'phases/04-testing/reference/t.py': 'x' }), 'upload', '');
    expect(source.child('phases/04-testing').walkLayout('reference')).toEqual(['t.py']);
    expect(source.leftOut()).toEqual(['phases/04-testing/reference/.DS_Store']);
  });
  it('sorts the walk in code-unit order', () => {
    const source = new MemoryPackSource(entries({ 'project.json': '{}', 'f/b.py': 'x', 'f/B.py': 'x', 'f/_a.py': 'x', 'f/a/z.py': 'x', 'f/a.py': 'x' }), 'upload', '');
    expect(source.walkLayout('f')).toEqual(['B.py', '_a.py', 'a.py', 'a/z.py', 'b.py']);
  });
  it('reads a dot entry under smoke/ at its path', () => {
    const source = new MemoryPackSource(entries({ 'project.json': '{}', 'phases/05-deployment/smoke/.selfcheck.json': '{}' }), 'upload', '');
    expect(source.walkLayout('phases/05-deployment/smoke')).toEqual(['.selfcheck.json']);
  });
  it('notes a __MACOSX/ beside the pack folder and one under the pack root alike', () => {
    const beside = entries({ 'shelf/project.json': '{}', '__MACOSX/shelf/._project.json': 'x' });
    expect(packRootOf(beside)).toBe('shelf');
    expect(new MemoryPackSource(beside, 'upload', 'shelf').leftOut()).toEqual(['__MACOSX/']);
    const under = new MemoryPackSource(entries({ 'project.json': '{}', '__MACOSX/._project.json': 'x' }), 'upload', '');
    under.walkLayout('');
    expect(under.leftOut()).toContain('__MACOSX/');
  });
  it('notes a __MACOSX/ directly inside the pack root at construction, in both archive shapes, before any walk', () => {
    const atRoot = new MemoryPackSource(entries({ 'project.json': '{}', '__MACOSX/._project.json': 'x' }), 'upload', '');
    const inFolder = new MemoryPackSource(entries({ 'shelf/project.json': '{}', 'shelf/__MACOSX/._x': 'x' }), 'upload', 'shelf');
    for (const source of [atRoot, inFolder]) {
      expect(source.leftOut()).toEqual(['__MACOSX/']);
      source.walkLayout('');
      expect(source.leftOut()).toEqual(['__MACOSX/']);
    }
  });
  it('notes each desktop entry outside phases/ once at construction, never mounting or refusing one', () => {
    const source = new MemoryPackSource(entries({
      'project.json': '{}', '.DS_Store': '\u0000', 'canonical/api/._x.py': '\u0000', 'notes/Thumbs.db': 'x', 'notes/__MACOSX/a/b': 'x',
      'notes/__MACOSX/c': 'x', 'canonical/.idea/desktop.ini': 'x',
      'phases/03-implementation/files/.DS_Store': '\u0000', 'phases/03-implementation/files/main.py': 'x',
    }), 'upload', '');
    const outside = ['.DS_Store', 'canonical/.idea/desktop.ini', 'canonical/api/._x.py', 'notes/Thumbs.db', 'notes/__MACOSX/'];
    // A desktop entry under phases/ waits for the walk that reaches it.
    expect(source.leftOut()).toEqual(outside);
    expect(source.walkLayout('phases/03-implementation/files')).toEqual(['main.py']);
    expect(source.leftOut()).toEqual([...outside, 'phases/03-implementation/files/.DS_Store'].sort());
    source.walkLayout('phases/03-implementation/files');
    expect(source.leftOut()).toHaveLength(outside.length + 1);
    // The secret scan still reads them: the tree keeps every byte.
    expect(source.walkForDigest()).toEqual(expect.arrayContaining(['.DS_Store', 'canonical/api/._x.py', 'notes/__MACOSX/a/b']));
  });
  it('notes nothing for an archive without desktop entries', () => {
    const source = new MemoryPackSource(entries({ 'shelf/project.json': '{}', 'shelf/phases/01-requirements/files/a.json': '{}' }), 'upload', 'shelf');
    source.walkLayout('');
    expect(source.leftOut()).toEqual([]);
  });
});

describe('the disk walk', () => {
  let dirs: string[] = [];
  const tempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  it('mounts dot entries and skips machine output, tool and editor folders and desktop files in a content/ phase folder', () => {
    const dir = tempDir('walk-');
    writeTree(dir, { 'files/.github/ci.yml': 'x', 'files/.DS_Store': 'x', 'files/.pytest_cache/v/x': 'x', 'files/.idea/w.xml': 'x', 'files/a.pyc': 'x', 'files/ok.py': 'x' });
    expect(new DirectoryPackSource(dir).walkLayout('files')).toEqual(['.github/ci.yml', 'ok.py']);
  });
  it('skips every machine-output and editor folder, __MACOSX/ and AppleDouble files, at any depth, in code-unit order', () => {
    const dir = tempDir('walk-');
    writeTree(dir, {
      'files/api/__pycache__/m.pyc': 'x', 'files/web/node_modules/x/i.js': 'x', 'files/.mypy_cache/x': 'x', 'files/.ruff_cache/x': 'x',
      'files/.tox/x': 'x', 'files/.venv/x': 'x', 'files/venv/x': 'x', 'files/.vscode/s.json': 'x', 'files/sub/__MACOSX/a': 'x',
      'files/sub/._b.py': 'x', 'files/sub/Thumbs.db': 'x', 'files/sub/desktop.ini': 'x', 'files/web/app.js.map': 'x',
      'files/sub/b.py': 'x', 'files/B.py': 'x', 'files/_a.py': 'x', 'files/.gitignore': 'x',
    });
    expect(new DirectoryPackSource(dir).walkLayout('files')).toEqual(['.gitignore', 'B.py', '_a.py', 'sub/b.py']);
    expect(new DirectoryPackSource(dir).child('files').walkLayout()).toEqual(['.gitignore', 'B.py', '_a.py', 'sub/b.py']);
  });
  it("leaves desktop files and tool and editor folders out of a pack's digest, so a Finder, pytest or editor leftover never moves it", () => {
    const dir = tempDir('digest-');
    fs.cpSync(SHELF_DIR, dir, { recursive: true });
    const before = packDigestOf(new DirectoryPackSource(dir));
    writeTree(dir, {
      '.DS_Store': 'x', 'phases/03-implementation/.DS_Store': 'x', 'canonical/api/._x.py': 'x', '__MACOSX/._project.json': 'x',
      'canonical/.mypy_cache/3.11/x.json': 'x', 'canonical/.ruff_cache/x': 'x', 'canonical/.tox/x': 'x', 'canonical/.venv/lib/x.py': 'x',
      'canonical/venv/lib/x.py': 'x', '.vscode/settings.json': '{}', '.idea/workspace.xml': 'x', 'phases/Thumbs.db': 'x', 'phases/desktop.ini': 'x',
    });
    expect(packDigestOf(new DirectoryPackSource(dir))).toBe(before);
    // The filter leaves out only those names: an authored note still moves the digest.
    writeTree(dir, { 'NOTES.md': 'a note beside project.json' });
    expect(packDigestOf(new DirectoryPackSource(dir))).not.toBe(before);
  });
  it('matches a leftover folder by a folder part, so a file named venv or .tox still moves the digest', () => {
    const dir = tempDir('digest-');
    fs.cpSync(SHELF_DIR, dir, { recursive: true });
    const before = packDigestOf(new DirectoryPackSource(dir));
    writeTree(dir, { 'phases/03-implementation/x/venv/lib.py': 'x', 'phases/03-implementation/x/.tox/log': 'x' });
    expect(packDigestOf(new DirectoryPackSource(dir))).toBe(before);
    writeTree(dir, { 'phases/03-implementation/venv': 'a file, not a folder' });
    const withVenv = packDigestOf(new DirectoryPackSource(dir));
    expect(withVenv).not.toBe(before);
    writeTree(dir, { 'phases/03-implementation/venv': 'edited' });
    const edited = packDigestOf(new DirectoryPackSource(dir));
    expect(edited).not.toBe(withVenv);
    writeTree(dir, { 'phases/03-implementation/.tox': 'a file too' });
    expect(packDigestOf(new DirectoryPackSource(dir))).not.toBe(edited);
  });
  it("keeps the disk walkForDigest listing desktop files, editor folders and __MACOSX/ for the scan", () => {
    const dir = tempDir('scan-');
    writeTree(dir, { 'project.json': '{}', '.DS_Store': 'x', '.idea/workspace.xml': 'x', '__MACOSX/._project.json': 'x' });
    expect(new DirectoryPackSource(dir).walkForDigest()).toEqual(expect.arrayContaining(['.DS_Store', '.idea/workspace.xml', '__MACOSX/._project.json']));
  });
  it('keeps the secret scan reading every byte: walkForDigest still lists editor folders and __MACOSX/', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n';
    const source = new MemoryPackSource(entries({
      'project.json': '{}', 'phases/03-implementation/files/.idea/id_rsa': 'x', 'phases/03-implementation/files/main.py': 'x', '__MACOSX/notes.txt': key,
    }), 'upload', '');
    expect(source.walkForDigest()).toEqual(expect.arrayContaining(['phases/03-implementation/files/.idea/id_rsa', '__MACOSX/notes.txt']));
    const refused = checkPackFiles(source);
    expect(refused.map((r) => r.where).sort()).toEqual(['__MACOSX/notes.txt', 'phases/03-implementation/files/.idea/id_rsa']);
    expect(refused.every((r) => r.code === 'PACK_SECRET_FILE')).toBe(true);
  });
});
