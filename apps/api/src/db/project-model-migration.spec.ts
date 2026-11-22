import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  ALL_ENTITIES,
  ContentBlobEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
  UserEntity,
} from './entities';
import { H1ProjectModel1789600000000 } from '../migrations/1789600000000-H1-ProjectModel';
import { H2CohortAssignmentAndEnrolmentPin1789600100000 } from '../migrations/1789600100000-H2-CohortAssignmentAndEnrolmentPin';

/**
 * H1 and H2 on the local-first store.
 *
 * The tree these migrations land in is a deployed release holding a term of
 * coursework, so the two questions this spec asks are the two an operator asks:
 * does the migrated schema land exactly on the entities, and does a database
 * that already holds a learner's work come out of it byte-identical.
 *
 * `database.module.spec.ts` already asserts both properties over *every*
 * migration: zero pending schema-builder queries after the run, and a full
 * revert back to an empty file, and that assertion is the parity gate. This
 * spec is the narrow one: it names H1 and H2, it proves each of the seven new
 * tables actually accepts a row, and it proves the reversal in dependency
 * order, so a failure says which migration and which table rather than
 * "the schema has drifted".
 *
 * Postgres is the same proof against a real server, in the `.postgres.spec.ts`
 * beside this file; it self-skips where none is configured, which is correct
 * rather than a gap.
 */
describe('the project model migrations', () => {
  const migrations = [path.join(__dirname, '..', 'migrations', '*.{ts,js}')];
  let dir = '';
  let opened: DataSource[] = [];

  const optionsFor = (file: string): DataSourceOptions =>
    ({
      type: 'better-sqlite3',
      database: file,
      entities: ALL_ENTITIES,
      synchronize: false,
      migrationsRun: true,
      migrations,
      migrationsTableName: 'learnsdlc_migrations',
    }) as DataSourceOptions;

  const open = async (file: string): Promise<DataSource> => {
    const dataSource = await new DataSource(optionsFor(file)).initialize();
    opened.push(dataSource);
    return dataSource;
  };

  const tables = async (dataSource: DataSource): Promise<string[]> =>
    (
      await dataSource.query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
    ).map((row: { name: string }) => row.name);

  /**
   * Revert until H1 is no longer applied, however many migrations were added
   * after it. A fixed count of undos would revert a later migration instead
   * and say nothing about these two.
   */
  const revertPastH1 = async (dataSource: DataSource): Promise<void> => {
    const applied = async (): Promise<string[]> =>
      (await dataSource.query(`SELECT name FROM learnsdlc_migrations`)).map(
        (row: { name: string }) => row.name,
      );
    let names = await applied();
    while (names.includes('H1ProjectModel1789600000000')) {
      await dataSource.undoLastMigration();
      names = await applied();
    }
  };

  /** The column names a table holds right now, in the schema's own order. */
  const columnsOf = async (dataSource: DataSource, table: string): Promise<string[]> =>
    (await dataSource.query(`PRAGMA table_info("${table}")`)).map(
      (column: { name: string }) => column.name,
    );

  /** The columns `enrollments` had before the pin, so the snapshot is of them alone. */
  const ENROLMENT_COLUMNS =
    '"id","userId","projectSlug","currentPhaseOrder","completed","packVersion","mentorMemory","startedAt","completedAt"';

  /**
   * A learner's term of work, as text, so a comparison is byte-for-byte.
   *
   * `enrollments` and `submissions` name their columns instead of taking `*`,
   * and for one reason: a release that ADDs a column to either table changes
   * what `*` returns without touching a byte a learner wrote, and the question
   * here is whether the retained bytes moved. `ENROLMENT_COLUMNS` is the
   * hand-written form of that for H2's pin column; `submissionColumns` is read
   * off the *previous* release's own file, so a later migration that widens
   * `submissions` (H3 did) does not have to edit this test to be judged by it.
   */
  const coursework = async (
    dataSource: DataSource,
    submissionColumns: string[],
  ): Promise<Record<string, string>> => ({
    users: JSON.stringify(await dataSource.query(`SELECT * FROM "users" ORDER BY "id"`)),
    enrollments: JSON.stringify(
      await dataSource.query(`SELECT ${ENROLMENT_COLUMNS} FROM "enrollments" ORDER BY "id"`),
    ),
    phase_states: JSON.stringify(
      await dataSource.query(`SELECT * FROM "phase_states" ORDER BY "id"`),
    ),
    submissions: JSON.stringify(
      await dataSource.query(
        `SELECT ${submissionColumns.map((name) => `"${name}"`).join(',')} ` +
          `FROM "submissions" ORDER BY "id"`,
      ),
    ),
  });

  /**
   * One learner, enrolled, one phase worked and one attempt handed in: written
   * as the *previous* release wrote it, which is why the enrolment is raw SQL:
   * that release's entity had no pin column, so its insert named none.
   */
  const seedCoursework = async (dataSource: DataSource): Promise<void> => {
    const user = await dataSource.getRepository(UserEntity).save({
      email: 'retained@learnsdlc.test',
      passwordHash: 'unusable-test-hash',
      displayName: 'Retained learner',
    });
    const enrollmentId = 'retained-enrolment';
    await dataSource.query(
      `INSERT INTO "enrollments" ("id","userId","projectSlug","currentPhaseOrder","completed","packVersion") ` +
        `VALUES (?,?,?,?,?,?)`,
      [enrollmentId, user.id, 'tasktrackr', 2, 0, '2.0.1'],
    );
    const phase = await dataSource.getRepository(PhaseStateEntity).save({
      userId: user.id,
      enrollmentId,
      phaseKey: 'requirements',
      phaseOrder: 1,
      status: 'passed',
      bestScore: 88,
      attempts: 3,
      workspace: { 'requirements/draft.md': '# retained draft' },
    });
    // Raw SQL for the same reason the enrolment above is raw: the current
    // entity carries columns the pre-H1 table has not got (H3's `taskKey`
    // among them) and an insert through the repository names every one of
    // them. An insert of that era named these six.
    await dataSource.query(
      `INSERT INTO "submissions" ("id","userId","phaseStateId","status","score","passed") ` +
        `VALUES (?,?,?,?,?,?)`,
      ['retained-submission', user.id, phase.id, 'completed', 88, 1],
    );
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-h1-'));
  });

  afterEach(async () => {
    for (const dataSource of opened) {
      if (dataSource.isInitialized) await dataSource.destroy();
    }
    opened = [];
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lands exactly on the entity schema and holds a row in every new table', async () => {
    const dataSource = await open(path.join(dir, 'fresh.sqlite'));

    // The assertion that the migrated schema and the entities agree: this is
    // the DDL synchronize would still want to run, and it has to be nothing.
    const pending = await dataSource.driver.createSchemaBuilder().log();
    expect(pending.upQueries.map((query) => query.query)).toEqual([]);

    const applied = await dataSource.query(`SELECT name FROM learnsdlc_migrations ORDER BY id`);
    expect(applied.map((row: { name: string }) => row.name)).toEqual(
      expect.arrayContaining([
        'H1ProjectModel1789600000000',
        'H2CohortAssignmentAndEnrolmentPin1789600100000',
      ]),
    );

    // and they are working tables, not just shapes
    const blob = await dataSource.getRepository(ContentBlobEntity).save({
      sha: 'a'.repeat(64),
      bytes: 'print("hello")\n',
      size: 15,
    });
    const project = await dataSource.getRepository(ProjectEntity).save({
      slug: 'tasktrackr',
      title: 'TaskTrackr',
      platformOwned: true,
      ownerUserId: null,
      isDefault: true,
      origin: 'seed',
    });
    const version = await dataSource.getRepository(ProjectVersionEntity).save({
      projectId: project.id,
      version: '2.0.1',
      status: 'published',
      manifest: { tagline: 't', description: 'd', language: 'python', languages: ['python'] },
      compiled: null,
      contentDigest: 'b'.repeat(64),
      sandboxBudget: 20,
      publishedAt: new Date().toISOString(),
    });
    const phase = await dataSource.getRepository(ProjectPhaseEntity).save({
      projectVersionId: version.id,
      key: 'requirements',
      order: 1,
      title: 'Requirements',
      intro: 'Write the story.',
      artifactKind: 'story',
      canRun: false,
      canPreview: false,
      runLabel: '',
      assistant: { systemPrompt: 'help', topics: [], progressive: [] },
      interview: null,
    });
    const task = await dataSource.getRepository(ProjectTaskEntity).save({
      projectPhaseId: phase.id,
      taskKey: 'story',
      order: 1,
      required: true,
      signOff: false,
      artefactType: 'user-story',
      artefactPath: 'requirements/draft.md',
      title: 'The story',
      brief: '# brief',
      objectives: ['one'],
      primaryPath: null,
      anchor: null,
      rubric: { passThreshold: 70, criteria: [] },
      checks: { kind: 'story', record: 'requirements/story.json', providedStories: [], learnerStory: { id: 'US-1', hints: {} }, floor: { minCriteria: 2, requiredTags: [], minExclusions: 1, requireSentence: true } },
    });
    const file = await dataSource.getRepository(ProjectFileEntity).save({
      projectVersionId: version.id,
      ownerKind: 'phase',
      ownerId: phase.id,
      path: 'requirements/draft.md',
      role: 'workspace',
      editable: true,
      language: 'markdown',
      blobSha: blob.sha,
    });
    const enrollment = await dataSource.getRepository(EnrollmentEntity).save({
      userId: 'pinned-learner',
      projectSlug: 'tasktrackr',
      packVersion: '2.0.1',
      projectVersionId: version.id,
    });

    expect({ blob: blob.sha, task: task.taskKey, file: file.role, pin: enrollment.projectVersionId })
      .toEqual({ blob: 'a'.repeat(64), task: 'story', file: 'workspace', pin: version.id });
    // the pin is nullable, because an enrolment made before the model existed
    // has none and the read resolves the published head for it
    const legacy = await dataSource.getRepository(EnrollmentEntity).save({
      userId: 'legacy-learner',
      projectSlug: 'tasktrackr',
    });
    expect(legacy.projectVersionId ?? null).toBeNull();
  });

  it('refuses a second draft, a duplicate phase order and a re-used file path', async () => {
    const dataSource = await open(path.join(dir, 'indexes.sqlite'));
    const projects = dataSource.getRepository(ProjectEntity);
    const versions = dataSource.getRepository(ProjectVersionEntity);
    const phases = dataSource.getRepository(ProjectPhaseEntity);
    const files = dataSource.getRepository(ProjectFileEntity);

    const project = await projects.save({ slug: 'ledger', title: 'Ledger', origin: 'blank' });
    const manifest = { tagline: 't', description: 'd', language: 'python', languages: ['python'] };
    const draft = await versions.save({
      projectId: project.id,
      version: '0.1.0',
      status: 'draft',
      manifest,
    });
    // one draft at a time, settled in the database rather than by a read
    await expect(
      versions.save(versions.create({ projectId: project.id, version: '0.2.0', status: 'draft', manifest })),
    ).rejects.toThrow();
    // and a published version may sit beside it
    await versions.save(versions.create({ projectId: project.id, version: '0.0.9', status: 'published', manifest }));

    const phase = await phases.save({
      projectVersionId: draft.id,
      key: 'requirements',
      order: 1,
      title: 'Requirements',
      intro: 'i',
      artifactKind: 'story',
      assistant: { systemPrompt: 'help', topics: [], progressive: [] },
    });
    await expect(
      phases.save(
        phases.create({
          projectVersionId: draft.id,
          key: 'design',
          order: 1,
          title: 'Design',
          intro: 'i',
          artifactKind: 'story',
          assistant: { systemPrompt: 'help', topics: [], progressive: [] },
        }),
      ),
    ).rejects.toThrow();

    const row = {
      projectVersionId: draft.id,
      ownerKind: 'phase' as const,
      ownerId: phase.id,
      path: 'requirements/draft.md',
      editable: true,
      language: 'markdown',
      blobSha: 'c'.repeat(64),
    };
    await files.save({ ...row, role: 'workspace' });
    // the natural key: one row per owner and path, which is why a sealed row's
    // path is the material's own path rather than the workspace path
    await expect(files.save(files.create({ ...row, role: 'solution' }))).rejects.toThrow();
    await files.save({ ...row, path: 'solution/requirements/draft.md', role: 'solution' });
    expect(await files.count()).toBe(2);
  });

  it('reverses in dependency order, leaving the enrolment without a pin column', async () => {
    const dataSource = await open(path.join(dir, 'revert.sqlite'));
    expect(await tables(dataSource)).toEqual(expect.arrayContaining(['projects', 'cohort_project_assignments']));

    // H2 then H1, which is the order the runbook reverts them in: reached by
    // reverting until H1 is gone, so a migration added above them
    // does not silently make this two undos of its own.
    await revertPastH1(dataSource);

    const left = await tables(dataSource);
    for (const gone of [
      'content_blobs',
      'projects',
      'project_versions',
      'project_phases',
      'project_tasks',
      'project_files',
      'cohort_project_assignments',
    ]) {
      expect(left).not.toContain(gone);
    }
    const columns: { name: string }[] = await dataSource.query(`PRAGMA table_info("enrollments")`);
    expect(columns.map((column) => column.name)).not.toContain('projectVersionId');
    // and the enrolment's own guard survived the column being added and dropped,
    // which a table rebuild would have taken with it
    const indexes: { name: string }[] = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'enrollments'`,
    );
    expect(indexes.map((index) => index.name)).toContain('UQ_enrollments_user_project');

    // the rest of the stack unwinds to an empty file, so neither migration left
    // anything behind for the next one to trip over
    const applied = await dataSource.query(`SELECT name FROM learnsdlc_migrations`);
    for (let i = 0; i < applied.length; i++) await dataSource.undoLastMigration();
    expect(await tables(dataSource)).toEqual(['learnsdlc_migrations']);
  });

  it('leaves a term of retained coursework byte-identical', async () => {
    const file = path.join(dir, 'retained.sqlite');
    const before = await open(file);
    // the file as the previous release left it: everything up to H1
    await revertPastH1(before);
    await seedCoursework(before);
    const submissionColumns = await columnsOf(before, 'submissions');
    const retained = await coursework(before, submissionColumns);
    await before.destroy();

    const after = await open(file);
    expect(await coursework(after, submissionColumns)).toEqual(retained);
    expect((await after.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query)).toEqual([]);
    // the new column is there and null; nothing filled it in on the way through
    const [row] = await after.query(`SELECT "projectVersionId" FROM "enrollments"`);
    expect(row.projectVersionId).toBeNull();
  });

  it('refuses a dialect it has no statements for, by name', async () => {
    for (const migration of [
      new H1ProjectModel1789600000000(),
      new H2CohortAssignmentAndEnrolmentPin1789600100000(),
    ]) {
      const runner = { connection: { options: { type: 'mysql' } } } as never;
      await expect(migration.up(runner)).rejects.toThrow(
        new RegExp(`${migration.name} has no statements for "mysql"`),
      );
      await expect(migration.down(runner)).rejects.toThrow(/has no statements for "mysql"/);
    }
  });
});
