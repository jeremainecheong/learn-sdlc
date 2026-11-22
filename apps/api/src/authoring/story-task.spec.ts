// The harness is quiz-authoring.spec.ts's: TaskTrackr imported into an
// in-memory database, then copied by a teacher, whose draft is what
// `updateTask` edits. TaskTrackr's Requirements task is a story task (3.0.0);
// `beforeAll` replaces the copied story block with a smaller one through
// `service.updateTask`, so every case below starts from the same story.
//
// `updateTask` answers with the phase (`TaskMutationResult`), so each case reads
// the edited task out of `result.phase.tasks` rather than off the result itself.
import 'reflect-metadata';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';
import type { DraftTaskView, TaskMutationResult } from '@learnsdlc/shared';
import { lockedCriterionRefusal } from '@learnsdlc/shared';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import { ProjectImporterService } from '../content/importer.service';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectRegistryService } from '../content/project-registry.service';
import { ProjectEntity, ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../content/project.entities';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from '../../test/quiz-fixture';
import { UpdateTaskDto } from './authoring.dto';
import { AuthoringService } from './authoring.service';
import { memoryDataSource } from '../../test/support/memory-db';

const caller = { id: 'teacher-1', role: 'INSTRUCTOR' as const, cohort: 'default' };

const SEED_STORY = {
  providedStories: [{ id: 'US-1', title: 'Log in', persona: 'member', capability: 'log in', benefit: 'borrow' }],
  learnerStory: { id: 'US-4', hints: {} },
  floor: { minCriteria: 2, requiredTags: ['happy', 'boundary'], minExclusions: 1, requireSentence: true },
};

describe('updateTask on a story task', () => {
  let dataSource: DataSource;
  let service: AuthoringService;
  let projectId = '';
  let versionId = '';
  let importedVersionId = '';

  const mainOf = (result: TaskMutationResult): DraftTaskView => {
    const task = result.phase.tasks.find((one) => one.taskKey === 'main');
    if (!task) throw new Error('the Requirements phase has no task keyed "main"');
    return task;
  };

  const rowOfMain = async () => {
    const phase = await dataSource
      .getRepository(ProjectPhaseEntity)
      .findOneByOrFail({ projectVersionId: versionId, key: 'requirements' });
    return dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: phase.id, taskKey: 'main' });
  };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await memoryDataSource();
    const content = new ContentService();
    const importer = new ProjectImporterService(content, dataSource);
    const registry = new ProjectRegistryService(content, dataSource, {
      importedContent: [],
    } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);
    const imported = await importer.importPack(new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')), {
      origin: 'seed',
      platformOwned: true,
    });
    await dataSource.getRepository(ProjectEntity).update({ id: imported.projectId }, { isDefault: true });
    await registry.load();
    service = new AuthoringService(dataSource, importer, registry);
    importedVersionId = imported.projectVersionId;

    const made = await service.createProject(caller, {
      title: 'Story Edit',
      slug: 'story-edit',
      fromVersionId: imported.projectVersionId,
    });
    projectId = made.project.id;
    versionId = made.draftVersionId;
    await service.updateTask(caller, projectId, versionId, 'requirements', 'main', { story: SEED_STORY } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('seeds a story block onto the task, keeping the record path the pack shipped', async () => {
    const row = await rowOfMain();
    expect(row.checks.kind).toBe('story');
    expect(row.checks.kind === 'story' && row.checks.record).toBe('requirements/story.json');
  });

  it('stores the floor, the provided stories and the rubric weights', async () => {
    const body = { title: 'Write SH-4', brief: 'Interview, then write.', artefactType: 'user-story', objectives: ['one'],
      story: { providedStories: [{ id: 'SH-1', title: 'Add a book', persona: 'librarian', capability: 'add', benefit: 'find' }], learnerStory: { id: 'SH-4', hints: { persona: 'librarian' } },
        floor: { minCriteria: 3, requiredTags: ['happy', 'boundary', 'error'], minExclusions: 2, requireSentence: true } },
      rubric: { passThreshold: 70, criteria: [{ key: 'story_structure', title: 'Sentence', description: 'Full.', weight: 0.4 }, { key: 'acceptance_criteria', title: 'Criteria', description: 'Testable.', weight: 0.6 }] } };
    const view = mainOf(await service.updateTask(caller, projectId, versionId, 'requirements', 'main', body as never));
    expect(view.story?.floor.minCriteria).toBe(3);
    expect(view.story?.providedStories[0].id).toBe('SH-1');
    expect(view.story?.learnerStory).toEqual({ id: 'SH-4', hints: { persona: 'librarian' } });
    expect(view.rubric.passThreshold).toBe(70);
    expect(view.rubric.criteria.map(c => c.weight)).toEqual([0.4, 0.6]);
    expect(view.title).toBe('Write SH-4');
    expect(view.objectives).toEqual(['one']);
    // and on the row, not only in the answer
    const row = await rowOfMain();
    expect(row.checks.kind === 'story' && row.checks.floor.minExclusions).toBe(2);
    expect(row.rubric.criteria.map((c) => c.key)).toEqual(['story_structure', 'acceptance_criteria']);
  });

  it.each([
    ['weights off', { rubric: { passThreshold: 70, criteria: [{ key: 'a', title: 'A', description: 'd', weight: 0.7 }] } }, 'Weights must sum to 1'],
    ['no criteria', { rubric: { passThreshold: 70, criteria: [] } }, 'at least one criterion'],
    ['learner id clash', { story: { providedStories: [{ id: 'SH-4', title: 't', persona: 'p', capability: 'c', benefit: 'b' }], learnerStory: { id: 'SH-4', hints: {} }, floor: { minCriteria: 2, requiredTags: [], minExclusions: 1, requireSentence: true } } }, 'learnerStory.id must not be a provided story'],
  ])('refuses %s', async (_n, body, message) => {
    await expect(service.updateTask(caller, projectId, versionId, 'requirements', 'main', { title: 't', brief: 'b', artefactType: 'user-story', objectives: [], ...body } as never)).rejects.toThrow(message);
  });

  it('lets the story and the rubric through the whitelist, and holds their caps', async () => {
    const strict = { whitelist: true, forbidNonWhitelisted: true };
    const good = plainToInstance(UpdateTaskDto, {
      story: SEED_STORY,
      rubric: { passThreshold: 70, criteria: [{ key: 'story_structure', title: 'T', description: 'd', weight: 1 }] },
    });
    expect(await validate(good, strict)).toEqual([]);
    const bad = plainToInstance(UpdateTaskDto, {
      story: { ...SEED_STORY, floor: { ...SEED_STORY.floor, minCriteria: 9 } },
      rubric: { passThreshold: 0, criteria: [{ key: 'k', title: 'T', description: 'd', weight: 1.5 }] },
    });
    const errors = await validate(bad, strict);
    expect(errors.map((e) => e.property).sort()).toEqual(['rubric', 'story']);
  });

  const rowOf = async (phaseKey: string, taskKey: string) => {
    const phase = await dataSource
      .getRepository(ProjectPhaseEntity)
      .findOneByOrFail({ projectVersionId: versionId, key: phaseKey as never });
    return dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: phase.id, taskKey });
  };

  it('refuses to start a story task outside the Requirements phase', async () => {
    // TaskTrackr's Design is a design phase since 4.0.0
    const before = await rowOf('design', 'main');
    expect(before.checks.kind).toBe('design');
    await expect(
      service.updateTask(caller, projectId, versionId, 'design', 'main', { story: SEED_STORY } as never),
    ).rejects.toThrow('A story task belongs to the Requirements phase.');
    const after = await rowOf('design', 'main');
    expect(after.checks).toEqual(before.checks);
  });

  it.each([
    ['story', { story: SEED_STORY }, 'is graded by running tests, not by rules, a word floor, a quiz key or a story floor.'],
    // Implementation's code task takes its fixed criteria, so a story's rubric is refused for the first fixed key it lacks
    ['rubric', { rubric: { passThreshold: 70, criteria: [{ key: 'k', title: 'T', description: 'd', weight: 1 }] } }, lockedCriterionRefusal('correctness_hidden', 'Correctness (hidden tests)')],
  ])('refuses a %s body on a code task and leaves it unchanged', async (_n, body, sentence) => {
    const before = await rowOf('implementation', 'main');
    expect(before.checks.kind).toBe('code');
    await expect(
      service.updateTask(caller, projectId, versionId, 'implementation', 'main', body as never),
    ).rejects.toThrow(sentence);
    const after = await rowOf('implementation', 'main');
    expect(after.checks).toEqual(before.checks);
    expect(after.rubric).toEqual(before.rubric);
  });

  it('keeps the sole-task rule with a concept quiz beside the story task: the story checks reach the phase, the quiz keeps its own grading', async () => {
    // A quiz beside the Requirements story task leaves
    // the phase no sole task, so the story task's checks must still be the
    // phase's when the draft compiles.
    const made = await service.createProject(caller, { title: 'Story Quiz', slug: 'story-quiz', fromVersionId: importedVersionId });
    const pid = made.project.id;
    const vid = made.draftVersionId;
    await service.addTask(caller, pid, vid, 'requirements', {
      taskKey: 'concepts',
      title: 'Requirements concepts',
      brief: FIXTURE_QUIZ_NOTICE,
      artefactType: 'quiz',
      required: false,
      quiz: { questions: fixtureQuizQuestions(5), criterion: 'requirements-concepts' },
    } as never);
    const edited = { ...SEED_STORY, floor: { ...SEED_STORY.floor, minCriteria: 3 } };
    await service.updateTask(caller, pid, vid, 'requirements', 'main', { story: edited } as never);

    const report = await service.validate(caller, pid, vid);
    expect(report.blocking).toEqual([]);
    const version = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: vid });
    const phase = version.compiled!.content.phases.find((one) => one.key === 'requirements')!;
    expect(phase.checks.kind).toBe('story');
    expect(phase.checks.kind === 'story' && phase.checks.floor.minCriteria).toBe(3);
    expect(phase.checks.kind === 'story' && phase.checks.providedStories.map((one) => one.id)).toEqual(['US-1']);
    expect(phase.rubric.criteria.map((one) => one.key)).toEqual(['story_structure', 'acceptance_criteria', 'scope_clarity']);

    const tasks = version.compiled!.phases.find((one) => one.key === 'requirements')!.tasks;
    const quiz = tasks.find((one) => one.taskKey === 'concepts')!;
    expect(quiz.checkKind).toBe('quiz');
    expect(quiz.checks?.kind).toBe('quiz');
    expect(quiz.rubric.criteria.map((one) => one.key)).toEqual(['requirements-concepts']);
    const main = tasks.find((one) => one.taskKey === 'main')!;
    expect(main.checkKind).toBe('story');
  });
});
