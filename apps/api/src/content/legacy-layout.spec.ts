import * as crypto from 'crypto';
import * as path from 'path';
import { languageOfPath, sortedMounts } from '@learnsdlc/shared';
import { NEW_LAYOUT_SECRET } from '../authoring/upload-limits';
import { phasesDigest } from '../seed/story-repin.service';
import { codeFolder, folderPack, projectJson } from '../../test/fixtures/folder-packs';
import { entriesOf } from '../../test/fixtures/upload-packs/archive';
import { olderShelfPack, olderTaskTrackrPack } from '../../test/legacy-phase';
import { pointerLoad } from '../../test/pointer-load';
import { ContentService, type LoadProjectOptions } from './content.service';
import type { CodeChecks, ProjectContent } from './content.types';
import { isFolderLayout, LayoutRefusal } from './folder-layout';
import { ConversionRefusal, isOlderLayout, languageWarning, layoutFromManifest, OLDER_LAYOUT_WARNING } from './legacy-layout';
import { MemoryPackSource } from './memory-pack-source';
import { compilePack } from './pack-compiler';
import { DirectoryPackSource, editorFolderSentence, LayoutWalkRefusal, machineOutputSentence, type PackSource } from './pack-source';
import { FIXTURES_DIR, OLDER_SHELF_DIR, UPLOAD_PACKS_DIR } from '../../test/fixtures/paths';

/**
 * An older archive converted once: `layoutFromManifest` reads
 * every pointer through the pointer loader's own readers and writes the
 * folder layout in memory, so the folder path compiles the converted pack to
 * the tasks the pointer path compiles the archive to, with its mounts in path
 * order and its languages derived. The proof is over the older upload
 * fixtures (`shelf-task`, `shelf-design-task`, the frozen `older-shelf/`) and
 * the archives built from the `legacy-*` fragments, TaskTrackr 5.0.0's
 * frozen phases among them, whose application phases source their files from
 * its own `canonical/`. `loadProject` reads only the folder layout, so the
 * pointer reading these cases compare with is `pointerLoad`
 * (`test/pointer-load.ts`), pinned by the first case to what the pointer
 * loader compiled.
 */

const PACKS = UPLOAD_PACKS_DIR;
/** Shelf as it shipped in the older layout, frozen. */
const OLDER_SHELF = OLDER_SHELF_DIR;
/** TaskTrackr's warm-up folder: a platform pack's, found by its folder now. */
const TASKTRACKR_WARMUP = path.resolve(__dirname, '../../../../content/tasktrackr/warmup');

/** The door's four conversions (`upload.service.ts`), on both sides of every comparison. */
const DOOR: LoadProjectOptions = { convertLegacyRequirements: true, convertLegacyDesign: true, convertLegacyRunbook: true, convertLegacyChange: true };

type Edit = (name: string, text: string) => string;

/**
 * A pack directory as an uploaded archive holds it: `edit` rewrites a named
 * text entry, `drop` leaves entries out, `add` puts new ones in.
 */
function archiveOf(dir: string, options: { edit?: Edit; drop?: (name: string) => boolean; add?: Record<string, string> } = {}): MemoryPackSource {
  const kept = entriesOf(dir)
    .filter((e) => !options.drop?.(e.name))
    .map((e) => ({ name: e.name, bytes: options.edit ? Buffer.from(options.edit(e.name, e.data.toString('utf8'))) : e.data }));
  const added = Object.entries(options.add ?? {}).map(([name, text]) => ({ name, bytes: Buffer.from(text) }));
  // the frozen older Shelf is the archive a teacher named shelf
  return new MemoryPackSource([...kept, ...added], dir === OLDER_SHELF ? 'shelf' : path.basename(dir), '');
}

/** One phase.json of an archive, edited as JSON. */
const phaseEdit = (folder: string, change: (spec: Record<string, any>) => void): Edit => (name, text) => {
  if (name !== `phases/${folder}/phase.json`) return text;
  const spec = JSON.parse(text);
  change(spec);
  return JSON.stringify(spec, null, 2);
};

/** A value's digest with its members in code-unit order, so the pin reads the compiled result, not its key order. */
function canonicalDigest(value: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return crypto.createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');
}

/** Every older fixture the proof covers, each a fresh source. */
const OLDER: [string, () => PackSource][] = [
  ['shelf-task', () => new DirectoryPackSource(path.join(PACKS, 'shelf-task'))],
  ['shelf-design-task', () => new DirectoryPackSource(path.join(PACKS, 'shelf-design-task'))],
  ['shelf (older-shelf)', () => new DirectoryPackSource(OLDER_SHELF)],
  ['TaskTrackr with legacy-deployment and legacy-maintenance', () => olderTaskTrackrPack()],
  ['Shelf with legacy-shelf', () => olderShelfPack()],
];

/**
 * What the pointer loader compiled each older fixture to, read the way the
 * folder layout reads it (`asFolderReads`): the compiled result's digest with
 * its members in code-unit order (`canonicalDigest`), `phasesDigest` over every
 * phase, and the loader's conversion notes. Recorded by driving the pointer
 * loader itself; `pointerLoad` must reproduce each one.
 */
const POINTER_LOADER_DIGESTS: Record<string, { compiled: string; phases: string; warnings: string[] }> = {
  'shelf-task': {
    compiled: '391b714df61fc1961bc92ed57d718bafcc59eac1ec59f0900bca9f7544391ddd',
    phases: '3f0b33bd35a7d9e183684fe0eb848c5a831efaf10802942d67d624a12c94a3e7',
    warnings: [
      "Requirements converted from markdown: 0 provided stories, learner story SH-5, default floor; 1 rule targets dropped",
    ],
  },
  'shelf-design-task': {
    compiled: 'eddef0ac78c78c907535c2b59865d7533a69612cee8d806602b718ea9d3f48fa',
    phases: '25e486ecaae34aef1bcea9d17482d6303ea33a27961b3e0db39a849dd6171a76',
    warnings: [
      "Requirements converted from markdown: 0 provided stories, learner story SH-5, default floor; 1 rule targets dropped",
      "Design converted from markdown: 3 rules became criterion sentences, the API contract off, the screen contract off, the sequence diagram off, the default floor, no stories listed yet (add them, or copy them from Requirements, in the builder); 2 markdown files dropped; the 60-word floor dropped (a design has no word floor), so \"Completeness\", which only it scored, keeps its own description.",
    ],
  },
  'shelf (older-shelf)': {
    compiled: '8023ddecee2dcae1edb08b967a5233edf6b5607ffe2dc78f3818c11e52965e50',
    phases: 'fbb6f8572fe8e4e337fc63069226cd315f42c10a1cf871bba603c77552378268',
    warnings: [],
  },
  'TaskTrackr with legacy-deployment and legacy-maintenance': {
    compiled: 'a077beb311d1cd10c7730ef923e9e88811f3b01d3ae2b53e72597e34fb6ae9ea',
    phases: '1eccdeb6ff3e139f605ab22ca1021623e362f26c6652864743b3cb95d56de9f9',
    warnings: [
      "Deployment converted to the runbook record: 6 runbook rules became criterion sentences; RUNBOOK.md became the starting runbook.",
      "Maintenance converted to the change request record: the ticket CR-2 built from the brief; the contract amendments on; CHANGELOG.md became the starting change request; change_request added, the other weights scaled by 0.85.",
    ],
  },
  'Shelf with legacy-shelf': {
    compiled: '85aabb2c9720bd86adde821c05bc72af8ee304fc0c8cf1a5c0f4b7476d9cafd0',
    phases: 'bd79108b065ac38194985995293bd5b7f8fe02f991fe2445d3188752b3582959',
    warnings: [
      "Deployment converted to the runbook record: 4 runbook rules became criterion sentences; RUNBOOK.md became the starting runbook.",
      "Maintenance converted to the change request record: the ticket CHG-1 built from the brief; the contract amendments off; change_request added, the other weights scaled by 0.85.",
    ],
  },
};

/** Each phase's task block brief, which the conversion moves into `taskPanel`. */
function blockBriefs(source: PackSource): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of JSON.parse(source.read('project.json')).phases as string[]) {
    const spec = JSON.parse(source.child(rel).read('phase.json'));
    if (spec.task && typeof spec.task.brief === 'string') out.set(spec.key, spec.task.brief);
  }
  return out;
}

/** The pointer path's load as the folder layout reads it: mounts in path order, languages derived, a block's brief as the brief. */
function asFolderReads(project: ProjectContent, briefs: Map<string, string>): ProjectContent {
  return {
    ...project,
    phases: project.phases.map((phase) => ({
      ...phase,
      taskPanel: briefs.get(phase.key) ?? phase.taskPanel,
      files: sortedMounts(phase.files).map((file) => ({ ...file, language: languageOfPath(file.path) })),
    })),
  };
}

const loadConverted = (source: PackSource): ProjectContent =>
  new ContentService().loadProject(layoutFromManifest(source).source, { ...DOOR, warnings: [], origin: 'upload' });

/** Every path the converted source holds. */
const pathsOf = (source: MemoryPackSource): string[] => source.walkForDigest('');

describe('layoutFromManifest: an older archive converted once', () => {
  it('converts each older fixture so the folder path compiles it to the pointer path\'s tasks, with mounts in path order and languages derived', () => {
    for (const [name, make] of OLDER) {
      const pointerSource = make();
      expect(isOlderLayout(pointerSource)).toBe(true);
      const pointerWarnings: string[] = [];
      const pointer = pointerLoad(pointerSource, { ...DOOR, warnings: pointerWarnings });
      const { source } = layoutFromManifest(make());
      expect(isOlderLayout(source)).toBe(false);
      expect(isFolderLayout(JSON.parse(source.read('project.json')))).toBe(true);
      const folderWarnings: string[] = [];
      const folder = new ContentService().loadProject(source, { ...DOOR, warnings: folderWarnings, origin: 'upload' });
      const expected = compilePack(asFolderReads(pointer, blockBriefs(make())));
      const actual = compilePack(folder);
      // the whole compiled result: the project's own members, every phase and every task
      expect({ name, compiled: actual }).toEqual({ name, compiled: expected });
      expect({ name, digest: phasesDigest(actual, []) }).toEqual({ name, digest: phasesDigest(expected, []) });
      // the loader's own conversion notes are the same on both paths
      expect({ name, warnings: folderWarnings }).toEqual({ name, warnings: pointerWarnings });
      // and the pointer reading is the deleted branch's own, at its last tree
      expect({ name, compiled: canonicalDigest(expected), phases: phasesDigest(expected, []), warnings: pointerWarnings }).toEqual({ name, ...POINTER_LOADER_DIGESTS[name] });
    }
    expect(Object.keys(POINTER_LOADER_DIGESTS)).toEqual(OLDER.map(([name]) => name));
  });

  it('warns once that the archive was in the older layout, and once per file whose declared language differs', () => {
    const mismatched = archiveOf(path.join(PACKS, 'shelf-design-task'), {
      edit: (name, text) => {
        if (!/^phases\/0[12]-[a-z]+\/phase\.json$/.test(name)) return text;
        const spec = JSON.parse(text);
        spec.files.push({ path: 'web/a.ts', source: spec.files[0].source, editable: false, language: 'javascript' });
        return JSON.stringify(spec, null, 2);
      },
    });
    expect(layoutFromManifest(mismatched).warnings).toEqual([OLDER_LAYOUT_WARNING, languageWarning('web/a.ts', 'javascript', 'typescript')]);
    expect(languageWarning('web/a.ts', 'javascript', 'typescript')).toBe('web/a.ts was declared javascript; it is read as typescript by its extension now.');
    expect(OLDER_LAYOUT_WARNING).toBe('This archive was in the older layout, with a list of phases and files. It was read once; its export will be in the folder layout.');
    // every declared language of the fixtures is its derived one, so their conversions warn only once
    for (const [, make] of OLDER) expect(layoutFromManifest(make()).warnings).toEqual([OLDER_LAYOUT_WARNING]);
  });

  it("prints the language warning's path through plainPath and its declared value clipped to 32 printable ASCII code units", () => {
    const longPath = `web/${'a'.repeat(170)}.ts`;
    const declaring = (file: Record<string, unknown>) =>
      archiveOf(OLDER_SHELF, {
        edit: phaseEdit('03-implementation', (spec) => {
          spec.files.push({ source: 'files/web/src/lib/shelf.ts', editable: false, ...file });
        }),
      });
    const warned = (file: Record<string, unknown>): string[] => layoutFromManifest(declaring(file)).warnings.slice(1);
    // a path longer than 160 characters is never echoed; a declared value is clipped and its unsafe bytes masked
    expect(warned({ path: longPath, language: 'java\u0000script\u00e9\nwith a tail long enough to be clipped' })).toEqual([
      'a file in the archive was declared java?script??with a tail long en; it is read as typescript by its extension now.',
    ]);
    // a plain path is printed exactly; a declared value that is not text is printed as its JSON, clipped the same way
    expect(warned({ path: 'web/b.ts', language: { name: 'javascript', note: 'x'.repeat(40) } })).toEqual([
      'web/b.ts was declared {"name":"javascript","note":"xxx; it is read as typescript by its extension now.',
    ]);
    expect(warned({ path: 'web/c.ts', language: 7 })).toEqual(['web/c.ts was declared 7; it is read as typescript by its extension now.']);
  });

  it("places the flat run's hidden files at their workspace paths", () => {
    const { source } = layoutFromManifest(olderTaskTrackrPack());
    const fixture = new DirectoryPackSource(path.join(FIXTURES_DIR, 'legacy-maintenance'));
    const at = 'phases/06-maintenance/hidden_tests';
    expect(source.walkLayout(at)).toEqual([
      'api/tests/test_change.py',
      'api/tests/test_regression.py',
      'web/web/src/components/change.test.tsx',
    ]);
    expect(source.read(`${at}/api/tests/test_change.py`)).toBe(fixture.read('hidden_tests/api/test_change.py'));
    const spec = JSON.parse(source.read('phases/06-maintenance/phase.json'));
    expect(spec.checks.runs.map((run: Record<string, unknown>) => run.hiddenTestDir)).toEqual([undefined, undefined]);
  });

  it('converts a flat code phase to its one run main, writing no runs', () => {
    const flat = archiveOf(OLDER_SHELF, {
      edit: phaseEdit('03-implementation', (spec) => {
        const [api] = spec.checks.runs;
        delete spec.checks.runs;
        spec.checks.hiddenTestDir = api.hiddenTestDir;
        spec.checks.visibleTests = api.visibleTests;
      }),
    });
    const pointer = pointerLoad(flat, { ...DOOR, warnings: [] }).phases.find((p) => p.key === 'implementation')!;
    const { source } = layoutFromManifest(flat);
    const spec = JSON.parse(source.read('phases/03-implementation/phase.json'));
    expect(spec.checks.runs).toBeUndefined();
    expect(spec.checks.hiddenTestDir).toBeUndefined();
    expect(source.walkLayout('phases/03-implementation/hidden_tests')).toEqual(['main/tests/test_hidden_shelf.py']);
    const folder = new ContentService().loadProject(source, { ...DOOR, warnings: [], origin: 'upload' }).phases.find((p) => p.key === 'implementation')!;
    const runs = (folder.checks as CodeChecks).runs;
    expect(runs.map((run) => run.id)).toEqual(['main']);
    expect(runs).toEqual((pointer.checks as CodeChecks).runs);
  });

  it('refuses a supportFiles map whose bytes differ from the locked mount at that path', () => {
    const differs = archiveOf(OLDER_SHELF, {
      edit: phaseEdit('04-testing', (spec) => {
        spec.checks.supportFiles['tests/conftest.py'] = '../../canonical/api/main.py';
      }),
    });
    expect(() => layoutFromManifest(differs)).toThrow(LayoutRefusal);
    expect(() => layoutFromManifest(differs)).toThrow(
      'phases/04-testing: checks.supportFiles gives tests/conftest.py other bytes than its read-only mount, and the folder layout holds one copy of a path. Make the two the same file and upload again.',
    );
    // the same bytes convert to a list of workspace paths, read from the mount
    const { source } = layoutFromManifest(new DirectoryPackSource(OLDER_SHELF));
    expect(JSON.parse(source.read('phases/04-testing/phase.json')).checks.supportFiles).toEqual(['tests/conftest.py']);
  });

  it('refuses a converted mount at a secret-shaped or editor path, naming the converted path', () => {
    const mounting = (file: Record<string, unknown>) =>
      archiveOf(OLDER_SHELF, {
        edit: phaseEdit('03-implementation', (spec) => {
          spec.files.push({ source: 'files/api/shelf.py', language: 'plaintext', ...file });
        }),
      });
    const secret = (file: Record<string, unknown>): string => {
      try {
        layoutFromManifest(mounting(file));
      } catch (error) {
        expect(error).toBeInstanceOf(ConversionRefusal);
        expect((error as ConversionRefusal).findings.every((one) => one.code === 'PACK_SECRET_FILE')).toBe(true);
        return (error as ConversionRefusal).message;
      }
      throw new Error('the archive converted');
    };
    // the archive holds no such name: the converted path is what makes it a secret
    expect(secret({ path: '.env', editable: false })).toBe(NEW_LAYOUT_SECRET('phases/03-implementation/readonly/.env'));
    expect(secret({ path: '.git/config', editable: true })).toBe(NEW_LAYOUT_SECRET('phases/03-implementation/files/.git/config'));
    expect(NEW_LAYOUT_SECRET('x/.env')).toBe('x/.env looks like a secret (a .env file, a private key or a credential). Leave secrets out of the archive and upload again.');
    const walk = (file: Record<string, unknown>): LayoutWalkRefusal => {
      try {
        layoutFromManifest(mounting(file));
      } catch (error) {
        expect(error).toBeInstanceOf(LayoutWalkRefusal);
        return error as LayoutWalkRefusal;
      }
      throw new Error('the archive converted');
    };
    expect(walk({ path: '.vscode/settings.json', editable: true }).message).toBe(editorFolderSentence('phases/03-implementation/files/.vscode'));
    expect(walk({ path: 'api/__pycache__/shelf.py', editable: false }).message).toBe(machineOutputSentence('phases/03-implementation/readonly/api/__pycache__'));
    expect(walk({ path: 'api/shelf.pyc', editable: false }).message).toBe(machineOutputSentence('phases/03-implementation/readonly/api/shelf.pyc'));
  });

  it("moves a task block's brief into taskPanel", () => {
    const pointer = new DirectoryPackSource(path.join(PACKS, 'shelf-task'));
    const before = JSON.parse(pointer.read('phases/01-requirements/phase.json'));
    const { source } = layoutFromManifest(pointer);
    const after = JSON.parse(source.read('phases/01-requirements/phase.json'));
    expect(after.taskPanel).toBe(before.task.brief);
    expect(after.task).toEqual({ key: before.task.key, title: before.task.title, objectives: before.task.objectives });
    expect(after.taskFile).toBeUndefined();
    expect(loadConverted(pointer).phases[0].taskPanel).toBe(before.task.brief);
    // with no block, the brief is the taskFile's bytes, inline
    const designPack = new DirectoryPackSource(path.join(PACKS, 'shelf-design-task'));
    const design = layoutFromManifest(designPack).source;
    expect(JSON.parse(design.read('phases/02-design/phase.json')).taskPanel).toBe(designPack.read('phases/02-design/task.md'));
  });

  it('leaves canonical/ and canonical/.env.example behind', () => {
    const archive = olderTaskTrackrPack();
    expect(archive.exists('canonical/.env.example')).toBe(true);
    for (const older of [archive, archiveOf(OLDER_SHELF)]) {
      const { source } = layoutFromManifest(older);
      expect(source.exists('canonical')).toBe(false);
      expect(pathsOf(source).filter((at) => at.startsWith('canonical/') || at.endsWith('.env.example'))).toEqual([]);
      // what is left is project.json and the phase folders
      expect(pathsOf(source).every((at) => at === 'project.json' || at.startsWith('phases/'))).toBe(true);
    }
  });

  it('converts an older archive whose mounts source ../../canonical/ from its own canonical/ folder, as TaskTrackr 5.0.0 does', () => {
    // TaskTrackr 5.0.0's phases 1 to 4 and the frozen legacy-deployment and legacy-maintenance as 5 and 6
    const archive = olderTaskTrackrPack();
    const { source } = layoutFromManifest(archive);
    const canonical = '../../canonical/';
    const landed: { from: string; at: string }[] = [];
    let mounts = 0;
    const meta = JSON.parse(archive.read('project.json'));
    for (const [i, rel] of (meta.phases as string[]).entries()) {
      const spec = JSON.parse(archive.child(rel).read('phase.json'));
      const folder = `phases/${String(i + 1).padStart(2, '0')}-${spec.key}`;
      for (const file of spec.files ?? []) {
        if (!file.source.startsWith(canonical)) continue;
        mounts += 1;
        landed.push({ from: file.source, at: `${folder}/${file.editable ? 'files' : 'readonly'}/${file.path}` });
      }
      const checks = spec.checks;
      for (const [dest, from] of Object.entries((checks.implFiles ?? {}) as Record<string, string>)) {
        if (from.startsWith(canonical)) landed.push({ from, at: `${folder}/impl/${dest}` });
      }
      // a support file is one of the phase's read-only mounts: one copy of a path
      for (const [dest, from] of Object.entries((Array.isArray(checks.supportFiles) ? {} : checks.supportFiles ?? {}) as Record<string, string>)) {
        if (from.startsWith(canonical)) landed.push({ from, at: `${folder}/readonly/${dest}` });
      }
      for (const [dest, from] of Object.entries((checks.smoke?.implFiles ?? {}) as Record<string, string>)) {
        if (from.startsWith(canonical)) landed.push({ from, at: `${folder}/smoke/${dest}` });
      }
      for (const [dest, value] of Object.entries((checks.drill?.faultedFiles ?? {}) as Record<string, unknown>)) {
        const from = typeof value === 'string' ? value : (value as { source?: string }).source;
        if (from?.startsWith(canonical)) landed.push({ from, at: `${folder}/drill/${dest}` });
      }
    }
    expect(landed).toHaveLength(126);
    expect(mounts).toBe(90);
    for (const one of landed) {
      expect({ at: one.at, bytes: source.read(one.at) }).toEqual({ at: one.at, bytes: archive.read(one.from.slice('../../'.length)) });
    }
    expect(pathsOf(source).some((at) => at.includes('canonical'))).toBe(false);
  });

  it("mounts legacy-deployment's .github/workflows/ci.yml at its path, editable", () => {
    const fixture = new DirectoryPackSource(path.join(FIXTURES_DIR, 'legacy-deployment'));
    const { source } = layoutFromManifest(olderTaskTrackrPack());
    expect(source.read('phases/05-deployment/files/.github/workflows/ci.yml')).toBe(fixture.read('files/ci.yml'));
    const deployment = loadConverted(olderTaskTrackrPack()).phases.find((p) => p.key === 'deployment')!;
    expect(deployment.files.find((f) => f.path === '.github/workflows/ci.yml')).toEqual({
      path: '.github/workflows/ci.yml',
      content: fixture.read('files/ci.yml'),
      editable: true,
      language: 'yaml',
    });
  });

  it('leaves desktop entries under phases/ out, notes each once at its original path, and converts none of them', () => {
    const desktop = {
      'phases/03-implementation/solution/api/Thumbs.db': 'thumbnails',
      'phases/03-implementation/hidden_tests/api/desktop.ini': '[.ShellClassInfo]',
      'phases/03-implementation/files/.DS_Store': 'finder',
      'phases/04-testing/mutants/__MACOSX/lend_twice_allowed/._shelf.py': 'fork',
      'phases/__MACOSX/03-implementation/._phase.json': 'fork',
    };
    const plain = layoutFromManifest(archiveOf(OLDER_SHELF));
    const { source, warnings } = layoutFromManifest(archiveOf(OLDER_SHELF, { add: desktop }));
    expect(source.leftOut()).toEqual([
      'phases/03-implementation/files/.DS_Store',
      'phases/03-implementation/hidden_tests/api/desktop.ini',
      'phases/03-implementation/solution/api/Thumbs.db',
      'phases/04-testing/mutants/__MACOSX/',
      'phases/__MACOSX/',
    ]);
    expect(pathsOf(source)).toEqual(pathsOf(plain.source));
    expect(warnings).toEqual([OLDER_LAYOUT_WARNING]);
    expect(compilePack(new ContentService().loadProject(source, { ...DOOR, warnings: [], origin: 'upload' })).phases)
      .toEqual(compilePack(new ContentService().loadProject(plain.source, { ...DOOR, warnings: [], origin: 'upload' })).phases);
    // a rebuilt source starts with nothing left out of its own
    expect(plain.source.leftOut()).toEqual([]);
  });

  it("carries a platform pack's warm-up folder to warmup/, and project.json names neither phases nor the warm-up", () => {
    // an older pack naming TaskTrackr's warm-up folder, as TaskTrackr 5.0.0 named its own
    const disk = new DirectoryPackSource(TASKTRACKR_WARMUP);
    const older = archiveOf(path.join(PACKS, 'shelf-task'), {
      edit: (name, text) => (name === 'project.json' ? JSON.stringify({ ...JSON.parse(text), warmup: 'warmup' }, null, 2) : text),
      add: Object.fromEntries(disk.walkForDigest().map((at) => [`warmup/${at}`, disk.read(at)])),
    });
    const { source } = layoutFromManifest(older);
    const meta = JSON.parse(source.read('project.json'));
    expect(meta.phases).toBeUndefined();
    expect(meta.warmup).toBeUndefined();
    expect(source.walkForDigest('warmup')).toEqual(disk.walkForDigest());
    for (const at of disk.walkForDigest()) expect(source.read(`warmup/${at}`)).toBe(disk.read(at));
  });

  it('reads the older layout from project.json: a phases member', () => {
    expect(isOlderLayout(new DirectoryPackSource(OLDER_SHELF))).toBe(true);
    expect(isOlderLayout(folderPack({ ...projectJson(), ...codeFolder() }))).toBe(false);
    expect(isOlderLayout(folderPack({ 'project.json': '{ not json' }))).toBe(false);
  });

  /* ---------------- each conversion rule pinned on its own ---------------- */

  it("places a mutant on the run its meta.run names: a flat web mutant lands at the web run's implementation path", () => {
    const nested = 'phases/04-testing/mutants/label_ignores_loan/web/src/lib/shelf.ts';
    const flatMutant = (): MemoryPackSource => {
      const bytes = new DirectoryPackSource(OLDER_SHELF).read(nested);
      return archiveOf(OLDER_SHELF, {
        drop: (name) => name === nested,
        add: { 'phases/04-testing/mutants/label_ignores_loan/shelf.ts': bytes },
      });
    };
    // its meta.run is web, the second run; the first run (api) holds no shelf.ts
    expect(JSON.parse(flatMutant().read('phases/04-testing/mutants/label_ignores_loan/meta.json')).run).toBe('web');
    const { source } = layoutFromManifest(flatMutant());
    expect(source.walkLayout('phases/04-testing/mutants/label_ignores_loan')).toEqual(['meta.json', 'web/src/lib/shelf.ts']);
    const pointer = pointerLoad(flatMutant(), { ...DOOR, warnings: [] });
    const folder = new ContentService().loadProject(source, { ...DOOR, warnings: [], origin: 'upload' });
    expect(compilePack(folder).phases).toEqual(compilePack(asFolderReads(pointer, blockBriefs(flatMutant()))).phases);
  });

  it('drops a "warmup": null from project.json, so an archive the pointer loader reads converts and loads', () => {
    const nullWarmup = archiveOf(path.join(PACKS, 'shelf-task'), {
      edit: (name, text) => (name === 'project.json' ? JSON.stringify({ ...JSON.parse(text), warmup: null }, null, 2) : text),
    });
    expect(JSON.parse(nullWarmup.read('project.json')).warmup).toBeNull();
    pointerLoad(nullWarmup, { ...DOOR, warnings: [] });
    const { source } = layoutFromManifest(nullWarmup);
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(source.read('project.json')), 'warmup')).toBe(false);
    expect(loadConverted(nullWarmup).phases.map((p) => p.key)).toEqual(['requirements']);
  });

  it('drops a supportFiles map the pointer loader never reads, on a phase that is not a tests phase', () => {
    const stray = archiveOf(OLDER_SHELF, {
      edit: phaseEdit('03-implementation', (spec) => {
        spec.checks.supportFiles = { 'tests/conftest.py': '../../canonical/tests/conftest.py' };
      }),
    });
    const pointer = pointerLoad(stray, { ...DOOR, warnings: [] });
    const { source } = layoutFromManifest(stray);
    expect(JSON.parse(source.read('phases/03-implementation/phase.json')).checks.supportFiles).toBeUndefined();
    const folder = new ContentService().loadProject(source, { ...DOOR, warnings: [], origin: 'upload' });
    expect(compilePack(folder).phases).toEqual(compilePack(asFolderReads(pointer, blockBriefs(stray))).phases);
  });

  it("names the archive's own folder when a subset's support map gives a path other bytes than its mount", () => {
    const subset = (change?: (spec: Record<string, any>) => void): MemoryPackSource =>
      archiveOf(OLDER_SHELF, {
        edit: (name, text) => {
          if (name === 'project.json') return JSON.stringify({ ...JSON.parse(text), phases: ['phases/03-implementation', 'phases/04-testing'] }, null, 2);
          return change ? phaseEdit('04-testing', change)(name, text) : text;
        },
      });
    // the subset converts to phases/02-testing, a folder the archive does not hold
    expect(layoutFromManifest(subset()).source.exists('phases/02-testing/phase.json')).toBe(true);
    const differs = subset((spec) => {
      spec.checks.supportFiles['tests/conftest.py'] = '../../canonical/api/main.py';
    });
    expect(() => layoutFromManifest(differs)).toThrow(LayoutRefusal);
    expect(() => layoutFromManifest(differs)).toThrow(
      'phases/04-testing: checks.supportFiles gives tests/conftest.py other bytes than its read-only mount, and the folder layout holds one copy of a path. Make the two the same file and upload again.',
    );
  });

  it("refuses a key held twice by naming the archive's two folders", () => {
    const twice = archiveOf(OLDER_SHELF, {
      edit: phaseEdit('04-testing', (spec) => {
        spec.key = 'implementation';
      }),
    });
    expect(() => layoutFromManifest(twice)).toThrow(LayoutRefusal);
    expect(() => layoutFromManifest(twice)).toThrow('phases/03-implementation and phases/04-testing both hold implementation. A project holds each phase once.');
  });

  it('refuses a mount whose path is not a plain relative path, in the loader\'s words, prefixed with the pack and the phase', () => {
    let index = -1;
    const escaping = archiveOf(OLDER_SHELF, {
      edit: phaseEdit('03-implementation', (spec) => {
        index = spec.files.length;
        spec.files.push({ path: '../escape.py', source: 'files/api/shelf.py', editable: false, language: 'python' });
      }),
    });
    expect(() => layoutFromManifest(escaping)).toThrow(
      `shelf/phases/03-implementation: files[${index}].path ("../escape.py") must be a relative path inside the workspace`,
    );
  });

  it("prefixes a reader's error with the pack and the archive's folder: a missing ../../canonical/ source", () => {
    const missing = archiveOf(OLDER_SHELF, {
      edit: phaseEdit('03-implementation', (spec) => {
        spec.files.push({ path: 'api/missing.py', source: '../../canonical/api/missing.py', editable: false, language: 'python' });
      }),
    });
    let message = '';
    try {
      layoutFromManifest(missing);
    } catch (error) {
      expect(error).not.toBeInstanceOf(LayoutRefusal);
      message = (error as Error).message;
    }
    expect(message.startsWith('shelf/phases/03-implementation: source file not found: ../../canonical/api/missing.py (resolved to ')).toBe(true);
  });

  it('reads the interview only for Requirements: a Design interview member writes no interview.json', () => {
    const designInterview = archiveOf(path.join(PACKS, 'shelf-design-task'), {
      edit: (name, text) => {
        if (!/^phases\/0[12]-[a-z]+\/phase\.json$/.test(name)) return text;
        return JSON.stringify({ ...JSON.parse(text), interview: '{"stakeholder": "a librarian"}' }, null, 2);
      },
    });
    const { source } = layoutFromManifest(designInterview);
    expect(pathsOf(source).filter((at) => at.endsWith('/interview.json'))).toEqual(['phases/01-requirements/interview.json']);
    expect(JSON.parse(source.read('phases/02-design/phase.json')).interview).toBeUndefined();
  });

  it('refuses two converted secrets with two findings in one ConversionRefusal, and a converted file holding a PEM key by its content', () => {
    const pem = `${['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ')}\nAAAA\n${['-----END', 'RSA PRIVATE KEY-----'].join(' ')}\n`;
    const mounting = (files: Record<string, unknown>[], add: Record<string, string> = {}) =>
      archiveOf(OLDER_SHELF, {
        add,
        edit: phaseEdit('03-implementation', (spec) => {
          spec.files.push(...files);
        }),
      });
    const refused = (archive: MemoryPackSource): ConversionRefusal => {
      try {
        layoutFromManifest(archive);
      } catch (error) {
        expect(error).toBeInstanceOf(ConversionRefusal);
        return error as ConversionRefusal;
      }
      throw new Error('the archive converted');
    };
    const two = refused(mounting([
      { path: '.env', source: 'files/api/shelf.py', editable: false, language: 'plaintext' },
      { path: 'keys/id_rsa', source: 'files/api/shelf.py', editable: false, language: 'plaintext' },
    ]));
    const where = ['phases/03-implementation/readonly/.env', 'phases/03-implementation/readonly/keys/id_rsa'];
    expect(two.findings).toEqual(where.map((at) => ({ code: 'PACK_SECRET_FILE', where: at, sentence: NEW_LAYOUT_SECRET(at) })));
    expect(two.message).toBe(where.map((at) => NEW_LAYOUT_SECRET(at)).join(' '));
    // the path is innocent; the bytes the pointer reached are a private key
    const keyed = refused(mounting(
      [{ path: 'api/notes.txt', source: 'files/api/notes.txt', editable: false, language: 'plaintext' }],
      { 'phases/03-implementation/files/api/notes.txt': pem },
    ));
    expect(keyed.findings).toEqual([{ code: 'PACK_SECRET_FILE', where: 'phases/03-implementation/readonly/api/notes.txt', sentence: NEW_LAYOUT_SECRET('phases/03-implementation/readonly/api/notes.txt') }]);
  });

  it("leaves a desktop file out of the warm-up's copy", () => {
    const withWarmup = archiveOf(path.join(PACKS, 'shelf-task'), {
      edit: (name, text) => (name === 'project.json' ? JSON.stringify({ ...JSON.parse(text), warmup: 'warmup' }, null, 2) : text),
      add: { 'warmup/hello.py': 'print("hello")\n', 'warmup/.DS_Store': 'finder', 'warmup/notes/Thumbs.db': 'thumbnails' },
    });
    const { source } = layoutFromManifest(withWarmup);
    expect(source.walkForDigest('warmup')).toEqual(['hello.py']);
    expect(source.read('warmup/hello.py')).toBe('print("hello")\n');
  });

  it("makes a task block's brief the taskPanel of a phase with neither taskFile nor taskPanel", () => {
    const blockOnly = archiveOf(path.join(PACKS, 'shelf-task'), {
      edit: phaseEdit('01-requirements', (spec) => {
        delete spec.taskFile;
        delete spec.taskPanel;
      }),
    });
    const before = JSON.parse(blockOnly.read('phases/01-requirements/phase.json'));
    expect(before.taskFile).toBeUndefined();
    expect(before.taskPanel).toBeUndefined();
    const { source } = layoutFromManifest(blockOnly);
    const after = JSON.parse(source.read('phases/01-requirements/phase.json'));
    expect(after.taskPanel).toBe(before.task.brief);
    expect(after.task.brief).toBeUndefined();
  });

  it("writes supportFiles: [] for a tests phase with runs and no map, so a run's support list is refused as the pointer loader refuses it", () => {
    const noMap = archiveOf(OLDER_SHELF, {
      edit: phaseEdit('04-testing', (spec) => {
        delete spec.checks.supportFiles;
      }),
    });
    const sentence = 'checks.supportFiles does not declare, so it would never reach the grading workspace';
    expect(() => pointerLoad(noMap, { ...DOOR, warnings: [] })).toThrow(sentence);
    const { source } = layoutFromManifest(noMap);
    expect(JSON.parse(source.read('phases/04-testing/phase.json')).checks.supportFiles).toEqual([]);
    expect(() => new ContentService().loadProject(source, { ...DOOR, warnings: [], origin: 'upload' })).toThrow(sentence);
  });

  it("drops each phase's order: a subset numbered 3 and 4 converts to 01-implementation and 02-testing, and an order the pointer loader refuses converts", () => {
    const subset = (order?: number): MemoryPackSource =>
      archiveOf(OLDER_SHELF, {
        edit: (name, text) => {
          if (name === 'project.json') return JSON.stringify({ ...JSON.parse(text), phases: ['phases/03-implementation', 'phases/04-testing'] }, null, 2);
          return order === undefined ? text : phaseEdit('03-implementation', (spec) => { spec.order = order; })(name, text);
        },
      });
    expect(pointerLoad(subset(), { ...DOOR, warnings: [] }).phases.map((p) => [p.key, p.order])).toEqual([['implementation', 3], ['testing', 4]]);
    const { source } = layoutFromManifest(subset());
    expect(source.entries('phases').map((one) => one.name)).toEqual(['01-implementation', '02-testing']);
    for (const folder of ['01-implementation', '02-testing']) expect(JSON.parse(source.read(`phases/${folder}/phase.json`)).order).toBeUndefined();
    expect(loadConverted(subset()).phases.map((p) => [p.key, p.order])).toEqual([['implementation', 1], ['testing', 2]]);
    // order 9 is no place in LearnSDLC's order: the pointer loader refuses it, the conversion never reads it
    expect(() => pointerLoad(subset(9), { ...DOOR, warnings: [] })).toThrow('order must be an integer 1..6');
    expect(loadConverted(subset(9)).phases.map((p) => [p.key, p.order])).toEqual([['implementation', 1], ['testing', 2]]);
  });
});
