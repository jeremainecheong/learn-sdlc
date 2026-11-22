import { MigrationInterface, QueryRunner } from 'typeorm';
import { compareProjectVersions } from '@learnsdlc/shared';
import {
  STORY_MIGRATION_RECEIPT_KEY,
  convertWorkspace,
  type StoryConversionOutcome,
} from './story-records/story-records';

/**
 * S1 — learners' Requirements stories, from markdown to the record. Data only.
 *
 * ## Why
 *
 * TaskTrackr 3.0.0's Requirements phase is a story phase: the room reads and
 * writes `requirements/story.json` and nothing else, and the grader reads the
 * record. A learner who wrote Requirements on 2.x holds the work in
 * `requirements/my-story.md` (and, if they used the 2.x room, a record beside
 * it carrying the room's `renderHash`). The boot re-pin
 * (`seed/story-repin.service.ts`) moves those learners onto 3.0.0 and
 * converts their work as it moves them, which also covers a store this
 * migration never ran on (schema sync, an adopted SQLite file). This converts
 * the learners already on a story version, on a store that runs migrations.
 *
 * ## Whose workspaces
 *
 * Every `phase_states` row of the `requirements` phase with a workspace,
 * converted if and only if the learner's version grades the story record:
 * the pinned version, or, for a null pin, the project's published head (which
 * is what a null pin resolves). This is the same set the boot re-pin converts,
 * so the two never disagree about a learner:
 *
 * - a TaskTrackr learner still pinned to a markdown version is skipped here;
 *   the re-pin converts their workspace in the same transaction that moves
 *   their pin, and never moves one it could not convert;
 * - a learner on any version whose Requirements is a story is converted here,
 *   and the re-pin finds the workspace already converted (`untouched`);
 * - a learner whose version still grades the markdown keeps the file it
 *   grades.
 *
 * Every skip is listed in the receipt with its own sentence: no enrolment, a
 * version that still grades the markdown, a snapshot that cannot be read, or
 * a null pin whose head still grades the markdown (or has none).
 *
 * ## What each outcome writes
 *
 * `convertWorkspace` (`story-records/story-records.ts`) decides, per row, in
 * TypeScript, with the phase's own story id; the statement here only writes.
 * A row is written only when it moved, and its `workspaceUpdatedAt` (the
 * stamp the room's save compares, a varchar on both dialects) is stamped
 * afresh in the same UPDATE, so a tab left open on the old workspace has its
 * next save refused rather than writing markdown over the record. A refused
 * row is left exactly as it was: nothing is dropped in silence.
 *
 * ## The receipt
 *
 * `settings["story-migration.receipt"]` holds `{ at, counts, fallbackStateIds,
 * refused, skipped, editedMarkdown }`: one count per outcome, the rows that
 * fell back to notes, each refusal and skip with its sentence, and how many
 * kept records had markdown edited beside them (kept in their notes). Running
 * the migration again (it is idempotent: a converted workspace has no
 * markdown left and is `untouched`) merges these keys into the receipt that is
 * there, so the sections the boot adds (`drafts`, `repin`) survive and there
 * is still one row.
 *
 * ## Dialects and the release tool
 *
 * The statements are plain text, identical on both dialects but for the
 * placeholders, and the joins cast `enrollments.id` and `projects.id` (uuid on
 * Postgres) to varchar for the reason H9 gives. Only `UPDATE`s and the
 * receipt's one `INSERT` or `UPDATE`: no DDL, so the release tool derives no
 * altered table. This migration writes `phase_states` and `settings`, and
 * its row counts do not move except the one receipt row in `settings`. The
 * boot that follows it re-pins learners and classes
 * (`seed/story-repin.service.ts`), which updates `enrollments`, supersedes
 * and inserts `cohort_project_assignments` rows and inserts `audit_events`
 * rows, so the operator names
 * `phase_states,settings,enrollments,cohort_project_assignments,audit_events`
 * in `--altered-tables`. That boot must run on a single API instance: its
 * check for a Requirements submission in flight is a plain read with no lock.
 */
export class S1StoryRecordsFromMarkdown1790100000000 implements MigrationInterface {
  name = 'S1StoryRecordsFromMarkdown1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const t = dialectOf(queryRunner, this.name);
    const at = (n: number) => (t.postgres ? `$${n}` : '?');
    if (t.postgres) await queryRunner.query(`SET lock_timeout = '3s'`);

    const rows: {
      id: string;
      workspace: string | null;
      workspaceUpdatedAt: string | null;
      projectSlug: string | null;
      projectVersionId: string | null;
    }[] = await queryRunner.query(
      `SELECT CAST(s."id" AS varchar) AS "id", s."workspace" AS "workspace", s."workspaceUpdatedAt" AS "workspaceUpdatedAt", ` +
        `e."projectSlug" AS "projectSlug", e."projectVersionId" AS "projectVersionId" ` +
        `FROM "phase_states" s LEFT JOIN "enrollments" e ON CAST(e."id" AS varchar) = s."enrollmentId" ` +
        `WHERE s."phaseKey" = 'requirements' AND s."workspace" IS NOT NULL ORDER BY s."id"`,
    );

    // What each pinned version's Requirements grades, read out of its snapshot.
    const pinned = new Map<string, Requirements>();
    for (const id of new Set(rows.map((r) => r.projectVersionId).filter((id): id is string => !!id))) {
      const found: { compiled: string | null }[] = await queryRunner.query(
        `SELECT v."compiled" AS "compiled" FROM "project_versions" v WHERE CAST(v."id" AS varchar) = ${at(1)}`,
        [id],
      );
      pinned.set(id, requirementsOf(found[0]?.compiled ?? null));
    }
    // A null pin resolves the project's published head, so that is what it grades.
    const heads = new Map<string, Requirements | null>();
    for (const slug of new Set(rows.filter((r) => r.projectSlug !== null && !r.projectVersionId).map((r) => r.projectSlug as string))) {
      const published: { version: string; compiled: string | null }[] = await queryRunner.query(
        `SELECT v."version" AS "version", v."compiled" AS "compiled" FROM "project_versions" v ` +
          `JOIN "projects" p ON CAST(p."id" AS varchar) = v."projectId" ` +
          `WHERE p."slug" = ${at(1)} AND v."status" = 'published'`,
        [slug],
      );
      const head = [...published].sort((a, b) => compareProjectVersions(b.version, a.version))[0];
      heads.set(slug, head ? requirementsOf(head.compiled) : null);
    }

    const counts: Record<StoryConversionOutcome | 'skipped', number> = {
      'kept-record': 0,
      'parsed-markdown': 0,
      'empty-template': 0,
      fallback: 0,
      untouched: 0,
      refused: 0,
      skipped: 0,
    };
    const fallbackStateIds: string[] = [];
    const refused: { stateId: string; reason: string }[] = [];
    const skipped: { stateId: string; reason: string }[] = [];
    let editedMarkdown = 0;

    for (const row of rows) {
      const graded = gradedBy(row, pinned, heads);
      if (graded.skip !== null) {
        counts.skipped += 1;
        skipped.push({ stateId: row.id, reason: graded.skip });
        continue;
      }
      let workspace: unknown;
      try {
        workspace = JSON.parse(row.workspace as string);
      } catch {
        workspace = null;
      }
      if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
        counts.refused += 1;
        refused.push({ stateId: row.id, reason: 'the workspace is not a JSON object, so it was not changed' });
        continue;
      }
      const out = convertWorkspace(workspace as Record<string, string>, { storyId: graded.storyId });
      counts[out.outcome] += 1;
      if (out.editedMarkdown) editedMarkdown += 1;
      if (out.outcome === 'fallback') fallbackStateIds.push(row.id);
      if (out.outcome === 'refused') refused.push({ stateId: row.id, reason: out.reason as string });
      if (out.outcome === 'untouched' || out.outcome === 'refused') continue;
      await queryRunner.query(
        `UPDATE "phase_states" SET "workspace" = ${at(1)}, "workspaceUpdatedAt" = ${at(2)}, "updatedAt" = CURRENT_TIMESTAMP ` +
          `WHERE CAST("id" AS varchar) = ${at(3)}`,
        [JSON.stringify(out.workspace), freshStamp(row.workspaceUpdatedAt), row.id],
      );
    }

    // Merged into whatever receipt is there, so a manual re-run rewrites its
    // own counts and keeps the sections the boot added (`drafts`, `repin`).
    const migration = { at: new Date().toISOString(), counts, fallbackStateIds, refused, skipped, editedMarkdown };
    const held: { value: string }[] = await queryRunner.query(`SELECT "value" AS "value" FROM "settings" WHERE "key" = ${at(1)}`, [
      STORY_MIGRATION_RECEIPT_KEY,
    ]);
    if (held.length) {
      await queryRunner.query(`UPDATE "settings" SET "value" = ${at(1)} WHERE "key" = ${at(2)}`, [
        JSON.stringify({ ...parsedObject(held[0].value), ...migration }),
        STORY_MIGRATION_RECEIPT_KEY,
      ]);
    } else {
      await queryRunner.query(`INSERT INTO "settings" ("key", "value") VALUES (${at(1)}, ${at(2)})`, [
        STORY_MIGRATION_RECEIPT_KEY,
        JSON.stringify(migration),
      ]);
    }

    // One line per outcome, through the connection's own logger: `db:migrate`
    // prints exactly one line (`cli/migrate.ts`), so nothing here writes to the
    // console. The boot says the same counts once, from the receipt
    // (`DraftConversionService`).
    for (const line of receiptLines(migration)) queryRunner.connection.logger.log('info', line, queryRunner);
  }

  /**
   * **A documented no-op.** The markdown a converted workspace held is gone by
   * design (a fallback's text is in the record's `notes`), and an API from
   * before this migration reads a 3.0.0 learner's record as a record: there is
   * nothing a `down()` could restore that is not already readable. The
   * receipt stays as the record of what `up()` did.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    dialectOf(queryRunner, this.name);
  }
}

// Module-private on purpose: TypeORM loads a migration directory by taking
// every exported value as a migration class (H9 carries its own copy too).


/** The receipt as log lines: one per outcome count, then the edited-markdown count. */
function receiptLines(receipt: { counts: Record<string, number>; editedMarkdown: number }): string[] {
  const lines = Object.entries(receipt.counts).map(([outcome, count]) => `S1 requirements workspaces ${outcome}: ${count}`);
  lines.push(`S1 kept records whose markdown was edited after the 2.x room rendered it: ${receipt.editedMarkdown}`);
  return lines;
}

/** What a version's Requirements grades, read out of its stored snapshot text; `unreadable` when there is none to read. */
type Requirements = { kind: string | undefined; storyId?: string } | 'unreadable';

function requirementsOf(compiled: string | null): Requirements {
  if (!compiled) return 'unreadable';
  try {
    const snapshot = JSON.parse(compiled) as {
      content?: { phases?: { key?: string; checks?: { kind?: string; learnerStory?: { id?: unknown } } }[] };
    };
    const checks = snapshot.content?.phases?.find((phase) => phase.key === 'requirements')?.checks;
    const storyId = typeof checks?.learnerStory?.id === 'string' ? checks.learnerStory.id : undefined;
    return { kind: checks?.kind, storyId };
  } catch {
    return 'unreadable';
  }
}

/**
 * Whether this row's learner is graded on the story record, and the phase's
 * story id when they are; otherwise the sentence the receipt lists the skip
 * under. The same rule the boot re-pin converts by: the learner's version is
 * the pin, or, for a null pin, the project's published head.
 */
function gradedBy(
  row: { projectSlug: string | null; projectVersionId: string | null },
  pinned: Map<string, Requirements>,
  heads: Map<string, Requirements | null>,
): { skip: null; storyId?: string } | { skip: string } {
  if (row.projectSlug === null) return { skip: 'the phase state has no enrolment' };
  if (row.projectVersionId) {
    const version = pinned.get(row.projectVersionId) ?? 'unreadable';
    if (version === 'unreadable') return { skip: "the learner's version has no compiled snapshot that can be read" };
    if (version.kind === 'story') return { skip: null, storyId: version.storyId };
    if (version.kind === 'markdown') return { skip: "the learner's version still grades the markdown story" };
    return { skip: "the learner's version does not grade a story in Requirements" };
  }
  const head = heads.get(row.projectSlug) ?? null;
  if (head === null) return { skip: "the learner follows the project's published head, and it has none" };
  if (head === 'unreadable') return { skip: "the learner follows the project's published head, whose compiled snapshot cannot be read" };
  if (head.kind === 'story') return { skip: null, storyId: head.storyId };
  if (head.kind === 'markdown') return { skip: "the learner follows the project's published head, which still grades the markdown story" };
  return { skip: "the learner follows the project's published head, which does not grade a story in Requirements" };
}

/**
 * A new `workspaceUpdatedAt`, later than the one the row held: the room's save
 * compares the stamp a tab quotes with the row's, so a tab still open on the
 * old workspace is refused rather than saving markdown over the record.
 */
function freshStamp(previous: string | null): string {
  return new Date(Math.max(Date.now(), (Date.parse(previous ?? '') || 0) + 1)).toISOString();
}

/** A stored receipt as an object, or an empty one when it is not readable as one. */
function parsedObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface Dialect {
  postgres: boolean;
}

/** Which of the two supported dialects this is, refusing a third by name. */
function dialectOf(queryRunner: QueryRunner, migration: string): Dialect {
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
  return { postgres };
}
