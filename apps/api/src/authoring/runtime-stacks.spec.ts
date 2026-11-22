import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RUNTIME_PROFILES, SUPPORTED_STACKS_SENTENCE } from '@learnsdlc/shared';
import { config } from '../config';
import type { RuntimeSpec } from '../content/content.types';
import {
  bakedRuntimeProfile,
  forgetSupportedStacks,
  readSupportedStacks,
  runtimeProfileRefusals,
  unsupportedPackages,
} from './runtime-stacks';

/**
 * What a teacher may name, read off the runner's own manifest.
 *
 * The allow-lists exist once, in `apps/api/runner/runtime_manifest.py`, because
 * that file is what the image bakes and what the sandbox imports. A second copy
 * in TypeScript would be a list that drifts the first time somebody adds a
 * package, and the version it refused would be a version the runner could
 * actually have run, or worse, the other way round.
 *
 * `scripts/prebake.mjs` is the wrong reader and is deliberately not used: it
 * walks the content directory off disk, and a teacher's project is rows.
 */
describe('the supported stacks', () => {
  it('are the three allow-lists the runner bakes, counted', () => {
    const stacks = readSupportedStacks();

    expect(stacks.python).toHaveLength(12);
    expect(stacks.python).toContain('flask');
    expect(stacks.python).toContain('pytest');
    expect(stacks.node).toHaveLength(6);
    expect(stacks.node).toContain('react');
    expect(stacks.node).toContain('@testing-library/react');
    expect(stacks.tools).toEqual(['esbuild']);
    expect(stacks.sentence).toBe(SUPPORTED_STACKS_SENTENCE);
  });

  it('are read from the manifest the runner imports, not from a copy', () => {
    const manifest = path.join(config.runnerDir, 'runtime_manifest.py');
    const source = fs.readFileSync(manifest, 'utf-8');
    const stacks = readSupportedStacks(manifest);

    for (const name of [...stacks.python, ...stacks.node, ...stacks.tools]) {
      expect(source).toContain(`"${name}"`);
    }
  });

  it('refuses a manifest that has lost one of the three lists, by name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-stacks-'));
    const at = path.join(dir, 'runtime_manifest.py');
    fs.writeFileSync(at, 'ALLOWED_PYTHON = frozenset({"flask"})\n', 'utf-8');

    expect(() => readSupportedStacks(at)).toThrow(/ALLOWED_NODE/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names every package outside the lists, in the ecosystem it was measured against', () => {
    const stacks = readSupportedStacks();

    expect(
      unsupportedPackages(
        { python: { version: '3.11', packages: ['flask==3.0.3', 'pytest==8.0.0'] } },
        stacks,
      ),
    ).toEqual([]);

    expect(
      unsupportedPackages(
        {
          python: { version: '3.11', packages: ['pandas==2.2.0'] },
          node: { version: '20', packages: { vue: '3.4.0' }, tools: { webpack: '5.0.0' } },
        },
        stacks,
      ),
    ).toEqual([
      { ecosystem: 'python', name: 'pandas' },
      { ecosystem: 'node', name: 'vue' },
      { ecosystem: 'tools', name: 'webpack' },
    ]);
  });

  it('has nothing to say about a project that declares no runtime block', () => {
    expect(unsupportedPackages(null, readSupportedStacks())).toEqual([]);
    expect(unsupportedPackages(undefined, readSupportedStacks())).toEqual([]);
  });
});

/**
 * The one runtime profile, `baked`.
 *
 * A teacher's upload names a runtime block. The deployment can run exactly one
 * stack (the three allow-lists the runner image bakes) so the profile is a
 * name over those lists, and a block outside it is refused at upload and again
 * at publish, naming every package that is outside. Nothing here edits the
 * runner: every list, pin form and esbuild version is read off the file the
 * sandbox imports, and the digest test works on a temporary copy of it.
 */
describe('the baked runtime profile', () => {
  const RUNNER_MANIFEST = path.join(config.runnerDir, 'runtime_manifest.py');
  const TASKTRACKR_PROJECT = path.resolve(
    config.runnerDir,
    '..',
    '..',
    '..',
    'content',
    'tasktrackr',
    'project.json',
  );
  const tasktrackrRuntime = (): RuntimeSpec =>
    (JSON.parse(fs.readFileSync(TASKTRACKR_PROJECT, 'utf-8')) as { runtime: RuntimeSpec }).runtime;

  const outside = (ecosystem: string, pkg: string, reason: string) => ({
    code: 'RUNTIME_OUTSIDE_PROFILE',
    package: pkg,
    ecosystem,
    reason,
  });

  afterEach(() => forgetSupportedStacks());

  it('refuses a Python package outside ALLOWED_PYTHON, naming the package', () => {
    expect(
      runtimeProfileRefusals({
        python: { version: '3.11', packages: ['flask==3.1.3', 'pandas==2.2.0', 'numpy==2.0.0'] },
      }),
    ).toEqual([
      outside('python', 'pandas', 'not-in-profile'),
      outside('python', 'numpy', 'not-in-profile'),
    ]);
  });

  it('refuses a Node package and a tool outside the profile, naming each', () => {
    expect(
      runtimeProfileRefusals({
        node: {
          version: '22',
          packages: { react: '18.3.1', vue: '3.4.0' },
          tools: { esbuild: '0.25.0', webpack: '5.0.0' },
        },
      }),
    ).toEqual([outside('node', 'vue', 'not-in-profile'), outside('tools', 'webpack', 'not-in-profile')]);
  });

  it('refuses a version pin outside the manifest pin form, naming the package', () => {
    expect(
      runtimeProfileRefusals({
        python: {
          version: '3.11',
          packages: ['flask>=3.0', 'pytest', 'Jinja2==3.1.6', 'click==latest', 'werkzeug==3.1.8'],
        },
        node: {
          version: '22',
          packages: { react: '^18.3.1', 'react-dom': '18.3', jsdom: '25.0.1' },
          tools: { esbuild: '0.23.0' },
        },
      }),
    ).toEqual([
      outside('python', 'flask>=3.0', 'pin-form'),
      outside('python', 'pytest', 'pin-form'),
      outside('python', 'Jinja2', 'pin-form'),
      outside('python', 'click', 'pin-form'),
      outside('node', 'react', 'pin-form'),
      outside('node', 'react-dom', 'pin-form'),
      // esbuild 0.23.0 is an exact version, but no reviewed checksum exists for it
      outside('tools', 'esbuild', 'pin-form'),
    ]);
  });

  it('refuses a runtime block the profile cannot read, never throws on it', () => {
    const hostile = {
      ruby: { version: '3.3', packages: ['rails==7.1.0'] },
      python: { version: '3.11', packages: 'flask==3.1.3' },
      node: { version: '22', packages: ['react'], tools: { esbuild: 25 } },
    } as unknown as RuntimeSpec;

    expect(runtimeProfileRefusals(hostile)).toEqual([
      outside('python', 'python.packages', 'pin-form'),
      outside('node', 'node.packages', 'pin-form'),
      outside('tools', 'esbuild', 'pin-form'),
      outside('runtime', 'ruby', 'not-in-profile'),
    ]);

    const entries = JSON.parse(
      '{"python":{"version":"3.11","packages":[{"toString":"x"},7,"flask==3.1.3"]},' +
        '"node":{"version":"22","packages":{"__proto__":"1.0.0","react":{"toString":"x"}}}}',
    ) as RuntimeSpec;
    expect(runtimeProfileRefusals(entries)).toEqual([
      outside('python', 'python.packages[0]', 'pin-form'),
      outside('python', 'python.packages[1]', 'pin-form'),
      outside('node', '__proto__', 'not-in-profile'),
      outside('node', 'react', 'pin-form'),
    ]);
    expect(runtimeProfileRefusals('python' as unknown as RuntimeSpec)).toEqual([
      outside('runtime', 'runtime', 'not-in-profile'),
    ]);
  });

  it('GUARD: passes TaskTrackr’s runtime block and every shape a teacher’s copy carries', () => {
    // A teacher's copy of a project carries its source version's `manifest.runtime` unchanged
    // (`importer.service.ts` writes it; the copy clones the manifest), so its
    // shapes are TaskTrackr's block, a structural clone of it, and the
    // runtime-free block of a project that bakes nothing.
    const reference = tasktrackrRuntime();
    expect(reference.python?.packages.length).toBeGreaterThan(0);
    expect(runtimeProfileRefusals(reference)).toEqual([]);
    expect(runtimeProfileRefusals(JSON.parse(JSON.stringify(reference)) as RuntimeSpec)).toEqual([]);
    expect(runtimeProfileRefusals(null)).toEqual([]);
    expect(runtimeProfileRefusals(undefined)).toEqual([]);
    // A subset of the baked pins is the honest neighbour of a copy; a pin the
    // deployment does not bake (such as `flask==3.0.3`) is refused below.
    expect(runtimeProfileRefusals({ python: { version: '3.11', packages: ['flask==3.1.3'] } })).toEqual([]);
  });

  it('GUARD: readSupportedStacks and unsupportedPackages answer from the runner’s allow-lists', () => {
    const stacks = readSupportedStacks();
    expect([...stacks.python].sort()).toEqual(
      [
        'blinker', 'click', 'flask', 'iniconfig', 'itsdangerous', 'jinja2',
        'markupsafe', 'packaging', 'pluggy', 'pygments', 'pytest', 'werkzeug',
      ],
    );
    expect([...stacks.node].sort()).toEqual([
      '@testing-library/dom', '@testing-library/react', 'jsdom', 'react', 'react-dom', 'react-router-dom',
    ]);
    expect(stacks.tools).toEqual(['esbuild']);
    expect(Object.keys(stacks).sort()).toEqual(['node', 'python', 'sentence', 'tools']);
    // the same object on a second read: still memoised per path
    expect(readSupportedStacks()).toBe(stacks);

    // Answers recorded before the runtime profile existed. Pin form is not
    // this function's question.
    expect(unsupportedPackages(tasktrackrRuntime(), stacks)).toEqual([]);
    expect(
      unsupportedPackages(
        {
          python: { version: '3.11', packages: ['Flask==3.0.3', 'pytest', 'flask>=3.0', 'pandas==2.2.0'] },
          node: { version: '22', packages: { react: '^18.3.1', vue: '3.4.0' }, tools: { esbuild: '0.23.0' } },
        },
        stacks,
      ),
    ).toEqual([
      { ecosystem: 'python', name: 'flask>=3.0' },
      { ecosystem: 'python', name: 'pandas' },
      { ecosystem: 'node', name: 'vue' },
    ]);
  });

  it('is one profile, `baked`, named, over the lists readSupportedStacks reads', () => {
    const stacks = readSupportedStacks();
    const profile = bakedRuntimeProfile();

    expect(profile.id).toBe('baked');
    expect(profile.name.length).toBeGreaterThan(0);
    expect(profile.python).toEqual([...stacks.python].sort());
    expect(profile.node).toEqual([...stacks.node].sort());
    expect(profile.tools).toEqual([...stacks.tools].sort());
    expect(profile.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(profile.sentence).toBe(SUPPORTED_STACKS_SENTENCE);
    // the contract's optional uploadMaxBytes is served too
    expect(Object.keys(profile).sort()).toEqual(
      ['id', 'manifestSha256', 'name', 'node', 'python', 'sentence', 'tools', 'uploadMaxBytes'],
    );
    expect(bakedRuntimeProfile()).toEqual(profile);
  });

  it('deep-equals RUNTIME_PROFILES[0] on everything the contract names, adding only the read lists, digest and archive cap', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { manifestSha256, python, node, tools, uploadMaxBytes, ...named } = bakedRuntimeProfile();
    expect(RUNTIME_PROFILES).toHaveLength(1);
    expect(named).toEqual(RUNTIME_PROFILES[0]);
    expect([manifestSha256.length, python.length, node.length, tools.length]).toEqual([64, 12, 6, 1]);
  });

  it('has a digest that changes if and only if an allow-list changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-profile-'));
    try {
      const source = fs.readFileSync(RUNNER_MANIFEST, 'utf-8');
      const write = (name: string, text: string): string => {
        const at = path.join(dir, name, 'runtime_manifest.py');
        fs.mkdirSync(path.dirname(at), { recursive: true });
        fs.writeFileSync(at, text, 'utf-8');
        return at;
      };
      const digestOf = (at: string): string => bakedRuntimeProfile(at).manifestSha256;
      const real = bakedRuntimeProfile().manifestSha256;

      // the copy is the same profile
      expect(digestOf(write('copy', source))).toBe(real);

      // not an allow-list change: order inside a set, a comment, an esbuild checksum
      const reordered = source
        .replace('    "flask",\n    "werkzeug",\n', '    "werkzeug",\n    "flask",\n')
        .replace('ALLOWED_TOOLS = frozenset', '# a reviewed comment\nALLOWED_TOOLS = frozenset')
        .replace(/"9e297058b6101e29[0-9a-f]+"/, `"${'0'.repeat(64)}"`);
      expect(reordered).not.toBe(source);
      expect(digestOf(write('reordered', reordered))).toBe(real);

      // an allow-list change, on each of the three lists
      const addedPython = source.replace('    "pygments",\n', '    "pygments",\n    "requests",\n');
      const removedNode = source.replace('    "jsdom",\n', '');
      const addedTool = source.replace('frozenset({"esbuild"})', 'frozenset({"esbuild", "swc"})');
      const moved = source
        .replace('    "pygments",\n', '    "pygments",\n    "jsdom",\n')
        .replace('    "jsdom",\n    "@testing', '    "@testing');
      const variants = [addedPython, removedNode, addedTool, moved];
      const digests = variants.map((text, i) => {
        expect(text).not.toBe(source);
        return digestOf(write(`changed-${i}`, text));
      });
      for (const one of digests) expect(one).not.toBe(real);
      expect(new Set(digests).size).toBe(digests.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the pin forms off the runner manifest, not a copy, and refuses a manifest without them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-profile-'));
    try {
      const source = fs.readFileSync(RUNNER_MANIFEST, 'utf-8');
      const at = path.join(dir, 'runtime_manifest.py');
      fs.writeFileSync(at, source.replace(/^PYTHON_SPEC = .*$/m, ''), 'utf-8');
      expect(() => runtimeProfileRefusals({ python: { version: '3.11', packages: ['flask==3.1.3'] } }, at)).toThrow(
        /PYTHON_SPEC/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
   * A name the image bakes is not enough. The runner
   * puts one baked layer on the path whatever a block declares, so a block
   * that pins a version the layer does not hold would publish and then run
   * against versions its author never wrote against. The versions are the
   * hash-locked ones in `apps/api/runner/runtime-locks/*`; the interpreters and
   * the tool versions are the content packs' merged block that
   * `scripts/prebake.mjs` bakes from.
   */
  it('refuses a package, tool or interpreter version the deployment does not bake, naming it', () => {
    expect(
      runtimeProfileRefusals({
        python: { version: '2.7', packages: ['flask==2.0.0', 'pytest==9.0.3'] },
        node: {
          version: '18',
          packages: { react: '17.0.2', 'react-dom': '18.3.1' },
          // 0.24.2 has a reviewed checksum, but the layer bakes 0.25.0
          tools: { esbuild: '0.24.2' },
        },
      }),
    ).toEqual([
      outside('python', 'python@2.7', 'not-in-profile'),
      outside('python', 'flask==2.0.0', 'not-in-profile'),
      outside('node', 'node@18', 'not-in-profile'),
      outside('node', 'react@17.0.2', 'not-in-profile'),
      outside('tools', 'esbuild@0.24.2', 'not-in-profile'),
    ]);
  });

  it('refuses the same Python package pinned twice, naming it once per extra pin', () => {
    expect(
      runtimeProfileRefusals({
        python: { version: '3.11', packages: ['flask==3.1.3', 'flask==3.0.0', 'pytest==9.0.3', 'flask==3.1.3'] },
      }),
    ).toEqual([outside('python', 'flask', 'pin-form'), outside('python', 'flask', 'pin-form')]);
  });

  it('refuses an interpreter version it cannot read and a nested key the profile has no meaning for', () => {
    const hostile = JSON.parse(
      '{"python":{"version":3.11,"packages":["flask==3.1.3"],"index_url":"x"},' +
        '"node":{"packages":{"react":"18.3.1"},"registry":"x","tools":{}}}',
    ) as RuntimeSpec;
    expect(runtimeProfileRefusals(hostile)).toEqual([
      outside('python', 'python.version', 'pin-form'),
      outside('python', 'python.index_url', 'not-in-profile'),
      outside('node', 'node.version', 'pin-form'),
      outside('node', 'node.registry', 'not-in-profile'),
    ]);
  });

  it('reads the baked versions off the locks and the content packs, not a copy, and refuses to guess without them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-profile-'));
    try {
      const runner = path.join(dir, 'runner');
      const locks = path.join(runner, 'runtime-locks');
      const content = path.join(dir, 'content', 'pack');
      fs.mkdirSync(locks, { recursive: true });
      fs.mkdirSync(content, { recursive: true });
      const at = path.join(runner, 'runtime_manifest.py');
      fs.copyFileSync(RUNNER_MANIFEST, at);
      const realLocks = path.join(config.runnerDir, 'runtime-locks');
      fs.writeFileSync(
        path.join(locks, 'python-requirements.txt'),
        fs
          .readFileSync(path.join(realLocks, 'python-requirements.txt'), 'utf-8')
          .replace(/^flask==3\.1\.3 /m, 'flask==3.1.4 '),
        'utf-8',
      );
      const pkg = JSON.parse(fs.readFileSync(path.join(realLocks, 'package.json'), 'utf-8')) as {
        dependencies: Record<string, string>;
      };
      pkg.dependencies.react = '18.3.2';
      fs.writeFileSync(path.join(locks, 'package.json'), JSON.stringify(pkg), 'utf-8');
      const block = tasktrackrRuntime();
      if (block.python) block.python.version = '3.12';
      if (block.node) block.node.tools = { esbuild: '0.24.2' };
      fs.writeFileSync(path.join(content, 'project.json'), JSON.stringify({ runtime: block }), 'utf-8');

      const contentDir = path.dirname(content);
      expect(
        runtimeProfileRefusals(
          {
            python: { version: '3.11', packages: ['flask==3.1.3', 'pytest==9.0.3'] },
            node: { version: '22', packages: { react: '18.3.1' }, tools: { esbuild: '0.25.0' } },
          },
          at,
          contentDir,
        ),
      ).toEqual([
        outside('python', 'python@3.11', 'not-in-profile'),
        outside('python', 'flask==3.1.3', 'not-in-profile'),
        outside('node', 'react@18.3.1', 'not-in-profile'),
        outside('tools', 'esbuild@0.25.0', 'not-in-profile'),
      ]);
      expect(
        runtimeProfileRefusals(
          {
            python: { version: '3.12', packages: ['flask==3.1.4'] },
            node: { version: '22', packages: { react: '18.3.2' }, tools: { esbuild: '0.24.2' } },
          },
          at,
          contentDir,
        ),
      ).toEqual([]);

      // no lock, or no pack that declares a runtime: a broken deployment, said by name
      fs.rmSync(path.join(locks, 'package.json'));
      forgetSupportedStacks(); // memoised like the lists: the layer never moves under a running API
      expect(() => runtimeProfileRefusals({ node: { version: '22', packages: {}, tools: {} } }, at, contentDir)).toThrow(
        /package\.json/,
      );
      const empty = path.join(dir, 'empty-content');
      fs.mkdirSync(empty);
      fs.copyFileSync(path.join(realLocks, 'package.json'), path.join(locks, 'package.json'));
      expect(() => runtimeProfileRefusals({ node: { version: '22', packages: {}, tools: {} } }, at, empty)).toThrow(
        /runtime block/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /* ---- the archive cap rides on the profile ---- */
  it('the runtime profile carries the configured archive cap', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { COHORT_IMPORT_MAX_BYTES } = require('@learnsdlc/shared') as typeof import('@learnsdlc/shared');
    const held = process.env.IMPORT_MAX_BYTES;
    try {
      process.env.IMPORT_MAX_BYTES = '1234567';
      expect(bakedRuntimeProfile().uploadMaxBytes).toBe(1234567);
      // the archive's bytes, as UploadService caps them, never the base64 body
      delete process.env.IMPORT_MAX_BYTES;
      expect(bakedRuntimeProfile().uploadMaxBytes).toBe(COHORT_IMPORT_MAX_BYTES);
    } finally {
      if (held === undefined) delete process.env.IMPORT_MAX_BYTES;
      else process.env.IMPORT_MAX_BYTES = held;
    }
  });
});
