import * as path from 'path';
import { HttpException } from '@nestjs/common';
import { DRAFT_FIRST_VERSION, RUN_SHAPE_REFUSAL_CODES } from '@learnsdlc/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import type { ProjectContent } from '../content/content.types';
import { mintTeacherSlug } from '../content/importer.service';
import { isOlderLayout, layoutFromManifest } from '../content/legacy-layout';
import { MemoryPackSource, packRootOf } from '../content/memory-pack-source';
import { compilePack } from '../content/pack-compiler';
import type { PackSource } from '../content/pack-source';
import { readZip, zipLimits } from '../content/zip-reader';
import { packFilesOf, writeZip } from '../../test/fixtures/upload-packs/archive';
import { HOSTILE_ARCHIVES } from '../../test/fixtures/upload-packs/hostile';
import {
  buildPackManifest,
  checkPackFiles,
  checkPackRuns,
  checkRunLimits,
  checkRuntimeProfile,
  checkUploadShape,
  type PackRefusal,
} from './upload-limits';
import { UploadService, type TeacherDraftImporter } from './upload.service';
import { rawPackManifestOf } from './validation';

/**
 * **A pack the upload door accepts is never refused at publish for the argv
 * rule.**
 *
 * Upload is allowed to be stricter than publish (the `canonical/`-only
 * pre-loader set *and* publish's own `rawPackManifestOf` reading). What must
 * never happen is the other way round: a teacher's upload is accepted, and the
 * draft it made can never be published because of the run-shape rule.
 *
 * The pure layer (this file):
 *
 * - **the upload door's verdict** is `UploadService.upload` itself, the real
 *   service with every check it runs (the pre-loader manifest checks, the
 *   loader, and the post-loader `checkPackRuns(rawPackManifestOf(loaded))`),
 *   over a capturing stand-in for the importer;
 * - **the stored content** is what `importTeacherDraft` stores for an archive
 *   with no task block: `compilePack({ ...loaded, slug, title,
 *   version: DRAFT_FIRST_VERSION }).content` over the source the door handed
 *   the importer (importer.service.ts `writeTeacherDraft`). A pack whose task
 *   block carries words (the `shelf-task` fixture) is re-compiled by the importer
 *   through `compileDraft`, which overlays task words and the task's own
 *   checks (the phase's, for an upload) and moves no argv; the e2e layer
 *   (`apps/api/test/upload-publish-argv.e2e-spec.ts`) reads the stored row
 *   itself, and calls the real publish route;
 * - **publish's argv rule** is publish's own expression, verbatim
 *   (authoring.service.ts `executableInput`):
 *   `const raw = rawPackManifestOf(compiled.content);
 *    [...checkPackRuns(raw), ...checkRunLimits(raw)]`.
 *
 * The corpus is fixed (`shelf`, `shelf-preview` (run shape 6, the
 * preview argv) `shelf-task`, and every `hostile.ts` entry whose
 * `expectedOutcome` is `accepted`) plus `VARIANT_COUNT` variants drawn by a
 * seeded PRNG (`PROPERTY_SEED`) over the rule's seven shapes.
 *
 * The generator and the helpers are exported for the e2e layer; the specs
 * below register only when this file is the one Jest is running.
 */

/* ------------------------------- the constants ------------------------------- */

/** The PRNG seed; the same seed always draws the same variants. */
export const PROPERTY_SEED = 0x0402_2026;
/** How many generated variants the pure layer asks the door about. */
export const VARIANT_COUNT = 240;

/** The run-shape rule's ten refusal codes, the ones publish must never draw for an accepted upload. */
export const RUN_SHAPE_CODES = [
  'RUN_FREEFORM_STRING',
  'RUN_OWN_COMMAND',
  'ARGV_INTERPRETER',
  'ARGV_SCRIPT',
  'ARGV_EXTRA',
  'ARGV_SHELL',
  'HARNESS_NOT_ALLOWED',
  'HIDDEN_NOT_FILE',
  'LIMIT_TIMEOUT',
  'LIMIT_MEMORY',
] as const;

/**
 * A fixed phrase of each run-shape code's own sentence (upload-limits.ts), for a
 * reader that only has the sentence: publish's report rows carry the
 * finding's sentence, not its code. Pinned against the real sentences below.
 */
export const RUN_SHAPE_SENTENCE_MARKS: Record<(typeof RUN_SHAPE_CODES)[number], string[]> = {
  RUN_FREEFORM_STRING: ['is a command string', 'must be an array of non-empty strings'],
  RUN_OWN_COMMAND: ['declares its own command'],
  ARGV_INTERPRETER: ['starts with an interpreter other than'],
  ARGV_SCRIPT: ['does not run a .py file this pack ships'],
  ARGV_EXTRA: ['passes arguments after the script'],
  ARGV_SHELL: ['contains a shell metacharacter or whitespace'],
  HARNESS_NOT_ALLOWED: ['are not one of the run shapes TaskTrackr uses'],
  HIDDEN_NOT_FILE: ["hidden suite must be test files the runner executes"],
  LIMIT_TIMEOUT: ["asks for more time than a learner's run gets"],
  LIMIT_MEMORY: ["asks for more memory than a learner's run gets"],
};

const FIXTURES = path.resolve(__dirname, '../../test/fixtures/upload-packs');
const CAP = 32 * 1024 * 1024;
const TITLE = 'Books on a shelf';
const TEACHER: AuthUser = { id: 'teacher-up-4', email: 'teacher@up-4.test', role: 'INSTRUCTOR', cohort: 'default' };

const PROJECT = 'project.json';
const IMPL = 'phases/03-implementation/phase.json';
const TESTING = 'phases/04-testing/phase.json';
const DEPLOY = 'phases/05-deployment/phase.json';
const MAINT = 'phases/06-maintenance/phase.json';

/* --------------------------------- the PRNG --------------------------------- */

/** mulberry32: small, seeded, the same stream on every machine. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, from: readonly T[]): T => from[Math.floor(rng() * from.length)];

/* -------------------------------- the variants -------------------------------- */

export type Base = 'shelf' | 'shelf-preview' | 'shelf-task';

/** One archive the property asks about. */
export interface Variant {
  name: string;
  /** Which run shapes (1–7), the declared limits or the command-key walk it touches. */
  shapes: string[];
  archive(): Buffer;
}

type Files = Map<string, Buffer>;

function filesOf(base: Base): Files {
  return new Map(packFilesOf(path.join(FIXTURES, base)).map((one) => [one.name, one.data]));
}

function zipFiles(files: Files): Buffer {
  return writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
}

function editJson(files: Files, name: string, edit: (json: any) => void): void {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`the base has no ${name}`);
  const json = JSON.parse(bytes.toString('utf8'));
  edit(json);
  files.set(name, Buffer.from(`${JSON.stringify(json, null, 2)}\n`, 'utf8'));
}

const DELETE = Symbol('delete');
function setOrDelete(target: any, key: string, value: unknown): void {
  if (value === DELETE) delete target[key];
  else target[key] = value;
}

/* The pools each mutation draws from. Weighted by repetition toward the closed shapes, so both verdicts occur. */
const INTERPRETERS = ['python3', 'python3', 'python3', 'python3', 'python', 'node', 'bash', 'sh', '/usr/bin/python3', 'python3.11', 'Python3', ''];
const SMOKE_SCRIPTS = ['api/main.py', 'api/main.py', 'api/main.py', 'api/shelf.py', 'deploy/shelf.json', 'api/Dockerfile', 'notes.md', 'ops/seed.py', 'missing.py', '../canonical/api/main.py', '-c', 'api/main.py '];
const SMOKE_EXTRAS: string[][] = [['--selfcheck'], ['--selfcheck'], ['--selfcheck'], [], ['--selfcheck', '--selfcheck'], ['--verbose'], ['--selfcheck;id'], ['--self check'], ['$HOME'], ['--selfcheck', '-v'], ['--selfcheck\n']];
const PREVIEW_SCRIPTS = ['api/main.py', 'api/main.py', 'api/main.py', 'ops/seed.py', 'ops/seed.py', 'api/shelf.py', 'web/index.html', 'web/src/main.ts', 'tests/conftest.py', 'missing.py', '/srv/api/main.py', 'api/../api/main.py'];
const PREVIEW_EXTRAS: string[][] = [[], [], [], [], ['--port'], ['--selfcheck'], ['8080'], ['&&', 'id'], ['--reset']];
const ARGV_FORMS = ['argv', 'argv', 'argv', 'argv', 'argv', 'string', 'nested', 'object', 'empty'] as const;
const COMMAND_KEYS_POOL = ['command', 'commands', 'cmd', 'argv', 'shell', 'script', 'entrypoint', 'exec', 'run', 'scripts', 'Command', 'runner', 'entryPoint', 'commandLine'];
const COMMAND_VALUES: unknown[] = ['python3 api/main.py', ['python3', 'api/main.py'], { argv: ['sh', '-c', 'id'] }, true, 1];

function argvIn(form: (typeof ARGV_FORMS)[number], words: string[]): unknown {
  switch (form) {
    case 'argv':
      return words;
    case 'string':
      return words.join(' ');
    case 'nested':
      return [words];
    case 'object':
      return { argv: words };
    case 'empty':
      return [];
  }
}

/** Shape 5: `checks.smoke.commands`. */
function mutateSmoke(files: Files, rng: Rng): string {
  const words = [pick(rng, INTERPRETERS), pick(rng, SMOKE_SCRIPTS), ...pick(rng, SMOKE_EXTRAS)];
  const form = pick(rng, [...ARGV_FORMS, 'two', 'inner-string'] as const);
  editJson(files, DEPLOY, (phase) => {
    phase.checks.smoke.commands =
      form === 'two'
        ? [words, ['python3', 'api/main.py', '--selfcheck']]
        : form === 'inner-string'
          ? [words.join(' ')]
          : form === 'nested' || form === 'object'
            ? [argvIn(form, words)]
            : form === 'argv'
              ? [words]
              : argvIn(form, words);
  });
  return `smoke ${form} ${JSON.stringify(words)}`;
}

/** Shape 6: `preview.service.command`. */
function mutatePreviewService(files: Files, rng: Rng): string {
  const words = [pick(rng, INTERPRETERS), pick(rng, PREVIEW_SCRIPTS), ...pick(rng, PREVIEW_EXTRAS)];
  const form = pick(rng, ARGV_FORMS);
  editJson(files, PROJECT, (project) => {
    project.preview.service.command = argvIn(form, words);
  });
  return `preview.service.command ${form} ${JSON.stringify(words)}`;
}

/** Shape 6: `preview.seed`. */
function mutatePreviewSeed(files: Files, rng: Rng): string {
  if (rng() < 0.12) {
    editJson(files, PROJECT, (project) => delete project.preview.seed);
    return 'preview.seed removed';
  }
  const words = [pick(rng, INTERPRETERS), pick(rng, PREVIEW_SCRIPTS), ...pick(rng, PREVIEW_EXTRAS)];
  const form = pick(rng, ARGV_FORMS);
  editJson(files, PROJECT, (project) => {
    project.preview.seed = argvIn(form, words);
  });
  return `preview.seed ${form} ${JSON.stringify(words)}`;
}

/** Where a command-declaring key (or a near miss) can be planted, outside the three argv sites. */
const COMMAND_SITES: { name: string; file: string; preview?: boolean; at(json: any): any }[] = [
  { name: 'project', file: PROJECT, at: (j) => j },
  { name: 'project.preview', file: PROJECT, preview: true, at: (j) => j.preview },
  { name: 'project.preview.service', file: PROJECT, preview: true, at: (j) => j.preview.service },
  { name: 'project.preview.web', file: PROJECT, preview: true, at: (j) => j.preview.web },
  { name: 'project.runtime.python', file: PROJECT, at: (j) => j.runtime.python },
  { name: 'implementation phase.json', file: IMPL, at: (j) => j },
  { name: 'deployment phase.json', file: DEPLOY, at: (j) => j },
  { name: 'implementation checks', file: IMPL, at: (j) => j.checks },
  { name: 'implementation checks.runs[0]', file: IMPL, at: (j) => j.checks.runs[0] },
  { name: 'implementation checks.runs[1]', file: IMPL, at: (j) => j.checks.runs[1] },
  { name: 'testing checks.runs[0]', file: TESTING, at: (j) => j.checks.runs[0] },
  { name: 'deployment checks.smoke', file: DEPLOY, at: (j) => j.checks.smoke },
  { name: 'deployment checks.drill', file: DEPLOY, at: (j) => j.checks.drill },
  // The folder layout's phase.json holds no files list and no drill.faultedFiles map (a mount and a
  // faulted file are files under their folders), so the walk's nested-object sites are these two.
  { name: 'deployment checks.rules[0]', file: DEPLOY, at: (j) => j.checks.rules[0] },
  { name: 'implementation rubric.criteria[0]', file: IMPL, at: (j) => j.rubric.criteria[0] },
  { name: 'implementation rubric', file: IMPL, at: (j) => j.rubric },
];

/**
 * Shape 6, the script alone: `["python3", <script>]` at the service or the
 * seed. Where upload's two readings of "a script this pack ships" could part
 * (a `canonical/` file a phase mounts editable, a file no previewing phase
 * mounts), so it is drawn on its own, keeping the interpreter and the arity
 * closed.
 */
function mutatePreviewScript(files: Files, rng: Rng): string {
  const script = pick(rng, ['api/shelf.py', 'api/shelf.py', 'web/src/lib/shelf.ts', 'ops/seed.py', 'api/main.py', 'tests/conftest.py', 'tests/test_shelf_api.py', 'deploy/shelf.json', 'missing.py']);
  const site = rng() < 0.5 ? 'service' : 'seed';
  editJson(files, PROJECT, (project) => {
    if (site === 'service') project.preview.service.command = ['python3', script];
    else project.preview.seed = ['python3', script];
  });
  return `preview.${site} script ${script}`;
}

/** The rule's walk: a command-declaring key anywhere but the three argv sites. */
function mutateCommandKey(files: Files, rng: Rng, preview: boolean): string {
  const site = pick(rng, COMMAND_SITES.filter((one) => preview || !one.preview));
  let key = pick(rng, COMMAND_KEYS_POOL);
  // Never overwrite an argv site itself: that is the argv mutations' job.
  if ((site.name === 'project.preview.service' && key === 'command') || (site.name === 'deployment checks.smoke' && key === 'commands') || (site.name === 'project.preview' && key === 'seed')) key = 'cmd';
  const value = pick(rng, COMMAND_VALUES);
  editJson(files, site.file, (json) => {
    site.at(json)[key] = value;
  });
  return `key ${key} at ${site.name}`;
}

/** Shapes 1–4: a test run's language, harness, hidden harness and transform. */
function mutateHarness(files: Files, rng: Rng): string {
  const file = pick(rng, [IMPL, IMPL, MAINT, TESTING]);
  const index = rng() < 0.5 ? 0 : 1;
  const field = pick(rng, ['harness', 'hiddenHarness', 'language', 'transform'] as const);
  const pools: Record<typeof field, unknown[]> = {
    harness: ['pytest', 'js', 'unittest', 'jest', 'node', DELETE],
    hiddenHarness: ['unittest', 'js', 'pytest', null, DELETE],
    language: ['python', 'typescript', 'javascript', 'Python'],
    transform: [true, false, DELETE, 'yes', 1],
  };
  const value = pick(rng, pools[field]);
  editJson(files, file, (phase) => setOrDelete(phase.checks.runs[index], field, value));
  return `${path.basename(path.dirname(file))} runs[${index}].${field} = ${value === DELETE ? '(removed)' : JSON.stringify(value)}`;
}

/** Shapes 1–2: a hidden suite (its directory, its files). */
function mutateHidden(files: Files, rng: Rng): string {
  const phaseDir = pick(rng, ['phases/03-implementation', 'phases/06-maintenance']);
  const file = `${phaseDir}/phase.json`;
  const index = rng() < 0.6 ? 0 : 1;
  const what = pick(rng, ['dir', 'add', 'add', 'rename', 'drop-harness'] as const);
  if (what === 'dir') {
    // A run's hidden suite is the folder hidden_tests/<run id>/ (the folder layout names no hiddenTestDir):
    // the draw moves the suite to another folder, another run's, none, or a sealed or mounted one.
    const id = index === 0 ? 'api' : 'web';
    const to = pick(rng, ['hidden_tests/api', 'hidden_tests/web', 'hidden_tests', 'hidden_tests/main', 'solution/api', 'files', 'missing', 'hidden_tests/api/api', 'hidden_tests/API']);
    const from = `${phaseDir}/hidden_tests/${id}/`;
    for (const at of [...files.keys()].filter((name) => name.startsWith(from))) {
      const data = files.get(at)!;
      files.delete(at);
      files.set(`${phaseDir}/${to}/${at.slice(from.length)}`, data);
    }
    return `${phaseDir} hidden_tests/${id}/ moved to ${to}/`;
  }
  if (what === 'drop-harness') {
    editJson(files, file, (phase) => delete phase.checks.runs[index].hiddenHarness);
    return `${phaseDir} runs[${index}].hiddenHarness removed, its suite kept`;
  }
  const dir = index === 0 ? `${phaseDir}/hidden_tests/api` : `${phaseDir}/hidden_tests/web/web/src/lib`;
  if (what === 'rename') {
    const at = [...files.keys()].find((name) => name.startsWith(`${dir}/`));
    if (!at) return `${dir}: nothing to rename`;
    const data = files.get(at)!;
    files.delete(at);
    const renamed = `${dir}/${pick(rng, ['hidden_suite.py', 'helpers.py', 'suite.ts', 'test_renamed.py', 'renamed.test.ts'])}`;
    files.set(renamed, data);
    return `${at} renamed ${renamed}`;
  }
  const name = pick(rng, ['conftest.py', '__init__.py', 'test_extra.py', 'helper.py', 'notes.md', 'extra.test.ts', 'extra.spec.ts']);
  files.set(`${dir}/${name}`, Buffer.from(name.endsWith('.py') ? 'import unittest\n' : name.endsWith('.ts') ? 'export {};\n' : 'notes\n', 'utf8'));
  return `${dir}/${name} added`;
}

/** A declared time or memory limit, around the learner's 15 s / 256 MB. */
function mutateLimit(files: Files, rng: Rng, preview: boolean): string {
  const t = config.runTimeoutSeconds;
  const m = config.runMemoryMb;
  const key = pick(rng, ['timeoutSeconds', 'timeoutSeconds', 'memoryMb', 'memoryMb', 'timeout', 'memory'] as const);
  const value = key.startsWith('timeout')
    ? pick(rng, [t - 1, t, t, t + 1, t + 0.5, 0, -1, String(t), 60, null])
    : pick(rng, [m - 1, m, m, m + 1, 512, 0, String(m), m * 2]);
  const sites: { name: string; file: string; preview?: boolean; at(json: any): any }[] = [
    { name: 'implementation checks.runs[0]', file: IMPL, at: (j) => j.checks.runs[0] },
    { name: 'implementation checks.runs[1]', file: IMPL, at: (j) => j.checks.runs[1] },
    { name: 'implementation checks', file: IMPL, at: (j) => j.checks },
    { name: 'implementation phase.json', file: IMPL, at: (j) => j },
    { name: 'testing checks.runs[0]', file: TESTING, at: (j) => j.checks.runs[0] },
    { name: 'deployment checks.smoke', file: DEPLOY, at: (j) => j.checks.smoke },
    { name: 'deployment checks.drill', file: DEPLOY, at: (j) => j.checks.drill },
    { name: 'project', file: PROJECT, at: (j) => j },
    { name: 'project.runtime', file: PROJECT, at: (j) => j.runtime },
    { name: 'project.preview.service', file: PROJECT, preview: true, at: (j) => j.preview.service },
  ];
  const site = pick(rng, sites.filter((one) => preview || !one.preview));
  editJson(files, site.file, (json) => {
    site.at(json)[key] = value;
  });
  return `${key} = ${JSON.stringify(value)} at ${site.name}`;
}

/**
 * Shape 7: the drill names files, never a command. In the folder layout a
 * faulted file is the file under `drill/` at its workspace path, so the
 * target and source draws move or replace that file; the other two edit
 * `checks.drill`.
 */
function mutateDrill(files: Files, rng: Rng): string {
  const what = pick(rng, ['target', 'source', 'expect', 'extra'] as const);
  const faulted = 'phases/05-deployment/drill/deploy/shelf.json';
  if (what === 'target') {
    const data = files.get(faulted)!;
    files.delete(faulted);
    files.set('phases/05-deployment/drill/api/main.py', data);
    return 'drill target';
  }
  if (what === 'source') {
    const source = pick(rng, ['kept', 'locked copy', 'removed'] as const);
    if (source === 'locked copy') files.set(faulted, files.get('phases/05-deployment/readonly/deploy/shelf.json')!);
    else if (source === 'removed') files.delete(faulted);
    return `drill source ${source}`;
  }
  editJson(files, DEPLOY, (phase) => {
    const drill = phase.checks.drill;
    if (what === 'expect') drill.expectFailure = pick(rng, [true, false, 'yes']);
    else drill[pick(rng, ['note', 'restart', 'fault'])] = pick(rng, ['python3 api/main.py', 'port-zero']);
  });
  return `drill ${what}`;
}

type Mutation = { shape: string; preview?: boolean; apply(files: Files, rng: Rng, preview: boolean): string };
const MUTATIONS: Mutation[] = [
  { shape: '5:smoke', apply: (f, r) => mutateSmoke(f, r) },
  { shape: '5:smoke', apply: (f, r) => mutateSmoke(f, r) },
  { shape: '6:preview.service', preview: true, apply: (f, r) => mutatePreviewService(f, r) },
  { shape: '6:preview.service', preview: true, apply: (f, r) => mutatePreviewService(f, r) },
  { shape: '6:preview.seed', preview: true, apply: (f, r) => mutatePreviewSeed(f, r) },
  { shape: '6:preview.script', preview: true, apply: (f, r) => mutatePreviewScript(f, r) },
  { shape: 'command-key', apply: (f, r, p) => mutateCommandKey(f, r, p) },
  { shape: 'command-key', apply: (f, r, p) => mutateCommandKey(f, r, p) },
  { shape: '1-4:harness', apply: (f, r) => mutateHarness(f, r) },
  { shape: '1-4:harness', apply: (f, r) => mutateHarness(f, r) },
  { shape: '1-2:hidden', apply: (f, r) => mutateHidden(f, r) },
  { shape: 'U5:limit', apply: (f, r, p) => mutateLimit(f, r, p) },
  { shape: 'U5:limit', apply: (f, r, p) => mutateLimit(f, r, p) },
  { shape: '7:drill', apply: (f, r) => mutateDrill(f, r) },
];

/**
 * `count` variants of `shelf` and `shelf-preview`, each with one to three
 * mutations drawn from `MUTATIONS` by the PRNG seeded with `seed`. The same
 * seed is the same list, archive for archive.
 */
export function generateVariants(seed: number = PROPERTY_SEED, count: number = VARIANT_COUNT): Variant[] {
  const rng = prng(seed);
  const out: Variant[] = [];
  for (let i = 0; i < count; i += 1) {
    const base: Base = rng() < 0.5 ? 'shelf' : 'shelf-preview';
    const preview = base === 'shelf-preview';
    const files = filesOf(base);
    const steps = 1 + Math.floor(rng() * 3);
    const said: string[] = [];
    const shapes: string[] = [];
    for (let s = 0; s < steps; s += 1) {
      const mutation = pick(rng, MUTATIONS.filter((one) => preview || !one.preview));
      said.push(mutation.apply(files, rng, preview));
      shapes.push(mutation.shape);
    }
    const bytes = zipFiles(files);
    out.push({ name: `#${i} ${base}: ${said.join('; ')}`, shapes, archive: () => Buffer.from(bytes) });
  }
  return out;
}

/** Shape 6's edge, enumerated rather than drawn: each script of the pool at the service and at the seed, one change each. */
export const PREVIEW_EDGE_SCRIPTS = ['api/shelf.py', 'web/src/lib/shelf.ts', 'ops/seed.py', 'api/main.py', 'tests/conftest.py', 'tests/test_shelf_api.py', 'web/src/main.ts', 'deploy/shelf.json', 'missing.py'];

export function previewEdgeVariants(): Variant[] {
  const out: Variant[] = [];
  for (const site of ['service', 'seed'] as const) {
    for (const script of PREVIEW_EDGE_SCRIPTS) {
      const files = filesOf('shelf-preview');
      editJson(files, PROJECT, (project) => {
        if (site === 'service') project.preview.service.command = ['python3', script];
        else project.preview.seed = ['python3', script];
      });
      const bytes = zipFiles(files);
      out.push({ name: `edge shelf-preview: preview.${site} = ["python3", "${script}"]`, shapes: [`6:preview.edge.${site}`], archive: () => Buffer.from(bytes) });
    }
  }
  return out;
}

/**
 * Shape 5's edge, enumerated rather than drawn.
 * The seeded draws over `checks.smoke.commands` are almost all refused, so the
 * accepted side of shape 5 is pinned here: `python3` with each shipped script,
 * with and without `--selfcheck`, as the only command or beside the shelf's own,
 * on both bases.
 */
export const SMOKE_EDGE_SCRIPTS = ['api/main.py', 'api/shelf.py'];
export const SMOKE_EDGE_EXTRAS: string[][] = [[], ['--selfcheck']];

export function smokeEdgeVariants(): Variant[] {
  const out: Variant[] = [];
  for (const base of ['shelf', 'shelf-preview'] as const) {
    for (const script of SMOKE_EDGE_SCRIPTS) {
      for (const extras of SMOKE_EDGE_EXTRAS) {
        for (const arity of ['one', 'two'] as const) {
          const files = filesOf(base);
          const words = ['python3', script, ...extras];
          editJson(files, DEPLOY, (phase) => {
            phase.checks.smoke.commands = arity === 'one' ? [words] : [words, ['python3', 'api/main.py', '--selfcheck']];
          });
          const bytes = zipFiles(files);
          out.push({ name: `edge ${base}: smoke ${arity} ${JSON.stringify(words)}`, shapes: ['5:smoke.edge'], archive: () => Buffer.from(bytes) });
        }
      }
    }
  }
  return out;
}

/** The fixed corpus: shelf, shelf-preview, shelf-task, and every accepted hostile.ts entry. */
export function fixedCorpus(): Variant[] {
  const bases: Base[] = ['shelf', 'shelf-preview', 'shelf-task'];
  return [
    ...bases.map((base) => {
      const bytes = zipFiles(filesOf(base));
      return { name: `corpus ${base}`, shapes: ['corpus'], archive: () => Buffer.from(bytes) };
    }),
    ...HOSTILE_ARCHIVES.filter((one) => one.expectedOutcome === 'accepted').map((one) => ({
      name: `corpus hostile.ts ${one.name}`,
      shapes: ['corpus'],
      archive: () => one.build(),
    })),
  ];
}

/* ------------------------------ the two sides ------------------------------ */

/** Publish's argv rule, verbatim: the expression at authoring.service.ts `executableInput`. */
export function publishArgvRefusals(content: ProjectContent): PackRefusal[] {
  const raw = rawPackManifestOf(content);
  const runShapes = [...checkPackRuns(raw), ...checkRunLimits(raw)];
  return runShapes;
}

export type DoorVerdict =
  | { accepted: true; source: PackSource }
  | { accepted: false; status: number; code: string; findings: string[] };

export type Door = (archive: Buffer, title?: string) => Promise<DoorVerdict>;

const CONTENT = new ContentService();

/** The real upload door: `UploadService.upload`, over an importer that only keeps the source it is handed. */
export const uploadDoor: Door = async (archive, title = TITLE) => {
  let handed: PackSource | null = null;
  const importer: TeacherDraftImporter = {
    async importTeacherDraft(source) {
      handed = source;
      return { projectId: 'p', versionId: 'v', slug: 's', report: {} as never };
    },
  };
  const service = new UploadService(importer, CONTENT, {} as never, CAP);
  try {
    await service.upload(TEACHER, { title, archiveBase64: archive.toString('base64') });
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const body = error.getResponse() as { code: string; findings?: { code: string }[] };
    return { accepted: false, status: error.getStatus(), code: body.code, findings: (body.findings ?? []).map((one) => one.code) };
  }
  if (!handed) throw new Error('the door accepted and handed the importer nothing');
  return { accepted: true, source: handed };
};

/**
 * What the importer stores as `compiled.content` for an accepted source with no
 * task-block words (importer.service.ts `writeTeacherDraft`): the loader's
 * content as the draft import loads it (an older Requirements or Design
 * converted), compiled once with the slug minted from the title. Throws what
 * the loader or the compiler throws (a pack nothing could store).
 */
export function storedContentOf(source: PackSource, title: string = TITLE): ProjectContent {
  const loaded = CONTENT.loadProject(source, { convertLegacyRequirements: true, convertLegacyDesign: true, warnings: [] });
  return compilePack({ ...loaded, slug: mintTeacherSlug(title, new Set()), title, version: DRAFT_FIRST_VERSION }).content;
}

/** One counterexample: an accepted archive whose stored content publish refuses for the argv rule. */
export interface Counterexample {
  name: string;
  codes: string[];
}

export interface PropertyRun {
  accepted: number;
  refused: number;
  /** Accepted by the door, but neither the loader nor the compiler could store it (only a stub door gets here). */
  unstorable: number;
  refusedBy: Record<string, number>;
  findings: Record<string, number>;
  /** How many accepted variants touched each shape tag (a variant with two tags counts under both). */
  acceptedShapes: Record<string, number>;
  counterexamples: Counterexample[];
}

/**
 * The shape families the property must see
 * ACCEPTED at least once, so no run shape is covered only by its refusals.
 * A tag maps to its family; a tag with no family (the corpus, the
 * script-only draw) is counted but never required.
 */
export const ACCEPTED_FAMILIES = ['5:smoke', '6:service', '6:seed', '1-4:harness', '1-2:hidden', 'U5:limit', 'command-key', '7:drill'] as const;
export function familyOf(shape: string): string | null {
  if (shape.startsWith('5:smoke')) return '5:smoke';
  if (shape === '6:preview.service' || shape === '6:preview.edge.service') return '6:service';
  if (shape === '6:preview.seed' || shape === '6:preview.edge.seed') return '6:seed';
  return (ACCEPTED_FAMILIES as readonly string[]).includes(shape) ? shape : null;
}
/** The families among `acceptedShapes` with at least one accepted variant. */
export function acceptedFamilies(acceptedShapes: Record<string, number>): string[] {
  const out = new Set<string>();
  for (const [shape, count] of Object.entries(acceptedShapes)) {
    const family = familyOf(shape);
    if (family && count > 0) out.add(family);
  }
  return [...out].sort();
}

/** The property over `variants`, asked of `door`: every accepted variant's stored content draws no run-shape refusal at publish. */
export async function runProperty(
  variants: Variant[],
  door: Door,
  publish: (content: ProjectContent) => PackRefusal[] = publishArgvRefusals,
): Promise<PropertyRun> {
  const run: PropertyRun = { accepted: 0, refused: 0, unstorable: 0, refusedBy: {}, findings: {}, acceptedShapes: {}, counterexamples: [] };
  for (const variant of variants) {
    const verdict = await door(variant.archive());
    if (!verdict.accepted) {
      run.refused += 1;
      run.refusedBy[verdict.code] = (run.refusedBy[verdict.code] ?? 0) + 1;
      for (const code of new Set(verdict.findings)) run.findings[code] = (run.findings[code] ?? 0) + 1;
      continue;
    }
    let content: ProjectContent;
    try {
      content = storedContentOf(verdict.source);
    } catch {
      run.unstorable += 1;
      continue;
    }
    run.accepted += 1;
    for (const shape of new Set(variant.shapes)) run.acceptedShapes[shape] = (run.acceptedShapes[shape] ?? 0) + 1;
    const refusals = publish(content);
    if (refusals.length > 0) run.counterexamples.push({ name: variant.name, codes: refusals.map((one) => one.code) });
  }
  return run;
}

/** A test-only door that accepts every archive it can read: the property must fail under it. */
export const acceptEverythingDoor: Door = async (archive) => {
  const entries = readZip(archive, zipLimits(CAP));
  return { accepted: true, source: new MemoryPackSource(entries, 'upload', packRootOf(entries)) };
};

/**
 * A test-only mutant of the real door: every pre-loader check and the loader,
 * but without the post-loader reading (`checkPackRuns(rawPackManifestOf(loaded))`,
 * upload.service.ts). In the pointer layout its canonical/-only pre-loader set
 * let through a preview script a phase mounted editable, which publish
 * refused. In the folder layout the pre-loader set is the mounts publish reads,
 * so dropping that reading lets nothing more through. The mutant
 * differs from the real door only in its refusals' words: it answers
 * PACK_INVALID for any archive `buildPackManifest` cannot read, which the
 * real door refuses too, and it lacks the real door's other checks (its text
 * rules), so it accepts at least what the real door accepts.
 */
export const preLoaderOnlyDoor: Door = async (archive) => {
  const entries = readZip(archive, zipLimits(CAP));
  const root = packRootOf(entries);
  const source = new MemoryPackSource(entries, 'upload', root);
  let manifest: ReturnType<typeof buildPackManifest>;
  try {
    manifest = buildPackManifest(source);
  } catch {
    // the folder layout's derivation refuses a pack it cannot read (a smoke script smoke/ does not hold); the real door says PACK_INVALID
    return { accepted: false, status: 400, code: 'PACK_INVALID', findings: [] };
  }
  const prefix = root ? `${root}/` : '';
  const names = entries.filter((one) => one.name.startsWith(prefix)).map((one) => one.name.slice(prefix.length)).filter(Boolean);
  const findings = [
    ...checkUploadShape(manifest),
    ...checkPackFiles(source, names),
    ...checkPackRuns(manifest),
    ...checkRunLimits(manifest),
    ...checkRuntimeProfile(manifest),
  ];
  if (findings.length) return { accepted: false, status: 400, code: findings[0].code, findings: findings.map((one) => one.code) };
  // the loader reads the folder layout only; an older archive is converted first, as the real door does
  let loadable: PackSource;
  try {
    loadable = isOlderLayout(source) ? layoutFromManifest(source).source : source;
    CONTENT.loadProject(loadable);
  } catch {
    return { accepted: false, status: 400, code: 'PACK_INVALID', findings: [] };
  }
  return { accepted: true, source: loadable };
};

/* ----------------------------------- specs ----------------------------------- */

// Imported by the e2e layer for its generator: the specs register only in this file's own run.
const testPath = String((expect.getState() as { testPath?: string }).testPath ?? '');
const OWN_RUN = testPath === '' || /upload-publish-argv\.property\.spec\.ts$/.test(testPath);

if (OWN_RUN) {
  describe('an archive the upload door accepts is never refused at publish for the argv rule (pure layer)', () => {
    let property: PropertyRun;
    const generated = generateVariants(PROPERTY_SEED, VARIANT_COUNT);
    const edges = previewEdgeVariants();
    const smokeEdges = smokeEdgeVariants();
    const variants = [...generated, ...edges, ...smokeEdges];

    it('GUARD: RUN_SHAPE_CODES is the shared RUN_SHAPE_REFUSAL_CODES, and each code’s marks are in the sentence upload-limits really writes', () => {
      expect([...RUN_SHAPE_CODES].sort()).toEqual([...RUN_SHAPE_REFUSAL_CODES].sort());
      // every run-shape sentence, drawn from the real rule over one raw manifest that breaks each
      const raw = {
        project: {
          preview: { service: { command: 'python3 x.py' }, seed: ['bash', 'x.sh', '--a'], cmd: 'x' },
        },
        warmup: null,
        phases: [
          {
            key: 'implementation',
            checks: { kind: 'code', runs: [{ id: 'a', language: 'ruby', harness: 'rspec', hiddenHarness: 'unittest', hiddenTestDir: 'h', timeoutSeconds: 99, memoryMb: 9999 }], smoke: { commands: [['python3', 'a;b.py']], implFiles: {} } },
            hiddenTestFiles: { a: ['h/notes.md'] },
            rest: {},
          },
          { key: 'deployment', checks: { kind: 'config', smoke: { commands: [[1]], implFiles: {} } }, hiddenTestFiles: {}, rest: {} },
        ],
        shippedFiles: [],
      };
      const found = [...checkPackRuns(raw as never), ...checkRunLimits(raw as never)];
      for (const code of RUN_SHAPE_CODES) {
        const sentences = found.filter((one) => one.code === code).map((one) => one.sentence);
        expect({ code, drawn: sentences.length > 0 }).toEqual({ code, drawn: true });
        expect({ code, marked: sentences.some((sentence) => RUN_SHAPE_SENTENCE_MARKS[code].some((mark) => sentence.includes(mark))) }).toEqual({ code, marked: true });
      }
    });

    it('the fixed corpus (shelf, shelf-preview, shelf-task, every accepted hostile.ts entry) is accepted, and publish’s argv expression over its stored content is []', async () => {
      const corpus = fixedCorpus();
      expect(corpus.map((one) => one.name)).toEqual(expect.arrayContaining(['corpus shelf', 'corpus shelf-preview', 'corpus shelf-task', 'corpus hostile.ts slug-tasktrackr']));
      for (const variant of corpus) {
        const verdict = await uploadDoor(variant.archive());
        expect({ variant: variant.name, accepted: verdict.accepted }).toEqual({ variant: variant.name, accepted: true });
        if (!verdict.accepted) continue;
        const content = storedContentOf(verdict.source);
        expect({ variant: variant.name, publish: publishArgvRefusals(content).map((one) => one.code) }).toEqual({ variant: variant.name, publish: [] });
      }
      // shelf-preview really is run shape 6: a service command and a seed, both reaching the rule
      const preview = await uploadDoor(corpus.find((one) => one.name === 'corpus shelf-preview')!.archive());
      const stored = storedContentOf((preview as { source: PackSource }).source);
      expect(stored.preview?.service.command).toEqual(['python3', 'api/main.py']);
      expect(stored.preview?.seed).toEqual(['python3', 'ops/seed.py']);
    }, 120_000);

    it(`PROPERTY: ${VARIANT_COUNT} seeded variants over the run-shape rule's seven shapes, plus shape 6's ${PREVIEW_EDGE_SCRIPTS.length * 2} and shape 5's ${SMOKE_EDGE_SCRIPTS.length * SMOKE_EDGE_EXTRAS.length * 4} enumerated edges: every one the door accepts publishes with no run-shape refusal`, async () => {
      expect(generated).toHaveLength(VARIANT_COUNT);
      expect(edges).toHaveLength(PREVIEW_EDGE_SCRIPTS.length * 2);
      expect(smokeEdges).toHaveLength(SMOKE_EDGE_SCRIPTS.length * SMOKE_EDGE_EXTRAS.length * 4);
      // the same seed is the same list
      expect(generateVariants(PROPERTY_SEED, 12).map((one) => one.name)).toEqual(generated.slice(0, 12).map((one) => one.name));
      property = await runProperty(variants, uploadDoor);
      // eslint-disable-next-line no-console
      console.log(`PROPERTY ${JSON.stringify({ seed: `0x${PROPERTY_SEED.toString(16)}`, variants: variants.length, accepted: property.accepted, refused: property.refused, unstorable: property.unstorable, refusedBy: property.refusedBy, findings: property.findings, acceptedShapes: property.acceptedShapes, counterexamples: property.counterexamples.length })}`);
      expect(property.counterexamples).toEqual([]);
      expect(property.unstorable).toBe(0);
      expect(property.accepted + property.refused).toBe(variants.length);
    }, 600_000);

    it('NON-VACUITY: the generator yields both verdicts, and its refusals reach every one of the run-shape rule’s ten codes', () => {
      expect(property).toBeDefined();
      expect(property.accepted).toBeGreaterThanOrEqual(30);
      expect(property.refused).toBeGreaterThanOrEqual(30);
      for (const code of RUN_SHAPE_CODES) expect({ code, reached: (property.findings[code] ?? 0) > 0 }).toEqual({ code, reached: true });
      const shapes = new Set(variants.flatMap((one) => one.shapes));
      expect([...shapes].sort()).toEqual(['1-2:hidden', '1-4:harness', '5:smoke', '5:smoke.edge', '6:preview.edge.seed', '6:preview.edge.service', '6:preview.script', '6:preview.seed', '6:preview.service', '7:drill', 'U5:limit', 'command-key']);
    });

    it('NON-VACUITY: every shape family is seen ACCEPTED at least once, not only refused', () => {
      expect(property).toBeDefined();
      expect(acceptedFamilies(property.acceptedShapes)).toEqual([...ACCEPTED_FAMILIES].sort());
    });

    it('NON-VACUITY (planted divergence): one extra argv word in an accepted variant’s stored smoke command turns publish’s expression red with ARGV_EXTRA, and the property reports it', async () => {
      const corpus = fixedCorpus();
      const verdict = await uploadDoor(corpus.find((one) => one.name === 'corpus shelf')!.archive());
      expect(verdict.accepted).toBe(true);
      const content = storedContentOf((verdict as { source: PackSource }).source);
      expect(publishArgvRefusals(content)).toEqual([]);
      const planted = JSON.parse(JSON.stringify(content)) as ProjectContent;
      const deployment = planted.phases.find((phase) => phase.key === 'deployment')!;
      if (deployment.checks.kind !== 'config') throw new Error('the Shelf pack\'s deployment is a config phase');
      deployment.checks.smokeCommands[0].push('--planted');
      expect(publishArgvRefusals(planted).map((one) => one.code)).toEqual(['ARGV_EXTRA']);
      // the same plant, through the property itself: the stored content is what publish reads
      const red = await runProperty(corpus.slice(0, 1), uploadDoor, (stored) => {
        const copy = JSON.parse(JSON.stringify(stored)) as ProjectContent;
        const smoke = copy.phases.find((phase) => phase.key === 'deployment')!.checks;
        if (smoke.kind === 'config') smoke.smokeCommands[0].push('--planted');
        return publishArgvRefusals(copy);
      });
      expect(red.counterexamples).toEqual([{ name: 'corpus shelf', codes: ['ARGV_EXTRA'] }]);
    }, 120_000);

    it('NON-VACUITY (stub door): a door that accepts every readable archive fails the property, with run-shape codes', async () => {
      const stub = await runProperty(variants, acceptEverythingDoor);
      // eslint-disable-next-line no-console
      console.log(`STUB ${JSON.stringify({ accepted: stub.accepted, unstorable: stub.unstorable, counterexamples: stub.counterexamples.length, codes: [...new Set(stub.counterexamples.flatMap((one) => one.codes))].sort() })}`);
      expect(stub.counterexamples.length).toBeGreaterThan(0);
      const codes = new Set(stub.counterexamples.flatMap((one) => one.codes));
      expect([...codes].every((code) => (RUN_SHAPE_CODES as readonly string[]).includes(code))).toBe(true);
      expect(codes.has('ARGV_EXTRA')).toBe(true);
    }, 600_000);

    it('the real door without its post-loader publish reading lets through no variant publish refuses: the folder layout\'s pre-loader set is the mounts publish reads', async () => {
      // In the pointer layout this mutant diverged: its pre-loader set was canonical/ alone, so a preview script a
      // phase mounted editable passed it and publish refused it (shelf-preview's shape 6). The folder layout derives
      // shippedFiles from the mounts, as publish's rawPackManifestOf does, so no variant can split the two readings;
      // the stub door and the planted divergence above keep the property's own non-vacuity.
      expect(property).toBeDefined();
      const mutant = await runProperty(variants, preLoaderOnlyDoor);
      // eslint-disable-next-line no-console
      console.log(`MUTANT ${JSON.stringify({ accepted: mutant.accepted, counterexamples: mutant.counterexamples.length })}`);
      expect(mutant.counterexamples).toEqual([]);
      // it accepts at least what the real door accepts (the real door's other checks, such as its text rules, refuse more)
      expect(mutant.accepted).toBeGreaterThanOrEqual(property.accepted);
    }, 600_000);
  });
}
