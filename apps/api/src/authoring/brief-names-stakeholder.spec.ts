import 'reflect-metadata';
import * as path from 'path';
import { DataSource } from 'typeorm';
import type { ValidationReport } from '@learnsdlc/shared';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import { ProjectImporterService } from '../content/importer.service';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectRegistryService } from '../content/project-registry.service';
import { ProjectEntity } from '../content/project.entities';
import { INHERITED_TASK_KEY } from '@learnsdlc/shared';

/** A brief for the kept story that names no stakeholder. */
const STORY_BRIEF = 'Write one user story for a member of staff who books a meeting room for a slot, with what happens when the slot is taken.';
import { ROOMDESK_INTERVIEW } from '../../test/reference-scenario-roomdesk';
import { AuthoringService } from './authoring.service';
import { BRIEF_NAMES_STAKEHOLDER_CHECK_ID } from './validation';
import { memoryDataSource } from '../../test/support/memory-db';

/*
 * The advisory
 * "A task that needs the interview names the stakeholder" asks the question
 * the Requirements reviewer asks before it hands over the sealed facts
 * (openai.provider.ts composeAuthoredReviewMessages: the persona's name,
 * trimmed, found in the brief in any case). A brief that names the stakeholder
 * in other capitals is given the facts, so the advisory does not say it
 * gets none. A brief that does not name them at all warns.
 *
 * In-memory SQLite, the real TaskTrackr pack copied the way a teacher copies
 * it (scenario-authoring.spec.ts's harness). No AI, no server.
 */

const TEACHER = { id: 'teacher-re-case', role: 'INSTRUCTOR' as const, cohort: 'default' };

describe('the stakeholder advisory matches the persona the way the reviewer does', () => {
  let dataSource: DataSource;
  let service: AuthoringService;
  let seedVersionId = '';

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    const content = new ContentService();
    const importer = new ProjectImporterService(content, dataSource);
    const registry = new ProjectRegistryService(content, dataSource, { importedContent: [] } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);
    const imported = await importer.importPack(new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')), { origin: 'seed', platformOwned: true });
    seedVersionId = imported.projectVersionId;
    await dataSource.getRepository(ProjectEntity).update({ id: imported.projectId }, { isDefault: true });
    await registry.load();
    service = new AuthoringService(dataSource, importer, registry);
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  const warnedTasks = (report: ValidationReport): Array<string | null | undefined> =>
    report.checks.filter((check) => check.id === BRIEF_NAMES_STAKEHOLDER_CHECK_ID).map((check) => check.taskKey);

  const reportWith = async (slug: string, brief: string): Promise<ValidationReport> => {
    const made = await service.createProject(TEACHER, { title: 'RoomDesk', slug, fromVersionId: seedVersionId });
    await service.putInterview(TEACHER, made.project.id, made.draftVersionId, ROOMDESK_INTERVIEW);
    // the kept story task's brief (Requirements is a story phase: its one work task is the story)
    await service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', INHERITED_TASK_KEY, { brief });
    return service.validate(TEACHER, made.project.id, made.draftVersionId);
  };

  it('a brief naming "priya nair" in small letters is not warned (the reviewer gives it the facts)', async () => {
    const report = await reportWith('re-case-lower', `${STORY_BRIEF} Ask priya nair how the rooms are booked first.`);
    expect(warnedTasks(report)).not.toContain(INHERITED_TASK_KEY);
  });

  it('a brief naming "PRIYA NAIR" in capitals is not warned either', async () => {
    const report = await reportWith('re-case-upper', `${STORY_BRIEF} Ask PRIYA NAIR how the rooms are booked first.`);
    expect(warnedTasks(report)).not.toContain(INHERITED_TASK_KEY);
  });

  it('control: written exactly, not warned; not named at all, still warned', async () => {
    expect(warnedTasks(await reportWith('re-case-exact', `${STORY_BRIEF} Ask Priya Nair first.`))).not.toContain(INHERITED_TASK_KEY);
    expect(warnedTasks(await reportWith('re-case-absent', STORY_BRIEF))).toContain(INHERITED_TASK_KEY);
  });
});
