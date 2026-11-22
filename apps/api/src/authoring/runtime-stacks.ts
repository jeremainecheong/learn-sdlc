import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RUNTIME_PROFILES, SUPPORTED_STACKS_SENTENCE } from '@learnsdlc/shared';
import type { RuntimeEcosystem, RuntimeProfileView, SupportedStacks } from '@learnsdlc/shared';
import { config, resolveImportMaxBytes } from '../config';
import type { RuntimeSpec } from '../content/content.types';

/**
 * What this deployment's runner can import, read off the runner's own manifest.
 *
 * A teacher never builds an image. So the honest answer to "can I use pandas"
 * is not a request queue, it is the three allow-lists the runner container
 * bakes (`ALLOWED_PYTHON`, `ALLOWED_NODE` and `ALLOWED_TOOLS` in
 * `apps/api/runner/runtime_manifest.py`) and the editor says so before a
 * teacher starts rather than at the door.
 *
 * **Read, not copied.** A TypeScript copy of those three sets is a list that
 * drifts the first time somebody adds a package with a review: the publish
 * would refuse a version the runner could actually have run, or (worse, and
 * silently) accept one it could not. The file is the manifest the sandbox
 * imports, so parsing it is the only reading that cannot be stale.
 *
 * **`scripts/prebake.mjs` is the wrong reader and is deliberately not used.**
 * It walks the content directory off disk to find the packs that declare a
 * runtime block, and a teacher's project is rows: it is blind to every project
 * this module exists for.
 */

/** `NAME = frozenset({...})`, with the names inside as double-quoted strings. */
const FROZENSET = (name: string): RegExp =>
  new RegExp(`${name}\\s*=\\s*frozenset\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`);

const QUOTED = /"([^"]+)"/g;

function listFrom(source: string, where: string, name: string): string[] {
  const block = FROZENSET(name).exec(source);
  if (!block) {
    throw new Error(
      `${where} declares no ${name}. That file is the one the runner imports and the one a ` +
        'publish measures a project against, so a missing allow-list is a broken deployment ' +
        'rather than an empty one.',
    );
  }
  const names = [...block[1].matchAll(QUOTED)].map((match) => match[1]);
  if (names.length === 0) {
    throw new Error(`${where}'s ${name} is empty, so nothing could ever be published against it.`);
  }
  return names;
}

/** Memoised per manifest path: the file is baked into the image and never moves. */
const cache = new Map<string, SupportedStacks>();

/** The three allow-lists, plus the one sentence the editor and the refusal share. */
export function readSupportedStacks(manifestPath?: string): SupportedStacks {
  const at = manifestPath ?? path.join(config.runnerDir, 'runtime_manifest.py');
  const held = cache.get(at);
  if (held) return held;

  const source = fs.readFileSync(at, 'utf-8');
  const stacks: SupportedStacks = {
    python: listFrom(source, at, 'ALLOWED_PYTHON'),
    node: listFrom(source, at, 'ALLOWED_NODE'),
    tools: listFrom(source, at, 'ALLOWED_TOOLS'),
    sentence: SUPPORTED_STACKS_SENTENCE,
  };
  cache.set(at, stacks);
  return stacks;
}

/** Forget the parsed manifest. For a spec that writes one of its own. */
export function forgetSupportedStacks(): void {
  cache.clear();
  pinCache.clear();
  versionCache.clear();
}

export interface UnsupportedPackage {
  ecosystem: RuntimeEcosystem;
  name: string;
}

/**
 * Every package a version's `runtime` block names that the runner does not
 * bake, in the order a teacher would read them: Python, then Node, then tools.
 *
 * A Python package is pinned `name==version` and a Node one is a map entry, so
 * the name is taken the way each side spells it. A version with no `runtime`
 * block names nothing and is not a near-miss: it is a project that needs
 * nothing baked.
 */
export function unsupportedPackages(
  runtime: RuntimeSpec | null | undefined,
  stacks: SupportedStacks,
): UnsupportedPackage[] {
  if (!runtime) return [];
  const out: UnsupportedPackage[] = [];
  const python = new Set(stacks.python);
  const node = new Set(stacks.node);
  const tools = new Set(stacks.tools);

  for (const pinned of runtime.python?.packages ?? []) {
    const name = String(pinned).split('==')[0].trim().toLowerCase();
    if (name && !python.has(name)) out.push({ ecosystem: 'python', name });
  }
  for (const name of Object.keys(runtime.node?.packages ?? {})) {
    if (!node.has(name)) out.push({ ecosystem: 'node', name });
  }
  for (const name of Object.keys(runtime.node?.tools ?? {})) {
    if (!tools.has(name)) out.push({ ecosystem: 'tools', name });
  }
  return out;
}

/* ------------------------- the one runtime profile ------------------------- */

/**
 * One package a runtime block names that the baked profile cannot run.
 * `reason` separates a name the image does not bake from a name it bakes but
 * pinned in a form the runner refuses (`PYTHON_SPEC`, `NODE_VERSION`, or an
 * esbuild version with no reviewed checksum). `ecosystem: 'runtime'` is a key
 * of the block itself that names no ecosystem the profile has.
 */
export interface RuntimeProfileRefusal {
  code: 'RUNTIME_OUTSIDE_PROFILE';
  package: string;
  ecosystem: RuntimeEcosystem | 'runtime';
  reason: 'not-in-profile' | 'pin-form';
}

/** The pin forms and reviewed esbuild versions, read off the same manifest. */
interface BakedPins {
  pythonSpec: RegExp;
  nodeVersion: RegExp;
  esbuildVersions: Set<string>;
}

const pinCache = new Map<string, BakedPins>();

/** `NAME = re.compile(r"...")`, the raw string compiled as a JavaScript pattern. */
function patternFrom(source: string, where: string, name: string): RegExp {
  const found = new RegExp(`^${name}\\s*=\\s*re\\.compile\\(\\s*r"((?:[^"\\\\]|\\\\.)*)"\\s*\\)`, 'm').exec(
    source,
  );
  if (!found) {
    throw new Error(
      `${where} declares no ${name}. The runner refuses a pin that does not match it, so a ` +
        'profile that cannot read it cannot say which pins the runner would accept.',
    );
  }
  return new RegExp(found[1]);
}

/** The top-level version keys of `ESBUILD_CHECKSUMS`: the esbuild versions anyone reviewed. */
function esbuildVersionsFrom(source: string, where: string): Set<string> {
  const block = /^ESBUILD_CHECKSUMS\s*=\s*\{([\s\S]*?)^\}/m.exec(source);
  const versions = block ? [...block[1].matchAll(/^ {4}"([^"]+)"\s*:\s*\{/gm)].map((m) => m[1]) : [];
  if (versions.length === 0) {
    throw new Error(`${where} declares no reviewed esbuild version in ESBUILD_CHECKSUMS.`);
  }
  return new Set(versions);
}

function readBakedPins(at: string): BakedPins {
  const held = pinCache.get(at);
  if (held) return held;
  const source = fs.readFileSync(at, 'utf-8');
  const pins: BakedPins = {
    pythonSpec: patternFrom(source, at, 'PYTHON_SPEC'),
    nodeVersion: patternFrom(source, at, 'NODE_VERSION'),
    esbuildVersions: esbuildVersionsFrom(source, at),
  };
  pinCache.set(at, pins);
  return pins;
}

function manifestAt(manifestPath?: string): string {
  return manifestPath ?? path.join(config.runnerDir, 'runtime_manifest.py');
}

/**
 * What the one baked layer holds, version by version. The runner puts that one
 * layer on the path whatever a block declares, so a name it bakes at another
 * version is a version no learner would run.
 *
 * - Package versions: the hash-locked files beside the manifest
 *   (`runtime-locks/python-requirements.txt`, `runtime-locks/package.json`),
 *   which are what `runtime_dependencies.py` installs.
 * - Interpreter and tool versions: the content packs' merged `runtime` block,
 *   which is what `scripts/prebake.mjs` bakes from (it refuses two packs that
 *   disagree, and so does this).
 *
 * Read-only; a missing or unreadable source throws by name, because guessing
 * would be accepting a block the layer cannot run.
 */
interface BakedVersions {
  python: Map<string, string>;
  node: Map<string, string>;
  tools: Map<string, string>;
  pythonVersion: string;
  nodeVersion: string;
}

const versionCache = new Map<string, BakedVersions>();

/** `runtime_dependencies.normalized`: the runner's own spelling of a Python name. */
const normalizedPython = (name: string): string => name.replace(/[-_.]+/g, '-').toLowerCase();

function readLock(locks: string, name: string): string {
  const at = path.join(locks, name);
  try {
    return fs.readFileSync(at, 'utf-8');
  } catch {
    throw new Error(
      `${at} (runtime-locks/${name}) cannot be read. It is the lock the baked layer is installed from, ` +
        'so without it the profile cannot say which versions the layer holds.',
    );
  }
}

function readBakedVersions(at: string, contentDir: string): BakedVersions {
  const key = `${at}\0${contentDir}`;
  const held = versionCache.get(key);
  if (held) return held;
  const locks = path.join(path.dirname(at), 'runtime-locks');

  const python = new Map<string, string>();
  for (const line of readLock(locks, 'python-requirements.txt').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const pinned = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)(?:\s|$)/.exec(line);
    if (!pinned) throw new Error(`runtime-locks/python-requirements.txt has a line that is not an exact pin.`);
    const name = normalizedPython(pinned[1]);
    if (python.has(name)) throw new Error(`runtime-locks/python-requirements.txt pins ${name} twice.`);
    python.set(name, pinned[2]);
  }

  let dependencies: unknown;
  try {
    dependencies = (JSON.parse(readLock(locks, 'package.json')) as { dependencies?: unknown }).dependencies;
  } catch (error) {
    if (error instanceof Error && error.message.includes('runtime-locks/package.json')) throw error;
    throw new Error('runtime-locks/package.json is not valid JSON.');
  }
  if (!isRecord(dependencies)) throw new Error('runtime-locks/package.json declares no dependencies.');
  const node = new Map<string, string>();
  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version !== 'string') throw new Error(`runtime-locks/package.json pins ${name} to a non-string.`);
    node.set(name, version);
  }

  let pythonVersion = '';
  let nodeVersion = '';
  const tools = new Map<string, string>();
  const agree = (what: string, held: string | undefined, next: unknown): string => {
    if (typeof next !== 'string') throw new Error(`a content pack's runtime block pins ${what} to a non-string.`);
    if (held && held !== next) {
      throw new Error(`the content packs pin ${what} to ${held} and to ${next}; one baked layer serves every pack.`);
    }
    return next;
  };
  let declared = false;
  let slugs: string[] = [];
  try {
    slugs = fs
      .readdirSync(contentDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    slugs = [];
  }
  for (const slug of slugs) {
    let runtime: unknown;
    try {
      runtime = (JSON.parse(fs.readFileSync(path.join(contentDir, slug, 'project.json'), 'utf-8')) as {
        runtime?: unknown;
      }).runtime;
    } catch {
      continue;
    }
    if (!isRecord(runtime)) continue;
    declared = true;
    if (isRecord(runtime.python) && runtime.python.version !== undefined) {
      pythonVersion = agree('python', pythonVersion, runtime.python.version);
    }
    if (isRecord(runtime.node)) {
      if (runtime.node.version !== undefined) nodeVersion = agree('node', nodeVersion, runtime.node.version);
      if (isRecord(runtime.node.tools)) {
        for (const [name, version] of Object.entries(runtime.node.tools)) {
          tools.set(name, agree(`the tool ${name}`, tools.get(name), version));
        }
      }
    }
  }
  if (!declared) {
    throw new Error(
      `no content pack under ${contentDir} declares a runtime block, so nothing is baked and the profile ` +
        'cannot say which interpreter or tool versions the layer holds.',
    );
  }

  const baked: BakedVersions = { python, node, tools, pythonVersion, nodeVersion };
  versionCache.set(key, baked);
  return baked;
}

/**
 * The one runtime profile: the stack this deployment's runner image
 * already bakes, named. The lists are `readSupportedStacks`' own, sorted, and
 * `manifestSha256` is taken over those three lists only (one `python:`,
 * `node:` or `tool:` line per name, sorted, newline-terminated) so it changes
 * exactly when an allow-list gains, loses or moves a name, and not for a
 * comment, an order inside a set, or an esbuild checksum.
 *
 * The profile also says (`uploadMaxBytes`) the archive cap
 * this deployment's upload door enforces (`IMPORT_MAX_BYTES` read the way
 * UploadService reads it (`resolveImportMaxBytes`), the archive's own bytes,
 * never the base64 body's limit) so the editor states the real limit.
 */
export function bakedRuntimeProfile(manifestPath?: string): RuntimeProfileView {
  const [descriptor] = RUNTIME_PROFILES;
  const stacks = readSupportedStacks(manifestAt(manifestPath));
  const python = [...stacks.python].sort();
  const node = [...stacks.node].sort();
  const tools = [...stacks.tools].sort();
  const lines = [
    ...python.map((name) => `python:${name}`),
    ...node.map((name) => `node:${name}`),
    ...tools.map((name) => `tool:${name}`),
  ];
  const manifestSha256 = createHash('sha256').update(`${lines.join('\n')}\n`, 'utf-8').digest('hex');
  return {
    id: descriptor.id,
    name: descriptor.name,
    manifestSha256,
    python,
    node,
    tools,
    sentence: descriptor.sentence,
    uploadMaxBytes: resolveImportMaxBytes(),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Every package a `runtime` block names outside the baked profile, Python then
 * Node then tools then any other key, each in the order the block lists it.
 *
 * The rule is the runner's own (`check_python_spec`, `check_node_package`,
 * `check_tool` in `runtime_manifest.py`), read off that file rather than
 * copied: a Python pin must match `PYTHON_SPEC` and name an `ALLOWED_PYTHON`
 * package; a Node package must be in `ALLOWED_NODE` and pinned to
 * `NODE_VERSION`; a tool must be in `ALLOWED_TOOLS`, pinned to `NODE_VERSION`,
 * and esbuild only at a version `ESBUILD_CHECKSUMS` reviewed. The block is
 * untrusted (an upload writes it), so a shape the profile cannot read is a
 * refusal, never a throw. No block at all is a project that bakes nothing.
 *
 * Used at upload and again at publish.
 */
export function runtimeProfileRefusals(
  runtime: RuntimeSpec | null | undefined,
  manifestPath?: string,
  contentDir?: string,
): RuntimeProfileRefusal[] {
  if (runtime === null || runtime === undefined) return [];
  const at = manifestAt(manifestPath);
  const stacks = readSupportedStacks(at);
  const pins = readBakedPins(at);
  const baked = readBakedVersions(at, contentDir ?? config.contentDir);
  const out: RuntimeProfileRefusal[] = [];
  const refuse = (
    ecosystem: RuntimeProfileRefusal['ecosystem'],
    pkg: string,
    reason: RuntimeProfileRefusal['reason'],
  ): void => {
    out.push({ code: 'RUNTIME_OUTSIDE_PROFILE', package: pkg, ecosystem, reason });
  };
  if (!isRecord(runtime)) {
    refuse('runtime', 'runtime', 'not-in-profile');
    return out;
  }
  const python = new Set(stacks.python);
  const node = new Set(stacks.node);
  const tools = new Set(stacks.tools);

  /** An interpreter version: a string, and the one the layer bakes. */
  const interpreter = (ecosystem: 'python' | 'node', version: unknown, bakedVersion: string): void => {
    if (typeof version !== 'string') refuse(ecosystem, `${ecosystem}.version`, 'pin-form');
    else if (version !== bakedVersion) refuse(ecosystem, `${ecosystem}@${version}`, 'not-in-profile');
  };
  /** A key inside a block that names nothing the profile has (an index, a registry). */
  const unknownKeys = (ecosystem: 'python' | 'node', block: Record<string, unknown>, known: string[]): void => {
    for (const key of Object.keys(block)) {
      if (!known.includes(key)) refuse(ecosystem, `${ecosystem}.${key}`, 'not-in-profile');
    }
  };

  const pythonBlock: unknown = runtime.python;
  if (pythonBlock !== undefined && pythonBlock !== null) {
    if (!isRecord(pythonBlock)) {
      refuse('python', 'python', 'pin-form');
    } else {
      interpreter('python', pythonBlock.version, baked.pythonVersion);
      const packages = pythonBlock.packages;
      if (packages !== undefined && !Array.isArray(packages)) {
        refuse('python', 'python.packages', 'pin-form');
      } else {
        const seen = new Set<string>();
        ((packages as unknown[] | undefined) ?? []).forEach((spec, index) => {
          // A non-string entry is named by where it sits: `String()` on an
          // uploaded object can itself throw (a `toString` key that is data).
          if (typeof spec !== 'string') {
            refuse('python', `python.packages[${index}]`, 'pin-form');
            return;
          }
          const pinned = pins.pythonSpec.exec(spec);
          if (!pinned) {
            refuse('python', spec.split('==')[0].trim() || spec, 'pin-form');
          } else if (!python.has(pinned[1] ?? spec)) {
            refuse('python', pinned[1] ?? spec, 'not-in-profile');
          } else if (seen.has(pinned[1])) {
            // The runner refuses a name pinned twice; one layer holds one version.
            refuse('python', pinned[1], 'pin-form');
          } else {
            seen.add(pinned[1]);
            if (baked.python.get(normalizedPython(pinned[1])) !== pinned[2]) refuse('python', spec, 'not-in-profile');
          }
        });
      }
      unknownKeys('python', pythonBlock, ['version', 'packages']);
    }
  }

  const nodeBlock: unknown = runtime.node;
  if (nodeBlock !== undefined && nodeBlock !== null) {
    if (!isRecord(nodeBlock)) {
      refuse('node', 'node', 'pin-form');
    } else {
      interpreter('node', nodeBlock.version, baked.nodeVersion);
      const sides: Array<['node' | 'tools', unknown]> = [
        ['node', nodeBlock.packages],
        ['tools', nodeBlock.tools],
      ];
      for (const [ecosystem, entries] of sides) {
        if (entries === undefined || entries === null) continue;
        if (!isRecord(entries)) {
          refuse(ecosystem, ecosystem === 'node' ? 'node.packages' : 'node.tools', 'pin-form');
          continue;
        }
        const allowed = ecosystem === 'node' ? node : tools;
        for (const [name, version] of Object.entries(entries)) {
          if (!allowed.has(name)) {
            refuse(ecosystem, name, 'not-in-profile');
          } else if (
            typeof version !== 'string' ||
            !pins.nodeVersion.test(version) ||
            (ecosystem === 'tools' && name === 'esbuild' && !pins.esbuildVersions.has(version))
          ) {
            refuse(ecosystem, name, 'pin-form');
          } else if ((ecosystem === 'node' ? baked.node : baked.tools).get(name) !== version) {
            refuse(ecosystem, `${name}@${version}`, 'not-in-profile');
          }
        }
      }
      unknownKeys('node', nodeBlock, ['version', 'packages', 'tools']);
    }
  }

  for (const key of Object.keys(runtime)) {
    if (key !== 'python' && key !== 'node') refuse('runtime', key, 'not-in-profile');
  }
  return out;
}
