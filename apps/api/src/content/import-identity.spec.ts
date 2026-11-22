import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { config } from '../config';
import {
  canonicalJson,
  contentDigestManifest,
  describeDifference,
  digestDifferences,
  projectHeaderOf,
  readGoldenDigests,
  sealedFilesOf,
  sealedPathsOf,
} from '../../test/content-golden';
import { blobShaFor } from './blob.store';
import { ContentService } from './content.service';
import type { PhaseContent, ProjectContent } from './content.types';
import { ProjectImporterService } from './importer.service';
import { COMPILER_IDENTITY, compilePack, contentDigestOf, type CompiledSnapshot } from './pack-compiler';
import { DirectoryPackSource } from './pack-source';
import { ProjectRegistryService } from './project-registry.service';
import type { SeedService } from '../seed/seed.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The registry runs after the seed's import, which it expresses by depending
 * on `SeedService` (see the service's own note). These specs are the import,
 * so what they hand it is a seed that has already run.
 */
const seeded = { importedContent: [] } as unknown as SeedService;

/**
 * The acceptance test for serving projects out of the database.
 *
 * The claim is that a project can come out of Postgres instead of out of the
 * image and no learner can tell. The way that claim is settled is by
 * deep equality: what the compiler produces from a pack's bytes must be exactly
 * what the loader produced from the same bytes, phase by phase, field by field,
 * including every sealed set. If this passes, nothing downstream of
 * `ContentService` can tell the difference, because there is no difference.
 *
 * The spec has two halves, and they are the two sources content can come from.
 * The first describe holds the compile path: the loader's output, the round trip
 * through the JSON column the snapshot is stored in, the digest manifest, and
 * the seal on what reaches a client. The second holds the database path itself:
 * import, publish, read the `compiled` column back, install it into a
 * `ContentService` that has never walked a directory, and answer every accessor
 * with the import source deleted.
 */
describe('the compiled snapshot is the pack', () => {
  let content: ContentService;
  let loaded: ProjectContent;
  let snapshot: CompiledSnapshot;

  beforeAll(() => {
    content = new ContentService();
    content.loadAll();
    loaded = content.getProject('tasktrackr');
    // the same bytes, read through the source the importer will read them
    // through, and compiled
    snapshot = compilePack(
      content.loadProject(new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr'))),
    );
  });

  it('the compiled snapshot deep-equals the on-disk load', () => {
    expect(snapshot.content).toEqual(loaded);
    expect(snapshot.content.phases.map((p) => p.key)).toEqual(loaded.phases.map((p) => p.key));
    expect(snapshot.slug).toBe(loaded.slug);
    expect(snapshot.version).toBe(loaded.version);
  });

  it('the compiled snapshot matches the recorded digests', () => {
    const recorded = readGoldenDigests('tasktrackr');
    expect(digestDifferences(snapshot.content, recorded).map(describeDifference)).toEqual([]);
    expect(contentDigestManifest(snapshot.content)).toEqual(recorded);
  });

  /**
   * The snapshot is stored in one `simple-json` column and read back by the
   * registry, so anything JSON cannot carry is a byte a learner loses. Nothing
   * in `ProjectContent` may be a `Map`, a `Set`, a `Date` or an `undefined`
   * that matters.
   */
  it('the compiled snapshot survives the round trip through a JSON column', () => {
    const stored = JSON.parse(JSON.stringify(snapshot)) as CompiledSnapshot;
    expect(stored).toEqual(snapshot);
    expect(stored.content).toEqual(loaded);
    // and through the canonical form the content digest is taken over
    expect(JSON.parse(canonicalJson(snapshot.content))).toEqual(loaded);
  });

  /**
   * The importer's idempotence key. A boot that finds this version already published
   * from the same bytes does nothing; one that finds it published from
   * different bytes refuses by name. Both depend on the digest being a
   * function of the content and sensitive to all of it.
   */
  it('the content digest is a function of the content', () => {
    expect(contentDigestOf(snapshot)).toBe(contentDigestOf(compilePack(loaded)));
    const moved: ProjectContent = {
      ...loaded,
      phases: loaded.phases.map((phase, i) =>
        i === 0 ? ({ ...phase, title: `${phase.title} ` } as PhaseContent) : phase,
      ),
    };
    expect(contentDigestOf(compilePack(moved))).not.toBe(contentDigestOf(snapshot));
  });

  /**
   * The existing seal (`content.service.ts`'s `workspaceFiles`), asserted
   * against the compiled snapshot rather than against the directory: the only
   * paths a client is handed are the phase's own `files`, so no sealed path can
   * ride out on a payload however the content arrived.
   */
  it('the compiled snapshot sends no sealed path to a client', () => {
    for (const phase of snapshot.content.phases) {
      const mounted = new Set(phase.files.map((f) => f.path));
      const served = content.workspaceFiles(phase, null).map((f) => f.path);
      expect(served.filter((at) => !mounted.has(at))).toEqual([]);
      const sealedOnly = Object.values(sealedPathsOf(phase))
        .flat()
        .filter((at) => !mounted.has(at));
      expect(served.filter((at) => sealedOnly.includes(at))).toEqual([]);
      // the hidden suite is the case that matters, and it is sealed-only by
      // construction: the fourth isolation seal is that no phase mounts it
      expect(sealedOnly.length).toBeGreaterThanOrEqual(
        phase.checks.kind === 'code' ? Object.keys(phase.checks.hiddenTestFiles).length : 0,
      );
    }
  });

  /**
   * The five blobs that are a **locked `workspace` row** in one phase and a
   * sealed `solution` file in another.
   *
   * They are the counter-example that decides where a role lives: one sha is
   * reached by many rows under many roles, so `project_files.role` is the only
   * place a role can exist and "these bytes are the answer" is a statement
   * about a `(version, phase, path)`. Asserted here, from the loaded content
   * and against the five known shas, so that the importer's row writer
   * inherits a hashing convention that is already proved: plain sha256 over
   * the file's bytes, with no normalisation of any kind.
   */
  it('the five dual-role blobs hash to the shas the design names', () => {
    const phase = (key: string): PhaseContent =>
      snapshot.content.phases.find((p) => p.key === key) as PhaseContent;
    const solutionOf = (key: string, at: string): string => {
      const checks = phase(key).checks;
      if (checks.kind !== 'code') throw new Error(`${key} is not a code phase`);
      return checks.solutionFiles[at];
    };
    const lockedIn = (key: string, at: string): string => {
      const file = phase(key).files.find((f) => f.path === at);
      if (!file || file.editable) throw new Error(`${at} is not locked in ${key}`);
      return file.content;
    };

    const dual: [string, string, string, string][] = [
      ['api/repository/tasks.py', 'implementation', 'testing', 'b1ec2b8726f65cfe2dfeb91567768b42377ccca4cafa83c82bb0b0f70e093f6b'],
      ['web/src/lib/overdue.ts', 'implementation', 'testing', 'd3215fe30f7996cde62c152dbddda76195fda4d6e69ce4cb654d9a4b46235350'],
      ['web/src/hooks/useTasks.ts', 'implementation', 'testing', '45737739a73d658cb5cb40e9baf182f5404c7af44400d46bb2b96fdc91e23e5a'],
      ['api/repository/comments.py', 'maintenance', 'testing', '03cfbdbbde4b509fc80cda50a3507400f0303dc1de0a97fe36f3e94d64b917df'],
      ['api/routes/comments.py', 'maintenance', 'testing', '54448befa1305d0fc4006c5e2591a7fb5c2f00277fe609f3cee7735e59ce219c'],
    ];
    for (const [at, answeredIn, lockedPhase, sha] of dual) {
      expect({ at, role: 'solution', sha: blobShaFor(solutionOf(answeredIn, at)) }).toEqual({
        at,
        role: 'solution',
        sha,
      });
      expect({ at, role: 'workspace', sha: blobShaFor(lockedIn(lockedPhase, at)) }).toEqual({
        at,
        role: 'workspace',
        sha,
      });
    }
  });

});

/**
 * The same claim, over rows.
 *
 * Above, the compiler was held against the loader. Here the pack goes all the
 * way through: `content/tasktrackr` is read by the loader, written as rows by
 * the importer, compiled into `project_versions.compiled`, read back out of
 * that column by `ProjectRegistryService`, and installed into a `ContentService`
 * that has **never** walked a directory. What comes out has to be the same
 * `ProjectContent`, phase for phase and sealed set for sealed set: that
 * equality is the whole of the database path's promise.
 *
 * The third test is the one the pin rests on: a published version is immutable,
 * so an enrolment resolved to one cannot have the ground move under an attempt,
 * and the accessor that makes that true is asserted here against two published
 * versions that genuinely differ.
 */
describe('the compiled snapshot is the pack, out of the database', () => {
  let dataSource: DataSource;
  let loader: ContentService;
  let importer: ProjectImporterService;
  let loaded: ProjectContent;
  let dir = '';

  const shippedPack = (): DirectoryPackSource =>
    new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr'));

  /** The shipped pack in a directory of its own, so a test may edit or delete it. */
  const copyOfThePack = (name: string): DirectoryPackSource => {
    const at = path.join(dir, name, 'tasktrackr');
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.cpSync(path.join(config.contentDir, 'tasktrackr'), at, { recursive: true });
    return new DirectoryPackSource(at);
  };

  const rewriteJson = (at: string, edit: (value: Record<string, unknown>) => void): void => {
    const value = JSON.parse(fs.readFileSync(at, 'utf-8')) as Record<string, unknown>;
    edit(value);
    fs.writeFileSync(at, JSON.stringify(value, null, 2), 'utf-8');
  };

  /** A database of its own, so one test's import cannot answer another's question. */
  const freshDatabase = async (): Promise<DataSource> =>
    memoryDataSource();

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-identity-'));
    dataSource = await freshDatabase();
    loader = new ContentService();
    loader.loadAll();
    loaded = loader.getProject('tasktrackr');
    importer = new ProjectImporterService(loader, dataSource);
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the compiled database snapshot deep-equals the on-disk load, through the importer', async () => {
    const result = await importer.importPack(shippedPack(), {
      origin: 'seed',
      platformOwned: true,
    });
    expect(result.outcome).toBe('imported');

    // a ContentService that has never read a file, fed only by the registry
    const registered = new ContentService();
    const registry = new ProjectRegistryService(registered, dataSource, seeded);
    expect(await registry.load()).toBe(1);

    const answer = registered.getProject('tasktrackr');
    expect(answer).toEqual(loaded);
    // the golden manifest keys phases by key, so it would not catch a reordered
    // `phases` array on its own: the order is asserted separately, here and on
    // the compile path above
    expect(answer.phases.map((p) => p.key)).toEqual(loaded.phases.map((p) => p.key));
    expect(answer.phases.map((p) => p.order)).toEqual(loaded.phases.map((p) => p.order));

    // and against the committed fixture, so it fails even if both sides drifted
    const recorded = readGoldenDigests('tasktrackr');
    expect(digestDifferences(answer, recorded).map(describeDifference)).toEqual([]);
    expect(contentDigestManifest(answer)).toEqual(recorded);
    expect(registered.headVersionIdFor('tasktrackr')).toBe(result.projectVersionId);
  });

  /**
   * The same equality, group by group, so that a failure names the phase and
   * the field rather than printing two copies of a whole project.
   *
   * `toEqual` over the project above is the stronger assertion and this one is
   * the readable one; both are kept because the first is what makes the claim
   * and the second is what a person debugging it can act on. The groups are
   * the content model's own list (files, checks, rubric, assistant, runtime, preview,
   * warm-up and every sealed set) read here off the **database** copy.
   */
  it('every phase out of the database matches the disk, field group by field group', async () => {
    const own = await freshDatabase();
    try {
      await new ProjectImporterService(new ContentService(), own).importPack(shippedPack(), {
        origin: 'seed',
        platformOwned: true,
      });
      const registered = new ContentService();
      expect(await new ProjectRegistryService(registered, own, seeded).load()).toBe(1);
      const fromDb = registered.getProject('tasktrackr');

      // the project's own header, and the three blocks that hang off it
      expect(projectHeaderOf(fromDb)).toEqual(projectHeaderOf(loaded));
      expect({ group: 'runtime', value: fromDb.runtime }).toEqual({
        group: 'runtime',
        value: loaded.runtime,
      });
      expect({ group: 'preview', value: fromDb.preview }).toEqual({
        group: 'preview',
        value: loaded.preview,
      });
      expect({ group: 'warmup', value: fromDb.warmup }).toEqual({
        group: 'warmup',
        value: loaded.warmup,
      });
      expect({ group: 'build', value: fromDb.build }).toEqual({
        group: 'build',
        value: loaded.build,
      });

      const groups = [
        'files',
        'checks',
        'rubric',
        'assistant',
        'interview',
        'objectives',
        'title',
        'intro',
        'order',
        'canRun',
        'canPreview',
        'runLabel',
        'artifactKind',
      ] as const;
      expect(fromDb.phases).toHaveLength(loaded.phases.length);
      for (const [at, disk] of loaded.phases.entries()) {
        const db = fromDb.phases[at];
        expect(db.key).toBe(disk.key);
        for (const group of groups) {
          expect({ phase: db.key, group, value: db[group] }).toEqual({
            phase: disk.key,
            group,
            value: disk[group],
          });
        }
        // the sealed sets, by bytes and by path: the hidden suite, the
        // solutions, the references, the mutants, the support files, the drill
        // and the interview brief
        expect({ phase: db.key, group: 'sealed', value: sealedFilesOf(db) }).toEqual({
          phase: disk.key,
          group: 'sealed',
          value: sealedFilesOf(disk),
        });
        expect({ phase: db.key, group: 'sealedPaths', value: sealedPathsOf(db) }).toEqual({
          phase: disk.key,
          group: 'sealedPaths',
          value: sealedPathsOf(disk),
        });
      }
    } finally {
      await own.destroy();
    }
  });

  /**
   * (c): a published version keeps its stored snapshot for ever, so the only
   * way a drift can be noticed is if the snapshot says which build produced
   * it. Recorded at compile, carried through the JSON column, read back by the
   * registry.
   */
  it('the compiled snapshot records the compiler that produced it', async () => {
    const own = await freshDatabase();
    try {
      const result = await new ProjectImporterService(new ContentService(), own).importPack(
        shippedPack(),
        { origin: 'seed', platformOwned: true },
      );
      expect(result.compilerDrift).toBeNull();
      const registry = new ProjectRegistryService(new ContentService(), own, seeded);
      const [version] = await registry.publishedVersions();
      expect(version.compiler).toBe(COMPILER_IDENTITY);
      expect(version.versionId).toBe(result.projectVersionId);
    } finally {
      await own.destroy();
    }
  });

  it('the compiled snapshot is the only source at runtime, with the content directory unreadable', async () => {
    const own = await freshDatabase();
    try {
      const source = copyOfThePack('unreadable');
      const importing = new ProjectImporterService(new ContentService(), own);
      await importing.importPack(source, { origin: 'seed', platformOwned: true });

      // the import source is gone: every answer below has one possible
      // origin, the `compiled` column
      fs.rmSync(path.join(dir, 'unreadable'), { recursive: true, force: true });
      expect(fs.existsSync(source.location)).toBe(false);
      expect(source.available()).toBe(false);

      const registered = new ContentService();
      expect(await new ProjectRegistryService(registered, own, seeded).load()).toBe(1);

      expect(registered.getProject('tasktrackr')).toEqual(loaded);
      for (const phase of loaded.phases) {
        const answer = registered.getPhase('tasktrackr', phase.key);
        expect(answer).toEqual(phase);
        expect(registered.workspaceFiles(answer, null)).toEqual(
          loader.workspaceFiles(phase, null),
        );
        expect(registered.executionFiles(answer, null)).toEqual(
          loader.executionFiles(phase, null),
        );
        expect(registered.drillSpec(answer)).toEqual(loader.drillSpec(phase));
        expect(registered.faultedExecutionFiles(answer, null)).toEqual(
          loader.faultedExecutionFiles(phase, null),
        );
        expect(registered.interviewBrief(answer)).toEqual(loader.interviewBrief(phase));
        expect(registered.getPhaseByOrder('tasktrackr', phase.order).key).toBe(phase.key);
      }
      expect(registered.designFilesFor('tasktrackr')).toEqual(loader.designFilesFor('tasktrackr'));
      expect(registered.getProject('tasktrackr').warmup ?? null).toEqual(loader.getProject('tasktrackr').warmup ?? null);
      // the warm-up is the case that would have been missed: it is loaded by a
      // reader of its own (`warmup.loader.ts`, which still reads `fs`
      // directly), and out of the snapshot it is one JSON member like
      // everything else
      expect(registered.getProject('tasktrackr').warmup?.files.length).toBeGreaterThan(0);
    } finally {
      await own.destroy();
    }
  });

  /**
   * The other half of "ContentService reads no file at runtime", and it is the half the deleted directory cannot
   * cover on its own: `config.contentDir` still holds the very same bytes, so
   * an accessor that quietly fell back to it would answer *correctly* above.
   * What rules that out is that there is no call to fall back through.
   */
  it('the accessors have no file to read: content.service.ts calls no fs', () => {
    const text = fs.readFileSync(path.join(__dirname, 'content.service.ts'), 'utf-8');
    const calls = text
      .split('\n')
      .map((line, at) => ({ at: at + 1, line }))
      .filter(({ line }) => /(^|[^.\w])fs\s*\./.test(line) && !line.trim().startsWith('*'))
      .map(({ at, line }) => `${at}: ${line.trim()}`);
    expect(calls).toEqual([]);
    // and it imports none either, so a future edit has to add the import back
    // before it can add the call
    expect(text).not.toMatch(/from 'fs'/);
    // the three readers that do touch a disk are named and are all reached from
    // `loadProject` or `loadAll`, which the importer and the two CLIs call and
    // no request path does
    expect(text).toMatch(/import \{ PackSource, directoryPacksIn, readRunnerFile \} from '\.\/pack-source';/);
    expect(text).toMatch(/import \{ loadWarmup \} from '\.\/warmup\.loader';/);
  });

  it('getForEnrollment answers the pinned version, and the published head for a null pin', async () => {
    const own = await freshDatabase();
    try {
      const importing = new ProjectImporterService(new ContentService(), own);
      const first = await importing.importPack(shippedPack(), {
        origin: 'seed',
        platformOwned: true,
      });

      // the bumped pack: a new published version, differing in one phase title
      const bumped = copyOfThePack('bumped');
      rewriteJson(path.join(bumped.location, 'project.json'), (meta) => {
        meta.version = '6.0.1';
      });
      rewriteJson(path.join(bumped.location, 'phases', '01-requirements', 'phase.json'), (phase) => {
        phase.title = 'Requirements, revised';
      });
      const second = await importing.importPack(bumped, { origin: 'seed', platformOwned: true });
      expect(second.outcome).toBe('imported');
      expect(second.version).toBe('6.0.1');

      const registered = new ContentService();
      expect(await new ProjectRegistryService(registered, own, seeded).load()).toBe(2);

      // the head is the newest published version, and it is what a request
      // naming the project answers
      expect(registered.getProject('tasktrackr').version).toBe('6.0.1');
      expect(registered.headVersionIdFor('tasktrackr')).toBe(second.projectVersionId);
      expect(registered.getPhase('tasktrackr', 'requirements').title).toBe('Requirements, revised');

      // an enrolment pinned to the superseded version still resolves it: that is
      // the pin doing its job, not a bug
      const pinned = { projectSlug: 'tasktrackr', projectVersionId: first.projectVersionId };
      expect(registered.getForEnrollment(pinned).version).toBe('6.0.0');
      expect(registered.getPhaseForEnrollment(pinned, 'requirements').title).toBe(
        loaded.phases[0].title,
      );
      expect(registered.getForEnrollment(pinned)).toEqual(loaded);

      // and a legacy row, which resolves the head and is not rewritten by the read
      const legacy = { projectSlug: 'tasktrackr', projectVersionId: null };
      expect(registered.getForEnrollment(legacy).version).toBe('6.0.1');
      expect(legacy.projectVersionId).toBeNull();
      expect(registered.getForEnrollment(pinned).warmup ?? null).toEqual(loaded.warmup ?? null);
    } finally {
      await own.destroy();
    }
  });
});
