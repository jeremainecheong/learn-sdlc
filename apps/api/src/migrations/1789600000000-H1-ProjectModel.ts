import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * H1 — a project stops being a directory.
 *
 * Six tables: the bytes once, keyed by their sha256, and the metadata that says
 * what each byte *is to the version that holds it*. `project_versions.compiled`
 * is the `ProjectContent` the runtime reads, so a phase load becomes one JSON
 * column instead of a disk walk, and `project_files.role` is the column every
 * seal will rest on — set at insert, never updated.
 *
 * **Purely additive.** Six new tables and eleven new indexes; nothing is
 * dropped, renamed or retyped and no existing row is rewritten, so it applies
 * to a populated database while the previous release is still answering
 * requests, and the previous release keeps working against it. There is no
 * `blob_roles` table, because one sha is reached by
 * many rows under many roles — five shas in the imported default project are
 * simultaneously a locked `workspace` row and a sealed `solution` file — so a
 * sha-keyed role table would have had to pick one of two true answers.
 *
 * Both dialects are real (sqlite is the supported local-first store), and `up()` refuses a third by
 * name rather than silently doing nothing, which is the rule the D6 migration's
 * own header set. Nothing here touches an existing table, so the raw-`ALTER TABLE`
 * rule that header also carries — never `queryRunner.addColumn` on sqlite,
 * because the driver implements it as a table rebuild and the rebuild loses a
 * partial index's `WHERE` — belongs to H2 rather than to this file.
 *
 * `"order"` is quoted in every statement: it is a reserved word in both
 * dialects. `uuid_generate_v4()` is the default every id in this schema already
 * uses and `InitialSchema` creates the extension, so nothing new is needed here.
 */
export class H1ProjectModel1789600000000 implements MigrationInterface {
  name = 'H1ProjectModel1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const t = typesFor(queryRunner, this.name);

    await queryRunner.query(
      `CREATE TABLE "content_blobs" ("sha" ${t.str64} ${t.pk}, "bytes" text NOT NULL, ` +
        `"size" integer NOT NULL, "createdAt" ${t.created})`,
    );

    await queryRunner.query(
      `CREATE TABLE "projects" ("id" ${t.id}, "slug" ${t.str} NOT NULL, "title" ${t.str} NOT NULL, ` +
        `"platformOwned" ${t.bool(false)}, "ownerUserId" ${t.str}, "isDefault" ${t.bool(false)}, ` +
        `"origin" ${t.str} NOT NULL, "createdAt" ${t.created})`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_projects_owner" ON "projects" ("ownerUserId") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_projects_slug" ON "projects" ("slug") `);

    await queryRunner.query(
      `CREATE TABLE "project_versions" ("id" ${t.id}, "projectId" ${t.str} NOT NULL, ` +
        `"version" ${t.str} NOT NULL, "status" ${t.str} NOT NULL DEFAULT ${t.lit('draft')}, ` +
        `"manifest" text NOT NULL, "compiled" text, "validation" text, "contentDigest" ${t.str64}, ` +
        `"sandboxBudget" integer, "forkedFromVersionId" ${t.str}, "publishedAt" ${t.str}, ` +
        `"publishedByUserId" ${t.str}, "notes" text, "createdAt" ${t.created})`,
    );
    // One draft at a time per project, settled in the database. A status
    // comparison is the shape Postgres normalises to and still compares equal,
    // which is what the codebase's own parity note vouches for; published and
    // archived versions fall outside the index, so a project keeps every
    // version it ever shipped.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_project_versions_draft" ON "project_versions" ("projectId") WHERE status = 'draft'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_project_versions_status" ON "project_versions" ("projectId", "status") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_project_versions_version" ON "project_versions" ("projectId", "version") `,
    );

    await queryRunner.query(
      `CREATE TABLE "project_phases" ("id" ${t.id}, "projectVersionId" ${t.str} NOT NULL, ` +
        `"key" ${t.str} NOT NULL, "order" integer NOT NULL, "title" text NOT NULL, ` +
        `"intro" text NOT NULL, "artifactKind" ${t.str} NOT NULL, "canRun" ${t.bool(false)}, ` +
        `"canPreview" ${t.bool(false)}, "runLabel" ${t.str} NOT NULL DEFAULT ${t.lit('')}, ` +
        `"assistant" text NOT NULL, "interview" text)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_project_phases_order" ON "project_phases" ("projectVersionId", "order") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_project_phases_key" ON "project_phases" ("projectVersionId", "key") `,
    );

    await queryRunner.query(
      `CREATE TABLE "project_tasks" ("id" ${t.id}, "projectPhaseId" ${t.str} NOT NULL, ` +
        `"taskKey" ${t.str} NOT NULL, "order" integer NOT NULL, "required" ${t.bool(true)}, ` +
        `"signOff" ${t.bool(false)}, "artefactType" ${t.str} NOT NULL, "artefactPath" ${t.str}, ` +
        `"title" ${t.str} NOT NULL, "brief" text NOT NULL, "objectives" text NOT NULL, ` +
        `"primaryPath" ${t.str}, "anchor" text, "rubric" text NOT NULL, "checks" text NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_project_tasks_order" ON "project_tasks" ("projectPhaseId", "order") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_project_tasks_key" ON "project_tasks" ("projectPhaseId", "taskKey") `,
    );

    await queryRunner.query(
      `CREATE TABLE "project_files" ("id" ${t.id}, "projectVersionId" ${t.str} NOT NULL, ` +
        `"ownerKind" ${t.str} NOT NULL, "ownerId" ${t.str} NOT NULL, "path" ${t.str} NOT NULL, ` +
        `"role" ${t.str} NOT NULL, "editable" ${t.bool(false)}, "language" ${t.str}, ` +
        `"blobSha" ${t.str64} NOT NULL)`,
    );
    // Scoped to the version on purpose: the two byte rules ask whether
    // *this version* holds these bytes under a sealed role, not whether the
    // platform's blob store does, where the answer is routinely yes.
    await queryRunner.query(
      `CREATE INDEX "IDX_project_files_blob" ON "project_files" ("projectVersionId", "blobSha") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_project_files_role" ON "project_files" ("projectVersionId", "role") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_project_files_path" ON "project_files" ("projectVersionId", "ownerId", "path") `,
    );
  }

  /**
   * Drops in reverse dependency order, each table's indexes before the table,
   * so the database `up()` started from is the one `down()` ends with. Nothing
   * outside these six tables is touched, which is what makes the revert a
   * complete one — `IDX_submissions_phase_state_created` and
   * `UQ_submissions_in_flight` are not named here because `up()` never named
   * them either.
   *
   * Reverting loses every imported project, so revert only a deploy whose
   * content has not been authored against.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    typesFor(queryRunner, this.name);
    for (const name of [
      'UQ_project_files_path',
      'IDX_project_files_role',
      'IDX_project_files_blob',
    ]) {
      await queryRunner.query(`DROP INDEX "${name}"`);
    }
    await queryRunner.query(`DROP TABLE "project_files"`);
    for (const name of ['UQ_project_tasks_key', 'UQ_project_tasks_order']) {
      await queryRunner.query(`DROP INDEX "${name}"`);
    }
    await queryRunner.query(`DROP TABLE "project_tasks"`);
    for (const name of ['UQ_project_phases_key', 'UQ_project_phases_order']) {
      await queryRunner.query(`DROP INDEX "${name}"`);
    }
    await queryRunner.query(`DROP TABLE "project_phases"`);
    for (const name of [
      'UQ_project_versions_version',
      'IDX_project_versions_status',
      'UQ_project_versions_draft',
    ]) {
      await queryRunner.query(`DROP INDEX "${name}"`);
    }
    await queryRunner.query(`DROP TABLE "project_versions"`);
    for (const name of ['UQ_projects_slug', 'IDX_projects_owner']) {
      await queryRunner.query(`DROP INDEX "${name}"`);
    }
    await queryRunner.query(`DROP TABLE "projects"`);
    await queryRunner.query(`DROP TABLE "content_blobs"`);
  }
}

// Module-private on purpose: TypeORM loads a migration directory by taking
// every exported value as a migration class. D6 duplicates its own
// `isPostgres` / `isSqlite` for the same reason.

/**
 * The dialect's own spelling of each type this migration writes, resolved once
 * so that both branches are one statement rather than two copies that drift —
 * and refusing a third dialect by name, which is the first of the two rules the
 * D6 header set.
 *
 * Index names are unqualified in `down()`: Postgres resolves them through
 * `search_path`, which is what lets the reversal be proved inside an isolated
 * schema rather than only against `public`.
 */
interface DialectTypes {
  postgres: boolean;
  /** A generated uuid primary key, as every other table in this schema declares it. */
  id: string;
  /** A primary key on a column the caller supplies, e.g. a blob's sha. */
  pk: string;
  str: string;
  str64: string;
  created: string;
  bool(value: boolean): string;
  lit(value: string): string;
}

function typesFor(queryRunner: QueryRunner, migration: string): DialectTypes {
  const type = queryRunner.connection.options.type;
  const postgres = type === 'postgres';
  const sqlite = type === 'better-sqlite3' || type === 'sqlite';
  if (!postgres && !sqlite) {
    throw new Error(
      `${migration} has no statements for "${type}". ` +
        'This deployment supports postgres (docker-compose.yml) and better-sqlite3 ' +
        '(the local-first path, docs/production-runbook.md §3a).',
    );
  }
  return {
    postgres,
    id: postgres
      ? 'uuid NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY'
      : 'varchar PRIMARY KEY NOT NULL',
    pk: postgres ? 'NOT NULL PRIMARY KEY' : 'PRIMARY KEY NOT NULL',
    str: postgres ? 'character varying' : 'varchar',
    str64: postgres ? 'character varying(64)' : 'varchar(64)',
    created: postgres
      ? 'TIMESTAMP NOT NULL DEFAULT now()'
      : "datetime NOT NULL DEFAULT (datetime('now'))",
    bool: (value: boolean) =>
      postgres
        ? `boolean NOT NULL DEFAULT ${value ? 'true' : 'false'}`
        : `boolean NOT NULL DEFAULT (${value ? 1 : 0})`,
    lit: (value: string) => (postgres ? `'${value}'` : `('${value}')`),
  };
}
