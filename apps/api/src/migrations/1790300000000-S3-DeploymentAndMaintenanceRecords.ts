import { MigrationInterface, QueryRunner } from 'typeorm';
import { compareProjectVersions } from '@learnsdlc/shared';
import {
  RUNBOOK_MIGRATION_RECEIPT_KEY,
  convertRunbookWorkspace,
  drillIncidentOf,
  legacyRunbookSourcesOf,
  type RecordConversion,
  type RecordConversionOutcome,
  type RecordMigrationReceipt,
} from './runbook-records/runbook-records';
import { CHANGE_MIGRATION_RECEIPT_KEY, convertChangeWorkspace, legacyChangeSourcesOf } from './change-records/change-records';

/**
 * S3 — learners' Deployment and Maintenance workspaces, from `RUNBOOK.md` to
 * the runbook record and from `CHANGELOG.md` to the change request record.
 * Data only.
 *
 * ## Why
 *
 * TaskTrackr 5.0.0's Deployment is a config phase with a runbook record
 * (`deployment/runbook.json`) and its Maintenance a code phase with a change
 * request record (`maintenance/change-request.json`): the rooms read and
 * write the records and nothing else, and the floors grade them. A learner
 * who worked on 4.0.0 holds the runbook in `RUNBOOK.md` and the release in
 * `CHANGELOG.md`. The boot re-pin (`seed/story-repin.service.ts`, every
 * phase the pin grades in its older form and the head grades structured,
 * converted in one savepoint) moves those learners onto 5.0.0 and converts
 * their work as it moves them, which also covers a store this migration
 * never ran on (schema sync, an adopted SQLite file). This converts the
 * learners already on a version that grades the records, on a store that
 * runs migrations. At migrate time no TaskTrackr version grades a record yet
 * (the boot imports 5.0.0 after the migrations), so every TaskTrackr state is
 * skipped here and the re-pin converts it.
 *
 * ## Whose workspaces
 *
 * Every `phase_states` row of the `deployment` or `maintenance` phase with a
 * workspace, converted if and only if the learner's version grades that
 * phase's structured form (a config Deployment with `runbook`, a code
 * Maintenance with `change`): the pinned version, or, for a null pin, the
 * project's published head (which is what a null pin resolves). This is the
 * set the boot re-pin's in-place pass converts, so the two never disagree
 * about a learner. Every skip is listed in its receipt with its own sentence:
 * no enrolment, a snapshot that cannot be read, a null pin whose head has
 * none, or "this state's version does not grade the runbook document" (or
 * "the change request document").
 *
 * ## What each outcome writes
 *
 * `convertRunbookWorkspace` (`runbook-records/runbook-records.ts`) and
 * `convertChangeWorkspace` (`change-records/change-records.ts`) decide, per
 * row, in TypeScript; the statement here only writes. The learner's file is
 * read with the template's own lines dropped (TaskTrackr 4.0.0's, frozen
 * beside each conversion, when the version names none), every word the
 * learner wrote landing in a list or in the record's `notes`; a drill holding
 * an incident fills the runbook's incident (`seeded` writes the version's
 * starting runbook with it when the learner wrote nothing); a record already
 * in the workspace is kept and the older file's words go to its notes. A
 * converted workspace loses its learner-written markdown files and the
 * read-only markdown mounts its version names, and nothing else. A row is
 * written only when it moved, and its `workspaceUpdatedAt` (the stamp the
 * room's save compares, a varchar on both dialects) is stamped afresh in the
 * same UPDATE, so a tab left open on the old workspace has its next save
 * refused rather than writing the markdown back over the record. The drill
 * column and submissions are never touched. A refused row is left exactly as
 * it was and listed for a conversion by hand: a record that cannot be read, a
 * learner-written file that is not text, words that would not fit in
 * `notes`, or a converted record the validator refuses. A learner's own words
 * are never trimmed here, and nothing is graded.
 *
 * ## The receipts
 *
 * `settings["runbook-migration.receipt"]` and
 * `settings["change-migration.receipt"]` hold `{ at, counts, converted,
 * refused, skipped, notesKept, runs }` (the runbook's adds `incidentsCopied`):
 * one count per outcome, each converted state with what moved, each refusal
 * and skip with its sentence, how many records had words kept in notes, and
 * the latest 50 runs' times and counts. They carry counts and sentences,
 * never a learner's words. Running the migration again (it is idempotent: a
 * converted workspace has no older file left and is `untouched`) adds the run
 * to `runs`, merges its refusals into the list (a refused state fixed by hand
 * since leaves it) and writes its skips, and leaves the rest as the last run
 * that converted something wrote it, merging lists across those runs by state
 * id; the sections the boot adds (`drafts`, `repin`) survive and there is
 * still one row per receipt.
 *
 * ## Dialects and the release tool
 *
 * The statements are plain text, identical on both dialects but for the
 * placeholders, and the joins cast `enrollments.id` and `projects.id` (uuid on
 * Postgres) to varchar for the reason H9 gives. Only `UPDATE`s and each
 * receipt's one `INSERT` or `UPDATE`: no DDL, so the release tool derives no
 * altered table. This migration writes `phase_states` and `settings`, as S1
 * and S2 do, and the boot that follows it re-pins learners and classes as
 * theirs does (`enrollments`, `cohort_project_assignments`, `audit_events`),
 * so the operator's `--altered-tables` is unchanged:
 * `phase_states,settings,enrollments,cohort_project_assignments,audit_events`.
 * That boot must run on a single API instance: its check for a submission in
 * flight is a plain read with no lock.
 */
export class S3DeploymentAndMaintenanceRecords1790300000000 implements MigrationInterface {
  name = 'S3DeploymentAndMaintenanceRecords1790300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const t = dialectOf(queryRunner, this.name);
    const at = (n: number) => (t.postgres ? `$${n}` : '?');
    if (t.postgres) await queryRunner.query(`SET lock_timeout = '3s'`);

    const rows: {
      id: string;
      phaseKey: string;
      workspace: string | null;
      workspaceUpdatedAt: string | null;
      drill: string | null;
      projectSlug: string | null;
      projectVersionId: string | null;
    }[] = await queryRunner.query(
      `SELECT CAST(s."id" AS varchar) AS "id", s."phaseKey" AS "phaseKey", s."workspace" AS "workspace", ` +
        `s."workspaceUpdatedAt" AS "workspaceUpdatedAt", s."drill" AS "drill", ` +
        `e."projectSlug" AS "projectSlug", e."projectVersionId" AS "projectVersionId" ` +
        `FROM "phase_states" s LEFT JOIN "enrollments" e ON CAST(e."id" AS varchar) = s."enrollmentId" ` +
        `WHERE s."phaseKey" IN ('deployment', 'maintenance') AND s."workspace" IS NOT NULL ORDER BY s."id"`,
    );

    // Each pinned version's snapshot, read once.
    const pinned = new Map<string, Snapshot>();
    for (const id of new Set(rows.map((r) => r.projectVersionId).filter((id): id is string => !!id))) {
      const found: { compiled: string | null }[] = await queryRunner.query(
        `SELECT v."compiled" AS "compiled" FROM "project_versions" v WHERE CAST(v."id" AS varchar) = ${at(1)}`,
        [id],
      );
      pinned.set(id, snapshotOf(found[0]?.compiled ?? null));
    }
    // A null pin resolves the project's published head, so that is what it grades.
    const heads = new Map<string, Snapshot | null>();
    for (const slug of new Set(rows.filter((r) => r.projectSlug !== null && !r.projectVersionId).map((r) => r.projectSlug as string))) {
      const published: { version: string; compiled: string | null }[] = await queryRunner.query(
        `SELECT v."version" AS "version", v."compiled" AS "compiled" FROM "project_versions" v ` +
          `JOIN "projects" p ON CAST(p."id" AS varchar) = v."projectId" ` +
          `WHERE p."slug" = ${at(1)} AND v."status" = 'published'`,
        [slug],
      );
      const head = [...published].sort((a, b) => compareProjectVersions(b.version, a.version))[0];
      heads.set(slug, head ? snapshotOf(head.compiled) : null);
    }

    const tallies: Record<RecordPhase, Tally> = { deployment: newTally(), maintenance: newTally() };
    for (const row of rows) {
      const phase = row.phaseKey as RecordPhase;
      const tally = tallies[phase];
      const graded = gradedBy(row, phase, pinned, heads);
      if (graded.skip !== null) {
        tally.counts.skipped += 1;
        tally.skipped.push({ stateId: row.id, reason: graded.skip });
        continue;
      }
      let workspace: unknown;
      try {
        workspace = JSON.parse(row.workspace as string);
      } catch {
        workspace = null;
      }
      if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
        tally.counts.refused += 1;
        tally.refused.push({ stateId: row.id, reason: 'the workspace is not a JSON object, so it was not changed' });
        continue;
      }
      const out: RecordConversion =
        phase === 'deployment'
          ? (() => {
              const sources = legacyRunbookSourcesOf(graded.snapshot);
              return convertRunbookWorkspace(workspace as Record<string, string>, {
                ...(sources ?? {}),
                drillIncident: drillIncidentOf(row.drill),
                ...(sources?.starting !== undefined ? { headStarting: sources.starting } : {}),
              });
            })()
          : convertChangeWorkspace(workspace as Record<string, string>, { ...(legacyChangeSourcesOf(graded.snapshot) ?? {}) });
      tally.counts[out.outcome] += 1;
      if (out.notesKept) tally.notesKept += 1;
      if (out.incidentCopied) tally.incidentsCopied += 1;
      if ((out.outcome === 'converted' || out.outcome === 'kept-record') && out.reason) tally.converted.push({ stateId: row.id, reason: out.reason });
      if (out.outcome === 'refused') tally.refused.push({ stateId: row.id, reason: out.reason as string });
      if (out.outcome === 'untouched') tally.settled.add(row.id);
      if (out.outcome === 'untouched' || out.outcome === 'refused') continue;
      tally.settled.add(row.id);
      await queryRunner.query(
        `UPDATE "phase_states" SET "workspace" = ${at(1)}, "workspaceUpdatedAt" = ${at(2)}, "updatedAt" = CURRENT_TIMESTAMP ` +
          `WHERE CAST("id" AS varchar) = ${at(3)}`,
        [JSON.stringify(out.workspace), freshStamp(row.workspaceUpdatedAt), row.id],
      );
    }

    const now = new Date().toISOString();
    await writeReceipt(queryRunner, at, RUNBOOK_MIGRATION_RECEIPT_KEY, now, tallies.deployment, true);
    await writeReceipt(queryRunner, at, CHANGE_MIGRATION_RECEIPT_KEY, now, tallies.maintenance, false);

    // One line per outcome, through the connection's own logger: `db:migrate`
    // prints exactly one line (`cli/migrate.ts`), so nothing here writes to the
    // console; the receipts hold every count and list.
    for (const line of [...receiptLines('runbook', tallies.deployment, true), ...receiptLines('change request', tallies.maintenance, false)]) {
      queryRunner.connection.logger.log('info', line, queryRunner);
    }
  }

  /**
   * **A documented no-op.** The `RUNBOOK.md` and `CHANGELOG.md` a converted
   * workspace held are gone by design: their words are in the record's lists,
   * release and `notes`, so there is nothing a `down()` could restore that the
   * record does not already hold. The receipts stay as the record of what
   * `up()` did.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    dialectOf(queryRunner, this.name);
  }
}

// Module-private on purpose: TypeORM loads a migration directory by taking
// every exported value as a migration class (H9, S1 and S2 carry their own copies too).

type RecordPhase = 'deployment' | 'maintenance';

/** The receipts keep the latest 50 runs, as the re-pin's do (`RECEIPT_RUNS`, `seed/receipts.ts`). */
const RECEIPT_RUNS = 50;

/** One phase's run: its counts and lists, and the states it found needing nothing (a refusal listed for one is over). */
interface Tally {
  counts: Record<RecordConversionOutcome | 'skipped', number>;
  converted: { stateId: string; reason: string }[];
  refused: { stateId: string; reason: string }[];
  skipped: { stateId: string; reason: string }[];
  notesKept: number;
  incidentsCopied: number;
  settled: Set<string>;
}

function newTally(): Tally {
  return {
    counts: { 'kept-record': 0, converted: 0, seeded: 0, untouched: 0, refused: 0, skipped: 0 },
    converted: [],
    refused: [],
    skipped: [],
    notesKept: 0,
    incidentsCopied: 0,
    settled: new Set(),
  };
}

/**
 * One receipt, merged into whatever is there, keeping the sections the boot
 * added (`drafts`, `repin`). Every run adds itself to `runs` (the latest 50).
 * A run that converts something writes its own counts and skips, merges its
 * converted and refused states into the lists already there (one entry per
 * state, a refusal dropped once its state settles) and adds its notes and
 * incidents; a run that converts nothing leaves the converting run's sections
 * as they were, so a manual re-run never erases what the first run did.
 */
async function writeReceipt(
  queryRunner: QueryRunner,
  at: (n: number) => string,
  key: string,
  now: string,
  tally: Tally,
  incidents: boolean,
): Promise<void> {
  const run = { at: now, counts: tally.counts };
  const held: { value: string }[] = await queryRunner.query(`SELECT "value" AS "value" FROM "settings" WHERE "key" = ${at(1)}`, [key]);
  const previous = held.length ? parsedObject(held[0].value) : {};
  const runs = [...(Array.isArray(previous.runs) ? previous.runs : []), run].slice(-RECEIPT_RUNS);
  const convertedNow = tally.counts['kept-record'] + tally.counts.converted + tally.counts.seeded > 0;
  const firstRun = !previous.counts || typeof previous.counts !== 'object';
  const standing = byState(previous.refused, tally.refused).filter((one) => !tally.settled.has(one.stateId));
  const counted = (name: string, now: number) => (typeof previous[name] === 'number' ? (previous[name] as number) : 0) + now;
  const receipt: Partial<RecordMigrationReceipt> =
    convertedNow || firstRun
      ? {
          ...run,
          converted: byState(previous.converted, tally.converted),
          refused: standing,
          skipped: tally.skipped,
          notesKept: counted('notesKept', tally.notesKept),
          ...(incidents ? { incidentsCopied: counted('incidentsCopied', tally.incidentsCopied) } : {}),
          runs,
        }
      : { refused: standing, skipped: tally.skipped, runs };
  if (held.length) {
    await queryRunner.query(`UPDATE "settings" SET "value" = ${at(1)} WHERE "key" = ${at(2)}`, [JSON.stringify({ ...previous, ...receipt }), key]);
  } else {
    await queryRunner.query(`INSERT INTO "settings" ("key", "value") VALUES (${at(1)}, ${at(2)})`, [key, JSON.stringify(receipt)]);
  }
}

/** A receipt as log lines: one per outcome count, then the records whose notes kept words (and the incidents copied). */
function receiptLines(record: string, tally: Tally, incidents: boolean): string[] {
  const lines = Object.entries(tally.counts).map(([outcome, count]) => `S3 ${record} workspaces ${outcome}: ${count}`);
  lines.push(`S3 ${record} records whose notes kept a learner's words: ${tally.notesKept}`);
  if (incidents) lines.push(`S3 runbook records given the drill's incident: ${tally.incidentsCopied}`);
  return lines;
}

/** A version's stored snapshot, parsed; `unreadable` when there is none to read. */
type Snapshot = { snapshot: unknown } | 'unreadable';

function snapshotOf(compiled: string | null): Snapshot {
  if (!compiled) return 'unreadable';
  try {
    const snapshot = typeof compiled === 'string' ? (JSON.parse(compiled) as unknown) : (compiled as unknown);
    return snapshot && typeof snapshot === 'object' ? { snapshot } : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** Whether a snapshot's phase is in its structured form: a config Deployment with `runbook`, a code Maintenance with `change`. */
function gradesRecord(snapshot: unknown, phase: RecordPhase): boolean {
  const phases = (snapshot as { content?: { phases?: { key?: unknown; checks?: { kind?: unknown; runbook?: unknown; change?: unknown } }[] } }).content?.phases;
  const checks = (Array.isArray(phases) ? phases : []).find((one) => one?.key === phase)?.checks;
  if (phase === 'deployment') return checks?.kind === 'config' && !!checks.runbook;
  return checks?.kind === 'code' && !!checks.change;
}

const DOCUMENT: Record<RecordPhase, string> = { deployment: 'runbook document', maintenance: 'change request document' };

/**
 * Whether this row's learner is graded on the record, and the version that
 * grades it; otherwise the sentence the receipt lists the skip under. The
 * same rule the boot re-pin's in-place pass converts by: the learner's
 * version is the pin, or, for a null pin, the project's published head.
 */
function gradedBy(
  row: { projectSlug: string | null; projectVersionId: string | null },
  phase: RecordPhase,
  pinned: Map<string, Snapshot>,
  heads: Map<string, Snapshot | null>,
): { skip: null; snapshot: unknown } | { skip: string } {
  if (row.projectSlug === null) return { skip: 'the phase state has no enrolment' };
  let version: Snapshot;
  if (row.projectVersionId) {
    version = pinned.get(row.projectVersionId) ?? 'unreadable';
    if (version === 'unreadable') return { skip: "the learner's version has no compiled snapshot that can be read" };
  } else {
    const head = heads.get(row.projectSlug) ?? null;
    if (head === null) return { skip: "the learner follows the project's published head, and it has none" };
    if (head === 'unreadable') return { skip: "the learner follows the project's published head, whose compiled snapshot cannot be read" };
    version = head;
  }
  return gradesRecord(version.snapshot, phase) ? { skip: null, snapshot: version.snapshot } : { skip: `this state's version does not grade the ${DOCUMENT[phase]}` };
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
