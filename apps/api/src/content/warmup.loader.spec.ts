import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContentService } from './content.service';
import { WARMUP_BRIEF_FILE_REFUSAL, loadWarmup } from './warmup.loader';

/**
 * The warm-up loader.
 *
 * Packs are hand-authored JSON, and a warm-up is the first thing a learner ever
 * opens, so a broken one has to name its own mistake at boot rather than reach
 * the room as an undefined. These pin the three ways an author gets it wrong:
 * a source that is not there, a check that names a file the pack never declared,
 * and a check the learner could edit their way past.
 */

/** A pack directory on disk, so the loader reads real files the way it will in production. */
function pack(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdlc-warmup-'));
  for (const [rel, content] of Object.entries(files)) {
    const at = path.join(dir, rel);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, content, 'utf-8');
  }
  return dir;
}

const GOOD = {
  'warmup/warmup.json': JSON.stringify({
    title: 'Warm-up',
    brief: 'Warm up first\n',
    runLabel: 'Run the check',
    steps: ['Change the word', 'Run it', 'Submit it'],
    files: [
      { path: 'greeting.py', source: 'files/greeting.py', editable: true, language: 'python' },
      { path: 'tests/test_warmup.py', source: 'files/test_warmup.py', editable: false },
    ],
    check: { kind: 'tests', testPaths: ['tests/test_warmup.py'] },
  }),
  'warmup/files/greeting.py': 'def greeting():\n    return "goodbye"\n',
  'warmup/files/test_warmup.py': 'assert True\n',
};

/** The same pack with one field replaced, so each case says what it changed. */
function withSpec(over: Record<string, unknown>): string {
  const spec = { ...JSON.parse(GOOD['warmup/warmup.json']), ...over };
  return pack({ ...GOOD, 'warmup/warmup.json': JSON.stringify(spec) });
}

describe('loadWarmup', () => {
  const dirs: string[] = [];
  const make = (files: Record<string, string>): string => {
    const dir = pack(files);
    dirs.push(dir);
    return dir;
  };
  const makeSpec = (over: Record<string, unknown>): string => {
    const dir = withSpec(over);
    dirs.push(dir);
    return dir;
  };

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports null for a pack that declares none', () => {
    const dir = make(GOOD);
    expect(loadWarmup(dir, undefined, 'python')).toBeNull();
    expect(loadWarmup(dir, null, 'python')).toBeNull();
  });

  it('loads the exercise, taking each file’s language from the pack when it names none', () => {
    const warmup = loadWarmup(make(GOOD), 'warmup', 'python');

    expect(warmup?.title).toBe('Warm-up');
    expect(warmup?.brief).toContain('Warm up first');
    expect(warmup?.steps).toHaveLength(3);
    expect(warmup?.runLabel).toBe('Run the check');
    expect(warmup?.files.map((f) => [f.path, f.editable, f.language])).toEqual([
      ['greeting.py', true, 'python'],
      ['tests/test_warmup.py', false, 'python'],
    ]);
    expect(warmup?.files[0].content).toContain('goodbye');
    // the check says which language and harness it runs under, and both
    // default to the pack's own, so a warm-up that names neither runs under
    // the pack's own language and harness
    expect(warmup?.check).toEqual({
      kind: 'tests',
      testPaths: ['tests/test_warmup.py'],
      language: 'python',
      harness: 'unittest',
      transform: false,
    });
  });

  it('names the file and the field when a source is not there', () => {
    const dir = makeSpec({
      files: [{ path: 'greeting.py', source: 'files/missing.py', editable: true }],
      check: { kind: 'tests', testPaths: ['greeting.py'] },
    });

    expect(() => loadWarmup(dir, 'warmup', 'python')).toThrow(
      /warmup.json: files\[0\].source: source file not found: files\/missing.py/,
    );
  });

  it('refuses a check that names a file the pack never declared', () => {
    const dir = makeSpec({ check: { kind: 'tests', testPaths: ['tests/nowhere.py'] } });

    expect(() => loadWarmup(dir, 'warmup', 'python')).toThrow(
      /check.testPaths names "tests\/nowhere.py", which files does not declare/,
    );
  });

  it('refuses a check the learner could edit their way past', () => {
    // A warm-up whose own test file is editable is a warm-up anybody passes by
    // deleting the assertion, which teaches the opposite of the lesson.
    const dir = makeSpec({
      files: [
        { path: 'greeting.py', source: 'files/greeting.py', editable: true },
        { path: 'tests/test_warmup.py', source: 'files/test_warmup.py', editable: true },
      ],
    });

    expect(() => loadWarmup(dir, 'warmup', 'python')).toThrow(
      /which is editable — a warm-up's own check must be locked/,
    );
  });

  it('refuses an exercise with nothing for the learner to change', () => {
    const dir = makeSpec({
      files: [{ path: 'tests/test_warmup.py', source: 'files/test_warmup.py', editable: false }],
      check: { kind: 'tests', testPaths: ['tests/test_warmup.py'] },
    });

    expect(() => loadWarmup(dir, 'warmup', 'python')).toThrow(
      /files needs at least one editable entry/,
    );
  });

  /* ------------------------- the warm-up's own run ------------------------ */

  /** The TypeScript warm-up: one line of code, the transform and the DOM harness. */
  const TS_SPEC = {
    files: [
      { path: 'web/src/lib/greeting.ts', source: 'files/greeting.ts', editable: true },
      { path: 'web/src/lib/greeting.test.ts', source: 'files/greeting.test.ts' },
    ],
    check: { kind: 'tests', testPaths: ['web/src/lib/greeting.test.ts'], language: 'typescript' },
  };

  const TS_FILES = {
    'warmup/files/greeting.ts': 'export const greeting = () => "goodbye";\n',
    'warmup/files/greeting.test.ts': "test('greeting', () => {});\n",
  };

  const tsPack = (over: Record<string, unknown> = {}): string => {
    const spec = { ...JSON.parse(GOOD['warmup/warmup.json']), ...TS_SPEC, ...over };
    const dir = pack({ ...GOOD, ...TS_FILES, 'warmup/warmup.json': JSON.stringify(spec) });
    dirs.push(dir);
    return dir;
  };

  it('runs a TypeScript warm-up under the DOM harness, with the transform on', () => {
    // the first thing a learner ever runs is the transform and the harness the
    // front-end phases grade them with, on a one-line function
    const warmup = loadWarmup(tsPack(), 'warmup', 'python', ['python', 'typescript']);

    expect(warmup?.check).toEqual({
      kind: 'tests',
      testPaths: ['web/src/lib/greeting.test.ts'],
      language: 'typescript',
      harness: 'js',
      transform: true,
    });
    // and the files still take the pack's language when they name none, which
    // is a highlighting hint and not the run's language
    expect(warmup?.files.map((f) => f.path)).toEqual([
      'web/src/lib/greeting.ts',
      'web/src/lib/greeting.test.ts',
    ]);
  });

  it('refuses a warm-up in a language the pack never declared', () => {
    expect(() => loadWarmup(tsPack(), 'warmup', 'python', ['python'])).toThrow(
      /check.language \("typescript"\) is not one of this pack's languages \(python\)/,
    );
  });

  it('refuses a harness that cannot run the warm-up’s language', () => {
    const dir = tsPack({
      check: { kind: 'tests', testPaths: ['web/src/lib/greeting.test.ts'], language: 'typescript', harness: 'pytest' },
    });
    expect(() => loadWarmup(dir, 'warmup', 'python', ['python', 'typescript'])).toThrow(
      /check.harness \("pytest"\) cannot run typescript: use js/,
    );
  });

  it('refuses a transform on a python warm-up', () => {
    const dir = makeSpec({
      check: { kind: 'tests', testPaths: ['tests/test_warmup.py'], transform: true },
    });
    expect(() => loadWarmup(dir, 'warmup', 'python')).toThrow(
      /check.transform is only for a typescript check, and this one is python/,
    );
  });

  it('refuses a brief kept in a file, by name, and reads the inline brief', () => {
    const inFile = makeSpec({ briefFile: 'brief.md' });
    fs.writeFileSync(path.join(inFile, 'warmup', 'brief.md'), 'Warm up first\n', 'utf-8');
    expect(() => loadWarmup(inFile, 'warmup', 'python')).toThrow(WARMUP_BRIEF_FILE_REFUSAL);
    expect(WARMUP_BRIEF_FILE_REFUSAL).toBe('warmup.json keeps its brief inline as brief, not in a file.');
    expect(loadWarmup(makeSpec({}), 'warmup', 'python')?.brief).toBe('Warm up first\n');
  });

  it('refuses a directory with no warmup.json, and a path that escapes the workspace', () => {
    const empty = make({ 'warmup/files/greeting.py': 'x' });
    expect(() => loadWarmup(empty, 'warmup', 'python')).toThrow(/warmup.json not found/);

    const escaping = makeSpec({
      files: [{ path: '../outside.py', source: 'files/greeting.py', editable: true }],
      check: { kind: 'tests', testPaths: ['../outside.py'] },
    });
    expect(() => loadWarmup(escaping, 'warmup', 'python')).toThrow(
      /must be a relative path inside the workspace/,
    );
  });
});

describe('the packs this repository ships', () => {
  const content = new ContentService();
  content.loadAll();

  for (const project of content.listProjects()) {
    it(`${project.slug}: ships a warm-up whose check fails on the file as shipped`, () => {
      const warmup = content.getProject(project.slug).warmup ?? null;
      expect(warmup).not.toBeNull();
      // The one property the exercise depends on: the starting state is wrong.
      // A warm-up that already passes teaches nothing, and the room's three
      // steps would have nothing to tick.
      const editable = warmup!.files.filter((f) => f.editable);
      expect(editable).toHaveLength(1);
      expect(editable[0].content).toContain('goodbye');
      const check = warmup!.files.find((f) => f.path === warmup!.check.testPaths[0]);
      expect(check?.editable).toBe(false);
      expect(check?.content).toContain('hello');
      expect(project.warmup).toBe(warmup);

      // the warm-up declares its own run, and it has to be one that can
      // collect the file it names. This pack's language is python while its
      // warm-up is TypeScript, so a check that inherited the project's language
      // would be driven by unittest, which discovers no `.ts` file at all.
      // Zero cases, and a run that collected nothing reads to the learner as a
      // pass on the very exercise whose point is that it starts red.
      const suite = warmup!.check.testPaths[0];
      const python = suite.endsWith('.py');
      expect({ suite, python: warmup!.check.language === 'python' }).toEqual({ suite, python });
      expect(python ? ['unittest', 'pytest'] : ['js']).toContain(warmup!.check.harness);
      expect({ suite, transform: warmup!.check.transform })
        .toEqual({ suite, transform: /\.tsx?$/.test(suite) });
    });
  }

  it('says on the project meta whether a pack has one', () => {
    for (const project of content.listProjects()) {
      expect(content.getProject(project.slug).warmup ?? null).not.toBeNull();
    }
  });
});
