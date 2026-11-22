import * as fs from 'fs';
import * as path from 'path';
import { UPLOAD_WHERE_NAMES } from '@learnsdlc/shared';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import { LAYOUT_SENTENCES } from '../content/folder-layout';
import { layoutFromManifest } from '../content/legacy-layout';
import { MemoryPackSource } from '../content/memory-pack-source';
import { DirectoryPackSource } from '../content/pack-source';
import { entriesOf } from '../../test/fixtures/upload-packs/archive';
import {
  RUN_SHAPE_CODES,
  buildPackManifest,
  checkLoadedPack,
  checkPackFiles,
  checkPackRuns,
  checkRunLimits,
  checkRuntimeProfile,
  checkUploadShape,
  type PackRefusal,
  type RawPackManifest,
} from './upload-limits';

/**
 * The limits an uploaded pack is held to before a row is
 * written, and again at publish (publish re-runs `checkPackRuns` and
 * `checkRunLimits`).
 *
 * The first block is the run-shape rule's cases: TaskTrackr's real pack, read
 * only, passes; each hostile variant is refused with its code and a sentence
 * that names where the run failed. The two limit codes live in
 * `checkRunLimits`, which reads the learner limit from config, so these
 * cases ask both functions together.
 */

const REPO = path.resolve(__dirname, '../../../..');
const PACK = path.join(REPO, 'content', 'tasktrackr');

/**
 * TaskTrackr on disk, in the folder layout, read the way the upload door reads
 * an archive (`buildPackManifest`), with its warm-up set beside it. The door
 * reads no phase of a pack that holds a `warmup/` folder (the shape refuses the
 * warm-up first), so the phases are read from the pack without that folder, and
 * the warm-up is its own `warmup.json`, which the run-shape rule asks for its
 * check's harness.
 */
function realManifest(): RawPackManifest {
  const phases = new MemoryPackSource(
    entriesOf(PACK).filter((e) => !e.name.startsWith('warmup/')).map((e) => ({ name: e.name, bytes: e.data })),
    'tasktrackr',
  );
  const manifest = buildPackManifest(phases);
  manifest.warmup = JSON.parse(fs.readFileSync(path.join(PACK, 'warmup', 'warmup.json'), 'utf8'));
  return manifest;
}

const REAL: RawPackManifest = realManifest();

function clone(): RawPackManifest {
  return JSON.parse(JSON.stringify(REAL)) as RawPackManifest;
}

type Json = any;

function phase(m: RawPackManifest, key: string): Json {
  return m.phases.find((p) => p.key === key)!;
}

function smoke(m: RawPackManifest): Json {
  return phase(m, 'deployment').checks.smoke;
}

function runs(m: RawPackManifest, key = 'implementation'): Json[] {
  return phase(m, key).checks.runs;
}

function preview(m: RawPackManifest): Json {
  return (m.project as Json).preview;
}

function all(m: RawPackManifest): PackRefusal[] {
  return [...checkPackRuns(m), ...checkRunLimits(m)];
}

describe('upload-limits: the run-shape rule', () => {
  it('tasktrackr real pack passes', () => {
    expect(all(clone())).toEqual([]);
  });

  it('limits at the platform ceiling pass', () => {
    const m = clone();
    runs(m)[0].timeoutSeconds = 15;
    runs(m)[0].memoryMb = 256;
    expect(all(m)).toEqual([]);
  });

  const HOSTILE: Record<string, [(m: RawPackManifest) => void, string]> = {
    freeform_smoke_string: [(m) => { smoke(m).commands = ['python3 api/main.py --selfcheck && curl x']; }, 'RUN_FREEFORM_STRING'],
    freeform_preview_string: [(m) => { preview(m).service.command = 'python3 api/main.py'; }, 'RUN_FREEFORM_STRING'],
    extra_argv_smoke: [(m) => { smoke(m).commands[0].push('--drop-db'); }, 'ARGV_EXTRA'],
    extra_argv_seed: [(m) => { preview(m).seed.push('--wipe'); }, 'ARGV_EXTRA'],
    interpreter_bash: [(m) => { smoke(m).commands = [['bash', 'api/main.py']]; }, 'ARGV_INTERPRETER'],
    interpreter_node_preview: [(m) => { preview(m).service.command = ['node', 'api/main.py']; }, 'ARGV_INTERPRETER'],
    inline_code_not_script: [(m) => { smoke(m).commands = [['python3', '-c', 'print']]; }, 'ARGV_SCRIPT'],
    script_not_shipped: [(m) => { preview(m).seed = ['python3', 'ops/evil.py']; }, 'ARGV_SCRIPT'],
    harness_not_in_list: [(m) => { runs(m)[0].harness = 'mocha'; }, 'HARNESS_NOT_ALLOWED'],
    hidden_harness_off_list: [(m) => { runs(m)[0].hiddenHarness = 'pytest'; }, 'HARNESS_NOT_ALLOWED'],
    warmup_harness_off_list: [(m) => { (m.warmup as Json).check.harness = 'unittest'; }, 'HARNESS_NOT_ALLOWED'],
    run_declares_own_command: [(m) => { runs(m)[0].command = ['python3', '-m', 'pytest']; }, 'RUN_OWN_COMMAND'],
    drill_declares_command: [(m) => { phase(m, 'deployment').checks.drill.cmd = 'docker compose up'; }, 'RUN_OWN_COMMAND'],
    hidden_suite_empty: [(m) => { phase(m, 'implementation').hiddenTestFiles.api = []; }, 'HIDDEN_NOT_FILE'],
    hidden_suite_is_script: [(m) => { phase(m, 'implementation').hiddenTestFiles.api = ['hidden_tests/api/grade.sh']; }, 'HIDDEN_NOT_FILE'],
    hidden_dir_escapes: [(m) => { runs(m, 'maintenance')[1].hiddenTestDir = '../../etc'; }, 'HIDDEN_NOT_FILE'],
    timeout_above_limit: [(m) => { runs(m)[0].timeoutSeconds = 120; }, 'LIMIT_TIMEOUT'],
    memory_above_limit: [(m) => { smoke(m).memoryMb = 2048; }, 'LIMIT_MEMORY'],
    shell_meta_smoke: [(m) => { smoke(m).commands[0][2] = '--selfcheck;rm'; }, 'ARGV_SHELL'],
    shell_meta_preview: [(m) => { preview(m).service.command = ['python3', 'api/main.py|nc']; }, 'ARGV_SHELL'],
    shell_subst_seed: [(m) => { preview(m).seed = ['python3', '$(id)']; }, 'ARGV_SHELL'],
  };

  it('ports exactly the 21 hostile variants', () => {
    expect(Object.keys(HOSTILE)).toHaveLength(21);
  });

  for (const name of Object.keys(HOSTILE).sort()) {
    it(`hostile variant is refused with named sentence: ${name}`, () => {
      const [mutate, code] = HOSTILE[name];
      const m = clone();
      mutate(m);
      const refusals = all(m);
      expect(refusals.map((r) => r.code)).toContain(code);
      const hit = refusals.find((r) => r.code === code)!;
      expect(hit.where).toBeTruthy();
      expect(hit.sentence).toContain(hit.where);
      expect(hit.sentence.endsWith('.')).toBe(true);
      expect(RUN_SHAPE_CODES).toContain(hit.code);
    });
  }
});

describe('HIDDEN_NOT_FILE asks door-rules’ isHiddenTestName for its answers', () => {
  const hiddenWith = (files: string[], key = 'implementation', run = 'api'): PackRefusal[] => {
    const m = clone();
    phase(m, key).hiddenTestFiles[run] = files;
    return checkPackRuns(m).filter((r) => r.code === 'HIDDEN_NOT_FILE');
  };
  it('a python run: test_*.py passes; extra_test.py, helpers.py, a .test.ts file and a test_*.pyc are refused', () => {
    expect(hiddenWith(['hidden_tests/api/test_extra.py'])).toEqual([]);
    for (const bad of ['hidden_tests/api/extra_test.py', 'hidden_tests/api/helpers.py', 'hidden_tests/api/a.test.ts', 'hidden_tests/api/test_a.pyc']) {
      expect([bad, hiddenWith(['hidden_tests/api/test_extra.py', bad]).length]).toEqual([bad, 1]);
    }
  });
  it("says where a hidden suite sits in the folder layout, its run's folder under hidden_tests/, and names no pointer member", () => {
    const [empty] = hiddenWith([]);
    expect(empty.sentence).toBe(
      "phases[implementation].checks.runs[0]'s hidden suite must be test files the runner executes with its own fixed command (test_*.py or *.test.ts[x]) in the run's folder under hidden_tests/; it holds no files.",
    );
    const [helper] = hiddenWith(['hidden_tests/api/test_extra.py', 'hidden_tests/api/helpers.py']);
    expect(helper.sentence).toMatch(/in the run's folder under hidden_tests\/; 1 of its 2 files are not test files\.$/);
    for (const one of [empty, helper]) expect(one.sentence).not.toMatch(/hiddenTestDir/);
  });
  it('a typescript run: *.test.ts[x] passes; a .spec.ts and a test_*.py are refused', () => {
    const m = clone();
    const web = runs(m).find((run) => run.language === 'typescript');
    expect(web).toBeTruthy();
    const ok = (files: string[]): PackRefusal[] => {
      const mm = clone();
      phase(mm, 'implementation').hiddenTestFiles[web.id] = files;
      return checkPackRuns(mm).filter((r) => r.code === 'HIDDEN_NOT_FILE');
    };
    expect(ok(['hidden_tests/web/a.test.ts', 'hidden_tests/web/b.test.tsx'])).toEqual([]);
    expect(ok(['hidden_tests/web/a.test.ts', 'hidden_tests/web/extra.spec.ts'])).toHaveLength(1);
    expect(ok(['hidden_tests/web/test_a.py'])).toHaveLength(1);
  });
});

describe('upload-limits: the learner limit', () => {
  it('a run declaring more time or memory than the learner limit is refused', () => {
    const m = clone();
    runs(m)[0].timeoutSeconds = config.runTimeoutSeconds + 1;
    runs(m, 'maintenance')[0].memoryMb = config.runMemoryMb + 1;
    const codes = checkRunLimits(m).map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['LIMIT_TIMEOUT', 'LIMIT_MEMORY']));
    // The limit is the configured one, not a constant: a lower learner limit refuses more.
    const tight = clone();
    runs(tight)[0].timeoutSeconds = 10;
    expect(checkRunLimits(tight, { timeoutSeconds: 9, memoryMb: 256 }).map((r) => r.code)).toEqual(['LIMIT_TIMEOUT']);
    expect(checkRunLimits(tight, { timeoutSeconds: 10, memoryMb: 256 })).toEqual([]);
  });

  it('a limit that is not a positive whole number is refused, never read as no limit', () => {
    for (const bad of [0, -1, 1.5, '15', true, null]) {
      const m = clone();
      runs(m)[0].timeoutSeconds = bad;
      expect(checkRunLimits(m).map((r) => r.code)).toEqual(['LIMIT_TIMEOUT']);
    }
  });

  it('a key that only shares a name with Object.prototype is not a limit key (no false refusal, at upload or at publish)', () => {
    const m = clone();
    preview(m).env = { toString: 'x', constructor: 'y', valueOf: 'z', hasOwnProperty: 'w' };
    runs(m)[0].toLocaleString = 'x';
    expect(checkRunLimits(m)).toEqual([]);
    // the four real limit keys are still read, own keys only
    const real = clone();
    preview(real).env = { timeout: 600, memory: 4096 };
    expect(checkRunLimits(real).map((r) => r.code).sort()).toEqual(['LIMIT_MEMORY', 'LIMIT_TIMEOUT']);
  });
});

describe('upload-limits: the rest of the upload wall', () => {
  const files = (tree: Record<string, string>) =>
    new MemoryPackSource(Object.entries(tree).map(([name, text]) => ({ name, bytes: Buffer.from(text) })), 'pack');

  it('dot-env and secret-shaped files are refused outside canonical/.env.example', () => {
    expect(checkPackFiles(files({ 'project.json': '{}', 'canonical/.env.example': 'PORT=1\n' }))).toEqual([]);
    const cases: Record<string, string> = {
      'canonical/.env': 'SECRET=1\n',
      'canonical/.env.local': 'SECRET=1\n',
      'canonical/.envrc': 'export SECRET=1\n',
      'canonical/deploy/prod.env': 'SECRET=1\n',
      'canonical/config.env': 'SECRET=1\n',
      'phases/05-deployment/files/.env.example': 'PORT=1\n',
      'canonical/deploy/server.pem': 'x',
      'canonical/.ssh/id_ed25519': 'x',
      'canonical/id_rsa': 'x',
      'canonical/.npmrc': '//registry/:_authToken=x\n',
      'canonical/.aws/credentials': '[default]\n',
      'canonical/.git/config': '[remote]\n',
      'canonical/api/settings.py': '-----BEGIN RSA PRIVATE KEY-----\nMIIx\n-----END RSA PRIVATE KEY-----\n',
    };
    for (const [name, text] of Object.entries(cases)) {
      const refusals = checkPackFiles(files({ 'project.json': '{}', [name]: text }));
      expect({ name, codes: refusals.map((r) => r.code) }).toEqual({ name, codes: ['PACK_SECRET_FILE'] });
      // The sentence names where, never the file's bytes.
      expect(refusals[0].sentence).not.toContain('MIIx');
      expect(refusals[0].sentence).not.toContain('_authToken');
    }
  });

  it('TaskTrackr’s own files pass the secret wall', () => {
    expect(checkPackFiles(new DirectoryPackSource(PACK))).toEqual([]);
  });

  it('a pack declaring a warm-up is refused, because the warm-up loader reads the host disk', () => {
    expect(checkUploadShape(clone()).map((r) => r.code)).toContain('PACK_WARMUP_NOT_UPLOADABLE');
    const m = clone();
    delete (m.project as Json).warmup;
    m.warmup = null;
    expect(checkUploadShape(m)).toEqual([]);
  });

  it('more than one work task in an executable phase is refused with today’s EXECUTABLE_SPLIT_NOT_READY wording', () => {
    const m = clone();
    delete (m.project as Json).warmup;
    m.warmup = null;
    phase(m, 'implementation').tasks = [
      { taskKey: 'api', checkKind: 'code' },
      { taskKey: 'web', checkKind: 'code' },
      { taskKey: 'check', checkKind: 'quiz' },
    ];
    const refusals = checkUploadShape(m);
    expect(refusals.map((r) => r.code)).toEqual(['PACK_EXECUTABLE_SPLIT']);
    expect(refusals[0].sentence).toContain('Several tasks in a coding, testing or deployment phase arrive next.');
    // the count it names is the work tasks', not the quiz beside them
    expect(refusals[0].sentence).toContain('holds 2 tasks');
    // One work task beside a quiz is a legal shape.
    phase(m, 'implementation').tasks = [{ taskKey: 'main', checkKind: 'code' }, { taskKey: 'check', checkKind: 'quiz' }];
    expect(checkUploadShape(m)).toEqual([]);
  });

  it('a runtime outside the baked profile is refused through RP’s runtimeProfileRefusals', () => {
    const m = clone();
    const seen: unknown[] = [];
    const refusals = checkRuntimeProfile(m, (runtime) => {
      seen.push(runtime);
      return [{ code: 'RUNTIME_OUTSIDE_PROFILE', package: 'leftpad', ecosystem: 'node', reason: 'not-in-profile' }];
    });
    expect(seen).toEqual([(m.project as Json).runtime]);
    expect(refusals.map((r) => r.code)).toEqual(['RUNTIME_OUTSIDE_PROFILE']);
    expect(refusals[0].sentence).toContain('leftpad');
    expect(checkRuntimeProfile(m, () => [])).toEqual([]);
  });

  describe('on the loaded pack', () => {
    const content = new ContentService();
    const project = content.loadProject(new DirectoryPackSource(PACK));

    it('TaskTrackr passes decision 37’s byte rules and the budget ceiling (20 ≤ 24, each phase ≤ 10)', () => {
      expect(checkLoadedPack(project)).toEqual([]);
    });

    it('decision 37 rule 1: a workspace row holding a hidden-test blob is refused', () => {
      const leaked = structuredClone(project);
      const impl = leaked.phases.find((p) => p.key === 'implementation')!;
      const hiddenBytes = Object.values((impl.checks as Json).runs[0].hiddenTestFiles as Record<string, string>)[0];
      impl.files.push({ path: 'tests/test_leak.py', content: hiddenBytes, editable: false, language: 'python' } as Json);
      expect(checkLoadedPack(leaked).map((r) => r.code)).toContain('PACK_SEALED_BYTES');
    });

    it('decision 37 rule 2: an editable row holding a solution blob is refused', () => {
      const leaked = structuredClone(project);
      const impl = leaked.phases.find((p) => p.key === 'implementation')!;
      const solutionBytes = Object.values((impl.checks as Json).solutionFiles as Record<string, string>)[0];
      impl.files.push({ path: 'api/answer.py', content: solutionBytes, editable: true, language: 'python' } as Json);
      expect(checkLoadedPack(leaked).map((r) => r.code)).toContain('PACK_SEALED_BYTES');
    });

    it('a workspace file under a reserved prefix is PACK_RESERVED_PATH (its own code), never PACK_SEALED_BYTES', () => {
      const reserved = structuredClone(project);
      const impl = reserved.phases.find((p) => p.key === 'implementation')!;
      impl.files.push({ path: 'hidden/notes.md', content: '# Notes for the shelf\n', editable: false, language: null } as Json);
      const refusals = checkLoadedPack(reserved);
      expect(refusals.map((r) => r.code)).toEqual(['PACK_RESERVED_PATH']);
      expect(refusals[0].sentence).toContain('hidden/notes.md');
      expect(refusals[0].sentence).toContain('"hidden/"');
    });

    it('a version priced above the ceiling is refused, naming the phase and the count', () => {
      const pricey = structuredClone(project);
      const testing = pricey.phases.find((p) => p.key === 'testing')!;
      const mutants = (testing.checks as Json).mutants as Json[];
      while (mutants.length < 9) mutants.push({ ...mutants[0], name: `extra_${mutants.length}` });
      const refusals = checkLoadedPack(pricey);
      expect(refusals.map((r) => r.code)).toContain('PACK_OVER_BUDGET');
      const hit = refusals.find((r) => r.code === 'PACK_OVER_BUDGET')!;
      expect(hit.sentence).toMatch(/testing/);
      expect(hit.sentence).toMatch(/\b1[1-9]\b/);
    });
  });
});

describe('a where names only the keys the authoring format documents; a key the archive chose prints as (a key)', () => {
  const ownCommand = (m: RawPackManifest): PackRefusal[] => checkPackRuns(m).filter((r) => r.code === 'RUN_OWN_COMMAND');
  const limits = (m: RawPackManifest): PackRefusal[] => checkRunLimits(m);

  it('a command key under a key the archive chose: the chosen key is never printed, in the where or the sentence', () => {
    const m = clone();
    runs(m)[0].myInternalNote = { command: ['python3', 'x.py'] };
    phase(m, 'implementation').rest.teacherStuff = { run: 'make' };
    const found = ownCommand(m);
    expect(found.map((r) => r.where).sort()).toEqual([
      'phases[implementation].(a key).run',
      'phases[implementation].checks.runs[0].(a key).command',
    ]);
    for (const r of found) {
      expect(r.sentence).not.toMatch(/myInternalNote|teacherStuff/);
      expect(r.sentence).toContain(r.where);
    }
  });

  it('a limit under a key the archive chose: the chosen key is never printed', () => {
    const m = clone();
    preview(m).service.secretSauce = { timeoutSeconds: 99 };
    const found = limits(m).filter((r) => r.code === 'LIMIT_TIMEOUT');
    expect(found.map((r) => r.where)).toEqual(['project.preview.service.(a key).timeoutSeconds']);
    expect(found[0].sentence).not.toContain('secretSauce');
  });

  it('GUARD: documented keys and the manifest’s own names still print as themselves (the where the web already reads)', () => {
    const m = clone();
    runs(m)[0].command = ['python3', '-m', 'pytest'];
    phase(m, 'deployment').checks.drill.cmd = 'docker compose up';
    // The folder layout keeps a drill's faulted files under drill/, so its
    // phase.json has no faultedFiles; an archive that writes one anyway still
    // has it named as the documented key it is.
    phase(m, 'deployment').checks.drill.faultedFiles = { exec: 'x' };
    runs(m)[0].timeoutSeconds = 120;
    smoke(m).memoryMb = 2048;
    preview(m).service.timeout = 99;
    expect(ownCommand(m).map((r) => r.where).sort()).toEqual([
      'phases[deployment].checks.drill.cmd',
      'phases[deployment].checks.drill.faultedFiles.exec',
      'phases[implementation].checks.runs[0].command',
    ]);
    expect(limits(m).map((r) => r.where).sort()).toEqual([
      'phases[deployment].checks.smoke.memoryMb',
      'phases[implementation].checks.runs[0].timeoutSeconds',
      'project.preview.service.timeout',
    ]);
    // the allowed argv sites are still recognised as such (no RUN_OWN_COMMAND on them)
    expect(ownCommand(clone())).toEqual([]);
  });

  it('GUARD: a key that spells a site with a dot is still not the site (the comparison is by key, never by printed text)', () => {
    const m = clone();
    (m.project as Json)['preview.service'] = { command: ['python3', 'api/main.py'] };
    expect(ownCommand(m).map((r) => r.where)).toEqual(['project.(a key).command']);
  });

  it('GUARD: the API and the upload page print the same names, because both import UPLOAD_WHERE_NAMES from the shared package', () => {
    const sharedNames = (file: string): string[] => {
      const text = fs.readFileSync(path.join(REPO, file), 'utf8');
      return [...text.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'@learnsdlc\/shared';/gm)].flatMap((one) =>
        one[1].split(',').map((name) => name.trim()).filter(Boolean),
      );
    };
    const api = sharedNames('apps/api/src/authoring/upload-limits.ts');
    const web = sharedNames('apps/web/components/staff/projects/UploadProject.tsx');
    expect(api).toContain('UPLOAD_WHERE_NAMES');
    expect(web).toContain('UPLOAD_WHERE_NAMES');
    expect(UPLOAD_WHERE_NAMES.size).toBeGreaterThan(30);
  });
});

describe('buildPackManifest reads only the folder layout', () => {
  // Shelf whole in the older layout: project.json lists the phases, each phase.json its pointers.
  const OLDER_SHELF = path.join(REPO, 'apps', 'api', 'test', 'fixtures', 'older-shelf');
  const older = (): MemoryPackSource =>
    new MemoryPackSource(entriesOf(OLDER_SHELF).map((e) => ({ name: e.name, bytes: e.data })), 'shelf');

  it("refuses a project.json that lists phases in the layout's own sentence, and reads none of the archive's pointers", () => {
    expect(() => buildPackManifest(older())).toThrow(LAYOUT_SENTENCES.listsPhases);
  });

  it('reads an older archive once it is converted, as the upload door converts it, each hidden suite from hidden_tests/<run id>/', () => {
    const manifest = buildPackManifest(layoutFromManifest(older()).source);
    expect(manifest.phases.map((phase) => phase.key)).toEqual(['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance']);
    for (const phase of manifest.phases) {
      for (const [id, files] of Object.entries(phase.hiddenTestFiles)) {
        expect(files.length).toBeGreaterThan(0);
        for (const at of files) expect(at.startsWith(`hidden_tests/${id || 'main'}/`)).toBe(true);
      }
    }
    expect(checkPackRuns(manifest)).toEqual([]);
  });
});
