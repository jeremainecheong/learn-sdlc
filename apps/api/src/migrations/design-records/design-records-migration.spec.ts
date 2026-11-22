import 'reflect-metadata';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DESIGN_JSON, validateDesignRecord } from '@learnsdlc/shared';
import { ALL_ENTITIES, EnrollmentEntity, PhaseStateEntity, SettingEntity, UserEntity } from '../../db/entities';
import { ProjectEntity, ProjectVersionEntity } from '../../content/project.entities';
import { S2DesignRecordsFromMarkdown1790200000000 } from '../1790200000000-S2-DesignRecordsFromMarkdown';
import { DESIGN_MIGRATION_RECEIPT_KEY, NOTES_HEADER } from './design-records';
import { TASKTRACKR_DESIGN_TEMPLATE } from './tasktrackr-design-template';

/**
 * The migration on the local-first store, every migration applied. It
 * converts a Design workspace if and only if the learner's version (the pin,
 * or the project's published head for a null pin) grades the design kind,
 * which is the set the boot re-pin also converts
 * (`seed/story-repin.service.ts`): a TaskTrackr learner still pinned to a
 * markdown version is converted by the re-pin in the same transaction that
 * moves them, never here. A refused row is left exactly as it was, and the
 * receipt names every folded, refused and skipped state with its reason.
 */
const MD = 'design/my-design.md';
/** The board's older record, as the 3.x room wrote it beside the design page. */
const LEGACY = JSON.stringify({
  fields: [{ name: 'id', type: 'integer', required: true, note: 'db' }],
  operations: [{ name: 'getOverdue(today)', satisfies: 'US-4', inputs: 'today', returns: 'Task[]', boundary: 'due today is not overdue', errors: '' }],
  decisions: [],
});
/** A drawn entity and 60 endpoints: the fold would leave endpoint lines out of the notes at the cap. */
const CUT = JSON.stringify({
  entities: [{ id: 'E1', name: 'Task' }],
  endpoints: Array.from({ length: 30 }, (_, i) => ({ method: 'GET', path: `/api/e${i + 1}`, purpose: 'p'.repeat(160) })),
});
const byId = (list: { stateId: string; reason: string }[]) => Object.fromEntries(list.map((one) => [one.stateId, one.reason]));
/** The stamp a tab that loaded the workspace before the migration still holds. */
const OLD_STAMP = '2026-10-01T09:00:00.000Z';

describe('S2 design records from markdown (sqlite)', () => {
  let db: DataSource;
  const states: Record<string, string> = {};
  let state: (key: string, pin: string | null, workspace: Record<string, string>) => Promise<void>;
  let v400: string;

  const compiled = (kind: 'markdown' | 'design') => ({
    content: { phases: [{ key: 'design', checks: { kind }, files: kind === 'markdown' ? [{ path: MD, content: TASKTRACKR_DESIGN_TEMPLATE }] : [] }] },
  });
  const rowOf = (key: string) => db.manager.findOneByOrFail(PhaseStateEntity, { id: states[key] });
  const workspaceOf = async (key: string) => (await rowOf(key)).workspace as Record<string, string>;
  const receiptOf = async () => JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: DESIGN_MIGRATION_RECEIPT_KEY })).value);

  beforeAll(async () => {
    Logger.overrideLogger(false);
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      migrations: [path.join(__dirname, '..', '*.{ts,js}')],
      migrationsTableName: 'learnsdlc_migrations',
    }).initialize();
    const applied = await db.runMigrations({ transaction: 'all' });
    // S2 is among the applied; later migrations follow it
    expect(applied.map((one) => one.name)).toContain('S2DesignRecordsFromMarkdown1790200000000');

    const user = await db.manager.save(db.manager.create(UserEntity, { email: 'l@s2.test', passwordHash: 'x', displayName: 'L' }));
    const tasktrackr = await db.manager.save(db.manager.create(ProjectEntity, { slug: 'tasktrackr', title: 'TaskTrackr', platformOwned: true, origin: 'seed' }));
    const v = async (version: string, kind: 'markdown' | 'design') =>
      (await db.manager.save(db.manager.create(ProjectVersionEntity, { projectId: tasktrackr.id, version, status: 'published', manifest: {} as never, compiled: compiled(kind) as never }))).id;
    const v300 = await v('3.0.0', 'markdown');
    v400 = await v('4.0.0', 'design');

    let order = 0;
    state = async (key, pin, workspace) => {
      const enrolment = await db.manager.save(db.manager.create(EnrollmentEntity, { userId: `${user.id}-${(order += 1)}`, projectSlug: 'tasktrackr', projectVersionId: pin }));
      const row = await db.manager.save(
        db.manager.create(PhaseStateEntity, { enrollmentId: enrolment.id, userId: user.id, phaseKey: 'design', phaseOrder: 2, workspace, workspaceUpdatedAt: OLD_STAMP }),
      );
      states[key] = row.id;
    };
    await state('folded', v400, { [MD]: TASKTRACKR_DESIGN_TEMPLATE, [DESIGN_JSON]: LEGACY });
    await state('refused', v400, { [DESIGN_JSON]: '{', [MD]: 'x' });
    await state('older', v300, { [MD]: 'my own design', [DESIGN_JSON]: LEGACY });
    await state('head', null, { [MD]: 'Tasks belong to one list.\n' });
    await state('cut', v400, { [DESIGN_JSON]: CUT, [MD]: 'board' });

    await new S2DesignRecordsFromMarkdown1790200000000().up(db.createQueryRunner());
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
  });

  it('folds the board record of a learner on the design version, drops the design page, and stamps it afresh', async () => {
    const row = await rowOf('folded');
    const workspace = row.workspace as Record<string, string>;
    expect(Object.keys(workspace)).toEqual([DESIGN_JSON]);
    const record = validateDesignRecord(workspace[DESIGN_JSON]).design!;
    expect(record.entities[0]).toMatchObject({ name: 'Model', kind: 'class' });
    expect(record.operations[0]).toMatchObject({ id: 'O1', note: 'boundary: due today is not overdue' });
    // the page was the untouched template: nothing of it is kept
    expect(record.notes ?? '').toBe('');
    expect(Date.parse(row.workspaceUpdatedAt as string)).toBeGreaterThan(Date.parse(OLD_STAMP));
  });

  it('seeds a null pin that follows the design head, keeping the words of its design page in notes', async () => {
    const workspace = await workspaceOf('head');
    expect(workspace[MD]).toBeUndefined();
    expect(validateDesignRecord(workspace[DESIGN_JSON]).design!.notes).toBe(`${NOTES_HEADER}\nTasks belong to one list.`);
  });

  it('leaves a learner still pinned to the markdown version for the re-pin, and a refused row exactly as it was', async () => {
    expect(await workspaceOf('older')).toEqual({ [MD]: 'my own design', [DESIGN_JSON]: LEGACY });
    expect(await workspaceOf('refused')).toEqual({ [DESIGN_JSON]: '{', [MD]: 'x' });
    // a fold that would cut the learner's lines is refused, never written
    expect(await workspaceOf('cut')).toEqual({ [DESIGN_JSON]: CUT, [MD]: 'board' });
    expect((await rowOf('cut')).workspaceUpdatedAt).toBe(OLD_STAMP);
    expect((await rowOf('older')).workspaceUpdatedAt).toBe(OLD_STAMP);
    expect((await rowOf('refused')).workspaceUpdatedAt).toBe(OLD_STAMP);
  });

  it('writes the receipt: one count per outcome, and each folded, refused and skipped state by id with its reason', async () => {
    const receipt = await receiptOf();
    expect(receipt.counts).toEqual({ 'kept-record': 0, folded: 1, seeded: 1, untouched: 0, refused: 2, skipped: 1 });
    expect(receipt.folded).toEqual([{ stateId: states.folded, reason: '1 field became the attributes of the entity Model; the boundary of O1 kept in its note' }]);
    expect(receipt.refused).toHaveLength(2);
    expect(byId(receipt.refused)[states.refused]).toBe('the design record could not be read, so it was not changed');
    expect(byId(receipt.refused)[states.cut]).toMatch(/^the board's older record would lose words in the fold \(\d+ endpoint lines left out of the notes: over the 4000-character cap\), so it was not changed$/);
    expect(receipt.skipped).toEqual([{ stateId: states.older, reason: "the learner's version still grades the markdown design" }]);
    expect(receipt.notesKept).toBe(1);
    expect(typeof receipt.at).toBe('string');
    // the first run is the harness's own runMigrations, on an empty store; this one converted
    expect(receipt.runs).toHaveLength(2);
    expect(receipt.runs[0].counts).toEqual({ 'kept-record': 0, folded: 0, seeded: 0, untouched: 0, refused: 0, skipped: 0 });
    expect(receipt.runs[1]).toEqual({ at: receipt.at, counts: receipt.counts });
  });

  it('running it again changes nothing it already converted, keeps the first run\'s sections and the boot\'s, and adds the run', async () => {
    const before = { folded: await workspaceOf('folded'), head: await workspaceOf('head') };
    const receipt = await receiptOf();
    const repin = { runs: [{ at: 'then', conversions: 1 }] };
    await db.manager.save(db.manager.create(SettingEntity, { key: DESIGN_MIGRATION_RECEIPT_KEY, value: JSON.stringify({ ...receipt, repin }) }));
    await new S2DesignRecordsFromMarkdown1790200000000().up(db.createQueryRunner());
    expect({ folded: await workspaceOf('folded'), head: await workspaceOf('head') }).toEqual(before);
    expect(await db.manager.countBy(SettingEntity, { key: DESIGN_MIGRATION_RECEIPT_KEY })).toBe(1);
    const again = await receiptOf();
    expect(again.repin).toEqual(repin);
    // a run that converts nothing leaves the converting run's sections as they were, and only adds itself to runs
    const { runs, ...sections } = again;
    const { runs: first, ...firstSections } = receipt;
    expect(sections).toEqual({ ...firstSections, repin });
    expect(runs).toHaveLength(3);
    expect(runs.slice(0, 2)).toEqual(first);
    expect(runs[2].counts).toEqual({ 'kept-record': 0, folded: 0, seeded: 0, untouched: 2, refused: 2, skipped: 1 });
  });

  it('a later run that converts a new row merges its folded state into the list and keeps the counts of the run that converted', async () => {
    await state('later', v400, { [DESIGN_JSON]: LEGACY });
    await new S2DesignRecordsFromMarkdown1790200000000().up(db.createQueryRunner());
    const receipt = await receiptOf();
    expect(receipt.counts).toEqual({ 'kept-record': 0, folded: 1, seeded: 0, untouched: 2, refused: 2, skipped: 1 });
    expect(Object.keys(byId(receipt.folded)).sort()).toEqual([states.folded, states.later].sort());
    expect(receipt.refused).toHaveLength(2);
    expect(receipt.skipped).toEqual([{ stateId: states.older, reason: "the learner's version still grades the markdown design" }]);
    expect(receipt.notesKept).toBe(1);
    expect(receipt.runs).toHaveLength(4);
    expect(receipt.repin).toEqual({ runs: [{ at: 'then', conversions: 1 }] });
  });

  it('a run that converts nothing still lists a newly refused or skipped state, and drops a refusal fixed by hand', async () => {
    await state('late-refused', v400, { [DESIGN_JSON]: '{', [MD]: 'y' });
    const v300 = (await db.manager.findOneByOrFail(ProjectVersionEntity, { version: '3.0.0' })).id;
    await state('late-skipped', v300, { [MD]: 'still markdown' });
    // fixed by hand: the refused row now holds a record already in the schema
    await db.manager.update(PhaseStateEntity, { id: states.refused }, { workspace: { [DESIGN_JSON]: JSON.stringify({ entities: [], relations: [], operations: [], decisions: [] }) } as never });
    await new S2DesignRecordsFromMarkdown1790200000000().up(db.createQueryRunner());
    const receipt = await receiptOf();
    // nothing converted, so the converting run's counts stand; the lists follow this run
    expect(receipt.counts.folded).toBe(1);
    expect(Object.keys(byId(receipt.skipped))).toContain(states['late-skipped']);
    const refusedIds = Object.keys(byId(receipt.refused));
    expect(refusedIds).toContain(states['late-refused']);
    expect(refusedIds).not.toContain(states.refused);
    expect(refusedIds).toContain(states.cut);
    expect(receipt.runs).toHaveLength(5);
  });
});
