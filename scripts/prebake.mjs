#!/usr/bin/env node
/**
 * Build the sandbox's pre-baked dependency layer, or check the one that is here.
 *
 * A graded run has no network and no package manager: the runner container is
 * `network_mode: none` and the child's PATH holds three directories. So every
 * library a learner's code imports (Flask, pytest, React, jsdom) has to be on
 * disk before the first job arrives. This script is what puts it there:
 * `apps/api/runner/runtime/`, built once per machine, baked into the runner
 * image, and never touched during a job.
 *
 *   node scripts/prebake.mjs build    install what the packs declare
 *   node scripts/prebake.mjs verify   is what is here what the packs declare?
 *   node scripts/prebake.mjs print    the digest alone, for a CI cache key
 *   node scripts/prebake.mjs manifest write manifest.json only, install nothing
 *
 * `manifest` is for building the runner image on a machine that will never run
 * learner code itself (scripts/stack.sh, the Compose stack): the image needs
 * the manifest in its build context and installs every dependency inside the
 * image, for its own platform, so the host only has to say what to install.
 * It needs Python 3.11 (for the locks) and no network. `verify` on such a
 * machine fails until `build` has run, which is the truth: nothing is baked.
 *
 * What may be installed is not this script's decision. `apps/api/runner/
 * runtime_manifest.py` holds the allowlists, this script reads them from there
 * rather than keeping a second copy, and a pack that names a package outside
 * them is refused at `build`: adding a dependency to the sandbox is a code
 * change with a review, not a content edit.
 *
 * The versions come the other way round: the pack pins them exactly, because
 * the pack is what a learner's phase is written against. `verify` recomputes
 * the digest over those pins and compares it with the one recorded at build
 * time, so a pack that moved a version and a machine that never rebuilt are the
 * same, visible problem.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_MODULE = path.join(ROOT, 'apps/api/runner/runtime_manifest.py');
const DEPENDENCY_MODULE = path.join(ROOT, 'apps/api/runner/runtime_dependencies.py');

/** Where the packs are read from. The env var is the seam a test points elsewhere. */
const CONTENT_DIR = process.env.PREBAKE_CONTENT_DIR
  ? path.resolve(process.env.PREBAKE_CONTENT_DIR)
  : path.join(ROOT, 'content');

/** Where the bytes land. Same rule and same default as runtime_manifest.runtime_root(). */
const RUNTIME_DIR = process.env.RUNNER_RUNTIME_DIR
  ? path.resolve(process.env.RUNNER_RUNTIME_DIR)
  : path.join(ROOT, 'apps/api/runner/runtime');

const PYTHON_DIR = path.join(RUNTIME_DIR, 'python');
const NODE_DIR = path.join(RUNTIME_DIR, 'node');
const NODE_MODULES = path.join(NODE_DIR, 'node_modules');
const BIN_DIR = path.join(RUNTIME_DIR, 'bin');
const MANIFEST = path.join(RUNTIME_DIR, 'manifest.json');

const PYTHON = process.env.PYTHON_BIN || 'python3';

/**
 * The sentence the runner prints when nothing is baked. One wording, held in
 * four places that must change together: see PREBAKE_MISSING_MESSAGE in
 * apps/api/runner/sandbox_runner.py, which lists them.
 */
const MISSING = 'The sandbox dependencies are not built on this machine. Run npm run prebake.';

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function fail(lines) {
  for (const line of lines) process.stderr.write(`${line}\n`);
  process.exitCode = 1;
}

/* -------------------------------------------------------------------------- */
/* what the packs declare                                                      */
/* -------------------------------------------------------------------------- */

/** Every pack's `runtime` block, merged, with the pack each pin came from. */
function readRuntime() {
  const problems = [];
  const python = { version: '', packages: new Map() };
  const node = { version: '', packages: new Map(), tools: new Map() };
  let declared = false;

  let slugs = [];
  try {
    slugs = fs
      .readdirSync(CONTENT_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { declared: false, problems: [`no content directory at ${rel(CONTENT_DIR)}`] };
  }

  const pin = (into, key, value, slug, what) => {
    const existing = into.get(key);
    if (existing && existing.value !== value) {
      problems.push(
        `${what} ${key} is pinned to ${existing.value} by ${existing.slug} and to ${value} by ${slug}. ` +
          'One pre-baked layer serves every pack, so the two packs have to agree.',
      );
      return;
    }
    into.set(key, { value, slug });
  };

  for (const slug of slugs) {
    const file = path.join(CONTENT_DIR, slug, 'project.json');
    let project;
    try {
      project = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      problems.push(`${slug}/project.json is missing or invalid JSON.`);
      continue;
    }
    const runtime = project?.runtime;
    if (!runtime || typeof runtime !== 'object') continue;
    declared = true;

    const py = runtime.python || {};
    if (py.version && python.version && python.version !== py.version) {
      problems.push(
        `python is pinned to ${python.version} and to ${py.version} by ${slug}. ` +
          'One pre-baked layer serves every pack.',
      );
    }
    if (py.version) python.version = py.version;
    for (const spec of py.packages || []) {
      const name = String(spec).split('==')[0];
      pin(python.packages, name, String(spec), slug, 'the Python package');
    }

    const nd = runtime.node || {};
    if (nd.version && node.version && node.version !== nd.version) {
      problems.push(
        `node is pinned to ${node.version} and to ${nd.version} by ${slug}. ` +
          'One pre-baked layer serves every pack.',
      );
    }
    if (nd.version) node.version = nd.version;
    for (const [name, version] of Object.entries(nd.packages || {})) {
      pin(node.packages, name, String(version), slug, 'the Node package');
    }
    for (const [name, version] of Object.entries(nd.tools || {})) {
      pin(node.tools, name, String(version), slug, 'the tool');
    }
  }

  return {
    declared,
    problems,
    runtime: {
      python: {
        version: python.version,
        packages: [...python.packages.values()].map((entry) => entry.value),
      },
      node: {
        version: node.version,
        packages: Object.fromEntries([...node.packages].map(([k, v]) => [k, v.value])),
        tools: Object.fromEntries([...node.tools].map(([k, v]) => [k, v.value])),
      },
    },
  };
}

/** The allowlists and the checksums, read from the one module that holds them. */
function readAllowlist() {
  const probe = run(PYTHON, ['-I', MANIFEST_MODULE, 'print']);
  if (probe.status !== 0) {
    throw new Error(
      `could not read the allowlist from ${rel(MANIFEST_MODULE)}: ${(probe.stderr || '').trim()}`,
    );
  }
  return JSON.parse(probe.stdout);
}

/* -------------------------------------------------------------------------- */
/* the digest                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The exact lines the digest is taken over. `runtime_manifest.digest_lines`
 * builds the same list in Python, and a test asserts the two agree: a digest
 * the two ends disagree about is worse than no digest at all.
 */
function digestLines(runtime) {
  const python = runtime.python || {};
  const node = runtime.node || {};
  return [
    `python ${python.version || ''}`,
    ...[...(python.packages || [])].sort(),
    `node ${node.version || ''}`,
    ...Object.entries(node.packages || {})
      .map(([name, version]) => `${name}@${version}`)
      .sort(),
    ...Object.entries(node.tools || {})
      .map(([name, version]) => `tool:${name}@${version}`)
      .sort(),
  ];
}

function digestOf(runtime) {
  return createHash('sha256').update(`${digestLines(runtime).join('\n')}\n`).digest('hex');
}

function rel(target) {
  const relative = path.relative(ROOT, target);
  return relative.startsWith('..') ? target : relative;
}

/* -------------------------------------------------------------------------- */
/* platforms                                                                   */
/* -------------------------------------------------------------------------- */

function platformKey() {
  const system = { darwin: 'darwin', linux: 'linux' }[process.platform];
  const machine = { arm64: 'arm64', x64: 'x64' }[process.arch];
  if (!system || !machine) return null;
  const key = `${system}-${machine}`;
  return ['darwin-arm64', 'linux-x64', 'linux-arm64'].includes(key) ? key : null;
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* build                                                                       */
/* -------------------------------------------------------------------------- */

function checkAgainstAllowlist(runtime, allow) {
  const problems = [];
  for (const spec of runtime.python.packages) {
    const match = /^([a-z0-9][a-z0-9._-]*)==([0-9][0-9A-Za-z.+-]*)$/.exec(spec);
    if (!match) {
      problems.push(
        `"${spec}" is not a pinned Python package. Write it as name==version, for example flask==3.0.3.`,
      );
      continue;
    }
    if (!allow.python.includes(match[1])) {
      problems.push(
        `"${match[1]}" is not on the runner's Python allowlist. Adding a package to the sandbox ` +
          'is a code change: add it to ALLOWED_PYTHON in apps/api/runner/runtime_manifest.py with a review.',
      );
    }
  }
  const exact = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
  for (const [name, version] of Object.entries(runtime.node.packages)) {
    if (!allow.node.includes(name)) {
      problems.push(
        `"${name}" is not on the runner's Node allowlist. Adding a package to the sandbox is a ` +
          'code change: add it to ALLOWED_NODE in apps/api/runner/runtime_manifest.py with a review.',
      );
    } else if (!exact.test(version)) {
      problems.push(`"${name}" is pinned to "${version}", which is not an exact version. Write 18.3.1, not ^18.3.1.`);
    }
  }
  for (const [name, version] of Object.entries(runtime.node.tools)) {
    if (!allow.tools.includes(name)) {
      problems.push(
        `"${name}" is not on the runner's tool allowlist. A tool is a binary the sandbox hands ` +
          'untrusted input to: add it to ALLOWED_TOOLS in apps/api/runner/runtime_manifest.py with a review.',
      );
    } else if (name === 'esbuild' && !allow.esbuild.includes(version)) {
      problems.push(
        `esbuild ${version} has no reviewed checksum. Add one per platform to ESBUILD_CHECKSUMS ` +
          'in apps/api/runner/runtime_manifest.py.',
      );
    }
  }
  return problems;
}

/** One installer reads the reviewed full dependency locks on every platform. */
export function dependencyEnvironment(action, runtime, env = process.env) {
  const childEnv = { ...env };
  if (action !== 'install-node' || env.NODE_BIN === undefined) return childEnv;
  const invalid = () => new Error(`NODE_BIN must name an executable Node.js ${runtime.node.version} binary.`);
  let binary;
  try {
    if (!env.NODE_BIN || !path.isAbsolute(env.NODE_BIN)) throw invalid();
    binary = fs.realpathSync(env.NODE_BIN);
    if (!fs.statSync(binary).isFile()) throw invalid();
    fs.accessSync(binary, fs.constants.X_OK);
    // The existing installer invokes "node" and "npm" itself. Its PATH must
    // resolve node to this exact binary, including when NODE_BIN is a symlink.
    if (fs.realpathSync(path.join(path.dirname(binary), 'node')) !== binary) throw invalid();
  } catch {
    throw invalid();
  }
  const probeEnv = { ...env };
  delete probeEnv.NODE_OPTIONS;
  delete probeEnv.NODE_PATH;
  const probe = run(binary, ['--version'], { env: probeEnv, timeout: 5000, maxBuffer: 4096 });
  const version = (probe.stdout || '').trim().match(/^v(\d+)\.\d+\.\d+$/);
  if (probe.status !== 0 || probe.error || !version || version[1] !== String(runtime.node.version)) throw invalid();
  childEnv.PATH = [path.dirname(binary), ...(env.PATH || '').split(path.delimiter).filter(Boolean)].join(path.delimiter);
  return childEnv;
}

function dependencyCommand(action, runtime, target) {
  const args = ['-I', DEPENDENCY_MODULE, action];
  if (target) args.push('--target', target);
  return run(PYTHON, args, { input: JSON.stringify(runtime), stdio: ['pipe', 'pipe', 'pipe'],
    env: dependencyEnvironment(action, runtime) });
}

function dependencyLocks(runtime) {
  const result = dependencyCommand('locks', runtime);
  if (result.status !== 0) throw new Error((result.stderr || 'Runtime dependency locks are unavailable.').trim());
  return JSON.parse(result.stdout);
}

function installPython(runtime) {
  const result = dependencyCommand('install-python', runtime, PYTHON_DIR);
  if (result.status !== 0) return ['Python runtime installation failed.', (result.stderr || '').trim()];
  return [];
}

function installNode(runtime) {
  const result = dependencyCommand('install-node', runtime, NODE_DIR);
  if (result.status !== 0) return ['Node runtime installation failed.', (result.stderr || '').trim()];
  return [];
}

/**
 * The platform's esbuild, taken from `@esbuild/<platform>` rather than from
 * `esbuild` itself: the wrapper package's postinstall downloads a binary at
 * install time, and a download we did not check the checksum of is the thing
 * this function exists to avoid.
 */
function installEsbuild(runtime) {
  if (!runtime.node.tools.esbuild) return [];
  const result = dependencyCommand('install-esbuild', runtime, BIN_DIR);
  if (result.status !== 0) return ['esbuild installation failed.', (result.stderr || '').trim()];
  return [];
}

/** The record `verify` and infra/runner.Dockerfile both check the layer against. */
function writeManifest(runtime, locks) {
  const manifest = {
    builtAt: new Date().toISOString(),
    platform: platformKey(),
    python: runtime.python,
    node: { version: runtime.node.version, packages: runtime.node.packages },
    tools: runtime.node.tools,
    digest: digestOf(runtime),
    dependencyLocks: locks,
  };
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * The manifest alone, for an image build: the same checks `build` makes before
 * it installs anything, then the record, and nothing installed. A manifest
 * already here for the same digest is left as it is, so a machine that ran
 * `build` keeps the record of what it baked.
 */
function manifestOnly() {
  const packs = readRuntime();
  if (packs.problems?.length) return fail(packs.problems);
  if (!packs.declared) {
    process.stdout.write('No pack declares a runtime block, so there is no manifest to write.\n');
    return undefined;
  }
  const refused = checkAgainstAllowlist(packs.runtime, readAllowlist());
  if (refused.length) return fail(refused);
  const wanted = digestOf(packs.runtime);
  const locks = dependencyLocks(packs.runtime);
  try {
    const current = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    if (current.digest === wanted && JSON.stringify(current.dependencyLocks) === JSON.stringify(locks)) {
      process.stdout.write(`The manifest already records the packs. digest ${wanted}\n`);
      return undefined;
    }
  } catch {
    // no manifest yet, or not one this can read: write it
  }
  writeManifest(packs.runtime, locks);
  process.stdout.write(`Wrote ${rel(MANIFEST)} (nothing installed). digest ${wanted}\n`);
  return undefined;
}

function build() {
  const packs = readRuntime();
  if (packs.problems?.length) return fail(packs.problems);
  if (!packs.declared) {
    process.stdout.write('No pack declares a runtime block, so there is nothing to pre-bake.\n');
    return undefined;
  }
  const allow = readAllowlist();
  const refused = checkAgainstAllowlist(packs.runtime, allow);
  if (refused.length) return fail(refused);

  // Fail an explicitly misconfigured learner tool before installing Python or
  // changing the runtime directory. App/npm/build callers retain their Node.
  dependencyEnvironment('install-node', packs.runtime);
  const locks = dependencyLocks(packs.runtime);
  const prepared = dependencyCommand('prepare', packs.runtime, RUNTIME_DIR);
  if (prepared.status !== 0) return fail([(prepared.stderr || 'Runtime directory cannot be prepared.').trim()]);
  fs.rmSync(MANIFEST, { force: true });

  const problems = [
    ...installPython(packs.runtime),
    ...installNode(packs.runtime),
    ...installEsbuild(packs.runtime, allow),
  ];
  if (problems.length) return fail(problems);

  const manifest = writeManifest(packs.runtime, locks);
  const tools = Object.keys(packs.runtime.node.tools);
  process.stdout.write(
    `Pre-baked ${packs.runtime.python.packages.length} Python packages, ` +
      `${Object.keys(packs.runtime.node.packages).length} Node packages and ` +
      `${tools.length === 1 ? tools[0] : `${tools.length} tools`} into ${rel(RUNTIME_DIR)}.\n` +
      `digest ${manifest.digest}\n`,
  );
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* verify                                                                      */
/* -------------------------------------------------------------------------- */

/** Import each package inside the baked tree, with nothing else on the path. */
function verifyPython(runtime) {
  const problems = [];
  for (const spec of [...runtime.python.packages].sort()) {
    const name = spec.split('==')[0].replace(/-/g, '_');
    const probe = run(PYTHON, [
      '-I', '-S', '-c',
      `import sys, importlib.metadata; sys.path.insert(0, ${JSON.stringify(PYTHON_DIR)}); import ${name}; assert importlib.metadata.version(${JSON.stringify(name)}) == ${JSON.stringify(spec.split('==')[1])}`,
    ]);
    if (probe.status !== 0) {
      problems.push(`${spec} is missing or has the wrong version in ${rel(PYTHON_DIR)}. Run npm run prebake.`);
    }
  }
  return problems;
}

function verifyNode(runtime) {
  const problems = [];
  for (const [name, version] of Object.entries(runtime.node.packages).sort()) {
    const file = path.join(NODE_MODULES, ...name.split('/'), 'package.json');
    let installed = null;
    try {
      installed = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    } catch {
      problems.push(`${name}@${version} is not in ${rel(NODE_MODULES)}. Run npm run prebake.`);
      continue;
    }
    if (installed !== version) {
      problems.push(`${name} is baked at ${installed} but the pack pins ${version}. Run npm run prebake.`);
    }
  }
  return problems;
}

function verifyEsbuild(runtime, allow) {
  const version = runtime.node.tools.esbuild;
  if (!version) return [];
  const binary = path.join(BIN_DIR, 'esbuild');
  if (!fs.existsSync(binary)) return [`esbuild is not in ${rel(BIN_DIR)}. Run npm run prebake.`];
  const key = platformKey();
  const expected = key && (allow.checksums?.esbuild || {})[version]?.[key];
  if (!expected) {
    return [`esbuild ${version} has no reviewed checksum for ${key || `${process.platform}-${process.arch}`}.`];
  }
  const actual = sha256File(binary);
  if (actual !== expected) {
    return [
      `the baked esbuild is not the binary we reviewed: expected ${expected}, got ${actual}. ` +
        'Delete apps/api/runner/runtime/bin and run npm run prebake.',
    ];
  }
  return [];
}

function verify() {
  const packs = readRuntime();
  if (packs.problems?.length) return fail(packs.problems);
  if (!packs.declared) {
    process.stdout.write('No pack declares a runtime block, so there is nothing to verify.\n');
    return undefined;
  }
  const manifest = (() => {
    try {
      return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    } catch {
      return null;
    }
  })();
  if (!manifest) return fail([MISSING]);

  const wanted = digestOf(packs.runtime);
  if (manifest.digest !== wanted) {
    return fail([
      `the pre-baked layer is stale: the packs now hash to ${wanted} and ${rel(MANIFEST)} records ` +
        `${manifest.digest}. Run npm run prebake.`,
    ]);
  }

  const locks = dependencyLocks(packs.runtime);
  if (Object.keys(locks).some((key) => manifest.dependencyLocks?.[key] !== locks[key]) ||
      Object.keys(manifest.dependencyLocks || {}).length !== Object.keys(locks).length) {
    return fail(['The baked dependency locks are stale. Run npm run prebake.']);
  }
  const allow = readAllowlist();
  const problems = [
    ...verifyPython(packs.runtime),
    ...verifyNode(packs.runtime),
    ...verifyEsbuild(packs.runtime, allow),
  ];
  for (const [action, target] of [['verify-python', PYTHON_DIR], ['verify-node', NODE_DIR]]) {
    const result = dependencyCommand(action, packs.runtime, target);
    if (result.status !== 0) problems.push(`The full ${action.slice(7)} dependency tree differs from its lock. Run npm run prebake.`);
  }
  if (problems.length) return fail(problems);
  process.stdout.write(`The pre-baked layer matches the packs. digest ${manifest.digest}\n`);
  return undefined;
}

/* -------------------------------------------------------------------------- */

function print() {
  const packs = readRuntime();
  if (packs.problems?.length) return fail(packs.problems);
  process.stdout.write(`${packs.declared ? digestOf(packs.runtime) : 'none'}\n`);
  return undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const COMMANDS = { build, verify, print, manifest: manifestOnly };
  const command = process.argv[2] || 'verify';
  if (!Object.hasOwn(COMMANDS, command)) {
    process.stderr.write(`unknown command "${command}". Use build, verify, print or manifest.\n`);
    process.exit(2);
  }
  try {
    COMMANDS[command]();
  } catch (error) {
    fail([error?.message || String(error)]);
  }
}
