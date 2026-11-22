import 'reflect-metadata';
import * as path from 'path';
import { DataSource, UpdateQueryBuilder } from 'typeorm';
import { draftOnlyRefusal } from '@learnsdlc/shared';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import { ProjectImporterService } from '../content/importer.service';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectEntity, ProjectVersionEntity } from '../content/project.entities';
import { ProjectRegistryService } from '../content/project-registry.service';
import { ALL_ENTITIES } from '../db/entities';
import {
  dropScratchSchema,
  migrationFilesBefore,
  openScratchSchema,
  postgresOptions,
  scratchSchema,
} from '../../test/migration-history-fixture';
import { isolatedPostgresUrl } from '../../test/support/postgres';
import { AuthoringService } from './authoring.service';
// the sealed door on its own connection, and deep validation's receipt digest (read-only import)
import { ProjectFileEntity, ProjectPhaseEntity } from '../content/project.entities';
import type { CompiledSnapshot } from '../content/pack-compiler';
import type { CodeChecks } from '../content/content.types';
import { SealedRoleService } from './sealed-roles';
import { executableContentDigest } from './deep-validation';
import { deepReceiptRefusal } from './validation';

/**
 * persist()'s compare-and-swap under the version row lock, proved on
 * PostgreSQL 16 with two connections (the PostgreSQL pattern in
 * `deep-validation.spec.ts`).
 *
 * Every draft writer locks the draft's version row first (`lockDraftRow`,
 * `pessimistic_write`), then loads the draft, compiles it, and swaps
 * `project_versions.validation` (and `compiled`) predicated on the text it
 * read. No other connection can commit to the row between that load and
 * that swap: a competing change either commits before the service's call,
 * and the service reads it, or starts while the service holds the lock, and
 * waits for it.
 *
 * Most cases take the first order. The competing change (deep validation's
 * receipt, a publish, another draft write, a sealed write) commits on
 * connection `two`, then the service runs on connection `one`, and the case
 * asks what the service does with the row as it now stands: a receipt is
 * carried, a version that is no longer a draft answers 409 with the
 * draft-only sentence, a stale deep receipt refuses the publish (400), and a
 * refused call writes nothing. Two cases take the second order: a direct
 * UPDATE of the row on connection `two`, started while validate holds the
 * lock, waits for it and lands whole after validate's write; and a sealed
 * write started while publish holds the lock waits, then meets the
 * published version.
 *
 * `racing` counts persist's swaps (its UPDATEs of the column) and can run a
 * step at the first of them, while the service holds the lock.
 *
 * Runs only with `POSTGRES_TEST_CONFIG` set inline (a scratch schema
 * `rx_spine2_<uuid>` it drops); skips without it.
 */

const url = isolatedPostgresUrl();
const describePg = url ? describe : describe.skip;
const PREFIX = 'rx_spine2';
const TEACHER = { id: '4f8e2a61-3c7b-4d19-8e25-6a0b9c1d2e33', role: 'INSTRUCTOR' as const, cohort: 'default' };

describePg('persist() compare-and-swap on PostgreSQL 16 (two connections)', () => {
  let admin: DataSource;
  let one: DataSource;
  let two: DataSource;
  let service: AuthoringService;
  let seedVersionId = '';
  const schema = scratchSchema(PREFIX);
  let made = 0;

  const open = async (max: number): Promise<DataSource> =>
    new DataSource({
      ...postgresOptions(url!, schema, [], ALL_ENTITIES),
      extra: { options: `-c search_path=${schema},public`, statement_timeout: 30000, max },
    } as never).initialize();

  const copy = async () => {
    made += 1;
    const out = await service.createProject(TEACHER, { title: `CAS copy ${made}`, slug: `cas-copy-${made}`, fromVersionId: seedVersionId });
    // one validate first, so the column holds a stored fast tier to swap against
    await service.validate(TEACHER, out.project.id, out.draftVersionId);
    return { projectId: out.project.id, versionId: out.draftVersionId };
  };

  const storedOf = async (versionId: string): Promise<Record<string, unknown>> => {
    const [row] = (await two.query(`SELECT "validation", "status" FROM "project_versions" WHERE "id" = $1`, [versionId])) as { validation: string | null; status: string }[];
    return { ...(row.validation ? (JSON.parse(row.validation) as Record<string, unknown>) : {}), _status: row.status };
  };

  /**
   * Run `act`, counting the swaps persist attempted (its own UPDATEs of the
   * validation column reaching `execute`), and run `during` at the first
   * `times` of them, while the service's transaction holds the version row
   * lock. `during` must never wait for a write on that row to finish: that
   * write waits for the lock this transaction holds.
   */
  const racing = async <T>(during: (attempt: number) => Promise<void>, times: number, act: () => Promise<T>) => {
    let attempts = 0;
    const original = UpdateQueryBuilder.prototype.execute;
    const spy = jest.spyOn(UpdateQueryBuilder.prototype, 'execute').mockImplementation(async function (this: any) {
      const values = (this.expressionMap?.valuesSet ?? {}) as Record<string, unknown>;
      if (this.expressionMap?.mainAlias?.target === ProjectVersionEntity && 'validation' in values) {
        attempts += 1;
        if (attempts <= times) await during(attempts);
      }
      return original.call(this);
    });
    try {
      const value = await act().then(
        (result) => ({ result, error: null as unknown }),
        (error: unknown) => ({ result: null as T | null, error }),
      );
      return { ...value, attempts };
    } finally {
      spy.mockRestore();
    }
  };
  /** Count persist's swaps in `act`, with nothing run between them. */
  const counted = <T>(act: () => Promise<T>) => racing(async () => undefined, 0, act);

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url: url! }).initialize();
    await openScratchSchema(admin, schema);
    const migrator = await new DataSource({
      ...postgresOptions(url!, schema, migrationFilesBefore('9999999999999'), ALL_ENTITIES),
      extra: { options: `-c search_path=${schema},public`, statement_timeout: 30000, max: 2 },
    } as never).initialize();
    await migrator.runMigrations({ transaction: 'all' });
    await migrator.destroy();
    one = await open(4);
    two = await open(2);

    const content = new ContentService();
    const importer = new ProjectImporterService(content, one);
    const registry = new ProjectRegistryService(content, one, {
      importedContent: [],
    } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);
    const imported = await importer.importPack(new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')), {
      origin: 'seed',
      platformOwned: true,
    });
    await one.getRepository(ProjectEntity).update({ id: imported.projectId }, { isDefault: true });
    await registry.load();
    seedVersionId = imported.projectVersionId;
    service = new AuthoringService(one, importer, registry);
    sealOne = new SealedRoleService(one, importer);
  }, 180000);
  let sealOne: SealedRoleService;

  afterAll(async () => {
    for (const source of [one, two]) if (source?.isInitialized) await source.destroy();
    if (admin?.isInitialized) {
      await dropScratchSchema(admin, schema, PREFIX);
      await admin.destroy();
    }
  });

  it('GUARD › a deep receipt (validation.deep and deepRun) that deep validation commits before validate is carried, in one swap on the text deep validation left', async () => {
    const fork = await copy();
    const deep = { contentDigest: 'e'.repeat(64), status: 'passed', checks: [], microVMs: 20, startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z' };
    const deepRun = { token: 'val-token-1', state: 'finished', startedAt: '2026-10-01T00:00:00Z' };
    const before = await storedOf(fork.versionId);
    expect(before.deep).toBeUndefined();

    // deep validation's finish(), on its own connection, committed: it carries what it read and adds its keys
    const now = { ...before };
    delete now._status;
    await two.query(`UPDATE "project_versions" SET "validation" = $1 WHERE "id" = $2`, [JSON.stringify({ ...now, deep, deepRun }), fork.versionId]);

    const out = await counted(() => service.validate(TEACHER, fork.projectId, fork.versionId));
    expect(out.error).toBeNull();
    const after = await storedOf(fork.versionId);
    expect(after.deep).toEqual(deep);
    expect(after.deepRun).toEqual(deepRun);
    expect(after.tier).toBe('fast');
    // validate read the row after deep validation's commit, so its first swap held
    expect(out.attempts).toBe(1);
    expect((after.report as { ranAt?: string } | undefined)?.ranAt).toBe(out.result!.ranAt);
  });

  it('GUARD › a version published before validate answers draftOnlyRefusal (409) and writes nothing', async () => {
    const fork = await copy();
    await two.query(`UPDATE "project_versions" SET "status" = 'published', "version" = '1.0.0' WHERE "id" = $1`, [fork.versionId]);
    const before = await storedOf(fork.versionId);
    const out = await counted(() => service.validate(TEACHER, fork.projectId, fork.versionId));
    // refused on the row as locked, before any swap
    expect(out.attempts).toBe(0);
    const response = (out.error as { getStatus?: () => number; getResponse?: () => unknown } | null);
    expect(response?.getStatus?.()).toBe(409);
    expect(String((response?.getResponse?.() as { message?: unknown } | undefined)?.message)).toBe(draftOnlyRefusal('1.0.0', 'published'));
    // and nothing was written over the published row's column
    const after = await storedOf(fork.versionId);
    expect(after).toEqual(before);
    expect(after._status).toBe('published');
  });

  it('GUARD › a direct update of the version row on a second connection, started while validate holds the row lock, waits for it and lands whole after validate\'s write: both writes stand, in order', async () => {
    const fork = await copy();
    const deep = { contentDigest: 'd'.repeat(64), status: 'passed', checks: [], microVMs: 20, startedAt: '2026-10-03T00:00:00Z', finishedAt: '2026-10-03T00:01:00Z' };
    const before = await storedOf(fork.versionId);
    const side: { direct?: Promise<unknown>; settled: boolean; settledAtSwap?: boolean; waitedOnLock: boolean } = { settled: false, waitedOnLock: false };
    const started = Date.now();
    const out = await racing(
      async () => {
        // Connection two's own UPDATE of the row, one statement: it adds its key to the
        // column as the column stands when the statement runs, and keeps the `when` it saw there.
        side.direct = two
          .query(
            `UPDATE "project_versions" /* persist-cas direct writer */ SET "validation" = ` +
              `(COALESCE("validation", '{}')::jsonb || jsonb_build_object('deep', $1::jsonb, 'sawWhen', COALESCE("validation", '{}')::jsonb -> 'when'))::text ` +
              `WHERE "id" = $2`,
            [JSON.stringify(deep), fork.versionId],
          )
          .then(
            () => {
              side.settled = true;
              return null;
            },
            (error: unknown) => {
              side.settled = true;
              return error;
            },
          );
        // PostgreSQL shows the statement waiting on a lock: the version row validate holds
        for (let poll = 0; poll < 200 && !side.waitedOnLock; poll += 1) {
          const waiting = (await admin.query(
            `SELECT 1 FROM pg_stat_activity WHERE "wait_event_type" = 'Lock' AND "query" LIKE '%persist-cas direct writer%' AND "pid" <> pg_backend_pid()`,
          )) as unknown[];
          side.waitedOnLock = waiting.length > 0;
          if (!side.waitedOnLock) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        side.settledAtSwap = side.settled;
      },
      1,
      () => service.validate(TEACHER, fork.projectId, fork.versionId),
    );
    const directError = await side.direct;
    const elapsed = Date.now() - started;
    const after = await storedOf(fork.versionId);
    const ranAt = (out.result as { ranAt?: string } | null)?.ranAt;
    expect({
      error: out.error,
      attempts: out.attempts,
      waitedOnLock: side.waitedOnLock,
      settledAtSwap: side.settledAtSwap,
      directError: directError ?? null,
    }).toEqual({ error: null, attempts: 1, waitedOnLock: true, settledAtSwap: false, directError: null });
    expect(before.when).not.toBe(ranAt);
    // validate's write whole, then the direct write whole on top of it: it saw validate's `when`
    expect({
      tier: after.tier,
      when: after.when,
      reportRanAt: (after.report as { ranAt?: string } | undefined)?.ranAt,
      deep: after.deep,
      sawWhen: after.sawWhen,
      status: after._status,
    }).toEqual({ tier: 'fast', when: ranAt, reportRanAt: ranAt, deep, sawWhen: ranAt, status: 'draft' });
    expect(elapsed).toBeLessThan(BOUND_MS);
  }, 120000);

  /*
   * A swap over the `validation` text only would let a draft write (B,
   * connection two) be carried in `validation` and lost from `compiled`. With
   * the lock, B commits before A's call or waits for A: A loads B's rows, and
   * the compile A stores is of the rows after both writes.
   */
  it("a draft write committed before another draft write's call: the stored compiled holds both", async () => {
    const fork = await copy();
    const content = new ContentService();
    const importerTwo = new ProjectImporterService(content, two);
    const registryTwo = new ProjectRegistryService(content, two, {
      importedContent: [],
    } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);
    await registryTwo.load();
    const serviceTwo = new AuthoringService(two, importerTwo, registryTwo);

    // B: a task edit on another phase, committed on its own connection
    await serviceTwo.updateTask(TEACHER, fork.projectId, fork.versionId, 'design', 'main', { title: 'Design, as B saved it' });
    // A: a task edit sent after B committed
    const out = await counted(() =>
      service.updateTask(TEACHER, fork.projectId, fork.versionId, 'requirements', 'main', { title: 'Requirements, as A saved it' }),
    );
    expect(out.error).toBeNull();
    expect(out.attempts).toBe(1);
    const [row] = (await two.query(`SELECT "compiled" FROM "project_versions" WHERE "id" = $1`, [fork.versionId])) as { compiled: string }[];
    const compiled = JSON.parse(row.compiled) as { phases: { key: string; tasks: { title: string }[] }[] };
    const titleOf = (key: string) => compiled.phases.find((one) => one.key === key)?.tasks.map((one) => one.title);
    // the stored compile is of the rows as they stand after both writes
    expect({ requirements: titleOf('requirements'), design: titleOf('design') }).toEqual({
      requirements: ['Requirements, as A saved it'],
      design: ['Design, as B saved it'],
    });
  });

  /*
   * Sealed writes and publish. A sealed write committed before publish's call
   * is in the rows publish loads; one that starts while publish holds the row
   * waits (the GUARD case). Each case is bounded by a timeout assertion, so a
   * lock that waited on the other connection would fail here instead of
   * hanging.
   */
  const servicesOnTwo = async () => {
    const content = new ContentService();
    const importerTwo = new ProjectImporterService(content, two);
    const registryTwo = new ProjectRegistryService(content, two, {
      importedContent: [],
    } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);
    await registryTwo.load();
    return { service: new AuthoringService(two, importerTwo, registryTwo), seal: new SealedRoleService(two, importerTwo) };
  };
  const BOUND_MS = 20000;
  const implementationHidden = async (versionId: string): Promise<string> => {
    const phase = await one.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key: 'implementation' });
    const rows = await one.getRepository(ProjectFileEntity).find({ where: { projectVersionId: versionId, ownerId: phase.id, role: 'hidden' } });
    return rows.map((row) => row.path).sort()[0].slice('hidden/'.length);
  };
  const storedRow = async (versionId: string) => {
    const [row] = (await two.query(`SELECT "status", "compiled", "validation" FROM "project_versions" WHERE "id" = $1`, [versionId])) as {
      status: string;
      compiled: string;
      validation: string | null;
    }[];
    return { status: row.status, compiled: JSON.parse(row.compiled) as CompiledSnapshot, validation: row.validation ? (JSON.parse(row.validation) as Record<string, unknown>) : {} };
  };
  const hiddenBytesIn = (compiled: CompiledSnapshot, at: string): string | undefined => {
    const checks = compiled.content.phases.find((one) => one.key === 'implementation')!.checks as CodeChecks;
    return checks.runs.map((run) => run.hiddenTestFiles[at]).find((bytes) => bytes !== undefined) ?? checks.hiddenTestFiles?.[at];
  };
  /** A passed deep receipt for the executable bytes of `compiled`, written straight into the version's column (deep validation's finish, test-side). */
  const receiptFor = async (versionId: string, compiled: CompiledSnapshot) => {
    const { validation } = await storedRow(versionId);
    const deep = { contentDigest: executableContentDigest({ compiled } as never), status: 'passed', checks: [], microVMs: 20, startedAt: '2026-10-02T00:00:00Z', finishedAt: '2026-10-02T00:01:00Z' };
    await two.query(`UPDATE "project_versions" SET "validation" = $1 WHERE "id" = $2`, [JSON.stringify({ ...validation, deep }), versionId]);
  };

  it('a sealed write committed before publish is in the compile publish stores', async () => {
    // a twin fork with the same sealed write: the compile publish should store, and a receipt current for it
    const twin = await copy();
    const fork = await copy();
    const at = await implementationHidden(fork.versionId);
    const sealed = `# the sealed bytes connection two commits\nimport unittest\n`;
    await sealOne.write(TEACHER, twin.projectId, twin.versionId, 'implementation', 'main', 'hidden', at, sealed, null);
    await service.validate(TEACHER, twin.projectId, twin.versionId);
    await receiptFor(fork.versionId, (await storedRow(twin.versionId)).compiled);
    const { seal } = await servicesOnTwo();

    const started = Date.now();
    // the sealed write commits on connection two, then publish runs on connection one
    await seal.write(TEACHER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', at, sealed, null);
    const out = await counted(() => service.publish(TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' }));
    const elapsed = Date.now() - started;
    const after = await storedRow(fork.versionId);
    expect({
      error: out.error === null ? null : String((out.error as Error).message),
      attempts: out.attempts,
      status: after.status,
      stored: hiddenBytesIn(after.compiled, at) === sealed,
    }).toEqual({ error: null, attempts: 1, status: 'published', stored: true });
    expect(elapsed).toBeLessThan(BOUND_MS);
  }, 120000);

  it('publish never ships a compile without sealed bytes committed before it: the stale receipt refuses it (400) and publish writes nothing', async () => {
    const fork = await copy();
    const at = await implementationHidden(fork.versionId);
    const first = `# first sealed bytes\nimport unittest\n`;
    const second = `# second sealed bytes, committed before publish\nimport unittest\n`;
    await sealOne.write(TEACHER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', at, first, null);
    await service.validate(TEACHER, fork.projectId, fork.versionId);
    // a receipt current for the first bytes: publish may ship them, never as if they were the rows' bytes after the second write
    await receiptFor(fork.versionId, (await storedRow(fork.versionId)).compiled);
    const { seal } = await servicesOnTwo();

    const started = Date.now();
    await seal.write(TEACHER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', at, second, null);
    const before = await storedRow(fork.versionId);
    const out = await counted(() => service.publish(TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' }));
    const elapsed = Date.now() - started;
    const after = await storedRow(fork.versionId);
    const response = out.error as { getStatus?: () => number; message?: string } | null;
    expect({
      status: after.status,
      publishedWithFirst: after.status === 'published' && hiddenBytesIn(after.compiled, at) === first,
      refused: response?.getStatus?.() ?? null,
      sentence: String(response?.message ?? '').includes(deepReceiptRefusal('Implementation')),
    }).toEqual({ status: 'draft', publishedWithFirst: false, refused: 400, sentence: true });
    // the refusal rolled publish's swap back: the row is as the sealed write left it
    expect(after).toEqual(before);
    expect(elapsed).toBeLessThan(BOUND_MS);
  }, 120000);

  it('GUARD › a sealed write that starts while publish holds the version row waits for it, then meets the published version (409): no sealed row lands behind a published compile', async () => {
    const fork = await copy();
    const at = await implementationHidden(fork.versionId);
    const late = `# a sealed write that started inside publish\nimport unittest\n`;
    const { seal } = await servicesOnTwo();
    let pending: Promise<unknown> | null = null;
    // the moment: publish has swapped (its UPDATE holds the row) and asks the file rows again
    const proto = AuthoringService.prototype as unknown as { sameFileRows: (...args: unknown[]) => Promise<boolean> };
    const original = proto.sameFileRows;
    const spy = jest.spyOn(proto, 'sameFileRows').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      if (!pending) {
        pending = seal.write(TEACHER, fork.projectId, fork.versionId, 'implementation', 'main', 'hidden', at, late, null).then(
          () => null,
          (error: unknown) => error,
        );
        // until PostgreSQL shows connection two waiting on the version row's lock (at most 750 ms):
        // only the sealed write's row lock on project_versions in this test's database counts, so a
        // lock wait in another session or database cannot end the poll early
        for (let poll = 0; poll < 30; poll += 1) {
          const waiting = (await admin.query(
            `SELECT 1 FROM pg_stat_activity WHERE "wait_event_type" = 'Lock' AND "datname" = current_database() ` +
              `AND "query" LIKE '%project_versions%FOR %UPDATE%' AND "pid" <> pg_backend_pid()`,
          )) as unknown[];
          if (waiting.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      return original.apply(this, args);
    });
    const started = Date.now();
    let published: unknown = null;
    try {
      published = await service.publish(TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' }).then(
        (result) => result,
        (error: unknown) => error,
      );
    } finally {
      spy.mockRestore();
    }
    const sealed = (await pending) as { getStatus?: () => number; message?: string } | null;
    const elapsed = Date.now() - started;
    const after = await storedRow(fork.versionId);
    const lateRows = (await two.query(
      `SELECT f."id" FROM "project_files" f JOIN "content_blobs" b ON b."sha" = f."blobSha" WHERE f."projectVersionId" = $1 AND b."bytes" = $2`,
      [fork.versionId, late],
    )) as unknown[];
    expect({
      published: (published as { versionId?: string } | null)?.versionId === fork.versionId,
      status: after.status,
      compiledHoldsLate: hiddenBytesIn(after.compiled, at) === late,
      lateRows: lateRows.length,
      sealedStatus: sealed?.getStatus?.() ?? null,
      sealedSentence: sealed?.message ?? null,
    }).toEqual({
      published: true,
      status: 'published',
      compiledHoldsLate: false,
      lateRows: 0,
      sealedStatus: 409,
      sealedSentence: draftOnlyRefusal('1.0.0', 'published'),
    });
    expect(elapsed).toBeLessThan(BOUND_MS);
  }, 120000);

  it("mutateDraft's answer is the stored draft's phase, holding the intro another writer committed before the call", async () => {
    const fork = await copy();
    const { service: serviceTwo } = await servicesOnTwo();
    const intro = 'Requirements, introduced by B before A saved.';
    const started = Date.now();
    // B: the same phase's intro, committed on its own connection
    await serviceTwo.updatePhase(TEACHER, fork.projectId, fork.versionId, 'requirements', { intro });
    // A: a task title in that phase
    const out = await counted(() =>
      service.updateTask(TEACHER, fork.projectId, fork.versionId, 'requirements', 'main', { title: 'Requirements, as A saved it' }),
    );
    const elapsed = Date.now() - started;
    expect(out.error).toBeNull();
    expect(out.attempts).toBe(1);
    const [stored] = (await two.query(
      `SELECT p."intro" FROM "project_phases" p WHERE p."projectVersionId" = $1 AND p."key" = 'requirements'`,
      [fork.versionId],
    )) as { intro: string }[];
    const answered = (out.result as { phase: { intro: string; tasks: { title: string }[] } }).phase;
    expect({ stored: stored.intro, answered: answered.intro, title: answered.tasks.map((one) => one.title) }).toEqual({
      stored: intro,
      answered: intro,
      title: ['Requirements, as A saved it'],
    });
    expect(elapsed).toBeLessThan(BOUND_MS);
  }, 120000);
});
