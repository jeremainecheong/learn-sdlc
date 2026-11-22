import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The first schema. Postgres and sqlite are both first-class here: a class
 * hosted on one laptop runs the sqlite branch (docs/production-runbook.md §3a),
 * a hosted deployment runs the Postgres one, and `RUN_MIGRATIONS=true` has to
 * bring a fresh file to the same shape on either. The sqlite statements are the
 * ones TypeORM's schema builder emits for these entities, so a migrated file and
 * a synchronised one are the same schema (asserted by db/database.module.spec.ts).
 *
 * Type mapping, for anyone editing this pair: uuid → `varchar PRIMARY KEY NOT
 * NULL` with the id generated in JS, `character varying` → `varchar`, `double
 * precision` → `float`, `TIMESTAMP … DEFAULT now()` → `datetime … DEFAULT
 * (datetime('now'))`, `DEFAULT false` → `DEFAULT (0)`, and no extensions.
 */
export class InitialSchema1787500326487 implements MigrationInterface {
    name = 'InitialSchema1787500326487'

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.upPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.upSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (isPostgres(queryRunner)) return this.downPostgres(queryRunner);
        if (isSqlite(queryRunner)) return this.downSqlite(queryRunner);
        throw new Error(unsupported(queryRunner, this.name));
    }

    private async upPostgres(queryRunner: QueryRunner): Promise<void> {
        // Every table's id default is uuid_generate_v4(), which lives in uuid-ossp.
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "passwordHash" character varying NOT NULL, "displayName" character varying NOT NULL, "role" character varying NOT NULL DEFAULT 'LEARNER', "cohort" character varying NOT NULL DEFAULT 'default', "dailyTokenBudget" integer, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users" ("email") `);
        await queryRunner.query(`CREATE TABLE "enrollments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" character varying NOT NULL, "projectSlug" character varying NOT NULL, "currentPhaseOrder" integer NOT NULL DEFAULT '1', "completed" boolean NOT NULL DEFAULT false, "startedAt" TIMESTAMP NOT NULL DEFAULT now(), "completedAt" character varying, CONSTRAINT "PK_7c0f752f9fb68bf6ed7367ab00f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_de33d443c8ae36800c37c58c92" ON "enrollments" ("userId") `);
        await queryRunner.query(`CREATE TABLE "phase_states" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "enrollmentId" character varying NOT NULL, "userId" character varying NOT NULL, "phaseKey" character varying NOT NULL, "phaseOrder" integer NOT NULL, "status" character varying NOT NULL DEFAULT 'locked', "bestScore" double precision, "attempts" integer NOT NULL DEFAULT '0', "reflection" text, "workspace" text, "ranBeforeSubmit" boolean NOT NULL DEFAULT false, "unlockedAt" character varying, "passedAt" character varying, CONSTRAINT "PK_5847b4edd03e1286806f841376b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_80f6433d6c1edf9361b3397dfd" ON "phase_states" ("enrollmentId") `);
        await queryRunner.query(`CREATE INDEX "IDX_0c86177ec06b28e42efd19ebf5" ON "phase_states" ("userId") `);
        await queryRunner.query(`CREATE TABLE "submissions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "phaseStateId" character varying NOT NULL, "userId" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'queued', "score" double precision, "passed" boolean, "report" text, "error" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_10b3be95b8b2fb1e482e07d706b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_0ebc5f9037adef802fe1453e7e" ON "submissions" ("phaseStateId") `);
        await queryRunner.query(`CREATE INDEX "IDX_eae888413ab8fc63cc48759d46" ON "submissions" ("userId") `);
        await queryRunner.query(`CREATE TABLE "execution_runs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "phaseStateId" character varying NOT NULL, "userId" character varying NOT NULL, "kind" character varying NOT NULL DEFAULT 'run', "status" character varying NOT NULL DEFAULT 'queued', "result" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7a2c43d68b87a384457fe4d0a62" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_75015fc7e682577f305f4477ac" ON "execution_runs" ("phaseStateId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e3b9992c813373c9264fe63bf4" ON "execution_runs" ("userId") `);
        await queryRunner.query(`CREATE TABLE "assistant_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" character varying NOT NULL, "enrollmentId" character varying NOT NULL, "phaseStateId" character varying NOT NULL, "phaseKey" character varying NOT NULL, "role" character varying NOT NULL, "content" text NOT NULL, "provider" character varying NOT NULL DEFAULT '', "cached" boolean NOT NULL DEFAULT false, "redacted" boolean NOT NULL DEFAULT false, "scopeRedirected" boolean NOT NULL DEFAULT false, "tokensIn" integer NOT NULL DEFAULT '0', "tokensOut" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2e3cd3325f853089044baca6b77" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_67fe0c1a32333707d64ee55398" ON "assistant_messages" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ba27dde6d5d69f85046b1f4840" ON "assistant_messages" ("phaseStateId") `);
        await queryRunner.query(`CREATE TABLE "ai_cache" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "cacheKey" character varying NOT NULL, "content" text NOT NULL, "provider" character varying NOT NULL DEFAULT '', "redacted" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_30b792e08262273016a05f34517" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f99d450a6e9b01da9dc791508b" ON "ai_cache" ("cacheKey") `);
        await queryRunner.query(`CREATE TABLE "settings" ("key" character varying NOT NULL, "value" text NOT NULL, CONSTRAINT "PK_c8639b7626fa94ba8265628f214" PRIMARY KEY ("key"))`);
    }

    private async downPostgres(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "settings"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f99d450a6e9b01da9dc791508b"`);
        await queryRunner.query(`DROP TABLE "ai_cache"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ba27dde6d5d69f85046b1f4840"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_67fe0c1a32333707d64ee55398"`);
        await queryRunner.query(`DROP TABLE "assistant_messages"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e3b9992c813373c9264fe63bf4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_75015fc7e682577f305f4477ac"`);
        await queryRunner.query(`DROP TABLE "execution_runs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_eae888413ab8fc63cc48759d46"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0ebc5f9037adef802fe1453e7e"`);
        await queryRunner.query(`DROP TABLE "submissions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0c86177ec06b28e42efd19ebf5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_80f6433d6c1edf9361b3397dfd"`);
        await queryRunner.query(`DROP TABLE "phase_states"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_de33d443c8ae36800c37c58c92"`);
        await queryRunner.query(`DROP TABLE "enrollments"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_97672ac88f789774dd47f7c8be"`);
        await queryRunner.query(`DROP TABLE "users"`);
    }

    private async upSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "passwordHash" varchar NOT NULL, "displayName" varchar NOT NULL, "role" varchar NOT NULL DEFAULT ('LEARNER'), "cohort" varchar NOT NULL DEFAULT ('default'), "dailyTokenBudget" integer, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users" ("email") `);
        await queryRunner.query(`CREATE TABLE "enrollments" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "projectSlug" varchar NOT NULL, "currentPhaseOrder" integer NOT NULL DEFAULT (1), "completed" boolean NOT NULL DEFAULT (0), "startedAt" datetime NOT NULL DEFAULT (datetime('now')), "completedAt" varchar)`);
        await queryRunner.query(`CREATE INDEX "IDX_de33d443c8ae36800c37c58c92" ON "enrollments" ("userId") `);
        await queryRunner.query(`CREATE TABLE "phase_states" ("id" varchar PRIMARY KEY NOT NULL, "enrollmentId" varchar NOT NULL, "userId" varchar NOT NULL, "phaseKey" varchar NOT NULL, "phaseOrder" integer NOT NULL, "status" varchar NOT NULL DEFAULT ('locked'), "bestScore" float, "attempts" integer NOT NULL DEFAULT (0), "reflection" text, "workspace" text, "ranBeforeSubmit" boolean NOT NULL DEFAULT (0), "unlockedAt" varchar, "passedAt" varchar)`);
        await queryRunner.query(`CREATE INDEX "IDX_80f6433d6c1edf9361b3397dfd" ON "phase_states" ("enrollmentId") `);
        await queryRunner.query(`CREATE INDEX "IDX_0c86177ec06b28e42efd19ebf5" ON "phase_states" ("userId") `);
        await queryRunner.query(`CREATE TABLE "submissions" ("id" varchar PRIMARY KEY NOT NULL, "phaseStateId" varchar NOT NULL, "userId" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('queued'), "score" float, "passed" boolean, "report" text, "error" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_0ebc5f9037adef802fe1453e7e" ON "submissions" ("phaseStateId") `);
        await queryRunner.query(`CREATE INDEX "IDX_eae888413ab8fc63cc48759d46" ON "submissions" ("userId") `);
        await queryRunner.query(`CREATE TABLE "execution_runs" ("id" varchar PRIMARY KEY NOT NULL, "phaseStateId" varchar NOT NULL, "userId" varchar NOT NULL, "kind" varchar NOT NULL DEFAULT ('run'), "status" varchar NOT NULL DEFAULT ('queued'), "result" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_75015fc7e682577f305f4477ac" ON "execution_runs" ("phaseStateId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e3b9992c813373c9264fe63bf4" ON "execution_runs" ("userId") `);
        await queryRunner.query(`CREATE TABLE "assistant_messages" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "enrollmentId" varchar NOT NULL, "phaseStateId" varchar NOT NULL, "phaseKey" varchar NOT NULL, "role" varchar NOT NULL, "content" text NOT NULL, "provider" varchar NOT NULL DEFAULT (''), "cached" boolean NOT NULL DEFAULT (0), "redacted" boolean NOT NULL DEFAULT (0), "scopeRedirected" boolean NOT NULL DEFAULT (0), "tokensIn" integer NOT NULL DEFAULT (0), "tokensOut" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_67fe0c1a32333707d64ee55398" ON "assistant_messages" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ba27dde6d5d69f85046b1f4840" ON "assistant_messages" ("phaseStateId") `);
        await queryRunner.query(`CREATE TABLE "ai_cache" ("id" varchar PRIMARY KEY NOT NULL, "cacheKey" varchar NOT NULL, "content" text NOT NULL, "provider" varchar NOT NULL DEFAULT (''), "redacted" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f99d450a6e9b01da9dc791508b" ON "ai_cache" ("cacheKey") `);
        await queryRunner.query(`CREATE TABLE "settings" ("key" varchar PRIMARY KEY NOT NULL, "value" text NOT NULL)`);
    }

    private async downSqlite(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "settings"`);
        await queryRunner.query(`DROP INDEX "IDX_f99d450a6e9b01da9dc791508b"`);
        await queryRunner.query(`DROP TABLE "ai_cache"`);
        await queryRunner.query(`DROP INDEX "IDX_ba27dde6d5d69f85046b1f4840"`);
        await queryRunner.query(`DROP INDEX "IDX_67fe0c1a32333707d64ee55398"`);
        await queryRunner.query(`DROP TABLE "assistant_messages"`);
        await queryRunner.query(`DROP INDEX "IDX_e3b9992c813373c9264fe63bf4"`);
        await queryRunner.query(`DROP INDEX "IDX_75015fc7e682577f305f4477ac"`);
        await queryRunner.query(`DROP TABLE "execution_runs"`);
        await queryRunner.query(`DROP INDEX "IDX_eae888413ab8fc63cc48759d46"`);
        await queryRunner.query(`DROP INDEX "IDX_0ebc5f9037adef802fe1453e7e"`);
        await queryRunner.query(`DROP TABLE "submissions"`);
        await queryRunner.query(`DROP INDEX "IDX_0c86177ec06b28e42efd19ebf5"`);
        await queryRunner.query(`DROP INDEX "IDX_80f6433d6c1edf9361b3397dfd"`);
        await queryRunner.query(`DROP TABLE "phase_states"`);
        await queryRunner.query(`DROP INDEX "IDX_de33d443c8ae36800c37c58c92"`);
        await queryRunner.query(`DROP TABLE "enrollments"`);
        await queryRunner.query(`DROP INDEX "IDX_97672ac88f789774dd47f7c8be"`);
        await queryRunner.query(`DROP TABLE "users"`);
    }

}

// Module-private on purpose: TypeORM loads a migration directory by taking
// every exported value as a migration class, so an exported helper here would
// be read as a migration with an unparseable timestamp.

/** The two dialects this deployment supports. Anything else stops the boot. */
function isPostgres(queryRunner: QueryRunner): boolean {
    return queryRunner.connection.options.type === 'postgres';
}

function isSqlite(queryRunner: QueryRunner): boolean {
    const type = queryRunner.connection.options.type;
    return type === 'better-sqlite3' || type === 'sqlite';
}

function unsupported(queryRunner: QueryRunner, migration: string): string {
    return (
        `${migration} has no statements for "${queryRunner.connection.options.type}". ` +
        'This deployment supports postgres (docker-compose.yml) and better-sqlite3 ' +
        '(the local-first path, docs/production-runbook.md §3a).'
    );
}
