import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import type { InstructorNoteKind, InstructorNoteView, PhaseKey } from '@learnsdlc/shared';
import { CohortEntity, UserEntity } from '../db/entities';
import { recordAudit } from '../audit/audit';
import { InstructorCaller, UNATTACHED_COHORT } from './cohort-scope';
import { InstructorNoteEntity } from './notes.entity';
import { isoOrEmpty } from '../db/timestamps';

/** What a note is written with; `id` is the caller's own for an edit. */
export interface WriteNoteInput {
  kind: InstructorNoteKind;
  cohortId: string;
  phaseKey?: PhaseKey | null;
  projectSlug?: string | null;
  text: string;
  sourceId?: string | null;
  done?: boolean;
}

/**
 * Notes an instructor writes for a whole class.
 *
 * Two kinds, one table. A **mentor note** is quoted word for word by the mentor
 * to every learner in that class in that phase, which is the only way a class
 * without an API key can be told "use `datetime.date.today()` when you compare
 * due dates" by its own instructor rather than by a model. A **lecture point**
 * never reaches a model at all; it is a line held for the next session, and
 * the Class page is what shows it.
 *
 * Scope is the same everywhere else in the console: a caller may write on a
 * class they own, or on the class they are in when that is a real one, and
 * anything else is a 404 rather than a 403.
 */
@Injectable()
export class NotesService {
  /** The most notes the mentor may carry into one reply. */
  static readonly MENTOR_NOTE_LIMIT = 2;
  /** The most one console page lists. */
  static readonly PAGE_LIMIT = 100;

  constructor(private readonly dataSource: DataSource) {}

  /* -------------------------------- scope -------------------------------- */

  /**
   * The classes this caller may write about: the ones they own, plus their own
   * cohort when it is a real class. `default` is not a class (it is the absence
   * of one) so a note can never be addressed to it.
   */
  private async writableCohorts(
    manager: EntityManager,
    caller: InstructorCaller,
  ): Promise<string[]> {
    if (caller.role === 'ADMIN') {
      const all = await manager.find(CohortEntity, { select: ['id'] });
      return all.map((cohort) => cohort.id);
    }
    const owned = await manager.find(CohortEntity, {
      where: { ownerUserId: caller.id },
      select: ['id'],
    });
    return [...new Set([caller.cohort, ...owned.map((cohort) => cohort.id)])].filter(
      (cohort) => cohort !== UNATTACHED_COHORT,
    );
  }

  private async requireCohort(
    manager: EntityManager,
    caller: InstructorCaller,
    cohortId: string,
  ): Promise<void> {
    const allowed = await this.writableCohorts(manager, caller);
    if (!allowed.includes(cohortId)) {
      throw new NotFoundException('no class with that id in your classes');
    }
  }

  /* -------------------------------- reading ------------------------------ */

  async list(
    caller: InstructorCaller,
    query: { cohortId?: string; kind?: InstructorNoteKind; phaseKey?: PhaseKey } = {},
  ): Promise<InstructorNoteView[]> {
    const manager = this.dataSource.manager;
    const allowed = await this.writableCohorts(manager, caller);
    const cohortIds = query.cohortId
      ? allowed.filter((id) => id === query.cohortId)
      : allowed;
    if (cohortIds.length === 0) return [];

    const rows = await manager.find(InstructorNoteEntity, {
      where: {
        cohortId: In(cohortIds),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.phaseKey ? { phaseKey: query.phaseKey } : {}),
      },
      order: { createdAt: 'DESC' },
      take: NotesService.PAGE_LIMIT,
    });
    return this.views(manager, rows);
  }

  /**
   * The notes one chat reply may quote: at most two, phase-specific before
   * class-wide, newest first inside each. A note with no phase applies to every
   * phase, and one with no project applies to every project, so an instructor
   * can say one thing to the whole class without writing it six times.
   */
  async forMentor(
    cohortId: string,
    projectSlug: string,
    phaseKey: PhaseKey,
  ): Promise<InstructorNoteEntity[]> {
    if (!cohortId || cohortId === UNATTACHED_COHORT) return [];
    const rows = await this.dataSource.manager.find(InstructorNoteEntity, {
      where: [
        { cohortId, kind: 'mentor', phaseKey, projectSlug },
        { cohortId, kind: 'mentor', phaseKey, projectSlug: IsNull() },
        { cohortId, kind: 'mentor', phaseKey: IsNull(), projectSlug },
        { cohortId, kind: 'mentor', phaseKey: IsNull(), projectSlug: IsNull() },
      ],
      order: { createdAt: 'DESC' },
      take: 20,
    });
    return rows
      .sort((a, b) => {
        const specific = Number(!!b.phaseKey) - Number(!!a.phaseKey);
        if (specific !== 0) return specific;
        return stamp(b.createdAt) - stamp(a.createdAt);
      })
      .slice(0, NotesService.MENTOR_NOTE_LIMIT);
  }

  /* -------------------------------- writing ------------------------------ */

  async write(caller: InstructorCaller, input: WriteNoteInput): Promise<InstructorNoteView> {
    return this.dataSource.transaction(async (manager) => {
      await this.requireCohort(manager, caller, input.cohortId);
      const row = await manager.save(
        manager.create(InstructorNoteEntity, {
          kind: input.kind,
          cohortId: input.cohortId,
          phaseKey: input.phaseKey ?? null,
          projectSlug: input.projectSlug ?? null,
          text: input.text.trim(),
          authorUserId: caller.id,
          sourceId: input.sourceId ?? null,
          doneAt: input.done ? new Date().toISOString() : null,
        }),
      );
      await this.audit(manager, caller, 'note.write', row);
      return (await this.views(manager, [row]))[0];
    });
  }

  async update(
    caller: InstructorCaller,
    id: string,
    input: Partial<WriteNoteInput>,
  ): Promise<InstructorNoteView> {
    return this.dataSource.transaction(async (manager) => {
      const row = await this.owned(manager, caller, id);
      if (input.cohortId && input.cohortId !== row.cohortId) {
        await this.requireCohort(manager, caller, input.cohortId);
        row.cohortId = input.cohortId;
      }
      if (input.kind) row.kind = input.kind;
      if (input.phaseKey !== undefined) row.phaseKey = input.phaseKey ?? null;
      if (input.projectSlug !== undefined) row.projectSlug = input.projectSlug ?? null;
      if (input.text !== undefined) row.text = input.text.trim();
      if (input.sourceId !== undefined) row.sourceId = input.sourceId ?? null;
      // Ticking a lecture point off is the one field the Class page toggles, so
      // it has to be able to say "not done" as well as "done".
      if (input.done !== undefined) row.doneAt = input.done ? new Date().toISOString() : null;

      const saved = await manager.save(row);
      await this.audit(manager, caller, 'note.write', saved);
      return (await this.views(manager, [saved]))[0];
    });
  }

  async remove(caller: InstructorCaller, id: string): Promise<{ deleted: true }> {
    return this.dataSource.transaction(async (manager) => {
      const row = await this.owned(manager, caller, id);
      await manager.delete(InstructorNoteEntity, { id: row.id });
      await this.audit(manager, caller, 'note.delete', row);
      return { deleted: true as const };
    });
  }

  private async owned(
    manager: EntityManager,
    caller: InstructorCaller,
    id: string,
  ): Promise<InstructorNoteEntity> {
    const row = await manager.findOne(InstructorNoteEntity, { where: { id } });
    // A note in another instructor's class is a 404 for the same reason a
    // learner in another class is: an id that answers differently depending on
    // whether it exists is a directory of other people's classes.
    if (!row) throw new NotFoundException('no note with that id in your classes');
    await this.requireCohort(manager, caller, row.cohortId);
    return row;
  }

  /**
   * The note names no learner (it is written to a whole class) so the subject
   * is the actor, exactly as `budget.default` does for a change that lands on
   * everyone. The reason is the note's text: an appeal about what a class was
   * told reads the words, not an id.
   */
  private async audit(
    manager: EntityManager,
    caller: InstructorCaller,
    event: 'note.write' | 'note.delete',
    row: InstructorNoteEntity,
  ): Promise<void> {
    await recordAudit(manager, {
      event,
      actorUserId: caller.id,
      subjectUserId: caller.id,
      targetId: row.id,
      action: row.kind,
      reason: row.text,
      detail: { cohortId: row.cohortId, phaseKey: row.phaseKey },
    });
  }

  /** Names for the ids, in one query for the whole page. */
  private async views(
    manager: EntityManager,
    rows: InstructorNoteEntity[],
  ): Promise<InstructorNoteView[]> {
    if (rows.length === 0) return [];
    const cohorts = await manager.find(CohortEntity, {
      where: { id: In([...new Set(rows.map((row) => row.cohortId))]) },
      select: ['id', 'name'],
    });
    const authors = await manager.find(UserEntity, {
      where: { id: In([...new Set(rows.map((row) => row.authorUserId))]) },
      select: ['id', 'displayName'],
    });
    const cohortNames = new Map(cohorts.map((cohort) => [cohort.id, cohort.name]));
    const authorNames = new Map(authors.map((author) => [author.id, author.displayName]));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      cohortId: row.cohortId,
      cohortName: cohortNames.get(row.cohortId) ?? null,
      phaseKey: row.phaseKey,
      projectSlug: row.projectSlug,
      text: row.text,
      authorUserId: row.authorUserId,
      authorName: authorNames.get(row.authorUserId) ?? null,
      sourceId: row.sourceId,
      doneAt: row.doneAt,
      createdAt: isoOrEmpty(row.createdAt),
      updatedAt: isoOrEmpty(row.updatedAt),
    }));
  }
}

const stamp = (value: Date | string): number =>
  value instanceof Date ? value.getTime() : Date.parse(String(value));

