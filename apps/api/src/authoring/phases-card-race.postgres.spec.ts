import 'reflect-metadata';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { PHASE_ORDER } from '@learnsdlc/shared';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import { ProjectImporterService } from '../content/importer.service';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectEntity, ProjectFileEntity, ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../content/project.entities';
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

/**
 * The door/save race, on a real PostgreSQL server, two pooled connections: a
 * Phases card door (`removePhase`, which deletes a phase's file, task and
 * phase rows and renumbers the rest) and an ordinary draft save
 * (`updatePhase`, another phase's intro) sent together on one draft of a
 * TaskTrackr copy, eight rounds, Testing put back whole after each.
 *
 * Every draft writer takes the version row's `pessimistic_write` lock first
 * (`lockDraftRow`), so the two sides wait on each other in one order: both
 * land in every round, and none deadlocks. Without it, a door and a save
 * could deadlock, and this race on a head before the
 * lock deadlocked in 7 rounds of 8. The SQLite pin of the lock is the call
 * order in `phases-card.spec.ts`; only a real server can race the two.
 *
 * Whatever the interleaving, the draft is never half written: a side either
 * lands whole or fails whole (a deadlock PostgreSQL broke, 40P01, or the
 * save's compare-and-swap, 409), a retry of a failed side lands, the phases
 * stay numbered 1 to n in LearnSDLC's order, no file row is left behind by a
 * removed phase, and the draft still compiles.
 *
 * Self-skips without `POSTGRES_TEST_CONFIG`, as every `.postgres.spec.ts` here
 * does; refuses any database but the loopback cluster's `lsdlc_numbers` /
 * `lsdlc_pgspecs`; works in a scratch schema it drops. The fixture needs
 * `uuid-ossp` installed on the server beforehand and will not install it.
 */
const url = isolatedPostgresUrl();
const describePg = url ? describe : describe.skip;
const PREFIX = 'rs_s4_race';
const TEACHER = { id: '7b1c9e40-5d2a-4f6b-9c3e-1a2b3c4d5e6f', role: 'INSTRUCTOR' as const, cohort: 'default' };
const ROUNDS = 8;

const codeOf = (error: unknown): string | undefined => {
  const e = error as { code?: string; driverError?: { code?: string } };
  return e?.code ?? e?.driverError?.code;
};
const statusOf = (error: unknown): number | undefined => {
  const e = error as { getStatus?: () => number };
  return typeof e?.getStatus === 'function' ? e.getStatus() : undefined;
};
/** A side that failed whole: a deadlock PostgreSQL broke, or the save's compare-and-swap conflict (409). */
const failedWhole = (error: unknown): boolean => codeOf(error) === '40P01' || statusOf(error) === 409;

describePg('the door/save race: a Phases card door against a draft save (PostgreSQL, two pooled connections)', () => {
  let admin: DataSource;
  let one: DataSource;
  let service: AuthoringService;
  const schema = scratchSchema(PREFIX);

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url: url! }).initialize();
    await openScratchSchema(admin, schema);
    const migrator = await new DataSource({
      ...postgresOptions(url!, schema, migrationFilesBefore('9999999999999'), ALL_ENTITIES),
      extra: { options: `-c search_path=${schema},public`, statement_timeout: 30000, max: 2 },
    } as never).initialize();
    await migrator.runMigrations({ transaction: 'all' });
    await migrator.destroy();
    one = await new DataSource({
      ...postgresOptions(url!, schema, [], ALL_ENTITIES),
      extra: { options: `-c search_path=${schema},public`, statement_timeout: 30000, max: 4 },
    } as never).initialize();
    const content = new ContentService();
    const importer = new ProjectImporterService(content, one);
    const registry = new ProjectRegistryService(content, one, { importedContent: [] } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);
    const imported = await importer.importPack(new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')), { origin: 'seed', platformOwned: true });
    await one.getRepository(ProjectEntity).update({ id: imported.projectId }, { isDefault: true });
    await registry.load();
    service = new AuthoringService(one, importer, registry);
  }, 300000);

  afterAll(async () => {
    if (one?.isInitialized) await one.destroy();
    if (admin?.isInitialized) {
      await dropScratchSchema(admin, schema, PREFIX);
      await admin.destroy();
    }
  });

  it('removing a phase and saving another phase\'s intro both land, with the draft row locked first: never half written, the phases stay 1 to n and the draft compiles', async () => {
    const seed = await one.getRepository(ProjectVersionEntity).findOneOrFail({ where: { status: 'published' } });
    const made = await service.createProject(TEACHER, { title: 'Race copy', slug: 'race-copy', fromVersionId: seed.id });
    const projectId = made.project.id;
    const versionId = made.draftVersionId;

    const phases = () => one.getRepository(ProjectPhaseEntity).find({ where: { projectVersionId: versionId } });
    const testingRows = async () => {
      const held = (await phases()).find((p) => p.key === 'testing');
      if (!held) return null;
      return {
        tasks: await one.getRepository(ProjectTaskEntity).count({ where: { projectPhaseId: held.id } }),
        files: await one.getRepository(ProjectFileEntity).count({ where: { projectVersionId: versionId, ownerKind: 'phase', ownerId: held.id } }),
      };
    };
    const orphans = async () => {
      const ids = (await phases()).map((p) => p.id);
      const files = await one.getRepository(ProjectFileEntity).find({ where: { projectVersionId: versionId, ownerKind: 'phase' }, select: { id: true, ownerId: true } });
      return files.filter((f) => !ids.includes(f.ownerId)).length;
    };
    const baseline = await testingRows();
    expect(baseline).not.toBeNull();

    const tally = { both: 0, doorFailed: 0, saveFailed: 0, deadlocks: 0, conflicts: 0 };
    for (let round = 1; round <= ROUNDS; round += 1) {
      const before = (await phases()).find((p) => p.key === 'requirements')!.intro;
      const intro = `Race round ${round}: the intro a teacher saved while another tab removed Testing.`;
      const door = () => service.removePhase(TEACHER, projectId, versionId, 'testing');
      const save = () => service.updatePhase(TEACHER, projectId, versionId, 'requirements', { intro } as never);
      const [d, s] = await Promise.allSettled([door(), save()]);
      for (const side of [d, s]) {
        if (side.status === 'rejected') {
          expect(failedWhole(side.reason)).toBe(true);
          if (codeOf(side.reason) === '40P01') tally.deadlocks += 1;
          else tally.conflicts += 1;
        }
      }
      if (d.status === 'fulfilled' && s.status === 'fulfilled') tally.both += 1;
      if (d.status === 'rejected') tally.doorFailed += 1;
      if (s.status === 'rejected') tally.saveFailed += 1;

      // whole or nothing, side by side
      const now = await phases();
      expect(now.some((p) => p.key === 'testing')).toBe(d.status === 'rejected');
      if (d.status === 'rejected') expect(await testingRows()).toEqual(baseline);
      expect(now.find((p) => p.key === 'requirements')!.intro).toBe(s.status === 'fulfilled' ? intro : before);
      expect(await orphans()).toBe(0);
      const sorted = [...now].sort((a, b) => a.order - b.order);
      expect(sorted.map((p) => p.order)).toEqual(sorted.map((_, i) => i + 1));
      expect(sorted.map((p) => p.key)).toEqual([...sorted.map((p) => p.key)].sort((a, b) => PHASE_ORDER.indexOf(a) - PHASE_ORDER.indexOf(b)));

      // a retry of a failed side lands
      if (d.status === 'rejected') await door();
      if (s.status === 'rejected') await save();
      const after = await phases();
      expect(after.some((p) => p.key === 'testing')).toBe(false);
      expect(after.find((p) => p.key === 'requirements')!.intro).toBe(intro);
      expect(await orphans()).toBe(0);
      await service.validate(TEACHER, projectId, versionId);
      const stored = await one.getRepository(ProjectVersionEntity).findOneOrFail({ where: { id: versionId } });
      expect((stored.compiled?.content.phases ?? []).map((p) => p.key).sort()).toEqual(after.map((p) => p.key).sort());

      // Testing put back whole for the next round
      await service.restorePhase(TEACHER, projectId, versionId, 'testing');
      expect(await testingRows()).toEqual(baseline);
    }
    // the lock serialises the two sides: both land every round, and none deadlocks
    expect(tally).toEqual({ both: ROUNDS, doorFailed: 0, saveFailed: 0, deadlocks: 0, conflicts: 0 });
  }, 600000);
});
