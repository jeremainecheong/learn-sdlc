import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { inflateRawSync } from 'zlib';
import { Logger } from '@nestjs/common';
import * as shared from '@learnsdlc/shared';
import { ContentService } from './content.service';
import { DirectoryPackSource } from './pack-source';
import { layoutFromManifest } from './legacy-layout';
import { compilePack, sandboxBudgetFor, soleTaskFor } from './pack-compiler';
import { sealedFilesOf } from './blob.store';
import {
  derivedFileRows,
  refuseReservedWorkspacePaths,
  refuseSealedWorkspaceBytes,
} from './importer.service';
import * as taskBlocksModule from './task-blocks';
import {
  SHELF_DIR,
  SHELF_MARKERS,
  SHELF_SLUG,
  SHELF_VERSION,
  TASKTRACKR_SENTINELS,
} from '../../test/fixtures/upload-packs/markers';
import { listArchive, packFilesOf, writeZip, zipDirectory } from '../../test/fixtures/upload-packs/archive';
import { HttpException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.decorators';
import { checkPackRuns, buildPackManifest } from '../authoring/upload-limits';
import { UploadService, type TeacherDraftImporter } from '../authoring/upload.service';
import * as hostileModule from '../../test/fixtures/upload-packs/hostile';
import { HOSTILE_ARCHIVES, HOSTILE_BY_NAME, touchesName } from '../../test/fixtures/upload-packs/hostile';
import * as contentDigestsCli from '../../test/cli/content-digests';
import * as verdictDigestsCli from '../../test/cli/verdict-digests';
import { FIXTURES_DIR, OLDER_SHELF_DIR } from '../../test/fixtures/paths';

/**
 * The two upload fixtures the upload, importer and validation tests use.
 *
 * `shelf` is a teacher's own application in the on-disk authoring format, and
 * the hostile set is what an upload must refuse. Both live under
 * `apps/api/test/fixtures/upload-packs/`; this spec holds them to their
 * documented shape, read-only, against the loader and compiler.
 */

const RUNTIME_MANIFEST = path.join(__dirname, '..', '..', 'runner', 'runtime_manifest.py');

/** A frozenset literal out of the runner's manifest, read as text (never edited). */
function allowList(name: string): Set<string> {
  const text = fs.readFileSync(RUNTIME_MANIFEST, 'utf-8');
  const at = text.indexOf(`${name} = frozenset({`);
  if (at < 0) throw new Error(`${name} is not in runtime_manifest.py`);
  const body = text.slice(at, text.indexOf('})', at));
  return new Set([...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

/** The supported run shapes 1–4: (language, harness, hiddenHarness, transform). */
const RUN_SHAPES_D2 = new Set([
  'python|pytest|unittest|false',
  'typescript|js|js|true',
  'python|pytest||false',
  'typescript|js||true',
]);

function readJson(rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(SHELF_DIR, rel), 'utf-8'));
}

/** Shelf's phase folders, as the folder layout lists its phases: every folder under phases/. */
function phaseFolders(): string[] {
  return fs.readdirSync(path.join(SHELF_DIR, 'phases'), { withFileTypes: true })
    .filter((one) => one.isDirectory())
    .map((one) => `phases/${one.name}`)
    .sort();
}

function load() {
  const content = new ContentService();
  return content.loadProject(new DirectoryPackSource(SHELF_DIR));
}

describe('the Shelf pack', () => {
  it('loads through DirectoryPackSource and compiles with today\'s pack-compiler with zero refusals', () => {
    const project = load();
    expect(project.slug).toBe(SHELF_SLUG);
    expect(project.version).toBe(SHELF_VERSION);
    const snapshot = compilePack(project);
    expect(snapshot.phases.map((p) => p.key)).toEqual([
      'requirements',
      'design',
      'implementation',
      'testing',
      'deployment',
      'maintenance',
    ]);
    // one work task per phase, the sole-task arm
    for (const phase of snapshot.phases) expect(phase.tasks).toHaveLength(1);
    const kinds = Object.fromEntries(project.phases.map((p) => [p.key, p.checks.kind]));
    expect(kinds).toEqual({
      requirements: 'story',
      design: 'design',
      implementation: 'code',
      testing: 'tests',
      deployment: 'config',
      maintenance: 'code',
    });

    const impl = project.phases.find((p) => p.key === 'implementation')!;
    if (impl.checks.kind !== 'code') throw new Error('implementation is not code');
    expect(impl.checks.runs.map((r) => r.id)).toEqual(['api', 'web']);
    for (const run of impl.checks.runs) expect(Object.keys(run.hiddenTestFiles).length).toBeGreaterThan(0);
    expect(Object.keys(impl.checks.solutionFiles).sort()).toEqual([...impl.checks.editableTargets].sort());
    // the starter fails: every editable target is a stub, never the solution
    for (const at of impl.checks.editableTargets) {
      const starter = impl.files.find((f) => f.path === at)!;
      expect(starter.editable).toBe(true);
      expect(starter.content).toContain('TODO(learner)');
      expect(starter.content).not.toBe(impl.checks.solutionFiles[at]);
    }

    const testing = project.phases.find((p) => p.key === 'testing')!;
    if (testing.checks.kind !== 'tests') throw new Error('testing is not tests');
    expect(testing.checks.runs).toHaveLength(2);
    expect(testing.checks.mutants.length).toBeGreaterThan(0);
    expect(testing.checks.mutants.length).toBeLessThanOrEqual(6);
    expect(testing.checks.minTests).toBeGreaterThan(0);
    expect(testing.checks.coverageKeywords.length).toBeGreaterThan(0);

    const deployment = project.phases.find((p) => p.key === 'deployment')!;
    if (deployment.checks.kind !== 'config') throw new Error('deployment is not config');
    // run shape 5 (the smoke command), exactly
    expect(deployment.checks.smokeCommands).toHaveLength(1);
    const [argv] = deployment.checks.smokeCommands;
    expect(argv).toHaveLength(3);
    expect(argv[0]).toBe('python3');
    expect(argv[1]).toMatch(/\.py$/);
    expect(Object.keys(deployment.checks.smokeImplFiles)).toContain(argv[1]);
    expect(argv[2]).toBe('--selfcheck');
    // the drill is its faulted files only (drill/ in the folder layout): no command of its own
    expect(deployment.checks.drill).toBeDefined();
    const rawDrill = readJson('phases/05-deployment/phase.json').checks.drill;
    expect(Object.keys(rawDrill).sort()).toEqual(['description', 'expectFailure', 'fault']);
    expect(fs.readdirSync(path.join(SHELF_DIR, 'phases', '05-deployment', 'drill')).length).toBeGreaterThan(0);

    const maintenance = project.phases.find((p) => p.key === 'maintenance')!;
    if (maintenance.checks.kind !== 'code') throw new Error('maintenance is not code');
    expect(maintenance.checks.runs.length).toBeGreaterThan(0);
    expect(maintenance.checks.runs.length).toBeLessThanOrEqual(4);
  });

  it('declares every test run in run shapes 1 to 4 and only allow-listed runtime packages', () => {
    const projectJson = readJson('project.json');
    const folders = phaseFolders();
    expect(folders).toHaveLength(6);
    for (const rel of folders) {
      const raw = readJson(`${rel}/phase.json`);
      for (const run of raw.checks.runs ?? []) {
        const shape = [run.language, run.harness, run.hiddenHarness ?? '', run.transform === true].join('|');
        expect({ at: `${rel} ${run.id}`, shape, allowed: RUN_SHAPES_D2.has(shape) }).toEqual({
          at: `${rel} ${run.id}`,
          shape,
          allowed: true,
        });
      }
    }
    expect(projectJson.preview).toBeUndefined();
    const python = allowList('ALLOWED_PYTHON');
    const node = allowList('ALLOWED_NODE');
    const tools = allowList('ALLOWED_TOOLS');
    for (const pin of projectJson.runtime.python.packages as string[]) {
      expect(python.has(pin.split('==')[0])).toBe(true);
    }
    for (const name of Object.keys(projectJson.runtime.node.packages)) expect(node.has(name)).toBe(true);
    for (const name of Object.keys(projectJson.runtime.node.tools ?? {})) expect(tools.has(name)).toBe(true);
  });

  it('plants one unique marker in every file of every sealed role, and none in a workspace file', () => {
    const project = load();
    const markers = Object.values(SHELF_MARKERS);
    expect(new Set(markers).size).toBe(markers.length);
    const seen: Record<keyof typeof SHELF_MARKERS, number> = {
      hidden: 0,
      solution: 0,
      reference: 0,
      impl: 0,
      mutant: 0,
      drill: 0,
    };
    for (const phase of project.phases) {
      for (const file of phase.files) {
        for (const marker of markers) expect({ at: `${phase.key}:${file.path}`, has: file.content.includes(marker) }).toEqual({ at: `${phase.key}:${file.path}`, has: false });
      }
      const checks = phase.checks;
      const expectAll = (role: keyof typeof SHELF_MARKERS, files: Record<string, string>) => {
        for (const [at, bytes] of Object.entries(files)) {
          expect({ role, at: `${phase.key}:${at}`, has: bytes.includes(SHELF_MARKERS[role]) }).toEqual({
            role,
            at: `${phase.key}:${at}`,
            has: true,
          });
          seen[role] += 1;
        }
      };
      if (checks.kind === 'code') {
        expectAll('hidden', checks.hiddenTestFiles);
        expectAll('solution', checks.solutionFiles);
      }
      if (checks.kind === 'tests') {
        expectAll('reference', checks.referenceTestFiles);
        expectAll('impl', checks.implFiles);
        for (const mutant of checks.mutants) expectAll('mutant', mutant.files);
      }
      if (checks.kind === 'config' && checks.drill) expectAll('drill', checks.drill.faultedFiles);
      // every sealed byte the importer derives for this phase carries a marker
      for (const [role, files] of Object.entries(sealedFilesOf(phase))) {
        if (role === 'support') continue; // locked helpers the learner reads by design
        for (const [at, bytes] of Object.entries(files ?? {})) {
          expect({ role, at: `${phase.key}:${at}`, marked: markers.some((m) => bytes.includes(m)) }).toEqual({
            role,
            at: `${phase.key}:${at}`,
            marked: true,
          });
        }
      }
    }
    for (const [role, count] of Object.entries(seen)) {
      expect({ role, planted: count > 0 }).toEqual({ role, planted: true });
    }
  });

  it('carries no TaskTrackr name, path or fact', () => {
    expect(TASKTRACKR_SENTINELS).toEqual([
      'TaskTrackr',
      'tasktrackr',
      'due_date',
      'TASK_SELECT',
      'CR-2',
      'schema.sql',
      'web/dist',
      'completeTask',
      'US-4',
      'Dana',
    ]);
    const hits: string[] = [];
    for (const file of packFilesOf(SHELF_DIR)) {
      const text = file.data.toString('utf-8');
      for (const sentinel of TASKTRACKR_SENTINELS) {
        if (text.includes(sentinel) || file.name.includes(sentinel)) hits.push(`${file.name}: ${sentinel}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('prices at most 24 per version and at most 10 per phase (sandboxBudgetFor)', () => {
    const project = load();
    const snapshot = compilePack(project);
    let total = 0;
    for (const phase of project.phases) {
      const budget = sandboxBudgetFor(phase, [soleTaskFor(phase)]);
      expect({ phase: phase.key, budget, withinPhaseCeiling: budget <= 10 }).toEqual({
        phase: phase.key,
        budget,
        withinPhaseCeiling: true,
      });
      expect(snapshot.sandboxBudgetByPhase[phase.key]).toBe(budget);
      total += budget;
    }
    expect(snapshot.sandboxBudget).toBe(total);
    expect(total).toBeLessThanOrEqual(24);
  });
});

/** The contract's two closed lists, read from it and nowhere else (no fallback: a renamed export is red here). */
const UPLOAD_CODES: readonly string[] = shared.UPLOAD_REFUSAL_CODES;
const RUN_SHAPE_CODES: readonly string[] = shared.RUN_SHAPE_REFUSAL_CODES;

/** One archive entry, as the diff compares it. */
function signature(entry: ReturnType<typeof listArchive>[number]): string {
  return JSON.stringify({
    flags: entry.flags,
    method: entry.method,
    crc: entry.crc32,
    compressed: entry.compressedSize,
    uncompressed: entry.uncompressedSize,
    external: entry.externalAttributes,
    madeBy: entry.versionMadeBy,
    data: createHash('sha256').update(entry.rawData).digest('hex'),
  });
}

/*
 * The Shelf pack as it shipped in the older layout (`OLDER_SHELF_DIR`, the frozen `older-shelf/`) is the
 * clean archive every hostile one is built from, since an attack is an edit of a teacher's older archive.
 */

/** A hostile pack on disk, converted once as the upload door converts an older archive, then loaded. */
function loadOlder(dir: string) {
  return new ContentService().loadProject(layoutFromManifest(new DirectoryPackSource(dir)).source);
}

/** A hostile archive written out to a temporary directory (it trusts the archive: fixtures only). */
function withExtracted<T>(name: string, use: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-preview-'));
  try {
    for (const entry of listArchive(HOSTILE_ARCHIVES.find((h) => h.name === name)!.build())) {
      const at = path.join(dir, entry.name);
      if (!at.startsWith(dir + path.sep)) throw new Error(`${name}: ${entry.name} leaves the directory`);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, entry.method === 8 ? inflateRawSync(entry.rawData) : entry.rawData);
    }
    return use(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function byName(entries: ReturnType<typeof listArchive>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of entries) {
    const list = out.get(entry.name) ?? [];
    list.push(signature(entry));
    out.set(entry.name, list);
  }
  return out;
}

describe('the hostile archives', () => {
  it('has one entry per attack the plan names', () => {
    expect(HOSTILE_ARCHIVES.map((h) => h.name).sort()).toEqual(
      [
        'path-traversal',
        'absolute-path',
        'symlink-entry',
        'duplicate-names',
        'case-colliding-names',
        'nul-in-name',
        'ratio-bomb',
        'total-size-bomb',
        'too-many-entries',
        'encrypted-flag',
        'crc-mismatch',
        'declared-size-mismatch',
        'runtime-outside-allow-lists',
        'run-timeout-above-limit',
        'run-memory-above-limit',
        'run-freeform-command-string',
        'run-own-command-key',
        'run-other-interpreter',
        'run-unshipped-script',
        'run-extra-arg',
        'run-shell-metacharacter',
        'run-harness-not-allowed',
        'run-hidden-not-a-file',
        'phase-two-work-tasks',
        'workspace-holds-hidden-blob',
        'editable-holds-solution-blob',
        'version-priced-25',
        'phase-priced-11',
        'slug-tasktrackr',
        'canonical-dot-env',
      ].sort(),
    );
  });

  it('every hostile archive names exactly one expected code in UPLOAD_REFUSALS ∪ RUN_SHAPE_REFUSAL_CODES', () => {
    expect(UPLOAD_CODES.length).toBeGreaterThan(0);
    expect(RUN_SHAPE_CODES.length).toBeGreaterThan(0);
    const codes = new Set([...UPLOAD_CODES, ...RUN_SHAPE_CODES]);
    const refused = HOSTILE_ARCHIVES.filter((h) => h.expectedOutcome === 'refused');
    // every entry but the one m3 says is accepted (next case) is a refusal
    expect(refused.length).toBe(HOSTILE_ARCHIVES.length - 1);
    for (const hostile of refused) {
      expect(typeof hostile.expectedCode).toBe('string');
      const code = hostile.expectedCode as string;
      // the upload door's own code: a run-shape refusal is mapped through `uploadRefusalForRunShape`, never compared raw
      const door = RUN_SHAPE_CODES.includes(code)
        ? shared.uploadRefusalForRunShape(code as shared.RunShapeRefusalCode)
        : code;
      expect({
        name: hostile.name,
        code,
        known: codes.has(code),
        expectedUploadCode: hostile.expectedUploadCode,
        uploadKnown: UPLOAD_CODES.includes(hostile.expectedUploadCode as string),
      }).toEqual({ name: hostile.name, code, known: true, expectedUploadCode: door, uploadKnown: true });
    }
    // and each run-shape refusal code is exercised at least once
    const named = new Set<string | null>(HOSTILE_ARCHIVES.map((h) => h.expectedCode));
    for (const code of RUN_SHAPE_CODES) expect({ code, named: named.has(code) }).toEqual({ code, named: true });
  });

  it('names an outcome for every entry, and the only accepted one is the archive slug the importer never reads (m3)', () => {
    for (const hostile of HOSTILE_ARCHIVES) {
      expect({ name: hostile.name, outcome: ['refused', 'accepted'].includes(String(hostile.expectedOutcome)) }).toEqual({
        name: hostile.name,
        outcome: true,
      });
    }
    expect(HOSTILE_ARCHIVES.filter((h) => h.expectedOutcome === 'accepted').map((h) => h.name)).toEqual([
      'slug-tasktrackr',
    ]);
    // the slug is minted from the title, never taken from the archive,
    // so an archive naming `tasktrackr` is imported under a minted slug and draws no refusal
    const slug = HOSTILE_BY_NAME.get('slug-tasktrackr')!;
    expect(slug.expectedCode).toBeNull();
    expect(slug.expectedUploadCode).toBeNull();
    expect(slug.mintedSlugIsNot).toBe('tasktrackr');
    for (const hostile of HOSTILE_ARCHIVES.filter((h) => h.name !== 'slug-tasktrackr')) {
      expect(hostile.mintedSlugIsNot).toBeUndefined();
    }
  });

  it("keeps no copy of XC's code lists of its own (the fixture reads the contract)", () => {
    const own = Object.keys(hostileModule).filter((key) => /REFUSAL_CODES/.test(key));
    expect(own).toEqual([]);
  });

  it('each hostile archive differs from the clean Shelf archive only in its attack', () => {
    // the clean archive is the frozen older Shelf every attack is built from, file for file
    const clean = listArchive(zipDirectory(OLDER_SHELF_DIR));
    expect(clean.map((e) => e.name)).toEqual(packFilesOf(OLDER_SHELF_DIR).map((f) => f.name));
    const before = byName(clean);
    for (const hostile of HOSTILE_ARCHIVES) {
      const after = byName(listArchive(hostile.build()));
      const changed = new Set<string>();
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        if (JSON.stringify(before.get(name) ?? []) !== JSON.stringify(after.get(name) ?? [])) changed.add(name);
      }
      const outside = [...changed].filter((name) => !touchesName(hostile, name));
      expect({ name: hostile.name, changed: changed.size > 0, outside }).toEqual({
        name: hostile.name,
        changed: true,
        outside: [],
      });
    }
  });

  it('sizes each size attack as exactly the attack it claims (32 MiB, 2,000 entries, 100:1)', () => {
    const cap = (shared as unknown as { COHORT_IMPORT_MAX_BYTES: number }).COHORT_IMPORT_MAX_BYTES;
    expect(cap).toBe(32 * 1024 * 1024);
    const shape = (buf: Buffer) => {
      const entries = listArchive(buf);
      const ratios = entries.map((e) => (e.compressedSize ? e.uncompressedSize / e.compressedSize : 0));
      return {
        archive: buf.length,
        entries: entries.length,
        total: entries.reduce((sum, e) => sum + e.uncompressedSize, 0),
        maxRatio: Math.max(...ratios),
      };
    };
    const cleanShape = shape(zipDirectory(SHELF_DIR));
    expect(cleanShape.entries).toBeLessThanOrEqual(2000);
    expect(cleanShape.total).toBeLessThanOrEqual(cap);
    expect(cleanShape.maxRatio).toBeLessThanOrEqual(100);

    const by = (name: string) => shape(HOSTILE_ARCHIVES.find((h) => h.name === name)!.build());
    const ratio = by('ratio-bomb');
    expect(ratio.maxRatio).toBeGreaterThan(100);
    expect(ratio.total).toBeLessThanOrEqual(cap);
    expect(ratio.entries).toBeLessThanOrEqual(2000);
    const total = by('total-size-bomb');
    expect(total.total).toBeGreaterThan(cap);
    expect(total.archive).toBeLessThan(cap);
    expect(total.maxRatio).toBeLessThanOrEqual(100);
    expect(total.entries).toBeLessThanOrEqual(2000);
    const many = by('too-many-entries');
    expect(many.entries).toBeGreaterThan(2000);
    expect(many.total).toBeLessThanOrEqual(cap);
    expect(many.maxRatio).toBeLessThanOrEqual(100);
  });

  it('prices the two ceiling attacks as they claim (sandboxBudgetFor over the hostile pack)', () => {
    const priced = (name: string) =>
      withExtracted(name, (dir) => {
        const project = loadOlder(dir);
        return Object.fromEntries(project.phases.map((p) => [p.key, sandboxBudgetFor(p, [soleTaskFor(p)])]));
      });
    const version = priced('version-priced-25');
    expect(Object.values(version).reduce((a, b) => a + b, 0)).toBe(25);
    expect(Math.max(...Object.values(version))).toBeLessThanOrEqual(10);
    const phase = priced('phase-priced-11');
    expect(phase.testing).toBe(11);
    expect(Object.values(phase).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(24);
  });

  it("draws today's own walls where one exists: decision 37's two byte rules and the runtime allow-list", () => {
    // each hostile pack is an older archive, converted once as the door converts one
    const rowsOf = (dir: string) => derivedFileRows(loadOlder(dir));
    // the clean pack clears both byte rules and the reserved prefixes
    const clean = derivedFileRows(load());
    expect(() => refuseSealedWorkspaceBytes('shelf', clean)).not.toThrow();
    expect(() => refuseReservedWorkspacePaths('shelf', clean)).not.toThrow();
    // rule 1: a learner-facing row holding the hidden suite's bytes
    withExtracted('workspace-holds-hidden-blob', (dir) =>
      expect(() => refuseSealedWorkspaceBytes('shelf', rowsOf(dir))).toThrow(/also holds as a hidden file/),
    );
    // rule 2: an editable row holding the answer's bytes
    withExtracted('editable-holds-solution-blob', (dir) =>
      expect(() => refuseSealedWorkspaceBytes('shelf', rowsOf(dir))).toThrow(/editable workspace file .* as a solution file/),
    );
    // the loader's own allow-list read of runtime_manifest.py
    withExtracted('runtime-outside-allow-lists', (dir) =>
      expect(() => loadOlder(dir)).toThrow(
        /"requests" is not on the runner's allowlist/,
      ),
    );
  });

  it('builds every archive in memory, deterministically', () => {
    for (const hostile of HOSTILE_ARCHIVES) {
      const one = hostile.build();
      const two = hostile.build();
      expect(Buffer.isBuffer(one)).toBe(true);
      expect(one.equals(two)).toBe(true);
    }
  });
});

describe('--pack-dir on the two digest CLIs', () => {
  const FIXTURES = FIXTURES_DIR;

  /** Swallow the CLIs' own stdout/stderr lines; the spies record them. */
  function quiet() {
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return {
      err,
      restore: () => {
        out.mockRestore();
        err.mockRestore();
      },
    };
  }

  it('refuses --pack together with --pack-dir rather than silently ignore --pack', () => {
    for (const parse of [contentDigestsCli.parseOptions, verdictDigestsCli.parseOptions]) {
      const q = quiet();
      try {
        expect(parse(['--pack', 'tasktrackr', '--pack-dir', SHELF_DIR])).toBeNull();
        expect(parse(['--pack-dir', SHELF_DIR, '--pack', 'tasktrackr'])).toBeNull();
        expect(parse(['--pack-dir'])).toBeNull();
        expect(parse(['--pack-dir', SHELF_DIR, '--check'])).toMatchObject({ packs: [], packDirs: [SHELF_DIR], check: true });
        // the default path's options are untouched
        expect(parse(['--pack', 'tasktrackr'])).toMatchObject({ packs: ['tasktrackr'], packDirs: [], check: false });
      } finally {
        q.restore();
      }
    }
  });

  it('content-digests --pack-dir writes <slug>-<version>-content-digests.json, the committed shelf fixture byte for byte', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-cd-'));
    const q = quiet();
    try {
      const options = { packs: [], check: false, out: dir, packDirs: [SHELF_DIR] };
      expect(contentDigestsCli.recordPackDirs(options)).toBe(0);
      expect(fs.readdirSync(dir)).toEqual([`${SHELF_SLUG}-${SHELF_VERSION}-content-digests.json`]);
      expect(fs.readFileSync(path.join(dir, `${SHELF_SLUG}-${SHELF_VERSION}-content-digests.json`), 'utf-8')).toBe(
        fs.readFileSync(path.join(FIXTURES, `${SHELF_SLUG}-${SHELF_VERSION}-content-digests.json`), 'utf-8'),
      );
      // --check: matches the committed fixture, differs from an empty directory, writes nothing
      expect(contentDigestsCli.recordPackDirs({ ...options, check: true, out: FIXTURES })).toBe(0);
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-cd-empty-'));
      try {
        expect(contentDigestsCli.recordPackDirs({ ...options, check: true, out: empty })).toBe(1);
        expect(fs.readdirSync(empty)).toEqual([]);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      q.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verdict-digests --pack-dir never writes a golden whose grading logged a lost report section', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-vd-'));
    // every error the grader captures goes through the app logger (observability/errors.ts)
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const q = quiet();
    let code: number;
    try {
      code = await verdictDigestsCli.recordPackDirs({ packs: [], check: false, out: dir, packDirs: [SHELF_DIR] });
    } finally {
      q.restore();
    }
    const errors = logged.mock.calls.length;
    logged.mockRestore();
    try {
      const written = fs.readdirSync(dir);
      // If the recorder's enrolment double (test/verdict-golden.ts graderFor) answers another slug
      // than the graded one, a shelf grade logs "unknown project" and loses its report sections:
      // the CLI must refuse. When it answers the graded slug, nothing is logged and the golden is written.
      const expected = errors
        ? { code: 1, written: [] as string[] }
        : { code: 0, written: [`${SHELF_SLUG}-${SHELF_VERSION}-verdict-digests.json`] };
      expect({ code, written }).toEqual(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The 'written' arm pinned. graderFor answers the graded slug, so the
  // shelf grade logs nothing and the CLI writes the golden, the committed one byte for byte.
  it('verdict-digests --pack-dir writes a golden once no report section is lost', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-vd-written-'));
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const q = quiet();
    let code: number;
    try {
      code = await verdictDigestsCli.recordPackDirs({ packs: [], check: false, out: dir, packDirs: [SHELF_DIR] });
    } finally {
      q.restore();
    }
    const errors = logged.mock.calls.length;
    logged.mockRestore();
    const name = `${SHELF_SLUG}-${SHELF_VERSION}-verdict-digests.json`;
    try {
      expect({ code, errors, written: fs.readdirSync(dir) }).toEqual({ code: 0, errors: 0, written: [name] });
      expect(fs.readFileSync(path.join(dir, name), 'utf-8')).toBe(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shelf-1.0.0-verdict-digests.json matches a fresh grade', async () => {
    const name = `${SHELF_SLUG}-${SHELF_VERSION}-verdict-digests.json`;
    const at = path.join(FIXTURES, name);
    expect(fs.existsSync(at)).toBe(true);
    const held = fs.readFileSync(at, 'utf-8');
    // the golden is the shelf pack's own: its slug, its version, and per phase exactly its budgeted microVMs
    const golden = JSON.parse(held);
    expect({ slug: golden.slug, version: golden.version }).toEqual({ slug: SHELF_SLUG, version: SHELF_VERSION });
    const { sandboxBudgetByPhase } = compilePack(load());
    const jobsByPhase = Object.fromEntries(
      Object.entries(golden.phases as Record<string, { jobs: unknown[]; sandboxBudget: number }>).map(([key, phase]) => [
        key,
        { jobs: phase.jobs.length, budget: phase.sandboxBudget },
      ]),
    );
    expect(jobsByPhase).toEqual(
      Object.fromEntries(Object.entries(sandboxBudgetByPhase).map(([key, n]) => [key, { jobs: n, budget: n }])),
    );
    expect(Object.values(sandboxBudgetByPhase).reduce((a, b) => a + b, 0)).toBe(16);

    // --check, in-process through the CLI's own parser: a fresh grade matches and nothing is written
    const options = verdictDigestsCli.parseOptions(['--pack-dir', SHELF_DIR, '--check', '--out', FIXTURES]);
    if (options === null || options === 'help') throw new Error('parseOptions refused the --check options');
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let code: number;
    let empty = '';
    let emptyCode: number;
    let lines: string[] = [];
    try {
      code = await verdictDigestsCli.recordPackDirs(options);
      lines = out.mock.calls.map((call) => String(call[0]));
      empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-vd-empty-'));
      emptyCode = await verdictDigestsCli.recordPackDirs({ ...options, out: empty });
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const errors = logged.mock.calls.length;
    logged.mockRestore();
    try {
      expect({ code, errors, matches: lines.some((l) => l.startsWith(`${SHELF_SLUG} ${SHELF_VERSION}: matches`)) }).toEqual({
        code: 0,
        errors: 0,
        matches: true,
      });
      // against a directory without the golden it differs, and still writes nothing
      expect({ emptyCode, written: fs.readdirSync(empty) }).toEqual({ emptyCode: 1, written: [] });
      expect(fs.readFileSync(at, 'utf-8')).toBe(held);
    } finally {
      if (empty) fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

/**
 * Run shape 6 (the app preview) on a pack that asks for it.
 *
 * `shelf-preview/` is the shelf pack plus an App preview: `preview.service.command` and
 * `preview.seed`, each `["python3", <a .py the pack ships>]`, an esbuild build
 * block and `web/index.html`. It has no goldens; it exists so the upload is
 * proved to accept shape 6 and to refuse the argv one word off it.
 */
const SHELF_PREVIEW_DIR = path.join(path.dirname(SHELF_DIR), 'shelf-preview');

const UPLOADER: AuthUser = { id: 'teacher-shelf', email: 'teacher@shelf.test', role: 'INSTRUCTOR', cohort: 'default' };

/** UploadService over a mocked importer and an audit sink, as the upload service's own spec builds it. */
function uploadWorld() {
  const calls: unknown[] = [];
  const importer: TeacherDraftImporter = {
    async importTeacherDraft(source, opts) {
      calls.push([source, opts]);
      // The project.uploaded audit row is written inside the import's transaction through onWritten,
      // so the mock runs the hook as the real importer does (`manager` resolves at call time).
      await opts.onWritten?.(manager as never, { projectId: 'p-shelf', versionId: 'v-shelf', slug: 'shelf-preview' });
      return { projectId: 'p-shelf', versionId: 'v-shelf', slug: 'shelf-preview', report: { tier: 'fast', blocking: [], advisory: [] } } as never;
    },
  };
  const saved: unknown[] = [];
  const manager = {
    create: (_entity: unknown, row: unknown) => row,
    save: async (row: unknown) => {
      saved.push(row);
      return row;
    },
  };
  const dataSource = { manager, transaction: async (fn: (m: unknown) => unknown) => fn(manager) };
  return { service: new UploadService(importer, new ContentService(), dataSource as never, 32 * 1024 * 1024), calls, saved };
}

/** The sibling as an archive, with `project.json` rewritten by `edit` (in memory only). */
function previewArchive(edit: (project: any) => void = () => undefined): Buffer {
  return writeZip(
    packFilesOf(SHELF_PREVIEW_DIR).map((file) => {
      if (file.name !== 'project.json') return { name: file.name, data: file.data };
      const project = JSON.parse(file.data.toString('utf-8'));
      edit(project);
      return { name: file.name, data: Buffer.from(`${JSON.stringify(project, null, 2)}\n`) };
    }),
  );
}

describe('run shape 6: the shelf-preview sibling', () => {
  // the folder layout ships the two preview scripts as read-only mounts of the previewing phase
  it('is the Shelf pack plus a preview: only project.json, the implementation phase and its two new read-only mounts differ', () => {
    const shelf = new Map(packFilesOf(SHELF_DIR).map((f) => [f.name, f.data]));
    const sibling = new Map(packFilesOf(SHELF_PREVIEW_DIR).map((f) => [f.name, f.data]));
    const changed = [...new Set([...shelf.keys(), ...sibling.keys()])]
      .filter((name) => !(shelf.get(name)?.equals(sibling.get(name) ?? Buffer.alloc(0)) && sibling.has(name)))
      .sort();
    expect(changed).toEqual([
      'phases/03-implementation/phase.json',
      'phases/03-implementation/readonly/ops/seed.py',
      'phases/03-implementation/readonly/web/index.html',
      'project.json',
    ]);
    // nothing of the shelf is dropped
    for (const name of shelf.keys()) expect({ name, kept: sibling.has(name) }).toEqual({ name, kept: true });
  });

  it('the upload accepts shape 6', async () => {
    const raw = JSON.parse(fs.readFileSync(path.join(SHELF_PREVIEW_DIR, 'project.json'), 'utf-8'));
    // shape 6 exactly: python3 and one shipped .py, nothing after it
    expect(raw.preview.service.command).toEqual(['python3', 'api/main.py']);
    expect(raw.preview.seed).toEqual(['python3', 'ops/seed.py']);
    // each script a mount of the previewing phase, where the folder layout holds it
    for (const script of [raw.preview.service.command[1], raw.preview.seed[1]]) {
      expect(fs.existsSync(path.join(SHELF_PREVIEW_DIR, 'phases', '03-implementation', 'readonly', script))).toBe(true);
    }
    expect(raw.build).toEqual({ tool: 'esbuild', entry: 'web/src/main.ts', outfile: 'web/build/app.js', jsx: 'automatic' });

    // the run-shape rule over the raw manifest finds nothing
    expect(checkPackRuns(buildPackManifest(new DirectoryPackSource(SHELF_PREVIEW_DIR)))).toEqual([]);

    // the loader takes it, with the preview and the build it declared
    const project = new ContentService().loadProject(new DirectoryPackSource(SHELF_PREVIEW_DIR));
    expect(project.preview?.service.command).toEqual(['python3', 'api/main.py']);
    expect(project.preview?.seed).toEqual(['python3', 'ops/seed.py']);
    expect(project.preview?.web).toEqual({ root: 'web/build', html: 'web/index.html' });
    expect(project.build).toEqual({ tool: 'esbuild', entry: 'web/src/main.ts', outfile: 'web/build/app.js', jsx: 'automatic' });
    expect(project.phases.filter((p) => p.canPreview).map((p) => p.key)).toEqual(['implementation']);

    // and the upload door accepts the archive: one draft, one audit row, the shelf pack's price
    const { service, calls, saved } = uploadWorld();
    const result = await service.upload(UPLOADER, { title: 'Shelf with a preview', archiveBase64: previewArchive().toString('base64') });
    expect(calls).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(result.compile).toEqual({ phases: 6, tasks: 6, files: expect.any(Number), sandboxBudget: 16 });
  });

  it('an extra argument or another interpreter in the preview argv is refused (ARGV_EXTRA / ARGV_INTERPRETER)', async () => {
    const cases: { name: string; edit: (project: any) => void; finding: string; where: string }[] = [
      { name: 'service: an extra argument', edit: (p) => p.preview.service.command.push('--debug'), finding: 'ARGV_EXTRA', where: 'project.preview.service.command' },
      { name: 'seed: an extra argument', edit: (p) => p.preview.seed.push('--reset'), finding: 'ARGV_EXTRA', where: 'project.preview.seed' },
      { name: 'service: the smoke flag is not a preview flag', edit: (p) => p.preview.service.command.push('--selfcheck'), finding: 'ARGV_EXTRA', where: 'project.preview.service.command' },
      { name: 'service: another interpreter', edit: (p) => (p.preview.service.command[0] = 'node'), finding: 'ARGV_INTERPRETER', where: 'project.preview.service.command' },
      { name: 'seed: another interpreter', edit: (p) => (p.preview.seed[0] = 'python'), finding: 'ARGV_INTERPRETER', where: 'project.preview.seed' },
    ];
    for (const one of cases) {
      const { service, calls, saved } = uploadWorld();
      let status = 0;
      let body: any = null;
      try {
        await service.upload(UPLOADER, { title: 'Shelf with a preview', archiveBase64: previewArchive(one.edit).toString('base64') });
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        status = error.getStatus();
        body = error.getResponse();
      }
      expect({
        name: one.name,
        status,
        code: body?.code,
        findings: (body?.findings ?? []).map((f: { code: string; where: string }) => `${f.code} ${f.where}`),
        drafts: calls.length,
        audits: saved.length,
      }).toEqual({
        name: one.name,
        status: 400,
        code: shared.uploadRefusalForRunShape(one.finding as shared.RunShapeRefusalCode),
        findings: [`${one.finding} ${one.where}`],
        drafts: 0,
        audits: 0,
      });
    }
  });
});

/**
 * The `shelf-task` sibling, the smallest pack the loader and the
 * upload accept whose one phase (a written requirements phase) carries
 * phase.json's `task` block (key, title, brief, objectives; `docs/authoring-format.md`, "The task block in phase.json").
 * Its block is applied end to end in `test/task-block-round-trip.e2e-spec.ts`;
 * here it is held to its shape, to the importer's own block check, and to the
 * upload door. `shelf/`, `shelf-preview/` and `hostile.ts` are not touched.
 */
const SHELF_TASK_DIR = path.join(path.dirname(SHELF_DIR), 'shelf-task');

describe('the shelf-task sibling: one phase whose phase.json carries a task block (FMT)', () => {
  it('is four files: project.json, and one written phase with its task.md, phase.json and one workspace file', () => {
    expect(packFilesOf(SHELF_TASK_DIR).map((file) => file.name)).toEqual([
      'phases/01-requirements/files/my-story.md',
      'phases/01-requirements/phase.json',
      'phases/01-requirements/task.md',
      'project.json',
    ]);
    const phase = JSON.parse(fs.readFileSync(path.join(SHELF_TASK_DIR, 'phases/01-requirements/phase.json'), 'utf-8'));
    // A block's members are optional and PHASE_TASK_BLOCK_KEYS includes 'signOff'; the frozen fixture
    // carries exactly the four it declares, each one the block holds.
    expect(Object.keys(phase.task).sort()).toEqual(['brief', 'key', 'objectives', 'title']);
    for (const member of Object.keys(phase.task)) expect((taskBlocksModule.PHASE_TASK_BLOCK_KEYS as readonly string[]).includes(member)).toBe(true);
    expect(phase.task.key).toBe(shared.INHERITED_TASK_KEY);
    // the block says something the phase alone does not, so applying it is observable
    expect(phase.task.title).not.toBe(phase.title);
    expect(phase.task.objectives).not.toEqual(phase.objectives);
    expect(phase.task.brief).not.toBe(fs.readFileSync(path.join(SHELF_TASK_DIR, 'phases/01-requirements/task.md'), 'utf-8'));
  });

  it("loads at the door converted, compiles to one work task, and its block passes the importer's own check", () => {
    // shelf-task stays in the older layout; the door converts it once (its block's brief becomes taskPanel)
    const source = layoutFromManifest(new DirectoryPackSource(SHELF_TASK_DIR)).source;
    // its Requirements is of the older kind, which the platform loader refuses and the door converts
    expect(() => new ContentService().loadProject(source)).toThrow(shared.REQUIREMENTS_OLDER_FORMAT_REFUSAL);
    const project = new ContentService().loadProject(source, { convertLegacyRequirements: true, warnings: [] });
    expect(project.phases.map((phase) => [phase.key, phase.checks.kind])).toEqual([['requirements', 'story']]);
    const snapshot = compilePack(project);
    const blocks = taskBlocksModule.phaseTaskBlocksOf(source);
    expect([...blocks.keys()]).toEqual(['requirements']);
    const { where, block } = blocks.get('requirements')!;
    expect(where).toBe('phases/01-requirements');
    const task = taskBlocksModule.soleTaskForBlock(where, snapshot.phases[0].tasks, block);
    expect(task).toEqual(soleTaskFor(project.phases[0]));
  });

  it('the upload door accepts it: one draft, one audit row', async () => {
    const { service, calls, saved } = uploadWorld();
    const result = await service.upload(UPLOADER, { title: 'Shelf with a task block', archiveBase64: zipDirectory(SHELF_TASK_DIR).toString('base64') });
    expect(calls).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(result.compile).toEqual({ phases: 1, tasks: 1, files: expect.any(Number), sandboxBudget: 0 });
  });
});
