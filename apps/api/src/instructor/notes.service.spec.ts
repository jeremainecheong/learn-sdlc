import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  AuditEventEntity,
  CohortEntity,
  InstructorNoteEntity,
  UserEntity,
} from '../db/entities';
import type { InstructorCaller } from './cohort-scope';
import { NotesService } from './notes.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * Notes an instructor writes for a whole class.
 *
 * Two things have to hold or the feature is worse than nothing: a note reaches
 * only the class it was written for, and the mentor carries at most two of them
 * into a reply, phase-specific first; a reply that recites a syllabus is not a
 * hint. The audit row carries the note's own words, because "what was this
 * class told" is the question an appeal asks.
 */
describe('NotesService', () => {
  let dataSource: DataSource;
  let service: NotesService;

  let cohortId = '';
  let otherCohortId = '';
  let owner: InstructorCaller;
  let stranger: InstructorCaller;

  const manager = () => dataSource.manager;
  /** Stamps notes a second apart, oldest first, as three writes a second apart would be. */
  const stampInOrder = async (ids: string[]): Promise<void> => {
    const base = Date.parse('2026-01-05T09:00:00.000Z');
    for (const [at, id] of ids.entries()) {
      await manager().update(InstructorNoteEntity, { id }, { createdAt: new Date(base + at * 1000) });
    }
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    service = new NotesService(dataSource);

    const ana = await manager().save(
      manager().create(UserEntity, {
        email: 'ana@class.test',
        passwordHash: 'x',
        displayName: 'Ana',
        role: 'INSTRUCTOR',
      }),
    );
    const monday = await manager().save(
      manager().create(CohortEntity, {
        name: 'Monday class',
        joinCode: 'MON-1',
        ownerUserId: ana.id,
      }),
    );
    cohortId = monday.id;
    await manager().update(UserEntity, ana.id, { cohort: cohortId });
    owner = { id: ana.id, role: 'INSTRUCTOR', cohort: cohortId };

    const bo = await manager().save(
      manager().create(UserEntity, {
        email: 'bo@class.test',
        passwordHash: 'x',
        displayName: 'Bo',
        role: 'INSTRUCTOR',
      }),
    );
    const friday = await manager().save(
      manager().create(CohortEntity, {
        name: 'Friday class',
        joinCode: 'FRI-1',
        ownerUserId: bo.id,
      }),
    );
    otherCohortId = friday.id;
    await manager().update(UserEntity, bo.id, { cohort: otherCohortId });
    stranger = { id: bo.id, role: 'INSTRUCTOR', cohort: otherCohortId };
  });

  const write = (over: Partial<Parameters<NotesService['write']>[1]> = {}) =>
    service.write(owner, {
      kind: 'mentor',
      cohortId,
      text: 'Use datetime.date.today() when you compare due dates.',
      ...over,
    } as Parameters<NotesService['write']>[1]);

  it('writes a note, names the class and the author, and audits the words', async () => {
    const note = await write({ phaseKey: 'requirements', projectSlug: 'tasktrackr' });

    expect(note).toMatchObject({
      kind: 'mentor',
      cohortId,
      cohortName: 'Monday class',
      phaseKey: 'requirements',
      projectSlug: 'tasktrackr',
      authorName: 'Ana',
      doneAt: null,
    });

    const audit = await manager().find(AuditEventEntity);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      event: 'note.write',
      actorUserId: owner.id,
      // The note names no learner, so the subject is the actor, exactly as
      // budget.default does for a change that lands on everyone.
      subjectUserId: owner.id,
      action: 'mentor',
      reason: 'Use datetime.date.today() when you compare due dates.',
    });
  });

  it('refuses a note on a class the caller does not own', async () => {
    await expect(write({ cohortId: otherCohortId })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hides another instructor’s notes from the list and from every write', async () => {
    const mine = await write({ phaseKey: 'requirements' });

    expect(await service.list(stranger)).toEqual([]);
    await expect(service.update(stranger, mine.id, { text: 'let me in here' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.remove(stranger, mine.id)).rejects.toBeInstanceOf(NotFoundException);
    // …and the note is still there.
    expect(await service.list(owner)).toHaveLength(1);
  });

  it('is a 404, not a 500, for an id that does not exist at all', async () => {
    await expect(service.remove(owner, 'no-such-note')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('filters the list by kind and by phase', async () => {
    await write({ kind: 'mentor', phaseKey: 'requirements' });
    await write({ kind: 'lecture', phaseKey: 'design', text: 'Revisit the contract table.' });

    expect(await service.list(owner, { kind: 'mentor' })).toHaveLength(1);
    expect(await service.list(owner, { kind: 'lecture' })).toHaveLength(1);
    expect(await service.list(owner, { phaseKey: 'design' })).toHaveLength(1);
    expect(await service.list(owner, { cohortId: otherCohortId })).toEqual([]);
  });

  it('ticks a lecture point off and puts it back', async () => {
    const point = await write({ kind: 'lecture', text: 'Nobody named the boundary.' });
    expect(point.doneAt).toBeNull();

    const done = await service.update(owner, point.id, { done: true });
    expect(done.doneAt).not.toBeNull();

    const undone = await service.update(owner, point.id, { done: false });
    expect(undone.doneAt).toBeNull();
  });

  it('keeps sourceId intact, which is what a pinned derived point is matched by', async () => {
    const pinned = await write({
      kind: 'lecture',
      sourceId: 'requirements:nobody named the boundary',
      text: 'Nobody named the boundary this week.',
    });
    expect(pinned.sourceId).toBe('requirements:nobody named the boundary');
    const [listed] = await service.list(owner, { kind: 'lecture' });
    expect(listed.sourceId).toBe('requirements:nobody named the boundary');
  });

  /* ------------------------------- forMentor ------------------------------ */

  it('gives the mentor at most two notes, phase-specific first', async () => {
    const first = await write({ text: 'A class-wide note about reading the task panel.' });
    const second = await write({ text: 'A second class-wide note about running the checks.' });
    const third = await write({ phaseKey: 'requirements', text: 'In requirements, name the boundary explicitly.' });
    // sqlite stamps createdAt to the second, so the order is set rather than waited for.
    await stampInOrder([first.id, second.id, third.id]);

    const forMentor = await service.forMentor(cohortId, 'tasktrackr', 'requirements');

    expect(forMentor).toHaveLength(2);
    expect(forMentor[0].text).toContain('name the boundary');
    // Then the newest class-wide one, not the oldest.
    expect(forMentor[1].text).toContain('running the checks');
  });

  it('matches a note pinned to another phase or another project to neither', async () => {
    await write({ phaseKey: 'design', text: 'In design, fill in the contract table.' });
    await write({ projectSlug: 'other-pack', text: 'On the other project: use Node 20.' });

    expect(await service.forMentor(cohortId, 'tasktrackr', 'requirements')).toEqual([]);
    expect(await service.forMentor(cohortId, 'tasktrackr', 'design')).toHaveLength(1);
    expect(await service.forMentor(cohortId, 'other-pack', 'requirements')).toHaveLength(1);
  });

  it('never carries a lecture point to the mentor', async () => {
    await write({ kind: 'lecture', text: 'Talk about the boundary in the lecture.' });
    expect(await service.forMentor(cohortId, 'tasktrackr', 'requirements')).toEqual([]);
  });

  it('carries nothing to a learner with no class', async () => {
    await write({ text: 'A class-wide note about reading the task panel.' });
    expect(await service.forMentor('default', 'tasktrackr', 'requirements')).toEqual([]);
    expect(await service.forMentor('', 'tasktrackr', 'requirements')).toEqual([]);
    expect(await service.forMentor(otherCohortId, 'tasktrackr', 'requirements')).toEqual([]);
  });

  it('deletes a note and records what was deleted', async () => {
    const note = await write();
    await expect(service.remove(owner, note.id)).resolves.toEqual({ deleted: true });

    expect(await manager().count(InstructorNoteEntity)).toBe(0);
    const audit = await manager().find(AuditEventEntity, { where: { event: 'note.delete' } });
    expect(audit[0].reason).toBe('Use datetime.date.today() when you compare due dates.');
  });
});
