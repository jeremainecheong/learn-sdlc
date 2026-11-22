import { randomUUID } from 'crypto';
import { readdirSync } from 'fs';
import * as path from 'path';
import { DataSource, DataSourceOptions, QueryRunner } from 'typeorm';

/**
 * The migration fixture for H5 (`submissions.resetEpoch`) and H9 (the legacy
 * null-pin backfill), proved on a database built the way a deployed host's
 * history runs:
 *
 * 1. the 27 base migrations;
 * 2. legacy enrolments in the shape before H2 (no pin), one of them a
 *    completed project, with their phase states and submissions;
 * 3. H1–H4;
 * 4. the rows the boot import writes for TaskTrackr 2.0.1, plus a teacher's
 *    project, a class assignment, pinned enrolments and task rows;
 * 5. H5 + H9, in the one transaction they run in on deploy.
 *
 * Every helper takes the dialect from the connection and speaks both. Nothing
 * here opens a connection of its own or names a server: the specs do that and
 * refuse any target but the isolated one.
 *
 * It lives under `test/`, not `src/`, so the production build never compiles
 * it (`tsconfig.build.json` builds `src` only; specs are excluded there).
 */

/** The app's own name for the ledger (`database.module.ts`). */
export const MIGRATIONS_TABLE = 'learnsdlc_migrations';

/** Stamps that cut the history where the host's history was cut. */
export const H1_STAMP = '1789600000000';
export const H5_STAMP = '1789800000000';

/** The three values an operator confirms before H5 + H9 run. */
export const OPERATOR_VALUES = {
  expectedTableCount: 32,
  alteredTables: 'enrollments,submissions',
  override: '--i-have-read-the-migrations',
} as const;

export const TASKTRACKR = 'tasktrackr';
export const TEACHER_SLUG = 'library-desk';

/**
 * The tree's migrations directory. In the tree it is `src/migrations`; a
 * staging run names it. H5 and H9 themselves are passed as
 * classes, never read from here, so the tree's copies cannot be counted twice.
 */
export const treeMigrationsDir = (): string =>
  process.env.LSDLC_TREE_MIGRATIONS ?? path.join(__dirname, '..', 'src', 'migrations');

/** Tree migration files whose stamp is strictly below `before`, oldest first. */
export const migrationFilesBefore = (before: string): string[] =>
  readdirSync(treeMigrationsDir())
    .filter((name) => /^[0-9]{13}-.+\.(ts|js)$/.test(name) && !name.endsWith('.d.ts'))
    .filter((name) => name.slice(0, 13) < before)
    .sort()
    .map((name) => path.join(treeMigrationsDir(), name));

type Queryable = Pick<QueryRunner, 'query' | 'connection'>;

const isPostgres = (q: Queryable): boolean => q.connection.options.type === 'postgres';

/** `INSERT` with the dialect's placeholders; sqlite binds booleans as 1/0. */
export async function insertRow(q: Queryable, table: string, row: Record<string, unknown>): Promise<void> {
  const pg = isPostgres(q);
  const keys = Object.keys(row);
  const values = keys.map((key) => {
    const value = row[key];
    return !pg && typeof value === 'boolean' ? (value ? 1 : 0) : value;
  });
  const marks = keys.map((_, index) => (pg ? `$${index + 1}` : '?')).join(', ');
  await q.query(
    `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(', ')}) VALUES (${marks})`,
    values,
  );
}

/** Every base table in the connection's own schema, sorted. */
export async function tableNames(q: Queryable): Promise<string[]> {
  const rows: { name: string }[] = isPostgres(q)
    ? await q.query(
        `SELECT table_name AS name FROM information_schema.tables ` +
          `WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
      )
    : await q.query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
      );
  return rows.map((row) => row.name).sort();
}

/** One line per column: name, type, nullability, default. */
export async function columnSignature(q: Queryable, table: string): Promise<string[]> {
  if (isPostgres(q)) {
    const rows: Record<string, string | null>[] = await q.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns ` +
        `WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    );
    return rows.map((r) => `${r.column_name}|${r.data_type}|${r.is_nullable}|${r.column_default ?? ''}`);
  }
  const rows: { name: string; type: string; notnull: number; dflt_value: string | null }[] =
    await q.query(`PRAGMA table_info("${table}")`);
  // sqlite reports a declared type in the case it chooses; the comparison is of meaning.
  return rows.map((r) => `${r.name}|${r.type.toLowerCase()}|${r.notnull ? 'NO' : 'YES'}|${r.dflt_value ?? ''}`);
}

/** Index name → its stored definition, for one table. */
export async function indexDefinitions(q: Queryable, table: string): Promise<Record<string, string>> {
  const rows: { name: string; def: string | null }[] = isPostgres(q)
    ? await q.query(
        `SELECT indexname AS name, indexdef AS def FROM pg_indexes ` +
          `WHERE schemaname = current_schema() AND tablename = $1`,
        [table],
      )
    : await q.query(`SELECT name, sql AS def FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`, [
        table,
      ]);
  return Object.fromEntries(rows.map((row) => [row.name, row.def ?? '(implicit)']));
}

/** Every row of a table, in a stable order, as plain JSON-able values. */
export async function tableRows(q: Queryable, table: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = await q.query(`SELECT * FROM "${table}" ORDER BY 1`);
  return JSON.parse(JSON.stringify(rows));
}

export interface DatabaseSnapshot {
  tables: string[];
  columns: Record<string, string[]>;
  indexes: Record<string, Record<string, string>>;
  rows: Record<string, Record<string, unknown>[]>;
  counts: Record<string, number>;
}

/** Schema, indexes and every row of every table: what "nothing else moved" is checked against. */
export async function snapshot(q: Queryable): Promise<DatabaseSnapshot> {
  const tables = await tableNames(q);
  const out: DatabaseSnapshot = { tables, columns: {}, indexes: {}, rows: {}, counts: {} };
  for (const table of tables) {
    out.columns[table] = await columnSignature(q, table);
    out.indexes[table] = await indexDefinitions(q, table);
    out.rows[table] = await tableRows(q, table);
    out.counts[table] = out.rows[table].length;
  }
  return out;
}

/**
 * Tables a schema migration after H5 and H9 touches, set aside by name in the
 * proofs' schema-builder parity: the entity set is the current one, so the
 * builder wants those later columns on a file migrated only to H5 or H9. The
 * migration stamped `1793430000000` adds one nullable text column to each of
 * `agent_turns` (`errorDetail`) and `agent_proposals` (`summary`); no
 * migration up to H9 names either table.
 */
export const LATER_SCHEMA_TABLES: readonly string[] = ['agent_turns', 'agent_proposals'];
/**
 * The pending schema-builder queries of this era: every query that names a
 * later migration's table left out, the bare name (sqlite rebuilds a table as
 * `temporary_<table>` and names its indexes `IDX_<table>_...`).
 */
export const pendingOfThisEra = (queries: string[]): string[] =>
  queries.filter((query) => !LATER_SCHEMA_TABLES.some((table) => query.includes(table)));

/** Tables whose column list differs between two snapshots. */
export const schemaChangedTables = (a: DatabaseSnapshot, b: DatabaseSnapshot): string[] =>
  a.tables.filter((table) => JSON.stringify(a.columns[table]) !== JSON.stringify(b.columns[table]));

/**
 * Tables whose rows differ, ignoring columns present on one side only (a new
 * nullable column is a schema change, reported by `schemaChangedTables`).
 */
export const dataChangedTables = (a: DatabaseSnapshot, b: DatabaseSnapshot): string[] =>
  a.tables.filter((table) => {
    const left = a.rows[table] ?? [];
    const right = b.rows[table] ?? [];
    if (left.length !== right.length) return true;
    return left.some((row, i) => {
      const other = right[i];
      const keys = Object.keys(row).filter((key) => key in other);
      return keys.some((key) => JSON.stringify(row[key]) !== JSON.stringify(other[key]));
    });
  });

export interface LegacyIds {
  instructor: string;
  cohort: string;
  completed: { user: string; enrollment: string };
  midway: { user: string; enrollment: string; inFlightSubmission: string };
  fresh: { user: string; enrollment: string };
}

const user = (email: string, role = 'LEARNER', cohort = 'default') => ({
  id: randomUUID(),
  email,
  passwordHash: 'fixture-not-a-hash',
  displayName: email.split('@')[0],
  role,
  cohort,
});

/**
 * Step 2: the shape before H2, on the 27 base migrations. No `projectVersionId`
 * column exists yet, so these enrolments are exactly the rows H2 leaves null.
 * One is a completed project.
 */
export async function seedLegacy(q: Queryable): Promise<LegacyIds> {
  const instructor = user('teacher@fixture.test', 'INSTRUCTOR');
  const completed = user('completed@fixture.test');
  const midway = user('midway@fixture.test', 'LEARNER', 'fixture-class');
  const fresh = user('fresh@fixture.test');
  for (const row of [instructor, completed, midway, fresh]) await insertRow(q, 'users', row);

  const cohort = randomUUID();
  await insertRow(q, 'cohorts', { id: cohort, name: 'Fixture class', joinCode: 'FIXTURE1', ownerUserId: instructor.id });

  const phases = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
  const enrol = async (userId: string, order: number, done: boolean): Promise<string> => {
    const id = randomUUID();
    await insertRow(q, 'enrollments', {
      id,
      userId,
      projectSlug: TASKTRACKR,
      currentPhaseOrder: order,
      completed: done,
      completedAt: done ? '2026-09-16T08:18:00.000Z' : null,
      packVersion: '2.0.1',
    });
    return id;
  };
  const phaseState = async (enrollmentId: string, userId: string, index: number, status: string) => {
    const id = randomUUID();
    await insertRow(q, 'phase_states', {
      id,
      enrollmentId,
      userId,
      phaseKey: phases[index],
      phaseOrder: index + 1,
      status,
      attempts: status === 'passed' ? 1 : 0,
      bestScore: status === 'passed' ? 92 : null,
      passedAt: status === 'passed' ? `2026-09-16T0${index + 1}:00:00.000Z` : null,
    });
    return id;
  };
  const submit = async (phaseStateId: string, userId: string, status: string, passed: boolean | null) => {
    const id = randomUUID();
    await insertRow(q, 'submissions', {
      id,
      phaseStateId,
      userId,
      status,
      score: passed === null ? null : passed ? 92 : 40,
      passed,
      packVersion: '2.0.1',
    });
    return id;
  };

  const completedEnrollment = await enrol(completed.id, 6, true);
  for (let i = 0; i < 6; i += 1) {
    const ps = await phaseState(completedEnrollment, completed.id, i, 'passed');
    await submit(ps, completed.id, 'done', false);
    await submit(ps, completed.id, 'done', true);
  }

  const midwayEnrollment = await enrol(midway.id, 3, false);
  let inFlightSubmission = '';
  for (let i = 0; i < 3; i += 1) {
    const ps = await phaseState(midwayEnrollment, midway.id, i, i < 2 ? 'passed' : 'unlocked');
    if (i < 2) await submit(ps, midway.id, 'done', true);
    else inFlightSubmission = await submit(ps, midway.id, 'queued', null);
  }

  const freshEnrollment = await enrol(fresh.id, 1, false);
  await phaseState(freshEnrollment, fresh.id, 0, 'unlocked');

  return {
    instructor: instructor.id,
    cohort,
    completed: { user: completed.id, enrollment: completedEnrollment },
    midway: { user: midway.id, enrollment: midwayEnrollment, inFlightSubmission },
    fresh: { user: fresh.id, enrollment: freshEnrollment },
  };
}

export interface PinnedProjectIds {
  tasktrackrProject: string;
  tasktrackr201: string;
  teacherProject: string;
  teacher100: string;
  teacherDraft: string;
  pinnedTasktrackr: string;
  pinnedTeacher: string;
  nullTeacher: string;
}

/**
 * Step 4: what the boot import writes for TaskTrackr 2.0.1, and the rows H1–H4
 * let a teacher create: an owned project with a published 1.0.0 and a draft,
 * a class assignment, enrolments pinned at creation (every creator pins),
 * task rows, and one null-pin enrolment on the teacher's slug (a rollback
 * window's row, the case H9 must leave alone).
 */
export async function seedPinnedProjects(q: Queryable, legacy: LegacyIds): Promise<PinnedProjectIds> {
  const tasktrackrProject = randomUUID();
  const teacherProject = randomUUID();
  await insertRow(q, 'projects', {
    id: tasktrackrProject,
    slug: TASKTRACKR,
    title: 'TaskTrackr',
    platformOwned: true,
    isDefault: true,
    origin: 'directory',
  });
  await insertRow(q, 'projects', {
    id: teacherProject,
    slug: TEACHER_SLUG,
    title: 'Library desk',
    platformOwned: false,
    ownerUserId: legacy.instructor,
    origin: 'authored',
  });
  const version = async (projectId: string, semver: string, status: string): Promise<string> => {
    const id = randomUUID();
    await insertRow(q, 'project_versions', {
      id,
      projectId,
      version: semver,
      status,
      manifest: JSON.stringify({ version: semver }),
      publishedAt: status === 'published' ? '2026-09-28T10:00:00.000Z' : null,
    });
    return id;
  };
  const tasktrackr201 = await version(tasktrackrProject, '2.0.1', 'published');
  const teacher100 = await version(teacherProject, '1.0.0', 'published');
  const teacherDraft = await version(teacherProject, '1.1.0', 'draft');

  await insertRow(q, 'cohort_project_assignments', {
    id: randomUUID(),
    cohortId: legacy.cohort,
    projectVersionId: teacher100,
    assignedByUserId: legacy.instructor,
    reason: 'Fixture: the class works the library desk.',
  });

  const learner = async (email: string) => {
    const row = user(email);
    await insertRow(q, 'users', row);
    return row.id;
  };
  const enrol = async (userId: string, slug: string, pin: string | null): Promise<string> => {
    const id = randomUUID();
    await insertRow(q, 'enrollments', { id, userId, projectSlug: slug, projectVersionId: pin, packVersion: null });
    return id;
  };
  const pinnedTasktrackr = await enrol(await learner('pinned-default@fixture.test'), TASKTRACKR, tasktrackr201);
  const pinnedTeacher = await enrol(legacy.midway.user, TEACHER_SLUG, teacher100);
  const nullTeacher = await enrol(await learner('rollback-window@fixture.test'), TEACHER_SLUG, null);

  const ps = randomUUID();
  await insertRow(q, 'phase_states', {
    id: ps,
    enrollmentId: pinnedTeacher,
    userId: legacy.midway.user,
    phaseKey: 'requirements',
    phaseOrder: 1,
    status: 'unlocked',
  });
  await insertRow(q, 'task_states', {
    id: randomUUID(),
    phaseStateId: ps,
    userId: legacy.midway.user,
    taskKey: 'write-the-story',
    status: 'in_progress',
    attempts: 1,
    resetCount: 1,
    resetAt: '2026-09-28T11:00:00.000Z',
  });
  await insertRow(q, 'submissions', {
    id: randomUUID(),
    phaseStateId: ps,
    userId: legacy.midway.user,
    status: 'done',
    passed: false,
    score: 40,
    taskKey: 'write-the-story',
  });

  return { tasktrackrProject, tasktrackr201, teacherProject, teacher100, teacherDraft, pinnedTasktrackr, pinnedTeacher, nullTeacher };
}

/** Options for a sqlite file holding the given migrations; no entities unless asked. */
export const sqliteOptions = (file: string, migrations: (string | Function)[], entities: Function[] = []): DataSourceOptions =>
  ({
    type: 'better-sqlite3',
    database: file,
    entities,
    synchronize: false,
    migrations,
    migrationsTableName: MIGRATIONS_TABLE,
  }) as DataSourceOptions;

/** A schema name this fixture generated, and the only kind it will drop. */
export const scratchSchema = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '')}`;

export const postgresOptions = (
  url: string,
  schema: string,
  migrations: (string | Function)[],
  entities: Function[] = [],
): DataSourceOptions =>
  ({
    type: 'postgres',
    url,
    schema,
    extra: { options: `-c search_path=${schema},public`, statement_timeout: 30000 },
    entities,
    synchronize: false,
    migrations,
    migrationsTableName: MIGRATIONS_TABLE,
  }) as DataSourceOptions;

/** Create the scratch schema; refuses to create an extension (uuid-ossp must already be there). */
export async function openScratchSchema(admin: DataSource, schema: string): Promise<void> {
  const extension = await admin.query(`SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp'`);
  if (extension.length !== 1) throw new Error('uuid-ossp is not installed; this fixture will not install it');
  await admin.query(`CREATE SCHEMA "${schema}"`);
}

/** Drop a schema only if its name is one `scratchSchema(prefix)` could have made. */
export async function dropScratchSchema(admin: DataSource, schema: string, prefix: string): Promise<void> {
  if (!new RegExp(`^${prefix}_[0-9a-f]{32}$`).test(schema)) throw new Error('migration cleanup namespace refused');
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  const left = await admin.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schema]);
  if (left.length !== 0) throw new Error('scratch schema survived its drop');
}
