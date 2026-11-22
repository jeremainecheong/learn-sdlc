import { MigrationInterface, QueryRunner } from 'typeorm';
import { compareProjectVersions } from '@learnsdlc/shared';
import {
  DESIGN_MIGRATION_RECEIPT_KEY,
  LEGACY_DESIGN_FILES,
  convertDesignWorkspace,
  legacyDesignSourcesOf,
  type DesignConversionOutcome,
  type LegacyDesignSources,
  type DesignMigrationReceipt,
} from './design-records/design-records';

/**
 * S2 — learners' Design workspaces, from the design page and the board's
 * older record to the design record. Data only.
 *
 * ## Why
 *
 * TaskTrackr 4.0.0's Design phase is a design phase: the room reads and
 * writes `design/design.json` (and the contracts beside it) and nothing else,
 * and the floor grades the record. A learner who wrote Design on 3.x holds the
 * work in `design/my-design.md`, whose board region the 3.x room rendered from
 * a record in the board's older shape (`fields`, `endpoints`, an operation's
 * text inputs and its ordering, boundary and example). The boot re-pin
 * (`seed/story-repin.service.ts`: every phase the pin grades as markdown and
 * the head grades structured is converted in one savepoint)
 * moves those learners onto 4.0.0 and converts their work as it moves them,
 * which also covers a store this migration never ran on (schema sync, an
 * adopted SQLite file). This converts the learners already on a version that
 * grades the design kind, on a store that runs migrations.
 *
 * ## Whose workspaces
 *
 * Every `phase_states` row of the `design` phase with a workspace, converted
 * if and only if the learner's version grades the design kind: the pinned
 * version, or, for a null pin, the project's published head (which is what a
 * null pin resolves). This is the same set the boot re-pin converts, so the
 * two never disagree about a learner:
 *
 * - a TaskTrackr learner still pinned to a markdown version is skipped here;
 *   the re-pin converts their workspace in the same transaction that moves
 *   their pin, and never moves one it could not convert;
 * - a learner on any version whose Design is the design kind is converted
 *   here, and the re-pin finds the workspace already converted (`untouched`);
 * - a learner whose version still grades the markdown design keeps the file
 *   it grades.
 *
 * Every skip is listed in the receipt with its own sentence: no enrolment, a
 * version that still grades the markdown design, a snapshot that cannot be
 * read, or a null pin whose head still grades the markdown design (or has none).
 *
 * ## What each outcome writes
 *
 * `convertDesignWorkspace` (`design-records/design-records.ts`) decides, per
 * row, in TypeScript; the statement here only writes. The record is validated
 * first and folded (`foldLegacyDesign`, the shared fold) only when it is
 * invalid or carries the board's older keys; the design page's words outside
 * the board's region, comments stripped, are kept in the record's `notes`
 * unless they are the version's template (with no record beside it, the
 * board's region is the board's only copy, so its text is kept too); any other learner-written markdown
 * the graded version names (a design-kind version mounts none, so the paths a
 * written task mints) is kept in `notes` under a header naming its file; the
 * learner-written files, `design/architecture.md` and
 * `requirements/provided-stories.md` are removed.
 * A row is written only when it moved, and its `workspaceUpdatedAt` (the
 * stamp the room's save compares, a varchar on both dialects) is stamped
 * afresh in the same UPDATE, so a tab left open on the old workspace has its
 * next save refused rather than writing the design page over the record. A
 * refused row is left exactly as it was and listed for a conversion by hand:
 * a record that cannot be read, a fold that would cut anything (a line at the
 * notes cap or an item past a board limit), a fold or notes the record's
 * validator refuses, a learner-written file that is not text, or words that
 * would not fit in `notes`. A learner's own prose is never trimmed here.
 * Submissions keep their snapshots.
 *
 * ## The receipt
 *
 * `settings["design-migration.receipt"]` holds `{ at, counts, folded, refused,
 * skipped, notesKept, runs }`: one count per outcome, each folded state with
 * what moved, each refusal and skip with its sentence, how many design pages
 * had words kept in notes, and every run's time and counts. Running the
 * migration again (it is idempotent: a converted workspace has no design page
 * left and is `untouched`) adds the run to `runs`, merges its refusals into
 * the list (a refused state fixed by hand since leaves it) and writes its
 * skips, and leaves the rest as the last run that converted something wrote
 * it, merging lists across those
 * runs by state id; the sections the boot adds (`drafts`, `repin`) survive
 * and there is still one row.
 *
 * ## Dialects and the release tool
 *
 * The statements are plain text, identical on both dialects but for the
 * placeholders, and the joins cast `enrollments.id` and `projects.id` (uuid on
 * Postgres) to varchar for the reason H9 gives. Only `UPDATE`s and the
 * receipt's one `INSERT` or `UPDATE`: no DDL, so the release tool derives no
 * altered table. This migration writes `phase_states` and `settings`, as S1
 * does, and the boot that follows it re-pins learners and classes as S1's
 * does (`enrollments`, `cohort_project_assignments`, `audit_events`), so the
 * operator's `--altered-tables` is unchanged:
 * `phase_states,settings,enrollments,cohort_project_assignments,audit_events`.
 * That boot must run on a single API instance: its check for a submission in
 * flight is a plain read with no lock.
 */
export class S2DesignRecordsFromMarkdown1790200000000 implements MigrationInterface {
  name = 'S2DesignRecordsFromMarkdown1790200000000';

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
        `WHERE s."phaseKey" = 'design' AND s."workspace" IS NOT NULL ORDER BY s."id"`,
    );

    // What each pinned version's Design grades, read out of its snapshot.
    const pinned = new Map<string, DesignGrading>();
    for (const id of new Set(rows.map((r) => r.projectVersionId).filter((id): id is string => !!id))) {
      const found: { compiled: string | null }[] = await queryRunner.query(
        `SELECT v."compiled" AS "compiled" FROM "project_versions" v WHERE CAST(v."id" AS varchar) = ${at(1)}`,
        [id],
      );
      pinned.set(id, designOf(found[0]?.compiled ?? null));
    }
    // A null pin resolves the project's published head, so that is what it grades.
    const heads = new Map<string, DesignGrading | null>();
    for (const slug of new Set(rows.filter((r) => r.projectSlug !== null && !r.projectVersionId).map((r) => r.projectSlug as string))) {
      const published: { version: string; compiled: string | null }[] = await queryRunner.query(
        `SELECT v."version" AS "version", v."compiled" AS "compiled" FROM "project_versions" v ` +
          `JOIN "projects" p ON CAST(p."id" AS varchar) = v."projectId" ` +
          `WHERE p."slug" = ${at(1)} AND v."status" = 'published'`,
        [slug],
      );
      const head = [...published].sort((a, b) => compareProjectVersions(b.version, a.version))[0];
      heads.set(slug, head ? designOf(head.compiled) : null);
    }

    const counts: Record<DesignConversionOutcome | 'skipped', number> = {
      'kept-record': 0,
      folded: 0,
      seeded: 0,
      untouched: 0,
      refused: 0,
      skipped: 0,
    };
    const folded: { stateId: string; reason: string }[] = [];
    const refused: { stateId: string; reason: string }[] = [];
    const skipped: { stateId: string; reason: string }[] = [];
    let notesKept = 0;
    const converted = new Set<string>();
    // the states this run found needing nothing (converted now, or already in the schema): a refusal listed for one is over
    const settled = new Set<string>();

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
      const out = convertDesignWorkspace(workspace as Record<string, string>, { ...graded.sources, templateMarkdown: graded.template });
      counts[out.outcome] += 1;
      if (out.notesKept) notesKept += 1;
      if (out.outcome === 'folded') folded.push({ stateId: row.id, reason: out.reason as string });
      if (out.outcome === 'refused') refused.push({ stateId: row.id, reason: out.reason as string });
      if (out.outcome === 'untouched') settled.add(row.id);
      if (out.outcome === 'untouched' || out.outcome === 'refused') continue;
      converted.add(row.id);
      settled.add(row.id);
      await queryRunner.query(
        `UPDATE "phase_states" SET "workspace" = ${at(1)}, "workspaceUpdatedAt" = ${at(2)}, "updatedAt" = CURRENT_TIMESTAMP ` +
          `WHERE CAST("id" AS varchar) = ${at(3)}`,
        [JSON.stringify(out.workspace), freshStamp(row.workspaceUpdatedAt), row.id],
      );
    }

    // Merged into whatever receipt is there, keeping the sections the boot
    // added (`drafts`, `repin`). Every run adds itself to `runs`. A run that
    // converts something writes its own counts and skips, merges its folded
    // and refused states into the lists already there (one entry per state,
    // a refusal dropped once its state converts) and adds its kept notes; a
    // run that converts nothing leaves the converting run's sections as they
    // were, so a manual re-run never erases what the first run did.
    const run = { at: new Date().toISOString(), counts };
    const held: { value: string }[] = await queryRunner.query(`SELECT "value" AS "value" FROM "settings" WHERE "key" = ${at(1)}`, [
      DESIGN_MIGRATION_RECEIPT_KEY,
    ]);
    const previous = held.length ? parsedObject(held[0].value) : {};
    const runs = [...(Array.isArray(previous.runs) ? previous.runs : []), run];
    const convertedNow = counts['kept-record'] + counts.folded + counts.seeded > 0;
    const firstRun = !previous.counts || typeof previous.counts !== 'object';
    // every run merges its refusals (a state refused for the first time is listed, one fixed by hand since
    // and now settled leaves the list) and writes its skips; only a converting run writes its counts and folds
    const standing = byState(previous.refused, refused).filter((one) => !settled.has(one.stateId));
    const receipt: Partial<DesignMigrationReceipt> =
      convertedNow || firstRun
        ? {
            ...run,
            folded: byState(previous.folded, folded),
            refused: standing,
            skipped,
            notesKept: (typeof previous.notesKept === 'number' ? previous.notesKept : 0) + notesKept,
            runs,
          }
        : { refused: standing, skipped, runs };
    if (held.length) {
      await queryRunner.query(`UPDATE "settings" SET "value" = ${at(1)} WHERE "key" = ${at(2)}`, [
        JSON.stringify({ ...previous, ...receipt }),
        DESIGN_MIGRATION_RECEIPT_KEY,
      ]);
    } else {
      await queryRunner.query(`INSERT INTO "settings" ("key", "value") VALUES (${at(1)}, ${at(2)})`, [
        DESIGN_MIGRATION_RECEIPT_KEY,
        JSON.stringify(receipt),
      ]);
    }

    // One line per outcome, through the connection's own logger: `db:migrate`
    // prints exactly one line (`cli/migrate.ts`), so nothing here writes to the
    // console; the receipt holds every count and list.
    for (const line of receiptLines({ counts, notesKept })) queryRunner.connection.logger.log('info', line, queryRunner);
  }

  /**
   * **A documented no-op.** The design page a converted workspace held is
   * gone by design: its board region was drawn from the record, and its own
   * words are in the record's `notes`, so there is nothing a `down()` could
   * restore that the record does not already hold. The receipt stays as the
   * record of what `up()` did.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    dialectOf(queryRunner, this.name);
  }
}

// Module-private on purpose: TypeORM loads a migration directory by taking
// every exported value as a migration class (H9 and S1 carry their own copies too).

/** The receipt as log lines: one per outcome count, then the design pages whose words were kept. */
function receiptLines(receipt: { counts: Record<string, number>; notesKept: number }): string[] {
  const lines = Object.entries(receipt.counts).map(([outcome, count]) => `S2 design workspaces ${outcome}: ${count}`);
  lines.push(`S2 design pages whose words were kept in notes: ${receipt.notesKept}`);
  return lines;
}

/** The design page the older Design mounted, the one whose words a learner's are compared with. */
const DESIGN_PAGE = LEGACY_DESIGN_FILES[0];

/**
 * What a version's Design grades, read out of its stored snapshot text, and
 * its design page's template when the snapshot carries one; `unreadable` when
 * there is none to read.
 */
type DesignGrading = { kind: string | undefined; template?: string; sources?: LegacyDesignSources } | 'unreadable';

function designOf(compiled: string | null): DesignGrading {
  if (!compiled) return 'unreadable';
  try {
    const snapshot = JSON.parse(compiled) as {
      content?: { phases?: { key?: string; checks?: { kind?: string }; files?: { path?: unknown; content?: unknown }[] }[] };
    };
    const phase = snapshot.content?.phases?.find((one) => one.key === 'design');
    const page = (Array.isArray(phase?.files) ? phase.files : []).find((file) => file?.path === DESIGN_PAGE);
    const sources = legacyDesignSourcesOf(snapshot);
    return { kind: phase?.checks?.kind, ...(typeof page?.content === 'string' ? { template: page.content } : {}), ...(sources ? { sources } : {}) };
  } catch {
    return 'unreadable';
  }
}

/**
 * Whether this row's learner is graded on the design record, and the
 * version's design page template when it has one; otherwise the sentence the
 * receipt lists the skip under. The same rule the boot re-pin converts by:
 * the learner's version is the pin, or, for a null pin, the project's
 * published head.
 */
function gradedBy(
  row: { projectSlug: string | null; projectVersionId: string | null },
  pinned: Map<string, DesignGrading>,
  heads: Map<string, DesignGrading | null>,
): { skip: null; template?: string; sources?: LegacyDesignSources } | { skip: string } {
  if (row.projectSlug === null) return { skip: 'the phase state has no enrolment' };
  if (row.projectVersionId) {
    const version = pinned.get(row.projectVersionId) ?? 'unreadable';
    if (version === 'unreadable') return { skip: "the learner's version has no compiled snapshot that can be read" };
    if (version.kind === 'design') return { skip: null, template: version.template, sources: version.sources };
    if (version.kind === 'markdown') return { skip: "the learner's version still grades the markdown design" };
    return { skip: "the learner's version does not grade a design record in Design" };
  }
  const head = heads.get(row.projectSlug) ?? null;
  if (head === null) return { skip: "the learner follows the project's published head, and it has none" };
  if (head === 'unreadable') return { skip: "the learner follows the project's published head, whose compiled snapshot cannot be read" };
  if (head.kind === 'design') return { skip: null, template: head.template, sources: head.sources };
  if (head.kind === 'markdown') return { skip: "the learner follows the project's published head, which still grades the markdown design" };
  return { skip: "the learner follows the project's published head, which does not grade a design record in Design" };
}

/** Two receipts' lists of states as one, one entry per state id, the later run's entry winning. */
function byState(earlier: unknown, later: { stateId: string; reason: string }[]): { stateId: string; reason: string }[] {
  const merged = new Map<string, { stateId: string; reason: string }>();
  for (const one of Array.isArray(earlier) ? earlier : []) {
    if (one && typeof one.stateId === 'string' && typeof one.reason === 'string') merged.set(one.stateId, { stateId: one.stateId, reason: one.reason });
  }
  for (const one of later) merged.set(one.stateId, one);
  return [...merged.values()];
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
