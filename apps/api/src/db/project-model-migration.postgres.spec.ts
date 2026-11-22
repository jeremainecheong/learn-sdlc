import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { readdirSync } from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  CohortProjectAssignmentEntity,
  ContentBlobEntity,
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
import { H3TaskStates1789600200000 } from '../migrations/1789600200000-H3-TaskStates';
import { describePostgres, postgresTarget } from '../../test/support/postgres';

/**
 * The project model migrations against a real PostgreSQL server, in a schema of
 * their own.
 *
 * The sqlite spec beside this file is the one that always runs; this is the
 * half that cannot be simulated: the normalised form Postgres stores a partial
 * index predicate in, `uuid` primary keys against `character varying`
 * references, and `boolean DEFAULT false` rather than `(0)`. The database half
 * is `describe.skip` without `POSTGRES_TEST_CONFIG`, exactly as the shared-preview
 * migration spec is; run it with the configuration set.
 *
 * **Its non-database half is not skipped.** If the migrations were named here
 * one at a time, a new one held back by the fixture's filter would never be
 * applied: the seed would then write a `submissions` row through an entity
 * that had gained a column (H3's `taskKey`, say) against a table that had
 * not. On a skipped suite that is invisible for ever. The first
 * `describe` below therefore asks the directory rather than a list: every
 * migration this fixture holds back must be one it applies by hand, and it
 * runs everywhere, so the next migration cannot go missing in silence.
 * The safety rails are asserted there too, for the same reason: they are the
 * only thing standing between this fixture and somebody's shared database.
 *
 * It refuses any target but the configured isolated server, it refuses to
 * create an extension or to touch `public`, and it drops only a schema whose
 * name it generated.
 */

/** Where the migration classes live, read rather than listed. */
const MIGRATIONS = path.join(__dirname, '..', 'migrations');

/**
 * The migrations this fixture holds back from `runMigrations` and applies by
 * hand, because the "before" it seeds is the release an operator upgrades FROM.
 */
const APPLIED_BY_HAND = [
  new H1ProjectModel1789600000000(),
  new H2CohortAssignmentAndEnrolmentPin1789600100000(),
  new H3TaskStates1789600200000(),
];

/**
 * The first stamp this fixture holds back, and its filter: **by stamp, not by
 * prefix.** A prefix such as `1789600*` would let H9 (an UPDATE of
 * `enrollments."projectVersionId"`) run in the first `runMigrations`, before
 * H2 had added the column, and the fixture would fail with `column
 * "projectVersionId" does not exist`, invisibly, because this half skips
 * without `POSTGRES_TEST_CONFIG`. Everything stamped at or after H1 is held
 * back; H1–H3 are applied by hand below, and every later one after them.
 */
const HELD_FROM = 1789600000000;
const stampOf = (file: string): number => Number(file.split('-')[0]);
const heldBack = (file: string): boolean => stampOf(file) >= HELD_FROM;

type Migration = { name: string; up(q: unknown): Promise<void>; down(q: unknown): Promise<void> };

/** A migration file's classes, instantiated. */
const migrationsIn = (file: string): Migration[] =>
  Object.values(require(path.join(MIGRATIONS, file)) as Record<string, unknown>)
    .filter((value): value is new () => Migration => typeof value === 'function')
    .map((ctor) => new ctor());

/**
 * The held-back migrations newer than the three applied by hand (H4, H5, H9 and
 * whatever is added later), in stamp order, read from the directory: they
 * run after H1–H3 inside the case and are undone before them.
 */
const APPLIED_AFTER: Migration[] = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.ts') && heldBack(name) && stampOf(name) > 1789600200000)
  .sort((a, b) => stampOf(a) - stampOf(b))
  .flatMap(migrationsIn);

/** The isolated server this fixture is allowed to talk to, and no other. */
const ISOLATED_TARGET = { hostname: '127.0.0.1', port: '5494' };

function isolatedTarget(databaseUrl: string): URL {
  const url = new URL(databaseUrl);
  if (url.hostname !== ISOLATED_TARGET.hostname || url.port !== ISOLATED_TARGET.port) {
    throw new Error('isolated migration target refused');
  }
  return url;
}

const SCHEMA_NAME = /^project_model_migration_[0-9a-f]{32}$/;

/** A namespace of this fixture's own making, which is the only kind it drops. */
const mintSchemaName = (): string => `project_model_migration_${randomUUID().replace(/-/g, '')}`;

function ownSchema(name: string): string {
  if (!SCHEMA_NAME.test(name)) throw new Error('migration cleanup namespace refused');
  return name;
}

describe('the project model migration fixture', () => {
  it('applies by hand exactly the migrations it holds back from the run', () => {
    const held = readdirSync(MIGRATIONS).filter(
      (name) => name.endsWith('.ts') && heldBack(name),
    );
    expect(held.length).toBeGreaterThan(0);
    // Asked of the modules rather than spelled out, so a migration added to the
    // block is either applied here or names itself in a failure.
    const declared = held.flatMap((file) => migrationsIn(file).map((migration) => migration.name));
    expect(
      [...APPLIED_BY_HAND, ...APPLIED_AFTER].map((migration) => migration.name).sort(),
    ).toEqual(declared.sort());
  });

  it('holds back by stamp, so a later migration can never run before H1–H3', () => {
    expect(heldBack('1789600000000-H1-ProjectModel.ts')).toBe(true);
    expect(heldBack('1789800100000-H9-PinLegacyEnrolments.ts')).toBe(true);
    expect(heldBack('1789510000000-SharedPreviewSessions.ts')).toBe(false);
    // Stamp order, H4 before H5 before H9.
    const names = APPLIED_AFTER.map((migration) => migration.name);
    expect(names.slice(0, 3)).toEqual([
      'H4QuizAttempts1789700000000',
      'H5SubmissionResetEpoch1789800000000',
      'H9PinLegacyEnrolments1789800100000',
    ]);
  });

  it('refuses any target but the configured isolated server', () => {
    expect(isolatedTarget('postgres://u:p@127.0.0.1:5494/learnsdlc').port).toBe('5494');
    for (const elsewhere of [
      'postgres://u:p@127.0.0.1:5432/learnsdlc',
      'postgres://u:p@db.example.invalid:5494/learnsdlc',
    ]) {
      expect(() => isolatedTarget(elsewhere)).toThrow('isolated migration target refused');
    }
  });

  it('drops only a namespace it generated itself', () => {
    expect(mintSchemaName()).toMatch(SCHEMA_NAME);
    expect(ownSchema(mintSchemaName())).toMatch(SCHEMA_NAME);
    for (const theirs of ['public', 'project_model_migration_', `project_model_migration_${'x'.repeat(32)}`]) {
      expect(() => ownSchema(theirs)).toThrow('migration cleanup namespace refused');
    }
  });
});

describePostgres('the project model migrations on an isolated actual PostgreSQL schema', () => {
  let admin: DataSource;
  let db: DataSource;
  let schema: string;
  let retained: Record<string, unknown[]>;
  let userId: string;
  const [h1, h2, h3] = APPLIED_BY_HAND;

  /**
   * The columns a table held in the release this fixture upgrades from, read off
   * that release's own schema rather than written down here.
   *
   * `enrollments` and `submissions` are snapshotted by name for one reason: a
   * migration that ADDs a column to either (H2's pin, H3's `taskKey`) changes
   * what `SELECT *` returns without touching a byte a learner wrote, and the
   * question this fixture asks is whether the retained bytes moved.
   */
  const before: Record<string, string[]> = {};

  const columnsOf = async (table: string): Promise<string[]> =>
    (
      await db.query(
        `SELECT column_name FROM information_schema.columns ` +
          `WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, table],
      )
    ).map((row: { column_name: string }) => row.column_name);

  /** A learner's term of work, as text, so a comparison is byte-for-byte. */
  const snapshot = async (): Promise<Record<string, unknown[]>> => {
    const out: Record<string, unknown[]> = {};
    for (const table of ['users', 'phase_states']) {
      out[table] = await db.query(
        `SELECT row_to_json(t)::text AS row FROM "${schema}"."${table}" t ORDER BY id`,
      );
    }
    for (const table of ['enrollments', 'submissions']) {
      out[table] = await db.query(
        `SELECT ${before[table].map((name) => `"${name}"`).join(',')} ` +
          `FROM "${schema}"."${table}" ORDER BY id`,
      );
    }
    return out;
  };

  beforeAll(async () => {
    const url = isolatedTarget(postgresTarget()!);
    schema = mintSchemaName();
    admin = await new DataSource({ type: 'postgres', url: url.toString() }).initialize();
    // Historical migrations use the already-installed UUID extension. This
    // fixture refuses to introduce a shared extension or modify public tables.
    expect(await admin.query("SELECT 1 FROM pg_extension WHERE extname='uuid-ossp'")).toHaveLength(1);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = await new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema,
      extra: { options: `-c search_path=${schema},public`, statement_timeout: 15000 },
      entities: ALL_ENTITIES,
      synchronize: false,
      // Everything up to the project model: the three below are applied by hand
      // inside the case, and the list they are held back by is the one the
      // first describe checks against this directory.
      migrations: readdirSync(MIGRATIONS)
        .filter((name) => name.endsWith('.ts') && !heldBack(name))
        .map((name) => path.join(MIGRATIONS, name)),
    }).initialize();
    expect((await db.query('SELECT current_schema() AS name'))[0].name).toBe(schema);
    await db.runMigrations();

    for (const table of ['enrollments', 'submissions']) before[table] = await columnsOf(table);
    expect(before.submissions).not.toContain('taskKey');
    expect(before.enrollments).not.toContain('projectVersionId');

    const user = await db.getRepository(UserEntity).save({
      email: 'migration-owned@example.invalid',
      displayName: 'Owned migration fixture',
      passwordHash: 'unusable',
    });
    userId = user.id;
    // The enrolment as the previous release wrote it: its entity had no pin.
    const [enrollment] = await db.query(
      `INSERT INTO "${schema}"."enrollments" ("userId","projectSlug","currentPhaseOrder","packVersion") ` +
        `VALUES ($1,$2,$3,$4) RETURNING id`,
      [userId, 'tasktrackr', 2, '2.0.1'],
    );
    const phase = await db.getRepository(PhaseStateEntity).save({
      userId,
      enrollmentId: enrollment.id,
      phaseKey: 'requirements',
      phaseOrder: 1,
      status: 'passed',
      bestScore: 90,
      attempts: 2,
      workspace: { 'requirements/story.md': 'Retained actual migration fixture' },
    });
    // The revision as an API from before H1 wrote it, by hand rather than
    // through the repository, for the same reason the enrolment above is raw:
    // `SubmissionEntity` already declares H3's `taskKey`, and naming it is the
    // one thing the pre-H1 table cannot accept. Every other column
    // of this insert is nullable or defaulted.
    await db.query(
      `INSERT INTO "${schema}"."submissions" ("phaseStateId","userId","status","score","passed") ` +
        `VALUES ($1,$2,$3,$4,$5)`,
      [phase.id, userId, 'completed', 90, true],
    );
    retained = await snapshot();
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${ownSchema(schema)}" CASCADE`);
      expect(await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).toEqual([]);
      await admin.destroy();
    }
  });

  it('lands on the entities, keeps retained coursework, and reverses completely', async () => {
    const runner = db.createQueryRunner();
    await runner.connect();
    try {
      await h1.up(runner);
      await h2.up(runner);
      await h3.up(runner);
      // Then H4, H5 and H9 (and any later one), in stamp order. H9 finds a
      // null-pin TaskTrackr enrolment but no published 2.0.1 yet, so it is a
      // no-op here, which the pin assertion below says.
      for (const migration of APPLIED_AFTER) await migration.up(runner);

      // The DDL synchronize would still want to run, and it has to be nothing.
      expect((await db.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query)).toEqual([]);
      expect(await snapshot()).toEqual(retained);
      // The columns the three added are there, at their own defaults, on rows
      // written before they existed.
      expect(await db.query(`SELECT "taskKey" FROM "${schema}"."submissions"`)).toEqual([
        { taskKey: '' },
      ]);
      const [pin] = await db.query(`SELECT "projectVersionId" FROM "${schema}"."enrollments"`);
      expect(pin.projectVersionId).toBeNull();

      const blob = await db.getRepository(ContentBlobEntity).save({
        sha: 'a'.repeat(64),
        bytes: 'print("hello")\n',
        size: 15,
      });
      const project = await db.getRepository(ProjectEntity).save({
        slug: 'tasktrackr',
        title: 'TaskTrackr',
        platformOwned: true,
        ownerUserId: null,
        isDefault: true,
        origin: 'seed',
      });
      const manifest = {
        tagline: 't',
        description: 'd',
        language: 'python',
        languages: ['python'],
      };
      const version = await db.getRepository(ProjectVersionEntity).save({
        projectId: project.id,
        version: '2.0.1',
        status: 'published',
        manifest,
        contentDigest: 'b'.repeat(64),
        sandboxBudget: 20,
        publishedByUserId: userId,
        publishedAt: new Date().toISOString(),
      });
      const phase = await db.getRepository(ProjectPhaseEntity).save({
        projectVersionId: version.id,
        key: 'requirements',
        order: 1,
        title: 'Requirements',
        intro: 'Write the story.',
        artifactKind: 'story',
        assistant: { systemPrompt: 'help', topics: [], progressive: [] },
      });
      await db.getRepository(ProjectTaskEntity).save({
        projectPhaseId: phase.id,
        taskKey: 'story',
        order: 1,
        artefactType: 'user-story',
        artefactPath: 'requirements/draft.md',
        title: 'The story',
        brief: '# brief',
        objectives: ['one'],
        rubric: { passThreshold: 70, criteria: [] },
        checks: { kind: 'story', record: 'requirements/story.json', providedStories: [], learnerStory: { id: 'US-1', hints: {} }, floor: { minCriteria: 2, requiredTags: [], minExclusions: 1, requireSentence: true } },
      });
      await db.getRepository(ProjectFileEntity).save({
        projectVersionId: version.id,
        ownerKind: 'phase',
        ownerId: phase.id,
        path: 'requirements/draft.md',
        role: 'workspace',
        editable: true,
        language: 'markdown',
        blobSha: blob.sha,
      });

      // The two partial unique indexes, which are the half this spec exists for:
      // both predicates are status comparisons, which is the shape Postgres
      // normalises and still compares equal.
      const versions = db.getRepository(ProjectVersionEntity);
      await versions.save(
        versions.create({ projectId: project.id, version: '2.1.0', status: 'draft', manifest }),
      );
      await expect(
        versions.save(
          versions.create({ projectId: project.id, version: '2.2.0', status: 'draft', manifest }),
        ),
      ).rejects.toThrow();

      const assignments = db.getRepository(CohortProjectAssignmentEntity);
      const assignment = {
        cohortId: 'cohort-1',
        projectVersionId: version.id,
        assignedByUserId: userId,
        reason: 'the Tuesday class is doing this one',
      };
      await assignments.save(assignments.create({ ...assignment, state: 'active' }));
      await expect(
        assignments.save(assignments.create({ ...assignment, state: 'active' })),
      ).rejects.toThrow();
      // a withdrawn assignment falls outside the index, so a class keeps its history
      await assignments.save(assignments.create({ ...assignment, state: 'withdrawn' }));
      expect(await assignments.count()).toBe(2);

      // and the pin is a column on a row that already existed
      await db.query(`UPDATE "${schema}"."enrollments" SET "projectVersionId" = $1`, [version.id]);
      const [pinned] = await db.query(`SELECT "projectVersionId" FROM "${schema}"."enrollments"`);
      expect(pinned.projectVersionId).toBe(version.id);

      // Reversal, H3 then H2 then H1, inside this schema rather than against
      // `public`. H3's write-off touches in-flight revisions alone, and the
      // retained one is `completed`, so the snapshot below is the same
      // question it was.
      await db.query(`DELETE FROM "${schema}"."cohort_project_assignments"`);
      for (const migration of [...APPLIED_AFTER].reverse()) await migration.down(runner);
      await h3.down(runner);
      await h2.down(runner);
      await h1.down(runner);
      for (const table of [
        'content_blobs',
        'projects',
        'project_versions',
        'project_phases',
        'project_tasks',
        'project_files',
        'cohort_project_assignments',
        'task_states',
        'task_resets',
        'quiz_attempts',
      ]) {
        expect(await runner.hasTable(table)).toBe(false);
      }
      expect(await columnsOf('enrollments')).toEqual(before.enrollments);
      expect(await columnsOf('submissions')).toEqual(before.submissions);
      expect(await snapshot()).toEqual(retained);
    } finally {
      await runner.release();
    }
  });
});
