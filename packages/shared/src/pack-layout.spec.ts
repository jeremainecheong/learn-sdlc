import {
  COMMON_FOLDERS, EDITOR_FOLDERS, KIND_FOLDERS, MACHINE_OUTPUT_FOLDERS, compareMountPaths, foldersFor, isDesktopFile, isMachineOutputFile,
  kindOfFolder, languageOfPath, phaseFolderName, phaseKeyOfFolder, sortedMounts,
} from './index';

describe('the archive layout', () => {
  it('names the folders each kind of phase holds', () => {
    expect(foldersFor('story')).toEqual(['files', 'readonly', 'quizzes']);
    expect(foldersFor('code')).toEqual(['files', 'readonly', 'quizzes', 'hidden_tests', 'solution']);
    expect(foldersFor('tests')).toEqual(['files', 'readonly', 'quizzes', 'reference', 'impl', 'mutants']);
    expect(foldersFor('config')).toEqual(['files', 'readonly', 'quizzes', 'smoke', 'drill']);
    expect(kindOfFolder('hidden_tests')).toBe('code');
    expect(kindOfFolder('files')).toBeNull();
    for (const list of [COMMON_FOLDERS, KIND_FOLDERS, KIND_FOLDERS.code, KIND_FOLDERS.tests, KIND_FOLDERS.config]) expect(Object.isFrozen(list)).toBe(true);
  });
  it('knows machine output, editor folders and desktop files by name', () => {
    expect([...MACHINE_OUTPUT_FOLDERS].sort()).toEqual(['.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.venv', '__pycache__', 'node_modules', 'venv']);
    expect([...EDITOR_FOLDERS].sort()).toEqual(['.idea', '.vscode']);
    expect(isMachineOutputFile('x.pyc')).toBe(true);
    expect(isMachineOutputFile('app.js.map')).toBe(true);
    expect(isMachineOutputFile('map.ts')).toBe(false);
    for (const name of ['.DS_Store', 'Thumbs.db', 'desktop.ini', '._main.py']) expect(isDesktopFile(name)).toBe(true);
    for (const name of ['.gitignore', '.env.example', 'main.py', '_private.py']) expect(isDesktopFile(name)).toBe(false);
  });
  it('orders mounts by workspace path in code-unit order, never by locale', () => {
    const paths = ['web/src/b.ts', 'Dockerfile', 'api/main.py', '.github/workflows/ci.yml', 'api/Dockerfile', 'api/_x.py', 'api/a.py'];
    expect(sortedMounts(paths.map((path) => ({ path }))).map((one) => one.path)).toEqual(
      ['.github/workflows/ci.yml', 'Dockerfile', 'api/Dockerfile', 'api/_x.py', 'api/a.py', 'api/main.py', 'web/src/b.ts'],
    );
    expect(compareMountPaths('B', 'a')).toBeLessThan(0);
    expect(sortedMounts([{ path: 'web/src/b.ts' }, { path: 'web-e2e/a.ts' }]).map((one) => one.path)).toEqual(['web-e2e/a.ts', 'web/src/b.ts']);
  });
  it("derives a mount's language from its path by the extension table", () => {
    const table: [string, string][] = [
      ['api/main.py', 'python'], ['web/src/a.ts', 'typescript'], ['web/src/A.tsx', 'typescript'], ['x.mts', 'typescript'], ['x.cts', 'typescript'],
      ['web/run-tests.js', 'javascript'], ['x.jsx', 'javascript'], ['x.mjs', 'javascript'], ['x.cjs', 'javascript'], ['shared/contract/api.json', 'json'],
      ['api/schema.sql', 'sql'], ['web/index.html', 'html'], ['docker-compose.yml', 'yaml'], ['x.yaml', 'yaml'], ['x.css', 'css'], ['x.scss', 'scss'],
      ['x.sh', 'shell'], ['x.toml', 'toml'], ['x.xml', 'xml'], ['NOTES.md', 'markdown'], ['requirements.txt', 'plaintext'],
      ['api/Dockerfile', 'dockerfile'], ['Dockerfile', 'dockerfile'], ['Makefile', 'plaintext'], ['x.unknown', 'plaintext'], ['.gitignore', 'plaintext'],
      ['x.constructor', 'plaintext'], ['x.__proto__', 'plaintext'], ['x.toString', 'plaintext'], ['X.PY', 'plaintext'],
    ];
    for (const [path, language] of table) expect({ path, language: languageOfPath(path) }).toEqual({ path, language });
  });
  it('names a phase folder by its place and reads the key back', () => {
    expect(phaseFolderName(3, 'implementation')).toBe('03-implementation');
    expect(phaseKeyOfFolder('03-implementation')).toBe('implementation');
    expect(phaseKeyOfFolder('testing')).toBe('testing');
    expect(phaseKeyOfFolder('3-implementation')).toBe('implementation');
    expect(phaseKeyOfFolder('07-review')).toBe('review');
    expect(phaseKeyOfFolder('03-Implementation')).toBe('Implementation');
  });
});
